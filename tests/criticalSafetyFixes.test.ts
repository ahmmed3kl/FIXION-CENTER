import { DatabaseService, SqlDatabase } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";

const SyncProcessor = require("../backend/src/services/SyncProcessor");

interface NativeStatement {
  all(...parameters: any[]): unknown[];
  get(...parameters: any[]): unknown;
  run(...parameters: any[]): unknown;
}

interface NativeSqlite {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeSqliteConstructor {
  new (filename: string): NativeSqlite;
}

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: NativeSqliteConstructor;
};

class RealSqliteDatabase implements SqlDatabase {
  constructor(
    readonly filename: string,
    private readonly connection: NativeSqlite = new DatabaseSync(filename),
  ) {}

  execSync(sql: string): void {
    this.connection.exec(sql);
  }

  runSync(sql: string, ...parameters: any[]): unknown {
    return this.connection.prepare(sql).run(...this.flatten(parameters));
  }

  getAllSync<T = any>(sql: string, ...parameters: any[]): T[] {
    return this.connection.prepare(sql).all(...this.flatten(parameters)) as T[];
  }

  getFirstSync<T = any>(sql: string, ...parameters: any[]): T | null {
    return (
      (this.connection.prepare(sql).get(...this.flatten(parameters)) as
        | T
        | undefined) || null
    );
  }

  transactionSync<T>(callback: () => T): T {
    this.execSync("BEGIN");
    try {
      const result = callback();
      this.execSync("COMMIT");
      return result;
    } catch (error) {
      this.execSync("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  private flatten(parameters: any[]): any[] {
    if (parameters.length === 1 && Array.isArray(parameters[0])) {
      return parameters[0];
    }
    return parameters;
  }
}

describe("Critical Safety Fixes (Phase 2, Step 2.5)", () => {
  const FINANCIAL_TYPES = [
    "payment",
    "payment_reversal",
    "debt_cycle",
    "debt_adjustment",
    "daily_closing",
    "advance_coverage",
    "payment_collected",
  ];

  afterEach(() => {
    DatabaseService.reinitialize();
  });

  describe("Finding 1: InMemorySqliteMock WHERE & Parameter Accuracy", () => {
    beforeEach(() => {
      DatabaseService.reinitialize();
    });

    it("evaluates positional parameters correctly when SET clause has placeholders (STALE_UPDATE)", () => {
      const db = DatabaseService.getDb();
      const centerId = "center-mock-stale";

      // Seed 2 conflict operations: one with STALE_UPDATE, one with another error
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES (?, ?, 'u1', 'd1', 'UPDATE', 'student', 's1', '{}', 'conflict', 0, 'Server STALE_UPDATE detected', '2026-11-01T00:00:00Z')`,
        ["op-stale-1", centerId],
      );
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES (?, ?, 'u1', 'd1', 'UPDATE', 'student', 's2', '{}', 'conflict', 0, 'OTHER_ERROR', '2026-11-01T00:00:00Z')`,
        ["op-other-1", centerId],
      );

      const staleResolvedAt = "2026-11-01T02:00:00.000Z";
      // SQL has 1 placeholder in SET (? for synced_at) and 1 placeholder in WHERE (? for center_id)
      const res = db.runSync(
        `UPDATE sync_operations
         SET status = 'synced', synced_at = ?, next_retry_at = NULL,
             last_error = 'Superseded by server newer version'
         WHERE center_id = ? AND status = 'conflict'
           AND last_error LIKE '%STALE_UPDATE%'`,
        [staleResolvedAt, centerId],
      );

      expect((res as any)?.changes).toBe(1);

      // Verify op-stale-1 was updated with correct values
      const staleOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = ?",
        ["op-stale-1"],
      );
      expect(staleOp.status).toBe("synced");
      expect(staleOp.synced_at).toBe(staleResolvedAt);
      expect(staleOp.last_error).toBe("Superseded by server newer version");
      expect(staleOp.next_retry_at).toBeNull();

      // Verify op-other-1 was NOT updated
      const otherOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = ?",
        ["op-other-1"],
      );
      expect(otherOp.status).toBe("conflict");
      expect(otherOp.last_error).toBe("OTHER_ERROR");
    });

    it("InMemorySqliteMock respects all multi-clause filters (status, center_id, retry_count, whitelist, error pattern)", () => {
      const db = DatabaseService.getDb();
      const centerId = "center-mock-rules";

      // 1. Qualifying non-financial operation
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-qualify', ?, 'u1', 'd1', 'UPDATE', 'teacher', 't1', '{}', 'conflict', 2, 'column notes does not exist', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      // 2. Financial operation with same error -> MUST NOT be updated
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-fin', ?, 'u1', 'd1', 'CREATE', 'payment', 'p1', '{}', 'conflict', 0, 'column notes does not exist', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      // 3. Retry count >= 10 -> MUST NOT be updated
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-retry-exceeded', ?, 'u1', 'd1', 'UPDATE', 'teacher', 't2', '{}', 'conflict', 10, 'column notes does not exist', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      // 4. Other center -> MUST NOT be updated
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-other-center', 'other-center', 'u1', 'd1', 'UPDATE', 'teacher', 't3', '{}', 'conflict', 0, 'column notes does not exist', '2026-11-01T00:00:00Z')`,
      );

      // 5. Unrecoverable error -> MUST NOT be updated
      db.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-unrecoverable', ?, 'u1', 'd1', 'UPDATE', 'teacher', 't4', '{}', 'conflict', 0, 'FATAL_DATABASE_CORRUPTION', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      const requeuedCount = SyncRepository.requeueRecoverableConflicts(centerId);
      expect(requeuedCount).toBe(1);

      // Check results
      const qualifyOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = 'op-qualify'",
      );
      expect(qualifyOp.status).toBe("pending");
      expect(qualifyOp.retry_count).toBe(3);
      expect(qualifyOp.last_error).toBeNull();

      const finOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = 'op-fin'",
      );
      expect(finOp.status).toBe("conflict");
      expect(finOp.retry_count).toBe(0);

      const retryExceededOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = 'op-retry-exceeded'",
      );
      expect(retryExceededOp.status).toBe("conflict");
      expect(retryExceededOp.retry_count).toBe(10);

