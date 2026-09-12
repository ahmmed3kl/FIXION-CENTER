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
import { Subject } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

export interface CreateSubjectDTO {
  name: string;
  code: string;
}

export interface UpdateSubjectDTO {
  name?: string;
  code?: string;
  status?: "active" | "inactive";
}

export class SubjectRepository {
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

  static getAll(includeInactive = false): Subject[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "subjects.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المواد الدراسية.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<Subject>(
      `SELECT id, center_id as centerId, name, code, status, created_at as createdAt, updated_at as updatedAt
       FROM subjects
       WHERE center_id = ?
       ORDER BY name ASC`,
      [centerId],
    );

    return includeInactive ? rows : rows.filter((r) => r.status === "active");
  }

  static findById(subjectId: string): Subject | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "subjects.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المواد الدراسية.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<Subject>(
      `SELECT id, center_id as centerId, name, code, status, created_at as createdAt, updated_at as updatedAt
       FROM subjects
       WHERE center_id = ? AND id = ?`,
      [centerId, subjectId],
    );

    return row || null;
  }

  static findByCode(code: string): Subject | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<Subject>(
      `SELECT id, center_id as centerId, name, code, status, created_at as createdAt, updated_at as updatedAt
       FROM subjects
       WHERE center_id = ? AND code = ?`,
      [centerId, code.trim()],
    );

    return row || null;
  }

  static createSubject(dto: CreateSubjectDTO): Subject {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "subjects.create")) {
      throw new ForbiddenError("ليس لديك صلاحية إضافة مادة دراسية جديدة.");
    }

    if (!dto.name || !dto.name.trim()) {
      throw new ValidationError("اسم المادة مطلوب.");
    }
    if (!dto.code || !dto.code.trim()) {
      throw new ValidationError("كود المادة مطلوب.");
    }

    const trimmedCode = dto.code.trim().toUpperCase();
    const existing = this.findByCode(trimmedCode);
    if (existing) {
      throw new ConflictError(
        `كود المادة (${trimmedCode}) مستخدم بالفعل في هذا المركز.`,
      );
    }

    const db = DatabaseService.getDb();
    const subjectId = `subj-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const name = dto.name.trim();

    db.runSync(
      `INSERT INTO subjects (id, center_id, name, code, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [subjectId, centerId, name, trimmedCode, now],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-subj-create-${Date.now()}-${subjectId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "subject",
      entityId: subjectId,
      action: "subject.create",
      payload: { name, code: trimmedCode },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "subject",
      entityId: subjectId,
      payload: { name, code: trimmedCode, status: "active", createdAt: now },
    });

    return {
      id: subjectId,
      centerId,
      name,
      code: trimmedCode,
      status: "active",
      createdAt: now,
    };
  }

  static updateSubject(subjectId: string, dto: UpdateSubjectDTO): Subject {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "subjects.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل بيانات المادة.");
    }

    const existing = this.findById(subjectId);
    if (!existing) {
      throw new NotFoundError("المادة غير موجودة.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const name = dto.name !== undefined ? dto.name.trim() : existing.name;
    const code =
      dto.code !== undefined ? dto.code.trim().toUpperCase() : existing.code;
    const status = dto.status || existing.status;

    if (code !== existing.code) {
      const codeTaken = this.findByCode(code);
      if (codeTaken && codeTaken.id !== subjectId) {
        throw new ConflictError(
          `كود المادة (${code}) مستخدم بالفعل في هذا المركز.`,
        );
      }
    }

    db.runSync(
      `UPDATE subjects
       SET name = ?, code = ?, status = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [name, code, status, now, centerId, subjectId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-subj-update-${Date.now()}-${subjectId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "subject",
      entityId: subjectId,
      action: "subject.update",
      payload: { name, code, status },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "subject",
      entityId: subjectId,
      payload: { name, code, status, updatedAt: now },
    });

    return {
      ...existing,
      name,
      code,
      status,
      updatedAt: now,
    };
  }

  static deactivateSubject(subjectId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "subjects.deactivate")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء تفعيل المادة الدراسية.");
    }

    const existing = this.findById(subjectId);
    if (!existing) {
      throw new NotFoundError("المادة غير موجودة.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    db.runSync(
      `UPDATE subjects SET status = 'inactive', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, subjectId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-subj-deact-${Date.now()}-${subjectId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "subject",
      entityId: subjectId,
      action: "subject.deactivate",
      payload: { name: existing.name },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "subject",
      entityId: subjectId,
      payload: { status: "inactive", updatedAt: now },
    });
  }
}
