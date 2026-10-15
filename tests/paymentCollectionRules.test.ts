jest.mock("expo-device", () => ({ modelName: "Test Device" }));

import { DatabaseService } from "../src/core/database";
import { ConnectivityService } from "../src/core/connectivity";
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
import { submitPaymentAction } from "../src/features/payments/paymentActionService";
import { PaymentOperationIdentity } from "../src/features/payments/paymentSubmissionIdentity";
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

  async function createPerSessionScenario(groupId?: string, requiredSessions = 2) {
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

    for (const group of GroupRepository.getAll().filter(
      (item) => !groupId || item.id === groupId,
    )) {
      const price = getConfiguredSessionPrice(group);
      const schedules = GroupScheduleRepository.getSchedulesForGroup(group.id);
      if (price === undefined || price <= 0 || !schedules.length) continue;

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
          const existing = db.getFirstSync<{ id: string; status: string }>(
            `SELECT id, status FROM sessions
             WHERE center_id = ? AND group_id = ? AND schedule_id = ? AND session_date = ?`,
            [centerId, group.id, schedule.id, sessionDate],
          );
          if (!existing || ["scheduled", "open"].includes(existing.status)) {
            dates.set(sessionDate, schedule.id);
          }
        }
        if (scenarioSessions.length + dates.size >= requiredSessions) break;
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
        if (scenarioSessions.length >= requiredSessions) break;
      }
      if (scenarioSessions.length >= requiredSessions) break;
    }

    if (scenarioSessions.length < requiredSessions) {
      throw new Error(
        `The payment test fixture needs ${requiredSessions} scheduled sessions in the current billing period.`,
      );
    }
    return { student, scenarioSessions };
  }

  function setTestGroupPrices(
    groupId: string,
    sessionPrice: number,
    monthlyPrice: number,
  ) {
    const group = GroupRepository.findById(groupId);
    if (!group) throw new Error("The payment test group was not found.");
    DatabaseService.getDb().runSync(
      `UPDATE groups
       SET name = ?, teacher_id = ?, subject_id = ?, grade = ?,
           session_price = ?, monthly_price = ?, session_duration_minutes = ?,
           late_after_minutes = ?, status = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [
        group.name,
        group.teacherId,
        group.subjectId,
        group.grade,
        sessionPrice,
        monthlyPrice,
        group.sessionDurationMinutes ?? 120,
        group.lateAfterMinutes ?? 15,
        group.status,
        new Date().toISOString(),
        centerId,
        groupId,
      ],
    );
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

  it("collects a session against a monthly cycle with exact group pricing, offline retry safety, and race protection", async () => {
    const db = DatabaseService.getDb();
    const group = GroupRepository.getAll().find(
      (item) => GroupScheduleRepository.getSchedulesForGroup(item.id).length > 0,
    );
    if (!group) throw new Error("The payment test fixture needs a scheduled group.");
    const originalPrices = db.getFirstSync<{
      sessionPrice: number;
      monthlyPrice: number;
    }>(
      "SELECT session_price as sessionPrice, monthly_price as monthlyPrice FROM groups WHERE center_id = ? AND id = ?",
      [centerId, group.id],
    );
    if (!originalPrices) throw new Error("The payment test group was not found.");

    const previousConnectivity = ConnectivityService.getState();
    setTestGroupPrices(group.id, 137, 1000);
    try {
      ConnectivityService.setState("offline");
      const { student, scenarioSessions } = await createPerSessionScenario(group.id, 3);
      const [attendanceSession, profileSession, racingSession] = scenarioSessions;
      const untouchedStudent = await createPerSessionScenario(group.id);
      const untouchedCycle = untouchedStudent.scenarioSessions[0].cycle;
      const cycleId = attendanceSession.cycle.id;
      DebtCycleRepository.setBillingMode(cycleId, "monthly");
      expect(untouchedCycle.billingMode).toBe("pending");
      await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: cycleId,
        adjustmentAmount: -50,
        reason: "خصم اختبار الدفع بالحصة",
        operationId: `op-session-discount-${student.id}`,
      });

      for (const scenario of scenarioSessions) {
        await AttendanceRepository.recordAttendance({
          studentId: student.id,
          sessionId: scenario.session.id,
          status: "present",
          isLate: false,
        });
      }

      const before = FinancialCalculationService.getStudentFinancialStatus(student.id);
      const cycleBefore = before.cycles.find((item) => item.id === cycleId);
      const firstCandidate = before.sessionDebt?.paymentCandidates?.find(
        (candidate) => candidate.sessionId === attendanceSession.session.id,
      );
      expect(firstCandidate).toMatchObject({
        debtCycleId: cycleId,
        sessionPrice: 137,
        amountDue: 137,
      });
      expect(before.sessionDebt!.expectedSessions).toBeGreaterThan(0);
      expect(1000 / before.sessionDebt!.expectedSessions).not.toBe(137);
      expect(cycleBefore?.billingMode).toBe("monthly");

      const attendanceRequest = {
        centerId,
        studentId: student.id,
        amount: 137,
        paymentType: "session" as const,
        debtCycleId: cycleId,
        sessionId: attendanceSession.session.id,
      };
      await expect(PaymentRepository.recordPayment({
        ...attendanceRequest,
        amount: 138,
        operationId: `op-session-overcharge-${student.id}`,
      })).rejects.toThrow("المبلغ يتجاوز رسوم الحصة المتبقية");
      const attendanceIdentityRef: { current: PaymentOperationIdentity | null } = {
        current: null,
      };
      const attendanceSubmission = await submitPaymentAction(
        attendanceRequest,
        attendanceIdentityRef.current,
        (identity) => { attendanceIdentityRef.current = identity; },
      );
      const attendanceRetry = await submitPaymentAction(
        attendanceRequest,
        attendanceIdentityRef.current,
        (identity) => { attendanceIdentityRef.current = identity; },
      );
      expect(attendanceRetry.payment.id).toBe(attendanceSubmission.payment.id);
      expect(attendanceSubmission.payment).toMatchObject({
        paymentType: "session",
        sessionId: attendanceSession.session.id,
        debtCycleId: cycleId,
        amount: 137,
      });

      const profileRequest = {
        centerId,
        studentId: student.id,
        amount: 137,
        paymentType: "session" as const,
        debtCycleId: cycleId,
        sessionId: profileSession.session.id,
      };
      const profileIdentityRef: { current: PaymentOperationIdentity | null } = {
        current: null,
      };
      const profileSubmission = await submitPaymentAction(
        profileRequest,
        profileIdentityRef.current,
        (identity) => { profileIdentityRef.current = identity; },
      );
      const profileRetry = await submitPaymentAction(
        profileRequest,
        profileIdentityRef.current,
        (identity) => { profileIdentityRef.current = identity; },
      );
      expect(profileRetry.payment.id).toBe(profileSubmission.payment.id);
      expect(profileSubmission.payment.sessionId).toBe(profileSession.session.id);

      const raceResults = await Promise.allSettled([
        PaymentRepository.recordPayment({
          studentId: student.id,
          amount: 137,
          paymentType: "session",
          debtCycleId: cycleId,
          sessionId: racingSession.session.id,
          operationId: `op-session-race-a-${student.id}`,
        }),
        PaymentRepository.recordPayment({
          studentId: student.id,
          amount: 137,
          paymentType: "session",
          debtCycleId: cycleId,
          sessionId: racingSession.session.id,
          operationId: `op-session-race-b-${student.id}`,
        }),
      ]);
      expect(raceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raceResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(PaymentRepository.recordPayment({
        studentId: student.id,
        amount: 137,
        paymentType: "session",
        debtCycleId: cycleId,
        sessionId: attendanceSession.session.id,
        operationId: `op-session-duplicate-${student.id}`,
      })).rejects.toThrow("لا يوجد مبلغ مستحق للتحصيل عن هذه الحصة");

      const finalStatus = FinancialCalculationService.getStudentFinancialStatus(student.id);
      const cycleAfter = finalStatus.cycles.find((item) => item.id === cycleId);
      expect(cycleAfter?.billingMode).toBe("monthly");
      expect(finalStatus.monthlyTotalPaid).toBe(0);
      expect(cycleAfter?.remainingDebt).toBe(
        Number(cycleBefore?.remainingDebt || 0) - 137 * 3,
      );
      expect(finalStatus.groupMonthlyPaid).toBe(137 * 3);
      expect(finalStatus.monthlyRemainingDebt).toBe(
        Number(cycleBefore?.remainingDebt || 0) - 137 * 3,
      );
      expect(db.getFirstSync<{ billingMode: string }>(
        "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
        [centerId, untouchedCycle.id],
      )?.billingMode).toBe("pending");
      expect(finalStatus.sessionPayments).toHaveLength(3);
      expect(finalStatus.monthlyPayments).toHaveLength(0);
      const attendanceGroupStatus = FinancialCalculationService
        .getStudentFinancialStatusForGroup(student.id, group.id);
      expect(attendanceGroupStatus.groupMonthlyPaid).toBe(137 * 3);
      expect(attendanceGroupStatus.groupRemainingDebt).toBe(
        Number(cycleBefore?.remainingDebt || 0) - 137 * 3,
      );
      expect(attendanceGroupStatus.monthlyTotalPaid).toBe(0);

      const successfulOperationIds = [
        attendanceSubmission.identity.operationId,
        profileSubmission.identity.operationId,
        ...raceResults
          .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof PaymentRepository.recordPayment>>> => result.status === "fulfilled")
          .map((result) => result.value.operationId),
      ];
      for (const operationId of successfulOperationIds) {
        expect(SyncRepository.getPendingOperations(centerId)
          .filter((operation) => operation.operationId === operationId)).toHaveLength(1);
      }
      const queuedSessionOperation = SyncRepository.getPendingOperations(centerId)
        .find((operation) =>
          operation.operationId === attendanceSubmission.identity.operationId,
        );
      if (!queuedSessionOperation) {
        throw new Error("The offline session payment was not queued for sync.");
      }
      expect(queuedSessionOperation.operationType).toBe("payment.create");
      expect(JSON.parse(String(queuedSessionOperation.payload))).toMatchObject({
        paymentType: "session",
        sessionId: attendanceSession.session.id,
        debtCycleId: cycleId,
        amount: 137,
      });

      const reversalOperationId = `op-session-payment-reversal-${student.id}`;
      const reversal = await PaymentRepository.reversePayment({
        paymentId: attendanceSubmission.payment.id,
        reason: "اختبار عكس دفعة حصة مرتبطة بدورة شهرية",
        operationId: reversalOperationId,
      });
      expect(reversal.reversedAmount).toBe(137);
      const afterReversal = FinancialCalculationService.getStudentFinancialStatus(student.id);
      expect(afterReversal.monthlyRemainingDebt).toBe(
        Number(cycleBefore?.remainingDebt || 0) - 137 * 2,
      );
      expect(afterReversal.monthlyTotalPaid).toBe(0);
      expect(afterReversal.sessionPaymentsTotal).toBe(137 * 2);
      const groupStatusAfterReversal = FinancialCalculationService
        .getStudentFinancialStatusForGroup(student.id, group.id);
      expect(groupStatusAfterReversal.groupMonthlyPaid).toBe(137 * 2);
      expect(groupStatusAfterReversal.groupRemainingDebt).toBe(
        Number(cycleBefore?.remainingDebt || 0) - 137 * 2,
      );
      expect(db.getFirstSync<{ isReversed: boolean | number }>(
        "SELECT is_reversed as isReversed FROM payments WHERE center_id = ? AND id = ?",
        [centerId, attendanceSubmission.payment.id],
      )?.isReversed).toBe(true);
      expect(SyncRepository.getPendingOperations(centerId)
        .filter((operation) => operation.operationId === reversalOperationId))
        .toHaveLength(1);

      const monthlyStudent = await createPerSessionScenario(group.id);
      const monthlyCycle = monthlyStudent.scenarioSessions[0].cycle;
      DebtCycleRepository.setBillingMode(monthlyCycle.id, "monthly");
      const monthlyBalance = FinancialCalculationService
        .getStudentFinancialStatus(monthlyStudent.student.id)
        .cycles.find((item) => item.id === monthlyCycle.id)?.remainingDebt;
      const monthlyPayment = await PaymentRepository.recordPayment({
        studentId: monthlyStudent.student.id,
        amount: Number(monthlyBalance),
        paymentType: "monthly",
        debtCycleId: monthlyCycle.id,
        operationId: `op-monthly-on-monthly-cycle-${monthlyStudent.student.id}`,
      });
      const monthlyStatus = FinancialCalculationService
        .getStudentFinancialStatus(monthlyStudent.student.id);
      expect(monthlyPayment.paymentType).toBe("monthly");
      expect(monthlyStatus.sessionPayments).toHaveLength(0);
      expect(monthlyStatus.monthlyPayments).toHaveLength(1);
      expect(monthlyStatus.monthlyRemainingDebt).toBe(0);
      expect(monthlyStatus.cycles.find((item) => item.id === monthlyCycle.id)?.billingMode)
        .toBe("monthly");
      expect(SyncRepository.getPendingOperations(centerId)
        .filter((operation) => operation.operationId === monthlyPayment.operationId))
        .toHaveLength(1);
    } finally {
      ConnectivityService.setState(previousConnectivity);
      setTestGroupPrices(
        group.id,
        originalPrices.sessionPrice,
        originalPrices.monthlyPrice,
      );
    }
  });

  it("allows the selected collection method on pending cycles and honors discounts and full waivers", async () => {
    const db = DatabaseService.getDb();
    const group = GroupRepository.getAll().find(
      (item) => GroupScheduleRepository.getSchedulesForGroup(item.id).length > 0,
    );
    if (!group) throw new Error("The payment test fixture needs a scheduled group.");
    const originalPrices = db.getFirstSync<{
      sessionPrice: number;
      monthlyPrice: number;
    }>(
      "SELECT session_price as sessionPrice, monthly_price as monthlyPrice FROM groups WHERE center_id = ? AND id = ?",
      [centerId, group.id],
    );
    if (!originalPrices) throw new Error("The payment test group was not found.");
    setTestGroupPrices(group.id, 141, 930);

    try {
      const discountedScenario = await createPerSessionScenario(group.id);
      const discountedSession = discountedScenario.scenarioSessions[0];
      expect(discountedSession.cycle.billingMode).toBe("pending");
      await AttendanceRepository.recordAttendance({
        studentId: discountedScenario.student.id,
        sessionId: discountedSession.session.id,
        status: "present",
        isLate: false,
      });
      const initialCycle = FinancialCalculationService
        .getStudentFinancialStatus(discountedScenario.student.id)
        .cycles.find((cycle) => cycle.id === discountedSession.cycle.id);
      const adjustedBalance = 50;
      await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: discountedSession.cycle.id,
        adjustmentAmount: adjustedBalance - Number(initialCycle?.effectivePrice || 0),
        reason: "خصم اختبار الدورة المعلقة",
        operationId: `op-pending-session-discount-${discountedScenario.student.id}`,
      });
      const discountedCandidate = FinancialCalculationService
        .getStudentFinancialStatus(discountedScenario.student.id)
        .sessionDebt?.paymentCandidates?.find(
          (candidate) => candidate.sessionId === discountedSession.session.id,
        );
      expect(discountedCandidate).toMatchObject({
        sessionPrice: 141,
        amountDue: 50,
      });
      const discountedPayment = await PaymentRepository.recordPayment({
        studentId: discountedScenario.student.id,
        amount: 50,
        paymentType: "session",
        debtCycleId: discountedSession.cycle.id,
        sessionId: discountedSession.session.id,
        operationId: `op-pending-session-discount-payment-${discountedScenario.student.id}`,
      });
      const discountedStatus = FinancialCalculationService
        .getStudentFinancialStatus(discountedScenario.student.id);
      expect(discountedPayment.paymentType).toBe("session");
      expect(discountedStatus.monthlyRemainingDebt).toBe(0);
      expect(discountedStatus.monthlyTotalPaid).toBe(0);
      expect(discountedStatus.cycles.find((cycle) => cycle.id === discountedSession.cycle.id)?.billingMode)
        .toBe("pending");

      const monthlyScenario = await createPerSessionScenario(group.id);
      const monthlyCycle = monthlyScenario.scenarioSessions[0].cycle;
      const monthlyBalance = FinancialCalculationService
        .getStudentFinancialStatus(monthlyScenario.student.id)
        .cycles.find((cycle) => cycle.id === monthlyCycle.id)?.remainingDebt;
      const monthlyPayment = await PaymentRepository.recordPayment({
        studentId: monthlyScenario.student.id,
        amount: Number(monthlyBalance),
        paymentType: "monthly",
        debtCycleId: monthlyCycle.id,
        operationId: `op-pending-monthly-payment-${monthlyScenario.student.id}`,
      });
      expect(monthlyPayment.paymentType).toBe("monthly");
      expect(FinancialCalculationService
        .getStudentFinancialStatus(monthlyScenario.student.id)
        .cycles.find((cycle) => cycle.id === monthlyCycle.id)?.billingMode).toBe("pending");

      const exemptScenario = await createPerSessionScenario(group.id);
      const exemptSession = exemptScenario.scenarioSessions[0];
      await AttendanceRepository.recordAttendance({
        studentId: exemptScenario.student.id,
        sessionId: exemptSession.session.id,
        status: "present",
        isLate: false,
      });
      const exemptCycle = FinancialCalculationService
        .getStudentFinancialStatus(exemptScenario.student.id)
        .cycles.find((cycle) => cycle.id === exemptSession.cycle.id);
      await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: exemptSession.cycle.id,
        adjustmentAmount: -Number(exemptCycle?.effectivePrice || 0),
        reason: "إعفاء كامل من الاشتراك",
        operationId: `op-pending-session-exemption-${exemptScenario.student.id}`,
      });
      await expect(PaymentRepository.recordPayment({
        studentId: exemptScenario.student.id,
        amount: 1,
        paymentType: "session",
        debtCycleId: exemptSession.cycle.id,
        sessionId: exemptSession.session.id,
        operationId: `op-pending-session-exempted-${exemptScenario.student.id}`,
      })).rejects.toThrow("لا يوجد مبلغ مستحق للتحصيل عن هذه الحصة");
      expect(db.getFirstSync<{ billingMode: string }>(
        "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
        [centerId, exemptSession.cycle.id],
      )?.billingMode).toBe("pending");
    } finally {
      setTestGroupPrices(
        group.id,
        originalPrices.sessionPrice,
        originalPrices.monthlyPrice,
      );
    }
  });

  it("does not switch a pending cycle after a payment has been recorded against it", async () => {
    const { student, scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();
    const operationId = `op-pending-cycle-payment-${student.id}`;

    const payment = await PaymentRepository.recordPayment({
      studentId: student.id,
      amount: 1,
      paymentType: "partial",
      debtCycleId: cycle.id,
      operationId,
    });

    expect(payment.debtCycleId).toBe(cycle.id);
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("pending");
    expect(() => DebtCycleRepository.setBillingMode(cycle.id, "per_session"))
      .toThrow("بعد تسجيل دفعات لهذه الدورة أو فترتها");
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("pending");
  });

  it("blocks per-session conversion when a legacy payment already references the pending cycle", async () => {
    const { student, scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const operationId = `op-legacy-cycle-payment-${student.id}`;
    db.runSync(
      `INSERT INTO payments
       (id, operation_id, center_id, student_id, debt_cycle_id,
        amount, payment_type, payment_method, payment_date, is_reversed,
        created_at, user_id)
       VALUES (?, ?, ?, ?, ?, 10, 'monthly', 'cash', ?, 0, ?, ?)`,
      [
        `legacy-payment-${student.id}`,
        operationId,
        centerId,
        student.id,
        cycle.id,
        cycle.startDate,
        now,
        useAuthStore.getState().currentUser!.id,
      ],
    );

    expect(() => DebtCycleRepository.setBillingMode(cycle.id, "per_session"))
      .toThrow("دفعات لهذه الدورة أو فترتها");
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("pending");
  });

  it("preserves a cycle discount by refusing an unsafe conversion to per-session billing", async () => {
    const { student, scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();

    await DebtAdjustmentRepository.createAdjustment({
      debtCycleId: cycle.id,
      adjustmentAmount: -1,
      reason: "خصم محفوظ قبل تحديد نظام الفوترة",
    });

    expect(() => DebtCycleRepository.setBillingMode(cycle.id, "per_session"))
      .toThrow("خصم أو تعديل");
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("pending");
    expect(FinancialCalculationService.getStudentFinancialStatus(student.id)
      .adjustments.some((adjustment) => adjustment.debtCycleId === cycle.id)).toBe(true);
  });

  it("does not discard a student's negotiated monthly rate when selecting per-session billing", async () => {
    const { scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();

    db.runSync(
      "UPDATE student_group_enrollments SET special_monthly_price = 250 WHERE center_id = ? AND id = ?",
      [centerId, cycle.enrollmentId],
    );
    expect(db.getFirstSync<{ specialMonthlyPrice: number }>(
      `SELECT special_monthly_price as specialMonthlyPrice
       FROM student_group_enrollments WHERE center_id = ? AND id = ?`,
      [centerId, cycle.enrollmentId],
    )?.specialMonthlyPrice).toBe(250);

    expect(() => DebtCycleRepository.setBillingMode(cycle.id, "per_session"))
      .toThrow("سعر شهري خاص");
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("pending");
  });

  it("refuses cycle-total adjustments after per-session billing is selected", async () => {
    const { scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();

    DebtCycleRepository.setBillingMode(cycle.id, "per_session");
    await expect(DebtAdjustmentRepository.createAdjustment({
      debtCycleId: cycle.id,
      adjustmentAmount: -50,
      reason: "خصم بعد تحديد الدفع بالحصة",
    })).rejects.toThrow("توزيع التعديل على كل حصة");

    expect(DebtAdjustmentRepository.getAdjustmentsForCycle(cycle.id)).toEqual([]);
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("per_session");
  });

  it("refuses cycle-total adjustments after per-session billing is selected", async () => {
    const { scenarioSessions } = await createPerSessionScenario();
    const cycle = scenarioSessions[0].cycle;
    const db = DatabaseService.getDb();

    DebtCycleRepository.setBillingMode(cycle.id, "per_session");
    await expect(DebtAdjustmentRepository.createAdjustment({
      debtCycleId: cycle.id,
      adjustmentAmount: -50,
      reason: "خصم بعد تحديد الدفع بالحصة",
    })).rejects.toThrow("توزيع التعديل على كل حصة");

    expect(DebtAdjustmentRepository.getAdjustmentsForCycle(cycle.id)).toEqual([]);
    expect(db.getFirstSync<{ billingMode: string }>(
      "SELECT billing_mode as billingMode FROM debt_cycles WHERE center_id = ? AND id = ?",
      [centerId, cycle.id],
    )?.billingMode).toBe("per_session");
  });
});
