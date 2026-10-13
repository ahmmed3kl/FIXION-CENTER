import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { ConnectivityService } from "../src/core/connectivity";
import { SyncRepository } from "../src/core/sync";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { Permission, User } from "../src/shared/types";

interface NativeStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
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
  private readonly connection: NativeSqlite;

  constructor(filename: string) {
    this.connection = new DatabaseSync(filename);
  }

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

const CENTER_ID = "legacy-roster-center";
const USER_ID = "legacy-roster-user";
const SOURCE_GROUP_ID = "legacy-roster-source-group";
const TARGET_GROUP_ID = "legacy-roster-target-group";
const SOURCE_SESSION_ID = "legacy-roster-source-session";
const PREVIOUS_MAKEUP_SESSION_ID = "legacy-roster-previous-makeup";
const CURRENT_SESSION_ID = "legacy-roster-current-session";
const VISITOR_IDS = ["legacy-visitor-1", "legacy-visitor-2", "legacy-visitor-3"];
const MEMBER_ID = "legacy-member-with-makeup";

describe("legacy compensation rows in expected session roster", () => {
  let tempDirectory: string;
  let database: RealSqliteDatabase;
  let originalDatabase: SqlDatabase;
  let databaseFilename: string;

  const setUser = () => {
    const user: User = {
      id: USER_ID,
      fullName: "Roster Test Staff",
      email: "roster-test@example.invalid",
      phone: "01000000000",
      role: "assistant",
      centerId: CENTER_ID,
      centerIds: [CENTER_ID],
      permissions: [
        "attendance.view",
        "reports.attendance.view",
        "attendance.create",
        "enrollments.view",
      ] as Permission[],
    };
    useAuthStore.setState({
      currentUser: user,
      activeCenterId: CENTER_ID,
      isAuthenticated: true,
      isLoading: false,
    });
  };

  const seedGroup = (id: string, name: string) => {
    database.runSync(
      `INSERT INTO groups
       (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, ?, ?, 'legacy-roster-teacher', 'legacy-roster-subject', 'Grade 1', 0, 0, 0, 'active', '2026-10-13', '2026-10-13')`,
      [id, CENTER_ID, name],
    );
  };

  const seedStudent = (id: string, code: string) => {
    database.runSync(
      `INSERT INTO students
       (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at, student_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Grade 1', 'active', '2026-10-13', ?, '2026-10-13')`,
      [id, CENTER_ID, `Student ${code}`, `CARD-${code}`, "01000000000", "01100000000", code],
    );
  };

  const seedSession = (id: string, groupId: string, date: string, status: string) => {
    database.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, 'legacy-roster-subject', 'legacy-roster-teacher', ?, '10:00', '12:00', ?, '2026-10-13')`,
      [id, CENTER_ID, groupId, date, status],
    );
  };

  const seedExpected = (sessionId: string, studentId: string, id = `exp-${sessionId}-${studentId}`) => {
    database.runSync(
      `INSERT OR IGNORE INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-13')`,
      [id, CENTER_ID, sessionId, studentId],
    );
  };

  const insertPaymentIndependentOutboxMarker = () => {
    SyncRepository.enqueueOperation({
      operationId: "unrelated-pending-roster-test-op",
      centerId: CENTER_ID,
      userId: USER_ID,
      deviceId: "roster-test-device",
      operationType: "UPDATE",
      entityType: "student",
      entityId: "unrelated-student",
      payload: { marker: "preserve" },
    });
  };

  beforeAll(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-legacy-roster-"));
    DatabaseService.init();
    originalDatabase = DatabaseService.getDb();
  });

  beforeEach(() => {
    databaseFilename = path.join(tempDirectory, `${Date.now()}-${Math.random()}.sqlite`);
    database = new RealSqliteDatabase(databaseFilename);
    DatabaseService.runMigrations(database);
    DatabaseService.setMockDb(database);
    ConnectivityService.setState("offline");
    database.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", [CENTER_ID, "Test Center", "LEGACY"]);
    database.runSync(
      `INSERT INTO teachers (id, center_id, name, status, created_at, updated_at)
       VALUES ('legacy-roster-teacher', ?, 'Teacher', 'active', '2026-10-13', '2026-10-13')`,
      [CENTER_ID],
    );
    database.runSync(
      `INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at)
       VALUES ('legacy-roster-subject', ?, 'Math', 'MATH', 'active', '2026-10-13', '2026-10-13')`,
      [CENTER_ID],
    );
    seedGroup(SOURCE_GROUP_ID, "Source group");
    seedGroup(TARGET_GROUP_ID, "Target group");
    for (const [index, id] of VISITOR_IDS.entries()) seedStudent(id, `99004${index + 1}`);
    seedStudent(MEMBER_ID, "990044");

    for (const studentId of [...VISITOR_IDS, MEMBER_ID]) {
      database.runSync(
        `INSERT INTO student_group_enrollments
         (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, '2099-10-01', 'active', '2026-10-13')`,
        [`enr-source-${studentId}`, CENTER_ID, studentId, SOURCE_GROUP_ID],
      );
    }
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-10-04', 'active', '2026-10-13')`,
      ["enr-target-member", CENTER_ID, MEMBER_ID, TARGET_GROUP_ID],
    );

    seedSession(SOURCE_SESSION_ID, SOURCE_GROUP_ID, "2099-10-01", "closed");
    seedSession(PREVIOUS_MAKEUP_SESSION_ID, TARGET_GROUP_ID, "2099-10-03", "closed");
    seedSession(CURRENT_SESSION_ID, TARGET_GROUP_ID, "2099-10-04", "open");
    for (const studentId of [...VISITOR_IDS, MEMBER_ID]) {
      seedExpected(SOURCE_SESSION_ID, studentId);
      database.runSync(
        `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES (?, ?, ?, ?, '2099-10-03T10:30:00.000Z', 'present', 0, 'makeup', ?, 0, ?)`,
        [`makeup-${studentId}`, CENTER_ID, studentId, PREVIOUS_MAKEUP_SESSION_ID, SOURCE_SESSION_ID, `op-makeup-${studentId}`],
      );
      if (VISITOR_IDS.includes(studentId)) {
        const compensationExpectedId = `exp-comp-${CURRENT_SESSION_ID}-${studentId}`;
        seedExpected(CURRENT_SESSION_ID, studentId, compensationExpectedId);
        // This exact enrollment ID is created by the old migration that
        // converted every session snapshot row into active membership.
        database.runSync(
          `INSERT INTO student_group_enrollments
           (id, center_id, student_id, group_id, start_date, status, created_at)
           VALUES (?, ?, ?, ?, '2026-09-01', 'active', '2026-09-01')`,
          [`enr-${compensationExpectedId}`, CENTER_ID, studentId, TARGET_GROUP_ID],
        );
      } else {
        seedExpected(CURRENT_SESSION_ID, studentId);
      }
    }
    setUser();
  });

  afterEach(() => {
    database.close();
    useAuthStore.setState({ currentUser: null, activeCenterId: null, isAuthenticated: false });
    ConnectivityService.setState("online");
  });

  afterAll(() => {
    DatabaseService.setMockDb(originalDatabase);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("removes three nonmember compensation visitors from expected and absent lists without rewriting their links", () => {
    expect(SessionRepository.getExpectedStudents(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([MEMBER_ID]);
    expect(AbsenceService.getAbsenteesForSession(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([MEMBER_ID]);
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toEqual({
      total: 1,
      present: 0,
      absent: 1,
      makeup: 0,
    });
    for (const studentId of VISITOR_IDS) {
      expect(AttendanceSessionService.isExpected(CURRENT_SESSION_ID, studentId)).toBe(false);
    }
    expect(AttendanceSessionService.isExpected(CURRENT_SESSION_ID, MEMBER_ID)).toBe(true);
    expect(database.getAllSync<{ id: string }>(
      `SELECT id FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND student_id IN (?, ?, ?)`,
      [CENTER_ID, TARGET_GROUP_ID, ...VISITOR_IDS],
    )).toHaveLength(3);
    expect(EnrollmentRepository.getActiveEnrollmentsForGroup(TARGET_GROUP_ID, "2099-10-04")
      .map((enrollment) => enrollment.studentId)).toEqual([MEMBER_ID]);
    expect(database.getAllSync<{ studentId: string; originalAbsenceId: string }>(
      `SELECT student_id as studentId, original_absence_id as originalAbsenceId
       FROM attendance WHERE center_id = ? AND session_id = ? ORDER BY student_id`,
      [CENTER_ID, PREVIOUS_MAKEUP_SESSION_ID],
    )).toEqual(
      [...VISITOR_IDS, MEMBER_ID].sort().map((studentId) => ({
        studentId,
        originalAbsenceId: SOURCE_SESSION_ID,
      })),
    );
  });

  it("keeps the eligible member after stale rows are replayed and SQLite is reopened", () => {
    insertPaymentIndependentOutboxMarker();
    const pendingBeforeActivation = SyncRepository.getPendingOperations(CENTER_ID)
      .map((operation) => operation.operationId);
    AttendanceSessionService.activate(CURRENT_SESSION_ID);
    const pendingSessionOperation = SyncRepository.getPendingOperations(CENTER_ID)
      .find((operation) => operation.entityId === CURRENT_SESSION_ID);
    expect(JSON.parse(pendingSessionOperation?.payload || "{}").expectedStudentIds).toEqual([MEMBER_ID]);

    // A pull/bootstrap can replay the old persisted expected rows. The app
    // must keep filtering them after reopening SQLite, without deleting them.
    for (const studentId of VISITOR_IDS) {
      seedExpected(CURRENT_SESSION_ID, studentId, `exp-${CURRENT_SESSION_ID}-${studentId}`);
    }
    database.close();
    database = new RealSqliteDatabase(databaseFilename);
    DatabaseService.setMockDb(database);
    setUser();

    expect(SessionRepository.getExpectedStudents(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([MEMBER_ID]);
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toMatchObject({
      total: 1,
      absent: 1,
    });
    expect(SyncRepository.getPendingOperations(CENTER_ID).map((operation) => operation.operationId))
      .toEqual(expect.arrayContaining(pendingBeforeActivation));
    expect(database.getAllSync<{ id: string }>(
      "SELECT id FROM session_expected_students WHERE center_id = ? AND session_id = ?",
      [CENTER_ID, CURRENT_SESSION_ID],
    )).toHaveLength(4);
  });
});
