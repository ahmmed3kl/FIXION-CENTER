export function mergeGradeScoreDrafts(
  currentDrafts: Record<string, string>,
  previousSavedScores: Record<string, string>,
  nextSavedScores: Record<string, string>,
): Record<string, string> {
  const merged = { ...nextSavedScores };
  for (const [key, value] of Object.entries(currentDrafts)) {
    if (
      Object.prototype.hasOwnProperty.call(nextSavedScores, key) &&
      value !== (previousSavedScores[key] ?? "")
    ) {
      merged[key] = value;
    }
  }
  return merged;
}
