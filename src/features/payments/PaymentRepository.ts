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
import { useAuthStore } from "../auth/useAuthStore";
import { FinancialCalculationService } from "./FinancialCalculationService";

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
   * Payment types: 'monthly', 'partial', 'session'.
   */
  static async recordPayment(params: {
    studentId: string;
    amount: number;
    paymentType?: "monthly" | "partial" | "session" | "full";
    paymentMethod?: string;
    debtCycleId?: string;
    sessionId?: string;
    subscriptionId?: string;
    paymentDate?: string;
    notes?: string;
    operationId?: string;
  }): Promise<PaymentEvent> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل المدفوعات.");
    }

    if (!params.amount || params.amount <= 0) {
      throw new ValidationError("مبلغ الدفعة يجب أن يكون أكبر من صفر.");
    }

    const db = DatabaseService.getDb();
    const paymentId = `pay-${generateUUID()}`;
    const operationId = params.operationId || `op-pay-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const createdAt = new Date().toISOString();
    const paymentDate = params.paymentDate || createdAt.slice(0, 10);
    const paymentMethod = params.paymentMethod || "cash";

    // Normalize payment type: 'full' in legacy calls maps to 'monthly'
    let normType: "monthly" | "partial" | "session" = "partial";
    if (params.paymentType === "session") {
      normType = "session";
    } else if (
      params.paymentType === "monthly" ||
      params.paymentType === "full"
    ) {
      normType = "monthly";
    } else if (params.paymentType === "partial") {
      normType = "partial";
    }

    // Auto-link debtCycleId for monthly/partial payments if not explicitly provided
    let assignedCycleId = params.debtCycleId || null;
    if (!assignedCycleId && normType !== "session") {
      const openCycles = db.getAllSync<any>(
        `SELECT id FROM debt_cycles WHERE center_id = ? AND student_id = ? AND status != 'paid' ORDER BY start_date ASC`,
        [centerId, params.studentId],
      );
      if (openCycles.length > 0) {
        assignedCycleId = openCycles[0].id;
      }
    }

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
      notes: params.notes,
      isReversed: false,
      createdAt,
      userId: user.id,
    };

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO payments (id, operation_id, center_id, student_id, subscription_id, debt_cycle_id, session_id, amount, payment_type, payment_method, payment_date, notes, is_reversed, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [paymentId, operationId, centerId, params.studentId, params.subscriptionId || null, assignedCycleId, params.sessionId || null, params.amount, normType, paymentMethod, paymentDate, params.notes || null, createdAt, user.id],
      );
      SyncRepository.enqueueOperation({ centerId, userId: user.id, deviceId, operationType: "payment.create", entityType: "payment", entityId: paymentId, payload: paymentEvent, operationId });
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "payment", entityId: paymentId, action: "payment.record", payload: { amount: params.amount, paymentType: normType, debtCycleId: assignedCycleId, sessionId: params.sessionId } });
    });

    // 4. Recalculate financial status to update cycle statuses dynamically
    try {
      FinancialCalculationService.getStudentFinancialStatus(params.studentId);
    } catch {
      // safe fallback
    }

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
      `SELECT id, center_id as centerId, student_id as studentId, amount, is_reversed as isReversed
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
      SyncRepository.enqueueOperation({ centerId, userId: user.id, deviceId, operationType: "payment.reverse", entityType: "payment_reversal", entityId: reversalId, payload: { ...reversal, updatedAt: now }, operationId });
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "payment", entityId: params.paymentId, action: "payment.reverse", payload: { reversedAmount: Number(payment.amount), reason: params.reason.trim(), reversalId } });
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
