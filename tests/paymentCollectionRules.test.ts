jest.mock("expo-device", () => ({ modelName: "Test Device" }));

import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { DebtAdjustmentRepository } from "../src/features/payments/DebtAdjustmentRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import {
  getDebtCyclePeriodLabel,
  getPaymentDescription,
} from "../src/features/payments/paymentPresentation";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("payment collection rules", () => {
  let centerId: string;
  let nextStudentCode = 99000000;

  beforeAll(async () => {
    DatabaseService.init();
    useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
    centerId = useAuthStore.getState().activeCenterId!;
    CardRangeRepository.replaceCenterRanges(centerId, [{
      id: "payment-rules-test-range",
      center_id: centerId,
      start_code: "99000000",
      end_code: "99009999",
      status: "active",
    }]);
  });

  function createStudent() {
    let code = String(nextStudentCode++);
    while (StudentRepository.findByStudentCode(code)) {
      code = String(nextStudentCode++);
    }
    return StudentRepository.createStudent({
      studentCode: code,
      cardCode: code,
      fullName: `طالب اختبار المدفوعات ${code}`,
      phone: "01012345678",
      parentPhone: "01112345678",
      grade: "الصف الأول الثانوي",
    });
  }

  async function createBillingCycle(
    studentId: string,
    periodStart: string,
    periodEnd: string,
    amountDue = 400,
    cycleType: "monthly" | "package" = "monthly",
  ) {
    const db = DatabaseService.getDb();
    const id = `test-cycle-${studentId}-${periodStart}`;
    const enrollmentId = `test-enrollment-${studentId}-${periodStart}`;
    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO debt_cycles
       (id, center_id, student_id, enrollment_id, cycle_number, start_date, end_date,
        cycle_price, status, cycle_type, billing_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [id, centerId, studentId, enrollmentId, periodStart, periodEnd, amountDue, cycleType, cycleType === "package" ? "package" : "monthly", now, now],
    );
    return {
      id,
      studentId,
      cycleType,
      startDate: periodStart,
      endDate: periodEnd,
    };
  }

  it("rejects an ordinary payment after a cycle is fully paid and allows its exact remaining balance", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");

    await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 300,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-partial-${student.id}`,
    });
    expect(FinancialCalculationService.getStudentFinancialStatus(student.id).monthlyRemainingDebt).toBe(100);
    const beforeOverpayment = DatabaseService.getDb().getAllSync<{ id: string }>(
      "SELECT id FROM payments WHERE center_id = ? AND student_id = ?",
      [centerId, student.id],
    );
    await expect(PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 101,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-over-partial-${student.id}`,
    })).rejects.toThrow("يتجاوز المتبقي المستحق");
    expect(DatabaseService.getDb().getAllSync<{ id: string }>(
      "SELECT id FROM payments WHERE center_id = ? AND student_id = ?",
      [centerId, student.id],
    )).toHaveLength(beforeOverpayment.length);

    await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 100,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-final-${student.id}`,
    });
    const paid = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(paid.monthlyTotalDue).toBe(400);
    expect(paid.monthlyTotalPaid).toBe(400);
    expect(paid.monthlyRemainingDebt).toBe(0);

    await expect(PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 1,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-over-${student.id}`,
    })).rejects.toThrow("لا يوجد مبلغ مستحق");
  });

  it("allows an unpaid obligation and treats a full discount as no remaining amount", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");

    expect(FinancialCalculationService.getStudentFinancialStatus(student.id).monthlyRemainingDebt).toBe(400);
    await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 400,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-unpaid-${student.id}`,
    });

    const freeStudent = createStudent();
    const discountedCycle = await createBillingCycle(freeStudent.id, "2026-10-01", "2026-10-31");
    await DebtAdjustmentRepository.createAdjustment({
      debtCycleId: discountedCycle.id,
      adjustmentAmount: -400,
      reason: "إعفاء كامل للاختبار",
      operationId: `op-payment-rule-discount-${freeStudent.id}`,
    });
    const discounted = FinancialCalculationService.getStudentFinancialStatus(freeStudent.id);
    expect(discounted.monthlyTotalDue).toBe(0);
    expect(discounted.monthlyRemainingDebt).toBe(0);
    await expect(PaymentRepository.recordPayment({
      studentId: freeStudent.id,
      amount: 1,
      paymentType: "monthly",
      debtCycleId: discountedCycle.id,
      operationId: `op-payment-rule-free-${freeStudent.id}`,
    })).rejects.toThrow("لا يوجد مبلغ مستحق");
  });

  it("keeps monthly periods explicit and does not infer a period for historical unlinked payments", async () => {
    const student = createStudent();
    const october = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");
    const november = await createBillingCycle(student.id, "2026-11-01", "2026-11-30");
    const octoberPayment = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 400,
      paymentType: "monthly",
      debtCycleId: october.id,
      operationId: `op-payment-rule-october-${student.id}`,
    });
    const novemberPayment = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 200,
      paymentType: "partial",
      debtCycleId: november.id,
      operationId: `op-payment-rule-november-${student.id}`,
    });

    const status = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(status.cycles.find((cycle) => cycle.id === october.id)?.remainingDebt).toBe(0);
    expect(status.cycles.find((cycle) => cycle.id === november.id)?.remainingDebt).toBe(200);
    expect(getPaymentDescription(octoberPayment, october).period).toContain("أكتوبر");
    expect(getPaymentDescription(novemberPayment, november).period).toContain("نوفمبر");
    expect(getDebtCyclePeriodLabel({
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    })).toContain("أكتوبر");
    expect(getPaymentDescription({
      paymentType: "monthly",
      debtCycleId: undefined,
    })).toEqual({ title: "اشتراك شهري", period: undefined });
  });

  it("restores the obligation when a payment is reversed", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");
    const payment = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 400,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-reversible-${student.id}`,
    });

    expect(FinancialCalculationService.getStudentFinancialStatus(student.id).monthlyRemainingDebt).toBe(0);
    await PaymentRepository.reversePayment({
      paymentId: payment.id,
      reason: "اختبار عكس دفعة",
      operationId: `op-payment-rule-reversal-${student.id}`,
    });
    const reversed = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(reversed.monthlyTotalPaid).toBe(0);
    expect(reversed.monthlyRemainingDebt).toBe(400);
  });

  it("keeps standalone session charges out of the monthly subscription balance", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");
    const now = new Date().toISOString();
    DatabaseService.getDb().runSync(
      `INSERT INTO payments
       (id, operation_id, center_id, student_id, amount, payment_type, payment_method,
        payment_date, is_reversed, created_at, user_id)
       VALUES (?, ?, ?, ?, 100, 'session', 'cash', '2026-10-05', 0, ?, ?)`,
      [`test-session-fee-${student.id}`, `op-test-session-fee-${student.id}`, centerId, student.id, now, useAuthStore.getState().currentUser!.id],
    );

    const status = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(status.monthlyTotalDue).toBe(400);
    expect(status.monthlyTotalPaid).toBe(0);
    expect(status.monthlyRemainingDebt).toBe(400);
    expect(status.sessionTotalPaid).toBe(100);
    expect(status.cycles.find((item) => item.id === cycle.id)?.remainingDebt).toBe(400);
  });

  it("caps package collection at its own remaining amount", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31", 600, "package");
    await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 200,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId: `op-package-partial-${student.id}`,
    });

    const status = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(status.packageMonthlyDue).toBe(600);
    expect(status.packageMonthlyPaid).toBe(200);
    expect(status.packageRemainingDebt).toBe(400);
    await expect(PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 401,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-package-over-${student.id}`,
    })).rejects.toThrow("يتجاوز المتبقي المستحق");
  });

  it("keeps retries idempotent without adding a second payment or outbox operation", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");
    const operationId = `op-payment-rule-retry-${student.id}`;
    const first = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 100,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId,
    });
    const pendingBeforeRetry = SyncRepository.getPendingOperations(centerId)
      .filter((operation) => operation.operationId === operationId).length;
    const retried = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 100,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId,
    });
    const pendingAfterRetry = SyncRepository.getPendingOperations(centerId)
      .filter((operation) => operation.operationId === operationId).length;
    const paidAfterRetry = FinancialCalculationService
      .getStudentFinancialStatus(student.id).monthlyTotalPaid;

    expect(retried.id).toBe(first.id);
    expect(paidAfterRetry).toBe(100);
    expect(pendingBeforeRetry).toBe(1);
    expect(pendingAfterRetry).toBe(pendingBeforeRetry);
  });

  it("rechecks the outstanding balance when saving after the payment dialog could have become stale", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-10-01", "2026-10-31");

    expect(FinancialCalculationService.getStudentFinancialStatus(student.id).monthlyRemainingDebt).toBe(400);
    await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 400,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-stale-first-${student.id}`,
    });
    await expect(PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 100,
      paymentType: "monthly",
      debtCycleId: cycle.id,
      operationId: `op-payment-rule-stale-second-${student.id}`,
    })).rejects.toThrow("لا يوجد مبلغ مستحق");
  });
});
