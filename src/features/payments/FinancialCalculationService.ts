import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import {
    DebtAdjustment,
    DebtCycle,
    DetailedStudentFinancialStatus,
    PaymentEvent,
    PaymentReversal,
    StudentSubscription,
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { DebtAdjustmentRepository } from "./DebtAdjustmentRepository";
import { DebtCycleRepository } from "./DebtCycleRepository";
import { SessionDebtService } from "./SessionDebtService";

export class FinancialCalculationService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Calculates comprehensive student financial status dynamically from underlying records.
   * NEVER relies on a mutated balance column.
   * - Derives monthly debt strictly from debt cycles, cycle adjustments, and non-reversed monthly payments.
   * - Session payments are strictly isolated and do NOT reduce monthly debt.
   * - Handles backward compatibility with Sprint 1 subscriptions.
   */
  static getStudentFinancialStatus(
    studentId: string,
    targetDate?: string,
  ): DetailedStudentFinancialStatus {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();

    // 1. Ensure debt cycles are up to date for all active enrollments of this student
    const activeEnrollments = db.getAllSync<any>(
      `SELECT id FROM student_group_enrollments WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [centerId, studentId],
    );

    for (const enr of activeEnrollments) {
      DebtCycleRepository.generateCyclesForEnrollment(enr.id, targetDate);
    }

    // Also ensure debt cycles are up to date for all active package subscriptions
    const activePackageSubscriptions = db.getAllSync<any>(
      `SELECT id FROM student_package_subscriptions WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [centerId, studentId],
    );

    for (const sub of activePackageSubscriptions) {
      DebtCycleRepository.generateCyclesForPackageSubscription(
        sub.id,
        targetDate,
      );
    }

    // 2. Fetch all debt cycles for this student
    const rawCycles = DebtCycleRepository.getCyclesForStudent(studentId);

    // 3. Fetch all adjustments for this student
    const adjustments: DebtAdjustment[] =
      DebtAdjustmentRepository.getAdjustmentsForStudent(studentId);

    // 4. Fetch all payments for this student
    const rawPayments = db.getAllSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId, subscription_id as subscriptionId,
              debt_cycle_id as debtCycleId, session_id as sessionId,
              amount, payment_type as paymentType, payment_method as paymentMethod,
              payment_date as paymentDate,
              notes, is_reversed as isReversed, created_at as createdAt,
              user_id as userId, updated_at as updatedAt
       FROM payments
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );

    const payments: PaymentEvent[] = rawPayments.map((p) => {
      const pType = p.paymentType === "cash" ? "session" : p.paymentType;
      const pMethod = p.paymentMethod || "cash";
      return {
        id: p.id,
        operationId: p.operationId,
        centerId: p.centerId,
        studentId: p.studentId,
        subscriptionId: p.subscriptionId || undefined,
        debtCycleId: p.debtCycleId || undefined,
        sessionId: p.sessionId || undefined,
        amount: Number(p.amount) || 0,
        paymentType: pType,
        paymentMethod: pMethod,
        paymentDate: p.paymentDate || p.createdAt?.slice(0, 10),
        notes: p.notes || undefined,
        isReversed: p.isReversed === 1 || p.isReversed === true,
        createdAt: p.createdAt,
        userId: p.userId,
        updatedAt: p.updatedAt || undefined,
      };
    });

    // 5. Fetch all payment reversals for this student
    const reversals = db.getAllSync<PaymentReversal>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              payment_id as paymentId, student_id as studentId,
              reversed_amount as reversedAmount, reason,
              reversed_by as reversedBy, reversed_at as reversedAt,
              created_at as createdAt
       FROM payment_reversals
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );

    // 6. Fetch legacy student_subscriptions (for Sprint 1 backward compatibility)
    const subscriptions = db.getAllSync<StudentSubscription>(
      `SELECT id, center_id as centerId, student_id as studentId, group_id as groupId,
              package_name as packageName, amount_due as amountDue,
              period_start as periodStart, period_end as periodEnd, status
       FROM student_subscriptions
       WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [centerId, studentId],
    );

    // 7. Calculate per-cycle effective price, payments, and remaining debt
    // Separate non-reversed payments:
    const activeMonthlyPayments = payments.filter(
      (p) => !p.isReversed && p.paymentType !== "session" && !p.sessionId,
    );
    const activeSessionPayments = payments.filter(
      (p) => !p.isReversed && (p.paymentType === "session" || !!p.sessionId),
    );

    // Track unassigned payments (payments without debtCycleId), and direct
    // payments by cycle.  A payment can be larger than the cycle it was
    // auto-linked to; any excess must carry forward to the next oldest cycle
    // instead of disappearing as an unrepresented credit.
    let unassignedPool = activeMonthlyPayments
      .filter((p) => !p.debtCycleId)
      .reduce((sum, p) => sum + p.amount, 0);
    const directPaymentsByCycle = new Map<string, number>();
    for (const payment of activeMonthlyPayments) {
      if (!payment.debtCycleId) continue;
      directPaymentsByCycle.set(
        payment.debtCycleId,
        (directPaymentsByCycle.get(payment.debtCycleId) || 0) + payment.amount,
      );
    }

    const enrichedCycles: DebtCycle[] = rawCycles.map((cycle) => {
      const cycleAdjs = adjustments.filter((a) => a.debtCycleId === cycle.id);
      const sumAdjs = cycleAdjs.reduce(
        (acc, a) => acc + (Number(a.adjustmentAmount) || 0),
        0,
      );
      const effectivePrice = Math.max(0, Number(cycle.cyclePrice) + sumAdjs);

      const directPaid = directPaymentsByCycle.get(cycle.id) || 0;

      // Allocate the oldest available money to this cycle.  This preserves
      // explicit cycle targeting, while carrying both unassigned money and
      // overpayments to later cycles.
      const available = directPaid + unassignedPool;
      const paidAmount = Math.min(effectivePrice, available);
      unassignedPool = Math.max(0, available - paidAmount);

      const remainingDebt = Math.max(0, effectivePrice - paidAmount);

      let computedStatus: "open" | "partial" | "paid" = "open";
      if (remainingDebt === 0 && effectivePrice > 0) {
        computedStatus = "paid";
      } else if (paidAmount > 0 && remainingDebt > 0) {
        computedStatus = "partial";
      } else if (effectivePrice === 0) {
        computedStatus = "paid";
      }

      if (computedStatus !== cycle.status) {
        try {
          DebtCycleRepository.updateCycleStatus(cycle.id, computedStatus);
        } catch {
          // ignore status sync update error
        }
      }

      return {
        ...cycle,
        effectivePrice,
        effectiveDue: effectivePrice,
        paidAmount,
        totalPaid: paidAmount,
        remainingDebt,
        status: computedStatus,
      };
    });

    // 8. Separate group cycles and package cycles
    const groupCycles = enrichedCycles.filter((c) => c.cycleType !== "package");
    const packageCycles = enrichedCycles.filter(
      (c) => c.cycleType === "package",
    );

    const groupMonthlyDue = groupCycles.reduce(
      (sum, c) => sum + (c.effectivePrice ?? 0),
      0,
    );
    const groupMonthlyPaid = groupCycles.reduce(
      (sum, c) => sum + (c.paidAmount ?? 0),
      0,
    );
    const groupRemainingDebt = Math.max(0, groupMonthlyDue - groupMonthlyPaid);

    const packageMonthlyDue = packageCycles.reduce(
      (sum, c) => sum + (c.effectivePrice ?? 0),
      0,
    );
    const packageMonthlyPaid = packageCycles.reduce(
      (sum, c) => sum + (c.paidAmount ?? 0),
      0,
    );
    const packageRemainingDebt = Math.max(
      0,
      packageMonthlyDue - packageMonthlyPaid,
    );

    // Total monthly due:
    let monthlyTotalDue = groupMonthlyDue + packageMonthlyDue;

    // If no cycles exist but legacy subscriptions exist (Sprint 1 fallback)
    if (enrichedCycles.length === 0 && subscriptions.length > 0) {
      monthlyTotalDue = subscriptions.reduce(
        (sum, s) => sum + (Number(s.amountDue) || 0),
        0,
      );
    }

    const monthlyTotalPaid = activeMonthlyPayments.reduce(
      (sum, p) => sum + p.amount,
      0,
    );
    const monthlyRemainingDebt =
      enrichedCycles.length > 0
        ? groupRemainingDebt + packageRemainingDebt
        : Math.max(0, monthlyTotalDue - monthlyTotalPaid);
    const totalRemainingDebt = monthlyRemainingDebt;
    const totalDue = monthlyTotalDue;
    const totalPaid = monthlyTotalPaid;
    const remainingBalance = totalRemainingDebt;

    const sessionTotalPaid = activeSessionPayments.reduce(
      (sum, p) => sum + p.amount,
      0,
    );
    const sessionPaymentsTotal = sessionTotalPaid;
    const sessionDebt = SessionDebtService.getCurrentMonthBreakdown(studentId, targetDate);

    const monthlyAdjustments = adjustments.reduce(
      (sum, a) => sum + (Number(a.adjustmentAmount) || 0),
      0,
    );

    return {
      // Legacy / Sprint 1 fields:
      totalDue,
      totalPaid,
      remainingBalance,
      subscriptions,
      payments,

      // Sprint 3 & 4 Financial Core fields:
      monthlyTotalDue,
      monthlyTotalPaid,
      monthlyAdjustments,
      monthlyRemainingDebt,
      totalRemainingDebt,
      sessionTotalPaid,
      sessionPaymentsTotal,
      groupMonthlyDue,
      groupMonthlyPaid,
      groupRemainingDebt,
      packageMonthlyDue,
      packageMonthlyPaid,
      packageRemainingDebt,
      cycles: enrichedCycles,
      adjustments,
      sessionPayments: activeSessionPayments,
      monthlyPayments: activeMonthlyPayments,
      reversals,
      sessionDebt,
      currentPeriodDebt: sessionDebt.currentDebt,
    };
  }

  /**
   * Same financial calculation scoped to one group. This is used by the
   * attendance scanner so a teacher only sees this student's debt for the
   * session/group currently being processed.
   */
  static getStudentFinancialStatusForGroup(
    studentId: string,
    groupId: string,
    targetDate?: string,
  ): DetailedStudentFinancialStatus {
    const full = this.getStudentFinancialStatus(studentId, targetDate);
    const db = DatabaseService.getDb();
    const sessionRows = db.getAllSync<{ id: string }>(
      `SELECT id FROM sessions WHERE center_id = ? AND group_id = ?`,
      [this.getActiveContext().centerId, groupId],
    );
    const sessionIds = new Set(sessionRows.map((row) => row.id));
    const cycles = full.cycles.filter((cycle) => cycle.groupId === groupId);
    const cycleIds = new Set(cycles.map((cycle) => cycle.id));
    const payments = full.payments.filter(
      (payment) =>
        (payment.debtCycleId && cycleIds.has(payment.debtCycleId)) ||
        (payment.sessionId && sessionIds.has(payment.sessionId)),
    );
    const adjustments = full.adjustments.filter((adjustment) =>
      cycleIds.has(adjustment.debtCycleId),
    );
    const monthlyPayments = payments.filter(
      (payment) =>
        !payment.isReversed &&
        payment.paymentType !== "session" &&
        !payment.sessionId,
    );
    const sessionPayments = payments.filter(
      (payment) =>
        !payment.isReversed &&
        (payment.paymentType === "session" || !!payment.sessionId),
    );
    const monthlyTotalDue = cycles.reduce(
      (sum, cycle) => sum + Number(cycle.effectivePrice ?? cycle.cyclePrice ?? 0),
      0,
    );
    // Use the cycle allocation rather than only directly-linked payment rows.
    // An unassigned payment may have been allocated to this group's oldest
    // cycle by the full calculation, so summing `monthlyPayments` alone can
    // incorrectly show zero paid in the group profile.
    const monthlyTotalPaid = cycles.reduce(
      (sum, cycle) => sum + Number(cycle.paidAmount ?? 0),
      0,
    );
    const monthlyAdjustments = adjustments.reduce(
      (sum, adjustment) => sum + Number(adjustment.adjustmentAmount || 0),
      0,
    );
    const sessionTotalPaid = sessionPayments.reduce(
      (sum, payment) => sum + Number(payment.amount || 0),
      0,
    );
    const sessionDebt = SessionDebtService.getCurrentMonthBreakdown(
      studentId,
      targetDate,
      groupId,
    );
    const monthlyRemainingDebt = cycles.reduce(
      (sum, cycle) => sum + Number(cycle.remainingDebt ?? 0),
      0,
    );
    const subscriptions = full.subscriptions.filter(
      (subscription) => subscription.groupId === groupId,
    );
    const reversals = full.reversals.filter((reversal) =>
      payments.some((payment) => payment.id === reversal.paymentId),
    );

    return {
      ...full,
      totalDue: monthlyTotalDue,
      totalPaid: monthlyTotalPaid,
      remainingBalance: monthlyRemainingDebt,
      subscriptions,
      payments,
      monthlyTotalDue,
      monthlyTotalPaid,
      monthlyAdjustments,
      monthlyRemainingDebt,
      totalRemainingDebt: monthlyRemainingDebt,
      sessionTotalPaid,
      sessionPaymentsTotal: sessionTotalPaid,
      groupMonthlyDue: monthlyTotalDue,
      groupMonthlyPaid: monthlyTotalPaid,
      groupRemainingDebt: monthlyRemainingDebt,
      packageMonthlyDue: 0,
      packageMonthlyPaid: 0,
      packageRemainingDebt: 0,
      cycles,
      adjustments,
      sessionPayments,
      monthlyPayments,
      reversals,
      sessionDebt,
      currentPeriodDebt: sessionDebt.currentDebt,
    };
  }
}
