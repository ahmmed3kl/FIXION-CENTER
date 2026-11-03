import { DatabaseService, SqlDatabase } from "../src/core/database";
import {
  SyncEngine,
  SyncRepository,
  isRetryableDependencyConflict,
} from "../src/core/sync";
import { MockSyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import { ConnectivityService } from "../src/core/connectivity";
import {
  PushSyncResponse,
  SyncOperationPayload,
} from "../src/core/api/contracts";

const db = require("../backend/src/db");
const SyncProcessor = require("../backend/src/services/SyncProcessor");
const zadxSmsProvider = require("../backend/src/services/zadxSmsProvider");

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

  close(): void {
    this.connection.close();
  }

  private flatten(parameters: any[]): any[] {
    return parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0]
      : parameters;
  }
}

interface ServerMockState {
  centerId: string;
  maxSeq: number;
  serverSyncOperations: Map<
    string,
    {
      operation_id: string;
      server_seq: number;
      status: string;
      center_id: string;
    }
  >;
  payments: Map<string, any>;
  attendance: Map<string, any>;
  students: Map<string, any>;
  sessions: Map<string, any>;
  debtCycles: Map<string, any>;
  notificationDeliveries: Map<string, any>;
  auditLogs: any[];
  queries: Array<{ sql: string; params: any[] }>;
}

