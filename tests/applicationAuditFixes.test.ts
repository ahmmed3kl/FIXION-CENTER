import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { ForbiddenError, ValidationError } from "../src/core/errors";
import { DeviceService } from "../src/core/device";
import { RolePermissions } from "../src/core/permissions";
import { GradeBookRepository, GradeExam } from "../src/features/grades/GradeBookRepository";
import { saveGradeEdit } from "../src/features/grades/gradeScoreEdit";
import { PackageRepository } from "../src/features/packages/PackageRepository";
import { OpeningBalanceService } from "../src/features/payments/OpeningBalanceService";
import { OperationalReportsService } from "../src/features/reports/OperationalReportsService";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { Permission, User } from "../src/shared/types";
import { captureLoad, isCurrentLoadResult } from "../src/shared/utils/loadResult";
import { ConnectivityService } from "../src/core/connectivity";

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

const CENTER_ID = "application-fix-center";
const USER_ID = "application-fix-user";
const STUDENT_ID = "application-fix-student";

describe("Application audit fixes on real SQLite", () => {
  let tempDirectory: string;
  let database: RealSqliteDatabase;
  const closedDatabases = new WeakSet<RealSqliteDatabase>();

  function openDatabase(testName: string): RealSqliteDatabase {
    const db = new RealSqliteDatabase(path.join(tempDirectory, `${testName}.sqlite`));
    DatabaseService.runMigrations(db);
    DatabaseService.setMockDb(db);
    DeviceService.setCachedDeviceId("application-fix-device");
    ConnectivityService.setState("offline");
    db.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", [CENTER_ID, "Test Center", "APP-TEST"]);
    seedTeacherSubjectGroupStudent(db);
    return db;
  }

  function seedTeacherSubjectGroupStudent(db: RealSqliteDatabase): void {
    const now = "2026-10-06T12:00:00.000Z";
    for (let index = 1; index <= 3; index += 1) {
      db.runSync(
        "INSERT INTO teachers (id, center_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        [`teacher-${index}`, CENTER_ID, `Teacher ${index}`, now, now],
      );
      db.runSync(
        "INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        [`subject-${index}`, CENTER_ID, `Subject ${index}`, `SUB-${index}`, now, now],
      );
      db.runSync(
        "INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [`teacher-subject-${index}`, CENTER_ID, `teacher-${index}`, `subject-${index}`, now],
      );
    }
    db.runSync(
      `INSERT INTO groups
       (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
       VALUES ('group-1', ?, 'Group 1', 'teacher-1', 'subject-1', 'Grade 1', 0, 0, 100, 'active', ?, ?)`,
      [CENTER_ID, now, now],
    );
    insertStudent(db, STUDENT_ID, null);
    db.runSync(
      `INSERT INTO student_group_enrollments
       (id, center_id, student_id, group_id, start_date, status, created_at, updated_at)
       VALUES ('enrollment-1', ?, ?, 'group-1', '2026-10-01', 'active', ?, ?)`,
      [CENTER_ID, STUDENT_ID, now, now],
    );
  }

  function insertStudent(db: RealSqliteDatabase, id: string, deletedAt: string | null): void {
    db.runSync(
      `INSERT INTO students
       (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at,
        student_code, deleted_at, deleted_by, updated_at)
       VALUES (?, ?, ?, ?, '01000000000', '01100000000', 'Grade 1', 'active', ?, ?, ?, ?, ?)`,
      [id, CENTER_ID, `Student ${id}`, `CARD-${id}`, "2026-10-01", `CODE-${id}`, deletedAt, deletedAt ? USER_ID : null, "2026-10-01T00:00:00.000Z"],
    );
  }

  function setUser(permissions: Permission[], role: User["role"] = "assistant"): void {
    const user: User = {
      id: USER_ID,
      fullName: "Application Test User",
      email: "application-test@example.invalid",
      phone: "01000000000",
      role,
      centerId: CENTER_ID,
      centerIds: [CENTER_ID],
      permissions,
    };
    useAuthStore.setState({
      currentUser: user,
      activeCenterId: CENTER_ID,
      isAuthenticated: true,
      isLoading: false,
    });
  }

  beforeAll(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-application-fixes-"));
  });

  afterEach(() => {
    if (database && !closedDatabases.has(database)) {
      database.close();
      closedDatabases.add(database);
    }
    useAuthStore.setState({ currentUser: null, activeCenterId: null, isAuthenticated: false });
    ConnectivityService.setState("online");
  });

  afterAll(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("commits opening cycle and payment together and rejects a duplicate opening cycle", async () => {
    database = openDatabase("opening-success");
    setUser(["payments.adjust", "payments.create"]);

    const result = await OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 25,
    });

    expect(result.payment?.amount).toBe(25);
    expect(database.getFirstSync("SELECT cycle_price FROM debt_cycles WHERE id = ?", [result.cycleId])).toEqual({ cycle_price: 100 });
    expect(database.getFirstSync("SELECT amount, debt_cycle_id FROM payments WHERE debt_cycle_id = ?", [result.cycleId])).toEqual({ amount: 25, debt_cycle_id: result.cycleId });
    await expect(OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 25,
    })).rejects.toThrow("يوجد رصيد افتتاحي مسجل");
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM debt_cycles")).toEqual({ count: 1 });
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM payments")).toEqual({ count: 1 });
  });

  it("rolls back the cycle, payment, outbox and audit rows on payment failure and permits retry", async () => {
    database = openDatabase("opening-rollback");
    setUser(["payments.adjust", "payments.create"]);
    database.execSync("CREATE TRIGGER fail_opening_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'forced payment failure'); END;");

    await expect(OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 25,
    })).rejects.toThrow();

    for (const table of ["debt_cycles", "payments", "sync_operations", "audit_logs"]) {
      expect(database.getFirstSync<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`)?.count).toBe(0);
    }

    database.execSync("DROP TRIGGER fail_opening_payment");
    const retry = await OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 25,
    });
    expect(retry.payment?.debtCycleId).toBe(retry.cycleId);
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM debt_cycles")).toEqual({ count: 1 });
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM payments")).toEqual({ count: 1 });
  });

  it("requires payments.create for a paid opening balance but allows adjustment-only zero-paid imports", async () => {
    database = openDatabase("opening-permissions");
    setUser(["payments.adjust"]);

    await expect(OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 25,
    })).rejects.toBeInstanceOf(ForbiddenError);
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM debt_cycles")).toEqual({ count: 0 });

    const noPayment = await OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 0,
    });
    expect(noPayment.payment).toBeUndefined();
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM debt_cycles")).toEqual({ count: 1 });
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM payments")).toEqual({ count: 0 });
  });

  it("does not treat payments.create alone as permission to adjust opening balances", async () => {
    database = openDatabase("opening-create-only");
    setUser(["payments.create"]);

    await expect(OpeningBalanceService.importCurrentPeriod({
      studentId: STUDENT_ID,
      enrollmentId: "enrollment-1",
      groupId: "group-1",
      cycleType: "monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountDue: 100,
      amountPaid: 0,
    })).rejects.toThrow("ليس لديك صلاحية ترحيل الرصيد");
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM debt_cycles")).toEqual({ count: 0 });
  });

  it("keeps opening-balance date defaults on the local calendar in a positive UTC offset", () => {
    const moduleRoot = path.join(tempDirectory, "local-date-runtime");
    const sourceRoot = path.join(__dirname, "../src");
    const dateOutput = path.join(moduleRoot, "shared", "utils", "date.js");
    const balanceOutput = path.join(moduleRoot, "features", "payments", "openingBalanceDates.js");
    fs.mkdirSync(path.dirname(dateOutput), { recursive: true });
    fs.mkdirSync(path.dirname(balanceOutput), { recursive: true });
    for (const [sourcePath, outputPath] of [
      [path.join(sourceRoot, "shared/utils/date.ts"), dateOutput],
      [path.join(sourceRoot, "features/payments/openingBalanceDates.ts"), balanceOutput],
    ]) {
      const source = fs.readFileSync(sourcePath, "utf8");
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      fs.writeFileSync(outputPath, compiled);
    }
    const output = execFileSync(process.execPath, [
      "-e",
      `const { getOpeningBalanceDateDefaults } = require(${JSON.stringify(balanceOutput)}); console.log(JSON.stringify(getOpeningBalanceDateDefaults(new Date("2026-10-06T12:30:00.000Z"))));`,
    ], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Pacific/Kiritimati" },
    });
    expect(JSON.parse(output)).toEqual({ periodStart: "2026-10-07", periodEnd: "2026-11-06" });
  });

  it("reports each same-group session exactly once with attendance counted against its own roster", () => {
    database = openDatabase("daily-multisession");
    setUser(["reports.attendance.view"]);
    const day = "2026-10-06";
    database.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES ('schedule-1', ?, 'group-1', 2, '09:00', '10:00', 'active', ?),
              ('schedule-2', ?, 'group-1', 2, '11:00', '12:00', 'active', ?)`,
      [CENTER_ID, day, CENTER_ID, day],
    );
    database.runSync(
      `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, schedule_id, created_at)
       VALUES ('session-1', ?, 'group-1', ?, '09:00', '10:00', 'closed', 'schedule-1', ?),
              ('session-2', ?, 'group-1', ?, '11:00', '12:00', 'closed', 'schedule-2', ?)`,
      [CENTER_ID, day, day, CENTER_ID, day, day],
    );
    insertStudent(database, "student-second", null);
    for (const sessionId of ["session-1", "session-2"]) {
      for (const studentId of [STUDENT_ID, "student-second"]) {
        database.runSync(
          "INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [`expected-${sessionId}-${studentId}`, CENTER_ID, sessionId, studentId, day],
        );
      }
    }
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES ('attendance-1', ?, ?, 'session-1', '09:10', 'present', 0, 'present', 'operation-1'),
              ('attendance-2', ?, 'student-second', 'session-2', '11:10', 'late', 1, 'present', 'operation-2')`,
      [CENTER_ID, STUDENT_ID, CENTER_ID],
    );

    const report = OperationalReportsService.getDailyAttendanceReport(day);
    expect(report.sessions.map((session) => session.sessionId)).toEqual(["session-1", "session-2"]);
    expect(report.sessions.map((session) => [session.expectedCount, session.presentCount, session.absentCount, session.lateCount])).toEqual([
      [2, 1, 1, 0],
      [2, 1, 1, 1],
    ]);
    expect(report.totals.totalSessions).toBe(2);
  });

  it("preserves the previous package and links when a later subject-link insert fails", async () => {
    database = openDatabase("package-atomic-update");
    setUser(["packages.view", "packages.update", "packages.manage", "subjects.view", "teachers.view"]);
    const now = "2026-10-06T12:00:00.000Z";
    database.runSync(
      `INSERT INTO packages (id, center_id, name, price, max_selections, description, status, created_at, updated_at)
       VALUES ('package-1', ?, 'Old package', 100, 1, 'old', 'active', ?, ?)`,
      [CENTER_ID, now, now],
    );
    database.runSync(
      `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, created_at)
       VALUES ('package-subject-old', ?, 'package-1', 'subject-1', 'teacher-1', ?)`,
      [CENTER_ID, now],
    );

    await expect(PackageRepository.updatePackageWithSubjects({
      id: "package-1",
      data: { name: "New package", price: 200, maxSelections: 2, description: "new" },
      subjects: [
        { subjectId: "subject-2", defaultTeacherId: "teacher-2" },
        { subjectId: "subject-3", defaultTeacherId: "teacher-1" },
      ],
    })).rejects.toThrow("المدرس غير مخصص لتدريس هذه المادة");

    expect(database.getFirstSync("SELECT name, price FROM packages WHERE id = 'package-1'")).toEqual({ name: "Old package", price: 100 });
    expect(database.getAllSync("SELECT id, subject_id FROM package_subjects WHERE package_id = 'package-1'")).toEqual([
      { id: "package-subject-old", subject_id: "subject-1" },
    ]);
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM sync_operations")).toEqual({ count: 0 });
    expect(database.getFirstSync("SELECT COUNT(*) as count FROM audit_logs")).toEqual({ count: 0 });
  });

  it("allows restore-only users to restore without granting deactivation", () => {
    database = openDatabase("restore-only");
    insertStudent(database, "student-deleted-1", "2026-10-01T00:00:00.000Z");
    setUser(["students.view", "students.restore"]);

    expect(StudentRepository.restoreDeletedStudent("student-deleted-1").deletedAt).toBeNull();
    expect(database.getFirstSync("SELECT deleted_at FROM students WHERE id = 'student-deleted-1'")).toEqual({ deleted_at: null });
    expect(() => StudentRepository.deleteStudent(STUDENT_ID)).toThrow(ForbiddenError);
    expect(database.getFirstSync("SELECT deleted_at FROM students WHERE id = ?", [STUDENT_ID])).toEqual({ deleted_at: null });
  });

  it("allows deactivate-only users to deactivate but not restore", () => {
    database = openDatabase("deactivate-only");
    insertStudent(database, "student-deleted-2", "2026-10-01T00:00:00.000Z");
    setUser(["students.view", "students.deactivate"]);

    expect(StudentRepository.deleteStudent(STUDENT_ID).deletedAt).toBeTruthy();
    expect(() => StudentRepository.restoreDeletedStudent("student-deleted-2")).toThrow(ForbiddenError);
    expect(database.getFirstSync("SELECT deleted_at FROM students WHERE id = ?", [STUDENT_ID])?.deleted_at).toBeTruthy();
    expect(database.getFirstSync("SELECT deleted_at FROM students WHERE id = 'student-deleted-2'")?.deleted_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("preserves admin and owner restore permissions", () => {
    database = openDatabase("restore-admin-owner");
    insertStudent(database, "student-deleted-admin", "2026-10-01T00:00:00.000Z");
    insertStudent(database, "student-deleted-owner", "2026-10-01T00:00:00.000Z");

    setUser(RolePermissions.admin, "admin");
    expect(StudentRepository.restoreDeletedStudent("student-deleted-admin").deletedAt).toBeNull();
    setUser(RolePermissions.owner, "owner");
    expect(StudentRepository.restoreDeletedStudent("student-deleted-owner").deletedAt).toBeNull();
  });

  it("restores the committed grade after a rejected value and enforces the maximum score", () => {
    database = openDatabase("grade-rejected-value");
    setUser(["grades.view", "grades.manage"]);
    const now = "2026-10-06T12:00:00.000Z";
    database.runSync(
      `INSERT INTO grade_exams (id, center_id, name, grade, max_score, status, created_at)
       VALUES ('exam-1', ?, 'Exam 1', 'Grade 1', 10, 'active', ?)`,
      [CENTER_ID, now],
    );
    const exam: GradeExam = {
      id: "exam-1", centerId: CENTER_ID, name: "Exam 1", grade: "Grade 1",
      maxScore: 10, status: "active", createdAt: now,
    };
    GradeBookRepository.setScore(exam, STUDENT_ID, "10");

    const edit = saveGradeEdit("11", "10", (value) =>
      GradeBookRepository.setScore(exam, STUDENT_ID, value),
    );

    expect(edit).toMatchObject({ saved: false, value: "10" });
    expect(edit.saved).toBe(false);
    expect(database.getFirstSync("SELECT score FROM grade_scores WHERE exam_id = 'exam-1' AND student_id = ?", [STUDENT_ID])).toEqual({ score: 10 });
    expect(() => GradeBookRepository.setScore(exam, STUDENT_ID, "11")).toThrow(ValidationError);
  });

  it("shows an empty group list only after a successful empty load", () => {
    expect(captureLoad(() => [], "Load failed")).toEqual({ status: "success", value: [] });
    expect(captureLoad(() => { throw new Error("Database unavailable"); }, "Groups could not be loaded")).toEqual({
      status: "error",
      message: "Database unavailable",
    });
  });

  it("shows report load failures and hides a result for a previous selection", () => {
    expect(captureLoad(() => { throw new Error("Report query failed"); }, "Report unavailable")).toEqual({
      status: "error",
      message: "Report query failed",
    });
    expect(isCurrentLoadResult("date-2026-10-05", "date-2026-10-06")).toBe(false);
    expect(isCurrentLoadResult("date-2026-10-06", "date-2026-10-06")).toBe(true);
    expect(isCurrentLoadResult("", "date-2026-10-06")).toBe(false);
  });

  it("keeps financial report query errors distinct from a successful empty result", () => {
    const empty = captureLoad(() => [], "Financial report unavailable");
    const failed = captureLoad(() => { throw new Error("Financial tables unavailable"); }, "Financial report unavailable");

    expect(empty).toEqual({ status: "success", value: [] });
    expect(failed).toEqual({ status: "error", message: "Financial tables unavailable" });
  });
});
