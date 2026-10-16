import { DatabaseService } from "../src/core/database";
import { SyncEngine } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { findAttendanceStudentByNormalizedCode } from "../src/features/attendance/barcodeAttendance";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { SessionDateService } from "../src/features/sessions/SessionDateService";
import { searchAttendanceStudents } from "../src/features/attendance/attendanceStudentSearch";

describe("Makeup focused verification tests", () => {
  const centerId = "center-1";
  const teacherId = "teacher-verify-1";
  const subjectId = "subject-verify-1";
  const grade1 = "الصف الأول الثانوي";
  const grade2 = "الصف الثاني الثانوي";

  let studentEligible: any;
  let studentIneligible: any;
  let currentDateSpy: jest.SpyInstance;
  let syncSpy: jest.SpyInstance;

  beforeAll(async () => {
    currentDateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-02");
    syncSpy = jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "offline",
      arabicMessage: "غير متصل",
    });
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter(centerId);

    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
      [centerId, "Center Verify", "CV1", "Africa/Cairo"],
    );
    CardRangeRepository.replaceCenterRanges(centerId, [
      { id: "test-card-range-verify", startCode: "000000", endCode: "999999" },
    ]);

    db.runSync(
      `INSERT OR REPLACE INTO teachers (id, center_id, name, subject_id, week_start_day)
       VALUES (?, ?, ?, ?, ?)`,
      [teacherId, centerId, "أستاذ التجربة", subjectId, 6],
    );

    // Group A (Grade 1 - original group)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      ["grp-v-a", centerId, "مجموعة أ (أولى ثانوي)", subjectId, teacherId, grade1],
    );
    // Group B (Grade 1 - parallel makeup target)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      ["grp-v-b", centerId, "مجموعة ب (أولى ثانوي)", subjectId, teacherId, grade1],
    );
    // Group C (Grade 2 - different grade, ineligible)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 120, 'active')`,
      ["grp-v-c", centerId, "مجموعة ج (تانية ثانوي)", subjectId, teacherId, grade2],
    );

    // Create eligible student (Grade 1)
    studentEligible = StudentRepository.createStudent({
      studentCode: "0880010",
      cardCode: "100010",
      fullName: "زياد أحمد محمود",
      phone: "01011113333",
      parentPhone: "01111113333",
      grade: grade1,
    });

    // Create ineligible student (Grade 2)
    studentIneligible = StudentRepository.createStudent({
      studentCode: "0880020",
      cardCode: "100020",
      fullName: "كريم ممدوح حسن",
      phone: "01011114444",
      parentPhone: "01111114444",
      grade: grade2,
    });

    // Legacy rows may use a differently cased active status and have no active card-history row.
    db.runSync(
      "UPDATE students SET status = 'ACTIVE' WHERE center_id = ? AND id = ?",
      [centerId, studentEligible.id],
    );
    db.runSync(
      "UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE center_id = ? AND student_id = ?",
      ["2026-10-02T08:00:00.000Z", centerId, studentEligible.id],
    );

    // Enrollments
    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date)
       VALUES (?, ?, ?, ?, 'active', '2026-09-01')`,
      ["enr-v-1", centerId, studentEligible.id, "grp-v-a"],
    );
    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date)
       VALUES (?, ?, ?, ?, 'active', '2026-09-01')`,
      ["enr-v-2", centerId, studentIneligible.id, "grp-v-c"],
    );

    // Original session in Group A with explicit absence for studentEligible
    const origSessionId = "session-v-orig";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-v-a', ?, ?, '2026-10-01', '10:00', '12:00', 'open', '2026-10-01T08:00:00.000Z')`,
      [origSessionId, centerId, subjectId, teacherId],
    );
    db.runSync(
      `INSERT OR REPLACE INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10-01T08:00:00.000Z')`,
      ["exp-v-1", centerId, origSessionId, studentEligible.id],
    );
    db.runSync(
      `INSERT OR REPLACE INTO attendance
       (id, center_id, session_id, student_id, status, attendance_type, recorded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'absent', 'present', '2026-10-01T10:30:00.000Z', '2026-10-01T10:30:00.000Z', '2026-10-01T10:30:00.000Z')`,
      [`att-default-${origSessionId}-${studentEligible.id}`, centerId, origSessionId, studentEligible.id],
    );

    // Active target makeup session in Group B
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-v-b', ?, ?, '2026-10-02', '12:00', '14:00', 'open', '2026-10-02T08:00:00.000Z')`,
      ["session-v-target", centerId, subjectId, teacherId],
    );
  });

  afterAll(() => {
    currentDateSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it("يعثر على طالب التعويض بالاسم والباركود ويسجل التعويض مرة واحدة فقط", async () => {
    const targetSessionId = "session-v-target";
    const session = SessionRepository.findById(targetSessionId);
    expect(session).not.toBeNull();

    const groupGrade = session?.groupGrade || undefined;
    expect(groupGrade).toBe(grade1);

    const allStudents = StudentRepository.getAllForAttendance();
    expect(allStudents.some((student) => student.id === studentEligible.id)).toBe(true);

    const searchResultsName = searchAttendanceStudents(allStudents, "زياد", groupGrade, centerId);
    expect(searchResultsName.some((s) => s.id === studentEligible.id)).toBe(true);

    const searchResultsIneligible = searchAttendanceStudents(allStudents, "كريم", groupGrade, centerId);
    expect(searchResultsIneligible.some((s) => s.id === studentIneligible.id)).toBe(false);

    const foundByCard = findAttendanceStudentByNormalizedCode(
      ScannerService.normalizeCardCode("100010"),
    );
    expect(foundByCard?.id).toBe(studentEligible.id);

    const normalizedStudentCode = ScannerService.normalizeCardCode("٠٨٨٠٠١٠");
    expect(normalizedStudentCode).toBe("0880010");
    const foundByStudentCode = findAttendanceStudentByNormalizedCode(normalizedStudentCode);
    expect(foundByStudentCode?.id).toBe(studentEligible.id);

    const eligibleResult = MakeupService.getEligibilityForSession(targetSessionId, studentEligible.id);
    expect(eligibleResult.eligible).toBe(true);
    expect(eligibleResult.originalAbsenceId).toBe("session-v-orig");

    const ineligibleResult = MakeupService.getEligibilityForSession(targetSessionId, studentIneligible.id);
    expect(ineligibleResult.eligible).toBe(false);
    const origSessionId = "session-v-orig";
    const db = DatabaseService.getDb();

    const makeupAttendance = await MakeupService.recordMakeupAttendance({
      studentId: studentEligible.id,
      sessionId: targetSessionId,
      originalAbsenceId: origSessionId,
    });

    expect(makeupAttendance).not.toBeNull();
    expect(makeupAttendance.studentId).toBe(studentEligible.id);
    expect(makeupAttendance.sessionId).toBe(targetSessionId);
    expect(makeupAttendance.attendanceType).toBe("makeup");
    expect(makeupAttendance.originalAbsenceId).toBe(origSessionId);

    const originalAbsence = db.getFirstSync<any>(
      `SELECT status, attendance_type as attendanceType FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, origSessionId, studentEligible.id],
    );
    expect(originalAbsence?.status).toBe("absent");
    expect(originalAbsence?.attendanceType).not.toBe("makeup");

    const secondTargetSessionId = "session-v-target-2";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, 'grp-v-b', ?, ?, '2026-10-02', '16:00', '18:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [secondTargetSessionId, centerId, subjectId, teacherId],
    );

    const eligibilityAfterMakeup = MakeupService.getEligibilityForSession(secondTargetSessionId, studentEligible.id);
    expect(eligibilityAfterMakeup.eligible).toBe(false);

    await expect(
      AttendanceRepository.recordAttendance({
        studentId: studentEligible.id,
        sessionId: secondTargetSessionId,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: origSessionId,
      }),
    ).rejects.toThrow("تم تسجيل تعويض لهذا الغياب مسبقًا.");

    const attendanceRecords = AttendanceRepository.getStudentAttendance(studentEligible.id);
    const makeupRecords = attendanceRecords.filter(
      (r) => r.attendanceType === "makeup" && r.originalAbsenceId === origSessionId,
    );
    expect(makeupRecords.length).toBe(1);
  });
});
