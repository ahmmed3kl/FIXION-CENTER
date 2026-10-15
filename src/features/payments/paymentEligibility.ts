import {
  DebtCycle,
  DetailedStudentFinancialStatus,
  Group,
  SessionDebtBreakdown,
  SessionPaymentCandidate,
} from "../../shared/types";
import { isPerSessionBillingMode } from "../../shared/utils/billingMode";

export function isSessionPaymentCycle(cycle: DebtCycle): boolean {
  return Boolean(
    cycle.groupId &&
    !cycle.packageSubscriptionId &&
    cycle.cycleType !== "package" &&
    cycle.status !== "cancelled" &&
    cycle.status !== "paid" &&
    isPerSessionBillingMode(cycle.billingMode, cycle.cycleType),
  );
}

type SessionPaymentStatus = Pick<
  DetailedStudentFinancialStatus,
  "currentPeriodDebt" | "cycles" | "sessionDebt"
>;

export function getPayableSessionPaymentCandidates(
  status: SessionPaymentStatus | null | undefined,
  sessionId?: string,
): SessionPaymentCandidate[] {
  if (!status?.sessionDebt?.paymentCandidates) return [];
  const cyclesById = new Map(status.cycles.map((cycle) => [cycle.id, cycle]));

  return status.sessionDebt.paymentCandidates.filter((candidate) => {
    if (
      (sessionId && candidate.sessionId !== sessionId) ||
      candidate.packageCovered ||
      !candidate.sessionPrice ||
      candidate.sessionPrice <= 0 ||
      candidate.amountDue <= 0
    ) {
      return false;
    }

    if (!candidate.debtCycleId) return true;
    const cycle = cyclesById.get(candidate.debtCycleId);
    return Boolean(
      cycle &&
      cycle.groupId === candidate.groupId &&
      !cycle.packageSubscriptionId &&
      cycle.cycleType !== "package" &&
      cycle.billingMode !== "package" &&
      cycle.status !== "cancelled" &&
      cycle.status !== "paid",
    );
  });
}

export function getSessionPaymentCycles(
  cycles: DebtCycle[],
  period?: Pick<SessionDebtBreakdown, "paymentCandidates">,
): DebtCycle[] {
  if (!period?.paymentCandidates) return [];
  const payableCycleIds = new Set(
    period.paymentCandidates
      .filter(
        (candidate) =>
          !candidate.packageCovered &&
          Boolean(candidate.sessionPrice && candidate.sessionPrice > 0) &&
          candidate.amountDue > 0,
      )
      .map((candidate) => candidate.debtCycleId),
  );
  return cycles.filter(
    (cycle) =>
      payableCycleIds.has(cycle.id) &&
      Boolean(cycle.groupId) &&
      !cycle.packageSubscriptionId &&
      cycle.cycleType !== "package" &&
      cycle.billingMode !== "package" &&
      cycle.status !== "cancelled" &&
      cycle.status !== "paid",
  );
}

export function hasPayableSessionDebt(
  status: SessionPaymentStatus | null | undefined,
): boolean {
  return getPayableSessionPaymentCandidates(status).length > 0;
}

export function getSessionPaymentUnavailableReason(
  status: SessionPaymentStatus | null | undefined,
  sessionId?: string,
): string | null {
  if (!status) return "تعذر تحميل الموقف المالي للطالب.";
  if (!status.sessionDebt) return "لا تتوفر بيانات رسوم الحصص للفترة الحالية.";

  const candidates = status.sessionDebt.paymentCandidates || [];
  const relevantCandidates = sessionId
    ? candidates.filter((candidate) => candidate.sessionId === sessionId)
    : candidates;
  if (getPayableSessionPaymentCandidates(status, sessionId).length > 0) {
    return null;
  }

  if (relevantCandidates.some((candidate) => candidate.packageCovered)) {
    return "هذه الحصة مغطاة بباقة، ولا تُحصّل لها دفعة حصة مستقلة.";
  }
  const relevantCycleIds = new Set(
    relevantCandidates
      .map((candidate) => candidate.debtCycleId)
      .filter((id): id is string => Boolean(id)),
  );
  const relevantCycles = status.cycles.filter(
    (cycle) =>
      relevantCycleIds.has(cycle.id) &&
      cycle.status !== "cancelled" &&
      cycle.status !== "paid",
  );
  if (
    relevantCycles.length > 0 &&
    relevantCycles.every(
      (cycle) =>
        cycle.cycleType === "package" ||
        cycle.billingMode === "package" ||
        Boolean(cycle.packageSubscriptionId),
    )
  ) {
    return "هذه الرسوم مرتبطة بباقة، ولا تُحصّل كدفعة حصة مستقلة.";
  }
  if (
    relevantCandidates.some(
      (candidate) => !candidate.sessionPrice || candidate.sessionPrice <= 0,
    )
  ) {
    return "سعر الحصة غير محدد للمجموعة. حدّد سعرًا موجبًا في تفاصيل المجموعة أولًا.";
  }
  if (relevantCandidates.length > 0) {
    return "لا يوجد مبلغ مستحق للتحصيل عن هذه الحصة؛ تحقّق من الرصيد وسجل المدفوعات.";
  }

  const periodCycles = status.cycles.filter(
    (cycle) =>
      cycle.startDate <= status.sessionDebt!.periodEnd &&
      cycle.endDate >= status.sessionDebt!.periodStart &&
      cycle.status !== "cancelled" &&
      cycle.status !== "paid",
  );
  const groupCycles = periodCycles.filter(
    (cycle) =>
      Boolean(cycle.groupId) &&
      !cycle.packageSubscriptionId &&
      cycle.cycleType !== "package" &&
      cycle.billingMode !== "package",
  );
  const packageCycles = periodCycles.filter(
    (cycle) =>
      cycle.cycleType === "package" ||
      cycle.billingMode === "package" ||
      Boolean(cycle.packageSubscriptionId),
  );

  if (!groupCycles.length && packageCycles.length > 0) {
    return "هذه الرسوم مرتبطة بباقة، ولا تُحصّل كدفعة حصة مستقلة.";
  }
  if (sessionId && relevantCandidates.length === 0) {
    return "يجب تسجيل حضور الطالب في الجلسة قبل تحصيل رسومها.";
  }
  if (groupCycles.length > 0) {
    return "لا توجد جلسة حضرها الطالب وغير مسددة ضمن دورة فعالة في الفترة الحالية.";
  }
  if (Number(status.currentPeriodDebt || 0) <= 0) {
    return "لا توجد رسوم حصص غير مسددة حاليًا.";
  }
  return "لا توجد دورة فوترة نشطة مرتبطة بحصة مستحقة في هذه الفترة.";
}

export function getSessionPaymentActionState(
  status: SessionPaymentStatus | null | undefined,
  canCreatePayment: boolean,
  isSubmitting: boolean,
  sessionId?: string,
): { disabled: boolean; reason: string | null } {
  const reason = canCreatePayment
    ? getSessionPaymentUnavailableReason(status, sessionId)
    : "ليس لديك صلاحية تسجيل المدفوعات.";
  return {
    disabled: isSubmitting || Boolean(reason),
    reason,
  };
}

export function getConfiguredSessionPrice(
  group: Pick<Group, "sessionPrice"> | null | undefined,
): number | undefined {
  const price = Number(group?.sessionPrice);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}
