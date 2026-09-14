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
    resolveUserPermissions
} from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { GroupSchedule } from "../../shared/types";
import { isValidTime, ValidationMessages } from "../../shared/utils/validation";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "./GroupRepository";

export interface CreateGroupScheduleDTO {
  groupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export class GroupScheduleRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    const permissions = resolveUserPermissions(currentUser);
    const user = { ...currentUser, permissions };
    return { centerId: activeCenterId, user };
  }

  static getSchedulesForGroup(groupId: string): GroupSchedule[] {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    return db.getAllSync<GroupSchedule>(
      `SELECT id, center_id as centerId, group_id as groupId, day_of_week as dayOfWeek,
              start_time as startTime, end_time as endTime, status, created_at as createdAt, updated_at as updatedAt
       FROM group_schedules
       WHERE center_id = ? AND group_id = ? AND status = 'active'
       ORDER BY day_of_week ASC, start_time ASC`,
      [centerId, groupId],
    );
  }

  static getAllActiveSchedules(): GroupSchedule[] {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    return db.getAllSync<GroupSchedule>(
      `SELECT id, center_id as centerId, group_id as groupId, day_of_week as dayOfWeek,
              start_time as startTime, end_time as endTime, status, created_at as createdAt, updated_at as updatedAt
       FROM group_schedules
       WHERE center_id = ? AND status = 'active'
       ORDER BY day_of_week ASC, start_time ASC`,
      [centerId],
    );
  }

  static createSchedule(dto: CreateGroupScheduleDTO): GroupSchedule {
    const { centerId, user } = this.getActiveContext();
    const canCreateSchedule = PermissionService.hasPermission(user.permissions, "groups.create") || PermissionService.hasPermission(user.permissions, "groups.update");
    if (!canCreateSchedule) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل جدول مواعيد المجموعة.");
    }

    if (dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
      throw new ValidationError(
        "يوم الأسبوع يجب أن يكون بين 0 (الأحد) و 6 (السبت).",
      );
    }

    if (!dto.startTime || !dto.endTime) {
      throw new ValidationError("وقت البدء ووقت الانتهاء مطلوبان.");
    }
    if (!isValidTime(dto.startTime) || !isValidTime(dto.endTime)) {
      throw new ValidationError(ValidationMessages.time);
    }

    // Validation: End time must be strictly after Start time
    if (dto.endTime <= dto.startTime) {
      throw new ValidationError("وقت الانتهاء يجب أن يكون بعد وقت البدء.");
    }

    const group = GroupRepository.findById(dto.groupId);
    if (!group || group.status !== "active") {
      throw new ValidationError("المجموعة غير موجودة أو غير مفعلة.");
    }

    // Validation: Check for overlapping schedules on the same day for this group
    const existing = this.getSchedulesForGroup(dto.groupId).filter(
      (s) => s.dayOfWeek === dto.dayOfWeek,
    );

    for (const s of existing) {
      // Overlap condition: not (newEnd <= existingStart or newStart >= existingEnd)
      if (!(dto.endTime <= s.startTime || dto.startTime >= s.endTime)) {
        throw new ConflictError(
          `يوجد تعارض في المواعيد لنفس المجموعة في هذا اليوم (${s.startTime} - ${s.endTime}).`,
        );
      }
    }

    const db = DatabaseService.getDb();
    const scheduleId = `sched-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        scheduleId,
        centerId,
        dto.groupId,
        dto.dayOfWeek,
        dto.startTime,
        dto.endTime,
        now,
      ],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-sched-create-${Date.now()}-${scheduleId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group_schedule",
      entityId: scheduleId,
      action: "group_schedule.create",
      payload: {
        groupId: dto.groupId,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: {
        groupId: dto.groupId,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        status: "active",
        createdAt: now,
      },
    });

    return {
      id: scheduleId,
      centerId,
      groupId: dto.groupId,
      dayOfWeek: dto.dayOfWeek,
      startTime: dto.startTime,
      endTime: dto.endTime,
      status: "active",
      createdAt: now,
    };
  }

  static deactivateSchedule(scheduleId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.update")) {
      throw new ForbiddenError("ليس لديك صلاحية حذف موعد المجموعة.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<GroupSchedule>(
      `SELECT id, group_id as groupId FROM group_schedules WHERE center_id = ? AND id = ?`,
      [centerId, scheduleId],
    );

    if (!existing) {
      throw new NotFoundError("الموعد غير موجود.");
    }

    const now = new Date().toISOString();
    db.runSync(
      `UPDATE group_schedules SET status = 'inactive', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, scheduleId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-sched-deact-${Date.now()}-${scheduleId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "group_schedule",
      entityId: scheduleId,
      action: "group_schedule.deactivate",
      payload: { groupId: existing.groupId },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: { status: "inactive", updatedAt: now },
    });
  }

  static reactivateSchedule(scheduleId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "groups.update")) throw new ForbiddenError("ليس لديك صلاحية إعادة تفعيل الموعد.");
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<GroupSchedule>("SELECT id, group_id as groupId FROM group_schedules WHERE center_id=? AND id=?", [centerId, scheduleId]);
    if (!existing) throw new NotFoundError("الموعد غير موجود.");
    const now = new Date().toISOString(); db.runSync("UPDATE group_schedules SET status='active', updated_at=? WHERE center_id=? AND id=?", [now, centerId, scheduleId]);
    const operationId = `op-sched-reactivate-${Date.now()}-${scheduleId}`; const deviceId = DeviceService.getDeviceIdSync();
    AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "group_schedule", entityId: scheduleId, action: "group_schedule.reactivate", payload: { groupId: existing.groupId } });
    SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "group_schedule", entityId: scheduleId, payload: { status: "active", updatedAt: now } });
  }
}
