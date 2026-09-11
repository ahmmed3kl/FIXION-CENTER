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
import { DailyClosingSummary } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class DailyClosingService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Performs daily cash closing for a business date.
   * - Aggregates all non-reversed cash payments for center+date.
   * - Breakdowns: monthly, partial, session, external_makeup, package.
   * - Does NOT mutate or delete original payment records.
   * - Prevents duplicate closing for the same center+date (UNIQUE constraint).
   */
  static closeDailyForDate(
    businessDate: string,
    operationId?: string,
  ): DailyClosingSummary {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "daily_closing.close")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إغلاق الصندوق اليومي.");
    }
    if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new ValidationError(
        "صيغة التاريخ غير صحيحة. يجب أن يكون YYYY-MM-DD.",
      );
    }

    const db = DatabaseService.getDb();

    const existing = db.getAllSync<DailyClosingSummary>(
      `SELECT * FROM daily_closing_summaries WHERE center_id = ? AND business_date = ?`,
      [centerId, businessDate],
    );

    if (existing.length > 0 && existing[0].status === "closed") {
      throw new ConflictError(`تم إغلاق الصندوق مسبقاً ليوم ${businessDate}.`);
    }

    // Aggregate payments for the day (non-reversed, by payment_date)
    const payments = db.getAllSync<any>(
      `SELECT id, amount, payment_type, payment_method, session_id, is_reversed
       FROM payments
       WHERE center_id = ? AND payment_date = ? AND (is_reversed = 0 OR is_reversed IS NULL)`,
      [centerId, businessDate],
    );

    // Also check created_at fallback for payments without payment_date
    const paymentsAlt = db.getAllSync<any>(
      `SELECT id, amount, payment_type, payment_method, session_id, is_reversed, created_at
       FROM payments
       WHERE center_id = ? AND created_at LIKE ?`,
      [centerId, `${businessDate}%`],
    );

    // Merge, deduplicate by id
    const allPaymentIds = new Set<string>();
    const allPayments: any[] = [];
    for (const p of [...payments, ...paymentsAlt]) {
      if (!allPaymentIds.has(p.id)) {
        allPaymentIds.add(p.id);
        allPayments.push(p);
      }
    }

    const activePayments = allPayments.filter(
      (p) => !p.is_reversed || p.is_reversed === 0,
    );

    let monthlyTotal = 0;
    let partialTotal = 0;
    let sessionTotal = 0;
    let externalMakeupTotal = 0;
    let packageTotal = 0;

    // Identify external makeup attendance sessions to distinguish external makeup payments from regular session payments
    const extAttRows = db.getAllSync<any>(
      `SELECT student_id, session_id FROM attendance WHERE center_id = ? AND is_external = 1`,
      [centerId],
    );
    const extAttSet = new Set(
      extAttRows.map((r: any) => `${r.student_id}-${r.session_id}`),
    );

    for (const p of activePayments) {
      const amount = Number(p.amount) || 0;
      const pType = p.payment_type === "cash" ? "session" : p.payment_type;

      if (pType === "monthly" || pType === "full") {
        monthlyTotal += amount;
      } else if (pType === "partial") {
        partialTotal += amount;
      } else if (pType === "session") {
        const isExternal =
          (p.notes && p.notes.includes("خارجي")) ||
          (p.session_id && extAttSet.has(`${p.student_id}-${p.session_id}`));
        if (isExternal) {
          externalMakeupTotal += amount;
        } else {
          sessionTotal += amount;
        }
      } else if (pType === "package") {
        packageTotal += amount;
      }
    }

    const totalCash =
      monthlyTotal +
      partialTotal +
      sessionTotal +
      externalMakeupTotal +
      packageTotal;
    const paymentCount = activePayments.length;

    const opId = operationId || `op-${generateUUID()}`;
    const now = new Date().toISOString();

    // If day was previously reopened (status === 'open'), re-closing updates the existing record with fresh aggregates
    if (existing.length > 0 && existing[0].status === "open") {
      const summaryId = existing[0].id;
      db.runSync(
        `UPDATE daily_closing_summaries
         SET status = 'closed',
             operation_id = ?,
             closed_by = ?,
             closed_at = ?,
             total_cash = ?,
             monthly_total = ?,
             partial_total = ?,
             session_total = ?,
             external_makeup_total = ?,
             package_total = ?,
             payment_count = ?,
             updated_at = ?
         WHERE center_id = ? AND business_date = ?`,
        [
          opId,
          user.id,
          now,
          totalCash,
          monthlyTotal,
          partialTotal,
          sessionTotal,
          externalMakeupTotal,
          packageTotal,
          paymentCount,
          now,
          centerId,
          businessDate,
        ],
      );

      const deviceId = DeviceService.getDeviceIdSync();

      SyncRepository.enqueueOperation({
        centerId,
        userId: user.id,
        deviceId,
        operationType: "update",
        entityType: "daily_closing",
        entityId: summaryId,
        operationId: opId,
        payload: { businessDate, totalCash, paymentCount, action: "reclose" },
      });

      AuditService.recordEvent({
        operationId: opId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "daily_closing",
        entityId: summaryId,
        action: "daily_closing_reclosed",
        payload: { businessDate, totalCash, paymentCount, closedBy: user.id },
      });

      return {
        id: summaryId,
        operationId: opId,
        centerId,
        businessDate,
        status: "closed",
        closedBy: user.id,
        closedAt: now,
        reopenedBy: existing[0].reopenedBy,
        reopenedAt: existing[0].reopenedAt,
        reopenReason: existing[0].reopenReason,
        totalCash,
        monthlyTotal,
        partialTotal,
        sessionTotal,
        externalMakeupTotal,
        packageTotal,
        paymentCount,
        createdAt: existing[0].createdAt,
        updatedAt: now,
      };
    }

    const summaryId = `dcs-${generateUUID()}`;

    db.runSync(
      `INSERT INTO daily_closing_summaries
         (id, operation_id, center_id, business_date, status, closed_by, closed_at,
          total_cash, monthly_total, partial_total, session_total, external_makeup_total,
          package_total, payment_count, created_at)
       VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        summaryId,
        opId,
        centerId,
        businessDate,
        user.id,
        now,
        totalCash,
        monthlyTotal,
        partialTotal,
        sessionTotal,
        externalMakeupTotal,
        packageTotal,
        paymentCount,
        now,
      ],
    );

    const deviceId = DeviceService.getDeviceIdSync();

    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "create",
      entityType: "daily_closing",
      entityId: summaryId,
      operationId: opId,
      payload: { businessDate, totalCash, paymentCount },
    });

    AuditService.recordEvent({
      operationId: opId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "daily_closing",
      entityId: summaryId,
      action: "daily_closing_closed",
      payload: { businessDate, totalCash, paymentCount, closedBy: user.id },
    });

    return {
      id: summaryId,
      operationId: opId,
      centerId,
      businessDate,
      status: "closed",
      closedBy: user.id,
      closedAt: now,
      totalCash,
      monthlyTotal,
      partialTotal,
      sessionTotal,
      externalMakeupTotal,
      packageTotal,
      paymentCount,
      createdAt: now,
    };
  }

  /**
   * Reopens a closed daily closing record.
   * Requires daily_closing.reopen permission (admin only).
   */
  static reopenDailyClosing(
    businessDate: string,
    reason: string,
    operationId?: string,
  ): DailyClosingSummary {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "daily_closing.reopen")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إعادة فتح إغلاق الصندوق.");
    }
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError("يجب إدخال سبب إعادة فتح الإغلاق.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getAllSync<DailyClosingSummary>(
      `SELECT id, status, center_id, business_date FROM daily_closing_summaries WHERE center_id = ? AND business_date = ?`,
      [centerId, businessDate],
    );
    if (existing.length === 0) {
      throw new NotFoundError(`لا يوجد إغلاق مسجل ليوم ${businessDate}.`);
    }
    if (existing[0].status !== "closed") {
      throw new ConflictError("الصندوق ليس مغلقاً.");
    }

    const now = new Date().toISOString();
    const opId = operationId || `op-${generateUUID()}`;

    db.runSync(
      `UPDATE daily_closing_summaries
       SET status = 'open', reopened_by = ?, reopened_at = ?, reopen_reason = ?, updated_at = ?
       WHERE center_id = ? AND business_date = ?`,
      [user.id, now, reason.trim(), now, centerId, businessDate],
    );

    const deviceId = DeviceService.getDeviceIdSync();

    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "update",
      entityType: "daily_closing",
      entityId: existing[0].id,
      operationId: opId,
      payload: { businessDate, reason: reason.trim(), reopenedBy: user.id },
    });

    AuditService.recordEvent({
      operationId: opId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "daily_closing",
      entityId: existing[0].id,
      action: "daily_closing_reopened",
      payload: { businessDate, reason: reason.trim(), reopenedBy: user.id },
    });

    // Return updated record
    const updated = db.getAllSync<DailyClosingSummary>(
      `SELECT id, operation_id as operationId, center_id as centerId, business_date as businessDate,
              status, closed_by as closedBy, closed_at as closedAt,
              reopened_by as reopenedBy, reopened_at as reopenedAt, reopen_reason as reopenReason,
              total_cash as totalCash, monthly_total as monthlyTotal, partial_total as partialTotal,
              session_total as sessionTotal, external_makeup_total as externalMakeupTotal,
              package_total as packageTotal, payment_count as paymentCount,
              created_at as createdAt, updated_at as updatedAt
       FROM daily_closing_summaries
       WHERE center_id = ? AND business_date = ?`,
      [centerId, businessDate],
    );
    return updated[0];
  }

  /**
   * Gets the closing summary for a business date.
   */
  static getClosingForDate(businessDate: string): DailyClosingSummary | null {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "daily_closing.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض إغلاق الصندوق.");
    }
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<DailyClosingSummary>(
      `SELECT id, operation_id as operationId, center_id as centerId, business_date as businessDate,
              status, closed_by as closedBy, closed_at as closedAt,
              reopened_by as reopenedBy, reopened_at as reopenedAt, reopen_reason as reopenReason,
              total_cash as totalCash, monthly_total as monthlyTotal, partial_total as partialTotal,
              session_total as sessionTotal, external_makeup_total as externalMakeupTotal,
              package_total as packageTotal, payment_count as paymentCount,
              created_at as createdAt, updated_at as updatedAt
       FROM daily_closing_summaries
       WHERE center_id = ? AND business_date = ?`,
      [centerId, businessDate],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Lists all daily closing records for the center.
   */
  static getAllClosings(): DailyClosingSummary[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "daily_closing.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض إغلاق الصندوق.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DailyClosingSummary>(
      `SELECT id, operation_id as operationId, center_id as centerId, business_date as businessDate,
              status, closed_by as closedBy, closed_at as closedAt,
              reopened_by as reopenedBy, reopened_at as reopenedAt, reopen_reason as reopenReason,
              total_cash as totalCash, monthly_total as monthlyTotal, partial_total as partialTotal,
              session_total as sessionTotal, external_makeup_total as externalMakeupTotal,
              package_total as packageTotal, payment_count as paymentCount,
              created_at as createdAt, updated_at as updatedAt
       FROM daily_closing_summaries
       WHERE center_id = ?
       ORDER BY business_date DESC`,
      [centerId],
    );
  }
}
