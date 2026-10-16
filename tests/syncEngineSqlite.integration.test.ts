import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BootstrapResponse, ISyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import {
  PullSyncResponse,
  PushSyncResponse,
  ServerChangeRecord,
  SyncOperationPayload,
} from "../src/core/api/contracts";
import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { isRetryableDependencyConflict, SyncEngine, SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { SessionGenerationService } from "../src/features/sessions/SessionGenerationService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { Permission, User } from "../src/shared/types";
import { stableSessionId } from "../src/shared/utils/stableIds";

jest.mock("expo-device", () => ({ modelName: null }));
jest.mock("../backend/src/db", () => ({ withTransaction: jest.fn() }));

interface ServerSyncOperation {
  centerId: string;
  operationId: string;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: string | Record<string, unknown>;
  createdAt: string;
}

interface ServerQueryClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number;
  }>;
}

interface ServerSyncProcessor {
  orderSyncOperations(operations: ServerSyncOperation[]): ServerSyncOperation[];
  isStudentEligibleForSessionGroup(
    client: ServerQueryClient,
    args: {
      centerId: string;
      groupId: string;
      sessionDate: string;
      scheduleId: string;
      subjectId: string;
      teacherId: string;
      groupGrade: string;
      studentId: string;
      allowSameDayLateEnrollment: boolean;
    },
  ): Promise<boolean>;
  applyDomainMutation(
    client: ServerQueryClient,
    context: {
      centerId: string;
      userId: string;
      deviceId: string;
      operationId: string;
      operationType: string;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

const ServerSyncProcessor = require("../backend/src/services/SyncProcessor") as ServerSyncProcessor;

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
    return (this.connection.prepare(sql).get(...this.flatten(parameters)) as T | undefined) || null;
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

class SharedServerAdapter implements ISyncApiAdapter {
  sequence = 100;
  pullCalls = 0;
  pushCalls = 0;
  loseNextPushResponse = false;
  readonly changes: ServerChangeRecord[] = [];
  private readonly operationSequences = new Map<string, number>();

  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.pushCalls += 1;
    const syncedOperationIds: string[] = [];
    for (const operation of operations) {
      let sequence = this.operationSequences.get(operation.operationId);
      if (!sequence) {
        sequence = ++this.sequence;
        this.operationSequences.set(operation.operationId, sequence);
        this.changes.push({
          sequenceNumber: sequence,
          operationId: operation.operationId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          action: operation.operationType.toLowerCase() as "create" | "update" | "delete",
          data: operation.payload,
          serverTimestamp: new Date().toISOString(),
        });
      }
      syncedOperationIds.push(operation.operationId);
    }

    if (this.loseNextPushResponse) {
      this.loseNextPushResponse = false;
      throw new Error("simulated response loss after server commit");
    }
    return {
      success: true,
      syncedOperationIds,
      conflicts: [],
      serverCursor: String(this.sequence),
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
    limit = 50,
  ): Promise<PullSyncResponse> {
    this.pullCalls += 1;
    const batch = this.changes
      .filter((change) => change.sequenceNumber > Number(cursor))
      .slice(0, limit);
    const remaining = this.changes.filter(
      (change) => change.sequenceNumber > Number(cursor),
    );
    const nextCursor = batch.length
      ? String(batch[batch.length - 1].sequenceNumber)
      : cursor;
    return {
      changes: batch,
      nextCursor,
      hasMore: remaining.length > batch.length,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    throw new Error(`Unexpected bootstrap request for ${centerId}`);
  }
}

class InvalidChangeAdapter extends SharedServerAdapter {
  async pullChanges(
    _centerId: string,
    cursor: string,
  ): Promise<PullSyncResponse> {
    this.pullCalls += 1;
    return {
      changes: [{
        sequenceNumber: Number(cursor) + 1,
        operationId: "unsupported-server-change",
        entityType: "unsupported_entity",
        entityId: "unsupported-entity",
        action: "create",
        data: {},
        serverTimestamp: new Date().toISOString(),
      }],
      nextCursor: String(Number(cursor) + 1),
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }
}

class SpecificRetryAdapter implements ISyncApiAdapter {
  calls: SyncOperationPayload[][] = [];
  bootstrapGroups: BootstrapResponse["groups"] | null = null;
  bootstrapCalls = 0;
  response: PushSyncResponse = {
    success: true,
    syncedOperationIds: [],
    conflicts: [],
    serverCursor: "100",
    processedAt: new Date().toISOString(),
  };

  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.calls.push(operations);
    return this.response;
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
  ): Promise<PullSyncResponse> {
    return {
      changes: [],
      nextCursor: cursor,
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(_centerId: string): Promise<BootstrapResponse> {
    this.bootstrapCalls += 1;
    if (!this.bootstrapGroups) throw new Error("Unexpected bootstrap request");
    return { groups: this.bootstrapGroups } as BootstrapResponse;
  }
}

class StaleTeacherUpdateAdapter extends SharedServerAdapter {
  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.pushCalls += 1;
    return {
      success: true,
      syncedOperationIds: [],
      conflicts: operations.map((operation) => ({
        operationId: operation.operationId,
        entityType: operation.entityType,
        entityId: operation.entityId,
        reason: "STALE_UPDATE: server has a newer version of this record.",
        resolution: "server_wins",
        serverState: { weekStartDay: 4 },
      })),
      serverCursor: String(this.sequence),
      processedAt: new Date().toISOString(),
    };
  }
}

class SnapshotBootstrapAdapter extends SharedServerAdapter {
  constructor(private readonly snapshot: BootstrapResponse) {
    super();
  }

  async bootstrapCenter(_centerId: string): Promise<BootstrapResponse> {
    return this.snapshot;
  }
}

describe("SyncEngine against independent persistent SQLite databases", () => {
  let tempDirectory: string;
  let originalDatabase: SqlDatabase;
  let originalAdapter: ISyncApiAdapter;
  const openedDatabases: RealSqliteDatabase[] = [];

  function createClientDatabase(name: string, centerId: string, cursor = "100"): RealSqliteDatabase {
    const database = new RealSqliteDatabase(path.join(tempDirectory, `${name}.sqlite`));
    openedDatabases.push(database);
    DatabaseService.runMigrations(database);
    database.execSync(`
      CREATE TABLE IF NOT EXISTS center_academic_stages (
        center_id TEXT PRIMARY KEY,
        stages_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database.runSync(
      `INSERT INTO teachers (id, center_id, name, status, created_at, updated_at)
       VALUES (?, ?, 'Local seed', 'active', ?, ?)`,
      [`seed-${name}`, centerId, new Date().toISOString(), new Date().toISOString()],
    );
    DatabaseService.setMockDb(database);
    SyncRepository.setServerCursor(centerId, cursor);
    SyncRepository.setLastBootstrapTime(centerId);
    return database;
  }

  function enqueueTeacher(
    centerId: string,
    deviceNumber: number,
    operationId: string,
    teacherId = `engine-teacher-${deviceNumber}`,
  ): void {
    SyncRepository.enqueueOperation({
      centerId,
      userId: `engine-user-${deviceNumber}`,
      deviceId: `engine-device-${deviceNumber}`,
      operationType: "create",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        name: `Device ${deviceNumber} teacher`,
      },
      operationId,
    });
  }

  function insertSession(
    database: RealSqliteDatabase,
    id: string,
    centerId: string,
    status = "open",
    sessionDate = "2026-10-15",
  ): void {
    const timestamp = new Date().toISOString();
    database.runSync(
      `INSERT INTO sessions
         (id, center_id, group_id, session_date, start_time, end_time, status,
          schedule_id, subject_id, teacher_id, session_price, late_after_minutes,
          created_at, updated_at)
       VALUES (?, ?, 'shared-group', ?, '10:00', '11:00', ?, 'shared-schedule',
               'shared-subject', 'shared-teacher', 100, 15, ?, ?)`,
      [id, centerId, sessionDate, status, timestamp, timestamp],
    );
  }

  function insertStudent(
    database: RealSqliteDatabase,
    id: string,
    centerId: string,
  ): void {
    database.runSync(
      `INSERT INTO students
         (id, center_id, full_name, card_code, phone, parent_phone, grade,
          status, created_at)
       VALUES (?, ?, 'Dependency student', ?, '', '', 'Grade 8', 'active', ?)`,
      [id, centerId, `card-${id}`, new Date().toISOString()],
    );
  }

  function insertDebtCycle(
    database: RealSqliteDatabase,
    id: string,
    centerId: string,
    studentId: string,
  ): void {
    const timestamp = new Date().toISOString();
    database.runSync(
      `INSERT INTO debt_cycles
         (id, center_id, student_id, enrollment_id, group_id, cycle_number,
          start_date, end_date, cycle_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'shared-group', 1, '2026-10-01', '2026-10-31',
               100, 'open', ?, ?)`,
      [id, centerId, studentId, `enrollment-${id}`, timestamp, timestamp],
    );
  }

  beforeAll(() => {
    DatabaseService.init();
    originalDatabase = DatabaseService.getDb();
    originalAdapter = SyncEngine.getAdapter();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-sync-engine-"));
  });

  afterAll(() => {
    openedDatabases.forEach((database) => database.close());
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    DatabaseService.setMockDb(originalDatabase);
    SyncEngine.setAdapter(originalAdapter);
    ConnectivityService.setState("online");
  });

  beforeEach(() => {
    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();
  });

  it("bootstraps explicit session identities without merging rows or moving historical references", async () => {
    const centerId = `session-bootstrap-${Date.now()}`;
    const database = createClientDatabase("session-bootstrap-device", centerId);
    const timestamp = "2026-10-15T10:00:00.000Z";
    const sessionStartedAt = "2026-10-15T09:59:00.000Z";
    insertSession(database, "local-session-a", centerId, "open");
    insertSession(database, "local-session-b", centerId, "open");
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late,
          attendance_type, operation_id)
       VALUES ('history-attendance', ?, 'student-a', 'local-session-a', ?, 'present',
               0, 'present', 'history-attendance-op')`,
      [centerId, timestamp],
    );
    database.runSync(
      `INSERT INTO payments
         (id, operation_id, center_id, student_id, amount, payment_type,
          payment_method, payment_date, notes, debt_cycle_id, session_id,
          subscription_id, is_reversed, created_at, user_id)
       VALUES ('history-payment', 'history-payment-op', ?, 'student-a', 100,
               'session', 'cash', '2026-10-15', NULL, NULL, 'local-session-a',
               NULL, 0, ?, 'test-user')`,
      [centerId, timestamp],
    );
    SyncRepository.enqueueOperation({
      operationId: "history-attendance-pending",
      centerId,
      userId: "test-user",
      deviceId: "offline-device",
      operationType: "create",
      entityType: "attendance",
      entityId: "history-attendance",
      payload: {
        id: "history-attendance",
        sessionId: "local-session-a",
        originalAbsenceId: "absence-record-a",
        studentId: "student-a",
        status: "present",
      },
    });

    const snapshot = {
      centerId,
      students: [],
      cards: [],
      groups: [],
      teachers: [],
      subjects: [],
      schedules: [],
      sessions: [
        {
          id: "remote-duplicate-session",
          center_id: centerId,
          group_id: "shared-group",
          schedule_id: "shared-schedule",
          session_date: "2026-10-15",
          start_time: "10:00",
          end_time: "11:00",
          status: "open",
          created_at: timestamp,
          updated_at: timestamp,
        },
        {
          id: "remote-canonical-session",
          center_id: centerId,
          group_id: "shared-group",
          schedule_id: "shared-schedule",
          session_date: "2026-10-15",
          start_time: "10:00",
          end_time: "11:00",
          status: "open",
          started_at: sessionStartedAt,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      sessionNaturalKeys: [{
        centerId,
        groupId: "shared-group",
        scheduleKey: "shared-schedule",
        sessionDate: "2026-10-15",
        canonicalSessionId: "remote-canonical-session",
        status: "open",
        hasNonCancelledDuplicate: false,
        hasCancelledDuplicate: false,
      }],
      sessionAliases: [{
        localSessionId: "remote-duplicate-session",
        canonicalSessionId: "remote-canonical-session",
      }],
      expectedStudents: [],
      enrollments: [],
      attendance: [{
        id: "history-attendance",
        center_id: centerId,
        student_id: "student-a",
        session_id: "remote-canonical-session",
        check_in_time: timestamp,
        status: "absent",
        attendance_type: "present",
        operation_id: "history-attendance-op",
      }],
      payments: [{
        id: "history-payment",
        operation_id: "history-payment-op",
        center_id: centerId,
        student_id: "student-a",
        amount: 100,
        payment_type: "session",
        payment_method: "cash",
        payment_date: "2026-10-15",
        session_id: "remote-canonical-session",
        created_at: timestamp,
        user_id: "test-user",
      }],
      latestServerSeq: 150,
      timestamp,
    } as BootstrapResponse;
    SyncEngine.setAdapter(new SnapshotBootstrapAdapter(snapshot));
    DatabaseService.setMockDb(database);

    await SyncEngine.bootstrapCenter(centerId);

    expect(database.getAllSync<{ id: string }>(
      `SELECT id FROM sessions
        WHERE center_id = ? AND group_id = 'shared-group'
          AND schedule_id = 'shared-schedule' AND session_date = '2026-10-15'`,
      [centerId],
    )).toHaveLength(4);
    expect(database.getFirstSync<{ created_at: string }>(
      "SELECT created_at FROM sessions WHERE center_id = ? AND id = 'remote-canonical-session'",
      [centerId],
    )?.created_at).toBe(sessionStartedAt);
    expect(database.getFirstSync<{ canonical_session_id: string }>(
      `SELECT canonical_session_id FROM session_id_aliases
        WHERE center_id = ? AND local_session_id = 'remote-duplicate-session'`,
      [centerId],
    )?.canonical_session_id).toBe("remote-canonical-session");
    expect(database.getFirstSync<{ canonical_session_id: string }>(
      `SELECT canonical_session_id FROM session_id_aliases
        WHERE center_id = ? AND local_session_id = 'local-session-a'`,
      [centerId],
    )?.canonical_session_id).toBe("remote-canonical-session");
    expect(database.getFirstSync<{ session_id: string; status: string }>(
      "SELECT session_id, status FROM attendance WHERE id = 'history-attendance'",
    )).toEqual({ session_id: "local-session-a", status: "present" });
    expect(database.getFirstSync<{ session_id: string }>(
      "SELECT session_id FROM payments WHERE id = 'history-payment'",
    )?.session_id).toBe("local-session-a");
    const pendingPayload = database.getFirstSync<{ payload: string }>(
      "SELECT payload FROM sync_operations WHERE operation_id = 'history-attendance-pending'",
    )?.payload;
    expect(JSON.parse(pendingPayload || "{}")).toMatchObject({
      sessionId: "local-session-a",
      originalAbsenceId: "absence-record-a",
    });

    const reversedDatabase = createClientDatabase(
      "session-bootstrap-reversed",
      centerId,
    );
    insertSession(reversedDatabase, "local-session-a", centerId, "open");
    insertSession(reversedDatabase, "local-session-b", centerId, "open");
    SyncEngine.setAdapter(new SnapshotBootstrapAdapter({
      ...snapshot,
      sessions: [...snapshot.sessions].reverse(),
      sessionAliases: [...(snapshot.sessionAliases || [])].reverse(),
    }));
    DatabaseService.setMockDb(reversedDatabase);
    await SyncEngine.bootstrapCenter(centerId);
    expect(reversedDatabase.getAllSync<{
      local_session_id: string;
      canonical_session_id: string;
    }>(
      `SELECT local_session_id, canonical_session_id
         FROM session_id_aliases
        WHERE center_id = ?
        ORDER BY local_session_id`,
      [centerId],
    )).toEqual([
      {
        local_session_id: "local-session-a",
        canonical_session_id: "remote-canonical-session",
      },
      {
        local_session_id: "local-session-b",
        canonical_session_id: "remote-canonical-session",
      },
      {
        local_session_id: "remote-duplicate-session",
        canonical_session_id: "remote-canonical-session",
      },
    ]);
  });

  it("orders enrollment and schedule before the session roster and accepts attendance promotion", async () => {
    const centerId = `session-enrollment-sync-${Date.now()}`;
    const database = createClientDatabase("session-enrollment-sync", centerId);
    const studentId = "roster-student";
    const groupId = "roster-group";
    const scheduleId = "roster-schedule";
    const sessionId = "roster-session";
    const attendanceId = `att-default-${sessionId}-${studentId}`;
    const expectedOperationId = `op-att-default-${sessionId}-${studentId}`;
    const now = new Date().toISOString();
    const enqueue = (
      operationId: string,
      operationType: string,
      entityType: string,
      entityId: string,
      payload: Record<string, unknown>,
    ) => SyncRepository.enqueueOperation({
      centerId,
      userId: "roster-user",
      deviceId: "roster-device",
      operationType,
      entityType,
      entityId,
      payload,
      operationId,
    });

    enqueue("roster-attendance-op", "UPDATE", "attendance", attendanceId, {
      id: attendanceId,
      centerId,
      studentId,
      sessionId,
      status: "present",
      attendanceType: "present",
      action: "attendance.promote_default_absence",
      expectedOperationId,
      checkInTime: now,
    });
    enqueue("roster-session-op", "session.reconcile", "session", sessionId, {
      groupId,
      scheduleId,
      subjectId: "roster-subject",
      teacherId: "roster-teacher",
      sessionDate: "2026-10-16",
      startTime: "10:00",
      endTime: "11:00",
      expectedStudentIds: [studentId],
      status: "open",
    });
    enqueue("roster-enrollment-op", "CREATE", "enrollment", "roster-enrollment", {
      id: "roster-enrollment",
      studentId,
      groupId,
      startDate: "2026-10-22",
      status: "active",
      createdAt: now,
    });
    enqueue("roster-schedule-op", "CREATE", "group_schedule", scheduleId, {
      id: scheduleId,
      groupId,
      dayOfWeek: 5,
      startTime: "10:00",
      endTime: "11:00",
      status: "active",
    });
    enqueue("roster-student-op", "CREATE", "student", studentId, {
      id: studentId,
      centerId,
    });
    enqueue("roster-group-op", "CREATE", "group", groupId, {
      id: groupId,
      teacherId: "roster-teacher",
      subjectId: "roster-subject",
    });

    const pending = SyncRepository.getPendingOperations(centerId);
    const operationIds = pending.map((operation) => operation.operationId);
    const operationIndex = (operationId: string) => operationIds.indexOf(operationId);
    expect(operationIndex("roster-group-op")).toBeLessThan(operationIndex("roster-schedule-op"));
    expect(operationIndex("roster-student-op")).toBeLessThan(operationIndex("roster-enrollment-op"));
    expect(operationIndex("roster-schedule-op")).toBeLessThan(operationIndex("roster-session-op"));
    expect(operationIndex("roster-enrollment-op")).toBeLessThan(operationIndex("roster-session-op"));
    expect(operationIndex("roster-session-op")).toBeLessThan(operationIndex("roster-attendance-op"));
    expect(
      SyncRepository.getPendingOperations(centerId, 5).map((operation) => operation.operationId),
    ).toContain("roster-session-op");
    expect(
      SyncRepository.getPendingOperations(centerId, 5).map((operation) => operation.operationId),
    ).not.toContain("roster-attendance-op");

    const serverOrdered = ServerSyncProcessor.orderSyncOperations(pending);
    const serverOperationIds = serverOrdered.map((operation) => operation.operationId);
    expect(serverOperationIds.indexOf("roster-enrollment-op")).toBeLessThan(
      serverOperationIds.indexOf("roster-session-op"),
    );
    expect(serverOperationIds.indexOf("roster-schedule-op")).toBeLessThan(
      serverOperationIds.indexOf("roster-session-op"),
    );

    let attendanceRecord: {
      id: string;
      session_id: string;
      student_id: string;
      check_in_time: string;
      status: string;
      is_late: boolean;
      attendance_type: string;
      original_absence_id: string | null;
      operation_id: string;
    } = {
      id: attendanceId,
      session_id: sessionId,
      student_id: studentId,
      check_in_time: now,
      status: "absent",
      is_late: false,
      attendance_type: "present",
      original_absence_id: null,
      operation_id: expectedOperationId,
    };
    const serverStatements: string[] = [];
    const serverClient: ServerQueryClient = {
      async query(sql, params = []) {
        const statement = sql.replace(/\s+/g, " ").trim();
        serverStatements.push(statement);
        if (statement.includes("FROM student_group_enrollments e")) {
          expect(statement).toContain("server_sync_operations");
          expect(statement).toContain("group_schedules session_schedule");
          expect(params).toEqual([
            centerId,
            groupId,
            studentId,
            "2026-10-16",
            scheduleId,
          ]);
          return { rows: [{ "?column?": 1 }] };
        }
        if (statement.includes("FROM student_package_subscriptions")) {
          return { rows: [] };
        }
        if (
          statement.includes("FROM sessions s") &&
          statement.includes("WHERE s.center_id = $1::varchar AND s.id = $2::varchar")
        ) {
          return {
            rows: [{
              id: sessionId,
              session_date: "2026-10-16",
              start_time: "10:00",
              group_id: groupId,
              schedule_id: scheduleId,
              subject_id: "roster-subject",
              teacher_id: "roster-teacher",
              status: "open",
              updated_at: now,
              validated_group_id: groupId,
              group_grade: "Grade 8",
              group_subject_id: "roster-subject",
              group_teacher_id: "roster-teacher",
            }],
          };
        }
        if (statement.includes("FROM students") && statement.includes("deleted_at IS NULL")) {
          return { rows: [{ center_id: centerId }] };
        }
        if (statement.includes("FROM session_expected_students")) {
          return { rows: [{ "?column?": 1 }] };
        }
        if (statement.includes("WITH RECURSIVE session_ids(session_id)")) {
          return { rows: [{ session_id: sessionId }] };
        }
        if (statement.includes("FROM attendance a") && statement.includes("FOR UPDATE OF a")) {
          return { rows: [{ ...attendanceRecord }] };
        }
        if (statement.startsWith("UPDATE attendance")) {
          attendanceRecord = {
            ...attendanceRecord,
            check_in_time: String(params[4]),
            status: String(params[5]),
            is_late: Boolean(params[6]),
            attendance_type: String(params[7]),
            original_absence_id: params[8] as string | null,
            operation_id: String(params[9]),
          };
          return { rows: [], rowCount: 1 };
        }
        if (
          statement.includes("FROM attendance") &&
          statement.includes("WHERE center_id = $1 AND id = $2")
        ) {
          return { rows: [{ ...attendanceRecord }] };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(
      ServerSyncProcessor.isStudentEligibleForSessionGroup(serverClient, {
        centerId,
        groupId,
        sessionDate: "2026-10-16",
        scheduleId,
        subjectId: "roster-subject",
        teacherId: "roster-teacher",
        groupGrade: "Grade 8",
        studentId,
        allowSameDayLateEnrollment: true,
      }),
    ).resolves.toBe(true);
    await ServerSyncProcessor.applyDomainMutation(serverClient, {
      centerId,
      userId: "roster-user",
      deviceId: "roster-device",
      operationId: "roster-attendance-present",
      operationType: "UPDATE",
      entityType: "attendance",
      entityId: attendanceId,
      payload: {
        id: attendanceId,
        centerId,
        studentId,
        sessionId,
        status: "present",
        attendanceType: "present",
        action: "attendance.promote_default_absence",
        expectedOperationId,
        checkInTime: now,
      },
    });

    expect(attendanceRecord.status).toBe("present");
    expect(attendanceRecord.operation_id).toBe("roster-attendance-present");
    expect(serverStatements.some((statement) => statement.startsWith("UPDATE attendance"))).toBe(true);
    expect(serverStatements.some((statement) => statement.startsWith("INSERT INTO attendance"))).toBe(false);
  });

  it("canonicalizes pulled session references and keeps present over absent in either pull order", () => {
    const centerId = `session-pull-order-${Date.now()}`;
    const firstDevice = createClientDatabase("session-pull-first", centerId);
    const secondDevice = createClientDatabase("session-pull-second", centerId);
    for (const database of [firstDevice, secondDevice]) {
      DatabaseService.setMockDb(database);
      insertSession(database, "shared-session", centerId);
      SyncRepository.recordSessionMappings(centerId, [{
        localSessionId: "device-session-alias",
        canonicalSessionId: "shared-session",
      }]);
    }
    const absentChange: ServerChangeRecord = {
      sequenceNumber: 101,
      operationId: "device-one-absence",
      entityType: "attendance",
      entityId: "device-one-attendance",
      action: "create",
      data: {
        id: "device-one-attendance",
        session_id: "device-session-alias",
        student_id: "same-student",
        check_in_time: "2026-10-15T10:10:00.000Z",
        status: "absent",
        attendance_type: "present",
      },
      serverTimestamp: "2026-10-15T10:11:00.000Z",
    };
    const presentChange: ServerChangeRecord = {
      sequenceNumber: 102,
      operationId: "device-two-presence",
      entityType: "attendance",
      entityId: "device-two-attendance",
      action: "create",
      data: {
        id: "device-two-attendance",
        session_id: "device-session-alias",
        student_id: "same-student",
        check_in_time: "2026-10-15T10:05:00.000Z",
        status: "present",
        attendance_type: "present",
      },
      serverTimestamp: "2026-10-15T10:12:00.000Z",
    };

    DatabaseService.setMockDb(firstDevice);
    SyncEngine.applyServerChanges(centerId, [absentChange, presentChange]);
    DatabaseService.setMockDb(secondDevice);
    SyncEngine.applyServerChanges(centerId, [presentChange, absentChange]);

    for (const database of [firstDevice, secondDevice]) {
      expect(database.getAllSync<{ id: string; session_id: string; status: string }>(
        `SELECT id, session_id, status FROM attendance
          WHERE center_id = ? AND student_id = 'same-student'`,
        [centerId],
      )).toEqual([{
        id: expect.any(String),
        session_id: "shared-session",
        status: "present",
      }]);
    }
    const prepared = SyncRepository.prepareOperationForPush({
      operationId: "makeup-reference-map",
      centerId,
      userId: "test-user",
      deviceId: "test-device",
      operationType: "create",
      entityType: "attendance",
      entityId: "makeup-attendance",
      payload: {
        sessionId: "device-session-alias",
        originalAbsenceId: "device-session-alias",
      },
      createdAt: new Date().toISOString(),
    });
    expect(prepared.payload).toEqual({
      sessionId: "shared-session",
      originalAbsenceId: "shared-session",
    });
  });

  it("retains the earliest server-approved session start time when Pull receives starts out of order", () => {
    const centerId = `session-start-time-pull-${Date.now()}`;
    const database = createClientDatabase("session-start-time-pull", centerId);
    const earliestStartedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const laterStartedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const sessionChange = (
      sequenceNumber: number,
      operationId: string,
      startedAt: string,
    ): ServerChangeRecord => ({
      sequenceNumber,
      operationId,
      entityType: "session",
      entityId: "canonical-session",
      action: "create",
      data: {
        id: "canonical-session",
        groupId: "shared-group",
        scheduleId: "shared-schedule",
        sessionDate: "2026-10-15",
        startTime: "10:00",
        endTime: "11:00",
        status: "open",
        createdAt: startedAt,
        startedAt,
      },
      serverTimestamp: startedAt,
    });

    SyncEngine.applyServerChanges(centerId, [
      sessionChange(101, "later-session-start", laterStartedAt),
      sessionChange(102, "earlier-session-start", earliestStartedAt),
    ]);

    expect(database.getAllSync<{
      id: string;
      created_at: string;
      status: string;
    }>(
      "SELECT id, created_at, status FROM sessions WHERE center_id = ?",
      [centerId],
    )).toEqual([{
      id: "canonical-session",
      created_at: earliestStartedAt,
      status: "open",
    }]);
  });

  it("applies explicit server-approved attendance cancellation and keeps its revision on Pull", () => {
    const centerId = `attendance-cancel-pull-${Date.now()}`;
    const database = createClientDatabase("attendance-cancel-pull", centerId);
    insertSession(database, "cancel-pull-session", centerId);
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          is_late, attendance_type, operation_id)
       VALUES ('cancel-pull-record', ?, 'student-a', 'cancel-pull-session',
               '2026-10-15T10:00:00.000Z', 'present', 0, 'present',
               'original-present-operation')`,
      [centerId],
    );
    DatabaseService.setMockDb(database);

    const applyAttendanceChange = (
      operationId: string,
      status: "present" | "absent",
      action?: string,
    ) => SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: Number(operationId.endsWith("cancel") ? 106 : operationId.endsWith("present") ? 107 : 108),
      operationId,
      entityType: "attendance",
      entityId: "cancel-pull-record",
      action: "update",
      data: {
        id: "cancel-pull-record",
        session_id: "cancel-pull-session",
        student_id: "student-a",
        status,
        action,
      },
      serverTimestamp: "2026-10-15T12:00:00.000Z",
    }]);

    applyAttendanceChange("accepted-cancel", "absent", "attendance.cancel");
    expect(database.getFirstSync<{
      status: string;
      operation_id: string;
    }>(
      "SELECT status, operation_id FROM attendance WHERE id = 'cancel-pull-record'",
    )).toEqual({
      status: "absent",
      operation_id: "accepted-cancel",
    });

    applyAttendanceChange("newer-present", "present");
    expect(database.getFirstSync<{
      status: string;
      operation_id: string;
    }>(
      "SELECT status, operation_id FROM attendance WHERE id = 'cancel-pull-record'",
    )).toEqual({
      status: "present",
      operation_id: "newer-present",
    });

    applyAttendanceChange("stale-absence", "absent");
    expect(database.getFirstSync<{
      status: string;
      operation_id: string;
    }>(
      "SELECT status, operation_id FROM attendance WHERE id = 'cancel-pull-record'",
    )).toEqual({
      status: "present",
      operation_id: "newer-present",
    });
  });

  it("applies a server-confirmed cancellation from Bootstrap without inferring an absence", async () => {
    const centerId = `attendance-cancel-bootstrap-${Date.now()}`;
    const database = createClientDatabase("attendance-cancel-bootstrap", centerId);
    insertSession(database, "cancel-bootstrap-session", centerId);
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          is_late, attendance_type, operation_id)
       VALUES ('cancel-bootstrap-record', ?, 'student-a',
               'cancel-bootstrap-session', '2026-10-15T10:00:00.000Z',
               'present', 0, 'present', 'old-present-operation')`,
      [centerId],
    );
    SyncEngine.setAdapter(new SnapshotBootstrapAdapter({
      centerId,
      students: [],
      cards: [],
      groups: [],
      teachers: [],
      subjects: [],
      schedules: [],
      sessions: [],
      sessionNaturalKeys: [],
      sessionAliases: [],
      expectedStudents: [],
      enrollments: [],
      attendance: [{
        id: "cancel-bootstrap-record",
        center_id: centerId,
        student_id: "student-a",
        session_id: "cancel-bootstrap-session",
        check_in_time: "2026-10-15T10:00:00.000Z",
        status: "absent",
        attendance_type: "present",
        operation_id: "confirmed-cancel-operation",
        last_operation_action: "attendance.cancel",
      }],
      payments: [],
      latestServerSeq: 120,
      timestamp: "2026-10-15T12:00:00.000Z",
    } as BootstrapResponse));
    DatabaseService.setMockDb(database);

    await SyncEngine.bootstrapCenter(centerId);

    expect(database.getFirstSync<{
      status: string;
      operation_id: string;
    }>(
      "SELECT status, operation_id FROM attendance WHERE id = 'cancel-bootstrap-record'",
    )).toEqual({
      status: "absent",
      operation_id: "confirmed-cancel-operation",
    });
  });

  it("does not let an older pulled session update reopen cancellation", () => {
    const centerId = `cancelled-session-pull-${Date.now()}`;
    const database = createClientDatabase("cancelled-session-pull", centerId);
    const cancelledAt = "2026-10-15T12:00:00.000Z";
    insertSession(database, "cancelled-session", centerId, "cancelled");
    database.runSync(
      "UPDATE sessions SET updated_at = ? WHERE center_id = ? AND id = ?",
      [cancelledAt, centerId, "cancelled-session"],
    );
    DatabaseService.setMockDb(database);

    SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: 101,
      operationId: "stale-session-open",
      entityType: "session",
      entityId: "cancelled-session",
      action: "update",
      data: {
        id: "cancelled-session",
        group_id: "shared-group",
        schedule_id: "shared-schedule",
        session_date: "2026-10-15",
        start_time: "10:00",
        end_time: "11:00",
        status: "open",
        updated_at: "2026-10-15T09:00:00.000Z",
      },
      serverTimestamp: "2026-10-15T09:01:00.000Z",
    }]);

    expect(database.getFirstSync<{ status: string; updated_at: string }>(
      "SELECT status, updated_at FROM sessions WHERE center_id = ? AND id = ?",
      [centerId, "cancelled-session"],
    )).toEqual({ status: "cancelled", updated_at: cancelledAt });
  });

  it("keeps cancelled-session closing history when a delayed reopen arrives", () => {
    const centerId = `cancelled-session-reopen-${Date.now()}`;
    const database = createClientDatabase("cancelled-session-reopen", centerId);
    const timestamp = "2026-10-15T12:00:00.000Z";
    insertSession(database, "cancelled-session", centerId, "cancelled");
    database.runSync(
      `INSERT INTO session_closing_records
         (id, operation_id, center_id, session_id, action, reason, performed_by,
          performed_at, previous_status, new_status, total_attendance,
          total_session_payments, created_at)
       VALUES ('existing-close', 'existing-close-operation', ?, 'cancelled-session',
               'close', 'close reason', 'test-user', ?, 'open', 'closed', 2,
               50, ?)` ,
      [centerId, timestamp, timestamp],
    );
    DatabaseService.setMockDb(database);

    SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: 102,
      operationId: "delayed-reopen-operation",
      entityType: "session_closing",
      entityId: "cancelled-session",
      action: "update",
      data: {
        id: "delayed-reopen",
        session_id: "cancelled-session",
        action: "reopen",
        new_status: "open",
        performed_at: "2026-10-15T09:00:00.000Z",
      },
      serverTimestamp: "2026-10-15T12:05:00.000Z",
    }]);

    expect(database.getFirstSync<{ status: string }>(
      "SELECT status FROM sessions WHERE center_id = ? AND id = ?",
      [centerId, "cancelled-session"],
    )?.status).toBe("cancelled");
    expect(database.getAllSync<{ id: string; action: string }>(
      `SELECT id, action FROM session_closing_records
        WHERE center_id = ? AND session_id = ? ORDER BY id`,
      [centerId, "cancelled-session"],
    )).toEqual([
      { id: "delayed-reopen", action: "reopen" },
      { id: "existing-close", action: "close" },
    ]);
  });

  it("preserves a conflicting payment reversal and records a financial sync conflict", () => {
    const centerId = `payment-reversal-conflict-${Date.now()}`;
    const database = createClientDatabase("payment-reversal-conflict", centerId);
    const timestamp = "2026-10-15T12:00:00.000Z";
    database.runSync(
      `INSERT INTO payments
         (id, operation_id, center_id, student_id, amount, payment_type,
          payment_method, payment_date, session_id, is_reversed, created_at, user_id)
       VALUES ('payment-a', 'payment-operation-a', ?, 'student-a', 100,
               'session', 'cash', '2026-10-15', 'shared-session', 1, ?, 'test-user')`,
      [centerId, timestamp],
    );
    database.runSync(
      `INSERT INTO payment_reversals
         (id, operation_id, center_id, payment_id, student_id, reversed_amount,
          reason, reversed_by, reversed_at, created_at)
       VALUES ('historical-reversal', 'historical-reversal-operation', ?,
               'payment-a', 'student-a', 100, 'original reason', 'test-user', ?, ?)`,
      [centerId, timestamp, timestamp],
    );
    DatabaseService.setMockDb(database);

    SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: 103,
      operationId: "conflicting-reversal-operation",
      entityType: "payment_reversal",
      entityId: "incoming-reversal",
      action: "create",
      data: {
        id: "incoming-reversal",
        payment_id: "payment-a",
        student_id: "student-a",
        reversed_amount: 100,
        reason: "different reversal",
        reversed_by: "other-user",
        reversed_at: timestamp,
        created_at: timestamp,
      },
      serverTimestamp: timestamp,
    }]);

    expect(database.getAllSync<{ id: string; operation_id: string }>(
      "SELECT id, operation_id FROM payment_reversals WHERE center_id = ?",
      [centerId],
    )).toEqual([{
      id: "historical-reversal",
      operation_id: "historical-reversal-operation",
    }]);
    expect(database.getFirstSync<{ operation_id: string; resolved_at: string | null }>(
      `SELECT operation_id, resolved_at FROM sync_conflicts
        WHERE operation_id = 'conflicting-reversal-operation'`,
    )).toEqual({
      operation_id: "conflicting-reversal-operation",
      resolved_at: null,
    });
    expect(database.getFirstSync<{ is_reversed: number }>(
      "SELECT is_reversed FROM payments WHERE id = 'payment-a'",
    )?.is_reversed).toBe(1);
  });

  it("canonicalizes pulled payment session aliases without rewriting historical absence references", () => {
    const centerId = `session-reference-pull-${Date.now()}`;
    const database = createClientDatabase("session-reference-pull", centerId);
    insertSession(database, "canonical-session", centerId);
    insertSession(database, "device-session-alias", centerId);
    DatabaseService.setMockDb(database);
    SyncRepository.recordSessionMappings(centerId, [{
      localSessionId: "device-session-alias",
      canonicalSessionId: "canonical-session",
    }]);

    SyncEngine.applyServerChanges(centerId, [
      {
        sequenceNumber: 104,
        operationId: "pulled-session-payment",
        entityType: "payment",
        entityId: "pulled-payment",
        action: "create",
        data: {
          id: "pulled-payment",
          student_id: "student-a",
          amount: 25,
          payment_type: "session",
          payment_method: "cash",
          payment_date: "2026-10-15",
          session_id: "device-session-alias",
          created_at: "2026-10-15T12:00:00.000Z",
          user_id: "test-user",
        },
        serverTimestamp: "2026-10-15T12:01:00.000Z",
      },
      {
        sequenceNumber: 105,
        operationId: "pulled-session-attendance",
        entityType: "attendance",
        entityId: "pulled-attendance",
        action: "create",
        data: {
          id: "pulled-attendance",
          session_id: "device-session-alias",
          original_absence_id: "device-session-alias",
          student_id: "student-a",
          check_in_time: "2026-10-15T12:02:00.000Z",
          status: "present",
        },
        serverTimestamp: "2026-10-15T12:03:00.000Z",
      },
    ]);

    expect(database.getFirstSync<{ session_id: string }>(
      "SELECT session_id FROM payments WHERE id = 'pulled-payment'",
    )?.session_id).toBe("canonical-session");
    expect(database.getFirstSync<{ session_id: string; original_absence_id: string }>(
      "SELECT session_id, original_absence_id FROM attendance WHERE id = 'pulled-attendance'",
    )).toEqual({
      session_id: "canonical-session",
      original_absence_id: "device-session-alias",
    });
  });

  it("replays an exact historical attendance identity without changing its other alias row", () => {
    const centerId = `session-reference-exact-replay-${Date.now()}`;
    const database = createClientDatabase("session-reference-exact-replay", centerId);
    insertSession(database, "canonical-session", centerId);
    insertSession(database, "device-session-alias", centerId);
    SyncRepository.recordSessionMappings(centerId, [{
      localSessionId: "device-session-alias",
      canonicalSessionId: "canonical-session",
    }]);
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late,
          attendance_type, operation_id)
       VALUES
         ('canonical-history-attendance', ?, 'student-a', 'canonical-session',
          '2026-10-15T10:00:00.000Z', 'present', 0, 'present',
          'canonical-history-operation'),
         ('alias-history-attendance', ?, 'student-a', 'device-session-alias',
          '2026-10-15T10:01:00.000Z', 'absent', 0, 'present',
          'alias-history-operation')`,
      [centerId, centerId],
    );
    DatabaseService.setMockDb(database);

    expect(() => SyncRepository.upsertPulledAttendance(database, centerId, {
      id: "alias-history-attendance",
      center_id: centerId,
      student_id: "student-a",
      session_id: "device-session-alias",
      check_in_time: "2026-10-15T10:02:00.000Z",
      status: "present",
      operation_id: "alias-history-operation-replayed",
    })).not.toThrow();
    expect(database.getAllSync<{
      id: string;
      session_id: string;
      status: string;
      check_in_time: string;
      operation_id: string;
    }>(
      `SELECT id, session_id, status, check_in_time, operation_id
         FROM attendance
        WHERE center_id = ? AND student_id = 'student-a'
        ORDER BY id`,
      [centerId],
    )).toEqual([
      {
        id: "alias-history-attendance",
        session_id: "device-session-alias",
        status: "present",
        check_in_time: "2026-10-15T10:02:00.000Z",
        operation_id: "alias-history-operation-replayed",
      },
      {
        id: "canonical-history-attendance",
        session_id: "canonical-session",
        status: "present",
        check_in_time: "2026-10-15T10:00:00.000Z",
        operation_id: "canonical-history-operation",
      },
    ]);
  });

  it("preserves multiple historical attendance rows instead of selecting an arbitrary alias match", () => {
    const centerId = `session-reference-conflict-${Date.now()}`;
    const database = createClientDatabase("session-reference-conflict", centerId);
    insertSession(database, "canonical-session", centerId);
    insertSession(database, "device-session-alias", centerId);
    SyncRepository.recordSessionMappings(centerId, [{
      localSessionId: "device-session-alias",
      canonicalSessionId: "canonical-session",
    }]);
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late,
          attendance_type, operation_id)
       VALUES
         ('canonical-history-attendance', ?, 'student-a', 'canonical-session',
          '2026-10-15T10:00:00.000Z', 'present', 0, 'present',
          'canonical-history-operation'),
         ('alias-history-attendance', ?, 'student-a', 'device-session-alias',
          '2026-10-15T10:01:00.000Z', 'absent', 0, 'present',
          'alias-history-operation')`,
      [centerId, centerId],
    );
    DatabaseService.setMockDb(database);

    expect(() => SyncRepository.upsertPulledAttendance(database, centerId, {
      id: "new-pulled-attendance",
      center_id: centerId,
      student_id: "student-a",
      session_id: "device-session-alias",
      check_in_time: "2026-10-15T10:02:00.000Z",
      status: "present",
      operation_id: "new-pulled-operation",
    })).toThrow(/multiple historical rows/);
    expect(database.getAllSync<{ id: string; session_id: string; status: string }>(
      `SELECT id, session_id, status FROM attendance
        WHERE center_id = ? AND student_id = 'student-a'
        ORDER BY id`,
      [centerId],
    )).toEqual([
      {
        id: "alias-history-attendance",
        session_id: "device-session-alias",
        status: "absent",
      },
      {
        id: "canonical-history-attendance",
        session_id: "canonical-session",
        status: "present",
      },
    ]);
  });

  it("retries the same activation operation after offline delivery and a lost acknowledgement", async () => {
    const centerId = `activation-response-loss-${Date.now()}`;
    createClientDatabase("activation-response-loss-device", centerId);
    const server = new SharedServerAdapter();
    SyncEngine.setAdapter(server);
    const sessionId = `activation-session-${Date.now()}`;
    const operationId = `op-session-activate-${sessionId}`;
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: "activation-test-user",
      deviceId: "activation-test-device",
      operationType: "UPDATE",
      entityType: "session",
      entityId: sessionId,
      payload: { action: "activate", status: "open" },
    });

    ConnectivityService.setState("offline");
    SyncEngine.clearRateLimitForTesting();
    expect((await SyncEngine.syncCenterNow(centerId)).state).toBe("offline");
    expect(SyncRepository.getByOperationId(operationId)?.status).toBe("pending");

    ConnectivityService.setState("online");
    server.loseNextPushResponse = true;
    SyncEngine.clearRateLimitForTesting();
    expect((await SyncEngine.syncCenterNow(centerId)).state).toBe("error");
    expect(SyncRepository.getByOperationId(operationId)?.status).toBe("failed");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    SyncEngine.clearRateLimitForTesting();
    expect((await SyncEngine.syncCenterNow(centerId)).syncedCount).toBe(1);
    expect(server.changes.filter((change) => change.operationId === operationId)).toHaveLength(1);
    expect(server.changes.find((change) => change.operationId === operationId)?.data)
      .toMatchObject({ action: "activate", status: "open" });
    expect(SyncRepository.getPendingOperations(centerId)).toHaveLength(0);
  });

  it("hides alias sessions from operational lists and scanner selection while retaining historical lookup", () => {
    const centerId = `session-alias-visibility-${Date.now()}`;
    const database = createClientDatabase("session-alias-visibility", centerId);
    const date = "2035-06-01";
    const timestamp = new Date().toISOString();
    const groupId = `alias-group-${Date.now()}`;
    const scheduleId = `alias-schedule-${Date.now()}`;
    const studentId = `alias-student-${Date.now()}`;
    const aliasId = stableSessionId(centerId, groupId, scheduleId, date);
    const canonicalId = `canonical-${aliasId}`;
    const teacherId = `alias-teacher-${groupId}`;
    const subjectId = `alias-subject-${groupId}`;
    const previousAuth = useAuthStore.getState();
    const viewer: User = {
      id: "session-alias-viewer",
      fullName: "Session alias test",
      phone: "",
      role: "admin",
      centerId,
      centerIds: [centerId],
      permissions: [
        "sessions.view",
        "sessions.generate",
        "groups.view",
        "groups.schedule.manage",
        "groups.students.view",
        "enrollments.view",
        "students.view",
        "attendance.create",
      ] satisfies Permission[],
    };

    database.runSync(
      `INSERT INTO teachers (id, center_id, name, status, created_at, updated_at)
       VALUES (?, ?, 'Alias test teacher', 'active', ?, ?)`,
      [teacherId, centerId, timestamp, timestamp],
    );
    database.runSync(
      `INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at)
       VALUES (?, ?, 'Alias test subject', 'ALIAS', 'active', ?, ?)`,
      [subjectId, centerId, timestamp, timestamp],
    );
    database.runSync(
      `INSERT INTO groups
         (id, center_id, name, teacher_id, subject_id, grade, default_fee,
          session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, ?, 'Alias test group', ?, ?, 'Grade 8', 0, 100, 0,
               'active', ?, ?)`,
      [groupId, centerId, teacherId, subjectId, timestamp, timestamp],
    );
    database.runSync(
      `INSERT INTO group_schedules
         (id, center_id, group_id, day_of_week, start_time, end_time,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '10:00', '11:00', 'active', ?, ?)`,
      [
        scheduleId,
        centerId,
        groupId,
        new Date(`${date}T12:00:00`).getDay(),
        timestamp,
        timestamp,
      ],
    );
    for (const sessionId of [canonicalId, aliasId]) {
      database.runSync(
        `INSERT INTO sessions
           (id, center_id, group_id, schedule_id, subject_id, teacher_id,
            session_price, late_after_minutes, session_date, start_time,
            end_time, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 100, 15, ?, '10:00', '11:00', 'open', ?, ?)`,
        [
          sessionId,
          centerId,
          groupId,
          scheduleId,
          subjectId,
          teacherId,
          date,
          timestamp,
          timestamp,
        ],
      );
    }
    database.runSync(
      `INSERT INTO session_id_aliases
         (center_id, local_session_id, canonical_session_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [centerId, aliasId, canonicalId, timestamp],
    );
    insertStudent(database, studentId, centerId);
    for (const sessionId of [canonicalId, aliasId]) {
      database.runSync(
        `INSERT INTO session_expected_students
           (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`expected-${sessionId}`, centerId, sessionId, studentId, timestamp],
      );
    }

    useAuthStore.setState({ activeCenterId: centerId, currentUser: viewer });
    try {
      expect(SessionRepository.getSessionsForDate(date).map(({ id }) => id)).toEqual([canonicalId]);
      expect(SessionRepository.getSessionsForMonth(date.slice(0, 7)).map(({ id }) => id))
        .toEqual([canonicalId]);
      expect(SessionGenerationService.getSessionsForDate(date).map(({ id }) => id))
        .toEqual([canonicalId]);
      expect(AttendanceSessionService.getTodaySessions(date).map(({ id }) => id))
        .toEqual([canonicalId]);
      expect(ScannerService.getEligibleSessionsForStudent(studentId, date).map(({ id }) => id))
        .toEqual([canonicalId]);
      expect(AttendanceSessionService.ensureSessionForGroup(groupId, date, scheduleId).id)
        .toBe(canonicalId);
      expect(SessionRepository.findById(aliasId)?.id).toBe(aliasId);
    } finally {
      useAuthStore.setState({
        activeCenterId: previousAuth.activeCenterId,
        currentUser: previousAuth.currentUser,
      });
    }
  });

  it("runs four independent real SyncEngine clients through push, pull, retry, offline recovery, and restart", async () => {
    const centerId = `engine-center-${Date.now()}`;
    const server = new SharedServerAdapter();
    SyncEngine.setAdapter(server);
    const clients = Array.from({ length: 4 }, (_, index) =>
      createClientDatabase(`device-${index + 1}`, centerId),
    );

    for (let index = 0; index < clients.length; index += 1) {
      DatabaseService.setMockDb(clients[index]);
      enqueueTeacher(centerId, index + 1, `engine-create-${index + 1}`);
      SyncEngine.clearRateLimitForTesting();
      const result = await SyncEngine.syncCenterNow(centerId);
      expect(result.state).toBe("online");
      expect(result.syncedCount).toBe(1);
      expect(result.errors).toBe(0);
      if (index === 0) {
        expect(SyncRepository.getServerCursor(centerId)).toBe("100");
      }
    }

    for (const client of clients) {
      DatabaseService.setMockDb(client);
      SyncEngine.clearRateLimitForTesting();
      const result = await SyncEngine.syncCenterNow(centerId);
      expect(result.errors).toBe(0);
      expect(SyncRepository.getServerCursor(centerId)).toBe(String(server.sequence));
      expect(client.getAllSync<{ id: string }>(
        "SELECT id FROM teachers WHERE center_id = ? AND id LIKE 'engine-teacher-%'",
        [centerId],
      )).toHaveLength(4);
    }

    DatabaseService.setMockDb(clients[0]);
    enqueueTeacher(centerId, 1, "engine-response-loss", "engine-teacher-loss");
    server.loseNextPushResponse = true;
    SyncEngine.clearRateLimitForTesting();
    const lostResponse = await SyncEngine.syncCenterNow(centerId);
    expect(lostResponse.state).toBe("error");
    expect(clients[0].getFirstSync<{ status: string }>(
      "SELECT status FROM sync_operations WHERE operation_id = ?",
      ["engine-response-loss"],
    )?.status).toBe("failed");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(SyncRepository.getPendingOperations(centerId).some(
      (operation) => operation.operationId === "engine-response-loss",
    )).toBe(true);
    SyncEngine.clearRateLimitForTesting();
    const retried = await SyncEngine.syncCenterNow(centerId);
    expect(retried.syncedCount).toBe(1);
    expect(server.changes.filter(
      (change) => change.operationId === "engine-response-loss",
    )).toHaveLength(1);
    expect(SyncRepository.getPendingOperations(centerId)).toHaveLength(0);

    enqueueTeacher(centerId, 1, "engine-offline-reconnect", "engine-teacher-offline");
    ConnectivityService.setState("offline");
    SyncEngine.clearRateLimitForTesting();
    const offline = await SyncEngine.syncCenterNow(centerId);
    expect(offline.state).toBe("offline");
    expect(SyncRepository.getPendingOperations(centerId)).toHaveLength(1);
    const pushesWhileOffline = server.pushCalls;

    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();
    const reconnected = await SyncEngine.syncCenterNow(centerId);
    expect(reconnected.syncedCount).toBe(1);
    expect(server.pushCalls).toBe(pushesWhileOffline + 1);

    const cursorBeforeRestart = SyncRepository.getServerCursor(centerId);
    const closedIndex = openedDatabases.indexOf(clients[0]);
    if (closedIndex >= 0) openedDatabases.splice(closedIndex, 1);
    clients[0].close();
    const restartedDatabase = new RealSqliteDatabase(clients[0].filename);
    openedDatabases.push(restartedDatabase);
    DatabaseService.setMockDb(restartedDatabase);
    expect(SyncRepository.getServerCursor(centerId)).toBe(cursorBeforeRestart);

    SyncEngine.clearRateLimitForTesting();
    const afterRestart = await SyncEngine.syncCenterNow(centerId);
    expect(afterRestart.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe(String(server.sequence));
    expect(restartedDatabase.getAllSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id LIKE 'engine-teacher-%'",
      [centerId],
    )).toHaveLength(6);

    const pullsBeforeRateLimit = server.pullCalls;
    const rateLimited = await SyncEngine.syncCenterNow(centerId);
    expect(rateLimited.state).toBe("online");
    expect(server.pullCalls).toBe(pullsBeforeRateLimit);
  });

  it("keeps local session IDs mapped for pending operations and prevents stale session resurrection", () => {
    const centerId = `session-alias-center-${Date.now()}`;
    const database = createClientDatabase("session-alias-device", centerId);
    const oldSessionId = "legacy-local-session";
    const canonicalSessionId = "server-canonical-session";
    const timestamp = new Date().toISOString();
    database.runSync(
      `INSERT INTO sessions
         (id, center_id, group_id, session_date, start_time, end_time, status, schedule_id, created_at)
       VALUES (?, ?, 'sync-group', '2026-10-12', '10:00', '11:00', 'cancelled', NULL, ?)`,
      [canonicalSessionId, centerId, timestamp],
    );
    const historicalDuplicateId = "historical-duplicate-session";
    database.runSync(
      `INSERT INTO sessions
         (id, center_id, group_id, session_date, start_time, end_time, status, schedule_id, created_at)
       VALUES (?, ?, 'sync-group', '2026-10-12', '10:00', '11:00', 'open', NULL, ?)`,
      [historicalDuplicateId, centerId, timestamp],
    );
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          is_late, attendance_type, operation_id)
       VALUES ('historical-attendance', ?, 'history-student', ?, ?, 'present', 0, 'present', 'historical-attendance-operation')`,
      [centerId, historicalDuplicateId, timestamp],
    );
    database.runSync(
      `INSERT INTO session_expected_students
         (id, center_id, session_id, student_id, created_at)
       VALUES ('historical-expected-student', ?, ?, 'history-student', ?)`,
      [centerId, historicalDuplicateId, timestamp],
    );
    database.runSync(
      `INSERT INTO payments
         (id, operation_id, center_id, student_id, amount, payment_type, created_at, user_id)
       VALUES ('historical-payment', 'historical-payment-operation', ?, 'history-student', 25, 'session', ?, 'history-user')`,
      [centerId, timestamp],
    );
    database.runSync(
      "UPDATE payments SET session_id = ? WHERE id = 'historical-payment'",
      [historicalDuplicateId],
    );
    SyncRepository.recordSessionMappings(centerId, [{
      localSessionId: oldSessionId,
      canonicalSessionId,
    }]);
    SyncRepository.enqueueOperation({
      operationId: "pending-legacy-session-attendance",
      centerId,
      userId: "sync-user",
      deviceId: "sync-device",
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: "legacy-attendance",
      payload: {
        id: "legacy-attendance",
        sessionId: oldSessionId,
        studentId: "sync-student",
      },
    });

    const pending = SyncRepository.getByOperationId("pending-legacy-session-attendance")!;
    const prepared = SyncRepository.prepareOperationForPush({
      operationId: pending.operationId,
      centerId: pending.centerId,
      userId: pending.userId,
      deviceId: pending.deviceId,
      operationType: pending.operationType,
      entityType: pending.entityType,
      entityId: pending.entityId,
      payload: typeof pending.payload === "string" ? JSON.parse(pending.payload) : pending.payload,
      createdAt: pending.createdAt,
    });
    expect(prepared.payload.sessionId).toBe(oldSessionId);
    expect(database.getFirstSync<{ payload: string }>(
      "SELECT payload FROM sync_operations WHERE operation_id = ?",
      [pending.operationId],
    )?.payload).toContain(oldSessionId);
    expect(SyncRepository.resolveSessionAlias("different-center", oldSessionId)).toBe(oldSessionId);

    SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: 1,
      entityType: "session",
      entityId: canonicalSessionId,
      action: "create",
      data: {
        id: canonicalSessionId,
        groupId: "sync-group",
        scheduleId: null,
        sessionDate: "2026-10-12",
        startTime: "10:00",
        endTime: "11:00",
        status: "open",
      },
      serverTimestamp: timestamp,
    }]);
    expect(database.getFirstSync<{ status: string }>(
      "SELECT status FROM sessions WHERE center_id = ? AND id = ?",
      [centerId, canonicalSessionId],
    )?.status).toBe("cancelled");
    expect(SyncRepository.resolveSessionAlias(centerId, historicalDuplicateId))
      .toBe(historicalDuplicateId);
    expect(database.getFirstSync<{ id: string }>(
      "SELECT id FROM sessions WHERE center_id = ? AND id = ?",
      [centerId, historicalDuplicateId],
    )?.id).toBe(historicalDuplicateId);
    expect(database.getFirstSync<{ sessionId: string }>(
      "SELECT session_id as sessionId FROM attendance WHERE id = 'historical-attendance'",
    )?.sessionId).toBe(historicalDuplicateId);
    expect(database.getFirstSync<{ sessionId: string }>(
      "SELECT session_id as sessionId FROM payments WHERE id = 'historical-payment'",
    )?.sessionId).toBe(historicalDuplicateId);
    expect(database.getFirstSync<{ sessionId: string }>(
      "SELECT session_id as sessionId FROM session_expected_students WHERE id = 'historical-expected-student'",
    )?.sessionId).toBe(historicalDuplicateId);
  });

  it("retries only missing attendance-session dependencies and leaves center mismatches permanent", () => {
    expect(isRetryableDependencyConflict(
      "ATTENDANCE_SESSION_NOT_FOUND: attendance session has not synchronized yet.",
    )).toBe(true);
    expect(isRetryableDependencyConflict(
      "ATTENDANCE_TARGET_NOT_FOUND: legacy server could not find the session yet.",
    )).toBe(true);
    expect(isRetryableDependencyConflict(
      "ATTENDANCE_SESSION_CENTER_MISMATCH: session is outside the authenticated center.",
    )).toBe(false);
    expect(isRetryableDependencyConflict(
      "ATTENDANCE_STUDENT_NOT_FOUND: attendance student does not exist.",
    )).toBe(false);
    expect(isRetryableDependencyConflict(
      'violates foreign key constraint "sessions_group_id_fkey"',
    )).toBe(false);
  });

  it("requeues dependency conflicts only after the matching session or explicit absence arrives", () => {
    const centerId = `dependency-arrival-${Date.now()}`;
    const database = createClientDatabase("dependency-arrival-device", centerId);
    insertSession(database, "dependency-target", centerId);
    insertSession(database, "dependency-source", centerId, "open", "2026-10-08");
    DatabaseService.setMockDb(database);

    SyncRepository.enqueueOperation({
      operationId: "waiting-present-attendance",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: "waiting-present-record",
      payload: {
        id: "waiting-present-record",
        sessionId: "dependency-target",
        studentId: "dependency-student",
        status: "present",
      },
    });
    database.runSync(
      `UPDATE sync_operations
          SET status = 'conflict',
              last_error = 'ATTENDANCE_TARGET_NOT_FOUND: session has not synchronized yet.'
        WHERE operation_id = 'waiting-present-attendance'`,
    );
    expect(SyncRepository.requeueResolvedAttendanceDependencies(centerId)).toBe(0);
    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(["dependency-target"]),
    )).toBe(1);
    expect(SyncRepository.getByOperationId("waiting-present-attendance")?.status)
      .toBe("pending");

    SyncRepository.enqueueOperation({
      operationId: "waiting-makeup-attendance",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: "waiting-makeup-record",
      payload: {
        id: "waiting-makeup-record",
        sessionId: "dependency-target",
        studentId: "dependency-student",
        status: "present",
        attendanceType: "makeup",
        originalAbsenceId: "dependency-source",
      },
    });
    database.runSync(
      `UPDATE sync_operations
          SET status = 'conflict',
              last_error = 'ATTENDANCE_TARGET_NOT_FOUND: dependency not synchronized yet.'
        WHERE operation_id = 'waiting-makeup-attendance'`,
    );
    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(["dependency-target"]),
    )).toBe(0);

    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          attendance_type, operation_id)
       VALUES ('dependency-source-absence', ?, 'dependency-student',
               'dependency-source', '2026-10-08T10:00:00.000Z', 'absent',
               'present', 'dependency-source-absence-operation')`,
      [centerId],
    );
    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(),
      new Set(["dependency-source-absence"]),
    )).toBe(1);
    expect(SyncRepository.getByOperationId("waiting-makeup-attendance")?.status)
      .toBe("pending");
  });

  it("requeues an attendance cancellation only after its attendance dependency arrives", () => {
    const centerId = `cancel-dependency-arrival-${Date.now()}`;
    const database = createClientDatabase("cancel-dependency-arrival", centerId);
    insertSession(database, "cancel-dependency-session", centerId);
    insertStudent(database, "cancel-dependency-student", centerId);
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          attendance_type, operation_id)
       VALUES ('cancel-dependency-record', ?, 'cancel-dependency-student',
               'cancel-dependency-session', '2026-10-15T10:00:00.000Z',
               'absent', 'present', 'cancel-dependency-create')`,
      [centerId],
    );
    DatabaseService.setMockDb(database);

    const payload = {
      id: "cancel-dependency-record",
      sessionId: "cancel-dependency-session",
      studentId: "cancel-dependency-student",
      status: "absent",
      expectedOperationId: "cancel-dependency-create",
      action: "attendance.cancel",
    };
    SyncRepository.enqueueOperation({
      operationId: "waiting-attendance-cancel",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "attendance.cancel",
      entityType: "attendance",
      entityId: payload.id,
      payload,
    });
    database.runSync(
      `UPDATE sync_operations
          SET status = 'failed',
              last_error = 'ATTENDANCE_CANCEL_TARGET_NOT_FOUND: attendance has not synchronized yet.'
        WHERE operation_id = 'waiting-attendance-cancel'`,
    );

    expect(isRetryableDependencyConflict(
      "ATTENDANCE_CANCEL_TARGET_NOT_FOUND: attendance has not synchronized yet.",
    )).toBe(true);
    expect(SyncRepository.requeueResolvedAttendanceDependencies(centerId)).toBe(0);
    expect(SyncRepository.getByOperationId("waiting-attendance-cancel")?.status)
      .toBe("failed");

    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(),
      new Set(["cancel-dependency-record"]),
    )).toBe(1);
    const requeued = SyncRepository.getByOperationId("waiting-attendance-cancel");
    expect(requeued?.status).toBe("pending");
    expect(requeued?.payload).toBe(JSON.stringify(payload));
  });

  it("requeues coverage, absence notification, delivery, and payment dependencies after their parents arrive", () => {
    const centerId = `mixed-dependency-arrival-${Date.now()}`;
    const database = createClientDatabase("mixed-dependency-arrival", centerId);
    insertSession(database, "retry-source-session", centerId, "open", "2026-10-08");
    insertSession(database, "retry-target-session", centerId, "open", "2026-10-15");
    insertStudent(database, "retry-student", centerId);
    insertDebtCycle(database, "retry-debt-cycle", centerId, "retry-student");
    database.runSync(
      `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          attendance_type, operation_id)
       VALUES ('retry-explicit-absence', ?, 'retry-student',
               'retry-source-session', '2026-10-08T10:00:00.000Z',
               'absent', 'present', 'retry-explicit-absence-operation')`,
      [centerId],
    );
    database.runSync(
      `INSERT INTO notification_events
         (id, operation_id, center_id, student_id, session_id, attendance_id,
          event_type, created_by, created_at)
       VALUES ('retry-absence-event', 'retry-absence-event-operation', ?,
               'retry-student', 'retry-source-session',
               'retry-explicit-absence', 'absence', 'test-user', ?)`,
      [centerId, new Date().toISOString()],
    );
    DatabaseService.setMockDb(database);

    const waitingOperations = [
      {
        operationId: "waiting-coverage",
        entityType: "advance_coverage",
        entityId: "waiting-coverage-row",
        operationType: "advance_coverage.create",
        payload: {
          id: "waiting-coverage-row",
          studentId: "retry-student",
          advanceSessionId: "retry-source-session",
          targetFutureSessionId: "retry-target-session",
        },
        lastError: "ADVANCE_COVERAGE_SESSION_NOT_FOUND: referenced session has not synchronized yet.",
      },
      {
        operationId: "waiting-absence-event",
        entityType: "notification_event",
        entityId: "retry-absence-event",
        operationType: "notification_event.create",
        payload: {
          id: "retry-absence-event",
          event_type: "absence",
          student_id: "retry-student",
          session_id: "retry-source-session",
          attendance_id: "retry-explicit-absence",
        },
        lastError: "ABSENCE_NOTIFICATION_TARGET_NOT_FOUND: attendance has not synchronized yet.",
      },
      {
        operationId: "waiting-delivery",
        entityType: "notification_delivery",
        entityId: "retry-delivery",
        operationType: "notification_delivery.create",
        payload: {
          id: "retry-delivery",
          notificationEventId: "retry-absence-event",
          channel: "sms",
        },
        lastError: "NOTIFICATION_EVENT_NOT_FOUND: delivery event has not synchronized yet.",
      },
      {
        operationId: "waiting-payment",
        entityType: "payment",
        entityId: "retry-payment",
        operationType: "payment.create",
        payload: {
          id: "retry-payment",
          studentId: "retry-student",
          debtCycleId: "retry-debt-cycle",
          amount: 25,
        },
        lastError: "PAYMENT_DEBT_CYCLE_NOT_FOUND",
      },
    ];
    for (const operation of waitingOperations) {
      SyncRepository.enqueueOperation({
        ...operation,
        centerId,
        userId: "dependency-user",
        deviceId: "dependency-device",
      });
      database.runSync(
        `UPDATE sync_operations
            SET status = 'conflict', last_error = ?
          WHERE operation_id = ?`,
        [operation.lastError, operation.operationId],
      );
    }

    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(),
      new Set(),
      new Map([["student", new Set(["unrelated-student"])]]),
    )).toBe(0);
    const arrivedEntityIds = new Map([
      ["session", new Set(["retry-source-session", "retry-target-session"])],
      ["student", new Set(["retry-student"])],
      ["attendance", new Set(["retry-explicit-absence"])],
      ["debt_cycle", new Set(["retry-debt-cycle"])],
      ["notification_event", new Set(["retry-absence-event"])],
    ]);
    expect(SyncRepository.requeueResolvedAttendanceDependencies(
      centerId,
      new Set(["retry-source-session", "retry-target-session"]),
      new Set(["retry-explicit-absence"]),
      arrivedEntityIds,
    )).toBe(4);

    for (const operation of waitingOperations) {
      expect(SyncRepository.getByOperationId(operation.operationId)?.status)
        .toBe("pending");
      expect(SyncRepository.getByOperationId(operation.operationId)?.payload)
        .toBe(JSON.stringify(operation.payload));
    }
  });

  it("requeues a waiting notification delivery when its pulled event arrives", () => {
    const centerId = `notification-event-arrival-${Date.now()}`;
    const database = createClientDatabase("notification-event-arrival", centerId);
    DatabaseService.setMockDb(database);
    SyncRepository.enqueueOperation({
      operationId: "notification-delivery-waits-for-event",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "notification_delivery.create",
      entityType: "notification_delivery",
      entityId: "waiting-delivery",
      payload: {
        id: "waiting-delivery",
        notificationEventId: "arriving-event",
        channel: "sms",
      },
    });
    database.runSync(
      `UPDATE sync_operations
          SET status = 'failed',
              last_error = 'NOTIFICATION_EVENT_NOT_FOUND: delivery event has not synchronized yet.'
        WHERE operation_id = 'notification-delivery-waits-for-event'`,
    );

    SyncEngine.applyServerChanges(centerId, [{
      sequenceNumber: 202,
      operationId: "arriving-event-operation",
      entityType: "notification_event",
      entityId: "arriving-event",
      action: "create",
      data: {
        id: "arriving-event",
        student_id: "event-student",
        session_id: "event-session",
        event_type: "attendance",
        created_by: "test-user",
        created_at: "2026-10-15T12:00:00.000Z",
      },
      serverTimestamp: "2026-10-15T12:01:00.000Z",
    }]);

    expect(database.getFirstSync<{ id: string }>(
      "SELECT id FROM notification_events WHERE id = 'arriving-event'",
    )?.id).toBe("arriving-event");
    expect(SyncRepository.getByOperationId(
      "notification-delivery-waits-for-event",
    )?.status).toBe("pending");
  });

  it("keeps a missing-session attendance operation in the retry queue until the session arrives", async () => {
    const centerId = `attendance-dependency-${Date.now()}`;
    const database = createClientDatabase("attendance-dependency-device", centerId);
    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    SyncRepository.enqueueOperation({
      operationId: "attendance-waits-for-session",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: "dependency-attendance",
      payload: {
        id: "dependency-attendance",
        sessionId: "dependency-session",
        studentId: "dependency-student",
        status: "present",
        attendanceType: "present",
      },
    });
    adapter.response = {
      success: true,
      syncedOperationIds: [],
      conflicts: [{
        operationId: "attendance-waits-for-session",
        entityType: "attendance",
        entityId: "dependency-attendance",
        reason: "ATTENDANCE_SESSION_NOT_FOUND: attendance session has not synchronized yet.",
        resolution: "server_wins",
      }],
      serverCursor: "100",
      processedAt: new Date().toISOString(),
    };

    DatabaseService.setMockDb(database);
    const waiting = await SyncEngine.syncCenterNow(centerId);
    expect(waiting.conflicts).toBe(0);
    expect(SyncRepository.getByOperationId("attendance-waits-for-session")?.status).toBe("failed");

    SyncRepository.enqueueOperation({
      operationId: "create-dependent-session",
      centerId,
      userId: "dependency-user",
      deviceId: "dependency-device",
      operationType: "create",
      entityType: "session",
      entityId: "dependency-session",
      payload: { id: "dependency-session", groupId: "dependency-group", sessionDate: "2026-10-13" },
    });
    database.runSync(
      "UPDATE sync_operations SET next_retry_at = ? WHERE operation_id = ?",
      ["2000-01-01T00:00:00.000Z", "attendance-waits-for-session"],
    );
    adapter.response = {
      success: true,
      syncedOperationIds: ["create-dependent-session", "attendance-waits-for-session"],
      conflicts: [],
      serverCursor: "100",
      processedAt: new Date().toISOString(),
    };

    SyncEngine.clearRateLimitForTesting();
    const retried = await SyncEngine.syncCenterNow(centerId);
    expect(retried.syncedCount).toBe(2);
    expect(database.getAllSync<{ operationId: string }>(
      "SELECT operation_id as operationId FROM sync_operations WHERE operation_id = ?",
      ["attendance-waits-for-session"],
    )).toHaveLength(1);
    expect(SyncRepository.getByOperationId("attendance-waits-for-session")?.status).toBe("synced");
  });

  it("synchronizes a teacher week-start change from one persistent device database to another", async () => {
    const centerId = `teacher-week-sync-${Date.now()}`;
    const teacherId = "shared-week-teacher";
    const timestamp = new Date().toISOString();
    const firstDevice = createClientDatabase("teacher-week-device-1", centerId);
    const secondDevice = createClientDatabase("teacher-week-device-2", centerId);
    for (const database of [firstDevice, secondDevice]) {
      database.runSync(
        `INSERT INTO teachers (id, center_id, name, status, week_start_day, created_at, updated_at)
         VALUES (?, ?, 'Shared teacher', 'active', 6, ?, ?)`,
        [teacherId, centerId, timestamp, timestamp],
      );
    }

    const server = new SharedServerAdapter();
    SyncEngine.setAdapter(server);
    try {
      const changedAt = new Date(Date.now() + 1).toISOString();
      firstDevice.runSync(
        "UPDATE teachers SET week_start_day = ?, updated_at = ? WHERE center_id = ? AND id = ?",
        [2, changedAt, centerId, teacherId],
      );
      DatabaseService.setMockDb(firstDevice);
      SyncRepository.enqueueOperation({
        operationId: "teacher-week-device-1-update",
        centerId,
        userId: "admin-user",
        deviceId: "device-1",
        operationType: "UPDATE",
        entityType: "teacher",
        entityId: teacherId,
        payload: {
          id: teacherId,
          teacherId,
          weekStartDay: 2,
          baseUpdatedAt: timestamp,
          updatedAt: changedAt,
        },
      });

      const firstSync = await SyncEngine.syncCenterNow(centerId);
      expect(firstSync.errors).toBe(0);

      DatabaseService.setMockDb(secondDevice);
      SyncEngine.clearRateLimitForTesting();
      const secondSync = await SyncEngine.syncCenterNow(centerId);
      expect(secondSync.errors).toBe(0);
      expect(secondDevice.getFirstSync<{ week_start_day: number; name: string }>(
        "SELECT week_start_day, name FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 2, name: "Shared teacher" });
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("keeps a newer server week-start over an older pending local edit through conflict resolution and restart", async () => {
    const centerId = `teacher-week-stale-${Date.now()}`;
    const teacherId = "stale-week-teacher";
    const baseUpdatedAt = "2026-10-01T10:00:00.000Z";
    const localUpdatedAt = "2026-10-02T10:00:00.000Z";
    const serverUpdatedAt = "2026-10-03T10:00:00.000Z";
    const device = createClientDatabase("teacher-week-stale-device", centerId);
    device.runSync(
      `INSERT INTO teachers (id, center_id, name, status, week_start_day, created_at, updated_at)
       VALUES (?, ?, 'Teacher', 'active', 6, ?, ?)`,
      [teacherId, centerId, baseUpdatedAt, baseUpdatedAt],
    );
    device.runSync(
      "UPDATE teachers SET week_start_day = ?, updated_at = ? WHERE center_id = ? AND id = ?",
      [2, localUpdatedAt, centerId, teacherId],
    );
    SyncRepository.enqueueOperation({
      operationId: "old-pending-week-start",
      centerId,
      userId: "admin-user",
      deviceId: "offline-device",
      operationType: "UPDATE",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        teacherId,
        weekStartDay: 2,
        baseUpdatedAt,
        updatedAt: localUpdatedAt,
      },
    });

    const server = new StaleTeacherUpdateAdapter();
    server.sequence = 101;
    server.changes.push({
      sequenceNumber: 101,
      operationId: "newer-server-week-start",
      entityType: "teacher",
      entityId: teacherId,
      action: "update",
      data: {
        id: teacherId,
        name: "Teacher",
        status: "active",
        weekStartDay: 4,
        updatedAt: serverUpdatedAt,
      },
      serverTimestamp: serverUpdatedAt,
    });
    SyncEngine.setAdapter(server);
    DatabaseService.setMockDb(device);
    try {
      const firstSync = await SyncEngine.syncCenterNow(centerId);
      expect(firstSync.conflicts).toBe(1);
      expect(device.getFirstSync<{ week_start_day: number }>(
        "SELECT week_start_day FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 4 });
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("conflict");
      expect(SyncRepository.getConflicts(centerId).map((conflict) => conflict.operationId))
        .toContain("old-pending-week-start");

      SyncEngine.clearRateLimitForTesting();
      const resolvedSync = await SyncEngine.syncCenterNow(centerId);
      expect(resolvedSync.errors).toBe(0);
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("synced");
      expect(SyncRepository.getConflicts(centerId)).toHaveLength(0);

      const closedIndex = openedDatabases.indexOf(device);
      if (closedIndex >= 0) openedDatabases.splice(closedIndex, 1);
      device.close();
      const reopenedDevice = new RealSqliteDatabase(device.filename);
      openedDatabases.push(reopenedDevice);
      DatabaseService.setMockDb(reopenedDevice);
      expect(reopenedDevice.getFirstSync<{ week_start_day: number }>(
        "SELECT week_start_day FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 4 });
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("synced");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("keeps the persisted cursor unchanged when real SyncEngine cannot apply a pull batch", async () => {
    const centerId = `engine-failed-apply-${Date.now()}`;
    const database = createClientDatabase("failed-apply", centerId);
    SyncEngine.setAdapter(new InvalidChangeAdapter());

    const result = await SyncEngine.syncCenterNow(centerId);

    expect(result.state).toBe("error");
    expect(result.errors).toBe(1);
    expect(SyncRepository.getServerCursor(centerId)).toBe("100");
    expect(database.getFirstSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id = 'unsupported-entity'",
      [centerId],
    )).toBeNull();
  });

  it("retries only the selected legacy group schedule update with its original operation id and payload", async () => {
    const centerId = `engine-targeted-retry-${Date.now()}`;
    const database = createClientDatabase("targeted-retry", centerId);
    const targetOperationId = "legacy-schedule-update-10";
    SyncRepository.enqueueOperation({
      operationId: "other-schedule-history",
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: { id: "legacy-schedule-id", startTime: "08:00", endTime: "09:00" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', last_error = 'Unrelated historical conflict'
       WHERE operation_id = ?`,
      ["other-schedule-history"],
    );
    const originalPayload = {
      id: "legacy-schedule-id",
      groupId: "legacy-group-id",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "11:00",
      updatedAt: "2026-10-10T10:00:00.000Z",
    };
    SyncRepository.enqueueOperation({
      operationId: targetOperationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: originalPayload,
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', retry_count = 10,
           last_error = 'column "updated_at" does not exist'
       WHERE operation_id = ?`,
      [targetOperationId],
    );
    SyncRepository.enqueueOperation({
      operationId: "unrelated-pending-operation",
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group",
      entityId: "unrelated-group-id",
      payload: { id: "unrelated-group-id" },
    });

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      adapter.response.syncedOperationIds = [targetOperationId];
      const result = await SyncEngine.retryLegacyGroupScheduleUpdate(
        centerId,
        targetOperationId,
      );

      expect(result).toBe("synced");
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]).toHaveLength(1);
      expect(adapter.calls[0][0]).toMatchObject({
        operationId: targetOperationId,
        centerId,
        operationType: "UPDATE",
        entityType: "group_schedule",
        entityId: "legacy-schedule-id",
        payload: originalPayload,
      });
      expect(SyncRepository.getByOperationId(targetOperationId)?.retryCount).toBe(10);
      expect(SyncRepository.getByOperationId(targetOperationId)?.status).toBe("synced");
      expect(SyncRepository.getByOperationId("unrelated-pending-operation")?.status).toBe("pending");
      expect(SyncRepository.getByOperationId("other-schedule-history")?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("rejects targeted retry for a teacher schedule conflict without sending it", async () => {
    const centerId = `engine-targeted-conflict-${Date.now()}`;
    const database = createClientDatabase("targeted-conflict", centerId);
    const operationId = "legacy-schedule-teacher-conflict";
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: { id: "legacy-schedule-id" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', retry_count = 10,
           last_error = 'TEACHER_SCHEDULE_CONFLICT: column "updated_at" does not exist'
       WHERE operation_id = ?`,
      [operationId],
    );

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      await expect(
        SyncEngine.retryLegacyGroupScheduleUpdate(centerId, operationId),
      ).rejects.toThrow("العملية غير مؤهلة لإعادة المحاولة الآمنة");
      expect(adapter.calls).toHaveLength(0);
      expect(SyncRepository.getByOperationId(operationId)?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("reconciles a group-delete conflict from fresh server state before deciding whether to retry", async () => {
    const centerId = `engine-group-delete-retry-${Date.now()}`;
    const database = createClientDatabase("group-delete-retry", centerId);
    const operationId = `op-grp-delete-${Date.now()}-group-1`;
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "DELETE",
      entityType: "group",
      entityId: "group-1",
      payload: { id: "group-1" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', last_error = 'column "status" does not exist'
       WHERE operation_id = ?`,
      [operationId],
    );

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      adapter.bootstrapGroups = [{ id: "group-1", deleted: false }];
      adapter.response.syncedOperationIds = [operationId];
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, operationId),
      ).resolves.toBe("synced");
      expect(adapter.bootstrapCalls).toBe(1);
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]).toHaveLength(1);
      expect(adapter.calls[0][0]).toMatchObject({
        operationId,
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-1",
      });
      expect(SyncRepository.getByOperationId(operationId)?.status).toBe("synced");

      const alreadyDeletedId = `op-grp-delete-${Date.now()}-group-2`;
      SyncRepository.enqueueOperation({
        operationId: alreadyDeletedId,
        centerId,
        userId: "retry-user",
        deviceId: "retry-device",
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-2",
        payload: { id: "group-2" },
      });
      database.runSync(
        `UPDATE sync_operations
         SET status = 'conflict', last_error = 'column "status" does not exist'
         WHERE operation_id = ?`,
        [alreadyDeletedId],
      );
      adapter.bootstrapGroups = [{ id: "group-2", deleted: true }];
      const pushesBeforeAlreadyDeleted = adapter.calls.length;
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, alreadyDeletedId),
      ).resolves.toBe("already_deleted");
      expect(adapter.calls).toHaveLength(pushesBeforeAlreadyDeleted);
      expect(SyncRepository.getByOperationId(alreadyDeletedId)?.status).toBe("synced");

      const unknownStateId = `op-grp-delete-${Date.now()}-group-3`;
      SyncRepository.enqueueOperation({
        operationId: unknownStateId,
        centerId,
        userId: "retry-user",
        deviceId: "retry-device",
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-3",
        payload: { id: "group-3" },
      });
      database.runSync(
        `UPDATE sync_operations
         SET status = 'conflict', last_error = 'column "status" does not exist'
         WHERE operation_id = ?`,
        [unknownStateId],
      );
      adapter.bootstrapGroups = [];
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, unknownStateId),
      ).rejects.toThrow("تعذر التحقق من وجود المجموعة على الخادم");
      expect(adapter.calls).toHaveLength(pushesBeforeAlreadyDeleted);
      expect(SyncRepository.getByOperationId(unknownStateId)?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });
});
