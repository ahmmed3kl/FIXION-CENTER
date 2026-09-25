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
    const rows = db.getAllSync<Student>(
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

    if (rows.length > 0) return rows;

    // Older sessions may have been created before roster snapshots were
    // introduced. Reconstruct their expected roster from the enrollment that
    // was active on the session date so reports do not incorrectly show zero.
    return db.getAllSync<Student>(
      `SELECT st.id, st.center_id as centerId, st.student_code as studentCode,
              st.full_name as fullName, st.card_code as cardCode, st.phone,
              st.parent_phone as parentPhone, st.grade, st.status,
              st.student_type as studentType, st.notes,
              st.created_at as createdAt, st.updated_at as updatedAt
       FROM sessions session
       JOIN student_group_enrollments enrollment
         ON enrollment.center_id = session.center_id
        AND enrollment.group_id = session.group_id
        AND enrollment.status = 'active'
        AND enrollment.start_date <= session.session_date
        AND (enrollment.end_date IS NULL OR enrollment.end_date >= session.session_date)
       JOIN students st
         ON st.center_id = enrollment.center_id AND st.id = enrollment.student_id
       WHERE session.center_id = ? AND session.id = ?
       ORDER BY st.full_name COLLATE NOCASE ASC`,
      [centerId, sessionId],
    );
  }
}
