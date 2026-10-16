import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { ConnectivityService } from "../src/core/connectivity";
import { SyncRepository } from "../src/core/sync";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { SessionDateService } from "../src/features/sessions/SessionDateService";
import { OperationalReportsService } from "../src/features/reports/OperationalReportsService";
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
        "attendance.makeup",
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

  it("keeps compensation visitors out of the roster while treating the real member as initially absent", () => {
    expect(SessionRepository.getExpectedStudents(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([MEMBER_ID]);
    expect(AbsenceService.getAbsenteesForSession(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([MEMBER_ID]);
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toEqual({
      total: 1,
      present: 0,
      absent: 1,
      notStarted: 0,
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
      notStarted: 0,
    });
    expect(SyncRepository.getPendingOperations(CENTER_ID).map((operation) => operation.operationId))
      .toEqual(expect.arrayContaining(pendingBeforeActivation));
    expect(database.getAllSync<{ id: string }>(
      "SELECT id FROM session_expected_students WHERE center_id = ? AND session_id = ?",
      [CENTER_ID, CURRENT_SESSION_ID],
    )).toHaveLength(4);
  });

  it("creates initial absences at session start and promotes one scan in place", async () => {
    const secondMemberId = "legacy-member-second";
    const coveredStudentId = "legacy-covered-student";
    database.runSync(
      "UPDATE sessions SET status = 'scheduled' WHERE center_id = ? AND id = ?",
      [CENTER_ID, CURRENT_SESSION_ID],
    );
    seedStudent(secondMemberId, "990045");
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-10-04', 'active', '2026-10-13')`,
      ["enr-target-second-member", CENTER_ID, secondMemberId, TARGET_GROUP_ID],
    );
    seedStudent(coveredStudentId, "990047");
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-10-01', 'active', '2026-10-13')`,
      [`enr-source-${coveredStudentId}`, CENTER_ID, coveredStudentId, SOURCE_GROUP_ID],
    );
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-10-04', 'active', '2026-10-13')`,
      [`enr-target-${coveredStudentId}`, CENTER_ID, coveredStudentId, TARGET_GROUP_ID],
    );
    seedExpected(SOURCE_SESSION_ID, coveredStudentId);
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status,
        is_late, attendance_type, original_absence_id, is_external, operation_id)
       VALUES (?, ?, ?, ?, '2099-10-01T10:30:00.000Z', 'present',
               0, 'present', NULL, 0, ?)`,
      [
        `att-advance-source-${coveredStudentId}`,
        CENTER_ID,
        coveredStudentId,
        SOURCE_SESSION_ID,
        `op-advance-source-${coveredStudentId}`,
      ],
    );
    database.runSync(
      `INSERT INTO advance_coverages
       (id, operation_id, center_id, student_id, advance_session_id,
        target_future_session_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-13')`,
      [
        `coverage-${coveredStudentId}`,
        `op-coverage-${coveredStudentId}`,
        CENTER_ID,
        coveredStudentId,
        SOURCE_SESSION_ID,
        CURRENT_SESSION_ID,
        USER_ID,
      ],
    );

    AttendanceSessionService.activate(CURRENT_SESSION_ID);

    const initialRows = database.getAllSync<{
      id: string;
      studentId: string;
      status: string;
      attendanceType: string;
      operationId: string;
    }>(
      `SELECT id, student_id as studentId, status,
              attendance_type as attendanceType, operation_id as operationId
       FROM attendance WHERE center_id = ? AND session_id = ?
       ORDER BY student_id`,
      [CENTER_ID, CURRENT_SESSION_ID],
    );
    expect(initialRows).toEqual(
      [MEMBER_ID, secondMemberId].sort().map((studentId) => ({
        id: `att-default-${CURRENT_SESSION_ID}-${studentId}`,
        studentId,
        status: "absent",
        attendanceType: "present",
        operationId: `op-att-default-${CURRENT_SESSION_ID}-${studentId}`,
      })),
    );
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toEqual({
      total: 3,
      present: 0,
      absent: 2,
      notStarted: 0,
      makeup: 0,
    });
    expect(AttendanceRepository.isAlreadyAttended(CURRENT_SESSION_ID, MEMBER_ID)).toBe(false);

    const promoted = await AttendanceRepository.recordAttendance({
      studentId: MEMBER_ID,
      sessionId: CURRENT_SESSION_ID,
      status: "present",
      isLate: false,
      checkInTime: "2099-10-04T10:30:00.000Z",
    });
    expect(promoted.id).toBe(`att-default-${CURRENT_SESSION_ID}-${MEMBER_ID}`);
    expect(AttendanceRepository.isAlreadyAttended(CURRENT_SESSION_ID, MEMBER_ID)).toBe(true);
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toEqual({
      total: 3,
      present: 1,
      absent: 1,
      notStarted: 0,
      makeup: 0,
    });
    expect(AbsenceService.getAbsenteesForSession(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([secondMemberId]);
    const coveredReport = OperationalReportsService.getStudentAttendanceReport(
      coveredStudentId,
      "2099-10-04",
      "2099-10-04",
    );
    expect(coveredReport.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: CURRENT_SESSION_ID, status: "covered" }),
    ]));
    expect(coveredReport.totals).toMatchObject({ coveredCount: 1, absentCount: 0 });

    const promotionOperation = SyncRepository.getByOperationId(promoted.operationId);
    expect(promotionOperation?.operationType).toBe("UPDATE");
    expect(JSON.parse(promotionOperation?.payload || "{}")).toMatchObject({
      action: "attendance.promote_default_absence",
      expectedOperationId: `op-att-default-${CURRENT_SESSION_ID}-${MEMBER_ID}`,
      status: "present",
    });
    const orderedOperationIds = SyncRepository.getPendingOperations(CENTER_ID)
      .map((operation) => operation.operationId);
    const initialAbsenceOperationIndex = orderedOperationIds.indexOf(
      `op-att-default-${CURRENT_SESSION_ID}-${MEMBER_ID}`,
    );
    const promotionOperationIndex = orderedOperationIds.indexOf(promoted.operationId);
    expect(initialAbsenceOperationIndex).toBeGreaterThanOrEqual(0);
    expect(promotionOperationIndex).toBeGreaterThan(initialAbsenceOperationIndex);

    await expect(AttendanceRepository.recordAttendance({
      studentId: MEMBER_ID,
      sessionId: CURRENT_SESSION_ID,
      status: "present",
      isLate: false,
      checkInTime: "2099-10-04T10:31:00.000Z",
    })).rejects.toThrow("تم تحضير الطالب مسبقًا");

    const newlyEnrolledStudentId = "legacy-member-added-during-session";
    seedStudent(newlyEnrolledStudentId, "990048");
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-10-04', 'active', '2026-10-13')`,
      [`enr-target-${newlyEnrolledStudentId}`, CENTER_ID, newlyEnrolledStudentId, TARGET_GROUP_ID],
    );
    AttendanceSessionService.addEnrolledStudentToOpenSession(
      CURRENT_SESSION_ID,
      newlyEnrolledStudentId,
    );
    const newStudentInitialAbsence = AttendanceRepository.getStudentAttendanceInSession(
      CURRENT_SESSION_ID,
      newlyEnrolledStudentId,
    );
    expect(newStudentInitialAbsence).toMatchObject({
      id: `att-default-${CURRENT_SESSION_ID}-${newlyEnrolledStudentId}`,
      status: "absent",
    });
    const newlyEnrolledAttendance = await AttendanceRepository.recordAttendance({
      studentId: newlyEnrolledStudentId,
      sessionId: CURRENT_SESSION_ID,
      status: "present",
      isLate: false,
      checkInTime: "2099-10-04T10:32:00.000Z",
    });
    expect(newlyEnrolledAttendance.id).toBe(newStudentInitialAbsence?.id);
    expect(AttendanceSessionService.getSummary(CURRENT_SESSION_ID)).toEqual({
      total: 4,
      present: 2,
      absent: 1,
      notStarted: 0,
      makeup: 0,
    });
    expect(AbsenceService.getAbsenteesForSession(CURRENT_SESSION_ID).map((student) => student.id))
      .toEqual([secondMemberId]);

    AttendanceSessionService.activate(CURRENT_SESSION_ID);
    expect(database.getAllSync<{ id: string }>(
      "SELECT id FROM attendance WHERE center_id = ? AND session_id = ?",
      [CENTER_ID, CURRENT_SESSION_ID],
    )).toHaveLength(3);
    expect(SyncRepository.getByOperationId(
      `op-att-default-${CURRENT_SESSION_ID}-${secondMemberId}`,
    )?.status).toBe("pending");
  });

  it("promotes a target-session initial absence to one linked makeup without changing the source absence", async () => {
    const studentId = "legacy-makeup-promotion-student";
    const sourceSessionId = "legacy-makeup-promotion-source";
    const targetSessionId = "legacy-makeup-promotion-target";
    const laterTargetSessionId = "legacy-makeup-promotion-later-target";
    seedStudent(studentId, "990046");
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-09-01', 'active', '2026-10-13')`,
      [`enr-makeup-source-${studentId}`, CENTER_ID, studentId, SOURCE_GROUP_ID],
    );
    database.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES (?, ?, ?, ?, '2099-09-01', 'active', '2026-10-13')`,
      [`enr-makeup-target-${studentId}`, CENTER_ID, studentId, TARGET_GROUP_ID],
    );
    seedSession(sourceSessionId, SOURCE_GROUP_ID, "2099-10-01", "closed");
    seedSession(targetSessionId, TARGET_GROUP_ID, "2099-10-02", "scheduled");
    seedExpected(sourceSessionId, studentId);
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status,
        is_late, attendance_type, original_absence_id, is_external, operation_id)
       VALUES (?, ?, ?, ?, '2099-10-01T10:30:00.000Z', 'absent',
               0, 'present', NULL, 0, ?)`,
      [`att-source-absence-${studentId}`, CENTER_ID, studentId, sourceSessionId, `op-source-absence-${studentId}`],
    );

    const currentDateSpy = jest
      .spyOn(SessionDateService, "getCurrentSessionDate")
      .mockReturnValue("2099-10-02");
    try {
      AttendanceSessionService.activate(targetSessionId);
      expect(AttendanceRepository.getStudentAttendanceInSession(targetSessionId, studentId))
        .toMatchObject({
          id: `att-default-${targetSessionId}-${studentId}`,
          status: "absent",
        });
      expect(MakeupService.getEligibilityForSession(targetSessionId, studentId))
        .toMatchObject({ eligible: true, originalAbsenceId: sourceSessionId });

      const makeup = await MakeupService.recordMakeupAttendance({
        studentId,
        sessionId: targetSessionId,
        originalAbsenceId: sourceSessionId,
        checkInTime: "2099-10-02T10:30:00.000Z",
      });
      expect(makeup).toMatchObject({
        id: `att-default-${targetSessionId}-${studentId}`,
        status: "present",
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      });
      expect(AttendanceRepository.getStudentAttendanceInSession(sourceSessionId, studentId))
        .toMatchObject({ status: "absent", attendanceType: "present" });

      const initialOperation = SyncRepository.getByOperationId(
        `op-att-default-${targetSessionId}-${studentId}`,
      );
      const promotionOperation = SyncRepository.getByOperationId(makeup.operationId);
      expect(initialOperation?.status).toBe("pending");
      expect(promotionOperation?.operationType).toBe("UPDATE");
      expect(promotionOperation?.status).toBe("pending");
      expect(JSON.parse(promotionOperation?.payload || "{}")).toMatchObject({
        action: "attendance.promote_default_absence",
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
        expectedOperationId: initialOperation?.operationId,
      });

      database.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date,
          start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'legacy-roster-subject', 'legacy-roster-teacher',
                 '2099-10-02', '14:00', '16:00', 'open', '2026-10-13')`,
        [laterTargetSessionId, CENTER_ID, TARGET_GROUP_ID],
      );
      expect(MakeupService.getEligibilityForSession(laterTargetSessionId, studentId).eligible)
        .toBe(false);
      await expect(AttendanceRepository.recordAttendance({
        studentId,
        sessionId: laterTargetSessionId,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
        checkInTime: "2099-10-02T14:30:00.000Z",
      })).rejects.toThrow("تم تسجيل تعويض لهذا الغياب مسبقًا");

      expect(database.getAllSync<{ id: string }>(
        `SELECT id FROM attendance
         WHERE center_id = ? AND student_id = ? AND original_absence_id = ?
           AND attendance_type = 'makeup'`,
        [CENTER_ID, studentId, sourceSessionId],
      )).toHaveLength(1);
    } finally {
      currentDateSpy.mockRestore();
    }
  });
});
