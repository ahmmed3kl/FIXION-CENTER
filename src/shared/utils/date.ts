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
  return date
    ? date.toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "short" })
    : fallback;
}
