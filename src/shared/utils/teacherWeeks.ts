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

export function normalizeTeacherWeekStartDay(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_TEACHER_WEEK_START_DAY;
  const startDay = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(startDay) || startDay < 0 || startDay > 6) {
    throw new RangeError("يوم بداية أسبوع المدرس غير صالح.");
  }
  return startDay;
}

function parseSessionDate(value: string): Date | null {
  const dateOnly = parseLocalDateOnly(value);
  if (dateOnly) return dateOnly;

  const match = /^(\d{4}-\d{2}-\d{2})(?:T|\s)(.+)$/.exec(value.trim());
  if (!match || !Number.isFinite(new Date(value).getTime())) return null;
  return parseLocalDateOnly(match[1]);
}

function getWeekBounds(dateValue: string, startDayValue: unknown): WeekBounds {
  const date = parseSessionDate(dateValue);
  if (!date) throw new RangeError("تاريخ الحصة غير صالح لدورة شرح المدرس.");
  const startDay = normalizeTeacherWeekStartDay(startDayValue);
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
  weekStartDay: unknown = DEFAULT_TEACHER_WEEK_START_DAY,
): WeekBounds {
  return getWeekBounds(dateValue, weekStartDay);
}

export function isWithinTeacherWeekCycle(
  originalSessionDate: string,
  candidateSessionDate: string,
  weekStartDay: unknown = DEFAULT_TEACHER_WEEK_START_DAY,
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
