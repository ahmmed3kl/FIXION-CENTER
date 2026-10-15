import { DebtCycle, DetailedStudentFinancialStatus, Group, SessionDebtBreakdown } from "../../shared/types";

export function isSessionPaymentCycle(cycle: DebtCycle): boolean {
  return Boolean(
    cycle.groupId &&
    !cycle.packageSubscriptionId &&
    cycle.billingMode !== "package" &&
    cycle.cycleType !== "package" &&
    cycle.status !== "cancelled" &&
    cycle.status !== "paid" &&
    (cycle.billingMode === "per_session" || cycle.cycleType === "per_session"),
  );
}

export function getSessionPaymentCycles(
  cycles: DebtCycle[],
  period?: Pick<SessionDebtBreakdown, "periodStart" | "periodEnd">,
): DebtCycle[] {
  if (!period) return [];
  return cycles.filter((cycle) =>
    isSessionPaymentCycle(cycle) &&
    cycle.startDate <= period.periodEnd &&
    cycle.endDate >= period.periodStart,
  );
}

export function hasPayableSessionDebt(
  status: Pick<DetailedStudentFinancialStatus, "currentPeriodDebt" | "cycles" | "sessionDebt"> | null | undefined,
): boolean {
  return Boolean(
    status &&
    status.sessionDebt &&
    Number(status.currentPeriodDebt || 0) > 0 &&
    getSessionPaymentCycles(status.cycles, status.sessionDebt).length > 0,
  );
}

export function getConfiguredSessionPrice(
  group: Pick<Group, "sessionPrice" | "defaultFee"> | null | undefined,
): number {
  return Math.max(0, Number(group?.sessionPrice || group?.defaultFee || 0) || 0);
}
