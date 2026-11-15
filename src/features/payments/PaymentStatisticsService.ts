import { DatabaseService } from "../../core/database";
import { DebtCycle, PaymentEvent } from "../../shared/types";
import { isPerSessionBillingMode } from "../../shared/utils/billingMode";
import { getDateOnlyInTimeZone } from "../../shared/utils/date";
import { smartSearch } from "../../shared/utils/smartSearch";
import { useAuthStore } from "../auth/useAuthStore";
import { EnrollmentRepository } from "../enrollments/EnrollmentRepository";
import { StudentRepository } from "../students/StudentRepository";
import { FinancialCalculationService } from "./FinancialCalculationService";
import { getDebtCyclePeriodLabel } from "./paymentPresentation";

export type PaymentCategoryKey = "monthly" | "session" | "partial" | "unpaid";

export interface BasePaymentStatRow {
  studentId: string;
  studentName: string;
  studentCode?: string;
  phone?: string;
}

export interface MonthlyPaymentStatRow extends BasePaymentStatRow {
  amountPaid: number;
  subscriptionLabel: string;
  paymentDate: string;
}

export interface SessionPaymentStatRow extends BasePaymentStatRow {
  amountPaid: number;
  sessionsCount: number | null;
  paymentDate: string;
}

export interface PartialPaymentStatRow extends BasePaymentStatRow {
  originalDue: number;
  amountPaid: number;
  remainingBalance: number;
}

export interface UnpaidStatRow extends BasePaymentStatRow {
  originalDue: number;
  remainingBalance: number;
}

export interface GroupPaymentStatistics {
  groupId: string;
  reportDate: string;
  categories: {
    monthly: MonthlyPaymentStatRow[];
    session: SessionPaymentStatRow[];
    partial: PartialPaymentStatRow[];
    unpaid: UnpaidStatRow[];
  };
  counts: {
    monthly: number;
    session: number;
    partial: number;
    unpaid: number;
  };
}

export function getCairoTodayDateOnly(now: Date = new Date()): string {
  return getDateOnlyInTimeZone(now, "Africa/Cairo");
}

