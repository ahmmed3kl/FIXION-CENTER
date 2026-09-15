import { calculateAbsenceReportCounts, calculateSessionAttendanceCounts } from "../src/features/attendance/AbsenceReportsService";
import { Attendance, Student } from "../src/shared/types";

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
});
