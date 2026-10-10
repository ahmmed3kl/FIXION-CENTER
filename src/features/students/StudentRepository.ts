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
import { CardRangeRepository } from "./CardRangeRepository";
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

export interface CreateStudentOptions {
  reuseArchivedCard?: boolean;
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
    const activeCard = StudentCardRepository.findByCardCode(normalizedCardCode);
    if (activeCard) {
      const cardOwner = this.findByIdInternal(activeCard.studentId, false);
      return cardOwner ? { ...cardOwner, cardCode: normalizedCardCode } : null;
    }

    const staleCard = StudentCardRepository.findCardByCodeInActiveCenter(normalizedCardCode);
    if (staleCard) {
      const staleOwner = this.findByIdInternal(staleCard.studentId, true);
      if (staleOwner && staleOwner.deletedAt) return null;
    }

    // The current student.card_code is the source of truth for scans. This
    // compatibility path is only for legacy records without a card-history row.
    const currentStudent = db.getFirstSync<any>(
      `SELECT id FROM students
       WHERE center_id = ? AND card_code = ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [centerId, normalizedCardCode],
    );
    if (currentStudent) return this.findByIdInternal(currentStudent.id, false);

    return null;
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
       WHERE center_id = ? AND student_code = ?
       ORDER BY created_at DESC`,
      [centerId, studentCode.trim()],
    );

