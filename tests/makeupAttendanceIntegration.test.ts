import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { ConnectivityService } from "../src/core/connectivity";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
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

  it("keeps successful cross-group compensation out of the destination group's expected roster", async () => {
    const centerId = "center-1";
    const db = DatabaseService.getDb();
    const sourceGroup = db.getFirstSync<any>(
      "SELECT id, teacher_id as teacherId, subject_id as subjectId, grade FROM groups WHERE center_id = ? AND id = ?",
      [centerId, "grp-1"],
    );
    expect(sourceGroup).toBeTruthy();
    const targetGroupId = "makeup-roster-target-group";
    db.runSync(
      `INSERT INTO groups
       (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, ?, 'Makeup target group', ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
      [targetGroupId, centerId, sourceGroup.teacherId, sourceGroup.subjectId, sourceGroup.grade, "2026-10-13", "2026-10-13"],
    );
    const visitor = StudentRepository.createStudent({
      studentCode: "990021",
      fullName: "Cross Group Makeup Visitor",
      phone: "01011110021",
      parentPhone: "01111110021",
      grade: sourceGroup.grade,
    });
    const sourceSessionId = "makeup-roster-source-session";
    const targetSessionId = "makeup-roster-target-session";
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-01', '10:00', '12:00', 'closed', '2026-10-13')`,
      [sourceSessionId, centerId, "grp-1", sourceGroup.subjectId, sourceGroup.teacherId],
    );
    db.runSync(
      `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-13')`,
      [`exp-${sourceSessionId}-${visitor.id}`, centerId, sourceSessionId, visitor.id],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-02', '10:00', '12:00', 'open', '2026-10-13')`,
      [targetSessionId, centerId, targetGroupId, sourceGroup.subjectId, sourceGroup.teacherId],
    );
    const targetRosterSummary = AttendanceSessionService.getSummary(targetSessionId);
    db.runSync(
      `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-13')`,
      [`exp-comp-${targetSessionId}-${visitor.id}`, centerId, targetSessionId, visitor.id],
    );
    db.runSync(
      `INSERT INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
       VALUES (?, ?, ?, ?, '2099-10-02T10:30:00.000Z', 'present', 0, 'makeup', ?, 0, ?)`,
      ["makeup-roster-attendance", centerId, visitor.id, targetSessionId, sourceSessionId, "makeup-roster-operation"],
    );

    expect(AttendanceSessionService.isExpected(targetSessionId, visitor.id)).toBe(false);
    expect(AttendanceSessionService.getSummary(targetSessionId)).toEqual({
      ...targetRosterSummary,
      makeup: 1,
    });
    expect(db.getFirstSync<any>(
      "SELECT original_absence_id as originalAbsenceId FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
      [centerId, targetSessionId, visitor.id],
    )?.originalAbsenceId).toBe(sourceSessionId);
  });

  it("filters legacy compensation snapshots from expected and absent lists without changing makeup links", () => {
    const centerId = "center-1";
    const db = DatabaseService.getDb();
    const sourceGroup = db.getFirstSync<any>(
      "SELECT id, teacher_id as teacherId, subject_id as subjectId, grade FROM groups WHERE center_id = ? AND id = ?",
      [centerId, "grp-1"],
    );
    expect(sourceGroup).toBeTruthy();
    const targetGroupId = "legacy-makeup-stale-roster-group";
    db.runSync(
      `INSERT INTO groups
       (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, ?, 'Legacy makeup stale roster', ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
      [targetGroupId, centerId, sourceGroup.teacherId, sourceGroup.subjectId, sourceGroup.grade, "2026-10-13", "2026-10-13"],
    );
    const visitors = ["990031", "990032", "990033"].map((studentCode) =>
      StudentRepository.createStudent({
        studentCode,
        fullName: `Legacy makeup visitor ${studentCode}`,
        phone: "01011110031",
        parentPhone: "01111110031",
        grade: sourceGroup.grade,
      }),
    );
    const realMember = StudentRepository.createStudent({
      studentCode: "990034",
      fullName: "Eligible group member with makeup history",
      phone: "01011110034",
      parentPhone: "01111110034",
      grade: sourceGroup.grade,
    });
    EnrollmentRepository.enrollStudent({
      studentId: realMember.id,
      groupId: targetGroupId,
      startDate: "2099-10-04",
    });

    const sourceSessionId = "legacy-makeup-source-session";
    const previousMakeupSessionId = "legacy-makeup-history-session";
    const currentSessionId = "legacy-makeup-current-session";
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-01', '10:00', '12:00', 'closed', '2026-10-13')`,
      [sourceSessionId, centerId, "grp-1", sourceGroup.subjectId, sourceGroup.teacherId],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-03', '10:00', '12:00', 'closed', '2026-10-13')`,
      [previousMakeupSessionId, centerId, targetGroupId, sourceGroup.subjectId, sourceGroup.teacherId],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-04', '10:00', '12:00', 'open', '2026-10-13')`,
      [currentSessionId, centerId, targetGroupId, sourceGroup.subjectId, sourceGroup.teacherId],
    );

    for (const visitor of visitors) {
      db.runSync(
        `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, '2026-10-13')`,
        [`exp-${sourceSessionId}-${visitor.id}`, centerId, sourceSessionId, visitor.id],
      );
      db.runSync(
        `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, '2026-10-13')`,
        [`exp-${currentSessionId}-${visitor.id}`, centerId, currentSessionId, visitor.id],
      );
      db.runSync(
        `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES (?, ?, ?, ?, '2099-10-03T10:30:00.000Z', 'present', 0, 'makeup', ?, 0, ?)`,
        [`legacy-makeup-${visitor.id}`, centerId, visitor.id, previousMakeupSessionId, sourceSessionId, `legacy-makeup-op-${visitor.id}`],
      );
    }
    db.runSync(
      `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-13')`,
      [`exp-${currentSessionId}-${realMember.id}`, centerId, currentSessionId, realMember.id],
    );

    const expectedStudents = SessionRepository.getExpectedStudents(currentSessionId);
    expect(expectedStudents.map((student) => student.id)).toEqual([realMember.id]);
    expect(AbsenceService.getAbsenteesForSession(currentSessionId).map((student) => student.id)).toEqual([realMember.id]);
    expect(AttendanceSessionService.getSummary(currentSessionId)).toEqual({
      total: 1,
      present: 0,
      absent: 1,
      makeup: 0,
    });
    for (const visitor of visitors) {
      expect(AttendanceSessionService.isExpected(currentSessionId, visitor.id)).toBe(false);
    }
    expect(AttendanceSessionService.isExpected(currentSessionId, realMember.id)).toBe(true);

    // Simulate a sync refresh replaying the old rows: reads must still apply
    // the same relationship check and never surface those rows as absences.
    for (const visitor of visitors) {
      db.runSync(
        `INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, '2026-10-13')`,
        [`exp-${currentSessionId}-${visitor.id}`, centerId, currentSessionId, visitor.id],
      );
    }
    expect(SessionRepository.getExpectedStudents(currentSessionId).map((student) => student.id)).toEqual([realMember.id]);
    expect(AttendanceSessionService.getSummary(currentSessionId).absent).toBe(1);
    expect(db.getAllSync<any>(
      `SELECT student_id as studentId, original_absence_id as originalAbsenceId
       FROM attendance WHERE center_id = ? AND session_id = ?`,
      [centerId, previousMakeupSessionId],
    ).map((row: any) => row.originalAbsenceId)).toEqual([sourceSessionId, sourceSessionId, sourceSessionId]);
  });

  it("records a newly enrolled attendance-screen student once and retains session outbox work", async () => {
    const centerId = "center-1";
    const groupId = "grp-1";
    const sessionId = "attendance-add-flow-session";
    const db = DatabaseService.getDb();
    const group = db.getFirstSync<any>(
      "SELECT teacher_id as teacherId, subject_id as subjectId, grade FROM groups WHERE center_id = ? AND id = ?",
      [centerId, groupId],
    );
    expect(group).toBeTruthy();
    const student = StudentRepository.createStudent({
      studentCode: "990022",
      fullName: "Attendance Add Flow Student",
      phone: "01011110022",
      parentPhone: "01111110022",
      grade: group.grade,
    });
    EnrollmentRepository.enrollStudent({
      studentId: student.id,
      groupId,
      startDate: "2099-10-03",
    });
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-10-03', '10:00', '12:00', 'open', '2026-10-13')`,
      [sessionId, centerId, groupId, group.subjectId, group.teacherId],
    );

    ConnectivityService.setState("offline");
    try {
      AttendanceSessionService.addEnrolledStudentToOpenSession(sessionId, student.id);
      expect(AttendanceSessionService.isExpected(sessionId, student.id)).toBe(true);
      await AttendanceRepository.recordAttendance({
        studentId: student.id,
        sessionId,
        status: "present",
        isLate: false,
      });
      expect(AttendanceRepository.isAlreadyAttended(sessionId, student.id)).toBe(true);

      AttendanceSessionService.addEnrolledStudentToOpenSession(sessionId, student.id);
      expect(db.getAllSync<any>(
        "SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
        [centerId, sessionId, student.id],
      )).toHaveLength(1);
      expect(SyncRepository.getByOperationId(
        `op-session-roster-add-${sessionId}-${student.id}`,
      )?.status).toBe("pending");
      const attendanceOperationId = db.getFirstSync<any>(
        "SELECT operation_id as operationId FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
        [centerId, sessionId, student.id],
      )?.operationId;
      expect(attendanceOperationId).toBeTruthy();
      expect(SyncRepository.getByOperationId(attendanceOperationId)?.status).toBe("pending");
    } finally {
      ConnectivityService.setState("online");
    }
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
