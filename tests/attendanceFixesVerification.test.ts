import { DatabaseService } from "../src/core/database";
import { SyncEngine } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { AbsenceNoteRepository } from "../src/features/attendance/AbsenceNoteRepository";
import { calculateAbsenceReportCounts } from "../src/features/attendance/AbsenceReportsService";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { DailyClosingService } from "../src/features/reports/DailyClosingService";
import { OperationalReportsService } from "../src/features/reports/OperationalReportsService";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { SessionClosingService } from "../src/features/sessions/SessionClosingService";

describe("Attendance, Makeup & Absence Reports Fixes Verification", () => {
  beforeEach(async () => {
    jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "idle",
    } as any);
    DatabaseService.init();
    await useAuthStore.getState().logout();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("allows re-attending a student after cancelAttendance and reverses external session payment on cancel", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-att-fix-1', 'center-1', 'طالب حضور', '01012345678', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO groups (id, center_id, name, monthly_price, session_price, default_fee, billing_mode, status, created_at)
       VALUES ('grp-att-fix-1', 'center-1', 'مجموعة أ', 300, 60, 60, 'monthly', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at)
       VALUES ('sess-att-fix-1', 'center-1', 'grp-att-fix-1', '2026-11-10', '10:00', '12:00', 'open', '2026-11-10T08:00:00.000Z')`,
    );

    const firstAtt = await AttendanceRepository.recordAttendance({
      studentId: "stu-att-fix-1",
      sessionId: "sess-att-fix-1",
      status: "present",
      isLate: false,
      isExternal: true,
    });
    expect(AttendanceRepository.isAlreadyAttended("sess-att-fix-1", "stu-att-fix-1")).toBe(true);

    const paymentBeforeCancel = db.getFirstSync<any>(
      `SELECT id, is_reversed as isReversed FROM payments
       WHERE center_id = ? AND student_id = ? AND session_id = ?
         AND payment_type = 'session' AND is_reversed = 0`,
      ["center-1", "stu-att-fix-1", "sess-att-fix-1"],
    );
    expect(paymentBeforeCancel).toBeTruthy();
    expect(Boolean(paymentBeforeCancel.isReversed)).toBe(false);

    const canceled = await AttendanceRepository.cancelAttendance(firstAtt.id);
    expect(canceled.status).toBe("absent");
    expect(canceled.isExternal).toBe(true);
    expect(AttendanceRepository.isAlreadyAttended("sess-att-fix-1", "stu-att-fix-1")).toBe(false);

    const paymentAfterCancel = db.getFirstSync<any>(
      `SELECT id, is_reversed as isReversed FROM payments WHERE id = ?`,
      [paymentBeforeCancel.id],
    );
    expect(Boolean(paymentAfterCancel?.isReversed)).toBe(true);

    const reAttended = await AttendanceRepository.recordAttendance({
      studentId: "stu-att-fix-1",
      sessionId: "sess-att-fix-1",
      status: "present",
      isLate: false,
      isExternal: true,
    });
    expect(reAttended.status).toBe("present");
    expect(AttendanceRepository.isAlreadyAttended("sess-att-fix-1", "stu-att-fix-1")).toBe(true);
  });

  it("SessionClosingService counts only present/late students and blocks absence notes on makeup attendance", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-cls-1', 'center-1', 'طالب 1', '01022223331', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-cls-2', 'center-1', 'طالب 2', '01022223332', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO groups (id, center_id, name, monthly_price, session_price, default_fee, billing_mode, status, created_at)
       VALUES ('grp-cls-1', 'center-1', 'مجموعة إغلاق', 300, 50, 50, 'monthly', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at)
       VALUES ('sess-cls-1', 'center-1', 'grp-cls-1', '2026-11-11', '10:00', '12:00', 'open', '2026-11-11T08:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES ('exp-cls-1', 'center-1', 'sess-cls-1', 'stu-cls-1', '2026-11-11T08:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES ('att-cls-1', 'center-1', 'stu-cls-1', 'sess-cls-1', '2026-11-11T10:05:00.000Z', 'present', 0, 'makeup', 'op-cls-1')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES ('att-cls-2', 'center-1', 'stu-cls-2', 'sess-cls-1', '2026-11-11T08:00:00.000Z', 'absent', 0, 'present', 'op-cls-2')`,
    );

    const originalGetFirst = db.getFirstSync.bind(db);
    jest.spyOn(db, "getFirstSync").mockImplementation(((sql: string, params?: any[]) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN session_expected_students")) {
        return {
          sessionId: "sess-cls-1",
          sessionStatus: "open",
          studentId: "stu-cls-1",
          studentStatus: "active",
          deletedAt: null,
        } as any;
      }
      return originalGetFirst(sql, params);
    }) as any);

    expect(() =>
      AbsenceNoteRepository.save("sess-cls-1", "stu-cls-1", "ملاحظة غير مسموحة"),
    ).toThrow("لا يمكن إضافة ملاحظة غياب");

    const closing = await SessionClosingService.closeSession("sess-cls-1");
    expect(closing.totalAttendance).toBe(1);
  });

  it("DailyClosingService separates packageTotal from monthlyTotal", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-pkg-1', 'center-1', 'طالب باقة', '01033334444', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO debt_cycles (id, center_id, student_id, group_id, cycle_number, cycle_type, billing_mode, start_date, end_date, cycle_price, status, created_at)
       VALUES ('cyc-pkg-1', 'center-1', 'stu-pkg-1', 'grp-pkg-1', 1, 'package', 'monthly', '2026-11-01', '2026-11-30', 500, 'open', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO payments (id, operation_id, center_id, student_id, debt_cycle_id, amount, payment_type, payment_method, payment_date, is_reversed, created_at, user_id)
       VALUES ('pay-pkg-1', 'op-pkg-1', 'center-1', 'stu-pkg-1', 'cyc-pkg-1', 500, 'package', 'cash', '2026-11-12', 0, '2026-11-12T10:00:00.000Z', 'usr-admin-1')`,
    );

    const summary = await DailyClosingService.closeDailyForDate("2026-11-12");
    expect(summary.packageTotal).toBe(500);
    expect(summary.monthlyTotal).toBe(0);
    expect(summary.totalCash).toBe(500);
  });

  it("calculateAbsenceReportCounts ignores cancelled makeups and ScannerService respects explicit timezone", () => {
    const counts = calculateAbsenceReportCounts(
      [{ id: "s1", centerId: "center-1", fullName: "A", phone: "1", status: "active", createdAt: "" } as any],
      [
        {
          id: "att-1",
          centerId: "center-1",
          studentId: "s1",
          sessionId: "sess-1",
          checkInTime: "",
          status: "absent",
          isLate: false,
          attendanceType: "makeup",
          operationId: "op-1",
        },
      ],
      [],
      true,
    );
    expect(counts.compensated).toBe(0);
    expect(counts.absent.map((s) => s.id)).toEqual(["s1"]);

    // 08:10 UTC = 10:10 in Africa/Cairo (UTC+2) -> on time for 10:00 session with 15 min grace
    const onTimeCairo = ScannerService.calculateLateStatus(
      "10:00",
      "2026-11-15T08:10:00.000Z",
      15,
      "Africa/Cairo",
    );
    expect(onTimeCairo.isLate).toBe(false);
    expect(onTimeCairo.status).toBe("present");

    // 08:20 UTC = 10:20 in Africa/Cairo -> late for 10:00 session with 15 min grace
    const lateCairo = ScannerService.calculateLateStatus(
      "10:00",
      "2026-11-15T08:20:00.000Z",
      15,
      "Africa/Cairo",
    );
    expect(lateCairo.isLate).toBe(true);
    expect(lateCairo.status).toBe("late");
  });

  it("OperationalReportsService includes makeup and covered sessions in attendanceRate", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-rate-1', 'center-1', 'طالب نسبة', '01044445555', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO groups (id, center_id, name, monthly_price, session_price, default_fee, billing_mode, status, created_at)
       VALUES ('grp-rate-1', 'center-1', 'مجموعة نسبة', 300, 50, 50, 'monthly', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES ('enr-rate-1', 'center-1', 'stu-rate-1', 'grp-rate-1', '2026-11-01', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at)
       VALUES ('sess-rate-1', 'center-1', 'grp-rate-1', '2026-11-01', '10:00', '12:00', 'closed', '2026-11-01T08:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at)
       VALUES ('sess-rate-2', 'center-1', 'grp-rate-1', '2026-11-02', '10:00', '12:00', 'closed', '2026-11-02T08:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES ('att-rate-1', 'center-1', 'stu-rate-1', 'sess-rate-1', '2026-11-01T10:00:00.000Z', 'present', 0, 'present', 'op-rate-1')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES ('att-rate-2', 'center-1', 'stu-rate-1', 'sess-rate-2', '2026-11-02T10:00:00.000Z', 'present', 0, 'makeup', 'op-rate-2')`,
    );

    const originalGetAll = db.getAllSync.bind(db);
    jest.spyOn(db, "getAllSync").mockImplementation(((sql: string, params?: any[]) => {
      if (sql.includes("FROM sessions s")) {
        return [
          {
            id: "sess-rate-1",
            session_date: "2026-11-01",
            status: "closed",
            group_name: "مجموعة نسبة",
            subject_name: "رياضيات",
          },
          {
            id: "sess-rate-2",
            session_date: "2026-11-02",
            status: "closed",
            group_name: "مجموعة نسبة",
            subject_name: "رياضيات",
          },
        ] as any;
      }
      return originalGetAll(sql, params);
    }) as any);

    const report = OperationalReportsService.getStudentAttendanceReport(
      "stu-rate-1",
      "2026-11-01",
      "2026-11-30",
    );
    expect(report.totals.totalSessions).toBe(2);
    expect(report.totals.makeupCount).toBe(1);
    expect(report.totals.attendanceRate).toBe(100);
  });
});
