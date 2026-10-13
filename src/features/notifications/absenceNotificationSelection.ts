export function beginAbsenceRecipientSelection(studentId: string): Set<string> {
  return new Set([studentId]);
}

export function toggleAbsenceRecipientSelection(
  selectedStudentIds: ReadonlySet<string>,
  studentId: string,
): Set<string> {
  const next = new Set(selectedStudentIds);
  if (next.has(studentId)) next.delete(studentId);
  else next.add(studentId);
  return next;
}

export function toggleAllAbsenceRecipientSelection(
  selectedStudentIds: ReadonlySet<string>,
  allAbsentStudentIds: readonly string[],
): Set<string> {
  const allSelected = allAbsentStudentIds.length > 0 &&
    allAbsentStudentIds.every((studentId) => selectedStudentIds.has(studentId));
  return allSelected ? new Set<string>() : new Set(allAbsentStudentIds);
}

export function getSelectedAbsenceRecipientIds(
  selectedStudentIds: Iterable<string>,
  scopedStudentIds: readonly string[],
): string[] {
  const selected = new Set(selectedStudentIds);
  return Array.from(new Set(scopedStudentIds.filter((studentId) => selected.has(studentId))));
}

export function hasValidNotificationContact(...contacts: Array<string | null | undefined>): boolean {
  return contacts.some((contact) => {
    const digits = String(contact || "").replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15;
  });
}

export function absenceNotificationOperationPrefix(sessionId: string, studentId: string): string {
  let hash = 2166136261;
  for (const character of `${sessionId}:${studentId}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `op-as-${(hash >>> 0).toString(36)}`;
}
