export type GradeScoreEditResult =
  | { saved: true; value: string }
  | { saved: false; value: string; error: unknown };

export function saveGradeEdit(
  value: string,
  previousValue: string,
  persist: (value: string) => unknown,
): GradeScoreEditResult {
  try {
    persist(value);
    return { saved: true, value };
  } catch (error) {
    return { saved: false, value: previousValue, error };
  }
}
