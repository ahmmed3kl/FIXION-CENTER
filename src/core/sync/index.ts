import { env } from "../../config/env";
import { SyncOperation, SyncOperationStatus } from "../../shared/types";
import {
  HttpSyncApiAdapter,
  ISyncApiAdapter,
  MockSyncApiAdapter,
  SyncOperationPayload,
} from "../api";
import { ConnectivityService } from "../connectivity";
import { DatabaseService } from "../database";
import { DeviceRepository } from "../device";
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
  if (e === "attendance" || e === "advance_coverage" || e === "makeup")
    return 2;
  if (e === "payment" || e === "payment_reversal" || e === "debt_adjustment")
    return 3;
  if (e === "session_closing" || e === "daily_closing") return 4;
  if (
    [
      "student",
      "student_card",
      "group",
      "teacher",
      "subject",
      "enrollment",
      "student_group_enrollment",
      "package",
      "package_subscription",
    ].includes(e)
  ) {
    return 5;
  }
  return 6;
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
       WHERE center_id = ? AND status = 'pending'`,
      [centerId],
    );

    // Sort by priority ASC, then createdAt ASC
    rows.sort((a, b) => {
      const pA = getOperationPriority(a.entityType);
      const pB = getOperationPriority(b.entityType);
      if (pA !== pB) return pA - pB;
      return a.createdAt.localeCompare(b.createdAt);
    });

    if (limit && limit > 0) {
      return rows.slice(0, limit);
    }
    return rows;
  }

  static getStats(centerId: string) {
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<{ status: SyncOperationStatus }>(
      "SELECT status FROM sync_operations WHERE center_id = ?",
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
      else if (r.status === "failed") failed++;
      else if (r.status === "conflict") conflict++;
    }

    return { pending, syncing, synced, failed, conflict, total: rows.length };
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
    db.runSync(
      `UPDATE sync_operations SET status = 'synced', synced_at = ? WHERE operation_id = ?`,
      [syncedAt, operationId],
    );
  }

  static markAsFailed(operationId: string, errorReason: string): void {
    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE sync_operations SET status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE operation_id = ?`,
      [errorReason, operationId],
    );
  }

  static markAsConflict(operationId: string, errorReason: string): void {
    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE sync_operations SET status = 'conflict', last_error = ? WHERE operation_id = ?`,
      [errorReason, operationId],
    );
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
}

export class SyncEngine {
  private static adapter: ISyncApiAdapter = env.enableMockData
    ? new MockSyncApiAdapter()
    : new HttpSyncApiAdapter();
  private static currentState: SyncEngineState = "online";

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

  /**
   * Calculates exponential backoff milliseconds for retry count.
   * delay = min(1000 * 2^retryCount, 60000)
   */
  static getBackoffDelayMs(retryCount: number): number {
    return Math.min(1000 * Math.pow(2, retryCount), 60000);
  }

  /**
   * Executes bidirectional synchronization for a center:
   * 1. Validates device status (inactive device halts sync).
   * 2. Checks network connectivity.
   * 3. Pulls new server changes using monotonic cursor.
   * 4. Batches and pushes pending local operations in priority order.
   * 5. Handles conflicts and retries with backoff gracefully.
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

    let syncedCount = 0;
    let errors = 0;
    let conflicts = 0;

    try {
      // 3. Pull Changes from Server with Monotonic Cursor
      const currentCursor = SyncRepository.getServerCursor(centerId);
      const pullResponse = await this.adapter.pullChanges(
        centerId,
        currentCursor,
        pullLimit,
      );

      if (
        pullResponse.nextCursor &&
        pullResponse.nextCursor !== currentCursor
      ) {
        SyncRepository.setServerCursor(centerId, pullResponse.nextCursor);
      }

      // 4. Push Prioritized Local Operations
      const pendingOps = SyncRepository.getPendingOperations(
        centerId,
        batchSize,
      );

      if (pendingOps.length > 0) {
        // Mark all as syncing
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
            SyncRepository.markAsConflict(
              conflict.operationId,
              `تضارب مع الخادم: ${conflict.reason} (${conflict.resolution})`,
            );
            conflicts++;
          }

          // Advance server cursor if returned
          if (pushResponse.serverCursor) {
            SyncRepository.setServerCursor(centerId, pushResponse.serverCursor);
          }
        } catch (pushErr: any) {
          // Push failed: mark each item as failed with backoff increment
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