function getEffectiveDateOnly(value?: string | null): string {
  if (!value) return "";
  return String(value).trim().slice(0, 10);
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function maxDateOnly(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Derives group payment statistics as of a specific reporting date using the
 * existing FinancialCalculationService rules and underlying ledger records.
 *
 * - Never classifies payments by amount alone (uses obligation/cycle & paymentType).
 * - Excludes payment requests from monthly/session categories.
 * - Filters obligations and payments by <= reportDate for historical accuracy.
 * - Aggregates per student within each category to prevent duplicate counting.
 */
export class PaymentStatisticsService {
  static getGroupPaymentStatistics(
    groupId: string,
    reportDate: string = getCairoTodayDateOnly(),
  ): GroupPaymentStatistics {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) {
      throw new Error("يجب تحديد السنتر أولاً.");
    }

    const normalizedDate = getEffectiveDateOnly(reportDate) || getCairoTodayDateOnly();
    const db = DatabaseService.getDb();

    // 1. Gather unique candidate students for this group as of reportDate:
    //    - Active enrollments on reportDate
    //    - Active package subscriptions scoped to this group
    //    - Any student with a non-reversed session payment for this group up to reportDate
    const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(
      groupId,
      normalizedDate,
    );

    const packageCandidates = db.getAllSync<{ studentId: string }>(
      `SELECT DISTINCT sps.student_id as studentId
       FROM student_package_subscriptions sps
       JOIN package_subjects ps ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id AND selected.subscription_id = sps.id AND selected.subject_id = ps.subject_id
       WHERE sps.center_id = ? AND sps.status = 'active'
         AND ps.subject_id = (SELECT subject_id FROM groups WHERE center_id = ? AND id = ?)
         AND (ps.group_id IS NULL OR ps.group_id = ?)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = (SELECT teacher_id FROM groups WHERE center_id = ? AND id = ?)
         AND (selected.id IS NULL OR selected.group_id IS NULL OR selected.group_id = ?)
         AND (selected.id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM package_subject_teacher_overrides any_selection
           WHERE any_selection.center_id = sps.center_id AND any_selection.subscription_id = sps.id
         ))`,
      [activeCenterId, activeCenterId, groupId, groupId, activeCenterId, groupId, groupId],
    );

    const sessionPaymentCandidates = db.getAllSync<{ studentId: string }>(
      `SELECT DISTINCT p.student_id as studentId
       FROM payments p
       JOIN sessions s ON s.id = p.session_id AND s.center_id = p.center_id
       WHERE p.center_id = ? AND s.group_id = ? AND p.is_reversed = 0 AND p.payment_type = 'session'
         AND COALESCE(NULLIF(substr(p.payment_date, 1, 10), ''), substr(p.created_at, 1, 10)) <= ?`,
      [activeCenterId, groupId, normalizedDate],
    );

    const studentIds = new Set<string>([
      ...enrollments.map((e) => String(e.studentId)),
      ...packageCandidates.map((p) => String(p.studentId)),
      ...sessionPaymentCandidates.map((s) => String(s.studentId)),
    ]);

    const monthlyRows: MonthlyPaymentStatRow[] = [];
    const sessionRows: SessionPaymentStatRow[] = [];
    const partialRows: PartialPaymentStatRow[] = [];
    const unpaidRows: UnpaidStatRow[] = [];

    for (const studentId of studentIds) {
      const student = StudentRepository.findById(studentId);
      if (!student) continue;

      const groupStatus = FinancialCalculationService.getStudentFinancialStatusForGroup(
        student.id,
        groupId,
        normalizedDate,
      );

      const baseInfo: BasePaymentStatRow = {
        studentId: student.id,
        studentName: student.fullName,
        studentCode: student.studentCode,
        phone: student.phone,
      };

      const perSessionCycleIds = new Set(
        groupStatus.cycles
          .filter((cycle) => isPerSessionBillingMode(cycle.billingMode, cycle.cycleType))
          .map((cycle) => cycle.id),
      );

      // Filter cycles that existed/started on or before reportDate and are real obligations
      const eligibleCycles: DebtCycle[] = groupStatus.cycles
        .filter((cycle) => {
          if (cycle.status === "cancelled") return false;
          if (perSessionCycleIds.has(cycle.id)) return false;
          const startDate = getEffectiveDateOnly(cycle.startDate);
          return !startDate || startDate <= normalizedDate;
        })
        .sort((a, b) => {
          const dateCmp = getEffectiveDateOnly(a.startDate).localeCompare(
            getEffectiveDateOnly(b.startDate),
          );
          if (dateCmp !== 0) return dateCmp;
          return (Number(a.cycleNumber) || 0) - (Number(b.cycleNumber) || 0);
        });

      // Filter non-reversed payments recorded on or before reportDate
      const paymentsAsOfDate: PaymentEvent[] = groupStatus.payments.filter((payment) => {
        if (payment.isReversed) return false;
        const pDate = getEffectiveDateOnly(payment.paymentDate || payment.createdAt);
        return !pDate || pDate <= normalizedDate;
      });

      const monthlyPaymentsAsOfDate = paymentsAsOfDate.filter(
        (payment) =>
          payment.paymentType !== "session" &&
          payment.paymentType !== "payment_request" &&
          !payment.paymentRequestObligationId &&
          (!payment.debtCycleId || !perSessionCycleIds.has(payment.debtCycleId)) &&
          (!!payment.debtCycleId || !payment.sessionId),
      );

      const sessionPaymentsAsOfDate = paymentsAsOfDate.filter(
        (payment) => payment.paymentType === "session",
      );

      // 2. Session category (strictly by paymentType === 'session', regardless of amount)
      if (sessionPaymentsAsOfDate.length > 0) {
        const distinctSessionIds = new Set<string>();
        let withoutSessionIdCount = 0;
        let totalSessionPaid = 0;
        let latestSessionPayDate = "";

        for (const p of sessionPaymentsAsOfDate) {
          totalSessionPaid += Number(p.amount) || 0;
          if (p.sessionId) {
            distinctSessionIds.add(p.sessionId);
          } else {
            withoutSessionIdCount += 1;
          }
          latestSessionPayDate = maxDateOnly(
            latestSessionPayDate,
            getEffectiveDateOnly(p.paymentDate || p.createdAt),
          );
        }

        const totalCovered =
          distinctSessionIds.size > 0
            ? distinctSessionIds.size + withoutSessionIdCount
            : sessionPaymentsAsOfDate.length;

        sessionRows.push({
          ...baseInfo,
          amountPaid: roundMoney(totalSessionPaid),
          sessionsCount: totalCovered > 0 ? totalCovered : null,
          paymentDate: latestSessionPayDate || normalizedDate,
        });
      }

      // 3. Allocate monthly payments (and session payments explicitly linked to monthly cycles)
      //    across eligibleCycles using the same oldest-first + direct-link rules.
      const eligibleCycleIds = new Set(eligibleCycles.map((c) => c.id));
      const directByCycle = new Map<string, { amount: number; latestDate: string; hasMonthlyPayment: boolean }>();
      let unassignedPool = 0;
      let latestUnassignedDate = "";

      for (const p of monthlyPaymentsAsOfDate) {
        const pDate = getEffectiveDateOnly(p.paymentDate || p.createdAt);
        if (p.debtCycleId && eligibleCycleIds.has(p.debtCycleId)) {
          const prev = directByCycle.get(p.debtCycleId) || {
            amount: 0,
            latestDate: "",
            hasMonthlyPayment: false,
          };
          directByCycle.set(p.debtCycleId, {
            amount: prev.amount + (Number(p.amount) || 0),
            latestDate: maxDateOnly(prev.latestDate, pDate),
            hasMonthlyPayment: true,
          });
        } else if (!p.debtCycleId) {
          unassignedPool += Number(p.amount) || 0;
          latestUnassignedDate = maxDateOnly(latestUnassignedDate, pDate);
        }
      }

      for (const p of sessionPaymentsAsOfDate) {
        if (p.debtCycleId && eligibleCycleIds.has(p.debtCycleId)) {
          const pDate = getEffectiveDateOnly(p.paymentDate || p.createdAt);
          const prev = directByCycle.get(p.debtCycleId) || {
            amount: 0,
            latestDate: "",
            hasMonthlyPayment: false,
          };
          directByCycle.set(p.debtCycleId, {
            amount: prev.amount + (Number(p.amount) || 0),
            latestDate: maxDateOnly(prev.latestDate, pDate),
            hasMonthlyPayment: prev.hasMonthlyPayment,
          });
        }
      }

      let settledMonthlyPaid = 0;
      let settledCycleCount = 0;
      let latestSettledLabel = "";
      let latestSettledDate = "";
      let hasConfirmedMonthlyInSettled = false;

      let partialDue = 0;
      let partialPaid = 0;
      let partialRemaining = 0;

      let unpaidDue = 0;
      let unpaidRemaining = 0;

      for (const cycle of eligibleCycles) {
        const effectivePrice = roundMoney(
          Math.max(0, Number(cycle.effectivePrice ?? cycle.cyclePrice ?? 0)),
        );
        if (effectivePrice <= 0) {
          // Free / 100%-exempt enrollment: no obligation due, never classify as unpaid/partial.
          continue;
        }

        const direct = directByCycle.get(cycle.id);
        const directAmount = direct?.amount || 0;
        const available = directAmount + unassignedPool;
        const paidAmount = roundMoney(Math.min(effectivePrice, available));
        const usedFromPool = Math.max(0, paidAmount - directAmount);
        unassignedPool = Math.max(0, available - paidAmount);
        const remainingDebt = roundMoney(Math.max(0, effectivePrice - paidAmount));

        if (remainingDebt <= 0.000001 && paidAmount > 0) {
          const cyclePayDate = maxDateOnly(
            direct?.latestDate || "",
            usedFromPool > 0 ? latestUnassignedDate : "",
          );
          if (direct?.hasMonthlyPayment || usedFromPool > 0) {
            hasConfirmedMonthlyInSettled = true;
          }
          settledMonthlyPaid += paidAmount;
          settledCycleCount += 1;
          latestSettledLabel =
            cycle.cycleType === "package"
              ? `اشتراك باقة${getDebtCyclePeriodLabel(cycle) ? ` · ${getDebtCyclePeriodLabel(cycle)}` : ""}`
              : getDebtCyclePeriodLabel(cycle) || "اشتراك شهري";
          latestSettledDate = maxDateOnly(latestSettledDate, cyclePayDate);
        } else if (paidAmount > 0 && remainingDebt > 0.000001) {
          partialDue += effectivePrice;
          partialPaid += paidAmount;
          partialRemaining += remainingDebt;
        } else if (paidAmount <= 0 && remainingDebt > 0.000001) {
          unpaidDue += effectivePrice;
          unpaidRemaining += remainingDebt;
        }
      }

      if (settledCycleCount > 0 && hasConfirmedMonthlyInSettled) {
        monthlyRows.push({
          ...baseInfo,
          amountPaid: roundMoney(settledMonthlyPaid),
          subscriptionLabel:
            settledCycleCount > 1
              ? `${latestSettledLabel} (${settledCycleCount} دورات)`
              : latestSettledLabel,
          paymentDate: latestSettledDate || normalizedDate,
        });
      }

      if (partialRemaining > 0.000001) {
        partialRows.push({
          ...baseInfo,
          originalDue: roundMoney(partialDue),
          amountPaid: roundMoney(partialPaid),
          remainingBalance: roundMoney(partialRemaining),
        });
      }

      if (unpaidRemaining > 0.000001) {
        unpaidRows.push({
          ...baseInfo,
          originalDue: roundMoney(unpaidDue),
          remainingBalance: roundMoney(unpaidRemaining),
        });
      }
    }

    const byName = (a: BasePaymentStatRow, b: BasePaymentStatRow) =>
      a.studentName.localeCompare(b.studentName, "ar");

    monthlyRows.sort(byName);
    sessionRows.sort(byName);
    partialRows.sort(byName);
    unpaidRows.sort(byName);

    return {
      groupId,
      reportDate: normalizedDate,
      categories: {
        monthly: monthlyRows,
        session: sessionRows,
        partial: partialRows,
        unpaid: unpaidRows,
      },
      counts: {
        monthly: monthlyRows.length,
        session: sessionRows.length,
        partial: partialRows.length,
        unpaid: unpaidRows.length,
      },
    };
  }

  static getComparableAmount(
    row: MonthlyPaymentStatRow | SessionPaymentStatRow | PartialPaymentStatRow | UnpaidStatRow,
    category: PaymentCategoryKey,
  ): number {
    if (category === "monthly" || category === "session") {
      return (row as MonthlyPaymentStatRow | SessionPaymentStatRow).amountPaid;
    }
    return (row as PartialPaymentStatRow | UnpaidStatRow).remainingBalance;
  }

  static filterRows<
    T extends MonthlyPaymentStatRow | SessionPaymentStatRow | PartialPaymentStatRow | UnpaidStatRow,
  >(
    rows: T[],
    category: PaymentCategoryKey,
    searchQuery: string,
    minAmountStr: string,
    maxAmountStr: string,
  ): T[] {
    const searched = searchQuery.trim()
      ? smartSearch(rows, searchQuery, [
          { get: (r) => r.studentName, weight: 3 },
          { get: (r) => r.studentCode, weight: 2 },
          { get: (r) => r.phone },
        ])
      : rows;

    const min = minAmountStr.trim() === "" ? null : Number(minAmountStr);
    const max = maxAmountStr.trim() === "" ? null : Number(maxAmountStr);
    const hasMin = min !== null && Number.isFinite(min);
    const hasMax = max !== null && Number.isFinite(max);

    if (!hasMin && !hasMax) return searched;

    return searched.filter((row) => {
      const amount = this.getComparableAmount(row, category);
      if (hasMin && amount < (min as number)) return false;
      if (hasMax && amount > (max as number)) return false;
      return true;
    });
  }
}