function createServerMockClient(state: ServerMockState) {
  return {
    state,
    query: async (sql: string, params: any[] = []) => {
      const q = sql.replace(/\s+/g, " ").trim();
      state.queries.push({ sql: q, params });

      if (q.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (q.includes("SAVEPOINT") || q.includes("ROLLBACK TO SAVEPOINT")) {
        return { rows: [] };
      }
      if (q.includes("SELECT COALESCE(MAX(server_seq)")) {
        return { rows: [{ max_seq: state.maxSeq }] };
      }

      // server_sync_operations lookup
      if (q.includes("FROM server_sync_operations WHERE operation_id = ANY")) {
        const opIds = params[0] || [];
        const rows: any[] = [];
        for (const opId of opIds) {
          const found = state.serverSyncOperations.get(String(opId));
          if (found) rows.push(found);
        }
        return { rows };
      }

      // server_sync_operations insertion
      if (q.includes("INSERT INTO server_sync_operations")) {
        state.maxSeq += 1;
        const opId = String(params[4]);
        const record = {
          operation_id: opId,
          server_seq: state.maxSeq,
          status: params[10],
          center_id: params[1],
        };
        state.serverSyncOperations.set(opId, record);
        return { rows: [{ server_seq: state.maxSeq }] };
      }

      if (q.includes("INSERT INTO audit_logs")) {
        state.auditLogs.push(params);
        return { rows: [] };
      }

      if (q.includes("INSERT INTO sync_checkpoints")) {
        return { rows: [] };
      }

      // Students
      if (q.includes("FROM students") && q.includes("FOR UPDATE")) {
        const student = state.students.get(String(params[1]));
        return { rows: student ? [student] : [] };
      }
      if (q.includes("IS NOT DISTINCT FROM") && q.includes("FROM students")) {
        const student = state.students.get(String(params[1]));
        const baseUpdatedAt = params[2];
        const matches =
          student &&
          new Date(student.updated_at).getTime() ===
            new Date(baseUpdatedAt).getTime();
        return { rows: [{ matches: Boolean(matches) }] };
      }
      if (q.includes("FROM students") && q.includes("deleted_at IS NULL")) {
        const student = state.students.get(String(params[1]));
        return { rows: student ? [{ center_id: student.center_id }] : [] };
      }
      if (q.includes("FROM students WHERE center_id = $1 AND id = $2")) {
        const student = state.students.get(String(params[1]));
        return { rows: student ? [student] : [] };
      }

      // Debt Cycles
      if (q.includes("FROM debt_cycles WHERE center_id = $1 AND id = $2")) {
        const cycle = state.debtCycles.get(String(params[1]));
        return { rows: cycle ? [cycle] : [] };
      }

      // Sessions - complex join for attendance
      if (q.includes("FROM sessions s") && q.includes("LEFT JOIN groups g")) {
        const sessionId = String(params[1]);
        const session = state.sessions.get(sessionId);
        if (session) {
          return {
            rows: [
              {
                id: session.id,
                session_date: session.session_date || "2026-10-15",
                start_time: session.start_time || "14:00:00",
                group_id: session.group_id || "grp-1",
                schedule_id: session.schedule_id || "sched-1",
                subject_id: session.subject_id || "sub-1",
                teacher_id: session.teacher_id || "tea-1",
                status: session.status || "open",
                updated_at: session.updated_at || new Date().toISOString(),
                validated_group_id: session.group_id || "grp-1",
                group_grade: session.grade || "Grade 8",
                group_subject_id: session.subject_id || "sub-1",
                group_teacher_id: session.teacher_id || "tea-1",
              },
            ],
          };
        }
        return { rows: [] };
      }

      // Simple session query
      if (q.includes("FROM sessions WHERE center_id = $1 AND id = $2")) {
        const session = state.sessions.get(String(params[1]));
        return { rows: session ? [session] : [] };
      }
      if (q.includes("FROM session_id_aliases")) {
        return { rows: [] };
      }
      if (q.includes("FROM session_expected_students")) {
        return { rows: [{ "?column?": 1 }] };
      }

      // Payments
      if (q.includes("INSERT INTO payments")) {
        const payId = params[0];
        const payRecord = {
          id: payId,
          operation_id: params[1],
          student_id: params[4],
          amount: params[7],
        };
        state.payments.set(payId, payRecord);
        return { rows: [payRecord] };
      }

      // Attendance
      if (q.includes("FROM attendance WHERE center_id = $1 AND id = $2")) {
        const att = state.attendance.get(String(params[1]));
        return { rows: att ? [att] : [] };
      }
      if (q.includes("FROM attendance") && q.includes("session_id")) {
        const attId = String(params[1]);
        const att = state.attendance.get(attId);
        return { rows: att ? [att] : [] };
      }
      if (q.includes("INSERT INTO attendance")) {
        const attId = params[0];
        const attRecord = {
          id: attId,
          operation_id: params[1],
          session_id: params[3],
          student_id: params[4],
          status: params[5],
        };
        state.attendance.set(attId, attRecord);
        return { rows: [attRecord] };
      }

      // SMS deliveries candidate sweep
      if (
        q.includes("FROM notification_deliveries") &&
        q.includes("status = 'queued'")
      ) {
        const candidates: any[] = [];
        for (const [, d] of state.notificationDeliveries) {
          if (d.status === "queued") {
            const payload =
              typeof d.response_payload === "string"
                ? JSON.parse(d.response_payload)
                : d.response_payload;
            if (
              payload.dispatchState === "pending" ||
              payload.dispatchState === "retry_scheduled"
            ) {
              candidates.push(d);
            }
          }
        }
        return { rows: candidates };
      }

      // SMS claim query
      if (
        q.includes("UPDATE notification_deliveries") &&
        q.includes("dispatchState', 'sending'")
      ) {
        const id = params[1];
        const d = state.notificationDeliveries.get(id);
        if (d && d.status === "queued") {
          const payload =
            typeof d.response_payload === "string"
              ? JSON.parse(d.response_payload)
              : d.response_payload;
          if (
            payload.dispatchState === "pending" ||
            payload.dispatchState === "retry_scheduled"
          ) {
            payload.dispatchState = "sending";
            payload.claimToken = params[2];
            d.response_payload = JSON.stringify(payload);
            return { rows: [d] };
          }
        }
        return { rows: [] };
      }

      // Center services
      if (
        q.includes(
          "FROM center_services WHERE center_id = $1 AND service_key = 'sms'",
        )
      ) {
        return { rows: [{ enabled: true }] };
      }

      // Notification events
      if (q.includes("FROM notification_events")) {
        return { rows: [{ recipient_phone: "01000000000" }] };
      }

      // Finalize SMS delivery
      if (
        q.includes("UPDATE notification_deliveries") &&
        q.includes("response_payload = $4::jsonb")
      ) {
        const id = params[4];
        const d = state.notificationDeliveries.get(id);
        if (d) {
          d.status = params[0];
          d.retry_count = params[1];
          d.provider_message_id = params[2];
          d.response_payload = params[3];
          return { rows: [d] };
        }
        return { rows: [] };
      }

      return { rows: [], rowCount: 1 };
    },
  };
}

describe("Phase 2, Step 2: Safe Conflict Retry & Recovery Tests", () => {
  const centerId = "center-safe-retry";
  const otherCenterId = "center-other-retry";
  const originalWithTransaction = db.withTransaction;
  const originalDbQuery = db.query;
  let activeRealDb: RealSqliteDatabase;

  beforeEach(() => {
    activeRealDb = new RealSqliteDatabase(":memory:");
    DatabaseService.runMigrations(activeRealDb);
    activeRealDb.execSync(`
      CREATE TABLE IF NOT EXISTS center_academic_stages (
        center_id TEXT PRIMARY KEY,
        stages_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    activeRealDb.runSync(
      `INSERT OR REPLACE INTO sync_cursors (center_id, server_cursor, updated_at)
       VALUES (?, '100', ?)`,
      [centerId, new Date().toISOString()],
    );
    DatabaseService.setMockDb(activeRealDb);

    // Clean test tables
    activeRealDb.runSync(
      "DELETE FROM sync_operations WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM sync_conflicts WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM audit_logs WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM students WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM sessions WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM attendance WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM payments WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
    activeRealDb.runSync(
      "DELETE FROM debt_cycles WHERE center_id IN (?, ?)",
      [centerId, otherCenterId],
    );
  });

  afterEach(() => {
    db.withTransaction = originalWithTransaction;
    db.query = originalDbQuery;
    if (activeRealDb) {
      activeRealDb.close();
    }
    jest.restoreAllMocks();
  });

  // =========================================================================
  // Category A: ثبات معرّف العملية (Operation ID Invariance)
  // =========================================================================
  describe("Category A: ثبات معرّف العملية (Operation ID Invariance)", () => {
    test("A1. إعادة استخدام نفس operation_id تعيد السجل القائم دون توليد معرّف جديد أو تكرار الصفوف محلياً", () => {
      const operationId = "op-inv-fixed-101";
      const localDb = DatabaseService.getDb();

      // First enqueue
      const op1 = SyncRepository.enqueueOperation({
        centerId,
        userId: "user-1",
        deviceId: "dev-1",
        operationType: "UPDATE",
        entityType: "student",
        entityId: "std-101",
        payload: { name: "عمر خالد" },
        operationId,
      });

      expect(op1.operationId).toBe(operationId);

      // Second enqueue with the same operationId (simulating retry enqueue)
      const op2 = SyncRepository.enqueueOperation({
        centerId,
        userId: "user-1",
        deviceId: "dev-1",
        operationType: "UPDATE",
        entityType: "student",
        entityId: "std-101",
        payload: { name: "عمر خالد" },
        operationId,
      });

      expect(op2.operationId).toBe(operationId);
      expect(op2.id).toBe(op1.id);

      const rows = localDb.getAllSync<any>(
        "SELECT * FROM sync_operations WHERE operation_id = ?",
        [operationId],
      );
      expect(rows.length).toBe(1);
    });

    test("A2. إثبات أن إعادة إنشاء العملية بمعرّف جديد يُنتج عملية مكررة تنافسية تكسر الـ Idempotency", () => {
      const localDb = DatabaseService.getDb();

      const opOriginal = SyncRepository.enqueueOperation({
        centerId,
        userId: "user-1",
        deviceId: "dev-1",
        operationType: "UPDATE",
        entityType: "student",
        entityId: "std-102",
        payload: { name: "يوسف علي" },
        operationId: "op-original-102",
      });

      // Flawed retry: generating a new operationId for the same mutation
      const opFlawedRetry = SyncRepository.enqueueOperation({
        centerId,
        userId: "user-1",
        deviceId: "dev-1",
        operationType: "UPDATE",
        entityType: "student",
        entityId: "std-102",
        payload: { name: "يوسف علي" },
        operationId: "op-flawed-retry-102",
      });

      expect(opOriginal.operationId).not.toBe(opFlawedRetry.operationId);
      const rows = localDb.getAllSync<any>(
        "SELECT * FROM sync_operations WHERE entity_id = 'std-102'",
      );
      // Two distinct operations now compete in the queue
      expect(rows.length).toBe(2);
    });

    test("A3. تعامل السيرفر مع العملية باعتبارها already_applied عند إعادة إرسال نفس المعرّف دون إعادة تطبيقها", async () => {
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 20,
        serverSyncOperations: new Map([
          [
            "op-server-applied-1",
            {
              operation_id: "op-server-applied-1",
              server_seq: 14,
              status: "applied",
              center_id: centerId,
            },
          ],
        ]),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.withTransaction = async (cb: any) => cb(serverClient);

      const pushResult = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: "op-server-applied-1",
            operationType: "UPDATE",
            entityType: "student",
            entityId: "std-1",
            payload: { name: "Ahmed" },
          },
        ],
      );

      expect(pushResult.success).toBe(true);
      expect(pushResult.syncedOperationIds).toContain("op-server-applied-1");
      expect(pushResult.conflicts.length).toBe(0);

      // Verify server did not execute duplicate savepoints or inserts
      const insertOps = serverState.queries.filter((q) =>
        q.sql.includes("INSERT INTO server_sync_operations"),
      );
      expect(insertOps.length).toBe(0);
    });
  });

  // =========================================================================
  // Category B: منع تكرار العمليات المالية (Zero Duplicate Financial Operations)
  // =========================================================================
  describe("Category B: منع تكرار العمليات المالية (Zero Duplicate Financial Operations)", () => {
    test("B1. محاكاة قبول الدفع على السيرفر وانقطاع الرد: إعادة إرسال نفس المعرّف لا تُنشئ سجل دفع ثانٍ", async () => {
      const paymentOpId = "op-payment-idempotent-201";
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 5,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.withTransaction = async (cb: any) => cb(serverClient);

      // First attempt: Server accepts payment
      const res1 = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: paymentOpId,
            operationType: "CREATE",
            entityType: "payment",
            entityId: "pay-rec-1",
            payload: {
              id: "pay-rec-1",
              studentId: "std-fin-1",
              amount: 500,
              paymentType: "installment",
            },
          },
        ],
      );

      expect(res1.syncedOperationIds).toContain(paymentOpId);
      expect(serverState.payments.size).toBe(1);

      // Network disconnect simulation: Client re-sends the exact same operationId
      const res2 = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: paymentOpId,
            operationType: "CREATE",
            entityType: "payment",
            entityId: "pay-rec-1",
            payload: {
              id: "pay-rec-1",
              studentId: "std-fin-1",
              amount: 500,
              paymentType: "installment",
            },
          },
        ],
      );

      expect(res2.syncedOperationIds).toContain(paymentOpId);
      // Absolute guarantee: payments count on server remains strictly 1
      expect(serverState.payments.size).toBe(1);
    });

    test("B2. إثبات أن إعادة إرسال الدفع بمعرّف جديد تُنشئ سجلاً مالياً مكرراً (مخاطر توليد معرّف جديد)", async () => {
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 5,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.withTransaction = async (cb: any) => cb(serverClient);

      // First attempt: Server accepts payment with ID 1
      await SyncProcessor.processPush(centerId, "user-1", "dev-1", [
        {
          operationId: "op-pay-first-attempt",
          operationType: "CREATE",
          entityType: "payment",
          entityId: "pay-rec-1",
          payload: {
            id: "pay-rec-1",
            studentId: "std-fin-1",
            amount: 500,
          },
        },
      ]);
      expect(serverState.payments.size).toBe(1);

      // Unsafe retry: generating new operationId
      await SyncProcessor.processPush(centerId, "user-1", "dev-1", [
        {
          operationId: "op-pay-second-attempt-duplicate",
          operationType: "CREATE",
          entityType: "payment",
          entityId: "pay-rec-2",
          payload: {
            id: "pay-rec-2",
            studentId: "std-fin-1",
            amount: 500,
          },
        },
      ]);

      // Server treated it as a second transaction! This proves why operationId invariance is mandatory
      expect(serverState.payments.size).toBe(2);
    });

    test("B3. العزل المالي التام: استبعاد جميع الأنواع المالية الـ 7 في حالة conflict من getPendingOperations", () => {
      const localDb = DatabaseService.getDb();
      const now = new Date().toISOString();

      const financialTypes = [
        "payment",
        "payment_reversal",
        "debt_cycle",
        "debt_adjustment",
        "daily_closing",
        "advance_coverage",
        "payment_collected",
      ];

      financialTypes.forEach((fType, idx) => {
        localDb.runSync(
          `INSERT INTO sync_operations (
             id, operation_id, center_id, user_id, device_id,
             operation_type, entity_type, entity_id, payload,
             status, created_at, last_error
           ) VALUES (?, ?, ?, 'user-1', 'dev-1', 'CREATE', ?, ?, '{}', 'conflict', ?, 'financial error')`,
          [`op-row-fin-${idx}`, `op-fin-${fType}`, centerId, fType, `ent-fin-${idx}`, now],
        );

        localDb.runSync(
          `INSERT INTO sync_conflicts (
             id, operation_id, center_id, entity_type, entity_id,
             reason, local_payload, server_payload, created_at
           ) VALUES (?, ?, ?, ?, ?, 'financial conflict', '{}', NULL, ?)`,
          [`conf-fin-${idx}`, `op-fin-${fType}`, centerId, fType, `ent-fin-${idx}`, now],
        );
      });

      // Add one normal pending non-financial operation
      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at
         ) VALUES ('op-row-std', 'op-std-pending', ?, 'user-1', 'dev-1', 'CREATE', 'student', 'std-1', '{}', 'pending', ?)`,
        [centerId, now],
      );

      const pendingOps = SyncRepository.getPendingOperations(centerId);

      // Only the normal student operation is returned
      expect(pendingOps.length).toBe(1);
      expect(pendingOps[0].operationId).toBe("op-std-pending");

      // Verify NONE of the 7 financial conflicts are returned in pending queue
      for (const fType of financialTypes) {
        expect(pendingOps.some((op) => op.entityType === fType)).toBe(false);
      }
    });

    test("B4. حصانة التعارضات المالية ضد requeueRecoverableConflicts (عدم تحويلها لـ pending أو synced)", () => {
      const localDb = DatabaseService.getDb();
      const now = new Date().toISOString();

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, last_error
         ) VALUES ('op-pay-rec', 'op-pay-conflict-test', ?, 'user-1', 'dev-1', 'CREATE', 'payment', 'p-1', '{}', 'conflict', ?, 'financial error')`,
        [centerId, now],
      );
      localDb.runSync(
        `INSERT INTO sync_conflicts (
           id, operation_id, center_id, entity_type, entity_id,
           reason, local_payload, server_payload, created_at
         ) VALUES ('c-pay', 'op-pay-conflict-test', ?, 'payment', 'p-1', 'financial error', '{}', NULL, ?)`,
        [centerId, now],
      );

      SyncRepository.requeueRecoverableConflicts(centerId);

      const op = SyncRepository.getByOperationId("op-pay-conflict-test");
      expect(op?.status).toBe("conflict");

      const conf = localDb.getFirstSync<any>(
        "SELECT resolved_at FROM sync_conflicts WHERE operation_id = 'op-pay-conflict-test'",
      );
      expect(conf?.resolved_at).toBeNull();
    });
  });

  // =========================================================================
  // Category C: منع تكرار الحضور (Zero Duplicate Attendance)
  // =========================================================================
  describe("Category C: منع تكرار الحضور (Zero Duplicate Attendance)", () => {
    test("C1. محاكاة فقدان رد الحضور: إعادة إرسال نفس المعرّف لا تُنشئ حضوراً مكرراً ولا تُغير الحالة", async () => {
      const attendanceOpId = "op-attendance-idempotent-301";
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 8,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map([
          [
            "std-att-1",
            {
              id: "std-att-1",
              center_id: centerId,
              name: "طالب حضور",
              deleted_at: null,
            },
          ],
        ]),
        sessions: new Map([
          [
            "sess-att-1",
            {
              id: "sess-att-1",
              center_id: centerId,
              session_date: "2026-10-15",
              start_time: "14:00:00",
              group_id: "grp-1",
              schedule_id: "sched-1",
              subject_id: "sub-1",
              teacher_id: "tea-1",
              status: "open",
            },
          ],
        ]),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.withTransaction = async (cb: any) => cb(serverClient);

      // Attempt 1: Server processes attendance
      const res1 = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: attendanceOpId,
            operationType: "CREATE",
            entityType: "attendance",
            entityId: "att-rec-1",
            payload: {
              id: "att-rec-1",
              studentId: "std-att-1",
              sessionId: "sess-att-1",
              status: "present",
              isExternal: true,
            },
          },
        ],
      );

      expect(res1.syncedOperationIds).toContain(attendanceOpId);
      expect(serverState.attendance.size).toBe(1);

      // Attempt 2: Client timed out and resends exact same attendance operation
      const res2 = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: attendanceOpId,
            operationType: "CREATE",
            entityType: "attendance",
            entityId: "att-rec-1",
            payload: {
              id: "att-rec-1",
              studentId: "std-att-1",
              sessionId: "sess-att-1",
              status: "present",
              isExternal: true,
            },
          },
        ],
      );

      expect(res2.syncedOperationIds).toContain(attendanceOpId);
      // Still exactly 1 attendance row, zero duplicates
      expect(serverState.attendance.size).toBe(1);
    });
  });

  // =========================================================================
  // Category D: التحقق من العمليات التابعة (Dependent Operations Verification)
  // =========================================================================
  describe("Category D: التحقق من العمليات التابعة (Dependent Operations Verification)", () => {
    test("D1. التعرف على أخطاء غياب السجلات الأب كتعارضات تابعة قابلة لإعادة المحاولة (isRetryableDependencyConflict)", () => {
      expect(
        isRetryableDependencyConflict("ATTENDANCE_SESSION_NOT_FOUND"),
      ).toBe(true);
      expect(
        isRetryableDependencyConflict("ATTENDANCE_TARGET_NOT_FOUND"),
      ).toBe(true);
      expect(
        isRetryableDependencyConflict("SESSION_ACTIVATION_TARGET_NOT_FOUND"),
      ).toBe(true);
      expect(
        isRetryableDependencyConflict("PAYMENT_DEBT_CYCLE_NOT_FOUND"),
      ).toBe(true);
      expect(
        isRetryableDependencyConflict("PAYMENT_SESSION_NOT_FOUND"),
      ).toBe(true);
      expect(
        isRetryableDependencyConflict("attendance_session_id_fkey"),
      ).toBe(true);

      // Non-dependency errors are NOT retryable dependency conflicts
      expect(
        isRetryableDependencyConflict("TEACHER_SCHEDULE_CONFLICT"),
      ).toBe(false);
      expect(
        isRetryableDependencyConflict("STALE_UPDATE: newer version exists"),
      ).toBe(false);
      expect(
        isRetryableDependencyConflict("STUDENT_CARD_RANGE_INVALID"),
      ).toBe(false);
    });

    test("D2. مسار SyncEngine يُحول التعارض التابع إلى failed للانتظار بدلاً من conflict الدائم", async () => {
      const localDb = DatabaseService.getDb();
      const depOpId = "op-dep-attendance-wait-401";

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, retry_count
         ) VALUES ('row-dep-1', ?, ?, 'user-1', 'dev-1', 'CREATE', 'attendance', 'att-401', '{}', 'pending', ?, 0)`,
        [depOpId, centerId, new Date().toISOString()],
      );

      class DependencyConflictAdapter extends MockSyncApiAdapter {
        async pushOperations(
          _cId: string,
          ops: SyncOperationPayload[],
        ): Promise<PushSyncResponse> {
          return {
            success: true,
            syncedOperationIds: [],
            conflicts: [
              {
                operationId: depOpId,
                entityType: "attendance",
                entityId: "att-401",
                reason: "ATTENDANCE_SESSION_NOT_FOUND",
                resolution: "manual_review",
              },
            ],
            serverCursor: "50",
            processedAt: new Date().toISOString(),
          };
        }
      }

      const prevAdapter = SyncEngine.getAdapter();
      SyncEngine.setAdapter(new DependencyConflictAdapter());
      ConnectivityService.setState("online");
      SyncEngine.clearRateLimitForTesting();

      await SyncEngine.syncCenterNow(centerId);

      const op = SyncRepository.getByOperationId(depOpId);
      // Must NOT be marked conflict or synced; must be failed with dependency wait
      expect(op?.status).toBe("failed");
      expect(op?.lastError).toContain("في انتظار مزامنة السجل المرتبط");

      // And no entry in sync_conflicts
      const conf = localDb.getFirstSync<any>(
        "SELECT * FROM sync_conflicts WHERE operation_id = ?",
        [depOpId],
      );
      expect(conf).toBeNull();

      SyncEngine.setAdapter(prevAdapter);
    });

    test("D3. بعد وصول السجل الأب، تتم متابعة نفس العملية بنفس المعرّف بنجاح", async () => {
      const depOpId = "op-dep-success-after-parent-402";
      const localDb = DatabaseService.getDb();

      // Operation was in 'failed' status waiting for parent
      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, retry_count, last_error
         ) VALUES ('row-dep-2', ?, ?, 'user-1', 'dev-1', 'CREATE', 'attendance', 'att-402', '{"status":"present"}', 'failed', ?, 1, 'في انتظار مزامنة السجل المرتبط')`,
        [depOpId, centerId, new Date().toISOString()],
      );

      class ParentArrivedAdapter extends MockSyncApiAdapter {
        pushedOps: SyncOperationPayload[] = [];
        async pushOperations(
          _cId: string,
          ops: SyncOperationPayload[],
        ): Promise<PushSyncResponse> {
          this.pushedOps = ops;
          return {
            success: true,
            syncedOperationIds: ops.map((o) => o.operationId),
            conflicts: [],
            serverCursor: "60",
            processedAt: new Date().toISOString(),
          };
        }
      }

      const adapter = new ParentArrivedAdapter();
      const prevAdapter = SyncEngine.getAdapter();
      SyncEngine.setAdapter(adapter);
      ConnectivityService.setState("online");
      SyncEngine.clearRateLimitForTesting();

      await SyncEngine.syncCenterNow(centerId);

      const op = SyncRepository.getByOperationId(depOpId);
      expect(op?.status).toBe("synced");
      expect(adapter.pushedOps.some((o) => o.operationId === depOpId)).toBe(true);

      SyncEngine.setAdapter(prevAdapter);
    });
  });

  // =========================================================================
  // Category E: حماية STALE_UPDATE (STALE_UPDATE Protection)
  // =========================================================================
  describe("Category E: حماية STALE_UPDATE (STALE_UPDATE Protection)", () => {
    test("E1. السيرفر يرمي STALE_UPDATE عند وجود نسخة أحدث من السجل (assertFreshMutation)", async () => {
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 10,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map([
          [
            "std-stale-1",
            {
              id: "std-stale-1",
              center_id: centerId,
              name: "محمود الحديث",
              updated_at: "2026-10-25T14:00:00.000Z",
            },
          ],
        ]),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);

      await expect(
        SyncProcessor.assertFreshMutation(
          serverClient,
          centerId,
          "student",
          "std-stale-1",
          {
            name: "محمود القديم",
            baseUpdatedAt: "2026-10-24T10:00:00.000Z", // Stale!
          },
          "UPDATE",
        ),
      ).rejects.toThrow("STALE_UPDATE: server has a newer version of this record.");
    });

    test("E2. عملية processPush تُرجع conflict للـ STALE_UPDATE وتعمل Rollback ولا تستبدل بيانات السيرفر", async () => {
      const serverState: ServerMockState = {
        centerId,
        maxSeq: 10,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map([
          [
            "std-stale-2",
            {
              id: "std-stale-2",
              center_id: centerId,
              name: "الاسم الأحدث على السيرفر",
              updated_at: "2026-10-28T12:00:00.000Z",
            },
          ],
        ]),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: new Map(),
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.withTransaction = async (cb: any) => cb(serverClient);

      const pushResult = await SyncProcessor.processPush(
        centerId,
        "user-1",
        "dev-1",
        [
          {
            operationId: "op-stale-push-1",
            operationType: "UPDATE",
            entityType: "student",
            entityId: "std-stale-2",
            payload: {
              name: "تعديل متقادم مرفوض",
              baseUpdatedAt: "2026-10-20T08:00:00.000Z",
            },
          },
        ],
      );

      expect(pushResult.conflicts.length).toBe(1);
      expect(pushResult.conflicts[0].reason).toContain("STALE_UPDATE");
      expect(pushResult.syncedOperationIds).not.toContain("op-stale-push-1");

      // Verify server record was NOT overwritten
      expect(serverState.students.get("std-stale-2").name).toBe(
        "الاسم الأحدث على السيرفر",
      );
    });

    test("E3. العميل: حماية STALE_UPDATE من التحول إلى pending أو إعادة الإرسال (requeueRecoverableConflicts)", () => {
      const localDb = DatabaseService.getDb();
      const opId = "op-stale-client-301";
      const now = new Date().toISOString();

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, last_error
         ) VALUES ('row-stale-1', ?, ?, 'user-1', 'dev-1', 'UPDATE', 'student', 'std-stale-3', '{}', 'conflict', ?, 'STALE_UPDATE: server has a newer version of this record.')`,
        [opId, centerId, now],
      );
      localDb.runSync(
        `INSERT INTO sync_conflicts (
           id, operation_id, center_id, entity_type, entity_id,
           reason, local_payload, server_payload, created_at
         ) VALUES ('conf-stale-1', ?, ?, 'student', 'std-stale-3', 'STALE_UPDATE: server has a newer version', '{}', NULL, ?)`,
        [opId, centerId, now],
      );

      SyncRepository.requeueRecoverableConflicts(centerId);

      const op = SyncRepository.getByOperationId(opId);
      // Must be retired as synced with 'Superseded', NEVER set to pending
      expect(op?.status).toBe("synced");
      expect(op?.lastError).toBe("Superseded by server newer version");

      // Pending queue must NOT contain it
      const pending = SyncRepository.getPendingOperations(centerId);
      expect(pending.some((p) => p.operationId === opId)).toBe(false);

      // Conflict must be resolved
      const conf = localDb.getFirstSync<any>(
        "SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?",
        [opId],
      );
      expect(conf?.resolved_at).not.toBeNull();
    });
  });

  // =========================================================================
  // Category F: حماية رسائل SMS (SMS Ambiguous Outcome Protection)
  // =========================================================================
  describe("Category F: حماية رسائل SMS (SMS Ambiguous Outcome Protection)", () => {
    test("F1. رسائل ambiguous_outcome تُسجل كـ failed مع dispatchState: 'ambiguous_outcome' وغير قابلة للإعادة", async () => {
      const deliveryId = "del-ambiguous-601";
      const deliveries = new Map<string, any>([
        [
          deliveryId,
          {
            id: deliveryId,
            center_id: centerId,
            provider: "sms",
            status: "queued",
            retry_count: 0,
            notification_event_id: "ev-601",
            response_payload: JSON.stringify({
              recipient: "01000000000",
              renderedMessage: "تنبيه غياب",
              dispatchState: "pending",
            }),
          },
        ],
      ]);

      const serverState: ServerMockState = {
        centerId,
        maxSeq: 1,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: deliveries,
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.query = serverClient.query;

      jest.spyOn(zadxSmsProvider, "isConfigured").mockReturnValue(true);
      jest.spyOn(zadxSmsProvider, "send").mockImplementation(async () => {
        const err: any = new Error("Connection timeout");
        err.ambiguous = true;
        err.category = "timeout_ambiguous";
        throw err;
      });

      await SyncProcessor.sweepPendingSmsDeliveries(
        centerId,
        [deliveryId],
      );

      // Finalized as failed
      const updated = deliveries.get(deliveryId);
      expect(updated.status).toBe("failed");
      const parsedPayload = JSON.parse(updated.response_payload);
      expect(parsedPayload.dispatchState).toBe("ambiguous_outcome");
      expect(parsedPayload.retryable).toBe(false);
      expect(parsedPayload.nextRetryAtMs).toBeNull();
    });

    test("F2. الفحص التلقائي الخلفي (sweepPendingSmsDeliveries) يستبعد رسائل ambiguous_outcome تماماً", async () => {
      const deliveryId = "del-already-ambiguous-602";
      const deliveries = new Map<string, any>([
        [
          deliveryId,
          {
            id: deliveryId,
            center_id: centerId,
            provider: "sms",
            status: "failed", // Already failed from ambiguity
            retry_count: 1,
            notification_event_id: "ev-602",
            response_payload: JSON.stringify({
              recipient: "01000000000",
              renderedMessage: "تنبيه غياب",
              dispatchState: "ambiguous_outcome",
              retryable: false,
            }),
          },
        ],
      ]);

      const serverState: ServerMockState = {
        centerId,
        maxSeq: 1,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: deliveries,
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.query = serverClient.query;

      const sendSpy = jest.spyOn(zadxSmsProvider, "send");

      const sweepResult = await SyncProcessor.sweepPendingSmsDeliveries(
        centerId,
        [], // background sweep for all candidates
      );

      expect(sweepResult.sent).toBe(0);
      expect(sweepResult.rescheduled).toBe(0);
      // Provider send MUST NOT be called!
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test("F3. استدعاء الإرسال الصريح بمعرّف رسالة ambiguous_outcome يفشل في حجزها (Claim) ولا يُكرر الإرسال", async () => {
      const deliveryId = "del-explicit-ambiguous-603";
      const deliveries = new Map<string, any>([
        [
          deliveryId,
          {
            id: deliveryId,
            center_id: centerId,
            provider: "sms",
            status: "failed",
            retry_count: 1,
            notification_event_id: "ev-603",
            response_payload: JSON.stringify({
              recipient: "01000000000",
              renderedMessage: "تنبيه",
              dispatchState: "ambiguous_outcome",
            }),
          },
        ],
      ]);

      const serverState: ServerMockState = {
        centerId,
        maxSeq: 1,
        serverSyncOperations: new Map(),
        payments: new Map(),
        attendance: new Map(),
        students: new Map(),
        sessions: new Map(),
        debtCycles: new Map(),
        notificationDeliveries: deliveries,
        auditLogs: [],
        queries: [],
      };

      const serverClient = createServerMockClient(serverState);
      db.query = serverClient.query;

      const sendSpy = jest.spyOn(zadxSmsProvider, "send");

      await SyncProcessor.dispatchPendingSmsDeliveries(centerId, [deliveryId]);

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Category G: حماية العمليات المتزامنة (Concurrency Guard / Race Condition Protection)
  // =========================================================================
  describe("Category G: حماية العمليات المتزامنة (Concurrency Guard / Race Condition Protection)", () => {
    test("G1. الحجز الشرطي الذري (Atomic Claim) يمنع استدعاءين متزامنين من إعادة محاولة نفس العملية", () => {
      const localDb = DatabaseService.getDb();
      const opId = "op-concurrent-race-701";

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at
         ) VALUES ('row-race-1', ?, ?, 'user-1', 'dev-1', 'UPDATE', 'student', 'std-race-1', '{}', 'conflict', ?)`,
        [opId, centerId, new Date().toISOString()],
      );

      // Caller A attempts atomic claim
      const claimOperation = (operationId: string) => {
        const result: any = localDb.runSync(
          "UPDATE sync_operations SET status = 'syncing' WHERE operation_id = ? AND status = 'conflict'",
          [operationId],
        );
        return { changes: result?.changes || 0 };
      };

      const resultA = claimOperation(opId);
      expect(resultA.changes).toBe(1);

      // Caller B attempts concurrent claim on the same operation
      const resultB = claimOperation(opId);
      expect(resultB.changes).toBe(0);

      // Operation remains owned by Caller A in 'syncing', never double-processed
      const finalOp = SyncRepository.getByOperationId(opId);
      expect(finalOp?.status).toBe("syncing");
    });

    test("G2. قفل SyncEngine للمركز يمنع تزامن عمليتي مزامنة في نفس اللحظة", async () => {
      let pushCalls = 0;
      let activePushes = 0;
      let maxConcurrentPushes = 0;

      activeRealDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at
         ) VALUES ('row-test-push-g2', 'op-test-push-g2', ?, 'user-1', 'dev-1', 'UPDATE', 'student', 'std-1', '{}', 'pending', ?)`,
        [centerId, new Date().toISOString()],
      );

      class ConcurrencyTrackingAdapter extends MockSyncApiAdapter {
        async pushOperations(
          _cId: string,
          _ops: SyncOperationPayload[],
        ): Promise<PushSyncResponse> {
          pushCalls++;
          activePushes++;
          if (activePushes > maxConcurrentPushes) {
            maxConcurrentPushes = activePushes;
          }
          // Simulate slight delay
          await new Promise((resolve) => setTimeout(resolve, 50));
          activePushes--;
          return {
            success: true,
            syncedOperationIds: _ops.map((o) => o.operationId),
            conflicts: [],
            serverCursor: "100",
            processedAt: new Date().toISOString(),
          };
        }
      }

      const trackingAdapter = new ConcurrencyTrackingAdapter();
      const prevAdapter = SyncEngine.getAdapter();
      SyncEngine.setAdapter(trackingAdapter);
      ConnectivityService.setState("online");
      SyncEngine.clearRateLimitForTesting();

      // Launch sync 1 and sync 2 concurrently
      const sync1Promise = SyncEngine.syncCenterNow(centerId);
      const sync2Promise = SyncEngine.syncCenterNow(centerId);

      const [res1, res2] = await Promise.all([sync1Promise, sync2Promise]);

      // Absolute concurrency guarantee: max concurrent pushes must be strictly <= 1
      expect(maxConcurrentPushes).toBe(1);

      // The second sync was rejected by the active sync mutex and rate-limiter
      expect(pushCalls).toBe(1);
      expect(res2.arabicMessage).toBe(
        "المزامنة قيد التنفيذ بالفعل، يرجى الانتظار قليلاً.",
      );
      expect(res2.syncedCount).toBe(0);

      SyncEngine.setAdapter(prevAdapter);
    });
  });

  // =========================================================================
  // Category H: التحقق من نتائج Pull (Authoritative Pull Verification)
  // =========================================================================
  describe("Category H: التحقق من نتائج Pull (Authoritative Pull Verification)", () => {
    test("H1. وجود كيان مشابه على السيرفر لا يُحول العملية المحلية إلى synced دون إثبات operation_id", () => {
      const localDb = DatabaseService.getDb();
      const opId = "op-unverified-create-801";
      const now = new Date().toISOString();

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, last_error
         ) VALUES ('row-unver-1', ?, ?, 'user-1', 'dev-1', 'CREATE', 'student', 'std-801', '{"name":"علي سامي"}', 'conflict', ?, 'SERVER_ERROR')`,
        [opId, centerId, now],
      );

      // Incoming server change has a student with the same name, but was created by a different operation
      const incomingChange = {
        operationId: "op-different-actor-899",
        entityType: "student",
        entityId: "std-remote-999",
        action: "create" as const,
        data: {
          id: "std-remote-999",
          name: "علي سامي",
          centerId,
        },
      };

      SyncEngine.applyServerChanges(centerId, [incomingChange]);

      // Local operation MUST REMAIN in conflict because opId was never acknowledged
      const localOp = SyncRepository.getByOperationId(opId);
      expect(localOp?.status).toBe("conflict");
      expect(localOp?.syncedAt ?? null).toBeNull();
    });

    test("H2. لا تُعتبر العملية ناجحة إلا بعد تأكيد قبول نفس operation_id رسمياً من السيرفر", () => {
      const localDb = DatabaseService.getDb();
      const opId = "op-verified-802";
      const now = new Date().toISOString();

      localDb.runSync(
        `INSERT INTO sync_operations (
           id, operation_id, center_id, user_id, device_id,
           operation_type, entity_type, entity_id, payload,
           status, created_at, last_error
         ) VALUES ('row-ver-1', ?, ?, 'user-1', 'dev-1', 'CREATE', 'student', 'std-802', '{"name":"كريم هاني"}', 'conflict', ?, 'NETWORK_TIMEOUT')`,
        [opId, centerId, now],
      );

      // Authoritative confirmation: Server specifically acknowledges operationId
      SyncRepository.markAsSynced(opId);

      const op = SyncRepository.getByOperationId(opId);
      expect(op?.status).toBe("synced");
      expect(op?.syncedAt).not.toBeNull();
    });
  });
});
