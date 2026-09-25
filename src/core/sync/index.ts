import { env } from "../../config/env";
import { SyncOperation, SyncOperationStatus } from "../../shared/types";
import {
  HttpSyncApiAdapter,
  ISyncApiAdapter,
  MockSyncApiAdapter,
  BootstrapResponse,
} from "../api/SyncApiAdapter";
import { SyncOperationPayload } from "../api/contracts";
import { ConnectivityService } from "../connectivity";
import { DatabaseService } from "../database";
import { DeviceRepository, DeviceService } from "../device";
import { DatabaseError } from "../errors";
import { Logger } from "../logger";

export type SyncEngineState = "online" | "offline" | "syncing" | "error";

export const ARABIC_SYNC_STATES: Record<SyncEngineState, string> = {
  online: "متصل",
  offline: "غير متصل",
  syncing: "تتم المزامنة",
  error: "فشل المزامنة",
};

export const ARABIC_OPERATION_STATES: Record<
  SyncOperationStatus | "local_saved",
  string
> = {
  local_saved: "تم الحفظ على الجهاز",
  pending: "في انتظار المزامنة",
  syncing: "تتم المزامنة",
  synced: "تمت المزامنة",
  failed: "فشل الإرسال",
  conflict: "يوجد تعارض",
};

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Returns integer priority for syncing (1 = highest, 6 = lowest).
 * 1. Authentication / device state
 * 2. Attendance & makeup
 * 3. Payments & reversals
 * 4. Closings (session & daily)
 * 5. Other CRUD mutations (students, groups, enrollments, packages)
 * 6. Cache / reports / templates
 */
export function getOperationPriority(entityType: string): number {
  const e = (entityType || "").toLowerCase();
  if (e === "user" || e === "device" || e === "auth") return 1;
  // A session must reach the server before attendance/makeup rows that
  // reference it. Starting a session locally immediately enables scanning,
  // so leaving this as the fallback priority (6) makes the attendance batch
  // arrive first and get rejected by the session foreign key.
  if (e === "session" || e === "session_created") return 1;
  if (e === "attendance" || e === "advance_coverage" || e === "makeup")
    return 2;
  if (e === "payment" || e === "payment_reversal" || e === "debt_adjustment")
    return 3;
  if (e === "session_closing" || e === "daily_closing") return 4;
  // CRUD mutations remain priority 5 for callers that consume the public
  // category value. The queue sorter below adds dependency-aware ordering
  // without changing this backwards-compatible contract.
  if (e === "teacher" || e === "subject" || e === "teacher_subject" ||
      e === "group" || e === "group_schedule" || e === "student" ||
      e === "student_card" || e === "package" || e === "package_subject" ||
      e === "enrollment" || e === "student_group_enrollment" ||
      e === "package_subscription" || e === "package_teacher_override" ||
      e === "debt_cycle") return 5;
  return 6;
}

const REPAIR_DEPENDENCY_PRIORITY: Record<string, number> = {
  teacher: 10,
  subject: 10,
  teacher_subject: 20,
  group: 30,
  group_schedule: 35,
  student: 40,
  student_card: 45,
  package: 50,
  package_subject: 55,
  enrollment: 60,
  student_group_enrollment: 60,
  package_subscription: 65,
  package_teacher_override: 70,
};

function canonicalEntityType(entityType: string): string {
  const normalized = String(entityType || "").toLowerCase().replace(/_created$|_updated$/, "");
  return normalized === "student_group_enrollment" ? "enrollment" : normalized;
}

function parseOperationPayload(payload: unknown): any {
  if (!payload) return {};
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload || "{}");
  } catch {
    return {};
  }
}

function firstValue(source: any, ...keys: string[]): any {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== "") {
      return source[key];
    }
  }
  return undefined;
}

function normalizeAdjustmentAmount(adjustment: any): number {
  const raw = Number(adjustment?.adjustment_amount ?? adjustment?.adjustmentAmount ?? adjustment?.amount ?? 0);
  if (adjustment?.adjustment_amount !== undefined || adjustment?.adjustmentAmount !== undefined) return raw;
  const type = String(adjustment?.adjustment_type || adjustment?.adjustmentType || "").toLowerCase();
  return ["discount", "waiver"].includes(type) ? -Math.abs(raw) : raw;
}

/**
 * SQLite has a natural unique key for debt cycles in addition to the primary
 * id. A server bootstrap can legitimately contain the same cycle under a
 * different id after a reset, so an id-only UPSERT is not sufficient.
 */
function upsertLocalDebtCycle(db: any, cycle: any, centerId: string): void {
  const id = cycle.id || cycle.debtCycleId;
  if (!id) return;
  const cycleCenterId = cycle.center_id || cycle.centerId || centerId;
  const studentId = cycle.student_id || cycle.studentId || "";
  const enrollmentId = cycle.enrollment_id || cycle.enrollmentId || "";
  const groupId = cycle.group_id || cycle.groupId || "";
  const cycleNumber = Number(cycle.cycle_number || cycle.cycleNumber || 1);
  const startDate = cycle.start_date || cycle.period_start || cycle.startDate || new Date().toISOString().slice(0, 10);
  const endDate = cycle.end_date || cycle.period_end || cycle.endDate || startDate;
  const cyclePrice = Number(cycle.cycle_price ?? cycle.amount_due ?? cycle.amountDue ?? cycle.cyclePrice ?? 0);
  const status = cycle.status === "pending" ? "open" : (cycle.status || "open");
  const createdAt = cycle.created_at || cycle.createdAt || new Date().toISOString();
  const updatedAt = cycle.updated_at || cycle.updatedAt || createdAt;
  const packageSubscriptionId = cycle.package_subscription_id || cycle.packageSubscriptionId || null;
  // PostgreSQL accepts only monthly, per_session, or package. Legacy local
  // rows used "group"; treat those as monthly when repairing/bootstraping.
  const rawCycleType = String(cycle.cycle_type || cycle.cycleType || "monthly")
    .trim()
    .toLowerCase()
    .replace(/[\s-]/g, "_");
  const cycleType = cycle.package_subscription_id || cycle.packageSubscriptionId || rawCycleType === "package"
    ? "package"
    : ["session", "per_session", "persession", "per_class", "perclass"].includes(rawCycleType)
      ? "per_session"
      : "monthly";

  const natural = enrollmentId
    ? db.getFirstSync(
        `SELECT id FROM debt_cycles
         WHERE center_id = ? AND enrollment_id = ? AND cycle_number = ?`,
        [cycleCenterId, enrollmentId, cycleNumber],
      )
    : null;
  const targetId = natural?.id || id;
  db.runSync(
    `INSERT INTO debt_cycles
       (id, center_id, student_id, enrollment_id, group_id, cycle_number,
        start_date, end_date, cycle_price, status, created_at, updated_at,
        package_subscription_id, cycle_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       student_id = excluded.student_id,
       enrollment_id = excluded.enrollment_id,
       group_id = excluded.group_id,
       cycle_number = excluded.cycle_number,
       start_date = excluded.start_date,
       end_date = excluded.end_date,
       cycle_price = excluded.cycle_price,
       status = excluded.status,
       updated_at = excluded.updated_at,
       package_subscription_id = excluded.package_subscription_id,
       cycle_type = excluded.cycle_type`,
    [targetId, cycleCenterId, studentId, enrollmentId, groupId, cycleNumber,
      startDate, endDate, cyclePrice, status, createdAt, updatedAt,
      packageSubscriptionId, cycleType],
  );
}

/**
 * Sorts the outbox by its normal business priority while also honoring
 * foreign-key dependencies present in the same batch. This keeps the legacy
 * public priority values intact, but prevents payment/debt-cycle and
 * attendance/session operations from racing their parent records.
 */
