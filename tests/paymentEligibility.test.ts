import { DebtCycle, SessionPaymentCandidate } from "../src/shared/types";
import {
  getConfiguredSessionPrice,
  getPayableSessionPaymentCandidates,
  getSessionPaymentActionState,
  getSessionPaymentCycles,
  getSessionPaymentUnavailableReason,
  hasPayableSessionDebt,
  isSessionPaymentCycle,
} from "../src/features/payments/paymentEligibility";
import { resolvePaymentOperationIdentity } from "../src/features/payments/paymentSubmissionIdentity";
import { normalizeBillingMode } from "../src/shared/utils/billingMode";

const makeCycle = (overrides: Partial<DebtCycle> = {}): DebtCycle => ({
  id: "cycle-1",
  centerId: "center-1",
  studentId: "student-1",
  enrollmentId: "enrollment-1",
  groupId: "group-1",
  cycleNumber: 1,
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  cyclePrice: 0,
  status: "open",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const makeCandidate = (
  overrides: Partial<SessionPaymentCandidate> = {},
): SessionPaymentCandidate => ({
  sessionId: "session-1",
  groupId: "group-1",
  groupName: "المجموعة",
  sessionDate: "2026-10-15",
  debtCycleId: "cycle-1",
  sessionPrice: 275,
  amountDue: 275,
  ...overrides,
});

describe("session payment eligibility", () => {
  it("allows a concrete session payment on monthly and pending cycles without changing their default mode", () => {
    const cycles = [
      makeCycle({ id: "monthly-cycle", billingMode: "monthly", cyclePrice: 500, remainingDebt: 500 }),
      makeCycle({ id: "pending-cycle", billingMode: "pending", cyclePrice: 600, remainingDebt: 600 }),
    ];
    const status = {
      currentPeriodDebt: 0,
      cycles,
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 2,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 2,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [
          makeCandidate({ sessionId: "monthly-session", debtCycleId: "monthly-cycle" }),
          makeCandidate({
            sessionId: "pending-session",
            debtCycleId: "pending-cycle",
            groupId: "group-1",
          }),
        ],
      },
    };

    expect(getSessionPaymentCycles(cycles, status.sessionDebt).map((cycle) => cycle.id))
      .toEqual(["monthly-cycle", "pending-cycle"]);
    expect(getPayableSessionPaymentCandidates(status).map((candidate) => candidate.sessionId))
      .toEqual(["monthly-session", "pending-session"]);
    expect(hasPayableSessionDebt(status)).toBe(true);
    expect(getSessionPaymentUnavailableReason(status)).toBeNull();
    expect(getSessionPaymentActionState(status, true, false, "monthly-session"))
      .toEqual({ disabled: false, reason: null });
  });

  it("does not expose a session payment when there is no current session debt", () => {
    expect(hasPayableSessionDebt({
      currentPeriodDebt: 0,
      cycles: [makeCycle({ billingMode: "per_session", cycleType: "per_session" })],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 0,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 0,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [],
      },
    })).toBe(false);
  });

  it("does not allow package, cancelled, or fully paid cycles to provide a session balance", () => {
    const cycles = [
      makeCycle({ id: "package-cycle", cycleType: "package", billingMode: "package" }),
      makeCycle({ id: "cancelled-cycle", status: "cancelled" }),
      makeCycle({ id: "paid-cycle", status: "paid", remainingDebt: 0 }),
    ];
    const status = {
      currentPeriodDebt: 0,
      cycles,
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 3,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 3,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [
          makeCandidate({ debtCycleId: "package-cycle" }),
          makeCandidate({ sessionId: "cancelled-session", debtCycleId: "cancelled-cycle" }),
          makeCandidate({ sessionId: "paid-session", debtCycleId: "paid-cycle" }),
        ],
      },
    };

    expect(getPayableSessionPaymentCandidates(status)).toEqual([]);
    expect(getSessionPaymentCycles(cycles, status.sessionDebt)).toEqual([]);
    expect(getSessionPaymentUnavailableReason(status)).toContain("باقة");
    expect(getSessionPaymentUnavailableReason(status, "session-1")).toContain("باقة");
  });

  it("explains when the selected session is already covered by a package", () => {
    const cycle = makeCycle({ billingMode: "monthly" });
    const status = {
      currentPeriodDebt: 0,
      cycles: [cycle],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 1,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 1,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [
          makeCandidate({ debtCycleId: cycle.id, packageCovered: true }),
        ],
      },
    };

    expect(getPayableSessionPaymentCandidates(status, "session-1")).toEqual([]);
    expect(getSessionPaymentUnavailableReason(status, "session-1"))
      .toBe("هذه الحصة مغطاة بباقة، ولا تُحصّل لها دفعة حصة مستقلة.");
  });

  it("uses the explicit pending mode and still offers a session payment when a candidate exists", () => {
    const pendingLegacyCycle = makeCycle({
      billingMode: "pending",
      cycleType: "per_session",
      remainingDebt: 300,
    });
    const status = {
      currentPeriodDebt: 0,
      cycles: [pendingLegacyCycle],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 1,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 0,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [makeCandidate({ debtCycleId: pendingLegacyCycle.id })],
      },
    };

    expect(normalizeBillingMode("pending", "per_session")).toBe("pending");
    expect(normalizeBillingMode("monthly", "per_session")).toBe("monthly");
    expect(isSessionPaymentCycle(pendingLegacyCycle)).toBe(false);
    expect(isSessionPaymentCycle(makeCycle({
      billingMode: "monthly",
      cycleType: "per_session",
    }))).toBe(false);
    expect(getSessionPaymentCycles(status.cycles, status.sessionDebt))
      .toEqual([pendingLegacyCycle]);
    expect(getSessionPaymentUnavailableReason(status)).toBeNull();
  });

  it("scopes session candidates to the requested session and group cycle", () => {
    const cycles = [
      makeCycle({ id: "group-one-cycle", groupId: "group-1", billingMode: "monthly", remainingDebt: 100 }),
      makeCycle({ id: "group-two-cycle", groupId: "group-2", billingMode: "pending", remainingDebt: 125 }),
    ];
    const status = {
      currentPeriodDebt: 0,
      cycles,
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 2,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 2,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [
          makeCandidate({ sessionId: "group-one-session", debtCycleId: "group-one-cycle" }),
          makeCandidate({
            sessionId: "group-two-session",
            groupId: "group-2",
            debtCycleId: "group-two-cycle",
            amountDue: 125,
          }),
        ],
      },
    };

    expect(getSessionPaymentCycles(cycles, status.sessionDebt).map((cycle) => cycle.id))
      .toEqual(["group-one-cycle", "group-two-cycle"]);
    expect(getPayableSessionPaymentCandidates(status, "group-two-session"))
      .toMatchObject([{ sessionId: "group-two-session", debtCycleId: "group-two-cycle" }]);
  });

  it("allows a properly priced external attendance candidate without a debt cycle", () => {
    const status = {
      currentPeriodDebt: 0,
      cycles: [],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 1,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 0,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [makeCandidate({ debtCycleId: undefined })],
      },
    };

    expect(getPayableSessionPaymentCandidates(status)).toHaveLength(1);
    expect(getSessionPaymentActionState(status, true, false).disabled).toBe(false);
  });

  it("explains missing session pricing and never falls back to default_fee", () => {
    const status = {
      currentPeriodDebt: 0,
      cycles: [makeCycle({ billingMode: "monthly", remainingDebt: 300 })],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 1,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 0,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [makeCandidate({ sessionPrice: null, amountDue: 0 })],
      },
    };

    expect(getConfiguredSessionPrice({ sessionPrice: 275 })).toBe(275);
    expect(getConfiguredSessionPrice({ sessionPrice: 0 })).toBeUndefined();
    expect(getSessionPaymentUnavailableReason(status)).toContain("سعر الحصة غير محدد");
  });

  it("explains missing payment permission and blocks duplicate in-flight submissions", () => {
    const status = {
      currentPeriodDebt: 0,
      cycles: [],
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 0,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 0,
        currentDebt: 0,
        sessionPriceTotal: 0,
        paymentCandidates: [],
      },
    };

    expect(getSessionPaymentActionState(status, false, false)).toEqual({
      disabled: true,
      reason: "ليس لديك صلاحية تسجيل المدفوعات.",
    });
    expect(getSessionPaymentActionState(status, true, true).disabled).toBe(true);
  });
});

describe("payment retry identity", () => {
  it("reuses an operation id only for the exact same payment request", () => {
    const payment = {
      centerId: "center-1",
      studentId: "student-1",
      amount: 275,
      paymentType: "session" as const,
      debtCycleId: "cycle-1",
    };
    const first = resolvePaymentOperationIdentity(payment, null);

    expect(resolvePaymentOperationIdentity(payment, first)).toBe(first);
    expect(resolvePaymentOperationIdentity({ ...payment, amount: 250 }, first).operationId)
      .not.toBe(first.operationId);
  });
});
