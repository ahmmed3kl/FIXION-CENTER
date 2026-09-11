import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    UnauthorizedError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { Attendance, AttendanceType } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class AttendanceRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز لتسجيل الحضور.",
      );
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Checks if attendance has already been recorded for this student in this session.
   * Strictly scopes query to the active authenticated center.
   */
  static isAlreadyAttended(sessionId: string, studentId: string): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>(
      "SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
      [centerId, sessionId, studentId],
    );
    return !!existing;
  }

  /**
   * Records student attendance offline in SQLite, enqueues sync operation, and records audit log.
   * Strictly verifies repository-level permission: attendance.create.
   */
  static async recordAttendance(params: {
    studentId: string;
    sessionId: string;
    status: "present" | "late";
    isLate: boolean;
    attendanceType?: AttendanceType;
    originalAbsenceId?: string;
    isExternal?: boolean;
    checkInTime?: string;
  }): Promise<Attendance> {
    const { centerId, user } = this.getActiveContext();

    if (
      !PermissionService.hasPermission(user.permissions, "attendance.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل الحضور.");
    }

    if (
      params.isExternal &&
      !PermissionService.hasPermission(user.permissions, "attendance.external")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل حضور طالب خارجي.");
    }

    if (
      params.attendanceType === "makeup" &&
      !PermissionService.hasPermission(user.permissions, "attendance.makeup")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل حضور تعويضي.");
    }

    const db = DatabaseService.getDb();

    // Check session status
    const session = db.getFirstSync<any>(
      `SELECT status FROM sessions WHERE center_id = ? AND id = ?`,
      [centerId, params.sessionId],
    );
    if (session?.status === "closed") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة مغلقة.");
    }
    if (session?.status === "cancelled") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة ملغاة.");
    }

    // Check duplicate
    if (this.isAlreadyAttended(params.sessionId, params.studentId)) {
      throw new ConflictError("تم تسجيل حضور الطالب مسبقًا لهذه الحصة.");
    }

    const attendanceId = `att-${generateUUID()}`;
    const operationId = `op-att-${generateUUID()}`;
    const deviceId = await DeviceService.getDeviceId();

    const now = new Date();
    const checkInTime =
      params.checkInTime ||
      `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(
        now.getSeconds(),
      ).padStart(2, "0")}`;

    const attendanceType = params.attendanceType || "present";
    const isLateInt = params.isLate ? 1 : 0;
    const isExternalInt = params.isExternal ? 1 : 0;

    // 1. Save to SQLite immediately (with UNIQUE constraint safety)
    try {
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attendanceId,
          centerId,
          params.studentId,
          params.sessionId,
          checkInTime,
          params.status,
          isLateInt,
          attendanceType,
          params.originalAbsenceId || null,
          isExternalInt,
          operationId,
        ],
      );
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        throw new ConflictError("تم تسجيل حضور الطالب مسبقًا لهذه الحصة.");
      }
      throw err;
    }

    // 2. If external makeup/attendance, record cash session payment (NO monthly debt)
    if (params.isExternal) {
      const session = db.getFirstSync<any>(
        `SELECT session_price as sessionPrice FROM sessions WHERE center_id = ? AND id = ?`,
        [centerId, params.sessionId],
      );
      const sessionPrice = Number(session?.sessionPrice ?? 0);
      if (sessionPrice > 0) {
        const payId = `pay-${generateUUID()}`;
        const payOpId = `op-pay-ext-${generateUUID()}`;
        const payDate = now.toISOString().slice(0, 10);

        db.runSync(
          `INSERT INTO payments (id, operation_id, center_id, student_id, session_id, amount, payment_type, payment_method, payment_date, is_reversed, notes, created_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, 'session', 'cash', ?, 0, 'حضور خارجي', ?, ?)`,
          [
            payId,
            payOpId,
            centerId,
            params.studentId,
            params.sessionId,
            sessionPrice,
            payDate,
            now.toISOString(),
            user.id,
          ],
        );

        SyncRepository.enqueueOperation({
          operationId: payOpId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment.create",
          entityType: "payment",
          entityId: payId,
          payload: {
            id: payId,
            operationId: payOpId,
            centerId,
            studentId: params.studentId,
            sessionId: params.sessionId,
            amount: sessionPrice,
            paymentType: "session",
            paymentMethod: "cash",
            paymentDate: payDate,
            notes: "حضور خارجي",
            isReversed: false,
            createdAt: now.toISOString(),
            userId: user.id,
          },
        });

        AuditService.recordEvent({
          operationId: payOpId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "payment",
          entityId: payId,
          action: "payment.create_external_session",
          payload: {
            sessionId: params.sessionId,
            amount: sessionPrice,
          },
        });
      }
    }

    const attendanceRecord: Attendance = {
      id: attendanceId,
      centerId,
      studentId: params.studentId,
      sessionId: params.sessionId,
      checkInTime,
      status: params.status,
      isLate: params.isLate,
      attendanceType,
      originalAbsenceId: params.originalAbsenceId,
      isExternal: Boolean(params.isExternal),
      operationId,
    };

    // 3. Create sync operation in sync queue
    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: attendanceId,
      payload: attendanceRecord,
      operationId,
    });

    // 4. Create audit log
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "attendance",
      entityId: attendanceId,
      action: "attendance.record",
      payload: {
        status: params.status,
        isLate: params.isLate,
        attendanceType,
        isExternal: Boolean(params.isExternal),
      },
    });

    return attendanceRecord;
  }

  /**
   * Retrieves attendance history for a session in the active center.
   */
  static getSessionAttendance(sessionId: string): Attendance[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "attendance.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              check_in_time as checkInTime, status, is_late = 1 as isLate,
              attendance_type as attendanceType, original_absence_id as originalAbsenceId,
              is_external = 1 as isExternal,
              operation_id as operationId
       FROM attendance
       WHERE center_id = ? AND session_id = ?
       ORDER BY check_in_time DESC`,
      [centerId, sessionId],
    );
  }

  /**
   * Retrieves attendance history for a student across all sessions in the active center.
   */
  static getStudentAttendance(studentId: string): Attendance[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "attendance.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              check_in_time as checkInTime, status, is_late = 1 as isLate,
              attendance_type as attendanceType, original_absence_id as originalAbsenceId,
              is_external = 1 as isExternal,
              operation_id as operationId
       FROM attendance
       WHERE center_id = ? AND student_id = ?
       ORDER BY check_in_time DESC`,
      [centerId, studentId],
    );
  }
}
