/** Deterministic, short identifiers for natural records created offline. */
export function stableSessionId(centerId: string, groupId: string, scheduleId: string, sessionDate: string): string {
  const normalizedCenterId = centerId.trim();
  const normalizedGroupId = groupId.trim();
  const normalizedScheduleId = scheduleId.trim();
  const normalizedDate = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(sessionDate.trim())?.[1];
  if (!normalizedCenterId || !normalizedGroupId || !normalizedScheduleId || !normalizedDate) {
    throw new Error("A scheduled session identity requires center, group, schedule, and date.");
  }
  const input = `${normalizedCenterId}|${normalizedGroupId}|${normalizedScheduleId}|${normalizedDate}`;
  let firstHash = 2166136261;
  let secondHash = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 16777619);
    secondHash = Math.imul(secondHash ^ (code + index), 2246822519);
  }
  const first = (firstHash >>> 0).toString(16).padStart(8, "0");
  const second = (secondHash >>> 0).toString(16).padStart(8, "0");
  return `sess-${first}${second}`;
}
