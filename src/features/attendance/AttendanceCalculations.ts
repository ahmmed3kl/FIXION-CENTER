import { Attendance } from "../../shared/types";

export interface SessionAttendanceCounts {
  expected: number;
  present: number;
  absent: number;
  notStarted: number;
  late: number;
  makeup: number;
}

export interface SessionRosterAttendanceRow {
  studentId: string;
  status: string;
  attendanceType?: string | null;
  originalAbsenceId?: string | null;
  originalAbsenceValid?: boolean;
}

export function getSessionExpectedStudentIds(
  sessionId: string,
  rows: { id?: string | null; studentId: string }[],
): string[] {
  const compensationPrefix = `exp-comp-${sessionId}-`;
  return Array.from(new Set(
    rows
      .filter((row) => !row.id?.startsWith(compensationPrefix))
      .map((row) => row.studentId)
      .filter(Boolean),
  ));
}

export function filterExpectedStudentIdsByEligibility(
  expectedStudentIds: string[],
  eligibleStudentIds: string[],
): string[] {
  const eligible = new Set(eligibleStudentIds);
  return Array.from(new Set(expectedStudentIds.filter((studentId) => eligible.has(studentId))));
}

/**
 * Compensation visitors belong to the destination session's attendance
 * history, not its regular expected roster. A historic snapshot may contain
 * such a visitor from older scanner flows; exclude only a successfully
 * recorded, origin-linked makeup when the student has no independent
 * enrollment/package eligibility in this destination group.
 */
export function excludeCompensationVisitorsFromExpectedRoster(
  expectedStudentIds: string[],
  attendance: SessionRosterAttendanceRow[],
  eligibleStudentIds: string[],
): string[] {
  const eligible = new Set(eligibleStudentIds);
  const compensationVisitors = new Set(
    attendance
      .filter((item) =>
        item.attendanceType === "makeup" &&
        (item.status === "present" || item.status === "late") &&
        item.originalAbsenceValid === true &&
        Boolean(item.originalAbsenceId),
      )
      .map((item) => item.studentId)
      .filter((studentId) => !eligible.has(studentId)),
  );
  return Array.from(new Set(expectedStudentIds)).filter(
    (studentId) => !compensationVisitors.has(studentId),
  );
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
  sessionStarted = false,
): SessionAttendanceCounts {
  const expectedIds = new Set(expectedStudentIds);
  const regularRows = attendance.filter((item) => item.attendanceType !== "makeup");
  const presentIds = new Set(
    regularRows
      .filter((item) => (item.status === "present" || item.status === "late") && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const advancedIds = new Set(coveredInAdvanceIds.filter((id) => expectedIds.has(id)));
  const makeupIds = new Set(
    attendance
      .filter((item) =>
        item.attendanceType === "makeup" &&
        (item.status === "present" || item.status === "late"),
      )
      .map((item) => item.studentId),
  );
  const absentIds = new Set(
    regularRows
      .filter((item) => item.status === "absent" && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const absent = Array.from(absentIds).filter(
    (id) => !presentIds.has(id) && !makeupIds.has(id) && !advancedIds.has(id),
  ).length;
  const noOutcomeIds = expectedStudentIds.filter(
    (id) => !presentIds.has(id) && !absentIds.has(id) && !advancedIds.has(id) && !makeupIds.has(id),
  );
  const defaultAbsences = sessionStarted ? noOutcomeIds.length : 0;
  const notStarted = sessionStarted ? 0 : noOutcomeIds.length;
  const makeup = makeupIds.size;
  const late = new Set(
    regularRows
      .filter((item) => item.status === "late" && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  ).size;
  return {
    expected: expectedStudentIds.length,
    present: presentIds.size,
    absent: absent + defaultAbsences,
    notStarted,
    late,
    makeup,
  };
}
