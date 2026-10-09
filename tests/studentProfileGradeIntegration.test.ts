import { DatabaseService } from "../src/core/database";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { GradeBookRepository } from "../src/features/grades/GradeBookRepository";
import { saveGradeEdit } from "../src/features/grades/gradeScoreEdit";

describe("student profile grade editing", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  it("persists edited scores for the group gradebook reader", () => {
    const groupId = "grp-1";
    const student = GradeBookRepository.getStudentsForGroup(groupId)[0];
    expect(student).toBeTruthy();

    const exam = GradeBookRepository.createExam(
      "Profile Grade Integration",
      groupId,
      student.grade,
      30,
    );

    const firstSave = saveGradeEdit("", "", (value) =>
      GradeBookRepository.setScore(exam, student.id, value),
    );
    expect(firstSave.saved).toBe(true);

    const editedSave = saveGradeEdit("24", "", (value) =>
      GradeBookRepository.setScore(exam, student.id, value),
    );
    expect(editedSave.saved).toBe(true);

    expect(GradeBookRepository.getScores([exam.id], [student.id])).toMatchObject([
      { examId: exam.id, studentId: student.id, score: 24 },
    ]);
  });
});
