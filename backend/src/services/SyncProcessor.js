const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");

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

class SyncProcessor {
  /**
   * Processes a batch of sync operations inside a true ACID transaction.
   */
  static async processPush(centerId, userId, deviceId, operations) {
    return db.withTransaction(async (client) => {
      const syncedOperationIds = [];
      const conflicts = [];
      let maxServerSeq = 0;

      // Get current highest server sequence for the center
      const currentSeqRes = await client.query(
        "SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM server_sync_operations WHERE center_id = $1",
        [centerId],
      );
      maxServerSeq = parseInt(currentSeqRes.rows[0].max_seq, 10);

      for (const op of operations) {
        const {
          operationId,
          operationType,
          entityType,
          entityId,
          payload,
          createdAt,
        } = op;

        if (!operationId) {
          conflicts.push({
            operationId: null,
            entityType,
            entityId,
            reason: "operationId is required for every sync operation.",
            resolution: "manual_review",
          });
          continue;
        }

        // 1. Check if operation was already processed (Database-level Idempotency)
        const existingOp = await client.query(
          "SELECT server_seq, status, center_id FROM server_sync_operations WHERE operation_id = $1",
          [operationId],
        );

        if (existingOp.rows.length > 0) {
          if (existingOp.rows[0].center_id !== centerId) {
            conflicts.push({
              operationId,
              entityType,
              entityId,
              reason: "operationId is already owned by another center.",
              resolution: "server_wins",
            });
            continue;
          }
          syncedOperationIds.push(operationId);
          const existingSeq = parseInt(existingOp.rows[0].server_seq, 10);
          if (existingSeq > maxServerSeq) {
            maxServerSeq = existingSeq;
          }
          continue;
        }

        // 2. Tenant isolation assertion: Operation center MUST match authenticated session center
        if (op.centerId && op.centerId !== centerId) {
          conflicts.push({
            operationId,
            entityType,
            entityId,
            reason: `Tenant mismatch: operation belongs to '${op.centerId}', authenticated center is '${centerId}'.`,
            resolution: "server_wins",
          });
          continue;
        }

        await client.query("SAVEPOINT op_savepoint");
        try {
          await SyncProcessor.assertFreshMutation(client, centerId, entityType, entityId, payload, operationType);
          // 3. Dispatch and apply domain mutation atomically
          await SyncProcessor.applyDomainMutation(client, {
            centerId,
            userId,
            deviceId,
            operationId,
            operationType,
            entityType,
            entityId,
            payload:
              typeof payload === "string" ? JSON.parse(payload) : payload,
            createdAt,
          });

          // 4. Ingest operation into monotonic server ledger
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
              JSON.stringify(payload || {}),
              createdAt || new Date().toISOString(),
            ],
          );

          const seq = parseInt(ingestRes.rows[0].server_seq, 10);
          if (seq > maxServerSeq) {
            maxServerSeq = seq;
          }

          // 5. Record Server-Side Audit Trail
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
              `${entityType || "entity"}.${operationType || "mutate"}`,
              JSON.stringify(payload || {}),
            ],
          );

          await client.query("RELEASE SAVEPOINT op_savepoint");
          syncedOperationIds.push(operationId);
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
            operationId,
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
          syncedOperationIds[syncedOperationIds.length - 1] || null,
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
          `SELECT student_code, card_code, full_name, phone, parent_phone, grade, student_type, notes, status
           FROM students WHERE center_id = $1 AND id = $2`,
          [centerId, studentId],
        );
        const existingStudent = existingStudentRes.rows[0];
        const cardCode = String(
          student.card_code || student.cardCode || student.student_code || student.studentCode || existingStudent?.card_code || existingStudent?.student_code || "",
        ).trim();
        const studentCode = String(
          student.student_code || student.studentCode || existingStudent?.student_code || cardCode,
        ).trim();
        const status = student.status || existingStudent?.status || "active";
        const cardWasProvided = Boolean(payload.card || !existingStudent);

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
            `SELECT student_id AS owner_id FROM student_cards
             WHERE center_id = $1 AND card_code = $2
             UNION
             SELECT id AS owner_id FROM students
             WHERE center_id = $1 AND card_code = $2`,
            [centerId, cardCode],
          );
          const otherOwner = cardOwner.rows.find((row) => row.owner_id !== studentId);
          if (otherOwner) {
            if (operationType === "REPAIR_AFTER_SERVER_RESET") {
              cardConflictWithAnotherStudent = true;
            } else {
              throw new Error(
                `Card code '${cardCode}' is already assigned to another student in this center.`,
              );
            }
          }
        }
        const persistedCardCode = cardConflictWithAnotherStudent
          ? (existingStudent?.card_code || null)
          : cardCode;

        const rawStudentType = student.student_type || student.studentType || existingStudent?.student_type || "registered";
        // PostgreSQL's legacy enum uses registered for external/guest-style
        // students; normalize the mobile value before writing it.
        const studentType = rawStudentType === "external" ? "registered" : rawStudentType;

        // 1. Insert Student with exact leading zeros preserved
        await client.query(
          `INSERT INTO students 
           (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, student_type, notes, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             student_code = EXCLUDED.student_code,
             card_code = EXCLUDED.card_code,
             full_name = EXCLUDED.full_name,
             phone = EXCLUDED.phone,
             parent_phone = EXCLUDED.parent_phone,
             grade = EXCLUDED.grade,
             notes = EXCLUDED.notes,
             status = EXCLUDED.status,
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
          ],
        );

        // 2. Insert Active Physical Card
        const cardId = payload.card?.id || `card-${studentId}`;
        if (persistedCardCode && cardWasProvided) {
          await client.query(
            `UPDATE student_cards
             SET status = 'deactivated', deactivated_at = NOW()
             WHERE center_id = $1 AND student_id = $2 AND status = 'active' AND id <> $3`,
            [centerId, studentId, cardId],
          );
          await client.query(
            `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             ON CONFLICT (id) DO UPDATE SET
               card_code = EXCLUDED.card_code,
               status = EXCLUDED.status,
               deactivated_at = CASE WHEN EXCLUDED.status = 'active' THEN NULL ELSE student_cards.deactivated_at END;`,
            [cardId, centerId, studentId, persistedCardCode, status === "active" ? "active" : "deactivated"],
          );
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
            att.status || "present",
            att.is_late ? true : false,
            att.attendance_type || att.attendanceType || "present",
            att.original_absence_id || att.originalAbsenceId || null,
            operationId,
          ],
        );
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
        // Relations can be absent when an old offline payment is retried
        // after a server reset. Keep the cash event uploadable; it remains
        // visible in the ledger and can be linked later by reconciliation.
        const debtCycleId = debtCycleExists.rows.length ? requestedDebtCycleId : null;
        const sessionId = sessionExists.rows.length ? requestedSessionId : null;
        // Append-only ledger insert
        await client.query(
          `INSERT INTO payments 
           (id, operation_id, center_id, student_id, debt_cycle_id, session_id, subscription_id, amount, payment_method, is_reversed, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW(), $10)
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
            adj.adjustment_type || adj.adjustmentType || "discount",
            parseFloat(adj.amount),
            adj.reason || "تسوية/خصم معتمد",
            userId,
          ],
        );
        break;
      }

      case "session":
      case "session_created": {
        const sess = payload;
        const sessionId = sess.id || context.entityId;
        const existingSessionRes = await client.query(
          `SELECT group_id, session_date, start_time, end_time, status
           FROM sessions WHERE center_id = $1::varchar AND id = $2::varchar`,
          [centerId, sessionId],
        );
        const existingSession = existingSessionRes.rows[0];
        const groupId = sess.group_id || sess.groupId || existingSession?.group_id;
        const sessionDate = normalizeDateOnly(sess.session_date || sess.sessionDate || existingSession?.session_date);
        const startTime = sess.start_time || sess.startTime || existingSession?.start_time;
        const endTime = sess.end_time || sess.endTime || existingSession?.end_time;
        const action = String(sess.action || context.operationType || "").toLowerCase();
        const status = action === "close" ? "closed" : action === "reopen" ? "open" : (sess.status || existingSession?.status || "open");
        if (!sessionId || !groupId || !sessionDate || !startTime || !endTime) {
          throw new Error("Session requires group, date, start time, and end time.");
        }
        await client.query(
          `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at, updated_at)
           VALUES ($1::varchar, $2::varchar, $3::varchar, $4::date, $5::varchar, $6::varchar, $7::varchar, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            sessionId,
            centerId,
            groupId,
            sessionDate,
            startTime,
            endTime,
            status,
          ],
        );
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
            `SELECT id, student_id FROM student_cards
             WHERE center_id = $1 AND card_code = $2`,
            [centerId, cardCode],
          );
          if (existingByCode.rows.length > 0) {
            // Student creation already persists this card. A follow-up
            // student_card operation for the same student is duplicate
            // delivery and must be idempotent, not a conflict.
            if (existingByCode.rows[0].student_id !== studentId) {
              throw new AppError("CARD_ALREADY_ASSIGNED", "Card is already assigned.", "الكارت مرتبط بطالب بالفعل ولا يمكن نقله.", 409);
            }
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
        await client.query(
          `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             teacher_id = EXCLUDED.teacher_id,
             subject_id = EXCLUDED.subject_id,
             grade = EXCLUDED.grade,
             default_fee = EXCLUDED.default_fee,
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            groupId,
            centerId,
            grp.name || "مجموعة دراسية",
            grp.teacher_id || grp.teacherId,
            grp.subject_id || grp.subjectId,
            grp.grade || "الصف الثالث الثانوي",
            parseFloat(
              grp.default_fee ||
                grp.defaultFee ||
                grp.session_price ||
                grp.sessionPrice ||
                0,
            ),
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
            sched.group_id || sched.groupId || existing.rows[0]?.group_id,
            parseInt(sched.day_of_week ?? sched.dayOfWeek ?? existing.rows[0]?.day_of_week, 10),
            sched.start_time || sched.startTime || existing.rows[0]?.start_time,
            sched.end_time || sched.endTime || existing.rows[0]?.end_time,
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
          await client.query("DELETE FROM package_subjects WHERE center_id = $1 AND package_id = $2 AND subject_id = $3", [centerId, link.package_id || link.packageId, link.subject_id || link.subjectId]);
        } else {
          await client.query(
            `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, created_at)
             VALUES ($1,$2,$3,$4,$5,NOW())
             ON CONFLICT (center_id, package_id, subject_id) DO UPDATE SET default_teacher_id=EXCLUDED.default_teacher_id`,
            [link.id || context.entityId || `pkg-sub-${centerId}-${link.package_id || link.packageId}-${link.subject_id || link.subjectId}`, centerId, link.package_id || link.packageId, link.subject_id || link.subjectId, link.default_teacher_id || link.defaultTeacherId || link.teacher_id || link.teacherId],
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
          await client.query(`INSERT INTO package_subject_teacher_overrides (id, center_id, subscription_id, subject_id, teacher_id, created_at)
             VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (center_id, subscription_id, subject_id) DO UPDATE SET teacher_id=EXCLUDED.teacher_id`,
            [override.id || context.entityId || `pkg-override-${centerId}-${override.subscription_id || override.subscriptionId}-${override.subject_id || override.subjectId}`, centerId, override.subscription_id || override.subscriptionId, override.subject_id || override.subjectId, override.teacher_id || override.teacherId]);
        }
        break;
      }

      case "debt_cycle": {
        const cycle = payload.debtCycle || payload;
        const id = cycle.id || cycle.debtCycleId || context.entityId;
        const statusMap = { open: "pending", ended: "paid", cancelled: "cancelled" };
        const studentId = cycle.student_id || cycle.studentId;
        const requestedEnrollmentId = cycle.enrollment_id || cycle.enrollmentId || null;
        const cycleNumber = Math.max(1, Number(cycle.cycle_number ?? cycle.cycleNumber ?? 1));
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
        // A retry can arrive with a new id for the same natural cycle. Reuse
        // the already stored id so the composite unique key is idempotent.
        let targetId = id;
        if (enrollmentId) {
          const existingNatural = await client.query(
            `SELECT id FROM debt_cycles
             WHERE center_id = $1 AND enrollment_id = $2 AND cycle_number = $3`,
            [centerId, enrollmentId, cycleNumber],
          );
          targetId = existingNatural.rows[0]?.id || id;
        }
        await client.query(`INSERT INTO debt_cycles
          (id, center_id, student_id, enrollment_id, package_subscription_id, cycle_type, period_start, period_end, amount_due, status, notes, cycle_number, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
          ON CONFLICT (id) DO UPDATE SET student_id=EXCLUDED.student_id, enrollment_id=EXCLUDED.enrollment_id,
            package_subscription_id=EXCLUDED.package_subscription_id, cycle_type=EXCLUDED.cycle_type,
            period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, amount_due=EXCLUDED.amount_due,
            status=EXCLUDED.status, notes=EXCLUDED.notes, cycle_number=EXCLUDED.cycle_number, updated_at=NOW()`,
          [targetId, centerId, studentId, enrollmentId, cycle.package_subscription_id || cycle.packageSubscriptionId || null, cycle.cycle_type || cycle.cycleType || "monthly", cycle.start_date || cycle.startDate || cycle.period_start, cycle.end_date || cycle.endDate || cycle.period_end, Number(cycle.cycle_price ?? cycle.cyclePrice ?? cycle.amount_due ?? cycle.amountDue ?? 0), statusMap[cycle.status] || cycle.status || "pending", cycle.notes || null, cycleNumber]);
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
        await client.query(`INSERT INTO grade_exams (id, center_id, name, grade, max_score, status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()),NOW())
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, grade=EXCLUDED.grade, max_score=EXCLUDED.max_score, status=EXCLUDED.status, updated_at=NOW()`,
          [id, centerId, exam.name, exam.grade, Number(exam.max_score ?? exam.maxScore ?? 100), exam.status || "active", exam.created_at || exam.createdAt || null]);
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
           ON CONFLICT (id) DO UPDATE SET
             event_type=EXCLUDED.event_type, channel=EXCLUDED.channel,
             template_body=EXCLUDED.template_body, is_default=EXCLUDED.is_default,
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
        await client.query(`INSERT INTO notification_deliveries
          (id, center_id, notification_event_id, provider, status, retry_count, response_payload, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, status=EXCLUDED.status,
            retry_count=EXCLUDED.retry_count, response_payload=EXCLUDED.response_payload`,
          [id, centerId, delivery.notification_event_id || delivery.notificationEventId, delivery.provider || delivery.channel || "push", delivery.status === "pending" ? "queued" : (delivery.status || "queued"), Number(delivery.retry_count || 0), JSON.stringify(delivery.response_payload || delivery.responsePayload || {})]);
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