      const otherCenterOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = 'op-other-center'",
      );
      expect(otherCenterOp.status).toBe("conflict");

      const unrecoverableOp = db.getFirstSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = 'op-unrecoverable'",
      );
      expect(unrecoverableOp.status).toBe("conflict");
    });
  });

  describe("Finding 2: Financial Operations Immunity in requeueRecoverableConflicts", () => {
    it("all 7 financial entity types are strictly excluded from re-queuing in native SQLite", () => {
      const realDb = new RealSqliteDatabase(":memory:");
      DatabaseService.runMigrations(realDb);
      DatabaseService.setMockDb(realDb);

      const centerId = "center-fin-native";

      // Seed all 7 financial entity types with recoverable-like errors
      FINANCIAL_TYPES.forEach((entityType, index) => {
        realDb.runSync(
          `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
           VALUES (?, ?, 'u1', 'd1', 'CREATE', ?, ?, '{}', 'conflict', 0, 'column amount does not exist', '2026-11-01T00:00:00Z')`,
          [`op-fin-${index}`, centerId, entityType, `id-${index}`],
        );
      });

      // Also seed a non-financial recoverable operation
      realDb.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-non-fin', ?, 'u1', 'd1', 'UPDATE', 'group', 'g1', '{}', 'conflict', 0, 'column max_selections does not exist', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      const repaired = SyncRepository.requeueRecoverableConflicts(centerId);
      expect(repaired).toBe(1);

      // Verify each financial type remained conflict
      FINANCIAL_TYPES.forEach((entityType, index) => {
        const row = realDb.getFirstSync<any>(
          "SELECT status, retry_count FROM sync_operations WHERE operation_id = ?",
          [`op-fin-${index}`],
        );
        expect(row.status).toBe("conflict");
        expect(row.retry_count).toBe(0);
      });

      // Verify the non-financial group operation was re-queued
      const groupRow = realDb.getFirstSync<any>(
        "SELECT status, retry_count FROM sync_operations WHERE operation_id = 'op-non-fin'",
      );
      expect(groupRow.status).toBe("pending");
      expect(groupRow.retry_count).toBe(1);

      realDb.close();
    });

    it("STALE_UPDATE is not turned back to pending by requeueRecoverableConflicts", () => {
      const realDb = new RealSqliteDatabase(":memory:");
      DatabaseService.runMigrations(realDb);
      DatabaseService.setMockDb(realDb);

      const centerId = "center-stale-native";

      realDb.runSync(
        `INSERT INTO sync_operations (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
         VALUES ('op-stale-concurrency', ?, 'u1', 'd1', 'UPDATE', 'student', 's1', '{}', 'conflict', 1, 'STALE_UPDATE concurrency conflict', '2026-11-01T00:00:00Z')`,
        [centerId],
      );

      SyncRepository.requeueRecoverableConflicts(centerId);

      const opRow = realDb.getFirstSync<any>(
        "SELECT status, last_error, synced_at FROM sync_operations WHERE operation_id = 'op-stale-concurrency'",
      );
      // STALE_UPDATE must be retired as synced (superseded), NOT pending!
      expect(opRow.status).toBe("synced");
      expect(opRow.last_error).toBe("Superseded by server newer version");
      expect(opRow.synced_at).toBeTruthy();

      realDb.close();
    });
  });

