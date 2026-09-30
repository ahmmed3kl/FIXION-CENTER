import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { PaymentEvent } from "../../shared/types";
import { getLocalDateOnly } from "../../shared/utils/date";
import { useAuthStore } from "../auth/useAuthStore";
import { DebtCycleRepository } from "./DebtCycleRepository";
import { PaymentRepository } from "./PaymentRepository";

/**
 * Mid-term onboarding workflow.
 *
 * Existing students keep their original billing anchor. We create one
 * opening debt cycle for the current period and record the amount already
 * paid as a normal payment event. New students continue using the regular
 * enrollment/package flow and do not use this service.
 */
export class OpeningBalanceService {
  static async importCurrentPeriod(params: {
    studentId: string;
    enrollmentId?: string;
    packageSubscriptionId?: string;
    packageId?: string;
    groupId?: string;
    cycleType: "monthly" | "package" | "per_session";
    periodStart: string;
    periodEnd: string;
    amountDue: number;
    amountPaid?: number;
    notes?: string;
  }): Promise<{ cycleId: string; payment?: PaymentEvent }> {
    const user = useAuthStore.getState().currentUser;
    if (!user || !PermissionService.hasPermission(resolveUserPermissions(user), "payments.adjust")) {
      throw new Error("ليس لديك صلاحية ترحيل الرصيد الافتتاحي.");
    }
    const due = Number(params.amountDue);
    const paid = Number(params.amountPaid || 0);
    if (!Number.isFinite(due) || due < 0) throw new Error("المديونية الحالية غير صحيحة.");
    if (!Number.isFinite(paid) || paid < 0 || paid > due) throw new Error("المدفوع حتى بداية النظام غير صحيح.");

    const cycle = await DebtCycleRepository.createOpeningCycle(params);
    let payment: PaymentEvent | undefined;
    if (paid > 0) {
      payment = await PaymentRepository.recordPayment({
        studentId: params.studentId,
        amount: paid,
        paymentType: paid >= due ? "monthly" : "partial",
        debtCycleId: cycle.id,
        subscriptionId: params.packageSubscriptionId,
        paymentDate: getLocalDateOnly(),
        notes: params.notes ? `رصيد افتتاحي: ${params.notes}` : "دفعة سابقة قبل تشغيل النظام",
      });
    }
    return { cycleId: cycle.id, payment };
  }
}

