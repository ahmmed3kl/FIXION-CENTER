/** Deterministic, short identifiers for natural records created offline. */
export function stableSessionId(centerId: string, groupId: string, scheduleId: string, sessionDate: string): string {
  const input = `${centerId}|${groupId}|${scheduleId}|${sessionDate}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sess-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