    if (!row) return null;
    return {
      ...row,
      cardCode: this.resolveCardCode(centerId, row),
    };
  }

  private static getHistoricalCardCode(centerId: string, studentId: string): string | undefined {
    const events = AuditService.getEntityLogs(centerId, studentId);
    for (const event of events) {
      if (event.entityType !== "student_card" || event.action !== "student_card.deactivate" || !event.payload) continue;
      try {
        const payload = JSON.parse(event.payload);
        if (payload.studentId === studentId && typeof payload.cardCode === "string") return payload.cardCode;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private static resolveCardCode(centerId: string, row: { id: string; cardCode?: string | null; deletedAt?: string | null }): string | undefined {
    const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
    if (row.deletedAt) {
      return row.cardCode || activeCard?.cardCode || this.getHistoricalCardCode(centerId, row.id);
    }
    const knownCard = row.cardCode
      ? StudentCardRepository.findCardByCodeInActiveCenter(row.cardCode)
      : null;
    if (knownCard && knownCard.studentId !== row.id) return undefined;
    return row.cardCode || activeCard?.cardCode || undefined;
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
       WHERE center_id = ? AND id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );

    if (!row) return null;
    return {
      ...row,
      cardCode: this.resolveCardCode(centerId, row),
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
    return rows.map((row) => {
      const deleteEvent = AuditService.getEntityLogs(centerId, row.id)
        .find((event) => event.action === "student.delete");
      let deletedByName: string | null = null;
      if (deleteEvent?.payload) {
        try {
          const payload = JSON.parse(deleteEvent.payload);
          deletedByName = typeof payload.actorName === "string" ? payload.actorName : null;
        } catch {
          deletedByName = null;
        }
      }
      return {
        ...row,
        deletedByName,
        cardCode: this.resolveCardCode(centerId, row),
      };
    });
  }

  static getArchivedCardOwner(cardCode: string): Student | null {
    const { centerId } = this.getActiveContext();
    const card = StudentCardRepository.findCardByCodeInActiveCenter(cardCode);
    if (!card) return null;
    const owner = this.findByIdInternal(card.studentId);
    return owner?.deletedAt ? owner : null;
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
    return filtered.map((row) => ({ ...row, cardCode: this.resolveCardCode(centerId, row) }));
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
    return rows.map((row) => ({ ...row, cardCode: this.resolveCardCode(centerId, row) || "" }));
  }

  static createStudent(dto: CreateStudentDTO, options: CreateStudentOptions = {}): Student {
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
    CardRangeRepository.assertCodeAllowed(centerId, cardCode);
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

    // Card codes are globally exclusive while active. An inactive card may
    // only be reassigned after explicit confirmation when its current-center
    // owner is archived.
    let archivedCardOwner: Student | null = null;
    if (cardCode) {
      const activeCard = StudentCardRepository.findActiveCardByCodeAnywhere(cardCode);
      if (activeCard) {
        throw new ConflictError(
          `كود الكارت (${cardCode}) مستخدم بالفعل لطالب آخر.`,
        );
      }
      const existingCard = StudentCardRepository.findCardByCodeInActiveCenter(cardCode);
      if (existingCard) {
        archivedCardOwner = this.findByIdInternal(existingCard.studentId, true);
        if (!archivedCardOwner?.deletedAt || options.reuseArchivedCard !== true) {
          throw new ConflictError(
            archivedCardOwner?.deletedAt
              ? "هذا الكارت مرتبط بطالب مؤرشف ويتطلب تأكيد إعادة استخدامه."
              : `كود الكارت (${cardCode}) مرتبط بسجل طالب آخر.`,
          );
        }
      }
    }

    const db = DatabaseService.getDb();
    const studentId = `std-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const studentType = dto.studentType || "registered";
    const notes = dto.notes?.trim() || null;
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-create-${Date.now()}-${studentId}`;
    let issuedCardId = `card-${studentId}`;

    // Atomic creation: insert student + issue card + create enrollments.
    // All writes use the shared transaction helper so a failed enrollment or
    // card insert cannot leave a partially-created student behind.
    DatabaseService.runInTransaction(() => {
      if (archivedCardOwner) {
        const releaseOperationId = `op-student-card-release-${Date.now()}-${archivedCardOwner.id}`;
        AuditService.recordEvent({
          operationId: releaseOperationId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "student",
          entityId: archivedCardOwner.id,
          action: "student.card_reused",
          payload: { studentId: archivedCardOwner.id, cardCode, newStudentId: studentId, actorName: user.fullName },
        });
        SyncRepository.enqueueOperation({
          operationId: releaseOperationId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "UPDATE",
          entityType: "student",
          entityId: archivedCardOwner.id,
          payload: {
            id: archivedCardOwner.id,
            studentId: archivedCardOwner.id,
            baseUpdatedAt: archivedCardOwner.updatedAt ?? null,
            updatedAt: now,
            updated_at: now,
            cardCode,
            card_code: cardCode,
            cardCodeChanged: true,
            replaceCard: true,
          },
        });
      }
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
        issuedCardId = StudentCardRepository.issueCard(studentId, cardCode).id;
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
          id: issuedCardId,
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
      if (existing.cardCode) {
        db.runSync(
          `UPDATE students SET card_code = ?, updated_at = ?
           WHERE center_id = ? AND id = ? AND deleted_at IS NOT NULL`,
          [existing.cardCode, now, centerId, studentId],
        );
      }
      const activeCard = StudentCardRepository.getActiveCardByStudentId(studentId);
      if (activeCard) {
        db.runSync(
          `UPDATE student_cards SET status = 'inactive', deactivated_at = ?
           WHERE center_id = ? AND id = ? AND status = 'active'`,
          [now, centerId, activeCard.id],
        );
        const cardOperationId = `op-card-archive-${Date.now()}-${activeCard.id}`;
        AuditService.recordEvent({
          operationId: cardOperationId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "student_card",
          entityId: activeCard.id,
          action: "student_card.deactivate",
          payload: { studentId, cardCode: activeCard.cardCode, reason: "student_archive" },
        });
        SyncRepository.enqueueOperation({
          operationId: cardOperationId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "UPDATE",
          entityType: "student_card",
          entityId: activeCard.id,
          payload: { studentId, cardCode: activeCard.cardCode, status: "inactive", deactivatedAt: now },
        });
      }
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
      const archivedCard = db.getFirstSync<any>(
        `SELECT id, card_code as cardCode FROM student_cards
         WHERE center_id = ? AND student_id = ? AND status = 'inactive'
         ORDER BY deactivated_at DESC LIMIT 1`,
        [centerId, studentId],
      );
      if (archivedCard) {
        const currentOwner = StudentCardRepository.findActiveCardByCodeAnywhere(archivedCard.cardCode);
        if (!currentOwner) {
          db.runSync(
            `UPDATE student_cards SET status = 'active', deactivated_at = NULL, issued_at = ?
             WHERE center_id = ? AND id = ? AND student_id = ? AND status = 'inactive'`,
            [now, centerId, archivedCard.id, studentId],
          );
          db.runSync(
            `UPDATE students SET card_code = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
            [existing.cardCode || archivedCard.cardCode, now, centerId, studentId],
          );
          SyncRepository.enqueueOperation({
            operationId: `op-card-restore-${Date.now()}-${archivedCard.id}`,
            centerId,
            userId: user.id,
            deviceId,
            operationType: "UPDATE",
            entityType: "student_card",
            entityId: archivedCard.id,
            payload: { studentId, cardCode: archivedCard.cardCode, status: "active", issuedAt: now },
          });
        }
      }
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
    const restoredCard = StudentCardRepository.getActiveCardByStudentId(studentId);
    const historicalCardCode = existing.cardCode && !StudentCardRepository.findActiveCardByCodeAnywhere(existing.cardCode)
      ? existing.cardCode
      : undefined;
    return {
      ...existing,
      cardCode: restoredCard?.cardCode ?? historicalCardCode,
      deletedAt: null,
      deletedBy: null,
      updatedAt: now,
    };
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
