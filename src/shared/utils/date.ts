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
