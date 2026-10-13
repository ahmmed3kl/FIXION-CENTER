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
import {
  PermissionService,
  resolveUserPermissions,
} from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
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
    const permissions = resolveUserPermissions(currentUser);
    const user = { ...currentUser, permissions };
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

    const availableRows = rows.filter((row) => row.status !== "deleted");
    return includeInactive
      ? availableRows
      : availableRows.filter((row) => row.status === "active");
  }

  /** Returns active groups that have at least one schedule on the requested JS weekday. */
  static getGroupsForDay(dayOfWeek: number): Group[] {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new ValidationError("يوم الأسبوع يجب أن يكون بين 0 و6.");
    }
    const groups = this.getAll();
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<{ groupId: string }>(
      `SELECT DISTINCT group_id as groupId FROM group_schedules
       WHERE center_id = ? AND day_of_week = ? AND status = 'active'`,
      [centerId, dayOfWeek],
    );
    const ids = new Set(rows.map((row) => row.groupId));
    return groups.filter((group) => ids.has(group.id));
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
        id: groupId,
        groupId,
        name,
        teacherId: dto.teacherId,
        teacher_id: dto.teacherId,
        subjectId: dto.subjectId,
        subject_id: dto.subjectId,
        grade: dto.grade.trim(),
        default_fee: defaultFee,
        defaultFee,
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        status: "active",
        createdAt: now,
      },
    });

    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync group notice:", err);
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
    if (existing.status === "deleted") {
      throw new ValidationError("لا يمكن تعديل مجموعة محذوفة.");
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
    const scheduleConflict = db.getFirstSync<any>(
      `SELECT other.name as groupName, gs.start_time as startTime, gs.end_time as endTime
       FROM group_schedules gs
       JOIN groups other ON other.center_id=gs.center_id AND other.id=gs.group_id
       JOIN group_schedules own ON own.center_id=gs.center_id AND own.group_id=?
         AND own.day_of_week=gs.day_of_week
       WHERE gs.center_id=? AND gs.group_id<>? AND gs.status='active'
         AND other.teacher_id=? AND own.status='active'
         AND NOT (own.end_time <= gs.start_time OR own.start_time >= gs.end_time)
       LIMIT 1`,
      [groupId, centerId, groupId, teacherId],
    );
    if (scheduleConflict)
      throw new ConflictError(
        `المدرس مشغول مع ${scheduleConflict.groupName || "مجموعة أخرى"} (${scheduleConflict.startTime} - ${scheduleConflict.endTime}).`,
      );
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
        id: groupId,
        groupId,
        name,
        teacherId,
        teacher_id: teacherId,
        subjectId,
        subject_id: subjectId,
        grade,
        sessionPrice,
        monthlyPrice,
        sessionDurationMinutes,
        lateAfterMinutes,
        status,
        baseUpdatedAt: existing.updatedAt ?? null,
        updatedAt: now,
      },
    });

    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync group update notice:", err);
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
    if (existing.status === "deleted") {
      throw new ValidationError("لا يمكن تغيير حالة مجموعة محذوفة.");
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
      payload: {
        status: "inactive",
        baseUpdatedAt: existing.updatedAt ?? null,
        updatedAt: now,
      },
    });
    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync group deactivation notice:", err);
    });
  }

  static reactivateGroup(groupId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.update"))
      throw new ForbiddenError("ليس لديك صلاحية إعادة تفعيل المجموعة.");
    const existing = this.findById(groupId);
    if (!existing) throw new NotFoundError("المجموعة غير موجودة.");
    if (existing.status === "deleted") {
      throw new ValidationError("لا يمكن إعادة تفعيل مجموعة محذوفة.");
    }
    const now = new Date().toISOString();
    DatabaseService.getDb().runSync(
      "UPDATE groups SET status='active', updated_at=? WHERE center_id=? AND id=?",
      [now, centerId, groupId],
    );
    const operationId = `op-grp-reactivate-${Date.now()}-${groupId}`;
    const deviceId = DeviceService.getDeviceIdSync();
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group",
      entityId: groupId,
      action: "group.reactivate",
      payload: {},
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
        status: "active",
        baseUpdatedAt: existing.updatedAt ?? null,
        updatedAt: now,
      },
    });
    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync group reactivation notice:", err);
    });
  }

  static deleteGroup(groupId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.deactivate"))
      throw new ForbiddenError("ليس لديك صلاحية حذف المجموعة.");
    const existing = this.findById(groupId);
    if (!existing) throw new NotFoundError("المجموعة غير موجودة.");
    if (existing.status === "deleted") return;
    const db = DatabaseService.getDb();
    const now = new Date();
    const updatedAt = now.toISOString();
    const endDate = updatedAt.slice(0, 10);
    const operationPrefix = `op-grp-delete-${now.getTime()}-${groupId}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const activeEnrollments = db.getAllSync<{
      id: string;
      studentId: string;
      groupId: string;
      startDate: string;
      specialMonthlyPrice: number | null;
      createdAt: string;
    }>(
      `SELECT id, student_id as studentId, group_id as groupId,
              start_date as startDate, special_monthly_price as specialMonthlyPrice,
              created_at as createdAt
         FROM student_group_enrollments
        WHERE center_id = ? AND group_id = ? AND status = 'active'`,
      [centerId, groupId],
    );
    const affectedCycles = db.getAllSync<{
      id: string;
      studentId: string;
      enrollmentId: string | null;
      groupId: string | null;
      cycleNumber: number | null;
      startDate: string;
      endDate: string;
      cyclePrice: number;
      status: string;
      packageSubscriptionId: string | null;
      packageId: string | null;
      cycleType: string;
      billingMode: string;
      serverRevision: number;
    }>(
      `SELECT dc.id, dc.student_id as studentId,
              dc.enrollment_id as enrollmentId, dc.group_id as groupId,
              dc.cycle_number as cycleNumber, dc.start_date as startDate,
              dc.end_date as endDate, dc.cycle_price as cyclePrice,
              dc.status, dc.package_subscription_id as packageSubscriptionId,
              dc.package_id as packageId, dc.cycle_type as cycleType,
              dc.billing_mode as billingMode, dc.server_revision as serverRevision
         FROM debt_cycles dc
        WHERE dc.center_id = ?
          AND dc.status IN ('open', 'partial', 'pending')
          AND dc.cycle_type <> 'package'
          AND dc.package_subscription_id IS NULL
          AND (
            dc.group_id = ?
            OR dc.enrollment_id IN (
              SELECT e.id
                FROM student_group_enrollments e
               WHERE e.center_id = ? AND e.group_id = ?
            )
          )`,
      [centerId, groupId, centerId, groupId],
    );

    for (const enrollment of activeEnrollments) {
      const operationId = `${operationPrefix}-enr-${enrollment.id}`;
      db.runSync(
        `UPDATE student_group_enrollments
            SET status = 'ended', end_date = ?, updated_at = ?
          WHERE center_id = ? AND id = ? AND status = 'active'`,
        [endDate, updatedAt, centerId, enrollment.id],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "enrollment",
        entityId: enrollment.id,
        action: "enrollment.end_on_group_delete",
        payload: { studentId: enrollment.studentId, groupId, endDate },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "enrollment",
        entityId: enrollment.id,
        payload: { status: "ended", endDate, updatedAt },
      });
    }

    for (const cycle of affectedCycles) {
      const paidRow = db.getFirstSync<{ paid: number }>(
        `SELECT COALESCE(SUM(amount), 0) as paid
           FROM payments
          WHERE center_id = ? AND debt_cycle_id = ?
            AND (is_reversed = 0 OR is_reversed IS NULL)`,
        [centerId, cycle.id],
      );
      const retainedPaidAmount = Math.max(0, Number(paidRow?.paid || 0));
      const operationId = `${operationPrefix}-cycle-${cycle.id}`;
      db.runSync(
        `UPDATE debt_cycles
            SET cycle_price = ?, status = 'cancelled', updated_at = ?
          WHERE center_id = ? AND id = ?`,
        [retainedPaidAmount, updatedAt, centerId, cycle.id],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "debt_cycle",
        entityId: cycle.id,
        action: "debt_cycle.cancel_on_group_delete",
        payload: { groupId, retainedPaidAmount },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "debt_cycle",
        entityId: cycle.id,
        payload: {
          ...cycle,
          cyclePrice: retainedPaidAmount,
          status: "cancelled",
          expectedRevision: Number(cycle.serverRevision || 0),
          updatedAt,
        },
      });
    }

    db.runSync(
      `UPDATE student_subscriptions SET status = 'cancelled'
        WHERE center_id = ? AND group_id = ? AND status = 'active'`,
      [centerId, groupId],
    );
    db.runSync(
      `UPDATE group_schedules SET status = 'inactive', updated_at = ?
        WHERE center_id = ? AND group_id = ? AND status != 'inactive'`,
      [updatedAt, centerId, groupId],
    );
    db.runSync(
      `UPDATE sessions SET status = 'cancelled', updated_at = ?
        WHERE center_id = ? AND group_id = ? AND status = 'scheduled'
          AND session_date >= ?`,
      [updatedAt, centerId, groupId, endDate],
    );
    db.runSync(
      `UPDATE groups SET status = 'deleted', updated_at = ?
        WHERE center_id = ? AND id = ?`,
      [updatedAt, centerId, groupId],
    );

    const operationId = `${operationPrefix}-group`;
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group",
      entityId: groupId,
      action: "group.delete",
      payload: { name: existing.name, archived: true },
    });
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "DELETE",
      entityType: "group",
      entityId: groupId,
      payload: {
        id: groupId,
        baseUpdatedAt: existing.updatedAt ?? null,
        deletedAt: updatedAt,
      },
    });
    SyncEngine.syncCenterNow(centerId).catch((err) => {
      console.warn("Auto-sync group delete notice:", err);
    });
  }
}
