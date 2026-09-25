import { Attendance } from "../../shared/types";

export interface SessionAttendanceCounts {
  expected: number;
  present: number;
  absent: number;
  late: number;
  makeup: number;
}

/**
 * Aggregates one session from its immutable expected roster and attendance
 * rows. Kept in a dependency-free module so repositories and reports can
 * share the calculation without importing each other.
 */
export function calculateSessionAttendanceCounts(
  expectedStudentIds: string[],
  attendance: Pick<Attendance, "studentId" | "status" | "attendanceType">[],
  coveredInAdvanceIds: string[] = [],
): SessionAttendanceCounts {
  const expectedIds = new Set(expectedStudentIds);
  const regularRows = attendance.filter((item) => item.attendanceType !== "makeup");
  const presentIds = new Set(
    regularRows
      .filter((item) => (item.status === "present" || item.status === "late") && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const advancedIds = new Set(coveredInAdvanceIds.filter((id) => expectedIds.has(id)));
  const absent = expectedStudentIds.filter((id) => !presentIds.has(id) && !advancedIds.has(id)).length;
  const makeup = new Set(attendance.filter((item) => item.attendanceType === "makeup").map((item) => item.studentId)).size;
  const late = new Set(
    regularRows
      .filter((item) => item.status === "late" && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  ).size;
  return { expected: expectedStudentIds.length, present: presentIds.size, absent, late, makeup };
}
