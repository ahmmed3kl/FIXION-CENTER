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
import { Group } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SubjectRepository } from "../subjects/SubjectRepository";
import { TeacherRepository } from "../teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../teachers/TeacherSubjectRepository";

export interface CreateGroupDTO {
  name: string;
  teacherId: string;
  subjectId: string;
  grade: string;
  defaultFee?: number;
  sessionPrice: number;
  monthlyPrice: number;
  sessionDurationMinutes?: number;
  lateAfterMinutes?: number;
}

export interface UpdateGroupDTO {
  name?: string;
  teacherId?: string;
  subjectId?: string;
  grade?: string;
  sessionPrice?: number;
  monthlyPrice?: number;
  sessionDurationMinutes?: number;
  lateAfterMinutes?: number;
  status?: "active" | "inactive";
}

export class GroupRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    // Normalize permissions — they may be missing/malformed after JSON.parse from SecureStorage
    const user = {
      ...currentUser,
      permissions: Array.isArray(currentUser.permissions)
        ? currentUser.permissions
        : [],
    };
    return { centerId: activeCenterId, user };
  }

  static getAll(includeInactive = false): Group[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المجموعات.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<Group>(
      `SELECT g.id, g.center_id as centerId, g.name, g.teacher_id as teacherId, g.subject_id as subjectId,
              g.grade, g.default_fee as defaultFee, g.session_price as sessionPrice, g.monthly_price as monthlyPrice,
              g.session_duration_minutes as sessionDurationMinutes, g.late_after_minutes as lateAfterMinutes,
              g.status, g.created_at as createdAt, g.updated_at as updatedAt,
              t.name as teacherName, s.name as subjectName
       FROM groups g
       LEFT JOIN teachers t ON g.teacher_id = t.id
       LEFT JOIN subjects s ON g.subject_id = s.id
       WHERE g.center_id = ?
       ORDER BY g.name ASC`,
      [centerId],
    );

    return includeInactive ? rows : rows.filter((r) => r.status === "active");
  }

  static findById(groupId: string): Group | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المجموعات.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<Group>(
      `SELECT g.id, g.center_id as centerId, g.name, g.teacher_id as teacherId, g.subject_id as subjectId,
              g.grade, g.default_fee as defaultFee, g.session_price as sessionPrice, g.monthly_price as monthlyPrice,
              g.session_duration_minutes as sessionDurationMinutes, g.late_after_minutes as lateAfterMinutes,
              g.status, g.created_at as createdAt, g.updated_at as updatedAt,
              t.name as teacherName, s.name as subjectName
       FROM groups g
       LEFT JOIN teachers t ON g.teacher_id = t.id
       LEFT JOIN subjects s ON g.subject_id = s.id
       WHERE g.center_id = ? AND g.id = ?`,
      [centerId, groupId],
    );

    return row || null;
  }

  static createGroup(dto: CreateGroupDTO): Group {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.create")) {
      throw new ForbiddenError("ليس لديك صلاحية إنشاء مجموعة جديدة.");
    }

    if (!dto.name || !dto.name.trim()) {
      throw new ValidationError("اسم المجموعة مطلوب.");
    }
    if (!dto.teacherId || !dto.teacherId.trim()) {
      throw new ValidationError("يجب تحديد المعلم.");
    }
    if (!dto.subjectId || !dto.subjectId.trim()) {
      throw new ValidationError("يجب تحديد المادة الدراسية.");
    }
    if (!dto.grade || !dto.grade.trim()) {
      throw new ValidationError("المرحلة الدراسية مطلوبة.");
    }

    const teacher = TeacherRepository.findById(dto.teacherId);
    if (!teacher || teacher.status !== "active") {
      throw new ValidationError(
        "المعلم المحدد غير متاح أو غير مفعل في هذا المركز.",
      );
    }

    const subject = SubjectRepository.findById(dto.subjectId);
    if (!subject || subject.status !== "active") {
      throw new ValidationError(
        "المادة المحددة غير متاحة أو غير مفعلة في هذا المركز.",
      );
    }

    // MANDATORY VALIDATION: Teacher must be assigned to subject
    const isAssigned = TeacherSubjectRepository.isTeacherAssignedToSubject(
      dto.teacherId,
      dto.subjectId,
    );
    if (!isAssigned) {
      throw new ValidationError(
        `المعلم (${teacher.name}) غير مخصص لتدريس مادة (${subject.name}) في هذا المركز.`,
      );
    }

    const db = DatabaseService.getDb();
    const groupId = `grp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const name = dto.name.trim();
    const sessionPrice = dto.sessionPrice ?? dto.defaultFee ?? 0;
    const monthlyPrice = dto.monthlyPrice ?? dto.defaultFee ?? 0;
    const sessionDurationMinutes = dto.sessionDurationMinutes ?? 120;
    const lateAfterMinutes = dto.lateAfterMinutes ?? 15;
    const defaultFee = dto.defaultFee ?? sessionPrice;

    db.runSync(
      `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        groupId,
        centerId,
        name,
        dto.teacherId,
        dto.subjectId,
        dto.grade.trim(),
        defaultFee,
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        now,
      ],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-grp-create-${Date.now()}-${groupId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group",
      entityId: groupId,
      action: "group.create",
      payload: {
        name,
        teacherId: dto.teacherId,
        subjectId: dto.subjectId,
        grade: dto.grade,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "group",
      entityId: groupId,
      payload: {
        name,
        teacherId: dto.teacherId,
        subjectId: dto.subjectId,
        grade: dto.grade.trim(),
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        status: "active",
        createdAt: now,
      },
    });

    return {
      id: groupId,
      centerId,
      name,
      teacherId: dto.teacherId,
      subjectId: dto.subjectId,
      grade: dto.grade.trim(),
      defaultFee,
      sessionPrice,
      monthlyPrice,
      sessionDurationMinutes,
      lateAfterMinutes,
      status: "active",
      createdAt: now,
      teacherName: teacher.name,
      subjectName: subject.name,
    };
  }

  static updateGroup(groupId: string, dto: UpdateGroupDTO): Group {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل بيانات المجموعة.");
    }

    const existing = this.findById(groupId);
    if (!existing) {
      throw new NotFoundError("المجموعة غير موجودة.");
    }

    const teacherId = dto.teacherId ?? existing.teacherId;
    const subjectId = dto.subjectId ?? existing.subjectId;

    if (dto.teacherId || dto.subjectId) {
      const isAssigned = TeacherSubjectRepository.isTeacherAssignedToSubject(
        teacherId,
        subjectId,
      );
      if (!isAssigned) {
        throw new ValidationError(
          "المعلم غير مخصص لتدريس هذه المادة الدراسية.",
        );
      }
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const name = dto.name !== undefined ? dto.name.trim() : existing.name;
    const grade = dto.grade !== undefined ? dto.grade.trim() : existing.grade;
    const sessionPrice =
      dto.sessionPrice !== undefined ? dto.sessionPrice : existing.sessionPrice;
    const monthlyPrice =
      dto.monthlyPrice !== undefined ? dto.monthlyPrice : existing.monthlyPrice;
    const sessionDurationMinutes =
      dto.sessionDurationMinutes !== undefined
        ? dto.sessionDurationMinutes
        : existing.sessionDurationMinutes;
    const lateAfterMinutes =
      dto.lateAfterMinutes !== undefined
        ? dto.lateAfterMinutes
        : existing.lateAfterMinutes;
    const status = dto.status || existing.status;

    db.runSync(
      `UPDATE groups
       SET name = ?, teacher_id = ?, subject_id = ?, grade = ?, session_price = ?, monthly_price = ?, session_duration_minutes = ?, late_after_minutes = ?, status = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [
        name,
        teacherId,
        subjectId,
        grade,
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        status,
        now,
        centerId,
        groupId,
      ],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-grp-update-${Date.now()}-${groupId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group",
      entityId: groupId,
      action: "group.update",
      payload: { name, teacherId, subjectId, status },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "group",
      entityId: groupId,
      payload: {
        name,
        teacherId,
        subjectId,
        grade,
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        status,
        updatedAt: now,
      },
    });

    return {
      ...existing,
      name,
      teacherId,
      subjectId,
      grade,
      sessionPrice,
      monthlyPrice,
      sessionDurationMinutes,
      lateAfterMinutes,
      status,
      updatedAt: now,
    };
  }

  static deactivateGroup(groupId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "groups.deactivate")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء تفعيل المجموعة.");
    }

    const existing = this.findById(groupId);
    if (!existing) {
      throw new NotFoundError("المجموعة غير موجودة.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    db.runSync(
      `UPDATE groups SET status = 'inactive', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, groupId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-grp-deact-${Date.now()}-${groupId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group",
      entityId: groupId,
      action: "group.deactivate",
      payload: { name: existing.name },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "group",
      entityId: groupId,
      payload: { status: "inactive", updatedAt: now },
    });
  }
}
