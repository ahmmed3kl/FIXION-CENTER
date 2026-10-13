import { DebtCycle, PaymentEvent } from "../../shared/types";

export function getDebtCyclePeriodLabel(cycle: Pick<DebtCycle, "startDate" | "endDate">): string | undefined {
  const startDate = cycle.startDate?.slice(0, 10);
  const endDate = cycle.endDate?.slice(0, 10);
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return undefined;
  }

  const formatDate = (value: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("ar-EG", { ...options, timeZone: "UTC" }).format(
      new Date(`${value}T12:00:00Z`),
    );
  if (startDate.slice(0, 7) === endDate.slice(0, 7)) {
    return formatDate(startDate, { month: "long", year: "numeric" });
  }
  return `من ${formatDate(startDate, { day: "numeric", month: "short", year: "numeric" })} إلى ${formatDate(endDate, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function getPaymentDescription(
  payment: Pick<PaymentEvent, "paymentType" | "debtCycleId">,
  cycle?: Pick<DebtCycle, "cycleType" | "startDate" | "endDate">,
): { title: string; period?: string } {
  if (payment.paymentType === "session") return { title: "رسوم حصة" };
  const period = cycle ? getDebtCyclePeriodLabel(cycle) : undefined;
  if (cycle?.cycleType === "package") {
    return { title: "دفعة باقة", period };
  }
  if (payment.paymentType === "monthly" || payment.paymentType === "full") {
    return { title: "اشتراك شهري", period };
  }
  return { title: "دفعة جزئية", period };
}
