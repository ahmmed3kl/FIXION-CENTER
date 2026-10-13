import { findPreviousSessionAbsence } from "../src/features/attendance/previousSessionAbsence";
import { Session } from "../src/shared/types";
import { StudentAttendanceHistoryRecord } from "../src/features/attendance/AttendanceRepository";

const currentSession: Session = {
  id: "current",
  centerId: "center",
  groupId: "group",
  sessionDate: "2026-03-10",
  startTime: "16:00",
  endTime: "18:00",
  status: "open",
  teacherName: "Teacher A",
  subjectName: "Math",
};

function record(
  id: string,
  sessionDate: string,
  status: StudentAttendanceHistoryRecord["status"],
  overrides: Partial<StudentAttendanceHistoryRecord> = {},
): StudentAttendanceHistoryRecord {
  return {
    id,
    centerId: "center",
    studentId: "student",
    sessionId: id,
    checkInTime: "",
    status,
    isLate: false,
    attendanceType: "present",
    operationId: id,
    groupId: "group",
    groupName: "Group",
    subjectName: "Math",
    teacherName: "Teacher A",
    sessionDate,
    startTime: "16:00",
    isDerivedAbsence: status === "absent",
    ...overrides,
  };
}

describe("previous attendance absence badge", () => {
  it("returns only the latest prior absence in the same group, teacher, and subject", () => {
    const result = findPreviousSessionAbsence([
      record("prior-absence", "2026-03-03", "absent"),
      record("other-teacher", "2026-03-09", "absent", { teacherName: "Teacher B" }),
      record("other-subject", "2026-03-09", "absent", { subjectName: "Science" }),
      record("other-group", "2026-03-09", "absent", { groupId: "another-group" }),
      record("future", "2026-03-11", "absent"),
      record("makeup", "2026-03-09", "present", { attendanceType: "makeup" }),
    ], currentSession);

    expect(result?.id).toBe("prior-absence");
  });

  it("does not flag an older absence when the latest eligible prior session was attended", () => {
    const result = findPreviousSessionAbsence([
      record("older-absence", "2026-03-03", "absent"),
      record("latest-present", "2026-03-09", "present"),
    ], currentSession);

    expect(result).toBeNull();
  });
});
