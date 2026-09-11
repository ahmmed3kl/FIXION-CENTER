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
import { StudentGroupEnrollment } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "../groups/GroupRepository";
import { StudentRepository } from "../students/StudentRepository";

export interface EnrollStudentDTO {
  studentId: string;
  groupId: string;
  startDate: string;
  endDate?: string | null;
  specialMonthlyPrice?: number | null;
}

export class EnrollmentRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  static getActiveEnrollmentsForStudent(
    studentId: string,
  ): StudentGroupEnrollment[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "enrollments.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات التسجيل.");
    }

    const db = DatabaseService.getDb();
    return db.getAllSync<StudentGroupEnrollment>(
      `SELECT e.id, e.center_id as centerId, e.student_id as studentId, e.group_id as groupId,
              e.start_date as startDate, e.end_date as endDate, e.status, e.special_monthly_price as specialMonthlyPrice,
              e.created_at as createdAt, e.updated_at as updatedAt,
              s.full_name as studentName, g.name as groupName
       FROM student_group_enrollments e
       LEFT JOIN students s ON e.student_id = s.id
       LEFT JOIN groups g ON e.group_id = g.id
       WHERE e.center_id = ? AND e.student_id = ? AND e.status = 'active'
       ORDER BY e.start_date DESC`,
      [centerId, studentId],
    );
  }

  static getActiveEnrollmentsForGroup(
    groupId: string,
    targetDate?: string,
  ): StudentGroupEnrollment[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "enrollments.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات التسجيل.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<StudentGroupEnrollment>(
      `SELECT e.id, e.center_id as centerId, e.student_id as studentId, e.group_id as groupId,
              e.start_date as startDate, e.end_date as endDate, e.status, e.special_monthly_price as specialMonthlyPrice,
              e.created_at as createdAt, e.updated_at as updatedAt,
              s.full_name as studentName, g.name as groupName
       FROM student_group_enrollments e
       LEFT JOIN students s ON e.student_id = s.id
       LEFT JOIN groups g ON e.group_id = g.id
       WHERE e.center_id = ? AND e.group_id = ? AND e.status = 'active'
       ORDER BY s.full_name ASC`,
      [centerId, groupId],
    );

    if (!targetDate) return rows;

    // Filter by active validity on targetDate: startDate <= targetDate AND (endDate IS NULL OR endDate >= targetDate)
    return rows.filter(
      (e) =>
        e.startDate <= targetDate && (!e.endDate || e.endDate >= targetDate),
    );
  }

  static enrollStudent(dto: EnrollStudentDTO): StudentGroupEnrollment {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "enrollments.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل الطالب في المجموعة.");
    }

    if (!dto.studentId) {
      throw new ValidationError("يجب تحديد الطالب.");
    }
    if (!dto.groupId) {
      throw new ValidationError("يجب تحديد المجموعة.");
    }
    if (!dto.startDate) {
      throw new ValidationError("تاريخ بدء الاشتراك مطلوب.");
    }

    const student = StudentRepository.findById(dto.studentId);
    if (!student || student.status !== "active") {
      throw new ValidationError("الطالب غير موجود أو غير مفعل في هذا المركز.");
    }

    const group = GroupRepository.findById(dto.groupId);
    if (!group || group.status !== "active") {
      throw new ValidationError(
        "المجموعة غير موجودة أو غير مفعلة في هذا المركز.",
      );
    }

    // Validation: prevent duplicate active enrollment for the same student in the same group
    const existingActive = this.getActiveEnrollmentsForStudent(
      dto.studentId,
    ).filter((e) => e.groupId === dto.groupId && e.status === "active");

    if (existingActive.length > 0) {
      throw new ConflictError(
        `الطالب (${student.fullName}) مسجل بالفعل في هذه المجموعة باشتراك فعال.`,
      );
    }

    const db = DatabaseService.getDb();
    const enrollmentId = `enr-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const endDate = dto.endDate || null;
    const specialPrice = dto.specialMonthlyPrice ?? null;

    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, special_monthly_price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        enrollmentId,
        centerId,
        dto.studentId,
        dto.groupId,
        dto.startDate,
        endDate,
        specialPrice,
        now,
      ],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-enr-create-${Date.now()}-${enrollmentId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "enrollment",
      entityId: enrollmentId,
      action: "enrollment.create",
      payload: {
        studentId: dto.studentId,
        groupId: dto.groupId,
        startDate: dto.startDate,
        specialPrice,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "enrollment",
      entityId: enrollmentId,
      payload: {
        studentId: dto.studentId,
        groupId: dto.groupId,
        startDate: dto.startDate,
        endDate,
        specialMonthlyPrice: specialPrice,
        status: "active",
        createdAt: now,
      },
    });

    return {
      id: enrollmentId,
      centerId,
      studentId: dto.studentId,
      groupId: dto.groupId,
      startDate: dto.startDate,
      endDate: endDate ?? undefined,
      status: "active",
      specialMonthlyPrice: specialPrice ?? undefined,
      createdAt: now,
      studentName: student.fullName,
      groupName: group.name,
    };
  }

  static endEnrollment(enrollmentId: string, endDate: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "enrollments.end")) {
      throw new ForbiddenError(
        "ليس لديك صلاحية إنهاء تسجيل الطالب في المجموعة.",
      );
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<StudentGroupEnrollment>(
      `SELECT id, student_id as studentId, group_id as groupId FROM student_group_enrollments WHERE center_id = ? AND id = ?`,
      [centerId, enrollmentId],
    );

    if (!existing) {
      throw new NotFoundError("سجل التسجيل غير موجود.");
    }

    const now = new Date().toISOString();
    db.runSync(
      `UPDATE student_group_enrollments SET status = 'ended', end_date = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
      [endDate, now, centerId, enrollmentId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-enr-end-${Date.now()}-${enrollmentId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "enrollment",
      entityId: enrollmentId,
      action: "enrollment.end",
      payload: {
        studentId: existing.studentId,
        groupId: existing.groupId,
        endDate,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "enrollment",
      entityId: enrollmentId,
      payload: { status: "ended", endDate, updatedAt: now },
    });
  }
}
