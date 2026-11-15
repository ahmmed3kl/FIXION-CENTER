import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import {
    DetailedStudentFinancialStatus,
    PaymentEvent,
    PaymentReversal,
} from "../../shared/types";
import { isValidIsoDate } from "../../shared/utils/validation";
import { useAuthStore } from "../auth/useAuthStore";
import { SessionDateService } from "../sessions/SessionDateService";
import { FinancialCalculationService } from "./FinancialCalculationService";
import {
  getPayableSessionPaymentCandidates,
  getSessionPaymentUnavailableReason,
  isSessionPaymentCycle,
} from "./paymentEligibility";
import { isPerSessionBillingMode } from "../../shared/utils/billingMode";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class PaymentRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز لإتمام العمليات المالية.",
      );
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Calculates student financial status dynamically from underlying records.
   * Delegates to FinancialCalculationService.
   */
  static getStudentFinancialStatus(
    studentId: string,
    targetDate?: string,
  ): DetailedStudentFinancialStatus {
    return FinancialCalculationService.getStudentFinancialStatus(
      studentId,
      targetDate,
    );
  }

  static getStudentFinancialStatusForGroup(
    studentId: string,
    groupId: string,
    targetDate?: string,
  ): DetailedStudentFinancialStatus {
    return FinancialCalculationService.getStudentFinancialStatusForGroup(
      studentId,
      groupId,
      targetDate,
    );
  }

  /**
   * Fetches all payments for a student in the active center.
   */
  static getPaymentsForStudent(studentId: string): PaymentEvent[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId, subscription_id as subscriptionId,
              debt_cycle_id as debtCycleId, session_id as sessionId,
              payment_request_obligation_id as paymentRequestObligationId,
              payment_request_id as paymentRequestId,
              amount, payment_type as paymentType, payment_method as paymentMethod,
              payment_date as paymentDate,
              notes, is_reversed as isReversed, created_at as createdAt,
              user_id as userId, updated_at as updatedAt
       FROM payments
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );

    return rows.map((p) => ({
      id: p.id,
      operationId: p.operationId,
      centerId: p.centerId,
      studentId: p.studentId,
      subscriptionId: p.subscriptionId || undefined,
      debtCycleId: p.debtCycleId || undefined,
      sessionId: p.sessionId || undefined,
      paymentRequestObligationId: p.paymentRequestObligationId || undefined,
      paymentRequestId: p.paymentRequestId || undefined,
      amount: Number(p.amount) || 0,
      paymentType: p.paymentType === "cash" ? "session" : p.paymentType,
      paymentMethod: p.paymentMethod || "cash",
      paymentDate: p.paymentDate || p.createdAt?.slice(0, 10),
      notes: p.notes || undefined,
      isReversed: p.isReversed === 1 || p.isReversed === true,
      createdAt: p.createdAt,
      userId: p.userId,
      updatedAt: p.updatedAt || undefined,
    }));
  }

  /**
   * Fetches all payment reversals for a student in the active center.
   */
  static getReversalsForStudent(studentId: string): PaymentReversal[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<PaymentReversal>(
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
  }

  /**
   * Records an immutable payment event with operation_id for idempotency,
   * adds to sync_operations, and writes to audit_logs.
   * Payment types: 'monthly', 'partial', 'session', 'payment_request'.
   */
  static async recordPayment(params: {
    studentId: string;
    amount: number;
    paymentType?: "monthly" | "partial" | "session" | "full" | "payment_request";
    paymentMethod?: string;
    debtCycleId?: string;
    sessionId?: string;
    subscriptionId?: string;
    paymentRequestObligationId?: string;
    paymentRequestId?: string;
    paymentDate?: string;
    notes?: string;
    operationId?: string;
    allowCreditBalance?: boolean;
  }): Promise<PaymentEvent> {
    return this.recordPaymentSync(params);
  }

  private static recordPaymentSync(
    params: Parameters<typeof PaymentRepository.recordPayment>[0],
  ): PaymentEvent {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل المدفوعات.");
    }

    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      throw new ValidationError("مبلغ الدفعة يجب أن يكون أكبر من صفر.");
    }
    const roundedAmount = Math.round(params.amount * 100) / 100;
    if (Math.abs(params.amount - roundedAmount) > 0.000001) {
      throw new ValidationError("مبلغ الدفعة يجب ألا يتجاوز منزلتين عشريتين.");
    }
    const db = DatabaseService.getDb();
    const operationId = params.operationId || `op-pay-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const createdAt = new Date().toISOString();
    const paymentDate =
      params.paymentDate || SessionDateService.getCurrentSessionDate(centerId);
    if (!isValidIsoDate(paymentDate)) {
      throw new ValidationError("تاريخ الدفع غير صحيح.");
    }
    const paymentMethod = params.paymentMethod || "cash";

    // Normalize payment type: 'full' in legacy calls maps to 'monthly'
    let normType: "monthly" | "partial" | "session" | "payment_request" = "partial";
    if (
      params.paymentType === "payment_request" ||
      Boolean(params.paymentRequestObligationId)
    ) {
      normType = "payment_request";
    } else if (params.paymentType === "session") {
      normType = "session";
    } else if (
      params.paymentType === "monthly" ||
      params.paymentType === "full"
    ) {
      normType = "monthly";
    } else if (params.paymentType === "partial") {
      normType = "partial";
    }
    if (params.allowCreditBalance && (normType === "session" || normType === "payment_request")) {
      throw new ValidationError("الرصيد المقدم يُسجل كدفعة شهرية أو جزئية، وليس كدفعة حصة.");
    }

    const existingPayment = db.getFirstSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId, subscription_id as subscriptionId,
              debt_cycle_id as debtCycleId, session_id as sessionId,
              payment_request_obligation_id as paymentRequestObligationId,
              payment_request_id as paymentRequestId,
              amount, payment_type as paymentType, payment_method as paymentMethod,
              payment_date as paymentDate, notes, is_reversed as isReversed,
              created_at as createdAt, user_id as userId, updated_at as updatedAt
       FROM payments WHERE operation_id = ?`,
      [operationId],
    );
    if (existingPayment) {
      const existingType = existingPayment.paymentType === "cash"
        ? "session"
        : existingPayment.paymentType;
      if (
        existingPayment.centerId !== centerId ||
        existingPayment.studentId !== params.studentId ||
        Number(existingPayment.amount) !== params.amount ||
        existingType !== normType ||
        (existingPayment.sessionId || undefined) !== (params.sessionId || undefined) ||
        (existingPayment.paymentRequestObligationId || undefined) !==
          (params.paymentRequestObligationId || undefined) ||
        (params.debtCycleId && existingPayment.debtCycleId !== params.debtCycleId)
      ) {
        throw new ConflictError("معرّف العملية مستخدم لدفعة ببيانات مختلفة.");
      }
      FinancialCalculationService.getStudentFinancialStatus(
        params.studentId,
        existingPayment.paymentDate,
      );
      return {
        id: existingPayment.id,
        operationId: existingPayment.operationId,
        centerId: existingPayment.centerId,
        studentId: existingPayment.studentId,
        subscriptionId: existingPayment.subscriptionId || undefined,
        debtCycleId: existingPayment.debtCycleId || undefined,
        sessionId: existingPayment.sessionId || undefined,
        paymentRequestObligationId:
          existingPayment.paymentRequestObligationId || undefined,
        paymentRequestId: existingPayment.paymentRequestId || undefined,
        amount: Number(existingPayment.amount) || 0,
        paymentType: existingType,
        paymentMethod: existingPayment.paymentMethod || "cash",
        paymentDate: existingPayment.paymentDate,
        notes: existingPayment.notes || undefined,
        isReversed: existingPayment.isReversed === 1 || existingPayment.isReversed === true,
        createdAt: existingPayment.createdAt,
        userId: existingPayment.userId,
        updatedAt: existingPayment.updatedAt || undefined,
      };
    }

    if (normType === "payment_request") {
      if (!params.paymentRequestObligationId) {
        throw new ValidationError("يجب تحديد مطالبة الدفع الخاصة بالطالب.");
      }
      const obligation = db.getFirstSync<any>(
        `SELECT id, center_id as centerId, request_id as requestId,
                group_id as groupId, student_id as studentId,
                amount_due as amountDue, amount_paid as amountPaid,
                status, payment_id as paymentId
         FROM student_payment_request_obligations
         WHERE center_id = ? AND id = ?`,
        [centerId, params.paymentRequestObligationId],
      );
      if (!obligation) {
        throw new NotFoundError("المطالبة المالية للطالب غير موجودة في هذا المركز.");
      }
      if (obligation.studentId !== params.studentId) {
        throw new ValidationError("المطالبة المالية لا تخص هذا الطالب.");
      }
      const parentRequest = db.getFirstSync<any>(
        `SELECT id, name, status, reference_month as referenceMonth
         FROM group_payment_requests
         WHERE center_id = ? AND id = ?`,
        [centerId, obligation.requestId],
      );
      if (!parentRequest) {
        throw new NotFoundError("متطلب الدفع غير موجود.");
      }
      if (parentRequest.status === "archived" || obligation.status === "cancelled") {
        throw new ValidationError("لا يمكن تسجيل دفعة لمطالبة ملغاة أو مؤرشفة.");
      }
      const paymentId = `pay-${generateUUID()}`;
      const paymentNotes =
        [
          `سداد متطلب: ${parentRequest.name}`,
          parentRequest.referenceMonth ? `(${parentRequest.referenceMonth})` : "",
          params.notes?.trim() || "",
        ]
          .filter(Boolean)
          .join(" • ") || undefined;

      const paymentEvent: PaymentEvent = {
        id: paymentId,
        operationId,
        centerId,
        studentId: params.studentId,
        paymentRequestObligationId: obligation.id,
        paymentRequestId: obligation.requestId,
        amount: params.amount,
        paymentType: "payment_request",
        paymentMethod,
        paymentDate,
        notes: paymentNotes,
        isReversed: false,
        createdAt,
        userId: user.id,
      };

      DatabaseService.runInTransaction(() => {
        const latestOb = db.getFirstSync<any>(
          `SELECT status, amount_due as amountDue
           FROM student_payment_request_obligations
           WHERE center_id = ? AND id = ?`,
          [centerId, obligation.id],
        );
        if (!latestOb) {
          throw new NotFoundError("المطالبة المالية غير موجودة.");
        }
        if (latestOb.status === "cancelled") {
          throw new ValidationError("لا يمكن تسجيل دفعة لمطالبة ملغاة.");
        }

        const existingObligationPayments = db.getAllSync<any>(
          `SELECT id, operation_id as operationId, amount, is_reversed as isReversed
           FROM payments
           WHERE center_id = ? AND payment_request_obligation_id = ? AND is_reversed = 0`,
          [centerId, obligation.id],
        );
        const seenPaymentKeys = new Set<string>();
        let confirmedPaidSoFar = 0;
        for (const p of existingObligationPayments) {
          if (p.isReversed === 1 || p.isReversed === true) continue;
          const key = String(p.operationId || p.operation_id || p.id);
          if (seenPaymentKeys.has(key)) continue;
          seenPaymentKeys.add(key);
          confirmedPaidSoFar += Number(p.amount) || 0;
        }
        confirmedPaidSoFar = Math.round(confirmedPaidSoFar * 100) / 100;

        const expectedDue = Math.round((Number(latestOb.amountDue) || 0) * 100) / 100;
        const remainingDue = Math.round(Math.max(0, expectedDue - confirmedPaidSoFar) * 100) / 100;
        if (remainingDue <= 0.000001) {
          throw new ConflictError("تم سداد هذه المطالبة مسبقًا لهذا الطالب.");
        }
        if (params.amount > remainingDue + 0.000001) {
          throw new ValidationError(
            `مبلغ الدفعة (${params.amount}) يتجاوز قيمة المطالبة المستحقة المتبقية (${remainingDue}).`,
          );
        }

        const newTotalPaid =
          Math.round(Math.min(expectedDue, confirmedPaidSoFar + params.amount) * 100) / 100;
        const newObligationStatus =
          newTotalPaid >= expectedDue - 0.000001 ? "paid" : "unpaid";
        const newPaidAt = newObligationStatus === "paid" ? createdAt : null;

        db.runSync(
          `INSERT INTO payments (id, operation_id, center_id, student_id, subscription_id, debt_cycle_id, session_id, payment_request_obligation_id, payment_request_id, amount, payment_type, payment_method, payment_date, notes, is_reversed, created_at, user_id)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            paymentId,
            operationId,
            centerId,
            params.studentId,
            obligation.id,
            obligation.requestId,
            params.amount,
            "payment_request",
            paymentMethod,
            paymentDate,
            paymentNotes || null,
            createdAt,
            user.id,
          ],
        );
        if (newObligationStatus === "paid") {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'paid', amount_paid = ?, payment_id = ?, paid_at = ?, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [newTotalPaid, paymentId, createdAt, createdAt, centerId, obligation.id],
          );
        } else {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'unpaid', amount_paid = ?, payment_id = ?, paid_at = NULL, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [newTotalPaid, paymentId, createdAt, centerId, obligation.id],
          );
        }
        SyncRepository.enqueueOperation({
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment.create",
          entityType: "payment",
          entityId: paymentId,
          payload: paymentEvent,
          operationId,
        });
        SyncRepository.enqueueOperation({
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment_request_obligation.pay",
          entityType: "payment_request_obligation",
          entityId: obligation.id,
          payload: {
            id: obligation.id,
            centerId,
            requestId: obligation.requestId,
            studentId: params.studentId,
            paymentId,
            amountPaid: newTotalPaid,
            status: newObligationStatus,
            paidAt: newPaidAt,
            updatedAt: createdAt,
          },
          operationId: `${operationId}-ob`,
        });
        AuditService.recordEvent({
          operationId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "payment",
          entityId: paymentId,
          action: "payment.record",
          payload: {
            studentId: params.studentId,
            amount: params.amount,
            paymentType: "payment_request",
            paymentRequestId: obligation.requestId,
            paymentRequestObligationId: obligation.id,
            requestName: parentRequest.name,
            notes: paymentNotes || null,
            actorName: user.fullName,
          },
        });
        DatabaseService.notifyLocalChange({
          centerId,
          entityType: "payment_request_obligation",
          entityId: obligation.id,
        });
        DatabaseService.notifyLocalChange({
          centerId,
          entityType: "payment",
          entityId: paymentId,
        });
      });

      FinancialCalculationService.getStudentFinancialStatus(
        params.studentId,
        paymentDate,
      );
      return paymentEvent;
    }

    let paymentSessionGroupId: string | undefined;
    let paymentSessionDate: string | undefined;
    let paymentSessionPrice: number | undefined;
    if (params.sessionId) {
      const session = db.getFirstSync<{
        id: string;
        groupId: string;
        sessionDate: string;
        status: string;
      }>(
        `SELECT id, group_id as groupId, session_date as sessionDate, status
         FROM sessions WHERE center_id = ? AND id = ?`,
        [centerId, params.sessionId],
      );
      if (!session) {
        throw new ValidationError("جلسة الحضور غير موجودة في هذا السنتر.");
      }
      if (session.status === "cancelled") {
        throw new ValidationError("لا يمكن تسجيل دفعة لحصة ملغاة.");
      }
      paymentSessionGroupId = session.groupId;
      paymentSessionDate = session.sessionDate;
      const group = db.getFirstSync<{ sessionPrice?: number }>(
        `SELECT session_price as sessionPrice
         FROM groups WHERE center_id = ? AND id = ?`,
        [centerId, paymentSessionGroupId],
      );
      const configuredPrice = Number(group?.sessionPrice);
      if (Number.isFinite(configuredPrice) && configuredPrice > 0) {
        paymentSessionPrice = configuredPrice;
      }
      if (normType === "session" && !paymentSessionPrice) {
        throw new ValidationError(
          "سعر الحصة غير محدد للمجموعة. حدّد سعرًا موجبًا في تفاصيل المجموعة أولًا.",
        );
      }
    }

    const paymentId = `pay-${generateUUID()}`;

    // Auto-link debtCycleId for monthly/partial payments if not explicitly provided
    let assignedCycleId = params.debtCycleId || null;
    if (!assignedCycleId && normType !== "session") {
      const openCycles = db.getAllSync<any>(
        params.subscriptionId
          ? `SELECT id FROM debt_cycles
             WHERE center_id = ? AND student_id = ?
               AND package_subscription_id = ? AND status NOT IN ('paid', 'cancelled')
             ORDER BY start_date ASC`
          : `SELECT id FROM debt_cycles
             WHERE center_id = ? AND student_id = ?
               AND status NOT IN ('paid', 'cancelled')
               AND NOT (billing_mode = 'per_session'
                        OR (COALESCE(billing_mode, '') = '' AND cycle_type = 'per_session'))
             ORDER BY start_date ASC`,
        params.subscriptionId
          ? [centerId, params.studentId, params.subscriptionId]
          : [centerId, params.studentId],
      );
      if (openCycles.length > 0) {
        assignedCycleId = openCycles[0].id;
      }
    }
    if (!assignedCycleId && normType === "session" && params.sessionId) {
      const sessionCycle = db.getFirstSync<{ id: string }>(
        `SELECT id FROM debt_cycles
         WHERE center_id = ? AND student_id = ? AND group_id = ?
           AND start_date <= ? AND end_date >= ?
           AND status NOT IN ('cancelled', 'paid')
           AND package_subscription_id IS NULL
           AND COALESCE(cycle_type, '') <> 'package'
           AND COALESCE(billing_mode, '') <> 'package'
         ORDER BY start_date DESC LIMIT 1`,
        [
          centerId,
          params.studentId,
          paymentSessionGroupId,
          paymentSessionDate,
          paymentSessionDate,
        ],
      );
      assignedCycleId = sessionCycle?.id || null;
    }
    // Legacy profile payments without a concrete session remain supported
    // only for cycles whose actual billing mode is per-session.
    if (!assignedCycleId && normType === "session" && !params.sessionId) {
      const perSessionCycleQuery = `SELECT id, billing_mode as billingMode,
                                           cycle_type as cycleType, group_id as groupId
                                      FROM debt_cycles
                                     WHERE center_id = ? AND student_id = ?
                                       AND (billing_mode = 'per_session'
                                            OR (COALESCE(billing_mode, '') = '' AND cycle_type = 'per_session'))
                                       AND status NOT IN ('cancelled', 'paid')
                                       AND package_subscription_id IS NULL
                                       AND COALESCE(cycle_type, '') <> 'package'
                                       AND COALESCE(billing_mode, '') <> 'package'`;
      type PerSessionCycleRow = {
        id: string;
        billingMode?: string;
        cycleType?: string;
        groupId?: string | null;
      };
      let perSessionCycle: PerSessionCycleRow | null = null;
      if (params.sessionId) {
        if (!paymentSessionGroupId || !paymentSessionDate) {
          throw new ValidationError("تعذر تحديد مجموعة وتاريخ جلسة دفع الحصة.");
        }
        perSessionCycle = db.getFirstSync<PerSessionCycleRow>(
          `${perSessionCycleQuery}
             AND group_id = ? AND start_date <= ? AND end_date >= ?
           ORDER BY start_date DESC LIMIT 1`,
          [centerId, params.studentId, paymentSessionGroupId, paymentSessionDate, paymentSessionDate],
        );
      } else {
        perSessionCycle = db.getFirstSync<PerSessionCycleRow>(
          `${perSessionCycleQuery}
           ORDER BY start_date DESC LIMIT 1`,
          [centerId, params.studentId],
        );
      }
      if (
        perSessionCycle &&
        isPerSessionBillingMode(perSessionCycle.billingMode, perSessionCycle.cycleType) &&
        (!params.sessionId || perSessionCycle.groupId === paymentSessionGroupId)
      ) {
        assignedCycleId = perSessionCycle.id;
      }
    }

    if (assignedCycleId) {
      const cycle = db.getFirstSync<{ id: string; studentId: string; status: string; enrollmentId?: string; packageSubscriptionId?: string; billingMode?: string; cycleType?: string }>(
        `SELECT id, student_id as studentId, status,
                enrollment_id as enrollmentId,
                package_subscription_id as packageSubscriptionId,
                billing_mode as billingMode, cycle_type as cycleType
           FROM debt_cycles
         WHERE center_id = ? AND id = ?`,
        [centerId, assignedCycleId],
      );
      if (!cycle || cycle.studentId !== params.studentId) {
        throw new ValidationError("دورة المديونية لا تخص هذا الطالب.");
      }
      if (cycle.status === "cancelled") {
        let endDate: string | null = null;
        if (cycle.enrollmentId) {
          endDate = db.getFirstSync<{ endDate: string | null }>(
            `SELECT end_date as endDate FROM student_group_enrollments WHERE center_id = ? AND id = ?`,
            [centerId, cycle.enrollmentId],
          )?.endDate || null;
        } else if (cycle.packageSubscriptionId) {
          endDate = db.getFirstSync<{ endDate: string | null }>(
            `SELECT end_date as endDate FROM student_package_subscriptions WHERE center_id = ? AND id = ?`,
            [centerId, cycle.packageSubscriptionId],
          )?.endDate || null;
        }
        if (endDate && paymentDate > endDate.slice(0, 10)) {
          throw new ValidationError("لا يمكن تسجيل دفع بعد إنهاء الاشتراك.");
        }
      }
    }

    const currentFinancialStatus = FinancialCalculationService.getStudentFinancialStatus(
      params.studentId,
      paymentDate,
    );
    let targetCycle = assignedCycleId
      ? currentFinancialStatus.cycles.find((cycle) => cycle.id === assignedCycleId)
      : undefined;
    if (assignedCycleId && !targetCycle) {
      throw new ValidationError("تعذر تحديث دورة المديونية قبل تسجيل الدفعة.");
    }
    const targetCycleIsPerSession = Boolean(targetCycle && isSessionPaymentCycle(targetCycle));
    if (normType === "session" && params.sessionId) {
      const candidate = getPayableSessionPaymentCandidates(
        currentFinancialStatus,
        params.sessionId,
      )[0];
      if (!candidate) {
        throw new ValidationError(
          getSessionPaymentUnavailableReason(
            currentFinancialStatus,
            params.sessionId,
          ) || "لا توجد رسوم حصة مستحقة مرتبطة بهذه الجلسة.",
        );
      }
      if (assignedCycleId && candidate.debtCycleId !== assignedCycleId) {
        throw new ValidationError("دورة المديونية لا تخص الحصة المحددة.");
      }
      if (!paymentSessionPrice || candidate.sessionPrice !== paymentSessionPrice) {
        throw new ValidationError(
          "سعر الحصة غير محدد للمجموعة. حدّد سعرًا موجبًا في تفاصيل المجموعة أولًا.",
        );
      }
      if (candidate.debtCycleId) {
        assignedCycleId = candidate.debtCycleId;
        targetCycle = currentFinancialStatus.cycles.find(
          (cycle) => cycle.id === assignedCycleId,
        );
        if (
          !targetCycle ||
          targetCycle.groupId !== paymentSessionGroupId ||
          (paymentSessionDate &&
            (targetCycle.startDate > paymentSessionDate ||
              targetCycle.endDate < paymentSessionDate))
        ) {
          throw new ValidationError("دورة المديونية لا تغطي تاريخ هذه الحصة.");
        }
      } else {
        const externalAttendance = db.getFirstSync<{ isExternal?: number | boolean }>(
          `SELECT is_external as isExternal FROM attendance
           WHERE center_id = ? AND session_id = ? AND student_id = ?
             AND status IN ('present', 'late')`,
          [centerId, params.sessionId, params.studentId],
        );
        if (!externalAttendance?.isExternal) {
          throw new ValidationError(
            "الحصة لا ترتبط بدورة مستحقة، ولا يمكن تحصيلها كحضور خارجي.",
          );
        }
      }
      if (params.amount > candidate.amountDue + 0.000001) {
        throw new ValidationError(
          `المبلغ يتجاوز رسوم الحصة المتبقية (${candidate.amountDue}).`,
        );
      }
    } else if (normType === "session") {
      if (!targetCycle || !targetCycleIsPerSession || !targetCycle.groupId) {
        throw new ValidationError(
          "لتسجيل دفعة حصة يجب تحديد جلسة حضرها الطالب أو استخدام دورة الدفع بالحصة.",
        );
      }
      if (
        !currentFinancialStatus.sessionDebt ||
        targetCycle.startDate > currentFinancialStatus.sessionDebt.periodEnd ||
        targetCycle.endDate < currentFinancialStatus.sessionDebt.periodStart
      ) {
        throw new ValidationError("لا توجد دورة دفع بالحصة نشطة في الفترة الحالية.");
      }
    }

    if (normType === "session" && !params.sessionId) {
      const groupId = targetCycle?.groupId;
      if (!groupId) {
        throw new ValidationError("تعذر تحديد مجموعة دورة دفع الحصة.");
      }
      const outstanding = Number(FinancialCalculationService.getStudentFinancialStatusForGroup(
        params.studentId,
        groupId,
      ).currentPeriodDebt || 0);
      if (outstanding <= 0) {
        throw new ValidationError("لا توجد رسوم حصص مستحقة للتحصيل في هذه الدورة.");
      }
      if (params.amount > outstanding + 0.000001) {
        throw new ValidationError(`المبلغ يتجاوز رسوم الحصص المستحقة (${outstanding}).`);
      }
    }

    // Recalculate immediately before writing. Monthly/package collections are
    // capped to a selected cycle, or to the aggregate when the oldest cycle
    // was assigned automatically. Advance payments use a separate explicit path.
    if (!params.allowCreditBalance && normType !== "session") {
      const outstanding = targetCycle
        ? params.debtCycleId
          ? Number(targetCycle.remainingDebt ?? 0)
          : Number(currentFinancialStatus.monthlyRemainingDebt || 0)
        : Number(currentFinancialStatus.monthlyRemainingDebt || 0);
      if (targetCycleIsPerSession && params.debtCycleId) {
        throw new ValidationError(
          "لا يوجد رصيد شهري مستحق في دورة محسوبة بالدفع بالحصة.",
        );
      }
      if (outstanding <= 0) {
        throw new ValidationError("لا يوجد مبلغ مستحق للتحصيل حاليًا.");
      }
      if (params.amount > outstanding + 0.000001) {
        throw new ValidationError(
          `المبلغ يتجاوز المتبقي المستحق (${outstanding}). استخدم «إضافة رصيد مقدم» إذا كانت الدفعة مقصودة للمستقبل.`,
        );
      }
    }

    const isAdvanceBeyondDue = Boolean(
      params.allowCreditBalance &&
      params.amount > Number(currentFinancialStatus.monthlyRemainingDebt ?? 0) + 0.000001,
    );
    const paymentNotes = [
      isAdvanceBeyondDue ? "رصيد مقدم" : "",
      params.notes?.trim() || "",
    ].filter(Boolean).join(" • ") || undefined;
    const paymentEvent: PaymentEvent = {
      id: paymentId,
      operationId,
      centerId,
      studentId: params.studentId,
      subscriptionId: params.subscriptionId,
      debtCycleId: assignedCycleId || undefined,
      sessionId: params.sessionId,
      amount: params.amount,
      paymentType: normType,
      paymentMethod,
      paymentDate,
      notes: paymentNotes,
      isReversed: false,
      createdAt,
      userId: user.id,
    };
    DatabaseService.runInTransaction(() => {
      if (normType === "session" && params.sessionId) {
        const latestStatus = FinancialCalculationService.getStudentFinancialStatus(
          params.studentId,
          paymentDate,
        );
        const latestCandidate = getPayableSessionPaymentCandidates(
          latestStatus,
          params.sessionId,
        )[0];
        if (
          !latestCandidate ||
          (latestCandidate.debtCycleId || null) !== assignedCycleId ||
          params.amount > latestCandidate.amountDue + 0.000001
        ) {
          throw new ValidationError(
            "تغيّر المبلغ المستحق لهذه الحصة. حدّث البيانات المالية قبل تسجيل الدفعة.",
          );
        }
      }
      db.runSync(
        `INSERT INTO payments (id, operation_id, center_id, student_id, subscription_id, debt_cycle_id, session_id, amount, payment_type, payment_method, payment_date, notes, is_reversed, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [paymentId, operationId, centerId, params.studentId, params.subscriptionId || null, assignedCycleId, params.sessionId || null, params.amount, normType, paymentMethod, paymentDate, paymentNotes || null, createdAt, user.id],
      );
      SyncRepository.enqueueOperation({ centerId, userId: user.id, deviceId, operationType: "payment.create", entityType: "payment", entityId: paymentId, payload: paymentEvent, operationId });
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "payment", entityId: paymentId, action: "payment.record", payload: { studentId: params.studentId, amount: params.amount, paymentType: normType, debtCycleId: assignedCycleId, sessionId: params.sessionId, subscriptionId: params.subscriptionId, notes: paymentNotes || null, actorName: user.fullName } });
      DatabaseService.notifyLocalChange({
        centerId,
        entityType: "payment",
        entityId: paymentId,
      });
    });

    FinancialCalculationService.getStudentFinancialStatus(
      params.studentId,
      paymentDate,
    );
    return paymentEvent;
  }

  /**
   * Helper method to record a session-specific cash payment.
   */
  static async recordSessionPayment(params: {
    studentId: string;
    sessionId: string;
    amount: number;
    paymentDate?: string;
    notes?: string;
    operationId?: string;
  }): Promise<PaymentEvent> {
    return this.recordPayment({
      ...params,
      paymentType: "session",
    });
  }

  /**
   * Collects one or multiple financial obligations (payment requests, subscriptions, sessions)
   * in a single atomic transaction.
   * - Preserves the identity, target obligation ID, and exact amount of every obligation.
   * - Records distinct payment entries in the ledger to maintain accurate audit and reversal history.
   * - Rejects duplicate collections if an obligation is already paid.
   * - Immediately recalculates and refreshes student financial status.
   */
  static async collectMultipleObligations(params: {
    studentId: string;
    items: Array<{
      type: "payment_request" | "subscription" | "session";
      id: string;
      amount?: number;
      notes?: string;
      debtCycleId?: string;
      sessionId?: string;
      paymentRequestObligationId?: string;
    }>;
    paymentMethod?: string;
    paymentDate?: string;
    batchNotes?: string;
    operationId?: string;
  }): Promise<{ payments: PaymentEvent[]; totalCollected: number }> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل المدفوعات.");
    }
    if (!params.items || params.items.length === 0) {
      throw new ValidationError("يجب تحديد التزام واحد على الأقل للتحصيل.");
    }

    const recordedPayments: PaymentEvent[] = [];
    let totalCollected = 0;

    DatabaseService.runInTransaction(() => {
      for (let i = 0; i < params.items.length; i++) {
        const item = params.items[i];
        const itemOpId = params.operationId
          ? `${params.operationId}-item-${i}`
          : undefined;

        let payment: PaymentEvent;
        if (item.type === "payment_request") {
          const obligationId =
            item.paymentRequestObligationId || item.id.replace(/^pr-/, "");
          let paymentAmount = item.amount;
          if (paymentAmount === undefined) {
            const db = DatabaseService.getDb();
            const ob = db.getFirstSync<any>(
              `SELECT amount_due as amountDue, amount_paid as amountPaid FROM student_payment_request_obligations WHERE center_id = ? AND id = ?`,
              [centerId, obligationId],
            );
            if (!ob) throw new NotFoundError("المطالبة المالية غير موجودة.");
            paymentAmount = Math.max(0, (Number(ob.amountDue) || 0) - (Number(ob.amountPaid) || 0));
          }
          if (paymentAmount <= 0) {
            throw new ConflictError("تم سداد هذه المطالبة مسبقًا لهذا الطالب.");
          }
          payment = this.recordPaymentSync({
            studentId: params.studentId,
            amount: paymentAmount,
            paymentType: "payment_request",
            paymentRequestObligationId: obligationId,
            paymentMethod: params.paymentMethod,
            paymentDate: params.paymentDate,
            notes: item.notes || params.batchNotes,
            operationId: itemOpId,
          });
          totalCollected = Math.round((totalCollected + paymentAmount) * 100) / 100;
        } else if (item.type === "subscription") {
          const cycleId = item.debtCycleId || item.id.replace(/^cycle-/, "");
          let paymentAmount = item.amount;
          if (paymentAmount === undefined) {
            const latestStatus = FinancialCalculationService.getStudentFinancialStatus(
              params.studentId,
              params.paymentDate,
            );
            const matchedCycle = (latestStatus.cycles || []).find(
              (c: any) => c.id === cycleId,
            );
            if (matchedCycle) {
              paymentAmount = Math.max(0, Number(matchedCycle.remainingDebt) || 0);
            } else {
              const db = DatabaseService.getDb();
              const cyc = db.getFirstSync<any>(
                `SELECT cycle_price as cyclePrice FROM debt_cycles WHERE center_id = ? AND id = ?`,
                [centerId, cycleId],
              );
              if (!cyc) throw new NotFoundError("دورة المديونية غير موجودة.");
              paymentAmount = Math.max(0, Number(cyc.cyclePrice) || 0);
            }
          }
          if (paymentAmount <= 0) {
            throw new ConflictError("تم سداد هذه الدورة مسبقًا لهذا الطالب.");
          }
          payment = this.recordPaymentSync({
            studentId: params.studentId,
            amount: paymentAmount,
            paymentType: "monthly",
            debtCycleId: cycleId,
            paymentMethod: params.paymentMethod,
            paymentDate: params.paymentDate,
            notes: item.notes || params.batchNotes,
            operationId: itemOpId,
          });
          totalCollected = Math.round((totalCollected + paymentAmount) * 100) / 100;
        } else if (item.type === "session") {
          const sessId = item.sessionId || item.id.replace(/^session-/, "");
          let paymentAmount = item.amount;
          if (paymentAmount === undefined || paymentAmount <= 0) {
            throw new ValidationError("مبلغ دفع الحصة مطلوب.");
          }
          payment = this.recordPaymentSync({
            studentId: params.studentId,
            amount: paymentAmount,
            paymentType: "session",
            sessionId: sessId,
            debtCycleId: item.debtCycleId,
            paymentMethod: params.paymentMethod,
            paymentDate: params.paymentDate,
            notes: item.notes || params.batchNotes,
            operationId: itemOpId,
          });
          totalCollected = Math.round((totalCollected + paymentAmount) * 100) / 100;
        } else {
          throw new ValidationError(`نوع الالتزام غير معروف: ${(item as any).type}`);
        }

        recordedPayments.push(payment);
      }
    });

    FinancialCalculationService.getStudentFinancialStatus(
      params.studentId,
      params.paymentDate,
    );

    return { payments: recordedPayments, totalCollected };
  }

  /**
   * Reverses an existing payment.
   * - Sets is_reversed = 1 on payments table (never hard deletes).
   * - Inserts an event into payment_reversals table.
   * - Enforces single-reversal: throws ConflictError if already reversed.
   * - Enforces payments.reversal permission (admin-only).
   * - Sync queue and audit logging.
   */
  static async reversePayment(params: {
    paymentId: string;
    reason: string;
    operationId?: string;
  }): Promise<PaymentReversal> {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "payments.reverse")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء المدفوعات.");
    }

    if (!params.reason || !params.reason.trim()) {
      throw new ValidationError("سبب إلغاء الدفعة مطلوب.");
    }

    const db = DatabaseService.getDb();

    // 1. Fetch payment
    const payment = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, amount, is_reversed as isReversed,
              payment_request_obligation_id as paymentRequestObligationId,
              payment_request_id as paymentRequestId
       FROM payments
       WHERE center_id = ? AND id = ?`,
      [centerId, params.paymentId],
    );

    if (!payment) {
      throw new NotFoundError("الدفعة غير موجودة.");
    }

    if (payment.isReversed === 1 || payment.isReversed === true) {
      throw new ConflictError(
        "تم إلغاء هذه الدفعة مسبقاً ولا يمكن إلغاؤها مرة أخرى.",
      );
    }

    const reversalId = `rev-${generateUUID()}`;
    const operationId = params.operationId || `op-rev-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const now = new Date().toISOString();

    const reversal: PaymentReversal = {
      id: reversalId,
      operationId,
      centerId,
      paymentId: params.paymentId,
      studentId: payment.studentId,
      reversedAmount: Number(payment.amount),
      reason: params.reason.trim(),
      reversedBy: user.id,
      reversedAt: now,
      createdAt: now,
    };

    DatabaseService.runInTransaction(() => {
      db.runSync(`UPDATE payments SET is_reversed = 1, updated_at = ? WHERE center_id = ? AND id = ?`, [now, centerId, params.paymentId]);
      db.runSync(
        `INSERT INTO payment_reversals (id, operation_id, center_id, payment_id, student_id, reversed_amount, reason, reversed_by, reversed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reversalId, operationId, centerId, params.paymentId, payment.studentId, Number(payment.amount), params.reason.trim(), user.id, now, now],
      );
      const linkedObligation = payment.paymentRequestObligationId
        ? db.getFirstSync<any>(
            `SELECT id, request_id as requestId, amount_due as amountDue, status
             FROM student_payment_request_obligations
             WHERE center_id = ? AND id = ?`,
            [centerId, payment.paymentRequestObligationId],
          )
        : db.getFirstSync<any>(
            `SELECT id, request_id as requestId, amount_due as amountDue, status
             FROM student_payment_request_obligations
             WHERE center_id = ? AND payment_id = ?`,
            [centerId, params.paymentId],
          );
      if (linkedObligation) {
        const parentReq = db.getFirstSync<any>(
          `SELECT status FROM group_payment_requests WHERE center_id = ? AND id = ?`,
          [centerId, linkedObligation.requestId],
        );
        const remainingPayments = db.getAllSync<any>(
          `SELECT id, operation_id as operationId, amount, created_at as createdAt, is_reversed as isReversed
           FROM payments
           WHERE center_id = ? AND payment_request_obligation_id = ? AND is_reversed = 0
           ORDER BY created_at DESC`,
          [centerId, linkedObligation.id],
        );
        const seenKeys = new Set<string>();
        let remainingConfirmedPaid = 0;
        let latestRemainingPayment: any = null;
        for (const rp of remainingPayments) {
          if (rp.id === params.paymentId) continue;
          if (rp.isReversed === 1 || rp.isReversed === true) continue;
          const key = String(rp.operationId || rp.operation_id || rp.id);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          remainingConfirmedPaid += Number(rp.amount) || 0;
          if (!latestRemainingPayment) latestRemainingPayment = rp;
        }
        remainingConfirmedPaid = Math.round(remainingConfirmedPaid * 100) / 100;
        const obDue = Math.round((Number(linkedObligation.amountDue ?? linkedObligation.amount_due) || 0) * 100) / 100;
        const isStillFullyPaid = obDue > 0 && remainingConfirmedPaid >= obDue - 0.000001;
        const restoredStatus = isStillFullyPaid
          ? "paid"
          : parentReq?.status === "archived"
            ? "cancelled"
            : "unpaid";
        const restoredPaymentId = latestRemainingPayment?.id || null;
        const restoredPaidAt = isStillFullyPaid
          ? latestRemainingPayment?.createdAt || latestRemainingPayment?.created_at || now
          : null;
        if (restoredStatus === "cancelled") {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'cancelled', amount_paid = ?, payment_id = NULL, paid_at = NULL, cancelled_at = ?, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [remainingConfirmedPaid, now, now, centerId, linkedObligation.id],
          );
        } else if (restoredStatus === "paid") {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'paid', amount_paid = ?, payment_id = ?, paid_at = ?, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [remainingConfirmedPaid, restoredPaymentId, restoredPaidAt, now, centerId, linkedObligation.id],
          );
        } else if (restoredPaymentId) {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'unpaid', amount_paid = ?, payment_id = ?, paid_at = NULL, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [remainingConfirmedPaid, restoredPaymentId, now, centerId, linkedObligation.id],
          );
        } else {
          db.runSync(
            `UPDATE student_payment_request_obligations
             SET status = 'unpaid', amount_paid = 0, payment_id = NULL, paid_at = NULL, updated_at = ?
             WHERE center_id = ? AND id = ?`,
            [now, centerId, linkedObligation.id],
          );
        }
        SyncRepository.enqueueOperation({
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment_request_obligation.reverse",
          entityType: "payment_request_obligation",
          entityId: linkedObligation.id,
          payload: {
            id: linkedObligation.id,
            centerId,
            requestId: linkedObligation.requestId,
            studentId: payment.studentId,
            status: restoredStatus,
            amountPaid: remainingConfirmedPaid,
            paymentId: restoredPaymentId,
            paidAt: restoredPaidAt,
            updatedAt: now,
          },
          operationId: `${operationId}-ob`,
        });
        DatabaseService.notifyLocalChange({
          centerId,
          entityType: "payment_request_obligation",
          entityId: linkedObligation.id,
        });
      }
      SyncRepository.enqueueOperation({ centerId, userId: user.id, deviceId, operationType: "payment.reverse", entityType: "payment_reversal", entityId: reversalId, payload: { ...reversal, updatedAt: now }, operationId });
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "payment", entityId: params.paymentId, action: "payment.reverse", payload: { studentId: payment.studentId, reversedAmount: Number(payment.amount), reason: params.reason.trim(), reversalId, paymentRequestObligationId: linkedObligation?.id || null, actorName: user.fullName } });
      DatabaseService.notifyLocalChange({
        centerId,
        entityType: "payment",
        entityId: params.paymentId,
      });
    });

    // 6. Recalculate financial status to update cycle statuses dynamically
    try {
      FinancialCalculationService.getStudentFinancialStatus(payment.studentId);
    } catch {
      // safe fallback
    }

    return reversal;
  }
}
