import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { Logger } from "../src/core/logger";
import { ConflictError, ForbiddenError } from "../src/core/errors";
import { DeviceService } from "../src/core/device";
import { ConnectivityService } from "../src/core/connectivity";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { AbsenceNoteRepository } from "../src/features/attendance/AbsenceNoteRepository";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { getAttendanceHistoryPresentation } from "../src/features/attendance/attendanceHistoryPresentation";
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

const CENTER_ID = "absence-note-center";
const STUDENT_ID = "absence-note-student";
const USER_ID = "absence-note-user";

describe("session-scoped absence notes", () => {
  let tempDirectory: string;
  let database: RealSqliteDatabase;

  function seedSession(id: string, date: string): void {
    database.runSync(
      "INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status) VALUES (?, ?, ?, ?, '16:00', '18:00', 'closed')",
      [id, CENTER_ID, "absence-note-group", date],
    );
    database.runSync(
      "INSERT INTO session_expected_students (id, center_id, session_id, student_id) VALUES (?, ?, ?, ?)",
      [`expected-${id}`, CENTER_ID, id, STUDENT_ID],
    );
  }

  function setUser(permissions: Permission[]): void {
    const user: User = {
      id: USER_ID,
      fullName: "Test Staff",
      email: "absence-notes@example.invalid",
      phone: "01000000000",
      role: "assistant",
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
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-absence-notes-"));
  });

  beforeEach(() => {
    database = new RealSqliteDatabase(path.join(tempDirectory, `${Date.now()}-${Math.random()}.sqlite`));
    DatabaseService.runMigrations(database);
    DatabaseService.setMockDb(database);
    DeviceService.setCachedDeviceId("absence-note-device");
    ConnectivityService.setState("offline");
    database.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", [CENTER_ID, "Test Center", "ABS-TEST"]);
    database.runSync(
      "INSERT INTO teachers (id, center_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ["absence-note-teacher", CENTER_ID, "Teacher", "2026-01-01", "2026-01-01"],
    );
    database.runSync(
      "INSERT INTO subjects (id, center_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      ["absence-note-subject", CENTER_ID, "Subject", "ABS", "2026-01-01", "2026-01-01"],
    );
    database.runSync(
      `INSERT INTO groups
       (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, ?, 'Group', ?, ?, 'Grade 1', 0, 0, 0, 'active', ?, ?)`,
      ["absence-note-group", CENTER_ID, "absence-note-teacher", "absence-note-subject", "2026-01-01", "2026-01-01"],
    );
    database.runSync(
      `INSERT INTO students
       (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at, student_code, updated_at)
       VALUES (?, ?, 'Test Student', 'ABS-CARD', '01000000000', '01100000000', 'Grade 1', 'active', ?, 'ABS-1', ?)`,
      [STUDENT_ID, CENTER_ID, "2026-01-01", "2026-01-01"],
    );
    seedSession("absence-note-session-1", "2026-01-01");
    seedSession("absence-note-session-2", "2026-01-08");
    setUser(["attendance.view", "attendance.edit"]);
  });

  afterEach(() => {
    database.close();
    useAuthStore.setState({ currentUser: null, activeCenterId: null, isAuthenticated: false });
    ConnectivityService.setState("online");
  });

  afterAll(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("keeps notes isolated by session and updates only the selected session note", () => {
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES (?, ?, ?, ?, ?, 'excused', 0, 'present', ?)`,
      ["absence-note-excused-attendance", CENTER_ID, STUDENT_ID, "absence-note-session-2", "2026-01-08T16:30:00Z", "absence-note-excused-operation"],
    );
    AbsenceNoteRepository.save("absence-note-session-1", STUDENT_ID, "مريض");
    AbsenceNoteRepository.save("absence-note-session-2", STUDENT_ID, "ظرف عائلي");
    AbsenceNoteRepository.save("absence-note-session-1", STUDENT_ID, "اعتذر ولي الأمر");
    database.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", ["absence-note-other-center", "Other Center", "ABS-OTHER"]);
    database.runSync(
      `INSERT INTO absence_notes
       (id, center_id, session_id, student_id, note_text, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["other-center-note", "absence-note-other-center", "absence-note-session-1", STUDENT_ID, "ملاحظة خاصة بمركز آخر", "2026-01-01", USER_ID],
    );

    expect(AbsenceNoteRepository.getForSession("absence-note-session-1").map((note) => note.text))
      .toEqual(["اعتذر ولي الأمر"]);
    expect(AbsenceNoteRepository.getForSession("absence-note-session-2").map((note) => note.text))
      .toEqual(["ظرف عائلي"]);
    expect(database.getFirstSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM absence_notes WHERE center_id = ?",
      [CENTER_ID],
    )?.count).toBe(2);
    const attendanceHistory = AttendanceRepository.getStudentAttendance(STUDENT_ID);
    expect(attendanceHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "absence-note-session-1",
          status: "absent",
          sessionDate: "2026-01-01",
          startTime: "16:00",
          absenceNote: "اعتذر ولي الأمر",
        }),
        expect.objectContaining({
          sessionId: "absence-note-session-2",
          status: "excused",
          sessionDate: "2026-01-08",
          startTime: "16:00",
          checkInTime: "2026-01-08T16:30:00Z",
          absenceNote: "ظرف عائلي",
        }),
      ]),
    );
    expect(attendanceHistory.filter(
      (record) => record.sessionId === "absence-note-session-1",
    )).toHaveLength(1);
    expect(attendanceHistory.filter(
      (record) => record.sessionId === "absence-note-session-2",
    )).toHaveLength(1);
    const noteOnlyAbsence = attendanceHistory.find(
      (record) => record.sessionId === "absence-note-session-1",
    );
    if (!noteOnlyAbsence) {
      throw new Error("Expected absence-note history to include a derived absence.");
    }
    expect(noteOnlyAbsence).toMatchObject({
      status: "absent",
      sessionDate: "2026-01-01",
      checkInTime: null,
      isDerivedAbsence: true,
    });
    expect(getAttendanceHistoryPresentation(noteOnlyAbsence)).toEqual({
      sessionDateLabel: "الخميس ٢٠٢٦/١/١",
      checkInTimeLabel: null,
      sessionStartTimeLabel: null,
    });
    expect(database.getFirstSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM sync_operations WHERE center_id = ? AND entity_type = 'absence_note'",
      [CENTER_ID],
    )?.count).toBe(3);
  });

  it("retains historical attendance when session or check-in fields are missing and logs their source", () => {
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES (?, ?, ?, ?, ?, 'present', 0, 'present', ?)`,
      [
        "legacy-orphan-attendance",
        CENTER_ID,
        STUDENT_ID,
        "legacy-missing-session",
        "",
        "legacy-orphan-attendance-operation",
      ],
    );
    const warning = jest.spyOn(Logger, "warn").mockImplementation(() => {});

    try {
      const row = AttendanceRepository.getStudentAttendance(STUDENT_ID)
        .find((item) => item.id === "legacy-orphan-attendance");

      expect(row).toMatchObject({
        sessionId: "legacy-missing-session",
        status: "present",
        checkInTime: null,
        sessionDate: null,
        startTime: null,
      });
      expect(warning).toHaveBeenCalledWith(
        "attendance",
        "student_history_session_date_unavailable",
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionId: "legacy-missing-session",
            source: "sessions.session_date",
            reason: "missing",
          }),
        }),
      );
      expect(warning).toHaveBeenCalledWith(
        "attendance",
        "student_history_check_in_time_unavailable",
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionId: "legacy-missing-session",
            source: "attendance.check_in_time",
            reason: "missing",
          }),
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects unauthorized, out-of-center, or present-student note writes before queueing", () => {
    setUser(["attendance.view"]);
    expect(() => AbsenceNoteRepository.save("absence-note-session-1", STUDENT_ID, "مريض"))
      .toThrow(ForbiddenError);

    setUser(["attendance.view", "attendance.edit"]);
    expect(() => AbsenceNoteRepository.save("other-center-session", STUDENT_ID, "مريض"))
      .toThrow(ConflictError);
    database.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES (?, ?, ?, ?, ?, 'present', 0, 'present', ?)`,
      ["absence-note-present-attendance", CENTER_ID, STUDENT_ID, "absence-note-session-1", "2026-01-01T16:30:00Z", "absence-note-existing-operation"],
    );
    expect(() => AbsenceNoteRepository.save("absence-note-session-1", STUDENT_ID, "مريض"))
      .toThrow(ConflictError);
    expect(database.getFirstSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM absence_notes WHERE center_id = ?",
      [CENTER_ID],
    )?.count).toBe(0);
    expect(database.getFirstSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM sync_operations WHERE center_id = ? AND entity_type = 'absence_note'",
      [CENTER_ID],
    )?.count).toBe(0);
  });
});
