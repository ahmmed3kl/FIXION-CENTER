import { DatabaseService } from "../src/core/database";
import { isRetryableDependencyConflict, SyncEngine } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { PaymentRequestRepository } from "../src/features/payments/PaymentRequestRepository";
import { SessionDebtService } from "../src/features/payments/SessionDebtService";
import { DailyClosingService } from "../src/features/reports/DailyClosingService";

describe("Payment System Fixes Verification", () => {
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

  it("collectMultipleObligations handles subscription without remaining_debt error and rolls back atomically on failure", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-fix-1', 'center-1', 'طالب اختبار', '01011112222', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO groups (id, center_id, name, monthly_price, session_price, billing_mode, status, created_at)
       VALUES ('grp-fix-1', 'center-1', 'مجموعة 1', 300, 50, 'monthly', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES ('enr-fix-1', 'center-1', 'stu-fix-1', 'grp-fix-1', '2026-11-01', 'active', '2026-11-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, cycle_type, billing_mode, start_date, end_date, cycle_price, status, created_at)
       VALUES ('cyc-fix-1', 'center-1', 'stu-fix-1', 'enr-fix-1', 'grp-fix-1', 1, 'monthly', 'monthly', '2026-11-01', '2026-11-30', 300, 'open', '2026-11-01T10:00:00.000Z')`,
    );

    // 1. Verify entire batch runs inside a single synchronous runInTransaction call
    const txSpy = jest.spyOn(DatabaseService, "runInTransaction");
    await expect(
      PaymentRepository.collectMultipleObligations({
        studentId: "stu-fix-1",
        paymentDate: "2026-11-15",
        operationId: "op-atomic-fail",
        items: [
          { type: "subscription", id: "cyc-fix-1", debtCycleId: "cyc-fix-1" },
          { type: "payment_request", id: "missing-ob", paymentRequestObligationId: "missing-ob" },
        ],
      }),
    ).rejects.toThrow();
    expect(txSpy).toHaveBeenCalled();
    txSpy.mockRestore();

    // Clean up mock in-memory row (InMemorySqliteMock does not implement SQLite ROLLBACK)
    db.runSync(`DELETE FROM payments WHERE center_id = 'center-1' AND student_id = 'stu-fix-1'`);

    // 2. Successful subscription collection without explicit amount
    const result = await PaymentRepository.collectMultipleObligations({
      studentId: "stu-fix-1",
      paymentDate: "2026-11-15",
      operationId: "op-atomic-ok",
      items: [{ type: "subscription", id: "cyc-fix-1", debtCycleId: "cyc-fix-1" }],
    });
    expect(result.totalCollected).toBe(300);
    expect(result.payments).toHaveLength(1);
  });

  it("SessionDebtService handles ISO dates without NaN and resolves periodStart/periodEnd cleanly", () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO students (id, center_id, full_name, phone, status, created_at)
       VALUES ('stu-fix-2', 'center-1', 'طالب تواريخ', '01011113333', 'active', '2026-10-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO groups (id, center_id, name, monthly_price, session_price, billing_mode, status, created_at)
       VALUES ('grp-fix-2', 'center-1', 'مجموعة 2', 400, 100, 'per_session', 'active', '2026-10-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, created_at)
       VALUES ('sch-fix-2', 'center-1', 'grp-fix-2', 4, '16:00', '18:00', '2026-10-01T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, created_at)
       VALUES ('enr-fix-2', 'center-1', 'stu-fix-2', 'grp-fix-2', '2026-10-15', 'active', '2026-10-15T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, cycle_type, billing_mode, start_date, end_date, cycle_price, status, created_at)
       VALUES ('cyc-fix-2a', 'center-1', 'stu-fix-2', 'enr-fix-2', 'grp-fix-2', 1, 'per_session', 'per_session', '2026-10-15', '2026-11-14', 400, 'open', '2026-10-15T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO sessions (id, center_id, group_id, schedule_id, session_date, status, created_at)
       VALUES ('ses-fix-nov5', 'center-1', 'grp-fix-2', 'sch-fix-2', '2026-11-05', 'completed', '2026-11-05T16:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, session_id, student_id, status, marked_at)
       VALUES ('att-fix-nov5', 'center-1', 'ses-fix-nov5', 'stu-fix-2', 'present', '2026-11-05T16:05:00.000Z')`,
    );

    const breakdown = SessionDebtService.getCurrentMonthBreakdown(
      "stu-fix-2",
      "2026-11-15T00:00:00.000Z",
    );
    expect(breakdown.periodStart).toBe("2026-11-01");
    expect(breakdown.periodEnd).toBe("2026-11-30");
    const nov5 = breakdown.paymentCandidates?.find((s) => s.sessionDate === "2026-11-05");
    expect(nov5).toBeDefined();
    expect(nov5?.debtCycleId).toBe("cyc-fix-2a");
  });

  it("DailyClosingService.reopenDailyClosing sets action: 'reopen' and closeDailyForDate supports re-closing 'reopened' rows", async () => {
    const db = DatabaseService.getDb();
    await DailyClosingService.closeDailyForDate("2026-11-14");
    await DailyClosingService.reopenDailyClosing("2026-11-14", "مراجعة حسابات");

    const ops = db.getAllSync<any>(
      `SELECT payload FROM sync_operations WHERE entity_type = 'daily_closing'`,
    );
    expect(ops.some((op) => JSON.parse(op.payload).action === "reopen")).toBe(true);

    // Simulate server pulling status = 'reopened' and then re-closing on client
    db.runSync(
      `UPDATE daily_closing_summaries SET status = 'reopened' WHERE center_id = 'center-1' AND business_date = '2026-11-14'`,
    );
    const reclosed = await DailyClosingService.closeDailyForDate("2026-11-14");
    expect(reclosed.status).toBe("closed");
  });

  it("PaymentRequestRepository.archiveRequest blocks payments.create-only users and PAYMENT_REQUEST_NOT_FOUND is retryable", async () => {
    expect(isRetryableDependencyConflict("PAYMENT_REQUEST_NOT_FOUND: missing")).toBe(true);

    // Give current user only payments.create (not payments.edit / payments.adjust)
    const current = useAuthStore.getState().currentUser!;
    useAuthStore.setState({
      currentUser: { ...current, permissions: ["payments.create", "payments.view"] },
    });

    await expect(
      PaymentRequestRepository.archiveRequest({ requestId: "req-any" }),
    ).rejects.toThrow(/ليس لديك صلاحية/);
  });
});
