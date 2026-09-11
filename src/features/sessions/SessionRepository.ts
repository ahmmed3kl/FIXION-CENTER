import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { Session } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

export class SessionRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Finds a session by ID within the active center.
   */
  static findById(sessionId: string): Session | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    return db.getFirstSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId, s.schedule_id as scheduleId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes, s.session_date as sessionDate,
              s.start_time as startTime, s.end_time as endTime, s.status,
              s.created_at as createdAt, s.updated_at as updatedAt,
              g.name as groupName, subj.name as subjectName, t.name as teacherName
       FROM sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN teachers t ON COALESCE(s.teacher_id, g.teacher_id) = t.id
       WHERE s.center_id = ? AND s.id = ?`,
      [centerId, sessionId],
    );
  }

  /**
   * Retrieves all sessions for a specific date in the active center.
   */
  static getSessionsForDate(dateStr: string): Session[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "sessions.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الحصص.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId, s.schedule_id as scheduleId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes, s.session_date as sessionDate,
              s.start_time as startTime, s.end_time as endTime, s.status,
              s.created_at as createdAt, s.updated_at as updatedAt,
              g.name as groupName, subj.name as subjectName, t.name as teacherName
       FROM sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN teachers t ON COALESCE(s.teacher_id, g.teacher_id) = t.id
       WHERE s.center_id = ? AND s.session_date = ?
       ORDER BY s.start_time ASC`,
      [centerId, dateStr],
    );
  }
}