const backendDb = require("../backend/src/db");

  describe("Finding 3: Prevent Re-dispatch of Already-Applied SMS", () => {
    let originalWithTransaction: any;

    beforeEach(() => {
      originalWithTransaction = backendDb.withTransaction;
    });

    afterEach(() => {
      backendDb.withTransaction = originalWithTransaction;
    });

    it("does NOT push already_applied notification_delivery into pendingSmsDeliveryIds", async () => {
      const dispatchedDeliveries: string[] = [];
      const originalDispatch = SyncProcessor.dispatchPendingSmsDeliveries;

      // Spy on dispatchPendingSmsDeliveries
      SyncProcessor.dispatchPendingSmsDeliveries = jest.fn(
        async (_centerId: string, deliveryIds: string[]) => {
          dispatchedDeliveries.push(...deliveryIds);
        },
      );

      const mockClient = {
        query: jest.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes("pg_advisory_xact_lock")) {
            return { rows: [] };
          }
          if (sql.includes("MAX(server_seq)")) {
            return { rows: [{ max_seq: "50" }] };
          }
          if (sql.includes("FROM server_sync_operations")) {
            // Simulate operation already applied on server
            return {
              rows: [
                {
                  operation_id: "op-sms-already-applied-101",
                  server_seq: "50",
                  status: "applied",
                  center_id: "center-sms-test",
                },
              ],
            };
          }
          if (sql.includes("SAVEPOINT")) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };

      backendDb.withTransaction = async (cb: any) => cb(mockClient);

      const operations = [
        {
          operationId: "op-sms-already-applied-101",
          centerId: "center-sms-test",
          entityType: "notification_delivery",
          entityId: "del-sms-101",
          operationType: "CREATE",
          payload: JSON.stringify({
            delivery: { id: "del-sms-101", phone: "01000000000" },
          }),
        },
      ];

      try {
        const result = await SyncProcessor.processPush(
          "center-sms-test",
          "user-test",
          "device-test",
          operations,
        );

        // Operation must be acknowledged in syncedOperationIds
        expect(result.syncedOperationIds).toContain(
          "op-sms-already-applied-101",
        );
        // But dispatchPendingSmsDeliveries must NOT have been called for this already_applied delivery
        expect(SyncProcessor.dispatchPendingSmsDeliveries).not.toHaveBeenCalled();
        expect(dispatchedDeliveries).toHaveLength(0);
      } finally {
        SyncProcessor.dispatchPendingSmsDeliveries = originalDispatch;
      }
    });

    it("dispatches SMS for newly applied notification_delivery mutations", async () => {
      const dispatchedDeliveries: string[] = [];
      const originalDispatch = SyncProcessor.dispatchPendingSmsDeliveries;

      SyncProcessor.dispatchPendingSmsDeliveries = jest.fn(
        async (_centerId: string, deliveryIds: string[]) => {
          dispatchedDeliveries.push(...deliveryIds);
        },
      );

      const mockClient = {
        query: jest.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes("pg_advisory_xact_lock")) {
            return { rows: [] };
          }
          if (sql.includes("MAX(server_seq)")) {
            return { rows: [{ max_seq: "50" }] };
          }
          if (sql.includes("FROM server_sync_operations")) {
            // Not yet applied
            return { rows: [] };
          }
          if (sql.includes("nextval('server_sync_seq')")) {
            return { rows: [{ nextval: "51" }] };
          }
          if (sql.includes("INSERT INTO server_sync_operations")) {
            return { rows: [{ server_seq: "51" }] };
          }
          if (sql.includes("SAVEPOINT") || sql.includes("RELEASE")) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };

      backendDb.withTransaction = async (cb: any) => cb(mockClient);

      // Mock applyDomainMutation to set queuedSmsDeliveryId for newly applied delivery
      const originalApplyDomain = SyncProcessor.applyDomainMutation;
      SyncProcessor.applyDomainMutation = jest.fn(
        async (client: any, mutationContext: any) => {
          mutationContext.queuedSmsDeliveryId = "del-new-202";
        },
      );

      const operations = [
        {
          operationId: "op-sms-new-202",
          centerId: "center-sms-test",
          entityType: "notification_delivery",
          entityId: "del-new-202",
          operationType: "CREATE",
          payload: JSON.stringify({
            delivery: { id: "del-new-202", phone: "01000000000" },
          }),
        },
      ];

      try {
        const result = await SyncProcessor.processPush(
          "center-sms-test",
          "user-test",
          "device-test",
          operations,
        );

        expect(result.syncedOperationIds).toContain("op-sms-new-202");
        expect(SyncProcessor.dispatchPendingSmsDeliveries).toHaveBeenCalledWith(
          "center-sms-test",
          ["del-new-202"],
        );
        expect(dispatchedDeliveries).toEqual(["del-new-202"]);
      } finally {
        SyncProcessor.dispatchPendingSmsDeliveries = originalDispatch;
        SyncProcessor.applyDomainMutation = originalApplyDomain;
      }
    });
  });
});
