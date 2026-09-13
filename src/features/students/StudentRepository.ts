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
    // Normalize permissions — they may be missing/malformed after JSON.parse
    const user = {
      ...currentUser,
      permissions: Array.isArray(currentUser.permissions)
        ? currentUser.permissions
        : [],
    };
    return { centerId: activeCenterId, user };
  }

  static findByCardCode(normalizedCardCode: string): Student | null {
    // Canonical source of truth: student_cards table strictly
    const card = StudentCardRepository.findByCardCode(normalizedCardCode);
    if (!card) return null;

    const student = this.findByIdInternal(card.studentId);
    if (!student) return null;

    return {
      ...student,
      cardCode: card.cardCode,
    };
  }

  static findByStudentCode(studentCode: string): Student | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ? AND student_code = ?`,
      [centerId, studentCode.trim()],
    );

    if (!row) return null;
    const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
    return {
      ...row,
      cardCode: activeCard?.cardCode ?? row.cardCode,
    };
  }

  private static findByIdInternal(studentId: string): Student | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ? AND id = ?`,
      [centerId, studentId],
    );

    if (!row) return null;
    const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
    return {
      ...row,
      cardCode: activeCard?.cardCode ?? row.cardCode,
    };
  }

  static findById(studentId: string): Student | null {
    const { user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الطلاب.");
    }
    return this.findByIdInternal(studentId);
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

  static getAll(includeInactive = false): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الطلاب.");
    }
    const db = DatabaseService.getDb();

    const rows = db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_code as studentCode, full_name as fullName, card_code as cardCode,
              phone, parent_phone as parentPhone, grade, status, student_type as studentType, notes,
              created_at as createdAt, updated_at as updatedAt
       FROM students
       WHERE center_id = ?
       ORDER BY full_name ASC`,
      [centerId],
    );

    const filtered = includeInactive
      ? rows
      : rows.filter((r) => r.status === "active");
    return filtered.map((row) => {
      const activeCard = StudentCardRepository.getActiveCardByStudentId(row.id);
      return {
        ...row,
        cardCode: activeCard?.cardCode ?? row.cardCode,
      };
    });
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
      const existingCard = StudentCardRepository.findByCardCode(cardCode);
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

    // Atomic creation: insert student + issue card + create enrollments
    try {
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
    } catch (err) {
      // Rollback inserted records on partial failure
      try {
        db.runSync(
          `DELETE FROM student_group_enrollments WHERE student_id = ?`,
          [studentId],
        );
        db.runSync(`DELETE FROM student_cards WHERE student_id = ?`, [
          studentId,
        ]);
        db.runSync(`DELETE FROM students WHERE id = ?`, [studentId]);
      } catch {}
      throw err;
    }

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-create-${Date.now()}-${studentId}`;

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
    const now = new Date().toISOString();

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

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-update-${Date.now()}-${studentId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student",
      entityId: studentId,
      action: "student.update",
      payload: { fullName, phone, grade },
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

  static deactivateStudent(studentId: string): void {
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

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    // Soft delete student
    db.runSync(
      `UPDATE students SET status = 'inactive', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, studentId],
    );

    // Deactivate active card if present
    const activeCard =
      StudentCardRepository.getActiveCardByStudentId(studentId);
    if (activeCard) {
      StudentCardRepository.deactivateCard(activeCard.id);
    }

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-std-deact-${Date.now()}-${studentId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student",
      entityId: studentId,
      action: "student.deactivate",
      payload: { fullName: existing.fullName },
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
        status: "inactive",
        updatedAt: now,
        updated_at: now,
        student: {
          id: studentId,
          status: "inactive",
        },
      },
    });

    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync student deactivate notice:", e);
    });
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
