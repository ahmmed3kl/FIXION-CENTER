import { DatabaseService, SqlDatabase } from "../src/core/database";
import {
  SyncRepository,
  SyncEngine,
  SafeConflictRetryService,
  SAFE_RETRY_BACKOFF_SECONDS,
  MAX_SAFE_RETRIES,
} from "../src/core/sync";
import { ISyncApiAdapter } from "../src/core/api/SyncApiAdapter";

function createMockAdapter(overrides?: Partial<ISyncApiAdapter>): ISyncApiAdapter {
  return {
    pushOperations: async () =>
      ({
        success: true,
        syncedOperationIds: [],
        conflicts: [],
        failedOperationIds: [],
        serverCursor: "0",
        processedAt: new Date().toISOString(),
      }) as any,
    pullChanges: async () => ({} as any),
    bootstrapCenter: async () => ({} as any),
    ...overrides,
  };
}

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

  runSync(sql: string, ...parameters: any[]): { lastInsertRowId: number; changes: number } {
    const res = this.connection.prepare(sql).run(...this.flatten(parameters)) as any;
    return {
      lastInsertRowId: Number(res?.lastInsertRowid || 0),
      changes: Number(res?.changes || 0),
    };
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

  private flatten(params: any[]): any[] {
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0];
    }
    return params;
  }
}

