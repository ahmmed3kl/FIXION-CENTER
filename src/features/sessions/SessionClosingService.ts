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
import { Session, SessionClosingRecord } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class SessionClosingService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Closes a session.
   * - Prevents attendance modifications after closing.
   * - Calculates final attendance + session payment totals.
   * - Records a closing audit record.
   * - Idempotent: closing an already-closed session returns the existing record.
   */
  static closeSession(
    sessionId: string,
    operationId?: string,
  ): SessionClosingRecord {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.close")) {
      throw new ForbiddenError("ليس لديك صلاحية إغلاق الحصص.");
    }

    const db = DatabaseService.getDb();
    const opId = operationId || `op-${generateUUID()}`;

    // Idempotency: return existing closing record if already closed
    const existingRecords = db.getAllSync<SessionClosingRecord>(
      `SELECT id, operation_id as operationId, center_id as centerId, session_id as sessionId,
              action, reason, performed_by as performedBy, performed_at as performedAt,
              previous_status as previousStatus, new_status as newStatus,
              total_attendance as totalAttendance, total_session_payments as totalSessionPayments,
              created_at as createdAt
       FROM session_closing_records
       WHERE center_id = ? AND session_id = ? AND action = 'close'
       ORDER BY created_at DESC`,
      [centerId, sessionId],
    );

    // Check session exists
    const sessionRows = db.getAllSync<any>(
      `SELECT id, status, center_id FROM sessions WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );
    if (sessionRows.length === 0) {
      throw new NotFoundError("الحصة غير موجودة.");
    }
    const session = sessionRows[0];

    if (session.status === "closed") {
      // Already closed — return last closing record (idempotent)
      if (existingRecords.length > 0) return existingRecords[0];
    }

    if (session.status === "cancelled") {
      throw new ValidationError("لا يمكن إغلاق حصة ملغاة.");
    }

    // Calculate totals
    const attendanceRows = db.getAllSync<any>(
      `SELECT COUNT(*) as cnt FROM attendance WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    const totalAttendance = attendanceRows[0]?.cnt || 0;

    const paymentRows = db.getAllSync<any>(
      `SELECT id, amount, payment_type, is_reversed FROM payments WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    const totalSessionPayments = paymentRows
      .filter((p: any) => !p.is_reversed || p.is_reversed === 0)
      .reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0);

    const previousStatus = session.status;
    const now = new Date().toISOString();

    // Update session status to closed
    db.runSync(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
      ["closed", now, centerId, sessionId],
    );

    // Insert closing record
    const recordId = `scr-${generateUUID()}`;
    db.runSync(
      `INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, performed_by, performed_at, previous_status, new_status, total_attendance, total_session_payments, created_at)
       VALUES (?, ?, ?, ?, 'close', ?, ?, ?, 'closed', ?, ?, ?)`,
      [recordId, opId, centerId, sessionId, user.id, now, previousStatus, totalAttendance, totalSessionPayments, now],
    );

    const deviceId = DeviceService.getDeviceIdSync();

    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "update",
      entityType: "session",
      entityId: sessionId,
      operationId: opId,
      payload: { action: "close", sessionId, performedBy: user.id },
    });

    AuditService.recordEvent({
      operationId: opId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "session",
      entityId: sessionId,
      action: "session_closed",
      payload: {
        sessionId,
        previousStatus,
        totalAttendance,
        totalSessionPayments,
      },
    });

    return {
      id: recordId,
      operationId: opId,
      centerId,
      sessionId,
      action: "close",
      performedBy: user.id,
      performedAt: now,
      previousStatus,
      newStatus: "closed",
      totalAttendance,
      totalSessionPayments,
      createdAt: now,
    };
  }

  /**
   * Reopens a closed session.
   * - Requires sessions.reopen permission (admin only).
   * - Creates an audit record with who/when/reason.
   * - Does NOT delete historical attendance or payment records.
   */
  static reopenSession(
    sessionId: string,
    reason: string,
    operationId?: string,
  ): SessionClosingRecord {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.reopen")) {
      throw new ForbiddenError("ليس لديك صلاحية إعادة فتح الحصص.");
    }
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError("يجب إدخال سبب إعادة فتح الحصة.");
    }

    const db = DatabaseService.getDb();
    const opId = operationId || `op-${generateUUID()}`;

    const sessionRows = db.getAllSync<any>(
      `SELECT id, status FROM sessions WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );
    if (sessionRows.length === 0) {
      throw new NotFoundError("الحصة غير موجودة.");
    }
    const session = sessionRows[0];
    if (session.status !== "closed") {
      throw new ConflictError("الحصة ليست مغلقة، لا يمكن إعادة فتحها.");
    }

    const now = new Date().toISOString();

    // Reopen session
    db.runSync(
      `UPDATE sessions SET status = 'open', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, sessionId],
    );

    // Insert reopen record
    const recordId = `scr-${generateUUID()}`;
    db.runSync(
      `INSERT INTO session_closing_records (id, operation_id, center_id, session_id, action, reason, performed_by, performed_at, previous_status, new_status, created_at)
       VALUES (?, ?, ?, ?, 'reopen', ?, ?, ?, 'closed', 'open', ?)`,
      [recordId, opId, centerId, sessionId, reason.trim(), user.id, now, now],
    );

    const deviceId = DeviceService.getDeviceIdSync();

    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "update",
      entityType: "session",
      entityId: sessionId,
      operationId: opId,
      payload: { action: "reopen", sessionId, reason: reason.trim(), performedBy: user.id },
    });

    AuditService.recordEvent({
      operationId: opId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "session",
      entityId: sessionId,
      action: "session_reopened",
      payload: { sessionId, reason: reason.trim() },
    });

    return {
      id: recordId,
      operationId: opId,
      centerId,
      sessionId,
      action: "reopen",
      reason: reason.trim(),
      performedBy: user.id,
      performedAt: now,
      previousStatus: "closed",
      newStatus: "open",
      createdAt: now,
    };
  }

  /**
   * Returns the closing history for a session.
   */
  static getClosingHistory(sessionId: string): SessionClosingRecord[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض سجل إغلاق الحصص.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<SessionClosingRecord>(
      `SELECT id, operation_id as operationId, center_id as centerId, session_id as sessionId,
              action, reason, performed_by as performedBy, performed_at as performedAt,
              previous_status as previousStatus, new_status as newStatus,
              total_attendance as totalAttendance, total_session_payments as totalSessionPayments,
              created_at as createdAt
       FROM session_closing_records
       WHERE center_id = ? AND session_id = ?
       ORDER BY created_at ASC`,
      [centerId, sessionId],
    );
  }
}
