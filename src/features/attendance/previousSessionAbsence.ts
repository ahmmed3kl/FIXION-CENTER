import type { Session } from "../../shared/types";
import type { StudentAttendanceHistoryRecord } from "./AttendanceRepository";

export function findPreviousSessionAbsence(
  records: StudentAttendanceHistoryRecord[],
  currentSession: Session,
): StudentAttendanceHistoryRecord | null {
  const currentKey = `${currentSession.sessionDate} ${currentSession.startTime}`;
  const previousRecord = records
    .filter((record) =>
      record.groupId === currentSession.groupId &&
      record.teacherName === currentSession.teacherName &&
      record.subjectName === currentSession.subjectName &&
      record.attendanceType !== "makeup" &&
      `${record.sessionDate} ${record.startTime}` < currentKey,
    )
    .sort((left, right) =>
      `${right.sessionDate} ${right.startTime}`.localeCompare(`${left.sessionDate} ${left.startTime}`),
    )[0];

  return previousRecord?.status === "absent" ? previousRecord : null;
}
