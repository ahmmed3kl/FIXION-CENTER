import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ConflictError, ForbiddenError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { Group, Session } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { EnrollmentRepository } from "../enrollments/EnrollmentRepository";
import { GroupRepository } from "../groups/GroupRepository";
import { SessionRepository } from "../sessions/SessionRepository";
import { GroupScheduleRepository } from "../groups/GroupScheduleRepository";
import { AuditService } from "../../core/audit";

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
}

/** Single source of truth for the normal attendance session flow. */
export class AttendanceSessionService {
  static getTodayGroups(date = AttendanceSessionService.localDate()): Group[] {
    return GroupRepository.getGroupsForDay(new Date(`${date}T12:00:00`).getDay());
  }

  static ensureSessionForGroup(groupId: string, date = AttendanceSessionService.localDate()): Session {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new ForbiddenError("يجب تسجيل الدخول أولاً.");
    const db = DatabaseService.getDb();
    const existing = SessionRepository.getSessionsForDate(date).find((session) => session.groupId === groupId);
    if (existing) return existing;
    const group = GroupRepository.findById(groupId);
    if (!group) throw new ConflictError("المجموعة غير موجودة.");
    const schedule = GroupScheduleRepository.getSchedulesForGroup(groupId).find((item) => item.dayOfWeek === new Date(`${date}T12:00:00`).getDay());
    if (!schedule) throw new ConflictError("لا يوجد موعد للمجموعة اليوم.");
    const now = new Date().toISOString();
    const sessionId = `sess-att-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    db.runSync(`INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`, [sessionId, activeCenterId, group.id, schedule.id, group.subjectId, group.teacherId, group.sessionPrice, group.lateAfterMinutes, date, schedule.startTime, schedule.endTime, now]);
    const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(group.id, date);
    for (const enrollment of enrollments) db.runSync("INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)", [`exp-${sessionId}-${enrollment.studentId}`, activeCenterId, sessionId, enrollment.studentId, now]);
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-session-att-${sessionId}`;
    AuditService.recordEvent({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, entityType: "session", entityId: sessionId, action: "session.attendance_start", payload: { groupId: group.id, scheduleId: schedule.id, sessionDate: date } });
    SyncRepository.enqueueOperation({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, operationType: "CREATE", entityType: "session", entityId: sessionId, payload: { groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, expectedStudentIds: enrollments.map((item) => item.studentId), status: "open", createdAt: now } });
    return { id: sessionId, centerId: activeCenterId, groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, status: "open", createdAt: now, groupName: group.name, teacherName: group.teacherName, subjectName: group.subjectName };
  }

  static getTodaySessions(date = AttendanceSessionService.localDate()): Session[] {
    const sessions = SessionRepository.getSessionsForDate(date).filter((session) => session.status === "open" || session.status === "scheduled");
    const scheduledGroupIds = new Set(GroupRepository.getGroupsForDay(new Date(`${date}T12:00:00`).getDay()).map((group) => group.id));
    return sessions.filter((session) => scheduledGroupIds.has(session.groupId));
  }

  private static localDate(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  static activate(sessionId: string): Session {
    const { currentUser } = useAuthStore.getState();
    if (!currentUser || !PermissionService.hasPermission(currentUser.permissions, "attendance.create")) {
      throw new ForbiddenError("ليس لديك صلاحية بدء جلسة الحضور.");
    }
    const session = SessionRepository.findById(sessionId);
    if (!session) throw new ConflictError("جلسة الحضور غير موجودة.");
    if (session.status === "closed" || session.status === "cancelled") throw new ConflictError("لا يمكن بدء جلسة مغلقة أو ملغاة.");

    const db = DatabaseService.getDb();
    if (session.status === "scheduled") {
      db.runSync("UPDATE sessions SET status = 'open', updated_at = ? WHERE center_id = ? AND id = ?", [new Date().toISOString(), session.centerId, session.id]);
      const deviceId = DeviceService.getDeviceIdSync();
      SyncRepository.enqueueOperation({
        operationId: `op-session-activate-${session.id}`,
        centerId: session.centerId,
        userId: currentUser.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "session",
        entityId: session.id,
        payload: { status: "open", updatedAt: new Date().toISOString() },
      });
    }
    const expectedCount = db.getFirstSync<{ count: number }>("SELECT COUNT(*) as count FROM session_expected_students WHERE session_id = ?", [sessionId]);
    if (!Number(expectedCount?.count)) {
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(session.groupId, session.sessionDate);
      const now = new Date().toISOString();
      for (const enrollment of enrollments) {
        db.runSync(
          "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [`exp-${sessionId}-${enrollment.studentId}`, session.centerId, sessionId, enrollment.studentId, now],
        );
      }
    }
    return session;
  }

  static isExpected(sessionId: string, studentId: string): boolean {
    const db = DatabaseService.getDb();
    return !!db.getFirstSync("SELECT 1 FROM session_expected_students WHERE session_id = ? AND student_id = ?", [sessionId, studentId]);
  }

  static getSummary(sessionId: string): AttendanceSummary {
    const db = DatabaseService.getDb();
    const total = Number(db.getFirstSync<any>("SELECT COUNT(*) as count FROM session_expected_students WHERE session_id = ?", [sessionId])?.count || 0);
    const present = Number(db.getFirstSync<any>("SELECT COUNT(*) as count FROM attendance WHERE session_id = ? AND status IN ('present','late')", [sessionId])?.count || 0);
    return { total, present, absent: Math.max(0, total - present) };
  }
}
