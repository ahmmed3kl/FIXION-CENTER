import { DebtCycle } from "../src/shared/types";
import { getConfiguredSessionPrice, getSessionPaymentCycles, hasPayableSessionDebt } from "../src/features/payments/paymentEligibility";
import { resolvePaymentOperationIdentity } from "../src/features/payments/paymentSubmissionIdentity";

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

describe("session payment eligibility", () => {
  it("requires an explicit per-session group cycle in the current period", () => {
    const cycles = [
      makeCycle({ id: "session-current", billingMode: "per_session", cycleType: "per_session" }),
      makeCycle({ id: "session-old", billingMode: "per_session", cycleType: "per_session", startDate: "2026-09-01", endDate: "2026-09-30" }),
      makeCycle({ id: "pending", billingMode: "pending" }),
      makeCycle({ id: "package", billingMode: "per_session", cycleType: "package" }),
      makeCycle({ id: "cancelled", billingMode: "per_session", cycleType: "per_session", status: "cancelled" }),
      makeCycle({ id: "paid", billingMode: "per_session", cycleType: "per_session", status: "paid" }),
    ];

    expect(getSessionPaymentCycles(cycles, {
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    }).map((cycle) => cycle.id)).toEqual(["session-current"]);
    expect(hasPayableSessionDebt({
      currentPeriodDebt: 300,
      cycles,
      sessionDebt: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        expectedSessions: 1,
        futureUnpaidSessions: 0,
        futurePaidSessions: 0,
        attendedPaidSessions: 0,
        attendedUnpaidSessions: 1,
        currentDebt: 300,
        sessionPriceTotal: 300,
      },
    })).toBe(true);
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
      },
    })).toBe(false);
  });

  it("uses the configured session price and the existing default-fee fallback", () => {
    expect(getConfiguredSessionPrice({ sessionPrice: 275, defaultFee: 400 })).toBe(275);
    expect(getConfiguredSessionPrice({ sessionPrice: 0, defaultFee: 400 })).toBe(400);
    expect(getConfiguredSessionPrice({ sessionPrice: 0, defaultFee: 0 })).toBe(0);
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
