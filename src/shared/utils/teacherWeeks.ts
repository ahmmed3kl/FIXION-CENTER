import { parseLocalDateOnly } from "./date";

export const SYSTEM_WEEK_START_DAY = 6;
export const DEFAULT_TEACHER_WEEK_START_DAY = SYSTEM_WEEK_START_DAY;

export interface WeekBounds {
  startDate: string;
  endDate: string;
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getWeekBounds(dateValue: string, startDay: number): WeekBounds {
  const date = parseLocalDateOnly(dateValue);
  if (!date || !Number.isInteger(startDay) || startDay < 0 || startDay > 6) {
    throw new RangeError("تاريخ أو يوم بداية الأسبوع غير صالح.");
  }
  const daysSinceStart = (date.getDay() - startDay + 7) % 7;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceStart, 12);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 12);
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

export function getSystemWeekBounds(dateValue: string): WeekBounds {
  return getWeekBounds(dateValue, SYSTEM_WEEK_START_DAY);
}

export function getTeacherWeekBounds(
  dateValue: string,
  weekStartDay = DEFAULT_TEACHER_WEEK_START_DAY,
): WeekBounds {
  return getWeekBounds(dateValue, weekStartDay);
}

export function isWithinTeacherWeekCycle(
  originalSessionDate: string,
  candidateSessionDate: string,
  weekStartDay = DEFAULT_TEACHER_WEEK_START_DAY,
): boolean {
  return getTeacherWeekBounds(originalSessionDate, weekStartDay).startDate ===
    getTeacherWeekBounds(candidateSessionDate, weekStartDay).startDate;
}

export const TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR = "TEACHER_MAKEUP_CYCLE_EXPIRED";
export const TEACHER_MAKEUP_CYCLE_EXPIRED_MESSAGE =
  "انتهت فرصة تعويض هذه الحصة مع نهاية دورة شرح المدرس.";

export function isTeacherMakeupCycleOpen(
  originalSessionDate: string,
  candidateSessionDate: string,
  weekStartDay: number,
  today: string,
): boolean {
  const bounds = getTeacherWeekBounds(originalSessionDate, weekStartDay);
  return bounds.startDate === getTeacherWeekBounds(candidateSessionDate, weekStartDay).startDate &&
    today <= bounds.endDate;
}