function orderOperationsByDependencies(rows: SyncOperation[]): SyncOperation[] {
  const baseSorted = [...rows].sort((a, b) => {
    const repairA = a.operationType === "REPAIR_AFTER_SERVER_RESET";
    const repairB = b.operationType === "REPAIR_AFTER_SERVER_RESET";
    if (repairA !== repairB) return repairA ? -1 : 1;
    if (repairA && repairB) {
      const pA = REPAIR_DEPENDENCY_PRIORITY[canonicalEntityType(a.entityType)] ?? 90;
      const pB = REPAIR_DEPENDENCY_PRIORITY[canonicalEntityType(b.entityType)] ?? 90;
      if (pA !== pB) return pA - pB;
    } else {
      const pA = getOperationPriority(a.entityType);
      const pB = getOperationPriority(b.entityType);
      if (pA !== pB) return pA - pB;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  const byKey = new Map<string, SyncOperation>();
  for (const operation of baseSorted) {
    const key = `${canonicalEntityType(operation.entityType)}:${operation.entityId}`;
    if (!byKey.has(key) || operation.operationType === "REPAIR_AFTER_SERVER_RESET") {
      byKey.set(key, operation);
    }
  }

  const dependencies = (operation: SyncOperation): string[] => {
    const payload = parseOperationPayload(operation.payload);
    const entity = canonicalEntityType(operation.entityType);
    const value = (...keys: string[]) => firstValue(payload, ...keys);
    const refs: Array<[string, any]> = [];
    if (entity === "session") refs.push(["group", value("groupId", "group_id")]);
    if (entity === "attendance" || entity === "makeup") {
      refs.push(["session", value("sessionId", "session_id")]);
      refs.push(["student", value("studentId", "student_id")]);
    }
    if (entity === "payment" || entity === "debt_adjustment") {
      refs.push(["debt_cycle", value("debtCycleId", "debt_cycle_id")]);
      refs.push(["session", value("sessionId", "session_id")]);
      refs.push(["student", value("studentId", "student_id")]);
    }
    if (entity === "debt_cycle") {
      refs.push(["enrollment", value("enrollmentId", "enrollment_id")]);
      refs.push(["student", value("studentId", "student_id")]);
      refs.push(["package_subscription", value("packageSubscriptionId", "package_subscription_id")]);
    }
    if (entity === "enrollment") {
      refs.push(["student", value("studentId", "student_id")]);
      refs.push(["group", value("groupId", "group_id")]);
    }
    if (entity === "student_card") refs.push(["student", value("studentId", "student_id")]);
    if (entity === "package_subject") refs.push(["package", value("packageId", "package_id")]);
    if (entity === "package_subscription") {
      refs.push(["student", value("studentId", "student_id")]);
      refs.push(["package", value("packageId", "package_id")]);
    }
    if (entity === "package_teacher_override") refs.push(["package_subscription", value("subscriptionId", "subscription_id")]);
    return refs.filter(([, id]) => id !== undefined).map(([type, id]) => `${type}:${id}`);
  };

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: SyncOperation[] = [];
  const visit = (operation: SyncOperation) => {
    const operationKey = operation.operationId;
    if (visited.has(operationKey) || visiting.has(operationKey)) return;
    visiting.add(operationKey);
    for (const dependencyKey of dependencies(operation)) {
      const dependency = byKey.get(dependencyKey);
      if (dependency) visit(dependency);
    }
    visiting.delete(operationKey);
    visited.add(operationKey);
    ordered.push(operation);
  };
  for (const operation of baseSorted) visit(operation);
  return ordered;
}

function retryDelayMs(retryCount: number): number {
  return Math.min(1000 * Math.pow(2, Math.max(0, retryCount)), 60000);
}

export class SyncRepository {
  static getByOperationId(operationId: string): SyncOperation | null {
    const db = DatabaseService.getDb();
    return db.getFirstSync<SyncOperation>(
      `SELECT id, operation_id as operationId, center_id as centerId, user_id as userId, device_id as deviceId,
              operation_type as operationType, entity_type as entityType, entity_id as entityId,
              payload, status, created_at as createdAt, synced_at as syncedAt, retry_count as retryCount,
              last_error as lastError
       FROM sync_operations
       WHERE operation_id = ?`,
      [operationId],
    );
  }

  /**
   * Enqueues an operation into the persistent queue.
   * Asserts device is active and preserves idempotency.
   */
  static enqueueOperation(params: {
    centerId: string;
    userId: string;
    deviceId: string;
    operationType: string;
    entityType: string;
    entityId: string;
    payload: any;
    operationId?: string;
  }): SyncOperation {
    // 1. Device status enforcement: Inactive device cannot create new mutations
    DeviceRepository.assertDeviceActive(params.centerId);

    const db = DatabaseService.getDb();
    const operationId = params.operationId || `op-${generateUUID()}`;

    // 2. Idempotency check: if operation already exists, return it without duplicate insertion
    if (params.operationId) {
      const existing = this.getByOperationId(params.operationId);
      if (existing) {
        return existing;
      }
    }

    const id = `sync-${generateUUID()}`;
    const payloadStr =
      typeof params.payload === "string"
        ? params.payload
        : JSON.stringify(params.payload);
    const createdAt = new Date().toISOString();

    try {
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, retry_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          operationId,
          params.centerId,
          params.userId,
          params.deviceId,
          params.operationType,
          params.entityType,
          params.entityId,
          payloadStr,
          "pending",
          createdAt,
          0,
        ],
      );

      return {
        id,
        operationId,
        centerId: params.centerId,
        userId: params.userId,
        deviceId: params.deviceId,
        operationType: params.operationType,
        entityType: params.entityType,
        entityId: params.entityId,
        payload: payloadStr,
        status: "pending",
        createdAt,
        retryCount: 0,
      };
    } catch (e: any) {
      if (e?.message?.includes("UNIQUE") && params.operationId) {
        const existing = this.getByOperationId(params.operationId);
        if (existing) return existing;
      }
      throw new DatabaseError(
        `فشل إدراج العملية في طابور المزامنة: ${e?.message}`,
      );
    }
  }

  /**
   * Retrieves pending operations sorted by business priority, then created_at.
   */
  static getPendingOperations(
    centerId: string,
    limit?: number,
  ): SyncOperation[] {
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<SyncOperation>(
      `SELECT id, operation_id as operationId, center_id as centerId, user_id as userId, device_id as deviceId,
              operation_type as operationType, entity_type as entityType, entity_id as entityId,
              payload, status, created_at as createdAt, synced_at as syncedAt, retry_count as retryCount,
              last_error as lastError
       FROM sync_operations
       WHERE center_id = ? AND (
         status = 'pending' OR
         (status = 'failed' AND retry_count < 10 AND
          (next_retry_at IS NULL OR next_retry_at <= ?))
       )`,
      [centerId, new Date().toISOString()],
    );

    // Sort by business priority and then move any same-batch parent operation
    // ahead of a child that references it through a foreign key.
    const ordered = orderOperationsByDependencies(rows);

    if (limit && limit > 0) {
      return ordered.slice(0, limit);
    }
    return ordered;
  }

  /**
   * Re-queue conflicts caused by server-side validation/configuration fixes.
   * Older clients used to permanently park these operations as `conflict`,
   * so simply deploying the corrected server would never resend them.
   */
  static requeueRecoverableConflicts(centerId: string): number {
    const db = DatabaseService.getDb();
    // A stale update means the server intentionally won the optimistic
    // concurrency check. It must not remain as an endless retry/conflict on
    // the device; the authoritative server row is already the resolution.
    const staleResolvedAt = new Date().toISOString();
    db.runSync(
      `UPDATE sync_operations
       SET status = 'synced', synced_at = ?, next_retry_at = NULL,
           last_error = 'Superseded by server newer version'
       WHERE center_id = ? AND status = 'conflict'
         AND last_error LIKE '%STALE_UPDATE%'`,
      [staleResolvedAt, centerId],
    );
    db.runSync(
      `UPDATE sync_conflicts
       SET resolved_at = COALESCE(resolved_at, ?)
       WHERE center_id = ? AND resolved_at IS NULL
         AND reason LIKE '%STALE_UPDATE%'`,
      [staleResolvedAt, centerId],
    );
    // Rewrite legacy attendance payloads before retrying them. Older builds
    // queued `status: late`, while PostgreSQL stores lateness in is_late and
    // only accepts present/absent/excused/attended_elsewhere.
    const legacyAttendance = db.getAllSync<{ operationId: string; payload: any }>(
      `SELECT operation_id as operationId, payload
       FROM sync_operations
       WHERE center_id = ? AND status = 'conflict' AND entity_type = 'attendance'
         AND last_error LIKE '%attendance_status_check%'`,
      [centerId],
    );
    for (const row of legacyAttendance) {
      try {
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        if (payload && String(payload.status).toLowerCase() === "late") {
          payload.status = "present";
          payload.isLate = true;
          payload.is_late = true;
          db.runSync(
            `UPDATE sync_operations
             SET payload = ?, status = 'pending', retry_count = 0,
                 next_retry_at = NULL, last_error = NULL
             WHERE operation_id = ?`,
            [JSON.stringify(payload), row.operationId],
          );
          db.runSync(
            `UPDATE sync_conflicts
             SET resolved_at = COALESCE(resolved_at, ?)
             WHERE center_id = ? AND operation_id = ? AND resolved_at IS NULL`,
            [new Date().toISOString(), centerId, row.operationId],
          );
        }
      } catch {
        // Leave malformed history visible in Sync Debug for manual review.
      }
    }
    // A grade-book operation can have been parked by an older backend that
    // did not know the entity yet. Keep it retryable after the backend deploys
    // instead of letting a stale retry counter permanently block it.
    db.runSync(
      `UPDATE sync_operations
       SET status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL
       WHERE center_id = ? AND status = 'conflict'
         AND entity_type IN ('grade_exam', 'grade_score')
         AND last_error LIKE '%Unsupported sync entity type%'`,
      [centerId],
    );
    // Older server-reset repairs used an entity id + timestamp as the
    // operation id and exceeded PostgreSQL's VARCHAR(64) limit. Rename those
    // local-only, never-applied operations before retrying them. The conflict
    // row is updated too so the UI/history keeps pointing at the same retry.
    const longIds = db.getAllSync<{ operationId: string }>(
      `SELECT operation_id as operationId FROM sync_operations
       WHERE center_id = ? AND status = 'conflict' AND retry_count < 10
         AND LENGTH(operation_id) > 64
         AND entity_type IN ('student', 'student_card', 'teacher', 'subject', 'group', 'group_schedule', 'session', 'enrollment', 'student_group_enrollment', 'attendance', 'payment', 'payment_reversal', 'debt_adjustment', 'debt_cycle', 'package', 'package_subject', 'package_subscription', 'package_teacher_override', 'notification_template')`,
      [centerId],
    );
    for (const row of longIds) {
      const replacement = `r-${generateUUID()}`;
      db.runSync(
        `UPDATE sync_conflicts SET operation_id = ? WHERE operation_id = ?`,
        [replacement, row.operationId],
      );
      db.runSync(
        `UPDATE sync_operations SET operation_id = ? WHERE operation_id = ?`,
        [replacement, row.operationId],
      );
    }
    const result = db.runSync(
      `UPDATE sync_operations
       SET status = 'pending', retry_count = retry_count + 1, next_retry_at = NULL, last_error = NULL
       WHERE center_id = ?
         AND status = 'conflict'
         AND retry_count < 10
         AND entity_type IN ('student', 'student_card', 'package', 'package_subject', 'package_subscription', 'package_teacher_override', 'notification_template', 'session', 'attendance', 'makeup', 'debt_cycle', 'payment', 'debt_adjustment', 'grade_exam', 'grade_score')
         AND (
           last_error LIKE '%CARD_OUTSIDE_ALLOWED_RANGE%'
           OR last_error LIKE '%CARD_ALREADY_ASSIGNED%'
           OR last_error LIKE '%student_type%'
           OR last_error LIKE '%packages_%'
           OR last_error LIKE '%max_selections%'
           OR last_error LIKE '%total_price%'
           OR last_error LIKE '%billing_cycle%'
           OR last_error LIKE '%column%does not exist%'
           OR last_error LIKE '%STALE_UPDATE%'
           OR last_error LIKE '%value too long%'
           OR last_error LIKE '%outside the authenticated center%'
           OR last_error LIKE '%CARD_BELONGS_TO_OTHER_CENTER%'
           OR last_error LIKE '%uq_center_card_code%'
           OR last_error LIKE '%package%constraint%'
           OR last_error LIKE '%grade_%'
           OR last_error LIKE '%Unknown entity%'
           OR last_error LIKE '%Unsupported sync entity type%'
           OR last_error LIKE '%violates foreign key%'
           OR last_error LIKE '%inconsistent types deduced%'
           OR last_error LIKE '%invalid input syntax for type timestamp%'
           OR last_error LIKE '%debt_cycles_%'
           OR last_error LIKE '%payments_debt_cycle_id_fkey%'
           OR last_error LIKE '%uq_notification_template%'
           OR last_error LIKE '%notification_templates%'
           OR last_error LIKE '%violates check constraint%'
           OR (
             entity_type IN ('attendance', 'makeup')
             AND (last_error LIKE '%session%' OR last_error LIKE '%foreign key%')
           )
         )`,
      [centerId],
    );
    return Number(result?.changes || 0);
  }

  /**
   * Rebuilds the server after a reset without losing records that were
   * previously marked synced on this device. Only entities absent from the
   * authoritative bootstrap snapshot are requeued; server-present rows are
   * left untouched.
   */
  static requeueEntitiesMissingFromServer(centerId: string, snapshot: any): number {
    const db = DatabaseService.getDb();
    const idsByType: Record<string, Set<string>> = {
      student: new Set((snapshot.students || []).map((row: any) => String(row.id))),
      student_card: new Set((snapshot.cards || []).map((row: any) => String(row.id))),
      package: new Set((snapshot.packages || []).map((row: any) => String(row.id))),
      package_subject: new Set((snapshot.packageSubjects || []).map((row: any) => String(row.id))),
      package_subscription: new Set((snapshot.packageSubscriptions || []).map((row: any) => String(row.id))),
      package_teacher_override: new Set((snapshot.packageTeacherOverrides || []).map((row: any) => String(row.id))),
    };
    const rows = db.getAllSync<{ operationId: string; entityType: string; entityId: string }>(
      `SELECT operation_id as operationId, entity_type as entityType, entity_id as entityId
       FROM sync_operations
       WHERE center_id = ? AND status IN ('synced', 'conflict')
         AND entity_type IN ('student', 'student_card', 'package', 'package_subject', 'package_subscription', 'package_teacher_override')`,
      [centerId],
    );
    let repaired = 0;
    for (const row of rows) {
      const serverIds = idsByType[row.entityType];
      if (!serverIds || serverIds.has(String(row.entityId))) continue;
      db.runSync(
        `UPDATE sync_operations
         SET status = 'pending', retry_count = 0, next_retry_at = NULL, last_error = NULL
         WHERE operation_id = ?`,
        [row.operationId],
      );
      repaired += 1;
    }
    return repaired;
  }

  static getStats(centerId: string) {
    const db = DatabaseService.getDb();
    this.cleanupSupersededConflicts(centerId);
    const rows = db.getAllSync<{ status: SyncOperationStatus; retryCount: number }>(
      "SELECT status, retry_count as retryCount FROM sync_operations WHERE center_id = ?",
      [centerId],
    );

    let pending = 0;
    let syncing = 0;
    let synced = 0;
    let failed = 0;
    let conflict = 0;

    for (const r of rows) {
      if (r.status === "pending") pending++;
      else if (r.status === "syncing") syncing++;
      else if (r.status === "synced") synced++;
      else if (r.status === "failed") {
        // A transient/network failure remains eligible for automatic retry;
        // surface it as pending instead of poisoning the whole sync status
        // forever because an old SQLite row is still retained.
        if (Number(r.retryCount || 0) < 10) pending++;
        else failed++;
      }
      else if (r.status === "conflict") conflict++;
    }

    return { pending, syncing, synced, failed, conflict, total: rows.length };
  }

  /** Recent local outbox activity for the sync diagnostics screen. */
  static getRecentOperations(centerId: string, limit = 100): SyncOperation[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return DatabaseService.getDb().getAllSync<SyncOperation>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              user_id as userId, device_id as deviceId,
              operation_type as operationType, entity_type as entityType,
              entity_id as entityId, payload, status,
              created_at as createdAt, synced_at as syncedAt,
              retry_count as retryCount, last_error as lastError
       FROM sync_operations
       WHERE center_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [centerId, safeLimit],
    );
  }

  /** Operations that still need server acknowledgement. */
  static getUnsyncedOperations(centerId: string, limit = 200): SyncOperation[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return DatabaseService.getDb().getAllSync<SyncOperation>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              user_id as userId, device_id as deviceId,
              operation_type as operationType, entity_type as entityType,
              entity_id as entityId, payload, status,
              created_at as createdAt, synced_at as syncedAt,
              retry_count as retryCount, last_error as lastError
       FROM sync_operations
       WHERE center_id = ? AND status IN ('pending', 'syncing', 'failed', 'conflict')
       ORDER BY created_at ASC
       LIMIT ?`,
      [centerId, safeLimit],
    );
  }

  /**
   * Clear historical conflict markers once a newer operation for the same
   * entity has already synced successfully. This also repairs devices that
   * completed the package upload before the conflict-cleanup code shipped.
   */
  private static cleanupSupersededConflicts(centerId: string): void {
    const db = DatabaseService.getDb();
    const successful = db.getAllSync<{
      entityType: string;
      entityId: string;
      createdAt: string;
    }>(
      `SELECT entity_type as entityType, entity_id as entityId,
              created_at as createdAt
       FROM sync_operations
       WHERE center_id = ? AND status = 'synced'`,
      [centerId],
    );
    for (const winner of successful) {
      db.runSync(
        `UPDATE sync_operations
         SET status = 'synced', synced_at = COALESCE(synced_at, ?),
             next_retry_at = NULL,
             last_error = 'Superseded by a successful sync operation'
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND created_at <= ? AND status IN ('failed', 'conflict')`,
        [
          winner.createdAt,
          centerId,
          winner.entityType,
          winner.entityId,
          winner.createdAt,
        ],
      );
      db.runSync(
        `UPDATE sync_conflicts
         SET resolved_at = COALESCE(resolved_at, ?)
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND created_at <= ? AND resolved_at IS NULL`,
        [
          winner.createdAt,
          centerId,
          winner.entityType,
          winner.entityId,
          winner.createdAt,
        ],
      );
    }
  }

  static markAsSyncing(operationId: string): void {
    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE sync_operations SET status = 'syncing' WHERE operation_id = ?`,
      [operationId],
    );
  }

  static markAsSynced(operationId: string): void {
    const db = DatabaseService.getDb();
    const syncedAt = new Date().toISOString();
    const operation = db.getFirstSync<{
      centerId: string;
      entityType: string;
      entityId: string;
      createdAt: string;
    }>(
      `SELECT center_id as centerId, entity_type as entityType,
              entity_id as entityId, created_at as createdAt
       FROM sync_operations WHERE operation_id = ?`,
      [operationId],
    );
    db.runSync(
      `UPDATE sync_operations SET status = 'synced', synced_at = ?, next_retry_at = NULL WHERE operation_id = ?`,
      [syncedAt, operationId],
    );

    // A successful repair is authoritative for the entity. Retire older
    // failed/conflicted attempts for the same record so historical retries do
    // not keep the dashboard stuck on "sync problem" forever.
    if (operation) {
      db.runSync(
        `UPDATE sync_operations
         SET status = 'synced', synced_at = ?, next_retry_at = NULL,
             last_error = 'Superseded by a successful sync operation'
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND operation_id <> ? AND created_at <= ?
           AND status IN ('pending', 'syncing', 'failed', 'conflict')`,
        [
          syncedAt,
          operation.centerId,
          operation.entityType,
          operation.entityId,
          operationId,
          operation.createdAt,
        ],
      );
      db.runSync(
        `UPDATE sync_conflicts
         SET resolved_at = ?
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND created_at <= ? AND resolved_at IS NULL`,
        [
          syncedAt,
          operation.centerId,
          operation.entityType,
          operation.entityId,
          operation.createdAt,
        ],
      );
    }
  }

  static markAsFailed(operationId: string, errorReason: string): void {
    const db = DatabaseService.getDb();
    const current = db.getFirstSync<{ retryCount: number }>(
      `SELECT retry_count as retryCount FROM sync_operations WHERE operation_id = ?`,
      [operationId],
    );
    const retryCount = Number(current?.retryCount || 0);
    const nextRetryAt = new Date(Date.now() + retryDelayMs(retryCount)).toISOString();
    db.runSync(
      `UPDATE sync_operations
       SET status = 'failed', retry_count = retry_count + 1, last_error = ?, next_retry_at = ?
       WHERE operation_id = ?`,
      [errorReason, nextRetryAt, operationId],
    );
  }

  static markAsConflict(
    operationId: string,
    errorReason: string,
    details?: { serverState?: any; resolution?: string },
  ): void {
    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE sync_operations SET status = 'conflict', last_error = ?, next_retry_at = NULL WHERE operation_id = ?`,
      [errorReason, operationId],
    );
    const operation = db.getFirstSync<any>(
      `SELECT center_id as centerId, entity_type as entityType, entity_id as entityId, payload
       FROM sync_operations WHERE operation_id = ?`,
      [operationId],
    );
    if (!operation) return;
    db.runSync(
      `INSERT INTO sync_conflicts
         (id, operation_id, center_id, entity_type, entity_id, reason, local_payload, server_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         reason = excluded.reason,
         server_payload = excluded.server_payload,
         created_at = excluded.created_at`,
      [
        `conflict-${generateUUID()}`,
        operationId,
        operation.centerId,
        operation.entityType,
        operation.entityId,
        errorReason,
        operation.payload || null,
        details?.serverState === undefined ? null : JSON.stringify(details.serverState),
        new Date().toISOString(),
      ],
    );
  }

  static getConflicts(centerId: string): any[] {
    return DatabaseService.getDb().getAllSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              entity_type as entityType, entity_id as entityId, reason,
              local_payload as localPayload, server_payload as serverPayload,
              created_at as createdAt, resolved_at as resolvedAt
       FROM sync_conflicts WHERE center_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC`,
      [centerId],
    );
  }

  static resolveConflict(operationId: string): void {
    DatabaseService.getDb().runSync(
      `UPDATE sync_conflicts SET resolved_at = ? WHERE operation_id = ?`,
      [new Date().toISOString(), operationId],
    );
  }

  /**
   * A process can be terminated after marking an operation as syncing but
   * before the server response is persisted. Such rows must be retryable on
   * the next launch; otherwise one crash permanently strands the mutation.
   */
  static recoverInterruptedOperations(centerId: string): number {
    const db = DatabaseService.getDb();
    const result = db.runSync(
      `UPDATE sync_operations
       SET status = 'pending', next_retry_at = NULL,
           last_error = COALESCE(last_error, 'sync interrupted')
       WHERE center_id = ? AND status = 'syncing'`,
      [centerId],
    );
    return result.changes ?? 0;
  }

  /**
   * Monotonic Server Cursor Management:
   * Always uses monotonic sequence tokens (never client timestamps!).
   */
  static getServerCursor(centerId: string): string {
    const db = DatabaseService.getDb();
    const row = db.getFirstSync<{ serverCursor: string }>(
      `SELECT server_cursor as serverCursor FROM sync_cursors WHERE center_id = ?`,
      [centerId],
    );
    return row?.serverCursor || "0";
  }

  static setServerCursor(centerId: string, cursor: string): void {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const existing = db.getFirstSync<any>(
      `SELECT center_id FROM sync_cursors WHERE center_id = ?`,
      [centerId],
    );

    if (existing) {
      db.runSync(
        `UPDATE sync_cursors SET server_cursor = ?, updated_at = ? WHERE center_id = ?`,
        [cursor, now, centerId],
      );
    } else {
      db.runSync(
        `INSERT INTO sync_cursors (center_id, server_cursor, updated_at) VALUES (?, ?, ?)`,
        [centerId, cursor, now],
      );
    }
  }

  static getResetGeneration(centerId: string): number {
    const db = DatabaseService.getDb();
    try {
      const row = db.getFirstSync<{ resetGeneration?: number; reset_generation?: number }>(
        `SELECT reset_generation as resetGeneration FROM sync_cursors WHERE center_id = ?`,
        [centerId],
      );
      return Number(row?.resetGeneration ?? row?.reset_generation ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  static setResetGeneration(centerId: string, generation: number): void {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const value = Math.max(0, Math.floor(Number(generation) || 0));
    const existing = db.getFirstSync<any>(
      `SELECT center_id FROM sync_cursors WHERE center_id = ?`,
      [centerId],
    );
    if (existing) {
      db.runSync(
        `UPDATE sync_cursors SET reset_generation = ?, updated_at = ? WHERE center_id = ?`,
        [value, now, centerId],
      );
    } else {
      db.runSync(
        `INSERT INTO sync_cursors (center_id, server_cursor, reset_generation, updated_at) VALUES (?, ?, ?, ?)`,
        [centerId, "0", value, now],
      );
    }
  }

  /** Clears center operational data after an authoritative server reset. */
  static resetLocalOperationalData(centerId: string): void {
    const db = DatabaseService.getDb();
    const tables = [
      "session_closing_records", "daily_closing_summaries",
      "notification_deliveries", "notification_events", "notification_templates",
      "payment_reversals", "payments", "debt_adjustments", "advance_coverages",
      "attendance", "session_expected_students", "sessions", "debt_cycles",
      "package_subject_teacher_overrides", "student_package_subscriptions",
      "package_subjects", "packages", "student_group_enrollments", "student_cards",
      "students", "group_schedules", "groups", "teacher_subjects", "teachers",
      "subjects", "grade_scores", "grade_exams", "audit_logs", "sync_operations",
      "sync_conflicts",
    ];
    DatabaseService.runInTransaction(() => {
      for (const table of tables) {
        try { db.runSync(`DELETE FROM ${table} WHERE center_id = ?`, [centerId]); } catch {}
      }
      this.setServerCursor(centerId, "0");
    });
  }
}

export class SyncEngine {
  private static bootstrapCompletedCenters = new Set<string>();
  private static adapter: ISyncApiAdapter = env.enableMockData
    ? new MockSyncApiAdapter()
    : new HttpSyncApiAdapter();
  private static currentState: SyncEngineState = "online";
  /** One in-flight sync pipeline per center; callers queue behind it. */
  private static readonly syncLocks = new Map<string, Promise<void>>();
  /** SQLite is a single native connection; serialize pipelines across centers too. */
  private static databaseSyncLock: Promise<void> | null = null;

  static setAdapter(adapter: ISyncApiAdapter): void {
    this.adapter = adapter;
  }

  static getAdapter(): ISyncApiAdapter {
    return this.adapter;
  }

  static getState(): SyncEngineState {
    return this.currentState;
  }

  static getArabicState(): string {
    return ARABIC_SYNC_STATES[this.currentState] || "متصل";
  }

  static getBackoffDelayMs(retryCount: number): number {
    return Math.min(1000 * Math.pow(2, retryCount), 60000);
  }

  /**
   * A server reset can erase the remote sync ledger while this device still
   * marks its original creates as synced. Rebuild fresh outbox records from
   * the actual local tables so recovery does not depend on old outbox rows.
   */
  private static queueLocalRecordsMissingFromSnapshot(
    centerId: string,
    snapshot: BootstrapResponse,
  ): number {
    const db = DatabaseService.getDb();
    const existingRemoteIds = {
      teacher: new Set((snapshot.teachers || []).map((row: any) => String(row.id))),
      subject: new Set((snapshot.subjects || []).map((row: any) => String(row.id))),
      teacher_subject: new Set((snapshot.teacherSubjects || []).map((row: any) => String(row.id))),
      group: new Set((snapshot.groups || []).map((row: any) => String(row.id))),
      group_schedule: new Set((snapshot.schedules || []).map((row: any) => String(row.id))),
      student: new Set((snapshot.students || []).map((row: any) => String(row.id))),
      enrollment: new Set((snapshot.enrollments || []).map((row: any) => String(row.id))),
      debt_cycle: new Set((snapshot.debtCycles || []).map((row: any) => String(row.id))),
      package: new Set((snapshot.packages || []).map((row: any) => String(row.id))),
      package_subject: new Set((snapshot.packageSubjects || []).map((row: any) => String(row.id))),
      package_subscription: new Set((snapshot.packageSubscriptions || []).map((row: any) => String(row.id))),
      package_teacher_override: new Set((snapshot.packageTeacherOverrides || []).map((row: any) => String(row.id))),
    };
    const actor = db.getFirstSync<{ userId: string }>(
      `SELECT user_id as userId FROM sync_operations
       WHERE center_id = ? AND user_id <> 'repair'
       ORDER BY created_at DESC LIMIT 1`,
      [centerId],
    );
    const userId = actor?.userId || "repair";
    const deviceId = DeviceService.getDeviceIdSync();
    let sequence = 0;
    let queued = 0;

    const queue = (entityType: string, entityId: string, payload: any) => {
      if (existingRemoteIds[entityType as keyof typeof existingRemoteIds]?.has(entityId)) return;
      const waiting = db.getFirstSync<{ operationId: string }>(
        `SELECT operation_id as operationId FROM sync_operations
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND operation_type = 'REPAIR_AFTER_SERVER_RESET'
           AND status IN ('pending', 'syncing', 'failed')
         LIMIT 1`,
        [centerId, entityType, entityId],
      );
      if (waiting) return;
      const createdAt = new Date(Date.now() + sequence++).toISOString();
      // The fresh repair payload is authoritative. Retire stale queued or
      // conflicted operations for this entity so their old partial payloads
      // cannot keep the sync indicator in an error state after recovery.
      db.runSync(
        `UPDATE sync_operations
         SET status = 'synced', synced_at = ?, next_retry_at = NULL,
             last_error = 'Superseded by server-reset repair operation'
         WHERE center_id = ? AND entity_type = ? AND entity_id = ?
           AND operation_type <> 'REPAIR_AFTER_SERVER_RESET'
           AND status IN ('pending', 'syncing', 'failed', 'conflict')`,
        [createdAt, centerId, entityType, entityId],
      );
      SyncRepository.enqueueOperation({
        // server_sync_operations.operation_id is VARCHAR(64). Keep repair
        // ids compact even when entity ids are UUIDs.
        operationId: `r-${generateUUID()}`,
        centerId,
        userId,
        deviceId,
        operationType: "REPAIR_AFTER_SERVER_RESET",
        entityType,
        entityId,
        payload: { ...payload, updatedAt: payload.updatedAt || createdAt },
      });
      queued += 1;
    };

    const teachers = db.getAllSync<any>(
      `SELECT id, name, phone, status, notes, created_at as createdAt, updated_at as updatedAt
       FROM teachers WHERE center_id = ?`,
      [centerId],
    );
    for (const teacher of teachers) queue("teacher", teacher.id, teacher);

    const subjects = db.getAllSync<any>(
      `SELECT id, name, code, status, created_at as createdAt, updated_at as updatedAt
       FROM subjects WHERE center_id = ?`,
      [centerId],
    );
    for (const subject of subjects) queue("subject", subject.id, subject);

    const teacherSubjects = db.getAllSync<any>(
      `SELECT id, teacher_id as teacherId, subject_id as subjectId, created_at as createdAt
       FROM teacher_subjects WHERE center_id = ?`,
      [centerId],
    );
    for (const link of teacherSubjects) queue("teacher_subject", link.id, link);

    const groups = db.getAllSync<any>(
      `SELECT id, name, teacher_id as teacherId, subject_id as subjectId, grade,
              default_fee as defaultFee, session_price as sessionPrice,
              monthly_price as monthlyPrice, session_duration_minutes as sessionDurationMinutes,
              late_after_minutes as lateAfterMinutes, status,
              created_at as createdAt, updated_at as updatedAt
       FROM groups WHERE center_id = ?`,
      [centerId],
    );
    for (const group of groups) queue("group", group.id, group);

    const schedules = db.getAllSync<any>(
      `SELECT id, group_id as groupId, day_of_week as dayOfWeek,
              start_time as startTime, end_time as endTime, status,
              created_at as createdAt, updated_at as updatedAt
       FROM group_schedules WHERE center_id = ?`,
      [centerId],
    );
    for (const schedule of schedules) queue("group_schedule", schedule.id, schedule);

    const students = db.getAllSync<any>(
      `SELECT id, student_code as studentCode, full_name as fullName,
              card_code as cardCode, phone, parent_phone as parentPhone,
              grade, status, student_type as studentType, notes,
              created_at as createdAt, updated_at as updatedAt
       FROM students WHERE center_id = ?`,
      [centerId],
    );
    for (const student of students) {
      const card = db.getFirstSync<any>(
        `SELECT id, card_code as cardCode FROM student_cards
         WHERE center_id = ? AND student_id = ? AND status = 'active'
         ORDER BY issued_at DESC LIMIT 1`,
        [centerId, student.id],
      );
      const cardCode = card?.cardCode || student.cardCode || student.studentCode;
      if (!cardCode) continue;
      queue("student", student.id, {
        ...student,
        cardCode,
        card_code: cardCode,
        student: { ...student, cardCode, card_code: cardCode },
        card: { id: card?.id || `card-${student.id}`, cardCode, card_code: cardCode },
      });
    }

    const enrollments = db.getAllSync<any>(
      `SELECT id, student_id as studentId, group_id as groupId,
              start_date as startDate, end_date as endDate, status,
              special_monthly_price as specialMonthlyPrice,
              created_at as createdAt, updated_at as updatedAt
       FROM student_group_enrollments WHERE center_id = ?`,
      [centerId],
    );
    for (const enrollment of enrollments) queue("enrollment", enrollment.id, enrollment);

    const debtCycles = db.getAllSync<any>(
      `SELECT id, student_id as studentId, enrollment_id as enrollmentId,
              group_id as groupId, cycle_number as cycleNumber,
              start_date as startDate, end_date as endDate,
              cycle_price as cyclePrice, status,
              package_subscription_id as packageSubscriptionId,
              cycle_type as cycleType, created_at as createdAt,
              updated_at as updatedAt
       FROM debt_cycles WHERE center_id = ?`,
      [centerId],
    );
    for (const cycle of debtCycles) queue("debt_cycle", cycle.id, cycle);

    const packages = db.getAllSync<any>(
      `SELECT id, name, price, max_selections as maxSelections, description,
              status, created_at as createdAt, updated_at as updatedAt
       FROM packages WHERE center_id = ?`,
      [centerId],
    );
    for (const pkg of packages) {
      queue("package", pkg.id, {
        ...pkg,
        // The mobile schema predates the server's package fields. Supply
        // safe canonical aliases so a repaired package satisfies the Neon
        // schema instead of relying on implicit defaults.
        grade: pkg.grade || "all",
        totalPrice: pkg.totalPrice ?? pkg.price ?? 0,
        billingCycle: pkg.billingCycle || "monthly",
      });
    }

    const packageSubjects = db.getAllSync<any>(
      `SELECT id, package_id as packageId, subject_id as subjectId,
              default_teacher_id as defaultTeacherId, group_id as groupId, created_at as createdAt
       FROM package_subjects WHERE center_id = ?`,
      [centerId],
    );
    for (const link of packageSubjects) queue("package_subject", link.id, link);

    const subscriptions = db.getAllSync<any>(
      `SELECT id, student_id as studentId, package_id as packageId,
              start_date as startDate, end_date as endDate,
              cancellation_date as cancellationDate, status,
              created_at as createdAt, updated_at as updatedAt
       FROM student_package_subscriptions WHERE center_id = ?`,
      [centerId],
    );
    for (const subscription of subscriptions) queue("package_subscription", subscription.id, subscription);

    const overrides = db.getAllSync<any>(
      `SELECT id, subscription_id as subscriptionId, subject_id as subjectId,
              teacher_id as teacherId, created_at as createdAt
       FROM package_subject_teacher_overrides WHERE center_id = ?`,
      [centerId],
    );
    for (const override of overrides) queue("package_teacher_override", override.id, override);

    return queued;
  }

  /**
   * Authoritative Bootstrap: Pulls full center data from Neon and populates local SQLite.
   */
  static async bootstrapCenter(centerId: string): Promise<void> {
    try {
      const data = await this.adapter.bootstrapCenter(centerId);
      const serverResetGeneration = Number(data.resetGeneration || 0);
      const localResetGeneration = SyncRepository.getResetGeneration(centerId);
      if (serverResetGeneration > localResetGeneration) {
        // The server has intentionally started a new term. Drop local
        // operational rows before applying the fresh authoritative snapshot;
        // otherwise the recovery logic would upload the old term again.
        SyncRepository.resetLocalOperationalData(centerId);
      }
      DatabaseService.runInTransaction((db) => {

      if (Array.isArray(data.gradeExams)) {
        for (const exam of data.gradeExams) {
          db.runSync(`INSERT INTO grade_exams (id, center_id, name, grade, max_score, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, grade=excluded.grade, max_score=excluded.max_score, status=excluded.status, updated_at=excluded.updated_at`,
            [exam.id, exam.center_id || centerId, exam.name, exam.grade, Number(exam.max_score ?? exam.maxScore ?? 100), exam.status || "active", exam.created_at || new Date().toISOString(), exam.updated_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.gradeScores)) {
        for (const score of data.gradeScores) {
          db.runSync(`INSERT INTO grade_scores (id, center_id, exam_id, student_id, score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at`,
            [score.id, score.center_id || centerId, score.exam_id || score.examId, score.student_id || score.studentId, score.score ?? null, score.created_at || new Date().toISOString(), score.updated_at || new Date().toISOString()]);
        }
      }

      // Upsert Teachers
      if (Array.isArray(data.teachers)) {
        for (const t of data.teachers) {
          db.runSync(
            `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at`,
            [
              t.id,
              t.center_id || centerId,
              t.name,
              t.phone || null,
              t.status || "active",
              t.notes || null,
              t.created_at || new Date().toISOString(),
              t.updated_at || new Date().toISOString(),
            ],
          );
        }
      }

      // Upsert Subjects
      if (Array.isArray(data.subjects)) {
        for (const s of data.subjects) {
          db.runSync(
            `INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, status=excluded.status, updated_at=excluded.updated_at`,
            [
              s.id,
              s.center_id || centerId,
              s.name,
              s.code || s.name,
              s.status || "active",
              s.created_at || new Date().toISOString(),
              s.updated_at || new Date().toISOString(),
            ],
          );
        }
      }

      // Upsert Teacher Subjects Link
      if (Array.isArray(data.teacherSubjects)) {
        for (const ts of data.teacherSubjects) {
          db.runSync(
            `INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET teacher_id=excluded.teacher_id, subject_id=excluded.subject_id`,
            [
              ts.id || `ts-${centerId}-${ts.teacher_id}-${ts.subject_id}`,
              ts.center_id || centerId,
              ts.teacher_id || ts.teacherId,
              ts.subject_id || ts.subjectId,
              ts.created_at || new Date().toISOString(),
            ],
          );
        }
      }

      // Upsert Groups
      if (Array.isArray(data.groups)) {
        for (const g of data.groups) {
          const defaultFee = Number(g.default_fee || g.defaultFee || 0);
          const sessionPrice = Number(
            g.session_price || g.sessionPrice || defaultFee,
          );
          const monthlyPrice = Number(
            g.monthly_price || g.monthlyPrice || defaultFee * 4,
          );
          const duration = Number(
            g.session_duration_minutes || g.sessionDurationMinutes || 120,
          );
          const lateAfter = Number(
            g.late_after_minutes || g.lateAfterMinutes || 15,
          );
          db.runSync(
            `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, teacher_id=excluded.teacher_id, subject_id=excluded.subject_id, grade=excluded.grade, default_fee=excluded.default_fee, session_price=excluded.session_price, monthly_price=excluded.monthly_price, session_duration_minutes=excluded.session_duration_minutes, late_after_minutes=excluded.late_after_minutes, status=excluded.status, updated_at=excluded.updated_at`,
            [
              g.id,
              g.center_id || centerId,
              g.name,
              g.teacher_id || g.teacherId,
              g.subject_id || g.subjectId,
              g.grade,
              defaultFee,
              sessionPrice,
              monthlyPrice,
              duration,
              lateAfter,
              g.status === "archived" ? "inactive" : (g.status || "active"),
              g.created_at || new Date().toISOString(),
              g.updated_at || new Date().toISOString(),
            ],
          );

          // Auto-link teacher to subject if not present
          if ((g.teacher_id || g.teacherId) && (g.subject_id || g.subjectId)) {
            try {
              db.runSync(
                `INSERT OR IGNORE INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                [
                  `ts-${centerId}-${g.teacher_id || g.teacherId}-${g.subject_id || g.subjectId}`,
                  centerId,
                  g.teacher_id || g.teacherId,
                  g.subject_id || g.subjectId,
                  new Date().toISOString(),
                ],
              );
            } catch {}
          }
        }
      }

      // Upsert Students
      if (Array.isArray(data.students)) {
        for (const std of data.students) {
          const studentCode =
            std.student_code ||
            std.studentCode ||
            std.card_code ||
            std.cardCode ||
            "";
          const cardCode = std.card_code || std.cardCode || studentCode;
          db.runSync(
            `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET student_code=excluded.student_code, card_code=excluded.card_code, full_name=excluded.full_name, phone=excluded.phone, parent_phone=excluded.parent_phone, grade=excluded.grade, status=excluded.status, student_type=excluded.student_type, notes=excluded.notes, updated_at=excluded.updated_at`,
            [
              std.id,
              std.center_id || centerId,
              studentCode,
              std.full_name || std.fullName || "",
              cardCode,
              std.phone || "",
              std.parent_phone || std.parentPhone || "",
              std.grade || "",
              std.status || "active",
              std.student_type || std.studentType || "registered",
              std.notes || null,
              std.created_at || new Date().toISOString(),
              std.updated_at || new Date().toISOString(),
            ],
          );
        }
      }

      // Upsert Student Cards
      if (Array.isArray(data.cards)) {
        for (const card of data.cards) {
          const cardCenterId = card.center_id || card.centerId || centerId;
          const cardStudentId = card.student_id || card.studentId;
          const cardCode = card.card_code || card.cardCode;
          const cardStatus = card.status === "active" ? "active" : "inactive";
          const issuedAt = card.issued_at || new Date().toISOString();
          const createdAt = card.created_at || new Date().toISOString();
          const existingByCode = db.getFirstSync<{ id: string }>(
            `SELECT id FROM student_cards WHERE center_id = ? AND card_code = ?`,
            [cardCenterId, cardCode],
          );

          // A previous bootstrap may have stored the same card code under a
          // different local id. Keep one canonical row instead of allowing a
          // primary-key/card-code collision to abort the entire bootstrap.
          if (existingByCode && existingByCode.id !== card.id) {
            db.runSync(
              `UPDATE student_cards
               SET student_id = ?, status = ?, issued_at = ?
               WHERE id = ?`,
              [cardStudentId, cardStatus, issuedAt, existingByCode.id],
            );
            continue;
          }

          db.runSync(
            `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               center_id=excluded.center_id,
               student_id=excluded.student_id,
               card_code=excluded.card_code,
               status=excluded.status,
               issued_at=excluded.issued_at`,
            [card.id, cardCenterId, cardStudentId, cardCode, cardStatus, issuedAt, createdAt],
          );
        }
      }

      // Upsert Sessions
      // Schedules are independent records and must be bootstrapped as well;
      // otherwise a fresh device cannot render or generate the same timetable.
      if (Array.isArray(data.schedules)) {
        for (const schedule of data.schedules) {
          db.runSync(
            `INSERT INTO group_schedules
               (id, group_id, day_of_week, start_time, end_time, center_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               group_id = excluded.group_id,
               day_of_week = excluded.day_of_week,
               start_time = excluded.start_time,
               end_time = excluded.end_time,
               center_id = excluded.center_id,
               status = excluded.status,
               updated_at = excluded.updated_at`,
            [
              schedule.id,
              schedule.group_id || schedule.groupId,
              Number(schedule.day_of_week ?? schedule.dayOfWeek),
              schedule.start_time || schedule.startTime,
              schedule.end_time || schedule.endTime,
              schedule.center_id || schedule.centerId || centerId,
              schedule.status || "active",
              schedule.created_at || schedule.createdAt || new Date().toISOString(),
              schedule.updated_at || schedule.updatedAt || new Date().toISOString(),
            ],
          );
        }
      }

      // Upsert Sessions
      if (Array.isArray(data.sessions)) {
        for (const sess of data.sessions) {
          db.runSync(
            `INSERT INTO sessions
               (id, center_id, group_id, session_date, start_time, end_time, status, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               group_id = excluded.group_id,
               session_date = excluded.session_date,
               start_time = excluded.start_time,
               end_time = excluded.end_time,
               status = excluded.status,
               schedule_id = excluded.schedule_id,
               subject_id = excluded.subject_id,
               teacher_id = excluded.teacher_id,
               session_price = excluded.session_price,
               late_after_minutes = excluded.late_after_minutes,
               updated_at = excluded.updated_at`,
            [
              sess.id,
              sess.center_id || centerId,
              sess.group_id || sess.groupId,
              sess.session_date || sess.sessionDate,
              sess.start_time || sess.startTime,
              sess.end_time || sess.endTime,
              sess.status || "open",
              sess.schedule_id || sess.scheduleId || null,
              sess.subject_id || sess.subjectId || null,
              sess.teacher_id || sess.teacherId || null,
              Number(sess.session_price ?? sess.sessionPrice ?? 0),
              Number(sess.late_after_minutes ?? sess.lateAfterMinutes ?? 15),
              sess.created_at || sess.createdAt || new Date().toISOString(),
              sess.updated_at || sess.updatedAt || new Date().toISOString(),
            ],
          );
        }
      }
      if (Array.isArray(data.expectedStudents)) {
        for (const expected of data.expectedStudents) {
          db.runSync(`INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, student_id=excluded.student_id`,
            [expected.id, expected.center_id || centerId, expected.session_id || expected.sessionId, expected.student_id || expected.studentId, expected.created_at || new Date().toISOString()]);
        }
      }

      // Upsert Enrollments
      if (Array.isArray(data.enrollments)) {
        for (const enr of data.enrollments) {
          db.runSync(
            `INSERT INTO student_group_enrollments
               (id, center_id, student_id, group_id, start_date, end_date, status, special_monthly_price, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               student_id = excluded.student_id,
               group_id = excluded.group_id,
               start_date = excluded.start_date,
               end_date = excluded.end_date,
               status = excluded.status,
               special_monthly_price = excluded.special_monthly_price,
               updated_at = excluded.updated_at`,
            [
              enr.id,
              enr.center_id || centerId,
              enr.student_id || enr.studentId,
              enr.group_id || enr.groupId,
              enr.start_date ||
                enr.joined_at ||
                new Date().toISOString().slice(0, 10),
              enr.end_date || enr.ended_at || null,
              enr.status === "withdrawn" ? "ended" : (enr.status || "active"),
              enr.special_monthly_price ?? enr.specialMonthlyPrice ?? enr.price_override ?? enr.priceOverride ?? null,
              enr.created_at || new Date().toISOString(),
              enr.updated_at || new Date().toISOString(),
            ],
          );
        }
      }

      if (Array.isArray(data.attendance)) {
        for (const a of data.attendance) {
          db.runSync(`INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, operation_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, check_in_time=excluded.check_in_time, is_late=excluded.is_late, attendance_type=excluded.attendance_type, original_absence_id=excluded.original_absence_id`,
            [a.id, a.center_id || centerId, a.student_id || a.studentId, a.session_id || a.sessionId, a.check_in_time || a.checkInTime || a.created_at || new Date().toISOString(), (a.is_late || a.isLate) ? "late" : (a.status || "present"), a.is_late || a.isLate ? 1 : 0, a.attendance_type || a.attendanceType || "present", a.original_absence_id || a.originalAbsenceId || null, a.operation_id || a.operationId || `bootstrap-attendance-${a.id}`]);
        }
      }
      if (Array.isArray(data.payments)) {
        for (const p of data.payments) {
          db.runSync(`INSERT INTO payments (id, operation_id, center_id, student_id, amount, payment_type, payment_method, payment_date, notes, debt_cycle_id, session_id, subscription_id, is_reversed, created_at, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, payment_type=excluded.payment_type, payment_method=excluded.payment_method, payment_date=excluded.payment_date, notes=excluded.notes, debt_cycle_id=excluded.debt_cycle_id, session_id=excluded.session_id, subscription_id=excluded.subscription_id, is_reversed=excluded.is_reversed, updated_at=excluded.created_at`,
            [p.id, p.operation_id || p.operationId || `bootstrap-payment-${p.id}`, p.center_id || centerId, p.student_id || p.studentId, Number(p.amount || 0), p.payment_type || p.paymentType || "session", p.payment_method || p.paymentMethod || "cash", p.payment_date || p.paymentDate || (p.created_at || p.createdAt || new Date().toISOString()).slice(0, 10), p.notes || null, p.debt_cycle_id || p.debtCycleId || null, p.session_id || p.sessionId || null, p.subscription_id || p.subscriptionId || null, p.is_reversed ? 1 : 0, p.created_at || p.createdAt || new Date().toISOString(), p.user_id || p.userId || "system"]);
        }
      }
      if (Array.isArray(data.paymentReversals)) {
        const paymentById = new Map((data.payments || []).map((p: any) => [p.id, p]));
        for (const r of data.paymentReversals) {
          const paymentId = r.payment_id || r.paymentId;
          const payment = paymentById.get(paymentId) as any;
          db.runSync(`INSERT INTO payment_reversals (id, operation_id, center_id, payment_id, student_id, reversed_amount, reason, reversed_by, reversed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING`,
            [r.id, r.operation_id || r.operationId || `bootstrap-reversal-${r.id}`, r.center_id || centerId, paymentId, r.student_id || r.studentId || payment?.student_id || "", Number(r.reversed_amount || r.reversedAmount || 0), r.reason || "", r.reversed_by || r.reversedBy || r.user_id || "system", r.reversed_at || r.reversedAt || r.created_at || new Date().toISOString(), r.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.debtAdjustments)) {
        for (const a of data.debtAdjustments) {
          db.runSync(`INSERT INTO debt_adjustments (id, operation_id, center_id, student_id, enrollment_id, debt_cycle_id, amount_before, adjustment_amount, amount_after, reason, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING`,
            [a.id, a.operation_id || a.operationId || `bootstrap-adjustment-${a.id}`, a.center_id || centerId, a.student_id || a.studentId || "", a.enrollment_id || a.enrollmentId || null, a.debt_cycle_id || a.debtCycleId, Number(a.amount_before || a.amountBefore || 0), normalizeAdjustmentAmount(a), Number(a.amount_after || a.amountAfter || (Number(a.amount_before || a.amountBefore || 0) + normalizeAdjustmentAmount(a))), a.reason || "", a.created_by || a.createdBy || a.user_id || "system", a.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.advanceCoverages)) {
        for (const c of data.advanceCoverages) {
          db.runSync(`INSERT INTO advance_coverages (id, operation_id, center_id, student_id, advance_session_id, target_future_session_id, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET target_future_session_id=excluded.target_future_session_id`,
            [c.id, c.operation_id || c.operationId || `bootstrap-coverage-${c.id}`, c.center_id || centerId, c.student_id || c.studentId, c.advance_session_id || c.advanceSessionId, c.target_future_session_id || c.targetFutureSessionId, c.created_by || c.createdBy || "system", c.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.notificationTemplates)) {
        for (const t of data.notificationTemplates) {
          db.runSync(`INSERT INTO notification_templates (id, center_id, event_type, channel, template_body, is_default, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(center_id, event_type, channel, is_default) DO UPDATE SET template_body=excluded.template_body, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
            [t.id, t.center_id || centerId, t.event_type || t.eventType, t.channel, t.template_body || t.templateBody || "", t.is_default ? 1 : 0, t.created_by || t.createdBy || "system", t.updated_by || t.updatedBy || null, t.created_at || new Date().toISOString(), t.updated_at || t.updatedAt || new Date().toISOString()]);
        }
      }

      if (Array.isArray(data.packages)) {
        for (const p of data.packages) {
          db.runSync(`INSERT INTO packages (id, center_id, name, price, max_selections, description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, max_selections=excluded.max_selections, description=excluded.description, status=excluded.status, updated_at=excluded.updated_at`,
            [p.id, p.center_id || centerId, p.name || "", Number(p.price ?? p.total_price ?? p.totalPrice ?? 0), Number(p.max_selections ?? p.maxSelections ?? 1), p.description || null, p.status || "active", p.created_at || new Date().toISOString(), p.updated_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.packageSubjects)) {
        for (const p of data.packageSubjects) {
          db.runSync(`INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, group_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(center_id, package_id, subject_id, default_teacher_id) DO NOTHING`,
            [p.id, p.center_id || centerId, p.package_id || p.packageId, p.subject_id || p.subjectId, p.default_teacher_id || p.defaultTeacherId || "", p.group_id || p.groupId || null, p.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.packageSubscriptions)) {
        for (const s of data.packageSubscriptions) {
          db.runSync(`INSERT INTO student_package_subscriptions (id, center_id, student_id, package_id, start_date, end_date, cancellation_date, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET student_id=excluded.student_id, package_id=excluded.package_id, start_date=excluded.start_date, end_date=excluded.end_date, cancellation_date=excluded.cancellation_date, status=excluded.status, updated_at=excluded.updated_at`,
            [s.id, s.center_id || centerId, s.student_id || s.studentId, s.package_id || s.packageId, s.start_date || s.startDate || new Date().toISOString().slice(0,10), s.end_date || s.endDate || null, s.cancellation_date || s.cancellationDate || null, s.status || "active", s.created_at || new Date().toISOString(), s.updated_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.packageTeacherOverrides)) {
        for (const o of data.packageTeacherOverrides) {
          db.runSync(`INSERT INTO package_subject_teacher_overrides (id, center_id, subscription_id, subject_id, teacher_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET teacher_id=excluded.teacher_id`,
            [o.id, o.center_id || centerId, o.subscription_id || o.subscriptionId, o.subject_id || o.subjectId, o.teacher_id || o.teacherId, o.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.debtCycles)) {
        for (const c of data.debtCycles) {
          upsertLocalDebtCycle(db, c, centerId);
        }
      }
      if (Array.isArray(data.notificationEvents)) {
        for (const e of data.notificationEvents) {
          db.runSync(`INSERT INTO notification_events (id, operation_id, center_id, student_id, session_id, attendance_id, event_type, template_id, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET event_type=excluded.event_type, template_id=excluded.template_id`,
            [e.id, e.operation_id || `bootstrap-${e.id}`, e.center_id || centerId, e.student_id || e.studentId, e.session_id || e.sessionId || "", e.attendance_id || e.attendanceId || null, e.event_type || e.eventType || "", e.template_id || e.templateId || null, e.created_by || e.createdBy || "system", e.created_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.notificationDeliveries)) {
        for (const d of data.notificationDeliveries) {
          db.runSync(`INSERT INTO notification_deliveries (id, center_id, notification_event_id, channel, status, recipient, rendered_message, sent_at, failure_reason, retry_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, status=excluded.status, sent_at=excluded.sent_at, failure_reason=excluded.failure_reason, retry_count=excluded.retry_count, updated_at=excluded.updated_at`,
            [d.id, d.center_id || centerId, d.notification_event_id || d.notificationEventId, d.provider || d.channel || "push", d.status || "pending", d.recipient || "", d.rendered_message || d.renderedMessage || "", d.sent_at || d.sentAt || null, d.failure_reason || d.failureReason || (d.response_payload ? JSON.stringify(d.response_payload) : null), Number(d.retry_count || 0), d.created_at || new Date().toISOString(), d.updated_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.sessionClosings)) {
        for (const c of data.sessionClosings) {
          db.runSync(`INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, reason, performed_by, performed_at, previous_status, new_status, total_attendance, total_session_payments, created_at)
            VALUES (?, ?, ?, ?, 'close', ?, ?, ?, 'open', 'closed', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET new_status='closed', total_attendance=excluded.total_attendance, total_session_payments=excluded.total_session_payments`,
            [c.id, `bootstrap-${c.id}`, c.center_id || centerId, c.session_id || c.sessionId, c.discrepancy_notes || null, c.closed_by || c.closedBy || "system", c.closed_at || new Date().toISOString(), Number(c.total_present || 0), Number(c.total_collected || 0), c.closed_at || new Date().toISOString()]);
        }
      }
      if (Array.isArray(data.dailyClosings)) {
        for (const c of data.dailyClosings) {
          db.runSync(`INSERT INTO daily_closing_summaries (id, operation_id, center_id, business_date, status, closed_by, closed_at, total_cash, payment_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, closed_by=excluded.closed_by, closed_at=excluded.closed_at, total_cash=excluded.total_cash, payment_count=excluded.payment_count, updated_at=excluded.updated_at`,
            [c.id, `bootstrap-${c.id}`, c.center_id || centerId, c.business_date || c.businessDate, c.status || "closed", c.closed_by || c.closedBy || null, c.closed_at || c.closedAt || null, Number(c.cash_in_drawer ?? c.total_revenue ?? 0), Number(c.payment_count || 0), c.closed_at || new Date().toISOString(), new Date().toISOString()]);
        }
      }

      if (data.latestServerSeq > 0) {
        SyncRepository.setServerCursor(centerId, String(data.latestServerSeq));
      } else {
        SyncRepository.setServerCursor(centerId, "0");
      }
      SyncRepository.setResetGeneration(centerId, serverResetGeneration);
      SyncRepository.requeueEntitiesMissingFromServer(centerId, data);
      });
      this.queueLocalRecordsMissingFromSnapshot(centerId, data);
    } catch (bootstrapErr) {
      console.warn("Bootstrap center error:", bootstrapErr);
    }
  }

  /**
   * Applies server stream changes incrementally to local SQLite.
   */
  static applyServerChanges(centerId: string, changes: any[]): void {
    // Apply the complete pull batch atomically. The caller advances the
    // server cursor only after this transaction commits successfully.
    DatabaseService.runInTransaction((db) => {
      for (const change of changes) {
        try {
        const entityType = change.entityType;
        const data = change.data || {};

        if (entityType === "student" || entityType === "student_created") {
          const s = data.student || data;
          const studentId = s.id || change.entityId;
          const existingStudent = db.getFirstSync<any>(
            `SELECT student_code, card_code, full_name, phone, parent_phone, grade, status, student_type, notes, created_at, updated_at
             FROM students WHERE center_id = ? AND id = ?`,
            [centerId, studentId],
          );
          const studentCode =
            s.student_code || s.studentCode || s.card_code || s.cardCode || existingStudent?.student_code || existingStudent?.card_code || "";
          const cardCode = s.card_code || s.cardCode || existingStudent?.card_code || studentCode;
          const cardWasProvided = Boolean(data.card || !existingStudent);

          db.runSync(
            `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET student_code=excluded.student_code, card_code=excluded.card_code, full_name=excluded.full_name, phone=excluded.phone, parent_phone=excluded.parent_phone, grade=excluded.grade, status=excluded.status, student_type=excluded.student_type, notes=excluded.notes, updated_at=excluded.updated_at`,
            [
              studentId,
              centerId,
              studentCode,
              s.full_name || s.fullName || existingStudent?.full_name || "",
              cardCode,
              s.phone || existingStudent?.phone || "",
              s.parent_phone || s.parentPhone || existingStudent?.parent_phone || "",
              s.grade || existingStudent?.grade || "",
              s.status || existingStudent?.status || "active",
              s.student_type || s.studentType || existingStudent?.student_type || "registered",
              s.notes !== undefined ? s.notes : (existingStudent?.notes || null),
              s.created_at || existingStudent?.created_at || new Date().toISOString(),
              s.updated_at || s.updatedAt || existingStudent?.updated_at || new Date().toISOString(),
            ],
          );

          if (cardCode && cardWasProvided) {
            db.runSync(
              `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(center_id, card_code) DO UPDATE SET
                 student_id=excluded.student_id,
                 status=excluded.status,
                 issued_at=excluded.issued_at`,
              [
                `card-${studentId}`,
                centerId,
                studentId,
                cardCode,
                s.status || existingStudent?.status || "active",
                new Date().toISOString(),
                new Date().toISOString(),
              ],
            );
          }
        } else if (entityType === "student_card") {
          const card = data.card || data;
          const cardId = card.id || change.entityId;
          const studentId = card.student_id || card.studentId;
          const cardCode = String(card.card_code || card.cardCode || "").trim();
          const action = String(change.action || "").toUpperCase();
          const isDeactivation = action === "DELETE" || card.status === "deactivated" || card.status === "lost" || card.status === "inactive";
          if (!cardId || !studentId || (!cardCode && !isDeactivation)) {
            throw new Error("Invalid student card change from server");
          }
          if (
            isDeactivation
          ) {
            db.runSync(
              `UPDATE student_cards SET status = ?, deactivated_at = ?
               WHERE id = ? AND center_id = ?`,
              [
                "inactive",
                new Date().toISOString(),
                cardId,
                centerId,
              ],
            );
          } else {
            db.runSync(
              `UPDATE student_cards SET status = 'deactivated', deactivated_at = ?
               WHERE center_id = ? AND student_id = ? AND status = 'active' AND id <> ?`,
              [new Date().toISOString(), centerId, studentId, cardId],
            );
            const existingByCode = db.getFirstSync<any>(
              `SELECT id, student_id as studentId FROM student_cards
               WHERE center_id = ? AND card_code = ?`,
              [centerId, cardCode],
            );
            if (existingByCode && existingByCode.studentId !== studentId) {
              throw new Error("Card code is owned by another student");
            }
            if (existingByCode && existingByCode.id !== cardId) {
              db.runSync(
                `UPDATE student_cards SET status = 'active', deactivated_at = NULL, issued_at = ?, created_at = COALESCE(created_at, ?)
                 WHERE id = ? AND center_id = ?`,
                [
                  card.issued_at || card.issuedAt || new Date().toISOString(),
                  card.created_at || card.createdAt || new Date().toISOString(),
                  existingByCode.id,
                  centerId,
                ],
              );
            } else {
            db.runSync(
              `INSERT INTO student_cards
                 (id, center_id, student_id, card_code, status, issued_at, deactivated_at, created_at)
               VALUES (?, ?, ?, ?, 'active', ?, NULL, ?)
               ON CONFLICT(id) DO UPDATE SET
                 center_id = excluded.center_id,
                 student_id = excluded.student_id,
                 card_code = excluded.card_code,
                 status = 'active',
                 issued_at = excluded.issued_at,
                 deactivated_at = NULL`,
              [
                cardId,
                centerId,
                studentId,
                cardCode,
                card.issued_at || card.issuedAt || new Date().toISOString(),
                card.created_at || card.createdAt || new Date().toISOString(),
              ],
            );
            }
          }
        } else if (entityType === "enrollment" || entityType === "student_group_enrollment") {
          const enrollment = data.enrollment || data;
          const enrollmentId = enrollment.id || change.entityId;
          db.runSync(
            `INSERT INTO student_group_enrollments
               (id, center_id, student_id, group_id, start_date, end_date, status, special_monthly_price, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               student_id = excluded.student_id,
               group_id = excluded.group_id,
               start_date = excluded.start_date,
               end_date = excluded.end_date,
               status = excluded.status,
               special_monthly_price = excluded.special_monthly_price,
               updated_at = excluded.updated_at`,
            [
              enrollmentId,
              centerId,
              enrollment.student_id || enrollment.studentId,
              enrollment.group_id || enrollment.groupId,
              enrollment.start_date || enrollment.startDate || enrollment.joined_at || enrollment.joinedAt || new Date().toISOString().slice(0, 10),
              enrollment.end_date || enrollment.endDate || enrollment.ended_at || enrollment.endedAt || null,
              enrollment.status === "withdrawn" ? "ended" : (enrollment.status || "active"),
              enrollment.special_monthly_price ?? enrollment.specialMonthlyPrice ?? enrollment.price_override ?? enrollment.priceOverride ?? null,
              enrollment.created_at || enrollment.createdAt || new Date().toISOString(),
              enrollment.updated_at || enrollment.updatedAt || new Date().toISOString(),
            ],
          );
        } else if (entityType === "teacher_subject" || entityType === "teacher_subject_assigned") {
          const link = data.teacherSubject || data;
          const teacherId = link.teacher_id || link.teacherId;
          const subjectId = link.subject_id || link.subjectId;
          if (!teacherId || !subjectId) throw new Error("Invalid teacher-subject change from server");
          if (String(change.action || "").toUpperCase() === "DELETE" || link.status === "inactive") {
            db.runSync(
              `DELETE FROM teacher_subjects WHERE center_id = ? AND teacher_id = ? AND subject_id = ?`,
              [centerId, teacherId, subjectId],
            );
          } else {
            db.runSync(
              `INSERT OR IGNORE INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              [
                link.id || `ts-${centerId}-${teacherId}-${subjectId}`,
                centerId,
                teacherId,
                subjectId,
                link.created_at || link.createdAt || new Date().toISOString(),
              ],
            );
          }
        } else if (entityType === "group_schedule") {
          const schedule = data.schedule || data;
          const scheduleId = schedule.id || change.entityId;
          if (String(change.action || "").toUpperCase() === "DELETE" || schedule.status === "inactive") {
            db.runSync(
              `UPDATE group_schedules SET status = 'inactive', updated_at = ? WHERE id = ? AND center_id = ?`,
              [new Date().toISOString(), scheduleId, centerId],
            );
          } else {
            db.runSync(
              `INSERT INTO group_schedules (id, group_id, day_of_week, start_time, end_time, center_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 group_id = excluded.group_id,
                 day_of_week = excluded.day_of_week,
                 start_time = excluded.start_time,
                 end_time = excluded.end_time,
                 center_id = excluded.center_id,
                 status = excluded.status,
                 updated_at = excluded.updated_at`,
              [
                scheduleId,
                schedule.group_id || schedule.groupId,
                Number(schedule.day_of_week ?? schedule.dayOfWeek),
                schedule.start_time || schedule.startTime,
                schedule.end_time || schedule.endTime,
                centerId,
                schedule.status || "active",
                schedule.created_at || schedule.createdAt || new Date().toISOString(),
                schedule.updated_at || schedule.updatedAt || new Date().toISOString(),
              ],
            );
          }
        } else if (entityType === "session" || entityType === "session_created") {
          const session = data.session || data;
          const sessionId = session.id || session.sessionId || change.entityId;
          const existingSession = db.getFirstSync<any>(`SELECT group_id, session_date, start_time, end_time, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, created_at FROM sessions WHERE center_id = ? AND id = ?`, [centerId, sessionId]);
          const sessionAction = String(session.action || change.action || "").toLowerCase();
          const requestedSessionStatus = sessionAction === "close" ? "closed" : sessionAction === "reopen" ? "open" : (session.status || "open");
          db.runSync(
            `INSERT INTO sessions
               (id, center_id, group_id, session_date, start_time, end_time, status, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               group_id = excluded.group_id,
               session_date = excluded.session_date,
               start_time = excluded.start_time,
               end_time = excluded.end_time,
               status = excluded.status,
               schedule_id = excluded.schedule_id,
               subject_id = excluded.subject_id,
               teacher_id = excluded.teacher_id,
               session_price = excluded.session_price,
               late_after_minutes = excluded.late_after_minutes,
               updated_at = excluded.updated_at`,
            [
              sessionId,
              centerId,
              session.group_id || session.groupId || existingSession?.group_id || "",
              session.session_date || session.sessionDate || existingSession?.session_date || new Date().toISOString().slice(0,10),
              session.start_time || session.startTime || existingSession?.start_time || "00:00",
              session.end_time || session.endTime || existingSession?.end_time || "00:00",
              requestedSessionStatus,
              session.schedule_id || session.scheduleId || existingSession?.schedule_id || null,
              session.subject_id || session.subjectId || existingSession?.subject_id || null,
              session.teacher_id || session.teacherId || existingSession?.teacher_id || null,
              Number(session.session_price ?? session.sessionPrice ?? existingSession?.session_price ?? 0),
              Number(session.late_after_minutes ?? session.lateAfterMinutes ?? existingSession?.late_after_minutes ?? 15),
              session.created_at || session.createdAt || existingSession?.created_at || new Date().toISOString(),
              session.updated_at || session.updatedAt || new Date().toISOString(),
            ],
          );
          if (Array.isArray(session.expectedStudentIds)) {
            for (const studentId of session.expectedStudentIds) {
              db.runSync(
                `INSERT OR IGNORE INTO session_expected_students
                   (id, center_id, session_id, student_id, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                  `exp-${sessionId}-${studentId}`,
                  centerId,
                  sessionId,
                  studentId,
                  session.created_at || session.createdAt || new Date().toISOString(),
                ],
              );
            }
          }
          if (sessionAction === "close" || sessionAction === "reopen") {
            if (sessionAction === "reopen") {
              db.runSync(`INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, reason, performed_by, performed_at, previous_status, new_status, total_attendance, total_session_payments, created_at)
                VALUES (?, ?, ?, ?, 'reopen', ?, ?, ?, 'closed', 'open', 0, 0, ?)
                ON CONFLICT(operation_id) DO NOTHING`,
                [session.closingRecordId || `reopen-${sessionId}-${change.operationId || Date.now()}`, change.operationId || `srv-reopen-${sessionId}`, centerId, sessionId, session.reason || null, session.performedBy || "system", session.performedAt || new Date().toISOString(), new Date().toISOString()]);
            } else {
              db.runSync(`INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, reason, performed_by, performed_at, previous_status, new_status, total_attendance, total_session_payments, created_at)
                VALUES (?, ?, ?, ?, 'close', ?, ?, ?, 'open', 'closed', ?, ?, ?)
                ON CONFLICT(operation_id) DO NOTHING`,
                [session.closingRecordId || `close-${sessionId}`, change.operationId || `srv-close-${sessionId}`, centerId, sessionId, session.reason || null, session.performedBy || "system", session.performedAt || new Date().toISOString(), Number(session.totalAttendance || 0), Number(session.totalSessionPayments || 0), new Date().toISOString()]);
            }
          }
        } else if (
          entityType === "teacher" ||
          entityType === "teacher_created" ||
          entityType === "teacher_updated"
        ) {
          const t = data.teacher || data;
          const teacherId = t.id || change.entityId;
          db.runSync(
            `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at`,
            [
              teacherId,
              centerId,
              t.name || "معلم",
              t.phone || null,
              t.status || "active",
              t.notes || null,
              t.created_at || new Date().toISOString(),
              t.updated_at || new Date().toISOString(),
            ],
          );
          if (t.cascadeGroups === true && (t.status || "") === "inactive") {
            db.runSync("UPDATE groups SET status = 'inactive', updated_at = ? WHERE center_id = ? AND teacher_id = ?", [t.updated_at || t.updatedAt || new Date().toISOString(), centerId, teacherId]);
          }
        } else if (
          entityType === "subject" ||
          entityType === "subject_created" ||
          entityType === "subject_updated"
        ) {
          const s = data.subject || data;
          const subjectId = s.id || change.entityId;
          db.runSync(
            `INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, status=excluded.status, updated_at=excluded.updated_at`,
            [
              subjectId,
              centerId,
              s.name || "مادة",
              s.code || s.name || "SUBJ",
              s.status || "active",
              s.created_at || new Date().toISOString(),
              s.updated_at || new Date().toISOString(),
            ],
          );
        } else if (
          entityType === "group" ||
          entityType === "group_created" ||
          entityType === "group_updated"
        ) {
          const g = data.group || data;
          const groupId = g.id || change.entityId;
          const defaultFee = Number(g.default_fee || g.defaultFee || 0);
          const sessionPrice = Number(
            g.session_price || g.sessionPrice || defaultFee,
          );
          const monthlyPrice = Number(
            g.monthly_price || g.monthlyPrice || defaultFee * 4,
          );
          db.runSync(
            `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, teacher_id=excluded.teacher_id, subject_id=excluded.subject_id, grade=excluded.grade, default_fee=excluded.default_fee, session_price=excluded.session_price, monthly_price=excluded.monthly_price, session_duration_minutes=excluded.session_duration_minutes, late_after_minutes=excluded.late_after_minutes, status=excluded.status, updated_at=excluded.updated_at`,
            [
              groupId,
              centerId,
              g.name || "مجموعة",
              g.teacher_id || g.teacherId,
              g.subject_id || g.subjectId,
              g.grade || "الصف الثالث الثانوي",
              defaultFee,
              sessionPrice,
              monthlyPrice,
              Number(g.session_duration_minutes || 120),
              Number(g.late_after_minutes || 15),
              g.status === "archived" ? "inactive" : (g.status || "active"),
              g.created_at || new Date().toISOString(),
              g.updated_at || new Date().toISOString(),
            ],
          );
          if ((g.teacher_id || g.teacherId) && (g.subject_id || g.subjectId)) {
            try {
              db.runSync(
                `INSERT OR IGNORE INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                [
                  `ts-${centerId}-${g.teacher_id || g.teacherId}-${g.subject_id || g.subjectId}`,
                  centerId,
                  g.teacher_id || g.teacherId,
                  g.subject_id || g.subjectId,
                  new Date().toISOString(),
                ],
              );
            } catch {}
          }
        } else if (
          entityType === "attendance" ||
          entityType === "attendance_marked"
        ) {
          const att = data;
          const attId = att.id || change.entityId;
          db.runSync(
            `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, operation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, check_in_time=excluded.check_in_time, is_late=excluded.is_late, attendance_type=excluded.attendance_type, original_absence_id=excluded.original_absence_id`,
            [
              attId,
              centerId,
              att.student_id || att.studentId,
              att.session_id || att.sessionId,
              att.check_in_time || att.checkInTime || new Date().toISOString(),
              att.is_late || att.isLate ? "late" : (att.status || "present"),
              att.is_late || att.isLate ? 1 : 0,
              att.attendance_type || att.attendanceType || "present",
              att.original_absence_id || att.originalAbsenceId || null,
              change.operationId || `srv-op-${change.sequenceNumber || Date.now()}`,
            ],
          );
        } else if (entityType === "payment") {
          const pay = data;
          const payId = pay.id || change.entityId;
          db.runSync(
            `INSERT INTO payments (id, operation_id, center_id, student_id, amount, payment_type, payment_method, payment_date, notes, debt_cycle_id, session_id, subscription_id, is_reversed, created_at, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, payment_type=excluded.payment_type, payment_method=excluded.payment_method, payment_date=excluded.payment_date, notes=excluded.notes, debt_cycle_id=excluded.debt_cycle_id, session_id=excluded.session_id, subscription_id=excluded.subscription_id, is_reversed=excluded.is_reversed`,
            [
              payId,
              change.operationId || pay.operation_id || pay.operationId || `srv-pay-${payId}`,
              centerId,
              pay.student_id || pay.studentId,
              parseFloat(pay.amount || 0),
              pay.payment_type || pay.paymentType || "session",
              pay.payment_method || pay.paymentMethod || "cash",
              pay.payment_date || pay.paymentDate || (pay.created_at || pay.createdAt || new Date().toISOString()).slice(0, 10),
              pay.notes || null,
              pay.debt_cycle_id || pay.debtCycleId || null,
              pay.session_id || pay.sessionId || null,
              pay.subscription_id || pay.subscriptionId || null,
              pay.is_reversed ? 1 : 0,
              pay.created_at || new Date().toISOString(),
              pay.user_id || "system",
            ],
          );
        } else if (entityType === "payment_reversal") {
          const rev = data.reversal || data;
          const paymentId = rev.payment_id || rev.paymentId;
          db.runSync(`UPDATE payments SET is_reversed = 1, updated_at = ? WHERE id = ? AND center_id = ?`, [new Date().toISOString(), paymentId, centerId]);
          db.runSync(`INSERT INTO payment_reversals (id, operation_id, center_id, payment_id, student_id, reversed_amount, reason, reversed_by, reversed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING`,
            [rev.id || change.entityId, change.operationId || `srv-reversal-${rev.id || change.entityId}`, centerId, paymentId, rev.student_id || rev.studentId || "", Number(rev.reversed_amount ?? rev.reversedAmount ?? 0), rev.reason || "", rev.reversed_by || rev.reversedBy || "system", rev.reversed_at || rev.reversedAt || new Date().toISOString(), rev.created_at || new Date().toISOString()]);
        } else if (entityType === "debt_adjustment") {
          const a = data.adjustment || data;
          db.runSync(`INSERT INTO debt_adjustments (id, operation_id, center_id, student_id, enrollment_id, debt_cycle_id, amount_before, adjustment_amount, amount_after, reason, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING`,
            [a.id || change.entityId, change.operationId || `srv-adjustment-${a.id || change.entityId}`, centerId, a.student_id || a.studentId || "", a.enrollment_id || a.enrollmentId || null, a.debt_cycle_id || a.debtCycleId || "", Number(a.amount_before ?? a.amountBefore ?? 0), normalizeAdjustmentAmount(a), Number(a.amount_after ?? a.amountAfter ?? (Number(a.amount_before ?? a.amountBefore ?? 0) + normalizeAdjustmentAmount(a))), a.reason || "", a.created_by || a.createdBy || "system", a.created_at || new Date().toISOString()]);
        } else if (entityType === "package") {
          const p = data.package || data;
          db.runSync(`INSERT INTO packages (id, center_id, name, price, max_selections, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, max_selections=excluded.max_selections, description=excluded.description, status=excluded.status, updated_at=excluded.updated_at`,
            [p.id || change.entityId, centerId, p.name || "", Number(p.price ?? p.total_price ?? p.totalPrice ?? 0), Number(p.max_selections ?? p.maxSelections ?? 1), p.description || null, p.status || "active", p.created_at || new Date().toISOString(), p.updated_at || new Date().toISOString()]);
        } else if (entityType === "package_subject") {
          const p = data.packageSubject || data;
          const packageAction = String(change.action || "").toUpperCase();
          const remove = packageAction === "DELETE" || packageAction.includes("REMOVE") || p.status === "inactive";
          if (remove) db.runSync(`DELETE FROM package_subjects WHERE center_id=? AND package_id=? AND subject_id=?`, [centerId, p.package_id || p.packageId, p.subject_id || p.subjectId]);
          else db.runSync(`INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(center_id, package_id, subject_id, default_teacher_id) DO NOTHING`,
            [p.id || change.entityId, centerId, p.package_id || p.packageId, p.subject_id || p.subjectId, p.default_teacher_id || p.defaultTeacherId || p.teacher_id || p.teacherId || "", p.group_id || p.groupId || null, p.created_at || new Date().toISOString()]);
        } else if (entityType === "package_subscription") {
          const s = data.subscription || data;
          db.runSync(`INSERT INTO student_package_subscriptions (id, center_id, student_id, package_id, start_date, end_date, cancellation_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET student_id=excluded.student_id, package_id=excluded.package_id, start_date=excluded.start_date, end_date=excluded.end_date, cancellation_date=excluded.cancellation_date, status=excluded.status, updated_at=excluded.updated_at`,
            [s.id || change.entityId, centerId, s.student_id || s.studentId, s.package_id || s.packageId, s.start_date || s.startDate || new Date().toISOString().slice(0,10), s.end_date || s.endDate || null, s.cancellation_date || s.cancellationDate || null, s.status || "active", s.created_at || new Date().toISOString(), s.updated_at || new Date().toISOString()]);
        } else if (entityType === "package_teacher_override") {
          const o = data.override || data;
          const overrideAction = String(change.action || "").toUpperCase();
          const remove = overrideAction === "DELETE" || overrideAction.includes("REMOVE") || o.status === "inactive";
          if (remove) db.runSync(`DELETE FROM package_subject_teacher_overrides WHERE center_id=? AND subscription_id=? AND subject_id=?`, [centerId, o.subscription_id || o.subscriptionId, o.subject_id || o.subjectId]);
          else db.runSync(`INSERT INTO package_subject_teacher_overrides (id, center_id, subscription_id, subject_id, teacher_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET teacher_id=excluded.teacher_id`,
            [o.id || change.entityId, centerId, o.subscription_id || o.subscriptionId, o.subject_id || o.subjectId, o.teacher_id || o.teacherId, o.created_at || new Date().toISOString()]);
         } else if (entityType === "debt_cycle") {
           const c = data.debtCycle || data;
           upsertLocalDebtCycle(db, { ...c, id: c.id || change.entityId }, centerId);
        } else if (entityType === "advance_coverage") {
          const c = data.coverage || data;
          db.runSync(`INSERT INTO advance_coverages (id, operation_id, center_id, student_id, advance_session_id, target_future_session_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET target_future_session_id=excluded.target_future_session_id`,
            [c.id || change.entityId, change.operationId || `srv-coverage-${c.id || change.entityId}`, centerId, c.student_id || c.studentId, c.advance_session_id || c.advanceSessionId, c.target_future_session_id || c.targetFutureSessionId, c.created_by || c.createdBy || "system", c.created_at || new Date().toISOString()]);
        } else if (entityType === "grade_exam") {
          const exam = data.exam || data;
          db.runSync(`INSERT INTO grade_exams (id, center_id, name, grade, max_score, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, grade=excluded.grade, max_score=excluded.max_score, status=excluded.status, updated_at=excluded.updated_at`,
            [exam.id || change.entityId, centerId, exam.name || "امتحان", exam.grade || "", Number(exam.max_score ?? exam.maxScore ?? 100), exam.status || "active", exam.created_at || exam.createdAt || new Date().toISOString(), exam.updated_at || exam.updatedAt || new Date().toISOString()]);
        } else if (entityType === "grade_score") {
          const score = data.scoreRecord || data;
          db.runSync(`INSERT INTO grade_scores (id, center_id, exam_id, student_id, score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at`,
            [score.id || change.entityId, centerId, score.exam_id || score.examId, score.student_id || score.studentId, score.score === "" ? null : (score.score ?? null), score.created_at || score.createdAt || new Date().toISOString(), score.updated_at || score.updatedAt || new Date().toISOString()]);
        } else if (entityType === "notification_event") {
          const e = data.event || data;
          db.runSync(`INSERT INTO notification_events (id, operation_id, center_id, student_id, session_id, attendance_id, event_type, template_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET event_type=excluded.event_type, template_id=excluded.template_id`,
            [e.id || e.eventId || change.entityId, change.operationId || e.operation_id || `srv-notif-${e.id || change.entityId}`, centerId, e.student_id || e.studentId, e.session_id || e.sessionId || "", e.attendance_id || e.attendanceId || null, e.event_type || e.eventType || "", e.template_id || e.templateId || null, e.created_by || e.createdBy || "system", e.created_at || new Date().toISOString()]);
        } else if (entityType === "notification_delivery") {
          const d = data.delivery || data;
          db.runSync(`INSERT INTO notification_deliveries (id, center_id, notification_event_id, channel, status, recipient, rendered_message, sent_at, failure_reason, retry_count, provider_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, status=excluded.status, sent_at=excluded.sent_at, failure_reason=excluded.failure_reason, retry_count=excluded.retry_count, provider_message_id=excluded.provider_message_id, updated_at=excluded.updated_at`,
            [d.id || change.entityId, centerId, d.notification_event_id || d.notificationEventId, d.provider || d.channel || "push", d.status || "pending", d.recipient || "", d.rendered_message || d.renderedMessage || "", d.sent_at || d.sentAt || null, d.failure_reason || d.failureReason || null, Number(d.retry_count || 0), d.provider_message_id || d.providerMessageId || null, d.created_at || new Date().toISOString(), d.updated_at || new Date().toISOString()]);
        } else if (entityType === "notification_template") {
          const t = data.template || data;
          db.runSync(`INSERT INTO notification_templates (id, center_id, event_type, channel, template_body, is_default, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(center_id, event_type, channel, is_default) DO UPDATE SET event_type=excluded.event_type, channel=excluded.channel, template_body=excluded.template_body, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
            [t.id || t.templateId || change.entityId, centerId, t.event_type || t.eventType, t.channel, t.template_body || t.templateBody || "", t.is_default ? 1 : 0, t.created_by || t.createdBy || "system", t.updated_by || t.updatedBy || null, t.created_at || t.createdAt || new Date().toISOString(), t.updated_at || t.updatedAt || new Date().toISOString()]);
        } else if (entityType === "session_closing") {
          const c = data.closing || data;
          const sessionId = c.session_id || c.sessionId || change.entityId;
          const reopen = String(c.action || change.action || "").toLowerCase() === "reopen";
          db.runSync(`UPDATE sessions SET status=?, updated_at=? WHERE id=? AND center_id=?`, [reopen ? "open" : "closed", new Date().toISOString(), sessionId, centerId]);
          if (reopen) db.runSync(`DELETE FROM session_closing_records WHERE center_id=? AND session_id=?`, [centerId, sessionId]);
          else db.runSync(`INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, reason, performed_by, performed_at, previous_status, new_status, total_attendance, total_session_payments, created_at) VALUES (?, ?, ?, ?, 'close', ?, ?, ?, 'open', 'closed', ?, ?, ?)
            ON CONFLICT(operation_id) DO NOTHING`, [c.id || `close-${sessionId}`, change.operationId || `srv-close-${sessionId}`, centerId, sessionId, c.reason || null, c.performed_by || c.performedBy || "system", c.performed_at || c.performedAt || new Date().toISOString(), Number(c.total_attendance ?? c.totalAttendance ?? 0), Number(c.total_session_payments ?? c.totalSessionPayments ?? 0), new Date().toISOString()]);
        } else if (entityType === "daily_closing") {
          const c = data.closing || data;
          const dailyAction = String(c.action || change.action || "").toLowerCase();
          const reopen = dailyAction === "reopen" || dailyAction.includes("reopen") || Boolean(c.reopenedBy || c.reopened_by || c.reason);
          db.runSync(`INSERT INTO daily_closing_summaries (id, operation_id, center_id, business_date, status, closed_by, closed_at, reopened_by, reopened_at, reopen_reason, total_cash, payment_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, closed_by=excluded.closed_by, closed_at=excluded.closed_at, reopened_by=excluded.reopened_by, reopened_at=excluded.reopened_at, reopen_reason=excluded.reopen_reason, total_cash=excluded.total_cash, payment_count=excluded.payment_count, updated_at=excluded.updated_at`, [c.id || change.entityId, change.operationId || `srv-daily-${c.id || change.entityId}`, centerId, c.business_date || c.businessDate, reopen ? "open" : "closed", c.closed_by || c.closedBy || null, reopen ? null : (c.closed_at || c.closedAt || new Date().toISOString()), reopen ? (c.reopened_by || c.reopenedBy || "system") : null, reopen ? new Date().toISOString() : null, c.reason || null, Number(c.total_cash ?? c.totalCash ?? c.cash_in_drawer ?? 0), Number(c.payment_count || 0), new Date().toISOString(), new Date().toISOString()]);
        } else {
          // Never advance the cursor past a record we cannot apply locally.
          // The next sync retries it after the app/backend has been upgraded.
          throw new Error(`Unsupported server sync entity type: ${entityType}`);
        }
        } catch (applyErr) {
          console.warn("Failed to apply change:", change, applyErr);
          throw applyErr;
        }
      }
    });
  }

  /**
   * Executes bidirectional synchronization for a center:
   * 1. Validates device status.
   * 2. Checks network connectivity.
   * 3. Performs initial bootstrap if cursor is 0 or local academic records are empty.
   * 4. Pulls new server changes using monotonic cursor and applies them to local SQLite.
   * 5. Batches and pushes pending local operations in priority order.
   * 6. Handles conflicts and retries gracefully.
   */
  static async syncCenterNow(
    centerId: string,
    options?: { batchSize?: number; pullLimit?: number },
  ): Promise<{
    syncedCount: number;
    errors: number;
    conflicts: number;
    state: SyncEngineState;
    arabicMessage: string;
  }> {
    const previous = this.syncLocks.get(centerId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queueTail = previous ? previous.catch(() => {}).then(() => current) : current;
    this.syncLocks.set(centerId, queueTail);
    if (previous) await previous.catch(() => {});
    const databasePrevious = this.databaseSyncLock;
    let databaseRelease!: () => void;
    const databaseCurrent = new Promise<void>((resolve) => {
      databaseRelease = resolve;
    });
    this.databaseSyncLock = databaseCurrent;
    if (databasePrevious) await databasePrevious.catch(() => {});
    try {
      return await this.runSyncCenterNow(centerId, options);
    } finally {
      databaseRelease();
      if (this.databaseSyncLock === databaseCurrent) {
        this.databaseSyncLock = null;
      }
      release();
      if (this.syncLocks.get(centerId) === queueTail) {
        this.syncLocks.delete(centerId);
      }
    }
  }

  private static async runSyncCenterNow(
    centerId: string,
    options?: { batchSize?: number; pullLimit?: number },
  ): Promise<{
    syncedCount: number;
    errors: number;
    conflicts: number;
    state: SyncEngineState;
    arabicMessage: string;
  }> {
    const startTime = Date.now();

    // 1. Inactive device check
    const deviceStatus = DeviceRepository.getDeviceStatus(centerId);
    if (deviceStatus === "inactive") {
      this.currentState = "error";
      Logger.warn("sync", "device_inactive", { centerId });
      return {
        syncedCount: 0,
        errors: 1,
        conflicts: 0,
        state: "error",
        arabicMessage: "هذا الجهاز غير نشط أو تم إلغاء تفعيله من قبل الإدارة.",
      };
    }

    // 2. Connectivity check
    const connectivity = ConnectivityService.getState();
    if (connectivity === "offline") {
      this.currentState = "offline";
      return {
        syncedCount: 0,
        errors: 0,
        conflicts: 0,
        state: "offline",
        arabicMessage: "الجهاز غير متصل بالإنترنت. تم حفظ العمليات محلياً.",
      };
    }

    this.currentState = "syncing";
    const batchSize = options?.batchSize || 50;
    const pullLimit = options?.pullLimit || 50;

    // Recover mutations left in `syncing` by a crashed or force-closed app.
    SyncRepository.recoverInterruptedOperations(centerId);
    // Retry old student/package conflicts that were caused by the server
    // validation/schema fixes. Without this, those records remain parked
    // forever because normal pending selection excludes `conflict` rows.
    SyncRepository.requeueRecoverableConflicts(centerId);

    let syncedCount = 0;
    let errors = 0;
    let conflicts = 0;

    try {
      // 3. Monotonic Cursor Check: Bootstrap if 0 OR if local teachers/groups are empty
      const db = DatabaseService.getDb();
      let localTeachersCount = 0;
      try {
        const row = db.getFirstSync<{ count: number }>(
          `SELECT COUNT(*) as count FROM teachers WHERE center_id = ? AND status = 'active'`,
          [centerId],
        );
        localTeachersCount = row?.count || 0;
      } catch {}

      let currentCursor = SyncRepository.getServerCursor(centerId);
      // Always bootstrap once per app process. This is required after a
      // server reset/reseed: the server sequence may have started again at a
      // value that is not lower than the client's cursor, so cursor comparison
      // alone cannot reveal that older local records are missing remotely.
      const firstBootstrapForCenter = !this.bootstrapCompletedCenters.has(centerId);
      if (firstBootstrapForCenter || currentCursor === "0" || localTeachersCount === 0) {
        try {
          await this.bootstrapCenter(centerId);
          this.bootstrapCompletedCenters.add(centerId);
          currentCursor = SyncRepository.getServerCursor(centerId);
        } catch (bootErr: any) {
          Logger.warn("sync", "bootstrap_skipped", {
            centerId,
            error:
              bootErr?.userMessage ||
              bootErr?.message ||
              "Bootstrap endpoint skipped, falling back to incremental stream pull and push",
          });
        }
      }

      // 4. Pull Changes from Server with Monotonic Cursor
      try {
        let hasMore = true;
        let batches = 0;
        while (hasMore && batches < 100) {
          const pullResponse = await this.adapter.pullChanges(centerId, currentCursor, pullLimit);
          if (Number(pullResponse.resetGeneration || 0) > SyncRepository.getResetGeneration(centerId)) {
            await this.bootstrapCenter(centerId);
            currentCursor = SyncRepository.getServerCursor(centerId);
            hasMore = false;
            continue;
          }
          if (pullResponse.cursorReset) {
            await this.bootstrapCenter(centerId);
            currentCursor = SyncRepository.getServerCursor(centerId);
            hasMore = false;
            continue;
          }
          if (pullResponse.changes && pullResponse.changes.length > 0) {
            this.applyServerChanges(centerId, pullResponse.changes);
          }
          const nextCursor = pullResponse.nextCursor || currentCursor;
          if (nextCursor === currentCursor && (pullResponse.hasMore || (pullResponse.changes?.length || 0) > 0)) {
            throw new Error("Server returned pull changes without cursor progress");
          }
          if (nextCursor !== currentCursor) {
            SyncRepository.setServerCursor(centerId, nextCursor);
            currentCursor = nextCursor;
          }
          hasMore = Boolean(pullResponse.hasMore);
          batches += 1;
        }
      } catch (pullErr: any) {
        // Do not push while the local cursor is stale. Otherwise a device can
        // write changes based on an outdated snapshot and create avoidable
        // conflicts. The next connectivity retry will pull first.
        errors++;
        Logger.warn("sync", "pull_failed", {
          centerId,
          error:
            pullErr?.userMessage || pullErr?.message || JSON.stringify(pullErr),
        });
        this.currentState = "error";
        return {
          syncedCount,
          errors,
          conflicts,
          state: "error",
          arabicMessage: "فشل تحميل التغييرات من الخادم. سيتم إعادة المحاولة قبل إرسال العمليات المحلية.",
        };
      }

      // 5. Push Prioritized Local Operations
      const pendingOps = SyncRepository.getPendingOperations(
        centerId,
        batchSize,
      );

      if (pendingOps.length > 0) {
        for (const op of pendingOps) {
          SyncRepository.markAsSyncing(op.operationId);
        }

        const payloads: SyncOperationPayload[] = pendingOps.map((op) => ({
          operationId: op.operationId,
          centerId: op.centerId,
          userId: op.userId,
          deviceId: op.deviceId,
          operationType: op.operationType,
          entityType: op.entityType,
          entityId: op.entityId,
          payload:
            typeof op.payload === "string"
              ? JSON.parse(op.payload || "{}")
              : op.payload,
          createdAt: op.createdAt,
          retryCount: op.retryCount,
        }));

        try {
          const pushResponse = await this.adapter.pushOperations(
            centerId,
            payloads,
          );

          // Handle successfully synced operations
          for (const syncedId of pushResponse.syncedOperationIds) {
            SyncRepository.markAsSynced(syncedId);
            syncedCount++;
          }

          // Handle conflicts
          for (const conflict of pushResponse.conflicts) {
            const operation = pendingOps.find(
              (item) => item.operationId === conflict.operationId,
            );
            Logger.warn("sync", "operation_conflict", {
              centerId,
              operationId: conflict.operationId,
              entityType: conflict.entityType || operation?.entityType,
              metadata: {
                entityId: conflict.entityId || operation?.entityId,
                reason: conflict.reason,
                resolution: conflict.resolution,
              },
            });
            SyncRepository.markAsConflict(
              conflict.operationId,
              `تضارب مع الخادم: ${conflict.reason} (${conflict.resolution})`,
              { serverState: conflict.serverState, resolution: conflict.resolution },
            );
            conflicts++;
          }

          // Advance server cursor if returned
          if (pushResponse.serverCursor) {
            SyncRepository.setServerCursor(centerId, pushResponse.serverCursor);
          }
        } catch (pushErr: any) {
          for (const op of pendingOps) {
            SyncRepository.markAsFailed(
              op.operationId,
              pushErr?.message || "فشل إرسال الدفعة",
            );
            errors++;
          }
          throw pushErr;
        }
      }

      this.currentState = errors > 0 ? "error" : "online";
      const durationMs = Date.now() - startTime;
      Logger.info("sync", "sync_completed", {
        centerId,
        durationMs,
        metadata: { syncedCount, errors, conflicts },
      });

      return {
        syncedCount,
        errors,
        conflicts,
        state: this.currentState,
        arabicMessage: "تمت المزامنة بنجاح",
      };
    } catch (err: any) {
      this.currentState = "error";
      Logger.error("sync", "sync_failed", err, { centerId });
      return {
        syncedCount,
        errors: errors || 1,
        conflicts,
        state: "error",
        arabicMessage: err?.message || "فشل الاتصال بخادم المزامنة",
      };
    }
  }
}
