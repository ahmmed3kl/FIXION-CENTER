import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { useAuthStore } from "../auth/useAuthStore";
import { isStudentColor, StudentColor } from "./studentColor";

export class StudentColorRepository {
  static setColor(studentId: string, color: StudentColor | null): void {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    if (!PermissionService.hasPermission(currentUser.permissions, "students.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تغيير لون الطالب.");
    }
    if (color !== null && !isStudentColor(color)) {
      throw new ValidationError("لون الطالب المحدد غير صالح.");
    }

    const db = DatabaseService.getDb();
    const student = db.getFirstSync<{ deletedAt: string | null; studentColor: string | null }>(
      `SELECT deleted_at as deletedAt, student_color as studentColor
       FROM students
       WHERE center_id = ? AND id = ?`,
      [activeCenterId, studentId],
    );
    if (!student) throw new NotFoundError("الطالب غير موجود في المركز الحالي.");
    if (student.deletedAt) throw new ConflictError("لا يمكن تغيير لون طالب مؤرشف.");
    if ((student.studentColor || null) === color) return;

    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-scolor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const action = color === null ? "student.color.reset" : "student.color.update";

    DatabaseService.runInTransaction(() => {
      const result = db.runSync(
        `UPDATE students
         SET student_color = ?
         WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
        [color, activeCenterId, studentId],
      );
      if (result.changes !== 1) {
        throw new NotFoundError("تعذر العثور على الطالب في المركز الحالي.");
      }

      AuditService.recordEvent({
        operationId,
        centerId: activeCenterId,
        userId: currentUser.id,
        deviceId,
        entityType: "student_color",
        entityId: studentId,
        action,
        payload: { studentId, studentColor: color, actorName: currentUser.fullName },
      });

      SyncRepository.enqueueOperation({
        operationId,
        centerId: activeCenterId,
        userId: currentUser.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "student_color",
        entityId: studentId,
        payload: { studentId, studentColor: color, updatedAt: now, action },
      });
    });

    SyncEngine.syncCenterNow(activeCenterId).catch((error) => {
      console.warn("Background student color sync failed:", error);
    });
  }
}
