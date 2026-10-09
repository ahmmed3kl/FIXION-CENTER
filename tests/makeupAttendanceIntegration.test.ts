import { DatabaseService } from "../src/core/database";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { GradeBookRepository } from "../src/features/grades/GradeBookRepository";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("makeup attendance integration", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  it("keeps makeup visitors out of regular attendance and exam rosters without blocking normal attendance", async () => {
    const centerId = "center-1";
    const groupId = "grp-1";
    const db = DatabaseService.getDb();
    const group = db.getFirstSync<any>(
      "SELECT id, teacher_id as teacherId, subject_id as subjectId, grade FROM groups WHERE center_id = ? AND id = ?",
      [centerId, groupId],
    );
    expect(group).toBeTruthy();

    const makeupStudent = StudentRepository.createStudent({
      studentCode: "990001",
      fullName: "Makeup Visitor",
      phone: "01011110001",
      parentPhone: "01111110001",
      grade: group.grade,
    });
    const examRosterBefore = GradeBookRepository.getStudentsForGroup(groupId);
    expect(examRosterBefore.length).toBeGreaterThan(0);
    const regularStudent = examRosterBefore[0];

    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["makeup-source-int", centerId, groupId, group.subjectId, group.teacherId, "2099-10-01", "10:00", "12:00", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["makeup-source-expected-int", centerId, "makeup-source-int", makeupStudent.id, "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["makeup-target-int", centerId, groupId, group.subjectId, group.teacherId, "2099-10-08", "10:00", "12:00", "2026-09-20"],
    );

    expect(AttendanceSessionService.getSummary("makeup-target-int")).toEqual({
      total: examRosterBefore.length,
      present: 0,
      absent: examRosterBefore.length,
      makeup: 0,
    });
    expect(AttendanceSessionService.isExpected("makeup-target-int", makeupStudent.id)).toBe(false);

    const makeupAttendance = await MakeupService.recordMakeupAttendance({
      studentId: makeupStudent.id,
      sessionId: "makeup-target-int",
      originalAbsenceId: "makeup-source-int",
      checkInTime: "2099-10-08T10:30:00.000Z",
    });
    expect(makeupAttendance.attendanceType).toBe("makeup");
    expect(
      AttendanceSessionService.isExpected("makeup-target-int", makeupStudent.id),
    ).toBe(false);
    expect(AttendanceSessionService.getSummary("makeup-target-int")).toEqual({
      total: examRosterBefore.length,
      present: 0,
      absent: examRosterBefore.length,
      makeup: 1,
    });

    const exam = GradeBookRepository.createExam(
      "Integration Exam",
      groupId,
      group.grade,
      20,
      "makeup-target-int",
    );
    const gradeRoster = GradeBookRepository.getStudentsForGroup(groupId);
    expect(gradeRoster.map((student) => student.id)).toEqual(examRosterBefore.map((student) => student.id));
    expect(gradeRoster.map((student) => student.id)).not.toContain(makeupStudent.id);
    expect(GradeBookRepository.getScores([exam.id], [makeupStudent.id])).toEqual([]);

    const savedScore = GradeBookRepository.setScore(exam, regularStudent.id, "18");
    expect(savedScore.studentId).toBe(regularStudent.id);
    expect(GradeBookRepository.getScores([exam.id], [makeupStudent.id])).toEqual([]);
    expect(
      GradeBookRepository.getScores([exam.id], [regularStudent.id, makeupStudent.id]).map((score) => score.studentId),
    ).toEqual([regularStudent.id]);

    const regularAttendance = await AttendanceRepository.recordAttendance({
      studentId: regularStudent.id,
      sessionId: "makeup-target-int",
      status: "present",
      isLate: false,
      checkInTime: "2099-10-08T10:35:00.000Z",
    });
    expect(regularAttendance.attendanceType).toBe("present");
    expect(AttendanceSessionService.getSummary("makeup-target-int")).toEqual({
      total: examRosterBefore.length,
      present: 1,
      absent: examRosterBefore.length - 1,
      makeup: 1,
    });
    expect(
      AttendanceSessionService.isExpected("makeup-target-int", regularStudent.id),
    ).toBe(true);
    const regularAttendanceRoster = SessionRepository.getExpectedStudents("makeup-target-int");
    expect(regularAttendanceRoster.map((student) => student.id)).toContain(regularStudent.id);
    expect(regularAttendanceRoster.map((student) => student.id)).not.toContain(makeupStudent.id);
    expect(
      AttendanceRepository.getSessionAttendance("makeup-target-int").map((attendance) => attendance.attendanceType),
    ).toEqual(["makeup", "present"]);
  });
});
