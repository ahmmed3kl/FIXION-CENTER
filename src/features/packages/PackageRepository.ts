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
import { PermissionService, RolePermissions } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { Package, PackageSubject, Permission } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SubjectRepository } from "../subjects/SubjectRepository";
import { TeacherRepository } from "../teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../teachers/TeacherSubjectRepository";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class PackageRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز لإدارة الباقات.",
      );
    }
    const rawPermissions = currentUser.permissions;
    const permissions: Permission[] =
      Array.isArray(rawPermissions) && rawPermissions.length > 0
        ? rawPermissions
        : RolePermissions[currentUser.role as keyof typeof RolePermissions] ||
          RolePermissions.admin;
    const user = { ...currentUser, permissions };
    return { centerId: activeCenterId, user };
  }

  /**
   * Retrieves all packages for the active center.
   */
  static getPackages(includeInactive = false): Package[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الباقات.");
    }
    const db = DatabaseService.getDb();
    const query = includeInactive
      ? `SELECT id, center_id as centerId, name, price, description, status, created_at as createdAt, updated_at as updatedAt
         FROM packages WHERE center_id = ? ORDER BY name ASC`
      : `SELECT id, center_id as centerId, name, price, description, status, created_at as createdAt, updated_at as updatedAt
         FROM packages WHERE center_id = ? AND status = 'active' ORDER BY name ASC`;

    return db.getAllSync<Package>(query, [centerId]);
  }

  /**
   * Retrieves a package by ID within the active center.
   */
  static getPackageById(id: string): Package | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الباقات.");
    }
    const db = DatabaseService.getDb();
    return db.getFirstSync<Package>(
      `SELECT id, center_id as centerId, name, price, description, status, created_at as createdAt, updated_at as updatedAt
       FROM packages WHERE center_id = ? AND id = ?`,
      [centerId, id],
    );
  }

  /**
   * Retrieves all subjects assigned to a package.
   */
  static getPackageSubjects(packageId: string): PackageSubject[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تفاصيل الباقة.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<PackageSubject>(
      `SELECT ps.id, ps.center_id as centerId, ps.package_id as packageId, ps.subject_id as subjectId,
              ps.default_teacher_id as defaultTeacherId, ps.created_at as createdAt,
              s.name as subjectName, s.code as subjectCode, t.name as defaultTeacherName
       FROM package_subjects ps
       JOIN subjects s ON ps.subject_id = s.id
       JOIN teachers t ON ps.default_teacher_id = t.id
       WHERE ps.center_id = ? AND ps.package_id = ?`,
      [centerId, packageId],
    );
  }

  /**
   * Creates a new standalone package.
   */
  static async createPackage(data: {
    name: string;
    price: number;
    description?: string;
  }): Promise<Package> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.create")) {
      throw new ForbiddenError("ليس لديك صلاحية إنشاء باقة جديدة.");
    }

    if (!data.name || !data.name.trim()) {
      throw new ValidationError("اسم الباقة مطلوب.");
    }
    if (data.price === undefined || data.price === null || data.price < 0) {
      throw new ValidationError("سعر الباقة يجب أن يكون صفراً أو أكثر.");
    }

    const db = DatabaseService.getDb();
    const id = `pkg-${generateUUID()}`;
    const now = new Date().toISOString();
    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-pkg-create-${generateUUID()}`;

    db.runSync(
      `INSERT INTO packages (id, center_id, name, price, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        centerId,
        data.name.trim(),
        data.price,
        data.description?.trim() || null,
        "active",
        now,
        now,
      ],
    );

    const createdPackage: Package = {
      id,
      centerId,
      name: data.name.trim(),
      price: data.price,
      description: data.description?.trim() || null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.create",
      entityType: "package",
      entityId: id,
      payload: createdPackage,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package",
      entityId: id,
      action: "package.create",
      payload: { name: data.name, price: data.price },
    });

    return createdPackage;
  }

  /**
   * Updates package metadata (name, price, description, status).
   * Note: Changing package price affects ONLY future ungenerated debt cycles.
   */
  static async updatePackage(
    id: string,
    data: {
      name?: string;
      price?: number;
      description?: string;
      status?: "active" | "inactive";
    },
  ): Promise<Package> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل بيانات الباقة.");
    }

    const existing = this.getPackageById(id);
    if (!existing) {
      throw new NotFoundError("الباقة غير موجودة في هذا المركز.");
    }

    if (data.price !== undefined && data.price < 0) {
      throw new ValidationError("سعر الباقة يجب أن يكون صفراً أو أكثر.");
    }

    const updatedName =
      data.name !== undefined ? data.name.trim() : existing.name;
    const updatedPrice = data.price !== undefined ? data.price : existing.price;
    const updatedDesc =
      data.description !== undefined
        ? data.description.trim()
        : existing.description;
    const updatedStatus =
      data.status !== undefined ? data.status : existing.status;
    const now = new Date().toISOString();

    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE packages
       SET name = ?, price = ?, description = ?, status = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [
        updatedName,
        updatedPrice,
        updatedDesc,
        updatedStatus,
        now,
        centerId,
        id,
      ],
    );

    const updatedPackage: Package = {
      ...existing,
      name: updatedName,
      price: updatedPrice,
      description: updatedDesc,
      status: updatedStatus,
      updatedAt: now,
    };

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-pkg-update-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.update",
      entityType: "package",
      entityId: id,
      payload: updatedPackage,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package",
      entityId: id,
      action: "package.update",
      payload: data,
    });

    return updatedPackage;
  }

  /**
   * Adds a subject with default teacher to a package.
   * Strictly validates that defaultTeacherId is assigned to subjectId in active center.
   */
  static async addPackageSubject(params: {
    packageId: string;
    subjectId: string;
    defaultTeacherId: string;
  }): Promise<PackageSubject> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية إضافة مواد إلى الباقة.");
    }

    const pkg = this.getPackageById(params.packageId);
    if (!pkg) {
      throw new NotFoundError("الباقة غير موجودة.");
    }

    const subject = SubjectRepository.findById(params.subjectId);
    if (!subject) {
      throw new NotFoundError("المادة غير موجودة.");
    }

    const teacher = TeacherRepository.findById(params.defaultTeacherId);
    if (!teacher) {
      throw new NotFoundError("المعلم غير موجود.");
    }

    // MANDATORY VALIDATION: Teacher must be assigned to this subject in the center
    const isAssigned = TeacherSubjectRepository.isTeacherAssignedToSubject(
      params.defaultTeacherId,
      params.subjectId,
    );
    if (!isAssigned) {
      throw new ValidationError("المدرس غير مخصص لتدريس هذه المادة في المركز.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>(
      `SELECT id FROM package_subjects WHERE center_id = ? AND package_id = ? AND subject_id = ?`,
      [centerId, params.packageId, params.subjectId],
    );
    if (existing) {
      throw new ConflictError("هذه المادة مضافة بالفعل إلى هذه الباقة.");
    }

    const id = `ps-${generateUUID()}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        centerId,
        params.packageId,
        params.subjectId,
        params.defaultTeacherId,
        now,
      ],
    );

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-pkg-add-subj-${generateUUID()}`;

    const packageSubject: PackageSubject = {
      id,
      centerId,
      packageId: params.packageId,
      subjectId: params.subjectId,
      defaultTeacherId: params.defaultTeacherId,
      createdAt: now,
      subjectName: subject.name,
      subjectCode: subject.code,
      defaultTeacherName: teacher.name,
    };

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.add_subject",
      entityType: "package_subject",
      entityId: id,
      payload: packageSubject,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_subject",
      entityId: id,
      action: "package_subject.add",
      payload: {
        packageId: params.packageId,
        subjectId: params.subjectId,
        teacherId: params.defaultTeacherId,
      },
    });

    return packageSubject;
  }

  /**
   * Removes a subject from a package.
   */
  static async removePackageSubject(params: {
    packageId: string;
    subjectId: string;
  }): Promise<void> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية إزالة مواد من الباقة.");
    }

    const db = DatabaseService.getDb();
    db.runSync(
      `DELETE FROM package_subjects WHERE center_id = ? AND package_id = ? AND subject_id = ?`,
      [centerId, params.packageId, params.subjectId],
    );

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-pkg-rm-subj-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.remove_subject",
      entityType: "package_subject",
      entityId: `${params.packageId}-${params.subjectId}`,
      payload: { packageId: params.packageId, subjectId: params.subjectId },
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_subject",
      entityId: `${params.packageId}-${params.subjectId}`,
      action: "package_subject.remove",
      payload: { packageId: params.packageId, subjectId: params.subjectId },
    });
  }
}
