import { AbsenceReportsService, calculateAbsenceReportCounts, calculateSessionAttendanceCounts } from "../src/features/attendance/AbsenceReportsService";
import { Attendance, Session, Student } from "../src/shared/types";
import { DatabaseService } from "../src/core/database";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
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
      { ...makeupAttendance("b"), id: "same-group", sessionId: targetSession.id, originalAbsenceId: "same-group-source" },
      { ...attendance("c", "present"), id: "regular-attendance", sessionId: targetSession.id, originalAbsenceId: sourceSession.id },
    ];
    const getAttendance = jest.spyOn(AttendanceRepository, "getSessionAttendance").mockReturnValue(makeups);
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
      findSession.mockRestore();
      findStudent.mockRestore();
    }
  });
});
