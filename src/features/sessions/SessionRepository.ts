import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { Session, Student } from "../../shared/types";
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
    if (!PermissionService.hasAnyPermission(user.permissions, ["sessions.view", "reports.attendance.view", "reports.view"])) {
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

  /** Read-only monthly session query used by attendance/absence reports. */
  static getSessionsForMonth(month: string): Session[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["sessions.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("Ù„ÙŠØ³ Ù„Ø¯ÙŠÙƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¹Ø±Ø¶ Ø§Ù„Ø­ØµØµ.");
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
       WHERE s.center_id = ? AND substr(s.session_date, 1, 7) = ?
       ORDER BY s.session_date DESC, s.start_time DESC`,
      [centerId, month],
    );
  }

  /** Read-only expected-student snapshot for a historical session. */
  static getExpectedStudents(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("Ù„ÙŠØ³ Ù„Ø¯ÙŠÙƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¹Ø±Ø¶ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø­Ø¶ÙˆØ± ÙˆØ§Ù„ØºÙŠØ§Ø¨.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<Student>(
      `SELECT s.id, s.center_id as centerId, s.student_code as studentCode,
              s.full_name as fullName, s.card_code as cardCode, s.phone,
              s.parent_phone as parentPhone, s.grade, s.status,
              s.student_type as studentType, s.notes,
              s.created_at as createdAt, s.updated_at as updatedAt
       FROM session_expected_students expected
       JOIN students s ON s.id = expected.student_id AND s.center_id = expected.center_id
       WHERE expected.center_id = ? AND expected.session_id = ?
       ORDER BY s.full_name COLLATE NOCASE ASC`,
      [centerId, sessionId],
    );
  }
}
