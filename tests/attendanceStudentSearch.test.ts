import { Student } from "../src/shared/types";
import { searchAttendanceStudents } from "../src/features/attendance/attendanceStudentSearch";

const students: Student[] = [
  {
    id: "student-session",
    centerId: "center-1",
    studentCode: "1001",
    fullName: "أحمد علي",
    phone: "01000000001",
    parentPhone: "01000000002",
    grade: "الصف الثالث الثانوي",
    status: "active",
  },
  {
    id: "student-other-group",
    centerId: "center-1",
    studentCode: "1002",
    fullName: "أحمد حسن",
    phone: "01000000003",
    parentPhone: "01000000004",
    grade: "الصف الثالث الثانوي",
    status: "active",
  },
  {
    id: "student-other-grade",
    centerId: "center-1",
    studentCode: "1003",
    fullName: "أحمد محمود",
    phone: "01000000005",
    parentPhone: "01000000006",
    grade: "الصف الثاني الإعدادي",
    status: "active",
  },
];

describe("attendance student search scope", () => {
  it("shows every matching student in the active group's grade, including students in other groups", () => {
    const results = searchAttendanceStudents(
      students,
      "أحمد",
      "الصف الثالث الثانوي",
    );

    expect(results.map((student) => student.id)).toEqual([
      "student-session",
      "student-other-group",
    ]);
    expect(results.map((student) => student.id)).not.toContain("student-other-grade");
  });

  it("does not show any students when the active group's grade is unavailable", () => {
    const results = searchAttendanceStudents(
      students,
      "",
      null,
    );

    expect(results).toEqual([]);
  });

  it("matches the active group's grade without requiring enrollment in the same group", () => {
    const results = searchAttendanceStudents(
      students,
      "أحمد",
      "  الصف الثالث الثانوي  ",
    );

    expect(results.map((student) => student.id)).toEqual([
      "student-session",
      "student-other-group",
    ]);
  });
});
