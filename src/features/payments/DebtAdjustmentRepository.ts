import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { DebtAdjustment } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class DebtAdjustmentRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Retrieves all adjustments for a specific debt cycle.
   */
  static getAdjustmentsForCycle(cycleId: string): DebtAdjustment[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DebtAdjustment>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId, enrollment_id as enrollmentId,
              debt_cycle_id as debtCycleId, amount_before as amountBefore,
              adjustment_amount as adjustmentAmount, amount_after as amountAfter,
              reason, created_by as createdBy, created_at as createdAt
       FROM debt_adjustments
       WHERE center_id = ? AND debt_cycle_id = ?
       ORDER BY created_at ASC`,
      [centerId, cycleId],
    );
  }

  /**
   * Retrieves all adjustments for a specific student.
   */
  static getAdjustmentsForStudent(studentId: string): DebtAdjustment[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DebtAdjustment>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId, enrollment_id as enrollmentId,
              debt_cycle_id as debtCycleId, amount_before as amountBefore,
              adjustment_amount as adjustmentAmount, amount_after as amountAfter,
              reason, created_by as createdBy, created_at as createdAt
       FROM debt_adjustments
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );
  }

  /**
   * Creates an administrative adjustment on a debt cycle.
   * - Enforces payments.adjust permission (admin-only).
   * - Validates reason is provided.
   * - Validates resulting amount is non-negative.
   * - Records before/after, reason, audit log, and sync queue.
   */
  static async createAdjustment(params: {
    debtCycleId: string;
    adjustmentAmount: number;
    reason: string;
    operationId?: string;
  }): Promise<DebtAdjustment> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.adjust")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل الرسوم / الديون.");
    }

    if (!params.reason || !params.reason.trim()) {
      throw new ValidationError("سبب التعديل مطلوب.");
    }

    if (params.adjustmentAmount === 0) {
      throw new ValidationError("قيمة التعديل لا يمكن أن تكون صفراً.");
    }

    const db = DatabaseService.getDb();

    // 1. Fetch debt cycle
    const cycle = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId,
              enrollment_id as enrollmentId, cycle_price as cyclePrice
       FROM debt_cycles
       WHERE center_id = ? AND id = ?`,
      [centerId, params.debtCycleId],
    );

    if (!cycle) {
      throw new NotFoundError("الدورة المالية غير موجودة.");
    }

    // 2. Calculate current effective price before this adjustment
    const existingAdjustments = this.getAdjustmentsForCycle(params.debtCycleId);
    const sumAdjustments = existingAdjustments.reduce(
      (acc, adj) => acc + (Number(adj.adjustmentAmount) || 0),
      0,
    );
    const amountBefore = Number(cycle.cyclePrice) + sumAdjustments;
    const amountAfter = amountBefore + Number(params.adjustmentAmount);

    if (amountAfter < 0) {
      throw new ValidationError("المبلغ بعد التعديل لا يمكن أن يكون سالباً.");
    }

    const adjustmentId = `adj-${generateUUID()}`;
    const operationId = params.operationId || `op-adj-${generateUUID()}`;
    const deviceId = await DeviceService.getDeviceId();
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO debt_adjustments (id, operation_id, center_id, student_id, enrollment_id, debt_cycle_id, amount_before, adjustment_amount, amount_after, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adjustmentId,
        operationId,
        centerId,
        cycle.studentId,
        cycle.enrollmentId,
        params.debtCycleId,
        amountBefore,
        params.adjustmentAmount,
        amountAfter,
        params.reason.trim(),
        user.id,
        now,
      ],
    );

    const adjustment: DebtAdjustment = {
      id: adjustmentId,
      operationId,
      centerId,
      studentId: cycle.studentId,
      enrollmentId: cycle.enrollmentId,
      debtCycleId: params.debtCycleId,
      amountBefore,
      adjustmentAmount: params.adjustmentAmount,
      amountAfter,
      reason: params.reason.trim(),
      createdBy: user.id,
      createdAt: now,
    };

    // Queue for sync
    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "debt_adjustment.create",
      entityType: "debt_adjustment",
      entityId: adjustmentId,
      payload: adjustment,
      operationId,
    });

    // Record in audit log
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "debt_adjustment",
      entityId: adjustmentId,
      action: "debt_adjustment.create",
      payload: {
        debtCycleId: params.debtCycleId,
        amountBefore,
        adjustmentAmount: params.adjustmentAmount,
        amountAfter,
        reason: params.reason.trim(),
      },
    });

    return adjustment;
  }
}
