const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const zadxSmsProvider = require("./zadxSmsProvider");

async function validateCardCode(client, centerId, cardCode) {
  if (!/^\d+$/.test(cardCode)) throw new AppError("INVALID_CARD_CODE", "Card code must contain digits only.", "كود الكارت غير صحيح.", 400);
  const ranges = await client.query("SELECT 1 FROM card_ranges WHERE center_id = $1 AND status = 'active' LIMIT 1", [centerId]);
  if (ranges.rows.length === 0) return;
  const range = await client.query("SELECT 1 FROM card_ranges WHERE center_id = $1 AND status = 'active' AND length(start_code) = length($2) AND start_code <= $2 AND end_code >= $2 LIMIT 1", [centerId, cardCode]);
  if (!range.rows.length) throw new AppError("CARD_OUTSIDE_ALLOWED_RANGE", "Card is outside the center allowed ranges.", "الكارت خارج النطاق المسموح لهذا المركز.", 403);
}

/**
 * Mobile clients historically stored check-in values as HH:mm:ss. PostgreSQL
 * expects a full timestamptz for attendance.check_in_time, so normalize both
 * legacy time-only values and normal ISO/date values at the API boundary.
 */
function normalizeTimestamp(value, dateHint) {
  if (!value) return new Date().toISOString();
  const raw = String(value).trim();
  if (/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)) {
    const date = dateHint && /^\d{4}-\d{2}-\d{2}/.test(String(dateHint))
      ? String(dateHint).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const time = raw.length === 5 ? `${raw}:00` : raw;
    return `${date}T${time}Z`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

// Keep debt-cycle values compatible with the canonical PostgreSQL enum/check
// constraint. Older mobile builds used names such as "group" and "session".
function normalizeDebtCycleType(value, hasPackageSubscription) {
  const raw = String(value || "").trim().toLowerCase().replace(/[-\s]/g, "_");
  if (raw === "package" || raw === "pkg" || hasPackageSubscription) return "package";
  if (["per_session", "persession", "session", "perclass", "per_class"].includes(raw)) {
    return "per_session";
  }
  return "monthly";
}

function normalizeDebtCycleStatus(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]/g, "_");
  const aliases = {
    open: "pending",
    active: "pending",
    current: "pending",
    due: "pending",
    pending: "pending",
    partially_paid: "partially_paid",
    partial: "partially_paid",
    partial_paid: "partially_paid",
    paid: "paid",
    closed: "paid",
    ended: "paid",
    cancelled: "cancelled",
    canceled: "cancelled",
    waived: "waived",
    written_off: "waived",
  };
  return aliases[raw] || "pending";
}

function normalizePaymentType(value) {
  const raw = String(value || "session").trim().toLowerCase();
  if (raw === "full") return "monthly";
  if (raw === "monthly" || raw === "partial" || raw === "session") return raw;
  return "session";
}

// The mobile app historically used `late` as an attendance status, while the
// PostgreSQL schema stores lateness in `is_late` and only accepts `present`,
// `absent`, `excused`, or `attended_elsewhere` in status. Normalize at the API
// boundary so old queued operations remain retryable after a deployment.
function normalizeAttendanceStatus(value, isLate) {
  const raw = String(value || "present").trim().toLowerCase();
  if (raw === "late") return "present";
  if (["present", "absent", "excused", "attended_elsewhere"].includes(raw)) {
    return raw;
  }
  return "present";
}

// Several older mobile operation IDs embedded both exam and student IDs and
// exceeded PostgreSQL's VARCHAR(64) operation_id columns. Keep a deterministic
// bounded key on the server so those queued operations can still be retried.
function normalizeOperationId(value) {
  const raw = String(value || "");
  if (raw.length <= 64) return raw;
  return `op-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 61)}`;
}

// A push batch may contain a child operation created immediately after its
// parent on the device. PostgreSQL correctly rejects the child while the
// parent is still absent, so order the batch before opening savepoints. This
// is intentionally server-side as well as client-side: older mobile builds
// and repair batches must receive the same FK-safe ordering.
const SYNC_ENTITY_ALIASES = {
  student_group_enrollment: "enrollment",
  session_payment: "payment",
  makeup_attendance: "makeup",
  attendance_marked: "attendance",
};
const SYNC_ENTITY_PRIORITY = {
  teacher: 10,
  subject: 10,
  package: 15,
  group: 20,
  student: 30,
  student_card: 35,
  enrollment: 40,
  group_schedule: 45,
  package_subject: 50,
  package_subscription: 55,
  package_teacher_override: 60,
  debt_cycle: 70,
  session: 80,
  attendance: 90,
  makeup: 90,
  payment: 100,
  payment_reversal: 100,
  debt_adjustment: 100,
  advance_coverage: 90,
};

function canonicalSyncEntity(value) {
  const raw = String(value || "").toLowerCase().replace(/_created$|_updated$|_deleted$/g, "");
  return SYNC_ENTITY_ALIASES[raw] || raw;
}

function syncPayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function firstSyncValue(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") return payload[key];
  }
  return undefined;
}

