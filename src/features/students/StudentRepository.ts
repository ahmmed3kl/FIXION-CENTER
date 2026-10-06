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
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Student } from "../../shared/types";
import { isEgyptianPhone, isNumericCode, isValidName, normalizeDigits, ValidationMessages } from "../../shared/utils/validation";
import { useAuthStore } from "../auth/useAuthStore";
import { EnrollmentRepository } from "../enrollments/EnrollmentRepository";
import { StudentCardRepository } from "./StudentCardRepository";
import { smartSearch } from "../../shared/utils/smartSearch";

export interface CreateStudentDTO {
  studentCode?: string;
  fullName: string;
  phone: string;
  parentPhone: string;
  grade?: string;
  studentType?: "registered" | "external";
  notes?: string;
  cardCode?: string;
  groupIds?: string[];
}

export interface UpdateStudentDTO {
  fullName?: string;
  phone?: string;
  parentPhone?: string;
  grade?: string;
  studentType?: "registered" | "external";
  notes?: string;
}

export class StudentRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز للوصول إلى بيانات الطلاب.",
      );
    }
    const permissions = resolveUserPermissions(currentUser);
    const user = { ...currentUser, permissions };
    return { centerId: activeCenterId, user };
  }

  static findByCardCode(normalizedCardCode: string): Student | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    // The current student.card_code is the source of truth for scans. This
    // prevents an old student_cards history row from identifying a student
    // after a simple card-code replacement.
    const currentStudent = db.getFirstSync<any>(
      `SELECT id FROM students
       WHERE center_id = ? AND card_code = ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [centerId, normalizedCardCode],
    );
    if (currentStudent) return this.findByIdInternal(currentStudent.id, false);

    // Legacy rows may have a missing students.card_code but a matching active
    // card row. Keep that compatibility path only when the card row is still
    // the student's current active identifier.
    const card = StudentCardRepository.findByCardCode(normalizedCardCode);
    if (!card) return null;
    const student = this.findByIdInternal(card.studentId, false);
    return student && student.cardCode === normalizedCardCode
      ? { ...student, cardCode: normalizedCardCode }
      : null;
  }

  static findByStudentCode(studentCode: string): Student | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              deleted_at as deletedAt, deleted_by as deletedBy,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ? AND student_code = ?`,
      [centerId, studentCode.trim()],
    );

    if (!row) return null;
    const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
    return {
      ...row,
      cardCode: row.cardCode || activeCard?.cardCode,
    };
  }

  private static findByIdInternal(studentId: string, includeDeleted = true): Student | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              deleted_at as deletedAt, deleted_by as deletedBy,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ? AND id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
      [centerId, studentId],
    );

    if (!row) return null;
    const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
    return {
      ...row,
      cardCode: row.cardCode || activeCard?.cardCode,
    };
  }

  static findById(studentId: string): Student | null {
    const { user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الطلاب.");
    }
    return this.findByIdInternal(studentId, false);
  }

  /** Read-only lookup for attendance/report screens that may not have student-management permission. */
  static findByIdForAttendanceReport(studentId: string): Student | null {
    const { user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    return this.findByIdInternal(studentId);
  }

  static getDeletedStudents(): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الطلاب.");
    }
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              deleted_at as deletedAt, deleted_by as deletedBy, created_at as createdAt, updated_at as updatedAt
       FROM students WHERE center_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, full_name ASC`,
      [centerId],
    );
    return rows.map((row) => ({
      ...row,
      cardCode: row.cardCode || StudentCardRepository.getActiveCardByStudentId(row.id)?.cardCode,
    }));
  }

  static searchDeletedStudents(query: string): Student[] {
    return smartSearch(this.getDeletedStudents(), query, [
      { get: (student) => student.fullName, weight: 1.2 },
      { get: (student) => student.studentCode, weight: 1.1 },
      { get: (student) => student.cardCode, weight: 1.1 },
      { get: (student) => student.phone },
      { get: (student) => student.parentPhone },
    ]);
  }

  /**
   * A duplicate phone is informational only. The lookup is deliberately
   * scoped to the active center and never participates in create/update.
   */
  static isPhoneUsedInActiveCenter(
    phone: string,
    excludeStudentId?: string,
  ): boolean {
    const { centerId } = this.getActiveContext();
    const normalizedPhone = normalizeDigits(phone).replace(/\s/g, "");
    if (!normalizedPhone) return false;
    const db = DatabaseService.getDb();
    const students = db.getAllSync<{ id: string; phone: string; parentPhone: string }>(
      `SELECT id, phone, parent_phone as parentPhone FROM students WHERE center_id = ?`,
      [centerId],
    );
    if (students.some((student) =>
      student.id !== excludeStudentId &&
      [student.phone, student.parentPhone].some((value) => normalizeDigits(value || "").replace(/\s/g, "") === normalizedPhone),
    )) return true;

    const teachers = db.getAllSync<{ phone: string }>(
      `SELECT phone FROM teachers WHERE center_id = ?`,
      [centerId],
    );
    return teachers.some((teacher) =>
      normalizeDigits(teacher.phone || "").replace(/\s/g, "") === normalizedPhone,
    );
  }

  static getAll(includeInactive = false, includeDeleted = false): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الطلاب.");
    }
    const db = DatabaseService.getDb();

    const rows = db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              deleted_at as deletedAt, deleted_by as deletedBy,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}
       ORDER BY full_name ASC`,
      [centerId],
    );

    const filtered = includeInactive || includeDeleted
      ? rows
      : rows.filter((r) => {
          // Legacy/synced databases may store status with different casing
          // (or as SQLite's integer boolean). Treat all active variants as
          // active so valid students are not silently omitted from the list.
          const status = String(r.status ?? "").trim().toLowerCase();
          return status === "active" || status === "1" || r.status === true;
        });
    return filtered.map((row) => {
      const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
      return {
        ...row,
        // The students.card_code column is still part of the authoritative
        // student snapshot. If the card-history table is missing/stale on a
        // device, do not discard a card code that arrived from PostgreSQL.
        cardCode: row.cardCode || activeCard?.cardCode,
      };
    });
  }

  /** Students available to the attendance picker without requiring full student-list access. */
  static getAllForAttendance(): Student[] {
    const { centerId, user } = this.getActiveContext();
    const canRead = PermissionService.hasPermission(user.permissions, "students.view") ||
      PermissionService.hasPermission(user.permissions, "attendance.view") ||
      PermissionService.hasPermission(user.permissions, "attendance.create");
    if (!canRead) throw new ForbiddenError("ليس لديك صلاحية عرض الطلاب للحضور.");
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName,
              card_code as cardCode, phone, parent_phone as parentPhone, grade, status,
              student_type as studentType, notes, created_at as createdAt, updated_at as updatedAt
       FROM students WHERE center_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY full_name ASC`, [centerId],
    );
    return rows.map((row) => ({
      ...row,
      cardCode: row.cardCode || StudentCardRepository.getActiveCardByStudentId(row.id)?.cardCode || "",
    }));
  }

  static createStudent(dto: CreateStudentDTO): Student {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل طالب جديد.");
    }

    const rawCode = (dto.studentCode || dto.cardCode || "").trim();
    if (!rawCode) {
      throw new ValidationError(
        "كود الطالب أو كود الكارت مطلوب ولا يمكن تركه فارغاً.",
      );
    }
    // Preserves leading zeros exactly (e.g. "00126")
    const trimmedCode = rawCode;
    const cardCode = (dto.cardCode || dto.studentCode || "").trim();

    if (!isNumericCode(trimmedCode) || !isNumericCode(cardCode)) {
      throw new ValidationError(ValidationMessages.code);
    }
    if (!isValidName(dto.fullName || "")) {
      throw new ValidationError(ValidationMessages.name);
    }
    if (!isEgyptianPhone(normalizeDigits(dto.phone || "")) || !isEgyptianPhone(normalizeDigits(dto.parentPhone || ""))) {
      throw new ValidationError(ValidationMessages.phone);
    }

    if (!dto.fullName || !dto.fullName.trim()) {
      throw new ValidationError("اسم الطالب مطلوب.");
    }
    if (!dto.phone || !dto.phone.trim()) {
      throw new ValidationError("رقم هاتف الطالب مطلوب.");
    }
    if (!dto.parentPhone || !dto.parentPhone.trim()) {
      throw new ValidationError("رقم هاتف ولي الأمر مطلوب.");
    }
    const grade = (dto.grade || "الصف الثالث الثانوي").trim();

    // Enforce uniqueness of student_code within center
    const existing = this.findByStudentCode(trimmedCode);
    if (existing) {
      throw new ConflictError(
        `كود الطالب (${trimmedCode}) مستخدم بالفعل لطالب آخر في هذا المركز.`,
      );
    }

    // Enforce uniqueness of cardCode within center if cardCode is present
    if (cardCode) {
      const existingCard = StudentCardRepository.findByCardCodeAnywhere(cardCode);
      if (existingCard) {
        throw new ConflictError(
          `كود الكارت (${cardCode}) مستخدم بالفعل لطالب آخر في هذا المركز.`,
        );
      }
    }

    const db = DatabaseService.getDb();
    const studentId = `std-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const studentType = dto.studentType || "registered";
    const notes = dto.notes?.trim() || null;
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-create-${Date.now()}-${studentId}`;

    // Atomic creation: insert student + issue card + create enrollments.
    // All writes use the shared transaction helper so a failed enrollment or
    // card insert cannot leave a partially-created student behind.
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          studentId,
          centerId,
          trimmedCode,
          dto.fullName.trim(),
          cardCode,
          dto.phone.trim(),
          dto.parentPhone.trim(),
          grade,
          studentType,
          notes,
          now,
        ],
      );

      // Issue card via canonical StudentCardRepository
      if (cardCode) {
        StudentCardRepository.issueCard(studentId, cardCode);
      }

      // Enroll in selected groups atomically
      if (dto.groupIds && dto.groupIds.length > 0) {
        for (const gId of dto.groupIds) {
          EnrollmentRepository.enrollStudent({
            studentId,
            groupId: gId,
            startDate: now.split("T")[0],
          });
        }
      }
      // Audit and outbox are committed with the entity mutation. If either
      // fails, the whole local operation rolls back.

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student",
      entityId: studentId,
      action: "student.create",
      payload: {
        studentCode: trimmedCode,
        cardCode,
        fullName: dto.fullName.trim(),
        grade,
        groupIds: dto.groupIds || [],
        actorName: user.fullName,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "student",
      entityId: studentId,
      payload: {
        id: studentId,
        studentId,
        studentCode: trimmedCode,
        student_code: trimmedCode,
        cardCode,
        card_code: cardCode,
        fullName: dto.fullName.trim(),
        full_name: dto.fullName.trim(),
        phone: dto.phone.trim(),
        parentPhone: dto.parentPhone.trim(),
        parent_phone: dto.parentPhone.trim(),
        grade,
        studentType,
        student_type: studentType,
        notes,
        groupIds: dto.groupIds || [],
        createdAt: now,
        student: {
          id: studentId,
          studentCode: trimmedCode,
          student_code: trimmedCode,
          cardCode,
          card_code: cardCode,
          fullName: dto.fullName.trim(),
          full_name: dto.fullName.trim(),
          phone: dto.phone.trim(),
          parentPhone: dto.parentPhone.trim(),
          parent_phone: dto.parentPhone.trim(),
          grade,
          studentType,
          student_type: studentType,
          notes,
        },
        card: {
          id: `card-${studentId}`,
          cardCode,
          card_code: cardCode,
        },
      },
    });
    });

    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync student create notice:", e);
    });

    return {
      id: studentId,
      centerId,
      studentCode: trimmedCode,
      fullName: dto.fullName.trim(),
      cardCode,
      phone: dto.phone.trim(),
      parentPhone: dto.parentPhone.trim(),
      grade,
      status: "active",
      studentType,
      notes: notes || undefined,
      createdAt: now,
    };
  }

  static updateStudent(studentId: string, dto: UpdateStudentDTO): Student {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل بيانات الطالب.");
    }

    const existing = this.findByIdInternal(studentId);
    if (!existing) {
      throw new NotFoundError("الطالب غير موجود.");
    }
    if (existing.deletedAt) throw new ConflictError("الطالب محذوف بالفعل.");

    const db = DatabaseService.getDb();
    const fullName = dto.fullName?.trim() || existing.fullName;
    const phone = dto.phone?.trim() || existing.phone;
    const parentPhone = dto.parentPhone?.trim() || existing.parentPhone;
    const grade = dto.grade?.trim() || existing.grade;
    const studentType = dto.studentType || existing.studentType;
    const notes =
      dto.notes !== undefined
        ? dto.notes?.trim() || null
        : (existing.notes ?? null);

    // Updates must enforce the same invariants as creation.  Previously an
    // edit could persist malformed names/phones (and could even overwrite a
    // valid value with whitespace) because only the create path validated DTOs.
    if (!isValidName(fullName)) {
      throw new ValidationError(ValidationMessages.name);
    }
    if (!isEgyptianPhone(normalizeDigits(phone)) || !isEgyptianPhone(normalizeDigits(parentPhone))) {
      throw new ValidationError(ValidationMessages.phone);
    }
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-update-${Date.now()}-${studentId}`;

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE students
         SET full_name = ?, phone = ?, parent_phone = ?, grade = ?, student_type = ?, notes = ?, updated_at = ?
         WHERE center_id = ? AND id = ?`,
        [
          fullName,
          phone,
          parentPhone,
          grade,
          studentType,
          notes,
          now,
          centerId,
          studentId,
        ],
      );
      // Keep audit and outbox in the same local commit as the entity update.

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student",
      entityId: studentId,
      action: "student.update",
      payload: { fullName, phone, grade, actorName: user.fullName },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "student",
      entityId: studentId,
      payload: {
        id: studentId,
        studentId,
        studentCode: existing.studentCode,
        student_code: existing.studentCode,
        cardCode: existing.cardCode,
        card_code: existing.cardCode,
        fullName,
        full_name: fullName,
        phone,
        parentPhone,
        parent_phone: parentPhone,
        grade,
        studentType,
        student_type: studentType,
        notes,
        baseUpdatedAt: existing.updatedAt ?? null,
        updatedAt: now,
        updated_at: now,
        student: {
          id: studentId,
          student_code: existing.studentCode,
          card_code: existing.cardCode,
          full_name: fullName,
          phone,
          parent_phone: parentPhone,
          grade,
          student_type: studentType,
          notes,
        },
      },
    });
    });

    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync student update notice:", e);
    });

    const activeCard =
      StudentCardRepository.getActiveCardByStudentId(studentId);
    return {
      ...existing,
      fullName,
      phone,
      parentPhone,
      grade,
      studentType,
      notes: notes ?? undefined,
      cardCode: activeCard?.cardCode ?? existing.cardCode,
      updatedAt: now,
    };
  }

  static deleteStudent(studentId: string): Student {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "students.deactivate")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء تفعيل الطالب.");
    }

    const existing = this.findByIdInternal(studentId);
    if (!existing) {
      throw new NotFoundError("الطالب غير موجود.");
    }

    if (existing.deletedAt) throw new ConflictError("Student is already deleted.");
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Soft delete student
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE students SET deleted_at = ?, deleted_by = ?, updated_at = ?
         WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
        [now, user.id, now, centerId, studentId],
      );
      // Keep audit and outbox in the same local commit as the status change.

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student",
      entityId: studentId,
      action: "student.delete",
      payload: { studentId, deletedAt: now, actorName: user.fullName },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "student",
      entityId: studentId,
      payload: {
        id: studentId,
        studentId,
        baseUpdatedAt: existing.updatedAt ?? null,
        updatedAt: now,
        updated_at: now,
        student: {
          id: studentId,
          deletedAt: now,
          deleted_at: now,
          deletedBy: user.id,
          deleted_by: user.id,
          updatedAt: now,
          updated_at: now,
        },
      },
    });
    });

    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync student archive notice:", e);
    });
    return { ...existing, deletedAt: now, deletedBy: user.id, updatedAt: now };
  }

  static restoreDeletedStudent(studentId: string): Student {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.restore")) {
      throw new ForbiddenError("ليس لديك صلاحية استرجاع الطالب.");
    }
    const existing = this.findByIdInternal(studentId);
    if (!existing) throw new NotFoundError("الطالب غير موجود.");
    if (!existing.deletedAt) throw new ConflictError("الطالب مسترجع بالفعل.");

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE students SET deleted_at = NULL, deleted_by = NULL, updated_at = ?
         WHERE center_id = ? AND id = ? AND deleted_at IS NOT NULL`,
        [now, centerId, studentId],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "student",
        entityId: studentId,
        action: "student.restore",
        payload: { studentId },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "student",
        entityId: studentId,
        payload: {
          id: studentId,
          studentId,
          baseUpdatedAt: existing.updatedAt ?? null,
          updatedAt: now,
          updated_at: now,
          student: { id: studentId, deletedAt: null, deleted_at: null, deletedBy: null, deleted_by: null, updatedAt: now, updated_at: now },
        },
      });
    });
    SyncEngine.syncCenterNow(centerId).catch((error) => {
      console.warn("Background auto-sync student restore notice:", error);
    });
    return { ...existing, deletedAt: null, deletedBy: null, updatedAt: now };
  }

  static search(query: string): Student[] {
    const all = this.getAll(false);
    return smartSearch(all, query, [
      { get: (s) => s.fullName, weight: 1.2 },
      { get: (s) => s.studentCode, weight: 1.1 },
      { get: (s) => s.cardCode, weight: 1.1 },
      { get: (s) => s.phone },
      { get: (s) => s.parentPhone },
    ]);
  }
}
