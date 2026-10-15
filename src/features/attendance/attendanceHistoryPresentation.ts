import { formatTimeArabic } from "../../core/localization";
import { formatLocalDate, parseLocalTimeParts } from "../../shared/utils/date";
import type { StudentAttendanceHistoryRecord } from "./AttendanceRepository";

export interface AttendanceHistoryPresentation {
  sessionDateLabel: string;
  checkInTimeLabel: string | null;
  sessionStartTimeLabel: string | null;
}

export function getAttendanceHistoryPresentation(
  record: Pick<
    StudentAttendanceHistoryRecord,
    "status" | "sessionDate" | "checkInTime" | "startTime"
  >,
): AttendanceHistoryPresentation {
  const isAbsence = record.status === "absent" || record.status === "excused";
  const checkInTime = parseLocalTimeParts(record.checkInTime)
    ? formatTimeArabic(record.checkInTime)
    : "";
  const sessionStartTime = parseLocalTimeParts(record.startTime)
    ? formatTimeArabic(record.startTime)
    : "";

  return {
    sessionDateLabel: formatLocalDate(record.sessionDate),
    checkInTimeLabel: isAbsence
      ? null
      : checkInTime
        ? `وقت تسجيل الحضور: ${checkInTime}`
        : "وقت تسجيل الحضور غير متاح",
    sessionStartTimeLabel:
      isAbsence || !sessionStartTime
        ? null
        : `بداية الجلسة: ${sessionStartTime}`,
  };
}
