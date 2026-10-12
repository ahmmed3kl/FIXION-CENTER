import { DatabaseService } from "../src/core/database";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { GradeBookRepository } from "../src/features/grades/GradeBookRepository";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { getLocalDateOnly } from "../src/shared/utils/date";
import { getTeacherWeekBounds } from "../src/shared/utils/teacherWeeks";
import * as localDateUtils from "../src/shared/utils/date";
import { TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR } from "../src/shared/utils/teacherWeeks";

describe("makeup attendance integration", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
    CardRangeRepository.replaceCenterRanges("center-1", [
      { id: "test-card-range-makeup-integration", startCode: "000000", endCode: "999999" },
    ]);
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
      ["makeup-target-int", centerId, groupId, group.subjectId, group.teacherId, "2099-10-02", "10:00", "12:00", "2026-09-20"],
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
      checkInTime: "2099-10-02T10:30:00.000Z",
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
      checkInTime: "2099-10-02T10:35:00.000Z",
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

  it("selects an eligible scheduled next class, skips ineligible intermediates, and expires at cycle end", () => {
    const centerId = "center-1";
    const groupId = "grp-1";
    const db = DatabaseService.getDb();
    const group = db.getFirstSync<any>(
      "SELECT teacher_id as teacherId, subject_id as subjectId FROM groups WHERE center_id = ? AND id = ?",
      [centerId, groupId],
    );
    expect(group).toBeTruthy();
    const student = StudentRepository.createStudent({
      studentCode: "990003",
      fullName: "Cycle test student",
      phone: "01011110003",
      parentPhone: "01111110003",
      grade: "الصف الثالث الثانوي",
    });
    const otherStudent = StudentRepository.createStudent({
      studentCode: "990004",
      fullName: "Intermediate roster student",
      phone: "01011110004",
      parentPhone: "01111110004",
      grade: "الصف الثالث الثانوي",
    });
    const intermediateStudent = StudentRepository.createStudent({
      studentCode: "990005",
      fullName: "Intermediate target student",
      phone: "01011110005",
      parentPhone: "01111110005",
      grade: "الصف الثالث الثانوي",
    });
    const insertSession = (id: string, date: string, start: string, status: string) => {
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '12:00', ?, ?)`,
        [id, centerId, groupId, group.subjectId, group.teacherId, date, start, status, "2026-10-12"],
      );
    };
    const expectStudent = (sessionId: string, expectedStudentId: string) => {
      db.runSync(
        `INSERT INTO session_expected_students
         (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`cycle-exp-${sessionId}-${expectedStudentId}`, centerId, sessionId, expectedStudentId, "2026-10-12"],
      );
    };

    insertSession("cycle-scheduled-source", "2100-10-02", "07:00", "closed");
    expectStudent("cycle-scheduled-source", student.id);
    insertSession("cycle-scheduled-next", "2100-10-03", "08:00", "scheduled");
    expectStudent("cycle-scheduled-next", student.id);
    insertSession("cycle-scheduled-later", "2100-10-03", "09:00", "open");
    expectStudent("cycle-scheduled-later", student.id);
    expect(MakeupService.getNextEligibleSession(student.id, "cycle-scheduled-source")?.id)
      .toBe("cycle-scheduled-next");

    insertSession("cycle-intermediate-source", "2100-10-02", "10:00", "closed");
    expectStudent("cycle-intermediate-source", intermediateStudent.id);
    insertSession("cycle-ineligible-intermediate", "2100-10-03", "10:30", "scheduled");
    expectStudent("cycle-ineligible-intermediate", otherStudent.id);
    insertSession("cycle-intermediate-target", "2100-10-03", "11:00", "open");
    expectStudent("cycle-intermediate-target", intermediateStudent.id);
    expect(MakeupService.getNextEligibleSession(intermediateStudent.id, "cycle-intermediate-source")?.id)
      .toBe("cycle-intermediate-target");

    const currentWeek = getTeacherWeekBounds(getLocalDateOnly());
    const previousWeekEnd = new Date(`${currentWeek.startDate}T12:00:00`);
    previousWeekEnd.setDate(previousWeekEnd.getDate() - 1);
    const expiredSourceDate = getLocalDateOnly(previousWeekEnd);
    insertSession("cycle-expired-source", expiredSourceDate, "10:00", "closed");
    expectStudent("cycle-expired-source", student.id);
    insertSession("cycle-expired-target", currentWeek.startDate, "10:00", "open");
    expectStudent("cycle-expired-target", student.id);
    expect(MakeupService.getNextEligibleSession(student.id, "cycle-expired-source")).toBeNull();
  });

  it("keeps makeup lookup and saving aligned through success, ineligible intermediates, and cycle expiry", async () => {
    const centerId = "center-1";
    const db = DatabaseService.getDb();
    const sourceGroup = db.getFirstSync<any>(
      "SELECT id, teacher_id as teacherId, subject_id as subjectId, grade FROM groups WHERE center_id = ? AND id = ?",
      [centerId, "grp-1"],
    );
    expect(sourceGroup).toBeTruthy();
    const targetGroupId = `makeup-cycle-target-${Date.now()}`;
    db.runSync(
      `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade)
       VALUES (?, ?, 'Makeup cycle target', ?, ?, ?)`,
      [targetGroupId, centerId, sourceGroup.teacherId, sourceGroup.subjectId, sourceGroup.grade],
    );

    const student = StudentRepository.createStudent({
      studentCode: "990010",
      fullName: "Cycle end success student",
      phone: "01011110010",
      parentPhone: "01111110010",
      grade: sourceGroup.grade,
    });
    const lateStudent = StudentRepository.createStudent({
      studentCode: "990011",
      fullName: "Cycle end expired student",
      phone: "01011110011",
      parentPhone: "01111110011",
      grade: sourceGroup.grade,
    });
    const unrelatedStudent = StudentRepository.createStudent({
      studentCode: "990012",
      fullName: "Intermediate roster student",
      phone: "01011110012",
      parentPhone: "01111110012",
      grade: sourceGroup.grade,
    });
    const insertSession = (
      id: string,
      groupId: string,
      date: string,
      startTime: string,
      status: string,
    ) => db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '12:00', ?, ?)`,
      [id, centerId, groupId, sourceGroup.subjectId, sourceGroup.teacherId, date, startTime, status, "2026-10-12"],
    );
    const expectStudent = (sessionId: string, expectedStudentId: string) => db.runSync(
      `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`makeup-cycle-${sessionId}-${expectedStudentId}`, centerId, sessionId, expectedStudentId, "2026-10-12"],
    );

    const sourceSessionId = `makeup-cycle-source-${Date.now()}`;
    const intermediateSessionId = `makeup-cycle-intermediate-${Date.now()}`;
    const targetSessionId = `makeup-cycle-target-session-${Date.now()}`;
    insertSession(sourceSessionId, "grp-1", "2026-10-12", "10:00", "closed");
    expectStudent(sourceSessionId, student.id);
    expectStudent(sourceSessionId, lateStudent.id);
    insertSession(intermediateSessionId, "grp-1", "2026-10-13", "10:30", "scheduled");
    expectStudent(intermediateSessionId, unrelatedStudent.id);
    insertSession(targetSessionId, targetGroupId, "2026-10-14", "10:00", "open");
    expectStudent(targetSessionId, unrelatedStudent.id);

    const today = jest.spyOn(localDateUtils, "getLocalDateOnly").mockReturnValue("2026-10-13");
    try {
      expect(AttendanceSessionService.isExpected(intermediateSessionId, student.id)).toBe(false);
      expect(MakeupService.getNextEligibleSession(student.id, sourceSessionId, targetSessionId)?.id)
        .toBe(targetSessionId);
      const originalDatabase = DatabaseService.getDb();
      const getDb = jest.spyOn(DatabaseService, "getDb").mockReturnValue({
        getFirstSync: (query: string) => {
          if (query.includes("SELECT s.group_id as groupId")) {
            return {
              groupId: targetGroupId,
              sessionDate: "2026-10-14",
              startTime: "10:00",
              subjectId: sourceGroup.subjectId,
              teacherId: sourceGroup.teacherId,
              groupName: "Makeup cycle target",
              teacherName: "Teacher",
              subjectName: "Subject",
            };
          }
          if (query.includes("SELECT g.id as groupId, g.name as groupName")) {
            return {
              groupId: "grp-1",
              groupName: "Source",
              originalSessionId: sourceSessionId,
              originalSessionDate: "2026-10-12",
              weekStartDay: 6,
            };
          }
          return null;
        },
      } as any);
      expect(AttendanceSessionService.getMakeupEligibility(targetSessionId, student.id))
        .toMatchObject({ eligible: true, originalAbsenceId: sourceSessionId });
      today.mockReturnValue("2026-10-17");
      expect(AttendanceSessionService.getMakeupEligibility(targetSessionId, lateStudent.id))
        .toEqual({ eligible: false });
      getDb.mockRestore();
      expect(DatabaseService.getDb()).toBe(originalDatabase);
      today.mockReturnValue("2026-10-13");

      const recorded = await MakeupService.recordMakeupAttendance({
        studentId: student.id,
        sessionId: targetSessionId,
        originalAbsenceId: sourceSessionId,
        checkInTime: "2026-10-14T10:00:00.000Z",
      });
      expect(recorded.attendanceType).toBe("makeup");
      expect(recorded.originalAbsenceId).toBe(sourceSessionId);
      expect(MakeupService.getNextEligibleSession(student.id, sourceSessionId, targetSessionId)).toBeNull();

      today.mockReturnValue("2026-10-17");
      await expect(MakeupService.recordMakeupAttendance({
        studentId: lateStudent.id,
        sessionId: targetSessionId,
        originalAbsenceId: sourceSessionId,
        checkInTime: "2026-10-14T10:00:00.000Z",
      })).rejects.toMatchObject({ message: TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR });
      await expect(AttendanceRepository.recordAttendance({
        studentId: lateStudent.id,
        sessionId: targetSessionId,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
        checkInTime: "2026-10-14T10:00:00.000Z",
      })).rejects.toMatchObject({ message: TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR });
    } finally {
      today.mockRestore();
    }
  });
});
