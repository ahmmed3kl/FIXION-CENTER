import { DatabaseService } from "../src/core/database";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { AbsenceReportsService } from "../src/features/attendance/AbsenceReportsService";
import { NotificationService } from "../src/features/notifications/NotificationService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { SessionDateService } from "../src/features/sessions/SessionDateService";
import { ConflictError } from "../src/core/errors";

const SyncProcessor = require("../backend/src/services/SyncProcessor");

describe("Makeup attendance and absence reports comprehensive fixes", () => {
  const centerId = "center-1";
  const teacherId = "teacher-makeup-test";
  const subjectId = "subject-makeup-test";
  const grade1 = "الصف الأول الثانوي";
  const grade2 = "الصف الثاني الثانوي";

  let student1: any;
  let currentDateSpy: jest.SpyInstance;

  beforeAll(async () => {
    currentDateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-02");
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter(centerId);

    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
      [centerId, "Center 1", "C1", "Africa/Cairo"],
    );
    CardRangeRepository.replaceCenterRanges(centerId, [
      { id: "test-card-range-makeup", startCode: "000000", endCode: "999999" },
    ]);

    db.runSync(
      `INSERT OR REPLACE INTO teachers (id, center_id, name, subject_id, week_start_day)
       VALUES (?, ?, ?, ?, ?)`,
      [teacherId, centerId, "Teacher Test", subjectId, 6], // Saturday
    );

    // Create 3 groups: Group A (grade1), Group B (grade1, parallel for makeup), Group C (grade2, different grade)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      ["grp-a", centerId, "مجموعة أ (أولى ثانوي)", subjectId, teacherId, grade1],
    );
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      ["grp-b", centerId, "مجموعة ب (أولى ثانوي)", subjectId, teacherId, grade1],
    );
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 120, 'active')`,
      ["grp-c", centerId, "مجموعة ج (تانية ثانوي)", subjectId, teacherId, grade2],
    );

    student1 = StudentRepository.createStudent({
      studentCode: "880001",
      fullName: "طالب تجربة التعويض",
      phone: "01011112222",
      parentPhone: "01111112222",
      grade: grade1,
    });

    // Enroll student in group A
    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date)
       VALUES (?, ?, ?, ?, 'active', '2026-09-01')`,
      ["enr-student-1", centerId, student1.id, "grp-a"],
    );
  });

  it("Scenario 1: Records explicit absence in original session without deleting or converting to present", () => {
    const db = DatabaseService.getDb();
    const sourceSessionId = "session-orig-1";

    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-a', ?, ?, '2026-10-01', '10:00', '12:00', 'open', '2026-10-01T08:00:00.000Z')`,
      [sourceSessionId, centerId, subjectId, teacherId],
    );
    db.runSync(
      `INSERT OR REPLACE INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-01T08:00:00.000Z')`,
      ["exp-orig-1", centerId, sourceSessionId, student1.id],
    );

    // Record absence
    db.runSync(
      `INSERT OR REPLACE INTO attendance
       (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES (?, ?, ?, ?, '2026-10-01T10:00:00.000Z', 'absent', 0, 'present', 'op-abs-1')`,
      ["att-orig-absent", centerId, student1.id, sourceSessionId],
    );

    const record = AttendanceRepository.getStudentAttendanceInSession(sourceSessionId, student1.id);
    expect(record).toBeTruthy();
    expect(record?.status).toBe("absent");
    expect(record?.attendanceType).toBe("present");
  });

  it("Scenario 2: Academic grade check rejects group C (different grade) and accepts group B (same grade)", async () => {
    const db = DatabaseService.getDb();
    const sourceSessionId = "session-orig-1";
    const targetSessionDiffGrade = "session-diff-grade";
    const targetSessionSameGrade = "session-target-b";

    // Target session in group C (different grade)
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-c', ?, ?, '2026-10-02', '10:00', '12:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [targetSessionDiffGrade, centerId, subjectId, teacherId],
    );

    // Target session in group B (same grade)
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-b', ?, ?, '2026-10-02', '14:00', '16:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [targetSessionSameGrade, centerId, subjectId, teacherId],
    );

    // Check eligibility for group C session: must be false due to grade mismatch
    const eligDiffGrade = MakeupService.getEligibilityForSession(
      targetSessionDiffGrade,
      student1.id,
    );
    expect(eligDiffGrade.eligible).toBe(false);

    // Attempting to record attendance in group C session is rejected due to grade mismatch
    await expect(
      AttendanceRepository.recordAttendance({
        studentId: student1.id,
        sessionId: targetSessionDiffGrade,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      }),
    ).rejects.toThrow("التعويض يجب أن يكون في الحصة التالية لنفس المادة والمدرس ونفس المرحلة الدراسية.");

    // Check eligibility for group B session: must be true
    const eligSameGrade = MakeupService.getEligibilityForSession(
      targetSessionSameGrade,
      student1.id,
    );
    expect(eligSameGrade.eligible).toBe(true);
  });

  it("Scenario 3 & 4: Validates and records makeup attendance in alternative session", async () => {
    const sourceSessionId = "session-orig-1";
    const targetSessionSameGrade = "session-target-b";

    const makeup = await AttendanceRepository.recordAttendance({
      studentId: student1.id,
      sessionId: targetSessionSameGrade,
      status: "present",
      isLate: false,
      attendanceType: "makeup",
      originalAbsenceId: sourceSessionId,
    });

    expect(makeup).toBeTruthy();
    expect(makeup.status).toBe("present");
    expect(makeup.attendanceType).toBe("makeup");
    expect(makeup.originalAbsenceId).toBe(sourceSessionId);
    expect(makeup.sessionId).toBe(targetSessionSameGrade);
  });

  it("Scenario 5: Preserves original absence in SQLite and registers sync operation", () => {
    const db = DatabaseService.getDb();
    const sourceSessionId = "session-orig-1";
    const targetSessionSameGrade = "session-target-b";

    // 1. Original absence record MUST remain intact with status = 'absent'
    const origAttendance = db.getFirstSync<any>(
      `SELECT status, attendance_type FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sourceSessionId, student1.id],
    );
    expect(origAttendance).toBeTruthy();
    expect(origAttendance.status).toBe("absent");
    expect(origAttendance.attendance_type).not.toBe("makeup");

    // 2. Makeup attendance record exists in target session
    const makeupAttendance = db.getFirstSync<any>(
      `SELECT status, attendance_type, original_absence_id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, targetSessionSameGrade, student1.id],
    );
    expect(makeupAttendance).toBeTruthy();
    expect(makeupAttendance.status).toBe("present");
    expect(makeupAttendance.attendance_type).toBe("makeup");
    expect(makeupAttendance.original_absence_id).toBe(sourceSessionId);

    // 3. Sync operation enqueued
    const syncOp = db.getFirstSync<any>(
      `SELECT entity_type, operation_type, payload FROM sync_operations
       WHERE center_id = ? AND entity_type = 'attendance'
       ORDER BY created_at DESC LIMIT 1`,
      [centerId],
    );
    expect(syncOp).toBeTruthy();
    const payload = JSON.parse(syncOp.payload);
    expect(payload.attendance_type || payload.attendanceType).toBe("makeup");
    expect(payload.original_absence_id || payload.originalAbsenceId).toBe(sourceSessionId);
  });

  it("Scenario 6: Server SyncProcessor.validateMakeupAttendance validates grades, dates, and absences", async () => {
    const mockClient = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes("FROM sessions s") && params[1] === "srv-source") {
          return {
            rows: [
              {
                id: "srv-source",
                group_id: "grp-a",
                session_date: "2026-10-01",
                start_time: "10:00",
                status: "closed",
                validated_group_id: "grp-a",
                group_grade: grade1,
                subject_id: subjectId,
                teacher_id: teacherId,
              },
            ],
          };
        }
        if (sql.includes("FROM session_id_aliases")) {
          return { rows: [] };
        }
        if (sql.includes("FROM attendance") && sql.includes("session_id = ANY")) {
          return {
            rows: [
              {
                id: "att-srv-source",
                session_id: "srv-source",
                status: "absent",
                attendance_type: "present",
              },
            ],
          };
        }
        if (sql.includes("FROM advance_coverages")) {
          return { rows: [] };
        }
        if (sql.includes("FROM attendance") && sql.includes("original_absence_id = ANY")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    // Case A: Reject mismatched grade on server
    const targetDiffGrade = {
      id: "srv-target-c",
      session_date: "2026-10-02",
      start_time: "10:00",
      group_grade: grade2,
      subject_id: subjectId,
      teacher_id: teacherId,
    };
    await expect(
      SyncProcessor.validateMakeupAttendance(mockClient, {
        centerId,
        sourceSessionId: "srv-source",
        targetSession: targetDiffGrade,
        targetSessionId: "srv-target-c",
        studentId: student1.id,
      }),
    ).rejects.toThrow("MAKEUP_TARGET_INVALID: source and target sessions must belong to the same academic grade.");

    // Case B: Accept matching grade on server
    const targetSameGrade = {
      id: "srv-target-b",
      session_date: "2026-10-02",
      start_time: "14:00",
      group_grade: grade1,
      subject_id: subjectId,
      teacher_id: teacherId,
    };
    await expect(
      SyncProcessor.validateMakeupAttendance(mockClient, {
        centerId,
        sourceSessionId: "srv-source",
        targetSession: targetSameGrade,
        targetSessionId: "srv-target-b",
        studentId: student1.id,
      }),
    ).resolves.not.toThrow();
  });

  it("Scenario 7: Surfaces makeup completion with target group and date in absence reports", () => {
    const sourceSessionId = "session-orig-1";
    const report = AbsenceReportsService.getSessionReport(sourceSessionId);

    // The student remains in the original session's absent list for historical accuracy
    expect(report.absent.some((s) => s.id === student1.id)).toBe(true);

    // AND the student's makeup is surfaced in compensation rows with completed kind and targetSession details
    const compRow = report.compensation.find(
      (c) => c.student.id === student1.id && c.kind === "completed",
    );
    expect(compRow).toBeTruthy();
    expect(compRow?.targetSession?.id).toBe("session-target-b");
    expect(compRow?.targetSession?.groupName).toBe("مجموعة ب (أولى ثانوي)");
    expect(compRow?.targetSession?.sessionDate).toBe("2026-10-02");

    // getMonthlyCrossGroupMakeups also includes the student
    const monthlyMakeups = AbsenceReportsService.getMonthlyCrossGroupMakeups("2026-10");
    const studentMonthly = monthlyMakeups.find((m) => m.student.id === student1.id);
    expect(studentMonthly).toBeTruthy();
    expect(studentMonthly?.originalSession.id).toBe(sourceSessionId);
    expect(studentMonthly?.targetSession.id).toBe("session-target-b");
  });

  it("Scenario 8: Blocks misleading absence notifications to students who completed makeup", async () => {
    const sourceSessionId = "session-orig-1";

    // 1. Client-side NotificationService.findExplicitAbsence returns null
    const explicitAbsence = NotificationService.findExplicitAbsence(
      centerId,
      sourceSessionId,
      student1.id,
    );
    expect(explicitAbsence).toBeNull();

    // 2. Client notifyAbsentees throws ConflictError because student is already compensated
    expect(() => {
      NotificationService.notifyAbsentees({
        sessionId: sourceSessionId,
        selectedStudentIds: [student1.id],
      });
    }).toThrow("تغيّرت حالة أحد الطلاب؛ لا يمكن إرسال إشعار إلا عن غياب صريح صالح حاليًا.");

    // 3. Server-side SyncProcessor rejects notification
    const mockClient = {
      query: jest.fn(async (sql) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rows: [
              {
                id: sourceSessionId,
                status: "open",
                group_id: "grp-a",
                validated_group_id: "grp-a",
              },
            ],
          };
        }
        if (sql.includes("FROM students")) {
          return { rows: [{ center_id: centerId, deleted_at: null }] };
        }
        if (sql.includes("FROM session_id_aliases")) {
          return { rows: [] };
        }
        if (sql.includes("FROM attendance") && sql.includes("FOR UPDATE")) {
          return {
            rows: [
              { id: "att-orig-absent", status: "absent", attendance_type: "present" },
            ],
          };
        }
        if (sql.includes("FROM advance_coverages")) {
          return { rows: [] };
        }
        if (sql.includes("attendance_type = 'makeup'")) {
          return {
            rows: [
              { id: "att-makeup-target", original_absence_id: sourceSessionId },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    await expect(
      SyncProcessor.validateExplicitAbsenceForNotification(mockClient, {
        centerId,
        sessionId: sourceSessionId,
        studentId: student1.id,
      }),
    ).rejects.toThrow("ABSENCE_NOTIFICATION_NO_LONGER_ABSENT: session is compensated by makeup attendance.");
  });

  it("Scenario 9: Rejects duplicate makeup for the same absence and preserves closed/cancelled sessions", async () => {
    const sourceSessionId = "session-orig-1";
    const db = DatabaseService.getDb();

    // Create another parallel session in group B on the same cycle day
    const sessionThird = "session-target-b2";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-b', ?, ?, '2026-10-02', '16:00', '18:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [sessionThird, centerId, subjectId, teacherId],
    );

    // Attempting a second makeup for the same original absence throws ConflictError
    await expect(
      AttendanceRepository.recordAttendance({
        studentId: student1.id,
        sessionId: sessionThird,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      }),
    ).rejects.toThrow("تم تسجيل تعويض لهذا الغياب مسبقًا.");

    // Closed session rejects recording
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-b', ?, ?, '2026-10-04', '10:00', '12:00', 'closed', '2026-10-04T08:00:00.000Z')`,
      ["session-closed", centerId, subjectId, teacherId],
    );
    await expect(
      AttendanceRepository.recordAttendance({
        studentId: student1.id,
        sessionId: "session-closed",
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      }),
    ).rejects.toThrow("ابدأ جلسة الحضور قبل تسجيل الطالب.");

    // Cancelled session rejects recording
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-b', ?, ?, '2026-10-05', '10:00', '12:00', 'cancelled', '2026-10-05T08:00:00.000Z')`,
      ["session-cancelled", centerId, subjectId, teacherId],
    );
    await expect(
      AttendanceRepository.recordAttendance({
        studentId: student1.id,
        sessionId: "session-cancelled",
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      }),
    ).rejects.toThrow("ابدأ جلسة الحضور قبل تسجيل الطالب.");
  });

  afterAll(() => {
    currentDateSpy.mockRestore();
  });
});

