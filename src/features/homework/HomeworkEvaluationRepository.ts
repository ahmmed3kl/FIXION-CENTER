import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { HomeworkEvaluationStatus, SessionHomeworkEvaluation } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export class HomeworkEvaluationRepository {
  private static context() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    return { centerId: activeCenterId, user: currentUser };
  }

  private static requireView(): { centerId: string; user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]> } {
    const context = this.context();
    if (!PermissionService.hasAnyPermission(context.user.permissions, [
      "grades.view", "grades.manage", "attendance.view", "attendance.create", "students.profile.view", "notifications.send",
    ])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تقييمات الواجب.");
    }
    return context;
  }

  private static requireAssignment(): { centerId: string; user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]> } {
    const context = this.context();
    if (!PermissionService.hasAnyPermission(context.user.permissions, ["grades.manage", "attendance.create", "attendance.edit"])) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل تقييم الواجب.");
    }
    return context;
  }

  private static requireManagement(): { centerId: string; user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]> } {
    const context = this.context();
    if (!PermissionService.hasPermission(context.user.permissions, "homework.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية إدارة حالات تقييم الواجب.");
    }
    return context;
  }

  static listStatuses(includeInactive = false): HomeworkEvaluationStatus[] {
    const { centerId } = this.requireView();
    return DatabaseService.getDb().getAllSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses
       WHERE center_id = ? AND status ${includeInactive ? "!= 'deleted'" : "= 'active'"}
       ORDER BY name COLLATE NOCASE`,
      [centerId],
    );
  }

  static createStatus(name: string): HomeworkEvaluationStatus {
    const { centerId, user } = this.requireManagement();
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new ValidationError("أدخل اسمًا للحالة لا يتجاوز 120 حرفًا.");
    const db = DatabaseService.getDb();
    const duplicate = db.getFirstSync<any>(
      `SELECT id FROM homework_evaluation_statuses
       WHERE center_id = ? AND lower(name) = lower(?) AND status != 'deleted'`,
      [centerId, cleanName],
    );
    if (duplicate) throw new ConflictError("حالة بهذا الاسم موجودة بالفعل.");

    const now = new Date().toISOString();
    const status: HomeworkEvaluationStatus = { id: id("hwstatus"), centerId, name: cleanName, status: "active", createdAt: now, updatedAt: now };
    const operationId = id("op-hwstatus-create");
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO homework_evaluation_statuses (id, center_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
        [status.id, centerId, cleanName, now, now],
      );
      AuditService.recordEvent({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status", entityId: status.id,
        action: "homework_evaluation_status.create", payload: { name: cleanName, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        operationType: "CREATE", entityType: "homework_evaluation_status", entityId: status.id,
        payload: { ...status, center_id: centerId, created_at: now, updated_at: now },
      });
    });
    SyncEngine.syncCenterNow(centerId).catch((error) => console.warn("Background homework status sync notice:", error));
    return status;
  }

  static updateStatus(statusId: string, updates: { name?: string; status?: "active" | "inactive" }): HomeworkEvaluationStatus {
    const { centerId, user } = this.requireManagement();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses WHERE center_id = ? AND id = ? AND status != 'deleted'`,
      [centerId, statusId],
    );
    if (!existing) throw new NotFoundError("حالة تقييم الواجب غير موجودة.");
    const name = updates.name === undefined ? existing.name : updates.name.trim();
    const status = updates.status || existing.status;
    if (!name || name.length > 120) throw new ValidationError("أدخل اسمًا صحيحًا للحالة.");
    const duplicate = db.getFirstSync<any>(
      `SELECT id FROM homework_evaluation_statuses
       WHERE center_id = ? AND lower(name) = lower(?) AND id != ? AND status != 'deleted'`,
      [centerId, name, statusId],
    );
    if (duplicate) throw new ConflictError("حالة بهذا الاسم موجودة بالفعل.");
    const now = new Date().toISOString();
    const operationId = id("op-hwstatus-update");
    const result = { ...existing, name, status, updatedAt: now };
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE homework_evaluation_statuses SET name = ?, status = ?, updated_at = ?
         WHERE center_id = ? AND id = ? AND status != 'deleted'`,
        [name, status, now, centerId, statusId],
      );
      AuditService.recordEvent({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status", entityId: statusId,
        action: "homework_evaluation_status.update", payload: { name, status, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        operationType: "UPDATE", entityType: "homework_evaluation_status", entityId: statusId,
        payload: { ...result, center_id: centerId, updated_at: now },
      });
    });
    SyncEngine.syncCenterNow(centerId).catch((error) => console.warn("Background homework status sync notice:", error));
    return result;
  }

  static removeStatus(statusId: string): void {
    const { centerId, user } = this.requireManagement();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses WHERE center_id = ? AND id = ? AND status != 'deleted'`,
      [centerId, statusId],
    );
    if (!existing) throw new NotFoundError("حالة تقييم الواجب غير موجودة.");
    const usage = db.getAllSync<{ id: string }>(
      `SELECT id FROM session_homework_evaluations
       WHERE center_id = ? AND status_id = ?`,
      [centerId, statusId],
    );
    if (usage.length > 0) {
      throw new ConflictError("لا يمكن حذف حالة استُخدمت في سجل واجب. يمكنك تعطيلها بدلًا من ذلك.");
    }
    const now = new Date().toISOString();
    const operationId = id("op-hwstatus-delete");
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE homework_evaluation_statuses SET status = 'deleted', updated_at = ?
         WHERE center_id = ? AND id = ? AND status != 'deleted'`,
        [now, centerId, statusId],
      );
      AuditService.recordEvent({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status", entityId: statusId,
        action: "homework_evaluation_status.delete", payload: { name: existing.name, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        operationType: "UPDATE", entityType: "homework_evaluation_status", entityId: statusId,
        payload: { id: statusId, status: "deleted", updatedAt: now, updated_at: now },
      });
    });
    SyncEngine.syncCenterNow(centerId).catch((error) => console.warn("Background homework status sync notice:", error));
  }

  static getForSession(sessionId: string, studentId: string): SessionHomeworkEvaluation | null {
    const { centerId } = this.requireView();
    const row = DatabaseService.getDb().getFirstSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND session_id = ? AND student_id = ? AND deleted_at IS NULL`,
      [centerId, sessionId, studentId],
    );
    if (!row) return null;
    return { ...row, statusName: this.getStatusName(centerId, row.statusId) };
  }

  static getForStudent(studentId: string): SessionHomeworkEvaluation[] {
    const { centerId } = this.requireView();
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND student_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );
    return rows.map((row) => {
      const session = db.getFirstSync<any>(
        `SELECT session_date as sessionDate, group_id as groupId
         FROM sessions WHERE center_id = ? AND id = ?`,
        [centerId, row.sessionId],
      );
      const group = session?.groupId
        ? db.getFirstSync<any>("SELECT name FROM groups WHERE center_id = ? AND id = ?", [centerId, session.groupId])
        : null;
      const attendance = db.getFirstSync<any>(
        `SELECT status FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, row.sessionId, studentId],
      );
      return {
        ...row,
        statusName: this.getStatusName(centerId, row.statusId),
        sessionDate: session?.sessionDate,
        groupName: group?.name,
        attendanceStatus: attendance?.status,
      };
    });
  }

  static setForSession(sessionId: string, studentId: string, statusId: string | null): SessionHomeworkEvaluation | null {
    const { centerId, user } = this.requireAssignment();
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<any>("SELECT id FROM sessions WHERE center_id = ? AND id = ?", [centerId, sessionId]);
    if (!session) throw new NotFoundError("الحصة غير موجودة في هذا المركز.");
    const student = db.getFirstSync<any>(
      "SELECT id FROM students WHERE center_id = ? AND id = ? AND deleted_at IS NULL",
      [centerId, studentId],
    );
    if (!student) throw new NotFoundError("الطالب غير موجود في هذا المركز.");
    const existing = db.getFirstSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (!statusId && (!existing || existing.deletedAt)) return null;
    if (statusId) {
      const status = db.getFirstSync<any>(
        `SELECT id FROM homework_evaluation_statuses
         WHERE center_id = ? AND id = ? AND status = 'active'`,
        [centerId, statusId],
      );
      if (!status) throw new ValidationError("حالة تقييم الواجب غير متاحة في هذا المركز.");
    }

    const now = new Date().toISOString();
    const operationId = id("op-hweval");
    let result: SessionHomeworkEvaluation | null = null;
    DatabaseService.runInTransaction(() => {
      if (statusId) {
        const evaluationId = existing?.id || id("hweval");
        const createdAt = existing?.createdAt || now;
        db.runSync(
          `INSERT INTO session_homework_evaluations
             (id, center_id, student_id, session_id, status_id, created_at, updated_at, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(center_id, student_id, session_id) DO UPDATE SET
             status_id = excluded.status_id, updated_at = excluded.updated_at,
             deleted_at = NULL, deleted_by = NULL`,
          [evaluationId, centerId, studentId, sessionId, statusId, createdAt, now],
        );
        result = { id: evaluationId, centerId, studentId, sessionId, statusId, statusName: this.getStatusName(centerId, statusId), createdAt, updatedAt: now, deletedAt: null };
      } else if (existing) {
        db.runSync(
          `UPDATE session_homework_evaluations SET deleted_at = ?, deleted_by = ?, updated_at = ?
           WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
          [now, user.id, now, centerId, existing.id],
        );
        result = null;
      }
      const action = statusId ? (existing ? "homework_evaluation.update" : "homework_evaluation.create") : "homework_evaluation.delete";
      AuditService.recordEvent({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        entityType: "session_homework_evaluation", entityId: existing?.id || result?.id || "",
        action, payload: { studentId, sessionId, statusId, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(),
        operationType: existing ? "UPDATE" : "CREATE",
        entityType: "session_homework_evaluation",
        entityId: existing?.id || result?.id || "",
        payload: {
          ...(existing || result || {}),
          id: existing?.id || result?.id || "",
          center_id: centerId, student_id: studentId, session_id: sessionId, status_id: statusId,
          deleted_at: statusId ? null : now, deleted_by: statusId ? null : user.id,
          updated_at: now, updatedAt: now,
        },
      });
    });
    SyncEngine.syncCenterNow(centerId).catch((error) => console.warn("Background homework evaluation sync notice:", error));
    return result;
  }

  private static getStatusName(centerId: string, statusId: string): string | undefined {
    return DatabaseService.getDb().getFirstSync<{ name: string }>(
      `SELECT name FROM homework_evaluation_statuses
       WHERE center_id = ? AND id = ?`,
      [centerId, statusId],
    )?.name;
  }
}
