import { mergeGradeScoreDrafts } from "../src/features/grades/gradeScoreDrafts";

describe("mergeGradeScoreDrafts", () => {
  it("refreshes saved scores while retaining unsaved edits", () => {
    expect(mergeGradeScoreDrafts(
      { "exam-1:student-1": "draft", "exam-2:student-1": "old" },
      { "exam-1:student-1": "saved", "exam-2:student-1": "old" },
      { "exam-1:student-1": "server", "exam-2:student-1": "new" },
    )).toEqual({
      "exam-1:student-1": "draft",
      "exam-2:student-1": "new",
    });
  });

  it("keeps a deliberate blank draft but drops drafts for records no longer present", () => {
    expect(mergeGradeScoreDrafts(
      { "exam-1:student-1": "", "exam-2:student-1": "stale" },
      { "exam-1:student-1": "saved", "exam-2:student-1": "saved" },
      { "exam-1:student-1": "updated" },
    )).toEqual({ "exam-1:student-1": "" });
  });
});