function orderSyncOperations(operations) {
  const base = [...operations].sort((a, b) => {
    const priorityA = SYNC_ENTITY_PRIORITY[canonicalSyncEntity(a.entityType)] ?? 500;
    const priorityB = SYNC_ENTITY_PRIORITY[canonicalSyncEntity(b.entityType)] ?? 500;
    return priorityA - priorityB || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
  const byEntity = new Map(base.map((operation) => [
    `${canonicalSyncEntity(operation.entityType)}:${String(operation.entityId || "")}`,
    operation,
  ]));
  const dependencies = (operation) => {
    const entity = canonicalSyncEntity(operation.entityType);
    const payload = syncPayload(operation.payload);
    const value = (...keys) => firstSyncValue(payload, ...keys);
    const refs = [];
    if (entity === "group") refs.push(["teacher", value("teacherId", "teacher_id")], ["subject", value("subjectId", "subject_id")]);
    if (entity === "group_schedule") refs.push(["group", value("groupId", "group_id")]);
    if (entity === "enrollment") refs.push(["student", value("studentId", "student_id")], ["group", value("groupId", "group_id")]);
    if (entity === "session") {
      refs.push(["group", value("groupId", "group_id")], ["teacher", value("teacherId", "teacher_id")], ["subject", value("subjectId", "subject_id")]);
      const students = payload.expectedStudentIds || payload.expected_student_ids;
      if (Array.isArray(students)) students.forEach((id) => refs.push(["student", id]));
    }
    if (entity === "attendance" || entity === "makeup" || entity === "advance_coverage") refs.push(["session", value("sessionId", "session_id", "advanceSessionId", "advance_session_id", "targetFutureSessionId", "target_future_session_id")], ["student", value("studentId", "student_id")]);
    if (entity === "payment" || entity === "payment_reversal" || entity === "debt_adjustment") refs.push(["debt_cycle", value("debtCycleId", "debt_cycle_id")], ["session", value("sessionId", "session_id")], ["student", value("studentId", "student_id")]);
    if (entity === "payment_reversal") refs.push(["payment", value("paymentId", "payment_id")]);
    if (entity === "debt_cycle") refs.push(["enrollment", value("enrollmentId", "enrollment_id")], ["student", value("studentId", "student_id")], ["package_subscription", value("packageSubscriptionId", "package_subscription_id")]);
    if (entity === "package_subscription") refs.push(["student", value("studentId", "student_id")], ["package", value("packageId", "package_id")]);
    if (entity === "package_teacher_override") refs.push(["package_subscription", value("subscriptionId", "subscription_id")], ["teacher", value("teacherId", "teacher_id")], ["subject", value("subjectId", "subject_id")]);
    return refs.filter(([, id]) => id !== undefined).map(([type, id]) => `${type}:${String(id)}`);
  };
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  const visit = (operation) => {
    const key = String(operation.operationId || `${operation.entityType}:${operation.entityId}`);
    if (visited.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies(operation)) {
      const parent = byEntity.get(dependency);
      if (parent) visit(parent);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(operation);
  };
  base.forEach(visit);
  return ordered;
}

class SyncProcessor {
  /**
   * Processes a batch of sync operations inside a true ACID transaction.
   */
  static async processPush(centerId, userId, deviceId, operations) {
    return db.withTransaction(async (client) => {
      const syncedOperationIds = [];
      const conflicts = [];
      // Older offline clients could generate a random session id for the same
      // group/schedule/date. Keep a per-batch alias so dependent attendance
      // and payment operations follow the canonical server session.
      const canonicalSessionIds = new Map();
      let maxServerSeq = 0;

      // Get current highest server sequence for the center
      const currentSeqRes = await client.query(
        "SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM server_sync_operations WHERE center_id = $1",
        [centerId],
      );
      maxServerSeq = parseInt(currentSeqRes.rows[0].max_seq, 10);

      for (const op of orderSyncOperations(operations)) {
        const {
          operationId: rawOperationId,
          operationType,
          entityType,
          entityId,
          payload,
          createdAt,
        } = op;

        if (!rawOperationId) {
          conflicts.push({
            operationId: null,
            entityType,
            entityId,
            reason: "operationId is required for every sync operation.",
            resolution: "manual_review",
          });
          continue;
        }
        const operationId = normalizeOperationId(rawOperationId);

        // 1. Check if operation was already processed (Database-level Idempotency)
        const existingOp = await client.query(
          "SELECT server_seq, status, center_id FROM server_sync_operations WHERE operation_id = $1",
          [operationId],
        );

        if (existingOp.rows.length > 0) {
          if (existingOp.rows[0].center_id !== centerId) {
            conflicts.push({
              operationId: rawOperationId,
              entityType,
              entityId,
              reason: "operationId is already owned by another center.",
              resolution: "server_wins",
            });
            continue;
          }
          syncedOperationIds.push(rawOperationId);
          const existingSeq = parseInt(existingOp.rows[0].server_seq, 10);
          if (existingSeq > maxServerSeq) {
            maxServerSeq = existingSeq;
          }
          continue;
        }

        // 2. Tenant isolation assertion: Operation center MUST match authenticated session center
        if (op.centerId && op.centerId !== centerId) {
          conflicts.push({
            operationId: rawOperationId,
            entityType,
            entityId,
            reason: `Tenant mismatch: operation belongs to '${op.centerId}', authenticated center is '${centerId}'.`,
            resolution: "server_wins",
          });
          continue;
        }

        await client.query("SAVEPOINT op_savepoint");
        try {
          const normalizedPayload = typeof payload === "string" ? JSON.parse(payload || "{}") : { ...(payload || {}) };
          const referencedSessionId = normalizedPayload.session_id || normalizedPayload.sessionId;
          const canonicalSessionId = referencedSessionId && canonicalSessionIds.get(String(referencedSessionId));
          if (canonicalSessionId) {
            normalizedPayload.session_id = canonicalSessionId;
            normalizedPayload.sessionId = canonicalSessionId;
          }
          await SyncProcessor.assertFreshMutation(client, centerId, entityType, entityId, normalizedPayload, operationType);
          // 3. Dispatch and apply domain mutation atomically
          await SyncProcessor.applyDomainMutation(client, {
            centerId,
            userId,
            deviceId,
            operationId,
            operationType,
            entityType,
            entityId,
            payload: normalizedPayload,
            createdAt,
          });

          if (canonicalSyncEntity(entityType) === "session") {
            const session = normalizedPayload;
            const natural = await client.query(
              `SELECT id FROM sessions
                 WHERE center_id = $1 AND group_id = $2
                   AND COALESCE(schedule_id, '') = COALESCE($3, '')
                   AND session_date = $4
                 LIMIT 1`,
              [centerId, session.group_id || session.groupId, session.schedule_id || session.scheduleId || null, normalizeDateOnly(session.session_date || session.sessionDate)],
            );
            if (natural.rows[0]?.id) canonicalSessionIds.set(String(entityId), String(natural.rows[0].id));
          }

          // 4. Ingest operation into monotonic server ledger. For SMS
          // deliveries, publish the authoritative post-provider status so
          // clients converge on sent/failed state during the next pull.
          let ledgerPayload = payload || {};
          if (entityType === "notification_delivery") {
            const deliveryState = await client.query("SELECT id, notification_event_id, provider, status, retry_count, provider_message_id FROM notification_deliveries WHERE center_id=$1 AND id=$2", [centerId, entityId]);
            if (deliveryState.rows[0]) ledgerPayload = { delivery: { ...deliveryState.rows[0] } };
          }
          const ingestRes = await client.query(
            `INSERT INTO server_sync_operations 
             (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', $9, NOW())
             RETURNING server_seq;`,
            [
              operationId,
              centerId,
              userId,
              deviceId,
              operationType || entityType || "mutation",
              entityType || "unknown",
              entityId || operationId,
              JSON.stringify(ledgerPayload),
              createdAt || new Date().toISOString(),
            ],
          );

          const seq = parseInt(ingestRes.rows[0].server_seq, 10);
          if (seq > maxServerSeq) {
            maxServerSeq = seq;
          }

          // 5. Record Server-Side Audit Trail
          const studentAuditState = entityType === "student" ? (payload?.student || payload || {}) : {};
          const hasStudentArchiveMutation = entityType === "student" && (
            Object.prototype.hasOwnProperty.call(studentAuditState, "deleted_at") ||
            Object.prototype.hasOwnProperty.call(studentAuditState, "deletedAt")
          );
          const studentIsArchived = Boolean(studentAuditState.deleted_at || studentAuditState.deletedAt);
          const auditAction = hasStudentArchiveMutation
            ? (studentIsArchived ? "student.delete" : "student.restore")
            : `${entityType || "entity"}.${operationType || "mutate"}`;
          await client.query(
            `INSERT INTO audit_logs
             (id, operation_id, center_id, user_id, device_id, entity_type, entity_id, action, timestamp, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9);`,
            [
              `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              operationId,
              centerId,
              userId,
              deviceId,
              entityType || "unknown",
              entityId || operationId,
              auditAction,
              JSON.stringify(ledgerPayload),
            ],
          );

          await client.query("RELEASE SAVEPOINT op_savepoint");
          syncedOperationIds.push(rawOperationId);
        } catch (opErr) {
          await client.query("ROLLBACK TO SAVEPOINT op_savepoint");
          let serverState = null;
          try {
            serverState = await SyncProcessor.readCurrentEntityState(client, centerId, entityType, entityId);
          } catch (_) {
            // Conflict review must never hide the original mutation error.
          }
          // If domain mutation failed with conflict or validation
          conflicts.push({
            operationId: rawOperationId,
            entityType,
            entityId,
            reason: opErr.message,
            resolution: "manual_review",
            serverState,
          });
        }
      }

      // 6. Update Per-Device Checkpoint (tracks device progress without modifying global server sequence)
      const checkpointId = `chk-${crypto.createHash("sha256").update(`${centerId}:${deviceId}`).digest("hex").slice(0, 48)}`;
      await client.query(
        `INSERT INTO sync_checkpoints (id, center_id, device_id, last_pulled_seq, last_pushed_operation_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (center_id, device_id) DO UPDATE SET
           last_pushed_operation_id = EXCLUDED.last_pushed_operation_id,
           updated_at = NOW();`,
        [
          checkpointId,
          centerId,
          deviceId,
          maxServerSeq,
          normalizeOperationId(syncedOperationIds[syncedOperationIds.length - 1]) || null,
        ],
      );

      return {
        success: true,
        syncedOperationIds,
        conflicts,
        serverCursor: String(maxServerSeq),
        processedAt: new Date().toISOString(),
      };
    });
  }

  /** Returns the authoritative row for conflict review without mutating it. */
  static async readCurrentEntityState(client, centerId, entityType, entityId) {
    if (!entityId) return null;
    const tableByType = {
      student: "students",
      student_created: "students",
      teacher: "teachers",
      teacher_created: "teachers",
      teacher_updated: "teachers",
      subject: "subjects",
      subject_created: "subjects",
      subject_updated: "subjects",
      group: "groups",
      group_created: "groups",
      group_updated: "groups",
      session: "sessions",
      session_created: "sessions",
      student_card: "student_cards",
      enrollment: "student_group_enrollments",
      student_group_enrollment: "student_group_enrollments",
      package: "packages",
      package_subscription: "student_package_subscriptions",
      grade_exam: "grade_exams",
      grade_score: "grade_scores",
      debt_cycle: "debt_cycles",
      notification_event: "notification_events",
      notification_template: "notification_templates",
      notification_delivery: "notification_deliveries",
      session_closing: "session_closing_records",
      daily_closing: "daily_closing_summaries",
    };
    const table = tableByType[entityType];
    if (!table) return null;
    const result = await client.query(`SELECT * FROM ${table} WHERE center_id = $1 AND id = $2`, [centerId, entityId]);
    return result.rows[0] || null;
  }

  // Lightweight optimistic concurrency: a stale offline update must become a
  // reviewable conflict instead of overwriting a newer server edit.
  static async assertFreshMutation(client, centerId, entityType, entityId, payload, operationType) {
    // A server-reset repair intentionally restores the device's local
    // authoritative row. Its local timestamp can predate a server row that
    // was recreated after the reset, so optimistic stale-write protection does
    // not apply to this explicit recovery operation.
    if (operationType === "REPAIR_AFTER_SERVER_RESET") return;
    const incoming = payload && (payload.updatedAt || payload.updated_at);
    if (!incoming || !entityId) return;
    const tableByType = {
      student: "students", teacher: "teachers", subject: "subjects",
      group: "groups", session: "sessions", enrollment: "student_group_enrollments",
      package: "packages", package_subscription: "student_package_subscriptions",
      group_schedule: "group_schedules", student_card: "student_cards",
      package_teacher_override: "package_subject_teacher_overrides",
      grade_exam: "grade_exams", grade_score: "grade_scores",
      notification_template: "notification_templates",
    };
    const table = tableByType[entityType];
    if (!table) return;
    const result = await client.query(`SELECT updated_at FROM ${table} WHERE center_id = $1 AND id = $2`, [centerId, entityId]);
    const serverUpdated = result.rows[0]?.updated_at;
    if (serverUpdated && new Date(serverUpdated).getTime() > new Date(incoming).getTime()) {
      throw new Error("STALE_UPDATE: server has a newer version of this record.");
    }
  }

  /**
   * Applies specific entity domain logic in PostgreSQL.
   */
  static async applyDomainMutation(client, context) {
    const { centerId, userId, operationId, operationType, entityType, payload } = context;

    switch (entityType) {
      case "student":
      case "student_created": {
        const student = payload.student || payload;
        const studentId = student.id || student.studentId || context.entityId;
        const existingStudentRes = await client.query(
          `SELECT student_code, card_code, full_name, phone, parent_phone, grade, student_type, notes, status, deleted_at, deleted_by
           FROM students WHERE center_id = $1 AND id = $2`,
          [centerId, studentId],
        );
        const existingStudent = existingStudentRes.rows[0];
        const hasDeletedAt = Object.prototype.hasOwnProperty.call(student, "deleted_at") || Object.prototype.hasOwnProperty.call(student, "deletedAt");
        const hasDeletedBy = Object.prototype.hasOwnProperty.call(student, "deleted_by") || Object.prototype.hasOwnProperty.call(student, "deletedBy");
        const deletedAt = hasDeletedAt ? (student.deleted_at ?? student.deletedAt ?? null) : (existingStudent?.deleted_at ?? null);
        const deletedBy = hasDeletedBy ? (student.deleted_by ?? student.deletedBy ?? null) : (existingStudent?.deleted_by ?? null);
        const cardCode = String(
          student.card_code || student.cardCode || student.student_code || student.studentCode || existingStudent?.card_code || existingStudent?.student_code || "",
        ).trim();
        const studentCode = String(
          student.student_code || student.studentCode || existingStudent?.student_code || cardCode,
        ).trim();
        const status = student.status || existingStudent?.status || "active";
        // Card lifecycle is owned by the dedicated student_card operation.
        // A student CREATE payload also contains a card for the initial
        // bootstrap, but that payload can be retried long after the student
        // has received a replacement card. Replaying it must never
        // deactivate the current card and resurrect the old one.
        const isCardCodeReplacement = payload.cardCodeChanged === true || payload.replaceCard === true;
        const cardWasProvided = (!existingStudent && Boolean(payload.card || cardCode)) || isCardCodeReplacement;

        if (!studentId || (!cardCode && !existingStudent)) {
          throw new Error("Card code / Student code is required.");
        }

        if (cardCode && cardWasProvided) await validateCardCode(client, centerId, cardCode);

        // A student code is an identity key and can never be reassigned. A
        // physical card code is different: after a server reset an old
        // repair may collide with a card that is already owned remotely. In
        // that repair-only case keep the student row and omit the card; the
        // separate student_card operation remains reviewable instead of
        // rolling back the entire student upload.
        const studentCodeOwner = await client.query(
          `SELECT id FROM students
           WHERE center_id = $1 AND student_code = $2 AND id <> $3`,
          [centerId, studentCode, studentId],
        );
        if (studentCodeOwner.rows.length > 0) {
          throw new Error(
            `Student code '${studentCode}' is already registered in this center.`,
          );
        }
        let cardConflictWithAnotherStudent = false;
        if (cardCode) {
          const cardOwner = await client.query(
            `SELECT student_id AS owner_id, center_id FROM student_cards
             WHERE card_code = $1
             UNION
             SELECT id AS owner_id, center_id FROM students
             WHERE card_code = $1`,
            [cardCode],
          );
          const otherOwner = cardOwner.rows.find((row) => row.owner_id !== studentId);
          if (otherOwner) {
            if (operationType === "REPAIR_AFTER_SERVER_RESET") {
              cardConflictWithAnotherStudent = true;
            } else {
              throw new Error(
                `Card code '${cardCode}' is already assigned in another center.`,
              );
            }
          }
        }
        const persistedCardCode = cardConflictWithAnotherStudent
          ? (existingStudent?.card_code || null)
          : cardCode;

        const rawStudentType = student.student_type || student.studentType || existingStudent?.student_type || "registered";
        const studentType = ["registered", "external", "guest", "scholarship"].includes(String(rawStudentType).toLowerCase())
          ? String(rawStudentType).toLowerCase()
          : "registered";

        // 1. Insert Student with exact leading zeros preserved
        await client.query(
          `INSERT INTO students 
           (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, student_type, notes, status, deleted_at, deleted_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             student_code = EXCLUDED.student_code,
             card_code = EXCLUDED.card_code,
             full_name = EXCLUDED.full_name,
             phone = EXCLUDED.phone,
             parent_phone = EXCLUDED.parent_phone,
             grade = EXCLUDED.grade,
             notes = EXCLUDED.notes,
             status = EXCLUDED.status,
             deleted_at = EXCLUDED.deleted_at,
             deleted_by = EXCLUDED.deleted_by,
             updated_at = NOW();`,
          [
            studentId,
            centerId,
            studentCode,
            student.full_name || student.fullName || existingStudent?.full_name || "",
            persistedCardCode,
            student.phone || existingStudent?.phone || "",
            student.parent_phone || student.parentPhone || existingStudent?.parent_phone || "",
            student.grade || existingStudent?.grade || "",
            studentType,
            student.notes !== undefined ? student.notes : (existingStudent?.notes || null),
            status,
            deletedAt,
            deletedBy,
          ],
        );

        // 2. Insert Active Physical Card
        const cardId = payload.card?.id || `card-${studentId}`;
        // A replacement is a direct edit of students.card_code. Do not
        // create/deactivate student_cards rows for this operation: card
        // history and cancellation semantics are intentionally not part of
        // replacing the student's current code.
        if (persistedCardCode && cardWasProvided && !isCardCodeReplacement) {
          await client.query(
            `UPDATE student_cards
             SET status = 'deactivated', deactivated_at = NOW()
             WHERE center_id = $1 AND student_id = $2 AND status = 'active' AND id <> $3`,
            [centerId, studentId, cardId],
          );
          try {
            await client.query(
              `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
               ON CONFLICT (id) DO UPDATE SET
                 card_code = EXCLUDED.card_code,
                 status = EXCLUDED.status,
                 deactivated_at = CASE WHEN EXCLUDED.status = 'active' THEN NULL ELSE student_cards.deactivated_at END;`,
              [cardId, centerId, studentId, persistedCardCode, status === "active" ? "active" : "deactivated"],
            );
          } catch (cardErr) {
            // A server-reset repair must not fail the student upload merely
            // because its historical physical card is now owned by another
            // student. Keep the student row and leave that card untouched.
            const cardErrText = String(cardErr?.constraint || cardErr?.message || "");
            if (operationType !== "REPAIR_AFTER_SERVER_RESET" || !cardErrText.includes("uq_center_card_code")) {
              throw cardErr;
            }
            await client.query(
              "UPDATE students SET card_code = NULL, updated_at = NOW() WHERE center_id = $1 AND id = $2",
              [centerId, studentId],
            );
          }
        }

        // 3. Insert Selected Group Enrollments atomically
        const enrollments =
          payload.enrollments || payload.groupEnrollments || [];
        for (const enr of enrollments) {
          await client.query(
            `INSERT INTO student_group_enrollments 
             (id, center_id, student_id, group_id, price_override, status, joined_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW(), NOW())
             ON CONFLICT (center_id, student_id, group_id) DO UPDATE SET
               price_override = EXCLUDED.price_override,
               status = 'active',
               updated_at = NOW();`,
            [
              enr.id ||
                `enr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              centerId,
              studentId,
              enr.group_id || enr.groupId,
              enr.price_override || enr.priceOverride || null,
            ],
          );
        }
        break;
      }

      case "attendance":
      case "attendance_marked": {
        const att = payload;
        const sessionDateRes = await client.query(
          "SELECT session_date FROM sessions WHERE center_id = $1::varchar AND id = $2::varchar",
          [centerId, att.session_id || att.sessionId],
        );
        const checkInTime = normalizeTimestamp(
          att.check_in_time || att.checkInTime,
          sessionDateRes.rows[0]?.session_date,
        );
        const rawAttendanceStatus = att.status;
        const normalizedAttendanceStatus = normalizeAttendanceStatus(
          rawAttendanceStatus,
          att.is_late,
        );
        const isLate = Boolean(att.is_late) || String(rawAttendanceStatus || "").toLowerCase() === "late";
        // Enforce deduplication via UNIQUE(session_id, student_id)
        await client.query(
          `INSERT INTO attendance
           (id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type, original_absence_id, operation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (session_id, student_id) DO NOTHING;`,
          [
            att.id,
            centerId,
            att.session_id || att.sessionId,
            att.student_id || att.studentId,
            checkInTime,
            normalizedAttendanceStatus,
            isLate,
            att.attendance_type || att.attendanceType || "present",
            att.original_absence_id || att.originalAbsenceId || null,
            operationId,
          ],
        );
        // A second offline device may have recorded the same student in the
        // same session.  The unique constraint keeps the first attendance,
        // but silently marking the second operation as applied hides a real
        // business conflict from the operator.  Replay of the same operation
        // is already handled by the operation ledger before this point.
        const existingAttendance = await client.query(
          `SELECT operation_id FROM attendance
             WHERE center_id = $1 AND session_id = $2 AND student_id = $3`,
          [centerId, att.session_id || att.sessionId, att.student_id || att.studentId],
        );
        if (existingAttendance.rows[0] && existingAttendance.rows[0].operation_id !== operationId) {
          throw new Error("ATTENDANCE_ALREADY_RECORDED: student already has attendance for this session.");
        }
        break;
      }

      case "payment":
      case "payment_collected": {
        const pay = payload;
        const paymentStudentId = pay.student_id || pay.studentId;
        const requestedDebtCycleId = pay.debt_cycle_id || pay.debtCycleId || null;
        const requestedSessionId = pay.session_id || pay.sessionId || null;
        const debtCycleExists = requestedDebtCycleId
          ? await client.query(
              "SELECT 1 FROM debt_cycles WHERE center_id = $1 AND id = $2",
              [centerId, requestedDebtCycleId],
            )
          : { rows: [] };
        const sessionExists = requestedSessionId
          ? await client.query(
              "SELECT 1 FROM sessions WHERE center_id = $1 AND id = $2",
              [centerId, requestedSessionId],
            )
          : { rows: [] };
        // Never accept a payment while silently dropping its relation. That
        // makes the receipt look synced but prevents it from reducing the
        // student's debt (and breaks session financial reports). Let the
        // client retry after the parent record has been uploaded.
        if (requestedDebtCycleId && !debtCycleExists.rows.length) {
          throw new Error("PAYMENT_DEBT_CYCLE_NOT_FOUND");
        }
        if (requestedSessionId && !sessionExists.rows.length) {
          throw new Error("PAYMENT_SESSION_NOT_FOUND");
        }
        const debtCycleId = debtCycleExists.rows.length ? requestedDebtCycleId : null;
        const sessionId = sessionExists.rows.length ? requestedSessionId : null;
        const paymentType = normalizePaymentType(pay.payment_type || pay.paymentType);
        const paymentDate = normalizeDateOnly(pay.payment_date || pay.paymentDate) || new Date().toISOString().slice(0, 10);
        // A cancellation may reach the server before a payment that was
        // collected earlier on another offline device. Keep that historical
        // payment valid, but reject payments dated after the enrollment ended.
        if (debtCycleId) {
          const cycleState = await client.query(
            `SELECT status, amount_due, enrollment_id, package_subscription_id
               FROM debt_cycles
              WHERE center_id = $1 AND id = $2`,
            [centerId, debtCycleId],
          );
          const cycle = cycleState.rows[0];
          if (cycle?.status === "cancelled") {
            let boundaryDate = null;
            if (cycle.enrollment_id) {
              const enrollmentState = await client.query(
                `SELECT ended_at::date AS end_date
                   FROM student_group_enrollments
                  WHERE center_id = $1 AND id = $2`,
                [centerId, cycle.enrollment_id],
              );
              boundaryDate = enrollmentState.rows[0]?.end_date || null;
            } else if (cycle.package_subscription_id) {
              const subscriptionState = await client.query(
                `SELECT end_date
                   FROM student_package_subscriptions
                  WHERE center_id = $1 AND id = $2`,
                [centerId, cycle.package_subscription_id],
              );
              boundaryDate = subscriptionState.rows[0]?.end_date || null;
            }
            if (boundaryDate && paymentDate > String(boundaryDate).slice(0, 10)) {
              throw new Error("PAYMENT_AFTER_ENROLLMENT_END");
            }
            await client.query(
              `UPDATE debt_cycles
                  SET amount_due = GREATEST(COALESCE(amount_due, 0), $3::numeric),
                      updated_at = NOW()
                WHERE center_id = $1 AND id = $2`,
              [centerId, debtCycleId, Number(pay.amount) || 0],
            );
          }
        }
        // Append-only ledger insert
        await client.query(
          `INSERT INTO payments 
           (id, operation_id, center_id, student_id, debt_cycle_id, session_id, subscription_id, amount, payment_method, payment_type, payment_date, notes, is_reversed, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, NOW(), $13)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            pay.id,
            operationId,
            centerId,
            paymentStudentId,
            debtCycleId,
            sessionId,
            pay.subscription_id || pay.subscriptionId || null,
            parseFloat(pay.amount),
            pay.payment_method || pay.paymentMethod || "cash",
            paymentType,
            paymentDate,
            pay.notes || null,
            userId,
          ],
        );
        break;
      }

      case "payment_reversal": {
        const rev = payload;
        await client.query(
          `INSERT INTO payment_reversals
           (id, operation_id, center_id, payment_id, reversed_amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            rev.id,
            operationId,
            centerId,
            rev.payment_id || rev.paymentId,
            parseFloat(rev.reversed_amount || rev.reversedAmount),
            rev.reason || "إلغاء إيصال الدفع",
            userId,
          ],
        );

        // Mark payment as reversed
        await client.query(
          "UPDATE payments SET is_reversed = true WHERE id = $1 AND center_id = $2",
          [rev.payment_id || rev.paymentId, centerId],
        );
        break;
      }

      case "debt_adjustment": {
        const adj = payload;
        const rawAmount = Number(adj.adjustment_amount ?? adj.adjustmentAmount ?? adj.amount ?? 0);
        if (!Number.isFinite(rawAmount) || rawAmount === 0) {
          throw new Error("Debt adjustment requires a non-zero amount.");
        }
        const adjustmentType = adj.adjustment_type || adj.adjustmentType || (rawAmount < 0 ? "discount" : "penalty");
        const normalizedType = ["discount", "waiver", "penalty", "correction"].includes(adjustmentType)
          ? adjustmentType
          : (rawAmount < 0 ? "discount" : "penalty");
        await client.query(
          `INSERT INTO debt_adjustments
           (id, operation_id, center_id, debt_cycle_id, adjustment_type, amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            adj.id,
            operationId,
            centerId,
            adj.debt_cycle_id || adj.debtCycleId,
            normalizedType,
            Math.abs(rawAmount),
            adj.reason || "تسوية/خصم معتمد",
            userId,
          ],
        );
        break;
      }

      case "session":
      case "session_created": {
        const sess = payload;
        let sessionId = sess.id || context.entityId;
        const existingSessionRes = await client.query(
          `SELECT group_id, schedule_id, subject_id, teacher_id, session_price,
                  late_after_minutes, session_date, start_time, end_time, status
           FROM sessions WHERE center_id = $1::varchar AND id = $2::varchar`,
          [centerId, sessionId],
        );
        let existingSession = existingSessionRes.rows[0];
        const groupId = sess.group_id || sess.groupId || existingSession?.group_id;
        const scheduleId = sess.schedule_id || sess.scheduleId || existingSession?.schedule_id || null;
        const subjectId = sess.subject_id || sess.subjectId || existingSession?.subject_id || null;
        const teacherId = sess.teacher_id || sess.teacherId || existingSession?.teacher_id || null;
        const sessionPrice = Number(sess.session_price ?? sess.sessionPrice ?? existingSession?.session_price ?? 0);
        const lateAfterMinutes = Number(sess.late_after_minutes ?? sess.lateAfterMinutes ?? existingSession?.late_after_minutes ?? 15);
        const sessionDate = normalizeDateOnly(sess.session_date || sess.sessionDate || existingSession?.session_date);
        const startTime = sess.start_time || sess.startTime || existingSession?.start_time;
        const endTime = sess.end_time || sess.endTime || existingSession?.end_time;
        const action = String(sess.action || context.operationType || "").toLowerCase();
        const isReconcile = action === "session.reconcile";
        const status = action === "close" ? "closed" : action === "reopen" ? "open" : (sess.status || existingSession?.status || "open");
        if (!sessionId || !groupId || !sessionDate || !startTime || !endTime) {
          throw new Error("Session requires group, date, start time, and end time.");
        }
        // Older APKs generated random session ids. If that row already exists
        // under the same natural schedule/date key, reconcile it to the
        // canonical server row instead of tripping the unique index.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`session:${centerId}:${groupId}:${scheduleId || ""}:${sessionDate}`],
        );
        const naturalSessionRes = await client.query(
          `SELECT id FROM sessions
           WHERE center_id = $1 AND group_id = $2
             AND COALESCE(schedule_id, '') = COALESCE($3, '')
             AND session_date = $4
           LIMIT 1`,
          [centerId, groupId, scheduleId, sessionDate],
        );
        const naturalSessionId = naturalSessionRes.rows[0]?.id;
        if (naturalSessionId && naturalSessionId !== sessionId) {
          sessionId = naturalSessionId;
          const canonicalSessionRes = await client.query(
            `SELECT group_id, schedule_id, subject_id, teacher_id, session_price,
                    late_after_minutes, session_date, start_time, end_time, status
             FROM sessions WHERE center_id = $1::varchar AND id = $2::varchar`,
            [centerId, sessionId],
          );
          existingSession = canonicalSessionRes.rows[0] || existingSession;
        }
        // Reconciliation is used to repair a local session after an offline
        // start. If the server already has that session, keep the server's
        // authoritative status/version instead of turning the repair into a
        // stale UPDATE (or accidentally reopening a closed session). Create
        // it only when it is genuinely missing.
        if (!isReconcile || !existingSession) {
          await client.query(
            `INSERT INTO sessions
             (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price,
              late_after_minutes, session_date, start_time, end_time, status, created_at, updated_at)
             VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar,
                     $7::numeric, $8::integer, $9::date, $10::varchar, $11::varchar, $12::varchar, NOW(), NOW())
             ON CONFLICT (id) DO UPDATE SET
               group_id = EXCLUDED.group_id,
               schedule_id = EXCLUDED.schedule_id,
               subject_id = EXCLUDED.subject_id,
               teacher_id = EXCLUDED.teacher_id,
               session_price = EXCLUDED.session_price,
               late_after_minutes = EXCLUDED.late_after_minutes,
               session_date = EXCLUDED.session_date,
               start_time = EXCLUDED.start_time,
               end_time = EXCLUDED.end_time,
               status = EXCLUDED.status,
               updated_at = NOW();`,
            [
              sessionId,
              centerId,
              groupId,
              scheduleId,
              subjectId,
              teacherId,
              sessionPrice,
              lateAfterMinutes,
              sessionDate,
              startTime,
              endTime,
              status,
            ],
          );
        } else if (existingSession) {
          // Reconciliation preserves the server status but repairs the
          // historical metadata used by local dashboards and reports.
          await client.query(
            `UPDATE sessions
                SET group_id = $3::varchar,
                    schedule_id = COALESCE($4::varchar, schedule_id),
                    subject_id = COALESCE($5::varchar, subject_id),
                    teacher_id = COALESCE($6::varchar, teacher_id),
                    session_price = $7::numeric,
                    late_after_minutes = $8::integer,
                    session_date = $9::date,
                    start_time = $10::varchar,
                    end_time = $11::varchar,
                    updated_at = NOW()
              WHERE center_id = $2::varchar AND id = $1::varchar`,
            [sessionId, centerId, groupId, scheduleId, subjectId, teacherId, sessionPrice, lateAfterMinutes, sessionDate, startTime, endTime],
          );
        }
        // Expected students are a historical manifest snapshot. Only create
        // it when supplied by a session-generation operation; updates/cancels
        // leave the existing manifest untouched.
        if (Array.isArray(sess.expectedStudentIds)) {
          for (const studentId of sess.expectedStudentIds) {
            await client.query(
              `INSERT INTO session_expected_students (id, center_id, session_id, student_id)
              SELECT $1::varchar, $2::varchar, $3::varchar, s.id
               FROM students s
               WHERE s.id = $4::varchar AND s.center_id = $2::varchar
               ON CONFLICT (session_id, student_id) DO NOTHING`,
              [`exp-${sessionId}-${studentId}`, centerId, sessionId, studentId],
            );
          }
        }
        if (action === "close") {
          const expected = await client.query("SELECT COUNT(*)::int AS count FROM session_expected_students WHERE center_id = $1 AND session_id = $2", [centerId, sessionId]);
          const attendance = await client.query("SELECT COUNT(*)::int AS count FROM attendance WHERE center_id = $1 AND session_id = $2 AND status = 'present'", [centerId, sessionId]);
          await client.query(
            `INSERT INTO session_closing_records
             (id, center_id, session_id, closed_by, total_expected, total_present, total_absent, total_collected, discrepancy_notes, closed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
             ON CONFLICT (session_id) DO UPDATE SET
               closed_by = EXCLUDED.closed_by, total_expected = EXCLUDED.total_expected,
               total_present = EXCLUDED.total_present, total_absent = EXCLUDED.total_absent,
               total_collected = EXCLUDED.total_collected, discrepancy_notes = EXCLUDED.discrepancy_notes,
               closed_at = NOW()` ,
            [
              `close-${operationId}`, centerId, sessionId,
              sess.performedBy || userId,
              Number(sess.totalExpected ?? expected.rows[0]?.count ?? 0),
              Number(sess.totalAttendance ?? attendance.rows[0]?.count ?? 0),
              Number(sess.totalAbsent ?? Math.max(0, Number(expected.rows[0]?.count || 0) - Number(attendance.rows[0]?.count || 0))),
              Number(sess.totalSessionPayments ?? 0), sess.reason || null,
            ],
          );
        } else if (action === "reopen") {
          await client.query("DELETE FROM session_closing_records WHERE center_id = $1 AND session_id = $2", [centerId, sessionId]);
        }
        break;
      }

      case "teacher":
      case "teacher_created":
      case "teacher_updated": {
        const tch = payload.teacher || payload;
        const teacherId = tch.id || tch.teacherId || context.entityId;
        await client.query(
          `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             phone = EXCLUDED.phone,
             status = EXCLUDED.status,
             notes = EXCLUDED.notes,
             updated_at = NOW();`,
          [
            teacherId,
            centerId,
            tch.name || "معلم بدون اسم",
            tch.phone || null,
            tch.status || "active",
            tch.notes || null,
          ],
        );
        break;
      }

      case "subject":
      case "subject_created":
      case "subject_updated": {
        const subj = payload.subject || payload;
        const subjectId = subj.id || subj.subjectId || context.entityId;
        await client.query(
          `INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             code = EXCLUDED.code,
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            subjectId,
            centerId,
            subj.name || "مادة دراسية",
            subj.code || subj.name || "SUBJ",
            subj.status || "active",
          ],
        );
        break;
      }

      case "teacher_subject":
      case "teacher_subject_assigned": {
        const ts = payload;
        const tsId =
          ts.id ||
          `ts-${centerId}-${ts.teacherId || ts.teacher_id}-${ts.subjectId || ts.subject_id}`;
        if (String(context.operationType || "").toUpperCase() === "DELETE" || ts.status === "inactive") {
          await client.query(
            `DELETE FROM teacher_subjects
             WHERE center_id = $1 AND teacher_id = $2 AND subject_id = $3`,
            [centerId, ts.teacherId || ts.teacher_id, ts.subjectId || ts.subject_id],
          );
        } else {
          await client.query(
            `INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (center_id, teacher_id, subject_id) DO NOTHING;`,
            [
              tsId,
              centerId,
              ts.teacherId || ts.teacher_id,
              ts.subjectId || ts.subject_id,
            ],
          );
        }
        break;
      }

      case "student_card": {
        const card = payload.card || payload;
        const cardId = card.id || context.entityId;
        let studentId = card.student_id || card.studentId;
        const cardCode = String(card.card_code || card.cardCode || "").trim();
        const operation = String(context.operationType || "").toUpperCase();
        const isDeactivation = operation === "DELETE" || card.status === "deactivated" || card.status === "inactive" || card.status === "lost";
        if (!studentId && isDeactivation) {
          const ownerResult = await client.query("SELECT student_id FROM student_cards WHERE id = $1 AND center_id = $2", [cardId, centerId]);
          studentId = ownerResult.rows[0]?.student_id;
        }
        if (!studentId) {
          throw new Error("Student card requires studentId.");
        }
        if (!isDeactivation && !cardCode) {
          throw new Error("Student card requires cardCode.");
        }
        const owner = await client.query(
          "SELECT id FROM students WHERE id = $1 AND center_id = $2",
          [studentId, centerId],
        );
        if (owner.rows.length === 0) {
          throw new Error("Student card owner is outside the authenticated center.");
        }
        if (isDeactivation) {
          await client.query(
            `UPDATE student_cards SET status = $1, deactivated_at = NOW()
             WHERE id = $2 AND center_id = $3`,
            [card.status === "lost" ? "lost" : "deactivated", cardId, centerId],
          );
        } else {
          await validateCardCode(client, centerId, cardCode);
          const globalOwner = await client.query("SELECT center_id FROM student_cards WHERE card_code = $1 AND status = 'active' LIMIT 1", [cardCode]);
          if (globalOwner.rows[0] && globalOwner.rows[0].center_id !== centerId) throw new AppError("CARD_BELONGS_TO_OTHER_CENTER", "Card belongs to another center.", "الكارت تابع لمركز آخر.", 403);
          await client.query(
            `UPDATE student_cards
             SET status = 'deactivated', deactivated_at = NOW()
             WHERE center_id = $1 AND student_id = $2 AND status = 'active' AND id <> $3`,
            [centerId, studentId, cardId],
          );
          const existingByCode = await client.query(
            `SELECT id, student_id, status FROM student_cards
             WHERE center_id = $1 AND card_code = $2`,
            [centerId, cardCode],
          );
          if (existingByCode.rows.length > 0) {
            // Student creation already persists this card. A follow-up
            // student_card operation for the same student is duplicate
            // delivery and must be idempotent, not a conflict.
            if (existingByCode.rows[0].status === "active" && existingByCode.rows[0].student_id !== studentId) {
              throw new AppError("CARD_ALREADY_ASSIGNED", "Card is already assigned.", "الكارت مرتبط بطالب بالفعل ولا يمكن نقله.", 409);
            }
            await client.query(
              `UPDATE student_cards
               SET student_id = $1, status = 'active', issued_at = NOW(), deactivated_at = NULL
               WHERE id = $2 AND center_id = $3`,
              [studentId, existingByCode.rows[0].id, centerId],
            );
          } else {
            try {
              await client.query(
                `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
                 VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   card_code = EXCLUDED.card_code,
                   status = 'active',
                   deactivated_at = NULL`,
                [cardId, centerId, studentId, cardCode],
              );
            } catch (cardErr) {
              // A concurrent/replayed delivery may win the card-code unique
              // index between the owner check above and this insert. Treat it
              // as idempotent when the winning row belongs to this student;
              // otherwise return a stable domain conflict instead of exposing
              // a raw PostgreSQL constraint error.
              if (cardErr?.code !== "23505" || !String(cardErr?.constraint || cardErr?.message || "").includes("uq_center_card_code")) {
                throw cardErr;
              }
              const winner = await client.query(
                "SELECT student_id FROM student_cards WHERE center_id = $1 AND card_code = $2",
                [centerId, cardCode],
              );
              if (winner.rows[0]?.student_id !== studentId) {
                throw new AppError("CARD_ALREADY_ASSIGNED", "Card is already assigned.", "الكارت مرتبط بطالب آخر.", 409);
              }
            }
          }
        }
        break;
      }

      case "enrollment": {
        const enrollment = payload.enrollment || payload;
        const enrollmentId = enrollment.id || context.entityId;
        const existing = await client.query(
          `SELECT student_id, group_id, price_override, status, joined_at, ended_at
           FROM student_group_enrollments
           WHERE center_id = $1 AND id = $2`,
          [centerId, enrollmentId],
        );
        const previous = existing.rows[0];
        const studentId = enrollment.student_id || enrollment.studentId || previous?.student_id;
        const groupId = enrollment.group_id || enrollment.groupId || previous?.group_id;
        if (!studentId || !groupId) {
          throw new Error("Enrollment requires studentId and groupId.");
        }
        // The local app calls an ended enrollment `ended`; PostgreSQL's
        // canonical status is `withdrawn` (history is still preserved).
        const requestedStatus = enrollment.status || previous?.status || "active";
        const status = requestedStatus === "ended" ? "withdrawn" : requestedStatus;
        const priceOverride = enrollment.price_override ?? enrollment.priceOverride ?? enrollment.specialMonthlyPrice ?? previous?.price_override ?? null;
        const joinedAt = enrollment.start_date || enrollment.startDate || enrollment.joined_at || enrollment.joinedAt || previous?.joined_at || null;
        const endedAt = enrollment.end_date || enrollment.endDate || enrollment.ended_at || enrollment.endedAt || (status === "withdrawn" ? new Date().toISOString() : previous?.ended_at || null);

        // A server-reset repair can carry the same student/group enrollment
        // under a new local id. PostgreSQL enforces the natural key
        // (center_id, student_id, group_id), so reconcile that row instead of
        // turning an otherwise valid repair into a permanent conflict.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`enrollment:${centerId}:${studentId}:${groupId}`],
        );
        const naturalRes = await client.query(
          `SELECT id FROM student_group_enrollments
           WHERE center_id = $1 AND student_id = $2 AND group_id = $3
           LIMIT 1`,
          [centerId, studentId, groupId],
        );
        const naturalId = naturalRes.rows[0]?.id;
        if (naturalId && naturalId !== enrollmentId) {
          await client.query(
            `UPDATE student_group_enrollments
                SET price_override = $2,
                    status = $3,
                    joined_at = COALESCE($4::timestamptz, joined_at),
                    ended_at = $5,
                    updated_at = NOW()
              WHERE center_id = $1 AND id = $6`,
            [centerId, priceOverride, status, joinedAt, endedAt, naturalId],
          );
          // Pull consumers use the payload id when present. Returning the
          // canonical id prevents another device from creating a duplicate
          // local enrollment while preserving the original operation id.
          if (payload.enrollment && typeof payload.enrollment === "object") {
            payload.enrollment.id = naturalId;
          } else if (payload && typeof payload === "object") {
            payload.id = naturalId;
          }
          break;
        }
        await client.query(
          `INSERT INTO student_group_enrollments
           (id, center_id, student_id, group_id, price_override, status, joined_at, ended_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             price_override = EXCLUDED.price_override,
             status = EXCLUDED.status,
             joined_at = EXCLUDED.joined_at,
             ended_at = EXCLUDED.ended_at,
             updated_at = NOW()`,
          [
            enrollmentId,
            centerId,
            studentId,
            groupId,
            priceOverride,
            status,
            joinedAt,
            endedAt,
          ],
        );
        break;
      }

      case "group":
      case "group_created":
      case "group_updated": {
        const grp = payload.group || payload;
        const groupId = grp.id || grp.groupId || context.entityId;
        const groupStatus = (grp.status || "active") === "inactive" ? "archived" : (grp.status || "active");
        const existingGroup = await client.query(
          `SELECT name, teacher_id, subject_id, grade, default_fee, session_price,
                  monthly_price, session_duration_minutes, late_after_minutes, status
             FROM groups WHERE center_id = $1 AND id = $2`,
          [centerId, groupId],
        );
        const previous = existingGroup.rows[0] || {};
        const defaultFee = Number(grp.default_fee ?? grp.defaultFee ?? grp.session_price ?? grp.sessionPrice ?? previous.default_fee ?? 0);
        const sessionPrice = Number(grp.session_price ?? grp.sessionPrice ?? previous.session_price ?? defaultFee);
        const monthlyPrice = Number(grp.monthly_price ?? grp.monthlyPrice ?? previous.monthly_price ?? defaultFee * 4);
        const duration = Number(grp.session_duration_minutes ?? grp.sessionDurationMinutes ?? previous.session_duration_minutes ?? 120);
        const lateAfter = Number(grp.late_after_minutes ?? grp.lateAfterMinutes ?? previous.late_after_minutes ?? 15);
        await client.query(
          `INSERT INTO groups
             (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price,
              monthly_price, session_duration_minutes, late_after_minutes, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             teacher_id = EXCLUDED.teacher_id,
             subject_id = EXCLUDED.subject_id,
             grade = EXCLUDED.grade,
             default_fee = EXCLUDED.default_fee,
             session_price = EXCLUDED.session_price,
             monthly_price = EXCLUDED.monthly_price,
             session_duration_minutes = EXCLUDED.session_duration_minutes,
             late_after_minutes = EXCLUDED.late_after_minutes,
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            groupId,
            centerId,
            grp.name || "مجموعة دراسية",
            grp.teacher_id || grp.teacherId,
            grp.subject_id || grp.subjectId,
            grp.grade || "الصف الثالث الثانوي",
            defaultFee,
            sessionPrice,
            monthlyPrice,
            duration,
            lateAfter,
            groupStatus,
          ],
        );
        break;
      }

      case "group_schedule": {
        const sched = payload;
        const schedId = sched.id || context.entityId || `sched-${Date.now()}`;
        const operation = String(context.operationType || "").toUpperCase();
        if (["DELETE", "REMOVE"].includes(operation) || sched.status === "inactive") {
          await client.query(
            `DELETE FROM group_schedules WHERE id = $1 AND center_id = $2`,
            [schedId, centerId],
          );
          break;
        }
        const existing = await client.query(
          `SELECT group_id, day_of_week, start_time, end_time FROM group_schedules WHERE id = $1 AND center_id = $2`,
          [schedId, centerId],
        );
        // Status-only updates (activate/deactivate) must not overwrite the
        // schedule with null day/time values from a compact offline payload.
        if (existing.rows[0] && (!sched.groupId && !sched.group_id && sched.status === "active")) {
          break;
        }
        const groupId = sched.group_id || sched.groupId || existing.rows[0]?.group_id;
        const dayOfWeek = parseInt(sched.day_of_week ?? sched.dayOfWeek ?? existing.rows[0]?.day_of_week, 10);
        const startTime = sched.start_time || sched.startTime || existing.rows[0]?.start_time;
        const endTime = sched.end_time || sched.endTime || existing.rows[0]?.end_time;
        const groupRes = await client.query(
          `SELECT teacher_id FROM groups WHERE center_id = $1 AND id = $2 AND status = 'active'`,
          [centerId, groupId],
        );
        if (!groupRes.rows[0]) throw new Error("GROUP_NOT_FOUND_OR_INACTIVE");
        // Serialize schedule writes and reject any overlap for the same
        // teacher, including partial overlaps (15:00-17:00 vs 16:00-18:00).
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule:${centerId}:${groupRes.rows[0].teacher_id}:${dayOfWeek}`]);
        const conflict = await client.query(
          `SELECT gs.start_time, gs.end_time, g.name AS group_name
           FROM group_schedules gs
           JOIN groups g ON g.center_id = gs.center_id AND g.id = gs.group_id
           WHERE gs.center_id = $1 AND gs.id <> $2 AND gs.day_of_week = $3
             AND g.teacher_id = $4
             AND NOT ($5::varchar <= gs.start_time OR $6::varchar >= gs.end_time)
           LIMIT 1`,
          [centerId, schedId, dayOfWeek, groupRes.rows[0].teacher_id, endTime, startTime],
        );
        if (conflict.rows[0]) {
          throw new Error(`TEACHER_SCHEDULE_CONFLICT:${conflict.rows[0].group_name || "group"}:${conflict.rows[0].start_time}-${conflict.rows[0].end_time}`);
        }
        await client.query(
          `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (id) DO UPDATE SET
             group_id = EXCLUDED.group_id,
             day_of_week = EXCLUDED.day_of_week,
             start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time;`,
          [
            schedId,
            centerId,
            groupId,
            dayOfWeek,
            startTime,
            endTime,
          ],
        );
        break;
      }

      case "package": {
        const pkg = payload.package || payload;
        const packageId = pkg.id || pkg.packageId || context.entityId;
        const existing = await client.query("SELECT name, grade, total_price, max_selections, billing_cycle, status FROM packages WHERE center_id = $1 AND id = $2", [centerId, packageId]);
        const prev = existing.rows[0] || {};
        const packageStatus = pkg.status === "canceled" ? "inactive" : (pkg.status ?? prev.status ?? "active");
        await client.query(
          `INSERT INTO packages (id, center_id, name, grade, total_price, max_selections, billing_cycle, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, grade=EXCLUDED.grade,
             total_price=EXCLUDED.total_price, max_selections=EXCLUDED.max_selections, billing_cycle=EXCLUDED.billing_cycle,
             status=EXCLUDED.status, updated_at=NOW()` ,
          [packageId, centerId, pkg.name ?? prev.name, pkg.grade ?? prev.grade ?? "all", Number(pkg.total_price ?? pkg.totalPrice ?? pkg.price ?? prev.total_price ?? 0), Math.max(1, Number(pkg.max_selections ?? pkg.maxSelections ?? prev.max_selections ?? 1)), pkg.billing_cycle ?? pkg.billingCycle ?? prev.billing_cycle ?? "monthly", packageStatus],
        );
        break;
      }

      case "package_subject": {
        const link = payload.packageSubject || payload;
        const removeOperation = String(context.operationType || "").toUpperCase();
        const remove = ["DELETE", "REMOVE"].includes(removeOperation) || removeOperation.includes("REMOVE") || link.status === "inactive";
        if (remove) {
          if (link.id) {
            await client.query("DELETE FROM package_subjects WHERE center_id = $1 AND id = $2", [centerId, link.id]);
          } else if (link.default_teacher_id || link.defaultTeacherId || link.teacher_id || link.teacherId) {
            await client.query(
              "DELETE FROM package_subjects WHERE center_id = $1 AND package_id = $2 AND subject_id = $3 AND default_teacher_id = $4",
              [centerId, link.package_id || link.packageId, link.subject_id || link.subjectId, link.default_teacher_id || link.defaultTeacherId || link.teacher_id || link.teacherId],
            );
          } else {
            await client.query("DELETE FROM package_subjects WHERE center_id = $1 AND package_id = $2 AND subject_id = $3", [centerId, link.package_id || link.packageId, link.subject_id || link.subjectId]);
          }
        } else {
          await client.query(
            `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, group_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())
             ON CONFLICT (center_id, package_id, subject_id, default_teacher_id) DO NOTHING`,
            [link.id || context.entityId || `pkg-sub-${centerId}-${link.package_id || link.packageId}-${link.subject_id || link.subjectId}`, centerId, link.package_id || link.packageId, link.subject_id || link.subjectId, link.default_teacher_id || link.defaultTeacherId || link.teacher_id || link.teacherId, link.group_id || link.groupId || null],
          );
        }
        break;
      }

      case "package_subscription": {
        const sub = payload.subscription || payload;
        const id = sub.id || sub.subscriptionId || context.entityId;
        const existing = await client.query("SELECT student_id, package_id, price_override, status, start_date, end_date FROM student_package_subscriptions WHERE center_id=$1 AND id=$2", [centerId, id]);
        const prev = existing.rows[0] || {};
        const requestedStatus = sub.status || (sub.cancellationDate || sub.cancellation_date ? "cancelled" : prev.status || "active");
        const status = requestedStatus === "ended" ? "completed" : requestedStatus === "canceled" ? "cancelled" : requestedStatus;
        await client.query(
          `INSERT INTO student_package_subscriptions (id, center_id, student_id, package_id, price_override, status, start_date, end_date, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
           ON CONFLICT (id) DO UPDATE SET student_id=EXCLUDED.student_id, package_id=EXCLUDED.package_id,
             price_override=EXCLUDED.price_override, status=EXCLUDED.status, start_date=EXCLUDED.start_date,
             end_date=EXCLUDED.end_date, updated_at=NOW()`,
          [id, centerId, sub.student_id || sub.studentId || prev.student_id, sub.package_id || sub.packageId || prev.package_id, sub.price_override ?? sub.priceOverride ?? prev.price_override ?? null, status, sub.start_date || sub.startDate || prev.start_date || new Date().toISOString().slice(0,10), sub.end_date || sub.endDate || prev.end_date || null],
        );
        break;
      }

      case "package_teacher_override": {
        const override = payload.override || payload;
        const removeOperation = String(context.operationType || "").toUpperCase();
        const remove = ["DELETE", "REMOVE"].includes(removeOperation) || removeOperation.includes("REMOVE") || override.status === "inactive";
        if (remove) {
          await client.query("DELETE FROM package_subject_teacher_overrides WHERE center_id=$1 AND subscription_id=$2 AND subject_id=$3", [centerId, override.subscription_id || override.subscriptionId, override.subject_id || override.subjectId]);
        } else {
          const overrideId = override.id || context.entityId || `pkg-override-${centerId}-${override.subscription_id || override.subscriptionId}-${override.subject_id || override.subjectId}`;
          const subscriptionId = override.subscription_id || override.subscriptionId;
          const subjectId = override.subject_id || override.subjectId;
          const teacherId = override.teacher_id || override.teacherId;
          const groupId = override.group_id || override.groupId || null;
          // Do not depend solely on a database unique index here. Some older
          // Neon databases may still contain duplicate rows from before the
          // constraint was introduced; updating by natural key makes those
          // queued operations retryable while the bootstrap migration cleans
          // the redundant rows.
          const updated = await client.query(
            `UPDATE package_subject_teacher_overrides
                SET teacher_id=$1, group_id=$2
              WHERE center_id=$3 AND subscription_id=$4 AND subject_id=$5`,
            [teacherId, groupId, centerId, subscriptionId, subjectId],
          );
          if (updated.rowCount === 0) {
            await client.query(
              `INSERT INTO package_subject_teacher_overrides
                (id, center_id, subscription_id, subject_id, teacher_id, group_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())
               ON CONFLICT (id) DO UPDATE SET teacher_id=EXCLUDED.teacher_id, group_id=EXCLUDED.group_id`,
              [overrideId, centerId, subscriptionId, subjectId, teacherId, groupId],
            );
          }
        }
        break;
      }

      case "debt_cycle": {
        const cycle = payload.debtCycle || payload;
        const id = cycle.id || cycle.debtCycleId || context.entityId;
        const studentId = cycle.student_id || cycle.studentId;
        const requestedEnrollmentId = cycle.enrollment_id || cycle.enrollmentId || null;
        if (!studentId) throw new Error("Debt cycle requires studentId.");
        const studentExists = await client.query(
          "SELECT 1 FROM students WHERE center_id = $1 AND id = $2",
          [centerId, studentId],
        );
        if (studentExists.rows.length === 0) {
          throw new Error("Debt cycle student is not present in this center yet.");
        }
        // Package cycles historically used the subscription id in
        // enrollmentId. The server FK points to the enrollment table, so
        // retain the relation only when the referenced enrollment exists.
        let enrollmentId = requestedEnrollmentId;
        if (enrollmentId) {
          const enrollmentExists = await client.query(
            "SELECT 1 FROM student_group_enrollments WHERE center_id = $1 AND id = $2",
            [centerId, enrollmentId],
          );
          if (enrollmentExists.rows.length === 0) enrollmentId = null;
        }
        // Idempotency is provided by the operation/entity id (ON CONFLICT id).
        // The cycle identity fields are persisted so bootstrap can reconstruct
        // group-scoped and multi-cycle balances accurately.
        const targetId = id;
        const groupId = cycle.group_id || cycle.groupId || null;
        const packageId = cycle.package_id || cycle.packageId || null;
        const cycleNumber = Number(cycle.cycle_number ?? cycle.cycleNumber ?? 1);
        const packageSubscriptionId = cycle.package_subscription_id || cycle.packageSubscriptionId || null;
        const cycleType = normalizeDebtCycleType(
          cycle.cycle_type || cycle.cycleType,
          Boolean(packageSubscriptionId),
        );
        const normalizedCycleStatus = normalizeDebtCycleStatus(cycle.status);
        const requestedCycleAmount = Number(
          cycle.cycle_price ?? cycle.cyclePrice ?? cycle.amount_due ?? cycle.amountDue ?? 0,
        );
        // A cancellation arriving after another offline device's payment must
        // waive only the unpaid remainder. Never overwrite the cycle amount
        // with zero when the server already has an immutable payment ledger.
        const amountForCycle = async (cycleId) => {
          if (!cycleId || !["cancelled", "waived"].includes(normalizedCycleStatus)) {
            return requestedCycleAmount;
          }
          const paid = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS paid
               FROM payments
              WHERE center_id = $1 AND debt_cycle_id = $2
                AND (is_reversed = FALSE OR is_reversed IS NULL)`,
            [centerId, cycleId],
          );
          return Math.max(requestedCycleAmount, Number(paid.rows[0]?.paid || 0));
        };
        // Reconcile by the business identity as well as the operation id.
        // Devices can generate different UUIDs for the same monthly/package
        // cycle while offline; inserting the second UUID would violate the
        // natural unique index and leave the operation stuck in conflict.
        const naturalOwner = enrollmentId || packageSubscriptionId;
        if (naturalOwner && cycleNumber !== null && cycleNumber !== undefined) {
          const naturalRes = await client.query(
            `SELECT id FROM debt_cycles
             WHERE center_id = $1
               AND COALESCE(enrollment_id, package_subscription_id) = $2
               AND cycle_number = $3
             LIMIT 1`,
            [centerId, naturalOwner, cycleNumber],
          );
          const naturalId = naturalRes.rows[0]?.id;
          if (naturalId && naturalId !== targetId) {
            const effectiveAmount = await amountForCycle(naturalId);
            await client.query(
              `UPDATE debt_cycles
                  SET student_id=$2, enrollment_id=$3, group_id=$4,
                      package_subscription_id=$5, package_id=$6,
                      cycle_number=$7, cycle_type=$8, period_start=$9,
                      period_end=$10, amount_due=$11, status=$12,
                      notes=$13, updated_at=NOW()
                WHERE center_id=$1 AND id=$14`,
              [centerId, studentId, enrollmentId, groupId, packageSubscriptionId, packageId,
                cycleNumber, cycleType, cycle.start_date || cycle.startDate || cycle.period_start,
                cycle.end_date || cycle.endDate || cycle.period_end,
                effectiveAmount,
                normalizedCycleStatus, cycle.notes || null, naturalId],
            );
            break;
          }
        }
        const effectiveAmount = await amountForCycle(targetId);
        await client.query(`INSERT INTO debt_cycles
          (id, center_id, student_id, enrollment_id, group_id, package_subscription_id, package_id, cycle_number, cycle_type, period_start, period_end, amount_due, status, notes, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
          ON CONFLICT (id) DO UPDATE SET student_id=EXCLUDED.student_id, enrollment_id=EXCLUDED.enrollment_id,
            group_id=EXCLUDED.group_id, package_subscription_id=EXCLUDED.package_subscription_id,
            package_id=EXCLUDED.package_id, cycle_number=EXCLUDED.cycle_number, cycle_type=EXCLUDED.cycle_type,
            period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, amount_due=EXCLUDED.amount_due,
            status=EXCLUDED.status, notes=EXCLUDED.notes, updated_at=NOW()`,
          [targetId, centerId, studentId, enrollmentId, groupId, packageSubscriptionId, packageId, cycleNumber, cycleType, cycle.start_date || cycle.startDate || cycle.period_start, cycle.end_date || cycle.endDate || cycle.period_end, effectiveAmount, normalizedCycleStatus, cycle.notes || null]);
        break;
      }

      case "advance_coverage": {
        const coverage = payload.coverage || payload;
        await client.query(`INSERT INTO advance_coverages (id, center_id, student_id, advance_session_id, target_future_session_id, created_at)
          VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (id) DO UPDATE SET target_future_session_id=EXCLUDED.target_future_session_id`,
          [coverage.id || context.entityId, centerId, coverage.student_id || coverage.studentId, coverage.advance_session_id || coverage.advanceSessionId, coverage.target_future_session_id || coverage.targetFutureSessionId]);
        break;
      }

      case "grade_exam": {
        const exam = payload.exam || payload;
        const id = exam.id || context.entityId;
        if (!id || !exam.name || !exam.grade) throw new Error("Grade exam requires name and grade.");
          await client.query(`INSERT INTO grade_exams (id, center_id, name, grade, group_id, max_score, status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()),NOW())
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, grade=EXCLUDED.grade, group_id=EXCLUDED.group_id, max_score=EXCLUDED.max_score, status=EXCLUDED.status, updated_at=NOW()`,
          [id, centerId, exam.name, exam.grade, exam.group_id || exam.groupId || null, Number(exam.max_score ?? exam.maxScore ?? 100), exam.status || "active", exam.created_at || exam.createdAt || null]);
        break;
      }

      case "grade_score": {
        const score = payload.scoreRecord || payload;
        const id = score.id || context.entityId;
        const examId = score.exam_id || score.examId;
        const studentId = score.student_id || score.studentId;
        if (!id || !examId || !studentId) throw new Error("Grade score requires exam and student.");
        await client.query(`INSERT INTO grade_scores (id, center_id, exam_id, student_id, score, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()),NOW())
          ON CONFLICT (center_id, exam_id, student_id) DO UPDATE SET score=EXCLUDED.score, updated_at=NOW()`,
          [id, centerId, examId, studentId, score.score === "" ? null : (score.score ?? null), score.created_at || score.createdAt || null]);
        break;
      }

      case "notification_event": {
        const event = payload.event || payload;
        const id = event.id || event.eventId || context.entityId;
        const studentId = event.student_id || event.studentId;
        const phone = event.recipient_phone || event.recipientPhone || (await client.query("SELECT phone, parent_phone FROM students WHERE center_id=$1 AND id=$2", [centerId, studentId])).rows[0]?.parent_phone || (await client.query("SELECT phone FROM students WHERE center_id=$1 AND id=$2", [centerId, studentId])).rows[0]?.phone || "";
        await client.query(`INSERT INTO notification_events (id, center_id, student_id, session_id, event_type, recipient_phone, channel, status, payload, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW()) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload`,
          [id, centerId, studentId, event.session_id || event.sessionId || null, event.event_type || event.eventType || "attendance", phone, event.channel || "push", JSON.stringify(event)]);
        break;
      }

      case "notification_template": {
        const template = payload.template || payload;
        const templateId = template.id || template.templateId || context.entityId;
        if (!templateId || !template.event_type && !template.eventType || !template.channel) {
          throw new Error("Notification template requires id, event type, and channel.");
        }
        await client.query(
          `INSERT INTO notification_templates
             (id, center_id, event_type, channel, template_body, is_default, created_by, updated_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
           ON CONFLICT (center_id, event_type, channel, is_default) DO UPDATE SET
             template_body=EXCLUDED.template_body,
             updated_by=EXCLUDED.updated_by, updated_at=NOW()` ,
          [
            templateId,
            centerId,
            template.event_type || template.eventType,
            template.channel,
            template.template_body || template.templateBody || "",
            Boolean(template.is_default ?? template.isDefault),
            template.created_by || template.createdBy || userId,
            template.updated_by || template.updatedBy || userId,
          ],
        );
        break;
      }

      case "notification_delivery": {
        const delivery = payload.delivery || payload;
        const id = delivery.id || delivery.deliveryId || context.entityId;
        const channel = delivery.channel || delivery.provider || "push";
        await client.query(`INSERT INTO notification_deliveries
          (id, center_id, notification_event_id, provider, status, retry_count, response_payload, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, status=EXCLUDED.status,
            retry_count=EXCLUDED.retry_count, response_payload=EXCLUDED.response_payload`,
          [id, centerId, delivery.notification_event_id || delivery.notificationEventId, channel, delivery.status === "pending" ? "queued" : (delivery.status || "queued"), Number(delivery.retry_count || 0), JSON.stringify(delivery.response_payload || delivery.responsePayload || {})]);
        if (channel === "sms") {
          const serviceState = await client.query("SELECT enabled FROM center_services WHERE center_id=$1 AND service_key='sms'", [centerId]);
          if ((serviceState.rows[0] && serviceState.rows[0].enabled === false) || !zadxSmsProvider.isConfigured()) {
            await client.query(`UPDATE notification_deliveries SET status='failed', response_payload=$1 WHERE id=$2 AND center_id=$3`, [JSON.stringify({ category: "sms_disabled" }), id, centerId]);
            break;
          }
          try {
            const result = await zadxSmsProvider.send({
              to: delivery.recipient || delivery.recipientPhone,
              message: delivery.rendered_message || delivery.renderedMessage || "",
              idempotencyKey: `fixion-sms-${id}`,
            });
            await client.query(`UPDATE notification_deliveries
              SET status='sent', provider_message_id=$1, response_payload=$2
              WHERE id=$3 AND center_id=$4`,
              [result.providerMessageId, JSON.stringify({ httpStatus: result.httpStatus, providerMessageId: result.providerMessageId }), id, centerId]);
            console.info("SMS delivery accepted", { deliveryId: id, centerId, provider: "zadx", httpStatus: result.httpStatus, providerMessageId: result.providerMessageId || null });
          } catch (error) {
            await client.query(`UPDATE notification_deliveries
              SET status='failed', retry_count=retry_count+1, response_payload=$1
              WHERE id=$2 AND center_id=$3`,
              [JSON.stringify({ category: error.category || "provider_error", httpStatus: error.httpStatus || null, retryable: Boolean(error.retryable) }), id, centerId]);
            console.warn("SMS delivery failed", { deliveryId: id, centerId, provider: "zadx", category: error.category || "provider_error", httpStatus: error.httpStatus || null });
          }
        }
        break;
      }

      case "daily_closing": {
        const close = payload.closing || payload;
        const date = close.business_date || close.businessDate;
        const closeAction = String(close.action || context.operationType || "").toLowerCase();
        const reopen = closeAction === "reopen" || Boolean(close.reopenedBy || close.reopened_by);
        await client.query(`INSERT INTO daily_closing_summaries (id, center_id, business_date, closed_by, total_sessions, total_attendees, total_revenue, cash_in_drawer, status, notes, closed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${reopen ? "NULL" : "NOW()"})
          ON CONFLICT (center_id, business_date) DO UPDATE SET closed_by=EXCLUDED.closed_by,
            total_sessions=EXCLUDED.total_sessions, total_attendees=EXCLUDED.total_attendees,
            total_revenue=EXCLUDED.total_revenue, cash_in_drawer=EXCLUDED.cash_in_drawer,
            status=EXCLUDED.status, notes=EXCLUDED.notes, closed_at=EXCLUDED.closed_at`,
          [close.id || context.entityId || `daily-${centerId}-${date}`, centerId, date, close.closed_by || close.closedBy || close.reopenedBy || userId, Number(close.total_sessions || 0), Number(close.total_attendees || 0), Number(close.total_revenue ?? close.totalRevenue ?? close.totalCash ?? 0), Number(close.cash_in_drawer ?? close.cashInDrawer ?? close.totalCash ?? 0), reopen ? "reopened" : "closed", close.reason || close.notes || null]);
        break;
      }

      default:
        throw new Error(`Unsupported sync entity type: ${entityType}`);
    }
  }
}

module.exports = SyncProcessor;
