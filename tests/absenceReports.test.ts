import { AbsenceReportsService, calculateAbsenceReportCounts, calculateSessionAttendanceCounts } from "../src/features/attendance/AbsenceReportsService";
import { Attendance, Session, Student } from "../src/shared/types";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AbsenceNoteRepository } from "../src/features/attendance/AbsenceNoteRepository";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

jest.mock("expo-device", () => ({ modelName: "Test Device" }));

const student = (id: string): Student => ({
  id,
  centerId: "center-1",
  studentCode: id,
  fullName: `Student ${id}`,
  phone: "01012345678",
  parentPhone: "01112345678",
  grade: "الثالث الثانوي",
  status: "active",
});

const attendance = (studentId: string, status: "present" | "late"): Attendance => ({
  id: `att-${studentId}`,
  centerId: "center-1",
  studentId,
  sessionId: "session-1",
  checkInTime: "17:00:00",
  status,
  isLate: status === "late",
  attendanceType: "present",
  operationId: `op-${studentId}`,
});

const makeupAttendance = (studentId: string): Attendance => ({
  ...attendance(studentId, "present"),
  id: `makeup-${studentId}`,
  attendanceType: "makeup",
});

const session = (
  id: string,
  groupId: string,
  options: Partial<Session> = {},
): Session => ({
  id,
  centerId: "center-1",
  groupId,
  groupName: `Group ${groupId}`,
  subjectName: "Math",
  teacherName: "Teacher",
  subjectId: "subject-1",
  teacherId: "teacher-1",
  sessionDate: "2026-10-02",
  startTime: "10:00",
  endTime: "12:00",
  status: "closed",
  ...options,
});

