import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService, RolePermissions, resolveUserPermissions } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Permission, Teacher } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

export interface CreateTeacherDTO {
  name: string;
  phone?: string;
  notes?: string;
}

export interface UpdateTeacherDTO {
  name?: string;
  phone?: string;
  notes?: string;
  status?: "active" | "inactive";
}

export class TeacherRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    const permissions = resolveUserPermissions(currentUser);
    const user = { ...currentUser, permissions };
    return { centerId: activeCenterId, user };
  }

  static getAll(includeInactive = false): Teacher[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "teachers.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المعلمين.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<Teacher>(
      `SELECT id, center_id as centerId, name, phone, status, notes, created_at as createdAt, updated_at as updatedAt
       FROM teachers
       WHERE center_id = ?
       ORDER BY name ASC`,
      [centerId],
    );

    return includeInactive ? rows : rows.filter((r) => r.status === "active");
  }

  static findById(teacherId: string): Teacher | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "teachers.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المعلمين.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<Teacher>(
      `SELECT id, center_id as centerId, name, phone, status, notes, created_at as createdAt, updated_at as updatedAt
       FROM teachers
       WHERE center_id = ? AND id = ?`,
      [centerId, teacherId],
    );

    return row || null;
  }

  static createTeacher(dto: CreateTeacherDTO): Teacher {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "teachers.create")) {
      throw new ForbiddenError("ليس لديك صلاحية إضافة معلم جديد.");
    }

    if (!dto.name || !dto.name.trim()) {
      throw new ValidationError("اسم المعلم مطلوب.");
    }

    const db = DatabaseService.getDb();
    const teacherId = `teach-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const name = dto.name.trim();
    const phone = dto.phone?.trim() || null;
    const notes = dto.notes?.trim() || null;

    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [teacherId, centerId, name, phone, notes, now],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-teach-create-${Date.now()}-${teacherId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "teacher",
      entityId: teacherId,
      action: "teacher.create",
      payload: { name, phone },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        teacherId,
        name,
        phone,
        notes,
        status: "active",
        createdAt: now,
      },
    });

    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync teacher notice:", err);
    });

    return {
      id: teacherId,
      centerId,
      name,
      phone: phone ?? undefined,
      notes: notes ?? undefined,
      status: "active",
      createdAt: now,
    };
  }

  static updateTeacher(teacherId: string, dto: UpdateTeacherDTO): Teacher {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "teachers.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل بيانات المعلم.");
    }

    const existing = this.findById(teacherId);
    if (!existing) {
      throw new NotFoundError("المعلم غير موجود.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const name = dto.name !== undefined ? dto.name.trim() : existing.name;
    const phone =
      dto.phone !== undefined ? dto.phone.trim() : (existing.phone ?? null);
    const notes =
      dto.notes !== undefined ? dto.notes.trim() : (existing.notes ?? null);
    const status = dto.status || existing.status;

    db.runSync(
      `UPDATE teachers
       SET name = ?, phone = ?, notes = ?, status = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [name, phone, notes, status, now, centerId, teacherId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-teach-update-${Date.now()}-${teacherId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "teacher",
      entityId: teacherId,
      action: "teacher.update",
      payload: { name, phone, status },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        teacherId,
        name,
        phone,
        notes,
        status,
        updatedAt: now,
      },
    });

    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync teacher update notice:", err);
    });

    return {
      ...existing,
      name,
      phone: phone ?? undefined,
      notes: notes ?? undefined,
      status,
      updatedAt: now,
    };
  }

  static deactivateTeacher(teacherId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "teachers.deactivate")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء تفعيل المعلم.");
    }

    const existing = this.findById(teacherId);
    if (!existing) {
      throw new NotFoundError("المعلم غير موجود.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    db.runSync(
      `UPDATE teachers SET status = 'inactive', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, teacherId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-teach-deact-${Date.now()}-${teacherId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "teacher",
      entityId: teacherId,
      action: "teacher.deactivate",
      payload: { name: existing.name },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "teacher",
      entityId: teacherId,
      payload: { status: "inactive", updatedAt: now },
    });
  }
}
