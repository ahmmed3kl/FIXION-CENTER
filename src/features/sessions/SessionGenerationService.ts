import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { Session, Student } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "../groups/GroupRepository";
import { GroupScheduleRepository } from "../groups/GroupScheduleRepository";
import { StudentRepository } from "../students/StudentRepository";
import { AttendanceSessionService } from "../attendance/AttendanceSessionService";

/** Parse a DATE at local noon so weekday calculations cannot cross a timezone boundary. */
function parseLocalDateOnly(dateValue: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return new Date(Number.NaN);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
    0,
  );
}

function formatLocalDateOnly(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export class SessionGenerationService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Idempotently generates sessions for a date range based on active group schedules.
   * - Enforces UNIQUE(group_id, schedule_id, session_date)
   * - Captures immutable historical snapshots of group configuration (subject, teacher, price, late threshold)
   * - Captures immutable historical snapshot of expected students valid on the session date
   */
  static generateSessionsForRange(fromDate: string, toDate: string): Session[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "sessions.generate")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية توليد الحصص والمحاضرات.");
    }

    if (fromDate > toDate) {
      throw new ValidationError(
        "تاريخ البداية يجب أن يكون قبل أو يساوي تاريخ النهاية.",
      );
    }

    const db = DatabaseService.getDb();
    const schedules = GroupScheduleRepository.getAllActiveSchedules();
    const groups = GroupRepository.getAll(false);
    const groupsMap = new Map(groups.map((g) => [g.id, g]));

    const generatedSessions: Session[] = [];
    const currentDate = parseLocalDateOnly(fromDate);
    const endDate = parseLocalDateOnly(toDate);
    if (!Number.isFinite(currentDate.getTime()) || !Number.isFinite(endDate.getTime())) {
      throw new ValidationError("صيغة التاريخ يجب أن تكون YYYY-MM-DD.");
    }

    const deviceId = DeviceService.getDeviceIdSync();

    while (currentDate <= endDate) {
      const dateStr = formatLocalDateOnly(currentDate);
      const dayOfWeek = currentDate.getDay(); // 0-6

      const matchingSchedules = schedules.filter(
        (s) => s.dayOfWeek === dayOfWeek,
      );

      for (const sched of matchingSchedules) {
        const group = groupsMap.get(sched.groupId);
        if (!group) continue;

        // Check if session already exists for (group_id, schedule_id, session_date)
        const existingSession = db.getFirstSync<Session>(
          `SELECT id FROM sessions
           WHERE center_id = ? AND group_id = ? AND schedule_id = ? AND session_date = ?`,
          [centerId, sched.groupId, sched.id, dateStr],
        );

        if (existingSession) {
          // Idempotent: Do not duplicate or overwrite existing session
          continue;
        }

        const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const now = new Date().toISOString();

        // 1. Insert Session with historical snapshot of configuration
        db.runSync(
          `INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [
            sessionId,
            centerId,
            group.id,
            sched.id,
            group.subjectId,
            group.teacherId,
            group.sessionPrice,
            group.lateAfterMinutes,
            dateStr,
            sched.startTime,
            sched.endTime,
            now,
          ],
        );

        // 2. Capture immutable snapshot of expected students based on active enrollment on this date
        const expectedStudentIds = AttendanceSessionService.getExpectedStudentIdsForGroup(group, group.id, dateStr);
        for (const studentId of expectedStudentIds) {
          db.runSync(
            `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [`exp-${sessionId}-${studentId}`, centerId, sessionId, studentId, now],
          );
        }

        const operationId = `op-sess-gen-${Date.now()}-${sessionId}`;
        AuditService.recordEvent({
          operationId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "session",
          entityId: sessionId,
          action: "session.generate",
          payload: {
            groupId: group.id,
            scheduleId: sched.id,
            sessionDate: dateStr,
            expectedCount: expectedStudentIds.length,
          },
        });

        SyncRepository.enqueueOperation({
          operationId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "CREATE",
          entityType: "session",
          entityId: sessionId,
          payload: {
            groupId: group.id,
            scheduleId: sched.id,
            subjectId: group.subjectId,
            teacherId: group.teacherId,
            sessionPrice: group.sessionPrice,
            lateAfterMinutes: group.lateAfterMinutes,
            sessionDate: dateStr,
            startTime: sched.startTime,
            endTime: sched.endTime,
            expectedStudentIds,
            status: "open",
            createdAt: now,
          },
        });

        generatedSessions.push({
          id: sessionId,
          centerId,
          groupId: group.id,
          scheduleId: sched.id,
          subjectId: group.subjectId,
          teacherId: group.teacherId,
          sessionPrice: group.sessionPrice,
          lateAfterMinutes: group.lateAfterMinutes,
          sessionDate: dateStr,
          startTime: sched.startTime,
          endTime: sched.endTime,
          status: "open",
          createdAt: now,
          groupName: group.name,
          teacherName: group.teacherName,
          subjectName: group.subjectName,
        });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return generatedSessions;
  }

  static getSessionsForDate(dateStr: string): Session[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الحصص.");
    }

    const db = DatabaseService.getDb();
    return db.getAllSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId, s.schedule_id as scheduleId,
              s.subject_id as subjectId, s.teacher_id as teacherId, s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes, s.session_date as sessionDate,
              s.start_time as startTime, s.end_time as endTime, s.status, s.created_at as createdAt, s.updated_at as updatedAt,
              g.name as groupName, t.name as teacherName, subj.name as subjectName
       FROM sessions s
       LEFT JOIN groups g ON s.group_id = g.id
       LEFT JOIN teachers t ON s.teacher_id = t.id
       LEFT JOIN subjects subj ON s.subject_id = subj.id
       WHERE s.center_id = ? AND s.session_date = ?
       ORDER BY s.start_time ASC`,
      [centerId, dateStr],
    );
  }

  static getExpectedStudentsForSession(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "students.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الطلاب.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<{ student_id: string }>(
      `SELECT student_id FROM session_expected_students WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );

    const students: Student[] = [];
    for (const r of rows) {
      const student = StudentRepository.findById(r.student_id);
      if (student) students.push(student);
    }
    return students;
  }

  static cancelSession(sessionId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.cancel")) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء الحصة.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<Session>(
      `SELECT id, group_id as groupId, session_date as sessionDate FROM sessions WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );

    if (!existing) {
      throw new NotFoundError("الحصة غير موجودة.");
    }

    const now = new Date().toISOString();
    db.runSync(
      `UPDATE sessions SET status = 'cancelled', updated_at = ? WHERE center_id = ? AND id = ?`,
      [now, centerId, sessionId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-sess-cancel-${Date.now()}-${sessionId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "session",
      entityId: sessionId,
      action: "session.cancel",
      payload: { groupId: existing.groupId, sessionDate: existing.sessionDate },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "session",
      entityId: sessionId,
      payload: { status: "cancelled", updatedAt: now },
    });
  }
}
