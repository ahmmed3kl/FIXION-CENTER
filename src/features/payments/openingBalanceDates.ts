import { getLocalDateOnly } from "../../shared/utils/date";

export function addOpeningBalanceMonth(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  date.setDate(date.getDate() - 1);
  return Number.isFinite(date.getTime()) ? getLocalDateOnly(date) : value;
}

export function getOpeningBalanceDateDefaults(now: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const periodStart = getLocalDateOnly(now);
  return {
    periodStart,
    periodEnd: addOpeningBalanceMonth(periodStart),
  };
}
