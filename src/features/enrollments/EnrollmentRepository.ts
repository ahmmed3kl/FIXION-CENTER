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
import { getLocalDateOnly } from "../../shared/utils/date";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "../groups/GroupRepository";
import { DebtCycleRepository } from "../payments/DebtCycleRepository";

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
       JOIN students s ON e.student_id = s.id AND s.deleted_at IS NULL
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

    // Keep this validation local to the enrollment repository. Importing
    // StudentRepository here creates a runtime cycle because student creation
    // delegates selected-group enrollment back to this repository.
    const db = DatabaseService.getDb();
    const student = db.getFirstSync<{ id: string; fullName: string; status: "active" | "inactive" }>(
      `SELECT id, full_name as fullName, status
       FROM students
       WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
      [centerId, dto.studentId],
    );
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

    const enrollmentId = `enr-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    const endDate = dto.endDate || null;
    const specialPrice = dto.specialMonthlyPrice ?? null;

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-enr-create-${Date.now()}-${enrollmentId}`;

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, special_monthly_price, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [enrollmentId, centerId, dto.studentId, dto.groupId, dto.startDate, endDate, specialPrice, now],
      );
      AuditService.recordEvent({
        operationId, centerId, userId: user.id, deviceId,
        entityType: "enrollment", entityId: enrollmentId,
        action: "enrollment.create",
        payload: { studentId: dto.studentId, groupId: dto.groupId, startDate: dto.startDate, specialPrice },
      });
      SyncRepository.enqueueOperation({
        operationId, centerId, userId: user.id, deviceId,
        operationType: "CREATE", entityType: "enrollment", entityId: enrollmentId,
        payload: { studentId: dto.studentId, groupId: dto.groupId, startDate: dto.startDate, endDate, specialMonthlyPrice: specialPrice, status: "active", createdAt: now },
      });
    });

    // Create the first financial cycle immediately when the caller also has
    // financial access. The calculation layer remains lazy for roles that can
    // enroll students but are not allowed to view financial data.
    try {
      if (PermissionService.hasPermission(user.permissions, "payments.view") || PermissionService.hasPermission(user.permissions, "payments.create")) {
        DebtCycleRepository.generateCyclesForEnrollment(enrollmentId);
      }
    } catch {
      // Financial generation is retried when the student's financial status is opened.
    }

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

    // Ending an enrollment must stop its outstanding group debt immediately.
    // Keep paid cycles and the payment/audit history, but waive open/partial
    // cycles so the student is not still shown as owing a group they left.
    const cyclesToCancel = db.getAllSync<any>(
      `SELECT id, student_id as studentId, enrollment_id as enrollmentId,
              group_id as groupId, cycle_number as cycleNumber,
              start_date as startDate, end_date as endDate,
              cycle_price as cyclePrice, package_subscription_id as packageSubscriptionId,
              package_id as packageId, cycle_type as cycleType
       FROM debt_cycles
       WHERE center_id = ? AND enrollment_id = ? AND status IN ('open', 'partial')`,
      [centerId, enrollmentId],
    );
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-enr-end-${Date.now()}-${enrollmentId}`;
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE student_group_enrollments SET status = 'ended', end_date = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
        [endDate, now, centerId, enrollmentId],
      );
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "enrollment", entityId: enrollmentId, action: "enrollment.end", payload: { studentId: existing.studentId, groupId: existing.groupId, endDate } });
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "enrollment", entityId: enrollmentId, payload: { status: "ended", endDate, updatedAt: now } });
      for (const cycle of cyclesToCancel) {
        const cycleOperationId = `op-dc-cancel-enrollment-${Date.now()}-${cycle.id}`;
        // Waive only the unpaid remainder. Preserve money already collected
        // on this cycle so a later sync cannot hide it from reports.
        const paidRow = db.getFirstSync<{ paid: number }>(
          `SELECT COALESCE(SUM(amount), 0) as paid
             FROM payments
            WHERE center_id = ? AND debt_cycle_id = ?
              AND (is_reversed = 0 OR is_reversed IS NULL)`,
          [centerId, cycle.id],
        );
        const retainedCyclePrice = Math.max(0, Number(paidRow?.paid || 0));
        db.runSync(
          `UPDATE debt_cycles SET cycle_price = ?, status = 'cancelled', updated_at = ? WHERE center_id = ? AND id = ?`,
          [retainedCyclePrice, now, centerId, cycle.id],
        );
        AuditService.recordEvent({
          operationId: cycleOperationId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "debt_cycle",
          entityId: cycle.id,
          action: "debt_cycle.cancel_on_enrollment_end",
          payload: { enrollmentId, groupId: existing.groupId, reason: "enrollment_ended", retainedPaidAmount: retainedCyclePrice },
        });
        SyncRepository.enqueueOperation({
          operationId: cycleOperationId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "UPDATE",
          entityType: "debt_cycle",
          entityId: cycle.id,
          payload: { ...cycle, cyclePrice: retainedCyclePrice, status: "cancelled", updatedAt: now },
        });
      }
    });
  }

  /** Move an active enrollment to another group while preserving its
   * enrollment/debt-cycle identity. This is used for same-subject/teacher
   * transfers so a second monthly debt cycle is never opened accidentally. */
  static transferEnrollment(enrollmentId: string, targetGroupId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "enrollments.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تحويل المجموعة.");
    }
    const db = DatabaseService.getDb();
    const enrollment = db.getFirstSync<any>(
      `SELECT id, student_id as studentId, group_id as groupId, start_date as startDate, end_date as endDate, status, special_monthly_price as specialMonthlyPrice FROM student_group_enrollments WHERE center_id = ? AND id = ?`,
      [centerId, enrollmentId],
    );
    const target = GroupRepository.findById(targetGroupId);
    if (!enrollment || enrollment.status !== "active") throw new NotFoundError("الاشتراك غير موجود.");
    if (!target || target.status !== "active") throw new ValidationError("المجموعة الجديدة غير موجودة.");
    if (enrollment.groupId === targetGroupId) throw new ConflictError("الطالب مسجل بالفعل في هذه المجموعة.");
    // Moving an enrollment keeps its debt-cycle/payment history only when the
    // instructional owner is unchanged. For a different teacher/subject,
    // create a fresh enrollment (and therefore a fresh debt stream) instead of
    // silently assigning the old teacher's balance to the new group.
    const source = GroupRepository.findById(enrollment.groupId);
    if (!source || source.teacherId !== target.teacherId || source.subjectId !== target.subjectId) {
      const schedules = db.getAllSync<{ dayOfWeek: number }>(
        `SELECT day_of_week as dayOfWeek FROM group_schedules
         WHERE center_id = ? AND group_id = ? AND status = 'active'`,
        [centerId, targetGroupId],
      );
      const today = new Date();
      const offsets = schedules
        .map((schedule) => (schedule.dayOfWeek - today.getDay() + 7) % 7)
        .filter((offset) => Number.isInteger(offset));
      const offset = offsets.length ? Math.min(...offsets) : 0;
      const firstClass = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      const replacementStartDate = `${firstClass.getFullYear()}-${String(firstClass.getMonth() + 1).padStart(2, "0")}-${String(firstClass.getDate()).padStart(2, "0")}` || getLocalDateOnly();
      this.enrollStudent({ studentId: enrollment.studentId, groupId: targetGroupId, startDate: replacementStartDate });
      const now = new Date().toISOString();
      const operationId = `op-enr-transfer-end-${Date.now()}-${enrollmentId}`;
      const deviceId = DeviceService.getDeviceIdSync();
      DatabaseService.runInTransaction(() => {
        db.runSync(
          `UPDATE student_group_enrollments SET status = 'ended', end_date = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
          [getLocalDateOnly(), now, centerId, enrollmentId],
        );
        AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "enrollment", entityId: enrollmentId, action: "enrollment.transfer_end", payload: { studentId: enrollment.studentId, fromGroupId: enrollment.groupId, toGroupId: targetGroupId } });
        SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "enrollment", entityId: enrollmentId, payload: { status: "ended", endDate: getLocalDateOnly(), updatedAt: now } });
      });
      return;
    }
    const duplicate = db.getFirstSync<{ id: string }>(
      `SELECT id FROM student_group_enrollments WHERE center_id = ? AND student_id = ? AND group_id = ? AND status = 'active'`,
      [centerId, enrollment.studentId, targetGroupId],
    );
    if (duplicate) throw new ConflictError("الطالب مسجل بالفعل في المجموعة الجديدة.");
    const now = new Date().toISOString();
    const operationId = `op-enr-transfer-${Date.now()}-${enrollmentId}`;
    const deviceId = DeviceService.getDeviceIdSync();
    DatabaseService.runInTransaction(() => {
      db.runSync(`UPDATE student_group_enrollments SET group_id = ?, updated_at = ? WHERE center_id = ? AND id = ?`, [targetGroupId, now, centerId, enrollmentId]);
      db.runSync(`UPDATE debt_cycles SET group_id = ?, updated_at = ? WHERE center_id = ? AND enrollment_id = ?`, [targetGroupId, now, centerId, enrollmentId]);
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "enrollment", entityId: enrollmentId, action: "enrollment.transfer", payload: { studentId: enrollment.studentId, fromGroupId: enrollment.groupId, toGroupId: targetGroupId } });
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "enrollment", entityId: enrollmentId, payload: { studentId: enrollment.studentId, groupId: targetGroupId, startDate: enrollment.startDate, endDate: enrollment.endDate || null, status: enrollment.status, specialMonthlyPrice: enrollment.specialMonthlyPrice ?? null, updatedAt: now } });
    });
  }
}