describe("absence report count aggregation", () => {
  const students = [student("a"), student("b")];

  it("keeps session list and details at 1 present / 1 absent", () => {
    const result = calculateAbsenceReportCounts(students, [students[1]], [attendance("a", "present")], []);
    expect(result).toMatchObject({ total: 2, present: [students[0]], absent: [students[1]], compensated: 0 });
  });

  it("reports two absentees", () => {
    const result = calculateAbsenceReportCounts(students, students, [], []);
    expect(result).toMatchObject({ total: 2, present: [], absent: students, compensated: 0 });
  });

  it("reports two present students", () => {
    const result = calculateAbsenceReportCounts(students, [], [attendance("a", "present"), attendance("b", "present")], []);
    expect(result).toMatchObject({ total: 2, present: students, absent: [], compensated: 0 });
  });

  it("keeps late as present, never absent", () => {
    const result = calculateAbsenceReportCounts(students, [students[1]], [attendance("a", "late")], []);
    expect(result.present).toHaveLength(1);
    expect(result.present[0].id).toBe("a");
    expect(result.absent.map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps an external makeup attendee out of the regular roster counts", () => {
    const result = calculateAbsenceReportCounts(
      [student("a"), student("b"), student("c")],
      [student("c")],
      [attendance("a", "present"), attendance("b", "present"), makeupAttendance("d")],
      [],
    );
    expect(result.total).toBe(3);
    expect(result.present.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.absent.map((item) => item.id)).toEqual(["c"]);
    expect(result.compensated).toBe(1);
  });

  it("does not let two makeup rows change regular present/absent counts", () => {
    const result = calculateAbsenceReportCounts(
      [student("a"), student("b"), student("c")],
      [student("a"), student("b"), student("c")],
      [makeupAttendance("d"), makeupAttendance("e")],
      [],
    );
    expect(result).toMatchObject({ total: 3, present: [], absent: [student("a"), student("b"), student("c")], compensated: 2 });
  });

  it("does not mark an expected student absent when their attendance is recorded as makeup", () => {
    const result = calculateSessionAttendanceCounts(
      ["a", "b", "c"],
      [attendance("a", "present"), makeupAttendance("b")],
    );

    expect(result).toEqual({ expected: 3, present: 1, absent: 1, late: 0, makeup: 1 });
  });

  it("counts late regular attendance as present while keeping makeup separate", () => {
    const result = calculateSessionAttendanceCounts(
      ["a", "b", "c"],
      [
        { studentId: "a", status: "late", attendanceType: "present" },
        { studentId: "b", status: "present", attendanceType: "present" },
        { studentId: "d", status: "present", attendanceType: "makeup" },
      ],
    );
    expect(result).toEqual({ expected: 3, present: 2, absent: 1, late: 1, makeup: 1 });
  });

  it("scopes never-attended classification to the student's teacher cycle and month", () => {
    const target = session("target", "group-1", { sessionDate: "2026-10-02" });
    const sameCycle = session("same-cycle", "group-2", { sessionDate: "2026-10-01" });
    const otherTeacher = session("other-teacher", "group-3", {
      sessionDate: "2026-10-02",
      teacherId: "teacher-2",
      teacherName: "Other Teacher",
    });
    const makeupSource = session("makeup-source", "group-4", { sessionDate: "2026-10-01" });
    const outsideMonth = session("outside-month", "group-5", { sessionDate: "2026-09-30" });
    const expectedBySession: Record<string, Student[]> = {
      target: [
        student("old-attendance"),
        student("other-teacher-attendance"),
        student("unlinked-makeup"),
        student("valid-makeup"),
        student("same-cycle-attendance"),
      ],
      "same-cycle": [student("same-cycle-attendance")],
      "other-teacher": [],
      "makeup-source": [student("valid-makeup")],
      "outside-month": [],
    };
    const attendanceBySession = new Map<string, Attendance[]>([
      ["target", [
        makeupAttendance("unlinked-makeup"),
        { ...makeupAttendance("valid-makeup"), originalAbsenceId: "makeup-source" },
      ]],
      ["same-cycle", [attendance("same-cycle-attendance", "present")]],
      ["other-teacher", [attendance("other-teacher-attendance", "present")]],
      ["outside-month", [attendance("old-attendance", "present")]],
    ]);
    const allSessions = [target, sameCycle, otherTeacher, makeupSource, outsideMonth];
    const getExpected = jest.spyOn(SessionRepository, "getExpectedStudents").mockImplementation((id) => expectedBySession[id] || []);
    const getDb = jest.spyOn(DatabaseService, "getDb").mockReturnValue({
      getFirstSync: jest.fn().mockReturnValue({ weekStartDay: 6 }),
    } as any);
    const getAttendance = jest.spyOn(AttendanceRepository, "getSessionAttendance")
      .mockImplementation((id) => attendanceBySession.get(id) || []);
    const getOneAttendance = jest.spyOn(AttendanceRepository, "getStudentAttendanceInSession").mockReturnValue(null);
    const findSession = jest.spyOn(SessionRepository, "findById")
      .mockImplementation((id) => allSessions.find((item) => item.id === id) || null);
    try {
      const rows = AbsenceReportsService.getMonthlyNeverAttended(
        "2026-10",
        allSessions.map((item) => ({ session: item, total: 0, present: 0, absent: 0, compensated: 0 })),
      );
      expect(rows.map((row) => row.student.id).sort()).toEqual([
        "old-attendance",
        "other-teacher-attendance",
        "unlinked-makeup",
      ]);
      expect(rows.find((row) => row.student.id === "old-attendance")).toMatchObject({
        teacherNames: ["Teacher"],
        subjectName: "Math",
        cycleStartDate: "2026-09-26",
        cycleEndDate: "2026-10-02",
      });
      expect(getAttendance).not.toHaveBeenCalledWith("outside-month");
    } finally {
      getExpected.mockRestore();
      getDb.mockRestore();
      getAttendance.mockRestore();
      getOneAttendance.mockRestore();
      findSession.mockRestore();
    }
  });

  it("lists only recorded linked makeups completed in a different group", () => {
    const targetSession = session("target-session", "target-group");
    const sourceSession = session("source-session", "source-group");
    const makeups = [
      { ...makeupAttendance("a"), id: "cross-group", sessionId: targetSession.id, originalAbsenceId: sourceSession.id },
      { ...makeupAttendance("b"), id: "not-originally-absent", studentId: "b", sessionId: targetSession.id, originalAbsenceId: sourceSession.id },
      { ...makeupAttendance("b"), id: "same-group", sessionId: targetSession.id, originalAbsenceId: "same-group-source" },
      { ...attendance("c", "present"), id: "regular-attendance", sessionId: targetSession.id, originalAbsenceId: sourceSession.id },
      { ...makeupAttendance("d"), id: "failed-makeup", studentId: "d", sessionId: targetSession.id, originalAbsenceId: sourceSession.id, status: "absent" as Attendance["status"] },
      { ...makeupAttendance("e"), id: "wrong-target", studentId: "e", sessionId: "another-session", originalAbsenceId: sourceSession.id },
    ];
    const getAttendance = jest.spyOn(AttendanceRepository, "getSessionAttendance").mockReturnValue(makeups);
    const getExpected = jest.spyOn(SessionRepository, "getExpectedStudents").mockReturnValue([student("a"), student("b")]);
    const getSourceAttendance = jest.spyOn(AttendanceRepository, "getStudentAttendanceInSession")
      .mockImplementation((_sessionId, studentId) => studentId === "b" ? attendance("b", "present") : null);
    const findSession = jest.spyOn(SessionRepository, "findById").mockImplementation((id) =>
      id === "same-group-source" ? session("same-group-source", "target-group") : sourceSession,
    );
    const findStudent = jest.spyOn(StudentRepository, "findByIdForAttendanceReport").mockReturnValue(student("a"));
    try {
      const rows = AbsenceReportsService.getMonthlyCrossGroupMakeups("2026-10", [{
        session: targetSession,
        total: 1,
        present: 0,
        absent: 1,
        compensated: 1,
      }]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        student: { id: "a" },
        originalSession: { id: "source-session" },
        targetSession: { id: "target-session" },
      });
    } finally {
      getAttendance.mockRestore();
      getExpected.mockRestore();
      getSourceAttendance.mockRestore();
      findSession.mockRestore();
      findStudent.mockRestore();
    }
  });

  it("shows completed compensation only when linked to a real original absence", () => {
    const targetSession = session("target-session", "target-group");
    const sourceSession = session("source-session", "source-group");
    const records: Attendance[] = [
      { ...makeupAttendance("a"), id: "valid-makeup", sessionId: targetSession.id, originalAbsenceId: sourceSession.id },
      { ...makeupAttendance("b"), id: "unlinked-makeup", studentId: "b", sessionId: targetSession.id },
      { ...makeupAttendance("d"), id: "external-makeup", studentId: "d", sessionId: targetSession.id, originalAbsenceId: sourceSession.id, isExternal: true },
    ];
    const getSessionAttendance = jest.spyOn(AttendanceRepository, "getSessionAttendance").mockReturnValue(records);
    const getExpected = jest.spyOn(SessionRepository, "getExpectedStudents")
      .mockImplementation((id) => id === sourceSession.id || id === targetSession.id ? [student("a")] : []);
    const getOriginalAttendance = jest.spyOn(AttendanceRepository, "getStudentAttendanceInSession").mockReturnValue(null);
    const findSession = jest.spyOn(SessionRepository, "findById").mockImplementation((id) =>
      id === targetSession.id ? targetSession : id === sourceSession.id ? sourceSession : null,
    );
    const getAbsentees = jest.spyOn(AbsenceService, "getAbsenteesForSession").mockReturnValue([student("a")]);
    const isCoveredInAdvance = jest.spyOn(MakeupService, "isSessionCoveredInAdvance").mockReturnValue(false);
    const getOpportunities = jest.spyOn(MakeupService, "getMakeupOpportunities").mockReturnValue([]);
    const getAbsenceNotes = jest.spyOn(AbsenceNoteRepository, "getForSession").mockReturnValue([]);
    try {
      const report = AbsenceReportsService.getSessionReport(targetSession.id);
      expect(report.compensation).toHaveLength(1);
      expect(report.compensation[0]).toMatchObject({
        kind: "completed",
        student: { id: "a" },
        originalSession: { id: "source-session", groupId: "source-group" },
      });
    } finally {
      getSessionAttendance.mockRestore();
      getExpected.mockRestore();
      getOriginalAttendance.mockRestore();
      findSession.mockRestore();
      getAbsentees.mockRestore();
      isCoveredInAdvance.mockRestore();
      getOpportunities.mockRestore();
      getAbsenceNotes.mockRestore();
    }
  });

  it("limits never-attended rows to the opened session roster and excludes successful cross-group makeups", () => {
    const target = session("selected-session", "group-1");
    const otherTeacherRow = {
      student: student("other"),
      teacherId: "teacher-2",
      subjectId: "subject-1",
      teacherNames: ["Other"],
      subjectName: "Math",
      groupNames: ["Other group"],
      cycleStartDate: "2026-09-26",
      cycleEndDate: "2026-10-02",
    };
    const matchingRow = {
      ...otherTeacherRow,
      student: student("matching"),
      teacherId: "teacher-1",
    };
    const peerGroupRow = { ...matchingRow, student: student("peer-group") };
    const compensatedRow = { ...matchingRow, student: student("compensated") };
    const reportDb: SqlDatabase = {
      execSync: jest.fn(),
      runSync: jest.fn(),
      getAllSync: jest.fn(),
      getFirstSync: jest.fn().mockReturnValue({ weekStartDay: "6" }),
    };
    const getDb = jest.spyOn(DatabaseService, "getDb").mockReturnValue(reportDb);
    const getExpected = jest.spyOn(SessionRepository, "getExpectedStudents")
      .mockReturnValue([matchingRow.student]);
    try {
      expect(AbsenceReportsService.getNeverAttendedForSession(
        target,
        [otherTeacherRow, matchingRow, peerGroupRow, compensatedRow],
        new Set(["compensated"]),
      ))
        .toEqual([matchingRow]);
    } finally {
      getDb.mockRestore();
      getExpected.mockRestore();
    }
  });

  it("shows only the two absent students from a six-student roster, not eight cycle-wide students", () => {
    const target = session("six-student-session", "current-group");
    const expected = Array.from({ length: 6 }, (_, index) => student(`current-${index + 1}`));
    const rows = [
      ...expected,
      student("peer-group-1"),
      student("peer-group-2"),
    ].map((item) => ({
      student: item,
      teacherId: "teacher-1",
      subjectId: "subject-1",
      teacherNames: ["Teacher"],
      subjectName: "Math",
      groupNames: ["Current or peer group"],
      cycleStartDate: "2026-09-26",
      cycleEndDate: "2026-10-02",
    }));
    const getDb = jest.spyOn(DatabaseService, "getDb").mockReturnValue({
      getFirstSync: jest.fn().mockReturnValue({ weekStartDay: 6 }),
    } as any);
    const getExpected = jest.spyOn(SessionRepository, "getExpectedStudents").mockReturnValue(expected);
    try {
      const counts = calculateAbsenceReportCounts(
        expected,
        expected.slice(4),
        expected.slice(0, 4).map((item) => attendance(item.id, "present")),
        [],
      );
      expect(counts.present).toHaveLength(4);
      expect(counts.absent).toHaveLength(2);
      const actualAbsentees = new Set(counts.absent.map((item) => item.id));
      const neverAttended = AbsenceReportsService.getNeverAttendedForSession(
        target,
        rows,
        new Set(),
        actualAbsentees,
      );
      expect(neverAttended.map((row) => row.student.id)).toEqual(["current-5", "current-6"]);
      expect(neverAttended).toHaveLength(2);
    } finally {
      getDb.mockRestore();
      getExpected.mockRestore();
    }
  });
});
