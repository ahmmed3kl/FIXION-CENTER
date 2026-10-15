jest.mock("expo-device", () => ({ modelName: "Test Device" }));

import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { GroupScheduleRepository } from "../src/features/groups/GroupScheduleRepository";
import { DebtAdjustmentRepository } from "../src/features/payments/DebtAdjustmentRepository";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { getConfiguredSessionPrice } from "../src/features/payments/paymentEligibility";
import { SessionDateService } from "../src/features/sessions/SessionDateService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import {
  getDebtCyclePeriodLabel,
  getPaymentDescription,
} from "../src/features/payments/paymentPresentation";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { configureTestCenterTimeZones } from "./helpers/centerTimeZone";

describe("payment collection rules", () => {
  let centerId: string;
  let nextStudentCode = 99000000;

  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
    centerId = useAuthStore.getState().activeCenterId!;
    configureTestCenterTimeZones();
    CardRangeRepository.replaceCenterRanges(centerId, [{
      id: "payment-rules-test-range",
      center_id: centerId,
      start_code: "99000000",
      end_code: "99009999",
      status: "active",
    }]);
  });

  function setCenterTimeZone(timeZone: string | null) {
    const db = DatabaseService.getDb();
    const center = db.getFirstSync<{ name: string; code: string }>(
      "SELECT name, code FROM centers WHERE id = ?",
      [centerId],
    );
    if (!center) throw new Error("The payment test center was not seeded.");
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
      [centerId, center.name, center.code, timeZone],
    );
  }

  it("uses the center business date for implicit payments and rejects a missing time zone", async () => {
    const student = createStudent();
    const cycle = await createBillingCycle(student.id, "2026-11-01", "2026-11-30");
    const dateSpy = jest
      .spyOn(SessionDateService, "getCurrentSessionDate")
      .mockReturnValue("2026-11-01");
    const operationId = `op-center-date-payment-${student.id}`;

    try {
      const payment = await PaymentRepository.recordPayment({
        studentId: student.id,
        amount: 10,
        paymentType: "partial",
        debtCycleId: cycle.id,
        operationId,
      });
      expect(dateSpy).toHaveBeenCalledWith(centerId);
      expect(payment.paymentDate).toBe("2026-11-01");
    } finally {
      dateSpy.mockRestore();
    }

    const db = DatabaseService.getDb();
    setCenterTimeZone(null);
    const rejectedOperationId = `op-center-date-missing-zone-${student.id}`;
    try {
      await expect(PaymentRepository.recordPayment({
        studentId: student.id,
        amount: 10,
        paymentType: "partial",
        debtCycleId: cycle.id,
        operationId: rejectedOperationId,
      })).rejects.toThrow("has no configured IANA time zone");
      expect(db.getFirstSync(
        "SELECT id FROM payments WHERE center_id = ? AND operation_id = ?",
        [centerId, rejectedOperationId],
      )).toBeNull();
    } finally {
      setCenterTimeZone("Africa/Cairo");
    }
  });

  it("uses the center business date for external-attendance payments and rejects unconfigured centers", async () => {
    const db = DatabaseService.getDb();
    const student = createStudent();
    const sessionId = `center-date-external-${student.id}`;
    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, session_price, status, created_at)
       VALUES (?, ?, 'grp-1', 'subj-1', 'teach-1', '2026-11-01', '10:00', '11:00', 250, 'open', ?)`,
      [sessionId, centerId, now],
    );
    const dateSpy = jest
      .spyOn(SessionDateService, "getCurrentSessionDate")
      .mockReturnValue("2026-11-01");

    try {
      await AttendanceRepository.recordAttendance({
        studentId: student.id,
        sessionId,
        status: "present",
        isLate: false,
        isExternal: true,
      });
      expect(dateSpy).toHaveBeenCalledWith(centerId, expect.any(Date));
      expect(db.getFirstSync(
        "SELECT payment_date as paymentDate FROM payments WHERE center_id = ? AND session_id = ?",
        [centerId, sessionId],
      )).toMatchObject({ paymentDate: "2026-11-01" });
    } finally {
      dateSpy.mockRestore();
    }

    const blockedStudent = createStudent();
    const blockedSessionId = `center-date-external-blocked-${blockedStudent.id}`;
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, session_price, status, created_at)
       VALUES (?, ?, 'grp-1', 'subj-1', 'teach-1', '2026-11-01', '11:00', '12:00', 250, 'open', ?)`,
      [blockedSessionId, centerId, now],
    );
    setCenterTimeZone(null);
    try {
      await expect(AttendanceRepository.recordAttendance({
        studentId: blockedStudent.id,
        sessionId: blockedSessionId,
        status: "present",
        isLate: false,
        isExternal: true,
      })).rejects.toThrow("has no configured IANA time zone");
      expect(db.getFirstSync(
        "SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
        [centerId, blockedSessionId, blockedStudent.id],
      )).toBeNull();
      expect(db.getFirstSync(
        "SELECT id FROM payments WHERE center_id = ? AND session_id = ?",
        [centerId, blockedSessionId],
      )).toBeNull();
    } finally {
      setCenterTimeZone("Africa/Cairo");
    }
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

  async function createPerSessionScenario() {
    const student = createStudent();
    const targetDate = SessionDateService.getCurrentSessionDate(centerId);
    const periodStart = `${targetDate.slice(0, 7)}-01`;
    const [year, month] = targetDate.slice(0, 7).split("-").map(Number);
    const monthEndDate = new Date(year, month, 0, 12);
    const periodEnd = `${monthEndDate.getFullYear()}-${String(monthEndDate.getMonth() + 1).padStart(2, "0")}-${String(monthEndDate.getDate()).padStart(2, "0")}`;
    const db = DatabaseService.getDb();
    const scenarioSessions: Array<{
      cycle: ReturnType<typeof DebtCycleRepository.generateCyclesForEnrollment>[number];
      session: NonNullable<ReturnType<typeof SessionRepository.findById>>;
      price: number;
    }> = [];

    for (const group of GroupRepository.getAll()) {
      const price = getConfiguredSessionPrice(group);
      const schedules = GroupScheduleRepository.getSchedulesForGroup(group.id);
      if (price <= 0 || !schedules.length) continue;

      const enrollment = EnrollmentRepository.enrollStudent({
        studentId: student.id,
        groupId: group.id,
        startDate: periodStart,
      });
      const cycles = DebtCycleRepository.generateCyclesForEnrollment(enrollment.id, periodEnd);
      const cycle = cycles.find((item) =>
        item.groupId === group.id &&
        item.startDate <= periodEnd &&
        item.endDate >= periodStart &&
        item.status !== "cancelled",
      );
      if (!cycle) continue;

      const dates = new Map<string, string>();
      for (const schedule of schedules) {
        for (let cursor = new Date(`${periodStart}T12:00:00`); cursor <= monthEndDate; cursor.setDate(cursor.getDate() + 1)) {
          if (cursor.getDay() !== schedule.dayOfWeek) continue;
          const sessionDate = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
          if (sessionDate < cycle.startDate || sessionDate > cycle.endDate) continue;
          const existing = db.getFirstSync<{ id: string }>(
            `SELECT id FROM sessions
             WHERE center_id = ? AND group_id = ? AND schedule_id = ? AND session_date = ?`,
            [centerId, group.id, schedule.id, sessionDate],
          );
          if (!existing) dates.set(sessionDate, schedule.id);
        }
        if (scenarioSessions.length + dates.size >= 2) break;
      }

      for (const [sessionDate, scheduleId] of dates) {
        const ensuredSession = AttendanceSessionService.ensureSessionForGroup(
          group.id,
          sessionDate,
          scheduleId,
        );
        const session = ensuredSession.status === "scheduled"
          ? AttendanceSessionService.activate(ensuredSession.id)
          : ensuredSession;
        if (session.status !== "open") {
          throw new Error(`Test session ${session.id} did not become open.`);
        }
        scenarioSessions.push({ cycle, session, price });
        if (scenarioSessions.length >= 2) break;
      }
      if (scenarioSessions.length >= 2) break;
    }

    if (scenarioSessions.length < 2) {
      throw new Error("The payment test fixture needs two unused, scheduled sessions in the current billing period.");
    }
    return { student, scenarioSessions };
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

  it("requires explicit per-session billing and records attendance/profile payments idempotently in the local outbox", async () => {
    const { student, scenarioSessions } = await createPerSessionScenario();
    const [attendanceSession, profileSession] = scenarioSessions;
    const db = DatabaseService.getDb();
    const rejectedOperationId = `op-session-pending-rejected-${student.id}`;

    expect(attendanceSession.cycle.billingMode).toBe("pending");
    await expect(PaymentRepository.recordSessionPayment({
      studentId: student.id,
      sessionId: attendanceSession.session.id,
      amount: attendanceSession.price,
      operationId: rejectedOperationId,
    })).rejects.toThrow("per_session");
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, attendanceSession.cycle.id],
    )?.billingMode).toBe("pending");
    expect(db.getFirstSync(
      "SELECT id FROM payments WHERE center_id = ? AND operation_id = ?",
      [centerId, rejectedOperationId],
    )).toBeNull();

    DebtCycleRepository.setBillingMode(attendanceSession.cycle.id, "per_session");
    if (profileSession.cycle.id !== attendanceSession.cycle.id) {
      DebtCycleRepository.setBillingMode(profileSession.cycle.id, "per_session");
    }
    for (const cycleId of new Set(scenarioSessions.map(({ cycle }) => cycle.id))) {
      expect(db.getFirstSync<{ billingMode: string }>(
        "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
        [centerId, cycleId],
      )?.billingMode).toBe("per_session");
    }
    await AttendanceRepository.recordAttendance({
      studentId: student.id,
      sessionId: attendanceSession.session.id,
      status: "present",
      isLate: false,
    });
    await AttendanceRepository.recordAttendance({
      studentId: student.id,
      sessionId: profileSession.session.id,
      status: "present",
      isLate: false,
    });

    const beforePayment = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(beforePayment.currentPeriodDebt).toBe(
      attendanceSession.price + profileSession.price,
    );
    expect(beforePayment.monthlyRemainingDebt).toBe(0);

    const attendanceOperationId = `op-session-attendance-${student.id}`;
    const attendancePayment = await PaymentRepository.recordSessionPayment({
      studentId: student.id,
      sessionId: attendanceSession.session.id,
      amount: attendanceSession.price,
      operationId: attendanceOperationId,
    });
    const attendanceRetry = await PaymentRepository.recordSessionPayment({
      studentId: student.id,
      sessionId: attendanceSession.session.id,
      amount: attendanceSession.price,
      operationId: attendanceOperationId,
    });
    expect(attendanceRetry.id).toBe(attendancePayment.id);
    expect(attendancePayment.sessionId).toBe(attendanceSession.session.id);

    const profileOperationId = `op-session-profile-${student.id}`;
    const profilePayment = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: profileSession.price,
      paymentType: "session",
      debtCycleId: profileSession.cycle.id,
      operationId: profileOperationId,
    });
    const profileRetry = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: profileSession.price,
      paymentType: "session",
      debtCycleId: profileSession.cycle.id,
      operationId: profileOperationId,
    });
    expect(profileRetry.id).toBe(profilePayment.id);
    expect(profilePayment.sessionId).toBeUndefined();
    expect(profilePayment.debtCycleId).toBe(profileSession.cycle.id);

    const payments = db.getAllSync<{ id: string; operationId: string; paymentType: string; sessionId: string | null }>(
      `SELECT id, operation_id as operationId, payment_type as paymentType, session_id as sessionId
       FROM payments WHERE center_id = ? AND student_id = ?`,
      [centerId, student.id],
    );
    expect(payments.filter((payment) =>
      payment.operationId === attendanceOperationId || payment.operationId === profileOperationId,
    )).toHaveLength(2);
    expect(payments.filter((payment) =>
      payment.operationId === attendanceOperationId || payment.operationId === profileOperationId,
    ).every((payment) => payment.paymentType === "session")).toBe(true);

    for (const operationId of [attendanceOperationId, profileOperationId]) {
      expect(SyncRepository.getPendingOperations(centerId)
        .filter((operation) => operation.operationId === operationId)).toHaveLength(1);
    }
    const afterPayment = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(afterPayment.currentPeriodDebt).toBe(0);
    expect(afterPayment.monthlyRemainingDebt).toBe(0);

    const reversalOperationId = `op-session-reversal-${student.id}`;
    const reversal = await PaymentRepository.reversePayment({
      paymentId: attendancePayment.id,
      reason: "اختبار عكس دفعة حصة",
      operationId: reversalOperationId,
    });
    expect(reversal.reversedAmount).toBe(attendanceSession.price);
    const afterReversal = FinancialCalculationService.getStudentFinancialStatus(student.id);
    expect(afterReversal.currentPeriodDebt).toBe(attendanceSession.price);
    expect(afterReversal.monthlyRemainingDebt).toBe(0);
    expect(afterReversal.sessionPaymentsTotal).toBe(profileSession.price);
    expect(db.getFirstSync<{ isReversed: boolean | number }>(
      "SELECT is_reversed as isReversed FROM payments WHERE center_id = ? AND id = ?",
      [centerId, attendancePayment.id],
    )?.isReversed).toBe(true);
    expect(SyncRepository.getPendingOperations(centerId)
      .filter((operation) => operation.operationId === reversalOperationId)).toHaveLength(1);
  });
});
