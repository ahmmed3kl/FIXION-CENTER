import { Student } from "../../shared/types";
import { smartSearch } from "../../shared/utils/smartSearch";

export function searchAttendanceStudents(
  students: Student[],
  query: string,
  groupGrade: string | null | undefined,
  centerId: string | null | undefined,
): Student[] {
  const normalizedGroupGrade = groupGrade?.trim().toLocaleLowerCase();
  if (!normalizedGroupGrade || !centerId) return [];

  const matches = smartSearch(students, query, [
    { get: (student) => student.fullName, weight: 3 },
    { get: (student) => student.phone },
    { get: (student) => student.parentPhone },
    { get: (student) => student.studentCode },
    { get: (student) => student.cardCode },
  ]);
  return matches.filter(
    (student) =>
      student.centerId === centerId &&
      typeof student.grade === "string" &&
      student.grade.trim().toLocaleLowerCase() === normalizedGroupGrade,
  );
}