describe("SafeConflictRetryService (Phase 2, Step 3)", () => {
  const centerId = "center-safe-test";
  const validUser = { id: "user-mgr-1", permissions: ["sync.manage"] };
  let db: RealSqliteDatabase;

  beforeEach(() => {
    db = new RealSqliteDatabase(":memory:");
    DatabaseService.setMockDb(db);
    SafeConflictRetryService.resetClaims();

    // Initialize minimum schema
    db.execSync(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE centers (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, center_id TEXT, username TEXT);
      CREATE TABLE groups (id TEXT PRIMARY KEY, center_id TEXT, name TEXT, teacher_id TEXT, status TEXT);
      CREATE TABLE group_schedules (id TEXT PRIMARY KEY, center_id TEXT, group_id TEXT, day_of_week INTEGER, start_time TEXT, end_time TEXT);
      CREATE TABLE students (id TEXT PRIMARY KEY, center_id TEXT, name TEXT, status TEXT);
      CREATE TABLE student_cards (id TEXT PRIMARY KEY, center_id TEXT, student_id TEXT, card_code TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, center_id TEXT, group_id TEXT, status TEXT, date TEXT);
      CREATE TABLE attendance (id TEXT PRIMARY KEY, center_id TEXT, student_id TEXT, session_id TEXT, status TEXT, attendance_type TEXT);
      CREATE TABLE notification_events (id TEXT PRIMARY KEY, center_id TEXT, event_type TEXT);
      CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, center_id TEXT, notification_event_id TEXT, provider TEXT, status TEXT);
      CREATE TABLE sync_operations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        center_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        synced_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at TEXT
      );
      CREATE TABLE sync_conflicts (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        center_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        local_payload TEXT,
        server_payload TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT,
        safe_retry_count INTEGER DEFAULT 0,
        last_safe_retry_at TEXT
      );
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        center_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT
      );
    `);

    db.runSync(
      `INSERT INTO centers (id, name) VALUES (?, ?)`,
      [centerId, "Center Safe Test"],
    );
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  // 1. Preservation of operation_id
  test("1. Preserves original operation_id and does NOT generate a new UUID or alias", async () => {
    const opId = "op-attendance-fixed-id-123";
    const sessionId = "sess-1";
    const studentId = "stud-1";

    // Setup parent entities so it's eligible
    db.runSync(`INSERT INTO sessions (id, center_id, status) VALUES (?, ?, ?)`, [sessionId, centerId, "completed"]);
    db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student One", "active"]);

    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-1", opId, centerId, "u-1", "dev-1", "CREATE", "attendance", "att-1", JSON.stringify({ sessionId, studentId }), "conflict", new Date().toISOString(), "ATTENDANCE_SESSION_NOT_FOUND"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-1", opId, centerId, "attendance", "att-1", "ATTENDANCE_SESSION_NOT_FOUND", new Date().toISOString()],
    );

    let pushedOperationId = "";
    const mockAdapter = createMockAdapter({
      pushOperations: async (cid, ops) => {
        pushedOperationId = ops[0].operationId;
        return {
          success: true,
          syncedOperationIds: [ops[0].operationId],
          conflicts: [],
          failedOperationIds: [],
          serverCursor: "0",
          processedAt: new Date().toISOString(),
        };
      },
    });
    SyncEngine.setAdapter(mockAdapter);

    const result = await SafeConflictRetryService.retryConflict({
      centerId,
      operationId: opId,
      user: validUser,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("synced");
    expect(pushedOperationId).toBe(opId); // STRICTLY EQUAL TO ORIGINAL ID!
  });

  // 2. Reject all 7 financial entity types
  test("2. Strictly rejects all 7 financial entity types from retry and claim", async () => {
    const financialTypes = [
      "payment",
      "payment_reversal",
      "debt_cycle",
      "debt_adjustment",
      "daily_closing",
      "advance_coverage",
      "payment_collected",
    ];

    for (const fType of financialTypes) {
      const opId = `op-fin-${fType}`;
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`row-${fType}`, opId, centerId, "u-1", "dev-1", "CREATE", fType, "e-1", "{}", "conflict", new Date().toISOString(), "some conflict error"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`conf-${fType}`, opId, centerId, fType, "e-1", "some conflict error", new Date().toISOString()],
      );

      const eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasonCode).toBe("FINANCIAL_PROTECTED");

      const claimed = SafeConflictRetryService.claimOperation(centerId, opId, validUser);
      expect(claimed).toBe(false);

      const result = await SafeConflictRetryService.retryConflict({
        centerId,
        operationId: opId,
        user: validUser,
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe("rejected");
      expect(result.reasonCode).toBe("FINANCIAL_PROTECTED");

      // Verify row status remained conflict
      const row = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [opId]);
      expect(row?.status).toBe("conflict");
    }
  });

  // 3. Reject STALE_UPDATE
  test("3. Strictly rejects STALE_UPDATE operations from retry", async () => {
    const opId = "op-stale-student";
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-stale", opId, centerId, "u-1", "dev-1", "UPDATE", "student", "st-1", "{}", "conflict", new Date().toISOString(), "STALE_UPDATE: newer version exists"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-stale", opId, centerId, "student", "st-1", "STALE_UPDATE: server version 5 > local version 3", new Date().toISOString()],
    );

    const eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCode).toBe("STALE_UPDATE");

    const result = await SafeConflictRetryService.retryConflict({
      centerId,
      operationId: opId,
      user: validUser,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe("rejected");
    expect(result.reasonCode).toBe("STALE_UPDATE");
  });

  // 4. Reject ambiguous_outcome SMS
  test("4. Strictly rejects SMS delivery operations with ambiguous_outcome", async () => {
    const opId = "op-sms-ambiguous";
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-sms", opId, centerId, "u-1", "dev-1", "CREATE", "notification_delivery", "del-1", "{}", "conflict", new Date().toISOString(), "timeout ambiguous_outcome"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-sms", opId, centerId, "notification_delivery", "del-1", "delivery ambiguous_outcome during sending", new Date().toISOString()],
    );

    const eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCode).toBe("SMS_AMBIGUOUS_OUTCOME");
  });

  // 5. Dependent operations: reject before parent arrives, allow after parent arrives
  test("5. Rejects dependent operation before parent arrives, allows retry once parent arrives", () => {
    const opId = "op-dep-card";
    const studentId = "student-missing-1";

    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-card", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-1", JSON.stringify({ studentId }), "conflict", new Date().toISOString(), "STUDENT_NOT_FOUND"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-card", opId, centerId, "student_card", "c-1", "STUDENT_NOT_FOUND", new Date().toISOString()],
    );

    // Before student arrives
    let eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCode).toBe("PARENT_NOT_ARRIVED");

    // Parent arrives via pull
    db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Arrived Student", "active"]);

    // After student arrives
    eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasonCode).toBe("ELIGIBLE_FOR_RETRY");
  });

  // 6. Schedule conflict: reject while conflict exists, allow after resolution
  test("6. Rejects group_schedule while time overlap exists, allows once conflict cleared", () => {
    const opId = "op-sched-overlap";
    const groupId = "grp-target";
    const schedId = "sch-target";

    db.runSync(`INSERT INTO groups (id, center_id, name, teacher_id, status) VALUES (?, ?, ?, ?, ?)`, [groupId, centerId, "Group Target", "t-1", "active"]);
    db.runSync(`INSERT INTO groups (id, center_id, name, teacher_id, status) VALUES (?, ?, ?, ?, ?)`, ["grp-other", centerId, "Group Other", "t-1", "active"]);
    // Existing active schedule for teacher t-1: Day 1 (Monday), 10:00 to 12:00
    db.runSync(`INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)`,
      ["sch-existing", centerId, "grp-other", 1, "10:00", "12:00"]
    );

    // Target schedule overlaps: Day 1, 11:00 to 13:00 for same teacher
    const payload = { groupId, dayOfWeek: 1, startTime: "11:00", endTime: "13:00", teacherId: "t-1" };

    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-sched", opId, centerId, "u-1", "dev-1", "CREATE", "group_schedule", schedId, JSON.stringify(payload), "conflict", new Date(Date.now() - 5000).toISOString(), "TEACHER_SCHEDULE_CONFLICT"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-sched", opId, centerId, "group_schedule", schedId, "TEACHER_SCHEDULE_CONFLICT", new Date(Date.now() - 5000).toISOString()],
    );

    // Simulate fresh pull performed after the conflict occurred
    SyncRepository.setLastFullSyncTime(centerId);

    // With overlap: rejected
    let eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCode).toBe("SCHEDULE_CONFLICT_STILL_EXISTS");

    // Resolve overlap by shifting existing schedule to 08:00 - 10:00
    db.runSync(`UPDATE group_schedules SET start_time = '08:00', end_time = '10:00' WHERE id = 'sch-existing'`);

    // Now conflict is cleared
    eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasonCode).toBe("ELIGIBLE_FOR_RETRY");
  });

  // 7. Atomic Claim prevents concurrent duplicate claims
  test("7. Atomic Claim prevents concurrent duplicate attempts on the same operation", () => {
    const opId = "op-claim-test";
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-claim", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-1", "{}", "conflict", new Date().toISOString(), "err"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-claim", opId, centerId, "student_card", "c-1", "err", new Date().toISOString()],
    );

    const firstClaim = SafeConflictRetryService.claimOperation(centerId, opId, validUser);
    expect(firstClaim).toBe(true);

    // Second claim fails
    const secondClaim = SafeConflictRetryService.claimOperation(centerId, opId, validUser);
    expect(secondClaim).toBe(false);

    // Eligibility check shows concurrent active
    const eligibility = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCode).toBe("CONCURRENT_ATTEMPT_ACTIVE");
  });

  // 8. Does not mark as synced without official server confirmation
  test("8. Does NOT mark operation as synced when server response fails or drops", async () => {
    const opId = "op-net-drop";
    const studentId = "st-net-drop";
    db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student Net", "active"]);

    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-drop", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-net", JSON.stringify({ studentId }), "conflict", new Date().toISOString(), "STUDENT_NOT_FOUND"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-drop", opId, centerId, "student_card", "c-net", "STUDENT_NOT_FOUND", new Date().toISOString()],
    );

    // Mock adapter throwing network exception
    const failingAdapter = createMockAdapter({
      pushOperations: async () => {
        throw new Error("Network request timed out");
      },
    });
    SyncEngine.setAdapter(failingAdapter);

    const result = await SafeConflictRetryService.retryConflict({
      centerId,
      operationId: opId,
      user: validUser,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");

    // Must NOT be marked as synced! Status must revert to conflict
    const row = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [opId]);
    expect(row?.status).toBe("conflict");

    const conf = db.getFirstSync<any>(`SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?`, [opId]);
    expect(conf?.resolved_at).toBeNull();
  });

  // 9. Center Isolation & Permissions
  test("9. Enforces permissions and center isolation", () => {
    const opId = "op-perm-test";
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-p", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-1", "{}", "conflict", new Date().toISOString(), "err"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-p", opId, centerId, "student_card", "c-1", "err", new Date().toISOString()],
    );

    // User without sync.manage permission
    const unprivilegedUser = { id: "user-read-only", permissions: ["students.view"] };
    const el1 = SafeConflictRetryService.evaluateEligibility(centerId, opId, unprivilegedUser);
    expect(el1.eligible).toBe(false);
    expect(el1.reasonCode).toBe("PERMISSION_DENIED");

    // Anonymous or unknown user ID
    const anonymousUser = { id: "unknown", permissions: ["sync.manage"] };
    const el2 = SafeConflictRetryService.evaluateEligibility(centerId, opId, anonymousUser);
    expect(el2.eligible).toBe(false);
    expect(el2.reasonCode).toBe("PERMISSION_DENIED");

    // Operation query for wrong center
    const el3 = SafeConflictRetryService.evaluateEligibility("different-center", opId, validUser);
    expect(el3.eligible).toBe(false);
    expect(el3.reasonCode).toBe("OPERATION_NOT_FOUND");
  });

  // 10. Backoff schedule & max 5 retries limit
  test("10. Respects backoff schedule and maximum 5 retries limit", () => {
    const opId = "op-backoff-test";
    const studentId = "st-backoff";
    db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student B", "active"]);

    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-b", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-b", JSON.stringify({ studentId }), "conflict", now, "err"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at, safe_retry_count, last_safe_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["conf-b", opId, centerId, "student_card", "c-b", "err", now, 1, now],
    );

    // Attempt 1 was just executed, backoff delay for attempt 1 is 120s -> backoff active
    const el1 = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(el1.eligible).toBe(false);
    expect(el1.reasonCode).toBe("BACKOFF_WAIT_ACTIVE");
    expect(el1.remainingDelaySeconds).toBeGreaterThan(0);

    // Set safe_retry_count = 5 (limit reached)
    db.runSync(
      `UPDATE sync_conflicts SET safe_retry_count = 5, last_safe_retry_at = '2026-01-01T00:00:00Z' WHERE operation_id = ?`,
      [opId],
    );
    const el2 = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
    expect(el2.eligible).toBe(false);
    expect(el2.reasonCode).toBe("MAX_RETRIES_EXCEEDED");
  });

  // 11. Single-operation retry does not affect other operations
  test("11. Single-operation retry does NOT affect or sync other conflicted operations in database", async () => {
    const op1 = "op-batch-1";
    const op2 = "op-batch-2";
    const studentId = "st-batch";
    db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Batch Student", "active"]);

    // op1
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-batch-1", op1, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-1", JSON.stringify({ studentId }), "conflict", new Date().toISOString(), "err"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-batch-1", op1, centerId, "student_card", "c-1", "err", new Date().toISOString()],
    );

    // op2
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["row-batch-2", op2, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-2", JSON.stringify({ studentId }), "conflict", new Date().toISOString(), "err"],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["conf-batch-2", op2, centerId, "student_card", "c-2", "err", new Date().toISOString()],
    );

    const adapter = createMockAdapter({
      pushOperations: async (cid, ops) => {
        // ops must contain ONLY op1
        expect(ops.length).toBe(1);
        expect(ops[0].operationId).toBe(op1);
        return {
          success: true,
          syncedOperationIds: [op1],
          conflicts: [],
          failedOperationIds: [],
          serverCursor: "0",
          processedAt: new Date().toISOString(),
        };
      },
    });
    SyncEngine.setAdapter(adapter);

    const result = await SafeConflictRetryService.retryConflict({
      centerId,
      operationId: op1,
      user: validUser,
    });

    expect(result.success).toBe(true);

    // op1 is synced
    const row1 = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [op1]);
    expect(row1?.status).toBe("synced");

    // op2 is UNTOUCHED (still conflict)
    const row2 = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [op2]);
    expect(row2?.status).toBe("conflict");
  });

  // 12. Lost server response idempotency
  test("12. Server idempotency: retrying with the same operation_id does NOT cause duplicate mutations", async () => {
    // Simulate backend SyncProcessor.processPush with an already applied operation
    const backendDb = require("../backend/src/db");
    const mockClient = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes("FROM centers WHERE id = $1")) {
          return { rows: [{ id: centerId, status: "active" }] };
        }
        if (sql.includes("FROM center_devices WHERE device_id = $1")) {
          return { rows: [{ device_id: "dev-idemp", center_id: centerId, status: "active" }] };
        }
        if (sql.includes("max_seq")) {
          return { rows: [{ max_seq: "10" }] };
        }
        if (sql.includes("FROM server_sync_operations") && sql.includes("operation_id = ANY")) {
          // Server already processed this operation previously!
          return {
            rows: [
              {
                operation_id: "op-idemp-attendance-1",
                server_seq: "10",
                status: "applied",
                center_id: centerId,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    const origWithTx = backendDb.withTransaction;
    backendDb.withTransaction = async (cb: any) => cb(mockClient);

    try {
      const payload = { studentId: "st-1", status: "present" };
      const operation = {
        operationId: "op-idemp-attendance-1",
        centerId,
        userId: "u-1",
        deviceId: "dev-idemp",
        operationType: "CREATE",
        entityType: "attendance",
        entityId: "att-idemp-1",
        payload,
      };

      const result = await SyncProcessor.processPush(
        centerId,
        "u-1",
        "dev-idemp",
        [operation],
      );

      // Server recognizes already_applied and returns syncedOperationIds without inserting duplicate!
      expect(result.syncedOperationIds).toContain("op-idemp-attendance-1");
      expect(result.conflicts).toHaveLength(0);

      // Verify no INSERT into attendance was executed
      const insertCalls = mockClient.query.mock.calls.filter((call: any[]) =>
        typeof call[0] === "string" && call[0].includes("INSERT INTO attendance"),
      );
      expect(insertCalls).toHaveLength(0);
    } finally {
      backendDb.withTransaction = origWithTx;
    }
  });

  describe("Step 3.2 Safety Corrections", () => {
    test("13. Crash recovery: recoverInterruptedOperations restores syncing open conflict to 'conflict' and never into getPendingOperations", () => {
      const opId = "op-interrupted-conflict";
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-ic", opId, centerId, "u-1", "dev-1", "CREATE", "attendance", "att-ic", "{}", "syncing", new Date().toISOString(), "[محاولة إعادة آمنة]"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at, safe_retry_count, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ["conf-ic", opId, centerId, "attendance", "att-ic", "ATTENDANCE_SESSION_NOT_FOUND", new Date().toISOString(), 1],
      );

      // Normal syncing operation (no conflict)
      const normalOpId = "op-interrupted-normal";
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-in", normalOpId, centerId, "u-1", "dev-1", "CREATE", "student", "st-in", "{}", "syncing", new Date().toISOString(), null],
      );

      // Run app recovery on startup
      SyncRepository.recoverInterruptedOperations(centerId);

      // The conflicted operation MUST revert to 'conflict'
      const conflictOpRow = db.getFirstSync<any>(`SELECT status, last_error FROM sync_operations WHERE operation_id = ?`, [opId]);
      expect(conflictOpRow?.status).toBe("conflict");
      expect(conflictOpRow?.last_error).toContain("تمت استعادة حالة التعارض بعد إعادة تشغيل التطبيق");

      // The normal operation MUST revert to 'pending'
      const normalOpRow = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [normalOpId]);
      expect(normalOpRow?.status).toBe("pending");

      // getPendingOperations must NOT include the conflicted operation
      const pendingOps = SyncRepository.getPendingOperations(centerId);
      const pendingIds = pendingOps.map((o) => o.operationId);
      expect(pendingIds).not.toContain(opId);
      expect(pendingIds).toContain(normalOpId);

      // Recovery is idempotent: running it again maintains the exact same safe state
      SyncRepository.recoverInterruptedOperations(centerId);
      const conflictOpRow2 = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [opId]);
      expect(conflictOpRow2?.status).toBe("conflict");
    });

    test("14. Sync lock ordering: rejects with CONCURRENT_ATTEMPT_ACTIVE when locked, without mutating SQLite row to syncing", async () => {
      const opId = "op-lock-order";
      const sessionId = "sess-lock";
      const studentId = "stud-lock";

      db.runSync(`INSERT INTO sessions (id, center_id, status) VALUES (?, ?, ?)`, [sessionId, centerId, "completed"]);
      db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student Lock", "active"]);

      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-lo", opId, centerId, "u-1", "dev-1", "CREATE", "attendance", "att-lo", JSON.stringify({ sessionId, studentId }), "conflict", new Date().toISOString(), "SESSION_NOT_FOUND"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["conf-lo", opId, centerId, "attendance", "att-lo", "SESSION_NOT_FOUND", new Date().toISOString()],
      );

      // Acquire withSyncLocks to simulate an active sync in progress
      let lockResolve!: () => void;
      const lockHeldPromise = new Promise<void>((res) => { lockResolve = res; });

      let retryResultPromise: Promise<any>;

      const backgroundLock = SyncEngine.withSyncLocks(centerId, async () => {
        // While lock is held, retry is attempted
        retryResultPromise = SafeConflictRetryService.retryConflict({
          centerId,
          operationId: opId,
          user: validUser,
        });
        await lockHeldPromise;
      });

      // Wait for retry attempt
      await new Promise((r) => setTimeout(r, 20));
      const result = await retryResultPromise!;

      expect(result.success).toBe(false);
      expect(result.status).toBe("rejected");
      expect(result.reasonCode).toBe("CONCURRENT_ATTEMPT_ACTIVE");

      // Verify row status remained strictly 'conflict' (NEVER changed to 'syncing')
      const row = db.getFirstSync<any>(`SELECT status FROM sync_operations WHERE operation_id = ?`, [opId]);
      expect(row?.status).toBe("conflict");

      // Release background lock
      lockResolve();
      await backgroundLock;
    });

    test("15. Backoff intervals: Attempt 1 immediate, Attempt 2 wait 30s, Attempt 3 wait 120s, Attempt 4 wait 300s, Attempt 5 wait 900s, Attempt 6 MAX_RETRIES_EXCEEDED", () => {
      const opId = "op-backoff-boundaries";
      const studentId = "st-bb";
      db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student BB", "active"]);

      const now = Date.now();
      const payload = JSON.stringify({ studentId });

      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-bb", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-bb", payload, "conflict", new Date().toISOString(), "err"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at, safe_retry_count, last_safe_retry_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        ["conf-bb", opId, centerId, "student_card", "c-bb", "err", new Date().toISOString()],
      );

      // Attempt 1: safe_retry_count = 0 -> immediate (0s wait)
      let el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(true);
      expect(el.reasonCode).toBe("ELIGIBLE_FOR_RETRY");

      // Attempt 2: safe_retry_count = 1 -> wait 30s
      // If 10s elapsed: backoff active
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 1, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 10 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("BACKOFF_WAIT_ACTIVE");
      expect(el.remainingDelaySeconds).toBe(20);

      // If 35s elapsed: allowed
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 1, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 35 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(true);

      // Attempt 3: safe_retry_count = 2 -> wait 120s
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 2, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 60 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("BACKOFF_WAIT_ACTIVE");
      expect(el.remainingDelaySeconds).toBe(60);

      // Attempt 4: safe_retry_count = 3 -> wait 300s
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 3, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 200 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("BACKOFF_WAIT_ACTIVE");
      expect(el.remainingDelaySeconds).toBe(100);

      // Attempt 5: safe_retry_count = 4 -> wait 900s
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 4, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 600 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("BACKOFF_WAIT_ACTIVE");
      expect(el.remainingDelaySeconds).toBe(300);

      // Attempt 6: safe_retry_count = 5 -> MAX_RETRIES_EXCEEDED
      db.runSync(
        `UPDATE sync_conflicts SET safe_retry_count = 5, last_safe_retry_at = ? WHERE operation_id = ?`,
        [new Date(now - 3600 * 1000).toISOString(), opId],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("MAX_RETRIES_EXCEEDED");
    });

    test("16. Failed claim does NOT increment safe_retry_count", () => {
      const opId = "op-failed-claim";
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-fc", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-fc", "{}", "pending", new Date().toISOString(), "err"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at, safe_retry_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        ["conf-fc", opId, centerId, "student_card", "c-fc", "err", new Date().toISOString()],
      );

      // Status is 'pending', not 'conflict' -> claim fails
      const claimed = SafeConflictRetryService.claimOperation(centerId, opId, validUser);
      expect(claimed).toBe(false);

      const conflictRow = db.getFirstSync<any>(`SELECT safe_retry_count FROM sync_conflicts WHERE operation_id = ?`, [opId]);
      expect(conflictRow?.safe_retry_count).toBe(0);
    });

    test("17. Strictly rejects duplicate conflict patterns with DUPLICATE_OR_UNRESOLVED_CONFLICT", () => {
      const duplicateReasons = [
        "DUPLICATE_CARD_CODE: 123456 already exists",
        "STUDENT_ALREADY_ENROLLED in this group",
        "UNIQUE constraint failed: student_cards.card_code",
        "DUPLICATE_ENTRY: student_code already in use",
      ];

      duplicateReasons.forEach((reason, idx) => {
        const opId = `op-dup-${idx}`;
        db.runSync(
          `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`row-${opId}`, opId, centerId, "u-1", "dev-1", "CREATE", "student_card", `c-dup-${idx}`, "{}", "conflict", new Date().toISOString(), reason],
        );
        db.runSync(
          `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`conf-${opId}`, opId, centerId, "student_card", `c-dup-${idx}`, reason, new Date().toISOString()],
        );

        const el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
        expect(el.eligible).toBe(false);
        expect(el.reasonCode).toBe("DUPLICATE_OR_UNRESOLVED_CONFLICT");
      });

      // Also verify that cross-center card violation is rejected as SECURITY_ISOLATION_VIOLATION
      const crossCenterOpId = "op-cross-center-card";
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-cc", crossCenterOpId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-cc", "{}", "conflict", new Date().toISOString(), "CARD_BELONGS_TO_OTHER_CENTER"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["conf-cc", crossCenterOpId, centerId, "student_card", "c-cc", "CARD_BELONGS_TO_OTHER_CENTER", new Date().toISOString()],
      );
      const ccEl = SafeConflictRetryService.evaluateEligibility(centerId, crossCenterOpId, validUser);
      expect(ccEl.eligible).toBe(false);
      expect(ccEl.reasonCode).toBe("SECURITY_ISOLATION_VIOLATION");
    });

    test("18. Strictly rejects dependent operations when parent operation is unconfirmed (pending/syncing/failed) on server", () => {
      const parentStudentId = "student-unconfirmed-1";
      const opId = "op-card-unconfirmed-parent";

      // Student exists in local SQLite table
      db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [parentStudentId, centerId, "Unconfirmed St", "active"]);

      // BUT parent student has an unconfirmed pending operation in sync_operations!
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-st-op", "op-student-create", centerId, "u-1", "dev-1", "CREATE", "student", parentStudentId, "{}", "pending", new Date().toISOString()],
      );

      // Student card operation referencing unconfirmed student
      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-card-op", opId, centerId, "u-1", "dev-1", "CREATE", "student_card", "c-unc", JSON.stringify({ studentId: parentStudentId }), "conflict", new Date().toISOString(), "STUDENT_NOT_FOUND"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["conf-card-op", opId, centerId, "student_card", "c-unc", "STUDENT_NOT_FOUND", new Date().toISOString()],
      );

      // Must be rejected with PARENT_UNCONFIRMED_ON_SERVER
      let el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("PARENT_UNCONFIRMED_ON_SERVER");

      // Once parent student is confirmed (status = 'synced')
      db.runSync(`UPDATE sync_operations SET status = 'synced' WHERE operation_id = 'op-student-create'`);
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(true);
      expect(el.reasonCode).toBe("ELIGIBLE_FOR_RETRY");
    });

    test("19. Strictly rejects attendance retry when session is cancelled", () => {
      const sessionId = "sess-cancelled";
      const studentId = "stud-sess-canc";
      const opId = "op-att-canc";

      db.runSync(`INSERT INTO sessions (id, center_id, status) VALUES (?, ?, ?)`, [sessionId, centerId, "cancelled"]);
      db.runSync(`INSERT INTO students (id, center_id, name, status) VALUES (?, ?, ?, ?)`, [studentId, centerId, "Student Canc", "active"]);

      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-canc", opId, centerId, "u-1", "dev-1", "CREATE", "attendance", "att-canc", JSON.stringify({ sessionId, studentId }), "conflict", new Date().toISOString(), "SESSION_CLOSED"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["conf-canc", opId, centerId, "attendance", "att-canc", "SESSION_CLOSED", new Date().toISOString()],
      );

      const el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("SESSION_CANCELLED");
    });

    test("20. Strictly rejects group_schedule when pull is missing or stale (PULL_REQUIRED_FOR_SCHEDULE)", () => {
      const opId = "op-sched-pull-check";
      const groupId = "grp-pull-check";
      const schedId = "sch-pull-check";

      // Group exists and is active
      db.runSync(`INSERT INTO groups (id, center_id, name, teacher_id, status) VALUES (?, ?, ?, ?, ?)`, [groupId, centerId, "Group Pull", "t-pull", "active"]);

      const payload = { groupId, dayOfWeek: 2, startTime: "14:00", endTime: "16:00", teacherId: "t-pull" };
      const conflictCreated = new Date().toISOString();

      db.runSync(
        `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["row-sp", opId, centerId, "u-1", "dev-1", "CREATE", "group_schedule", schedId, JSON.stringify(payload), "conflict", conflictCreated, "TEACHER_SCHEDULE_CONFLICT"],
      );
      db.runSync(
        `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["conf-sp", opId, centerId, "group_schedule", schedId, "TEACHER_SCHEDULE_CONFLICT", conflictCreated],
      );

      // No pull performed yet
      let el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("PULL_REQUIRED_FOR_SCHEDULE");

      // Pull performed 15 minutes ago (older than 10 min window -> stale)
      const stalePullTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      db.runSync(
        `INSERT OR REPLACE INTO sync_metadata (center_id, last_full_sync, bootstrap_count, total_syncs, updated_at)
         VALUES (?, ?, 1, 1, ?)`,
        [centerId, stalePullTime, stalePullTime],
      );
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(false);
      expect(el.reasonCode).toBe("PULL_REQUIRED_FOR_SCHEDULE");

      // Pull performed fresh right now
      SyncRepository.setLastFullSyncTime(centerId);
      el = SafeConflictRetryService.evaluateEligibility(centerId, opId, validUser);
      expect(el.eligible).toBe(true);
      expect(el.reasonCode).toBe("ELIGIBLE_FOR_RETRY");
    });
  });
});
