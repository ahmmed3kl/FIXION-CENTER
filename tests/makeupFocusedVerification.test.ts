import { DatabaseService } from "../src/core/database";
import { SyncEngine } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
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

  it("يجلب الطلاب المتوقعين وتظهر العدادات بشكل صحيح لجلسة المجموعة حتى لو كان تاريخ البدء مجدولاً لاحقاً", async () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-v-d";
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      [groupId, centerId, "مجموعة د (أولى ثانوي)", subjectId, teacherId, grade1],
    );

    const studentD = StudentRepository.createStudent({
      studentCode: "0880030",
      cardCode: "100030",
      fullName: "عمر خالد مصطفى",
      phone: "01011115555",
      parentPhone: "01111115555",
      grade: grade1,
    });

    // Simulate forward-scheduled enrollment start date (e.g. 2026-10-09) with createdAt today (2026-10-02)
    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date, created_at)
       VALUES (?, ?, ?, ?, 'active', '2026-10-09', '2026-10-02T10:00:00.000Z')`,
      ["enr-v-d", centerId, studentD.id, groupId],
    );

    const sessionDId = "session-v-d";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-02', '10:00', '12:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [sessionDId, centerId, groupId, subjectId, teacherId],
    );

    const isExpected = AttendanceSessionService.isExpected(sessionDId, studentD.id);
    expect(isExpected).toBe(true);

    const summary = AttendanceSessionService.getSummary(sessionDId);
    expect(summary.total).toBe(1);
    expect(summary.absent).toBe(1);
    expect(summary.present).toBe(0);
    expect(summary.makeup).toBe(0);
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

  it("يعثر على طالب التعويض بكود 1051021 عند اختلاف صيغة المرحلة (الصف الثاني الثانوي مقابل الثاني الثانوي) ويثبت التعويض وحمايته من التكرار", async () => {
    const db = DatabaseService.getDb();
    const groupSecA = "grp-sec-a";
    const groupSecB = "grp-sec-b";

    // Groups created with grade "الثاني الثانوي" (without "الصف")
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      [groupSecA, centerId, "مجموعة 2 ثانوي - أ", subjectId, teacherId, "الثاني الثانوي"],
    );
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 100, 'active')`,
      [groupSecB, centerId, "مجموعة 2 ثانوي - ب", subjectId, teacherId, "الثاني الثانوي"],
    );

    // Student registered with grade "الصف الثاني الثانوي" and code "1051021"
    const student1051021 = StudentRepository.createStudent({
      studentCode: "1051021",
      cardCode: "051021",
      fullName: "أحمد محمد محمود",
      phone: "01099998888",
      parentPhone: "01199998888",
      grade: "الصف الثاني الثانوي",
    });

    // Enrolled in Group A
    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date)
       VALUES (?, ?, ?, ?, 'active', '2026-09-01')`,
      ["enr-sec-1", centerId, student1051021.id, groupSecA],
    );

    // Group A had an earlier session where student1051021 was absent
    const sessionSecA = "sess-sec-a";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-01', '14:00', '16:00', 'open', '2026-10-01T10:00:00.000Z')`,
      [sessionSecA, centerId, groupSecA, subjectId, teacherId],
    );
    db.runSync(
      `INSERT OR REPLACE INTO attendance
       (id, center_id, session_id, student_id, status, attendance_type, recorded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'absent', 'present', '2026-10-01T14:30:00.000Z', '2026-10-01T14:30:00.000Z', '2026-10-01T14:30:00.000Z')`,
      [`att-default-${sessionSecA}-${student1051021.id}`, centerId, sessionSecA, student1051021.id],
    );

    // Active session for Group B today (host session for makeup)
    const sessionSecB = "sess-sec-b";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-02', '16:00', '18:00', 'open', '2026-10-02T12:00:00.000Z')`,
      [sessionSecB, centerId, groupSecB, subjectId, teacherId],
    );

    // 1. Verify finding by normalized code "1051021"
    const foundByCode = findAttendanceStudentByNormalizedCode("1051021");
    expect(foundByCode).not.toBeNull();
    expect(foundByCode?.id).toBe(student1051021.id);

    // 2. Verify searchAttendanceStudents returns student 1051021 despite "الصف الثاني الثانوي" vs "الثاني الثانوي"
    const allStudents = StudentRepository.getAllForAttendance();
    const searchResults = searchAttendanceStudents(allStudents, "1051021", "الثاني الثانوي", centerId);
    expect(searchResults.some((s) => s.id === student1051021.id)).toBe(true);

    // 3. Verify eligibility check via MakeupService & AttendanceSessionService
    const makeupEligibilityStrict = MakeupService.getEligibilityForSession(sessionSecB, student1051021.id);
    expect(makeupEligibilityStrict.eligible).toBe(true);
    expect(makeupEligibilityStrict.originalAbsenceId).toBe(sessionSecA);

    const makeupEligibilitySession = AttendanceSessionService.getMakeupEligibility(sessionSecB, student1051021.id);
    expect(makeupEligibilitySession.eligible).toBe(true);
    expect(makeupEligibilitySession.originalAbsenceId).toBe(sessionSecA);

    // 4. Record makeup attendance
    const makeupAtt = await AttendanceRepository.recordAttendance({
      studentId: student1051021.id,
      sessionId: sessionSecB,
      status: "present",
      isLate: false,
      attendanceType: "makeup",
      originalAbsenceId: sessionSecA,
    });
    expect(makeupAtt).not.toBeNull();
    expect(makeupAtt.attendanceType).toBe("makeup");

    // 5. Verify duplicate prevention
    const duplicateEligibility = MakeupService.getEligibilityForSession(sessionSecB, student1051021.id);
    expect(duplicateEligibility.eligible).toBe(false);

    await expect(
      AttendanceRepository.recordAttendance({
        studentId: student1051021.id,
        sessionId: sessionSecB,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sessionSecA,
      }),
    ).rejects.toThrow("تم تسجيل تعويض لهذا الغياب مسبقًا.");
  });

  it("يسمح بحضور التعويض المسبق دون اشتراط غياب سابق، ويضمن استقلال جلسة الطالب الأصلية وعدم تكرار الحضور واستقلال الرسوم", async () => {
    const db = DatabaseService.getDb();
    const groupAdvA = "grp-adv-a";
    const groupAdvB = "grp-adv-b";

    // Teacher for this test
    const teacherAdv = "teacher-adv-1";
    db.runSync(
      `INSERT OR REPLACE INTO teachers (id, center_id, name, subject_id, week_start_day)
       VALUES (?, ?, ?, ?, ?)`,
      [teacherAdv, centerId, "أستاذ التعويض المسبق", subjectId, 6],
    );

    // Group A (session price 150)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 150, 'active')`,
      [groupAdvA, centerId, "مجموعة أ (المجموعة الأصلية)", subjectId, teacherAdv, "الصف الأول الثانوي"],
    );
    // Group B (session price 120)
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, subject_id, teacher_id, grade, session_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 120, 'active')`,
      [groupAdvB, centerId, "مجموعة ب (مجموعة التعويض الموازي)", subjectId, teacherAdv, "الأول الثانوي"],
    );

    // Create student enrolled ONLY in Group A
    const advanceStudent = StudentRepository.createStudent({
      studentCode: "0880099",
      cardCode: "100099",
      fullName: "يوسف حسام الدين",
      phone: "01099887766",
      parentPhone: "01199887766",
      grade: "الصف الأول الثانوي",
    });

    db.runSync(
      `INSERT OR REPLACE INTO student_group_enrollments (id, center_id, student_id, group_id, status, start_date)
       VALUES (?, ?, ?, ?, 'active', '2026-09-01')`,
      ["enr-adv-1", centerId, advanceStudent.id, groupAdvA],
    );

    // Session in Group B occurs first (e.g. at 12:00 on 2026-10-02)
    const sessionAdvB = "sess-adv-b";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-02', '12:00', '14:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [sessionAdvB, centerId, groupAdvB, subjectId, teacherAdv],
    );

    // 1. Advance student has NO prior absence in group A or anywhere else.
    // Verify eligibility check allows advance makeup.
    const makeupEligibilityB = MakeupService.getEligibilityForSession(sessionAdvB, advanceStudent.id);
    expect(makeupEligibilityB.eligible).toBe(true);
    expect(makeupEligibilityB.isAdvanceMakeup).toBe(true);
    expect(makeupEligibilityB.originalAbsenceId).toBeUndefined();

    const sessionServiceEligibility = AttendanceSessionService.getMakeupEligibility(sessionAdvB, advanceStudent.id);
    expect(sessionServiceEligibility.eligible).toBe(true);
    expect(sessionServiceEligibility.isAdvanceMakeup).toBe(true);
    expect(sessionServiceEligibility.originalAbsenceId).toBeUndefined();

    // 2. Record advance makeup attendance in Group B
    const makeupAtt = await AttendanceRepository.recordAttendance({
      studentId: advanceStudent.id,
      sessionId: sessionAdvB,
      status: "present",
      isLate: false,
      attendanceType: "makeup",
    });
    expect(makeupAtt).not.toBeNull();
    expect(makeupAtt.attendanceType).toBe("makeup");
    expect(makeupAtt.sessionId).toBe(sessionAdvB);

    // Verify Group B summary: advance makeup visitor is counted in makeup counter, not polluting total expected roster
    const summaryB = AttendanceSessionService.getSummary(sessionAdvB);
    expect(summaryB.total).toBe(0);
    expect(summaryB.present).toBe(0);
    expect(summaryB.makeup).toBe(1);

    // 3. Duplicate prevention: cannot attend makeup again in session B
    const dupEligibility = MakeupService.getEligibilityForSession(sessionAdvB, advanceStudent.id);
    expect(dupEligibility.eligible).toBe(false);

    await expect(
      AttendanceRepository.recordAttendance({
        studentId: advanceStudent.id,
        sessionId: sessionAdvB,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
      }),
    ).rejects.toThrow();

    // 4. Group A session occurs LATER (e.g. at 16:00 on 2026-10-02)
    const sessionAdvA = "sess-adv-a";
    db.runSync(
      `INSERT OR REPLACE INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-02', '16:00', '18:00', 'open', '2026-10-02T08:00:00.000Z')`,
      [sessionAdvA, centerId, groupAdvA, subjectId, teacherAdv],
    );

    // 5. Verify the student appears on the regular roster of Group A
    const isExpectedInOriginal = AttendanceSessionService.isExpected(sessionAdvA, advanceStudent.id);
    expect(isExpectedInOriginal).toBe(true);

    const summaryA = AttendanceSessionService.getSummary(sessionAdvA);
    expect(summaryA.total).toBe(1);
    expect(summaryA.absent).toBe(1);
    expect(summaryA.present).toBe(0);
    expect(summaryA.makeup).toBe(0);

    // 6. Student attends their regular session in Group A independently
    const regularAtt = await AttendanceRepository.recordAttendance({
      studentId: advanceStudent.id,
      sessionId: sessionAdvA,
      status: "present",
      isLate: false,
      attendanceType: "present",
    });
    expect(regularAtt).not.toBeNull();
    expect(regularAtt.attendanceType).toBe("present");
    expect(regularAtt.sessionId).toBe(sessionAdvA);

    const summaryAAfter = AttendanceSessionService.getSummary(sessionAdvA);
    expect(summaryAAfter.total).toBe(1);
    expect(summaryAAfter.present).toBe(1);
    expect(summaryAAfter.absent).toBe(0);

    // 7. Group A enrollment and pricing remains completely unchanged
    const originalGroup = db.getFirstSync<any>(
      "SELECT session_price as sessionPrice FROM groups WHERE center_id = ? AND id = ?",
      [centerId, groupAdvA],
    );
    expect(originalGroup.sessionPrice).toBe(150);

    const studentEnrollment = db.getFirstSync<any>(
      "SELECT group_id as groupId, status FROM student_group_enrollments WHERE center_id = ? AND student_id = ? AND group_id = ?",
      [centerId, advanceStudent.id, groupAdvA],
    );
    expect(studentEnrollment.groupId).toBe(groupAdvA);
    expect(studentEnrollment.status).toBe("active");
  });
});
