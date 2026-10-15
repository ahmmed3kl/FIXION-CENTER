/** Returns the device's local calendar date as YYYY-MM-DD.
 *
 * Date-only business values (session days, enrollment starts, daily closing)
 * must not be derived from UTC midnight via toISOString(): in Cairo that can
 * become the previous calendar day during the first hours after midnight.
 */
export function getLocalDateOnly(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function getDateOnlyInTimeZone(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Cannot derive a business date from an invalid instant.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new RangeError("Could not derive a business date in the configured time zone.");
  }
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function addDateOnlyDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match || !Number.isInteger(days)) {
    throw new RangeError("A date-only value and whole-day offset are required.");
  }
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(12, 0, 0, 0);
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new RangeError("The date-only value is not a valid calendar date.");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Parse a date-only value without allowing the JavaScript Date parser to
 * silently turn malformed/UTC values into an "Invalid Date" label. */
export function parseLocalDateOnly(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function formatLocalDate(value: unknown, fallback = "تاريخ غير متاح"): string {
  const date = parseLocalDateOnly(value);
  if (!date) return fallback;
  const weekday = date.toLocaleDateString("ar-EG", { weekday: "long" });
  const day = String(date.getDate());
  const month = String(date.getMonth() + 1);
  const year = String(date.getFullYear()).slice(-2);
  return `${weekday} ${day}/${month}/${year}`;
}

export function formatLocalDateTime(value: unknown, fallback = "تاريخ غير متاح"): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return fallback;
  const hour24 = date.getHours();
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? "م" : "ص";
  const time = `${String(hour12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${period}`;
  return `${formatLocalDate(getLocalDateOnly(date), fallback)} — ${time}`;
}
