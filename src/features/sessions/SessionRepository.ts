import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { Session, Student } from "../../shared/types";
import { getSessionExpectedStudentIds } from "../attendance/AttendanceCalculations";
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
              g.name as groupName, g.grade as groupGrade, subj.name as subjectName, t.name as teacherName
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
         AND NOT EXISTS (
           SELECT 1 FROM session_id_aliases alias
           WHERE alias.center_id = s.center_id
             AND alias.local_session_id = s.id
         )
       ORDER BY s.start_time ASC`,
      [centerId, dateStr],
    );
  }

  /** Read-only monthly session query used by attendance/absence reports. */
  static getSessionsForMonth(month: string): Session[] {
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
       WHERE s.center_id = ? AND substr(s.session_date, 1, 7) = ?
         AND NOT EXISTS (
           SELECT 1 FROM session_id_aliases alias
           WHERE alias.center_id = s.center_id
             AND alias.local_session_id = s.id
         )
       ORDER BY s.session_date DESC, s.start_time DESC`,
      [centerId, month],
    );
  }

  static getActivationTimestamps(sessionIds: string[]): Map<string, string> {
    const ids = Array.from(new Set(sessionIds.filter(Boolean)));
    if (ids.length === 0) return new Map();

    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const requestedIds = new Set(ids);
    const activationTimes = new Map<string, string>();

    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const rows = db.getAllSync<{
        sessionId?: string;
        entityId?: string;
        action: string;
        timestamp: string;
      }>(
        `SELECT entity_id as sessionId, action, timestamp
         FROM audit_logs
         WHERE center_id = ? AND entity_type = 'session'
           AND entity_id IN (${batch.map(() => "?").join(",")})
           AND action IN ('session.attendance_start', 'session.activated', 'session_reopened')
         ORDER BY timestamp DESC`,
        [centerId, ...batch],
      );
      for (const row of rows) {
        const sessionId = String(row.sessionId || row.entityId || "");
        if (
          !requestedIds.has(sessionId) ||
          !["session.attendance_start", "session.activated", "session_reopened"].includes(row.action) ||
          !row.timestamp
        ) {
          continue;
        }
        const previous = activationTimes.get(sessionId);
        if (!previous || row.timestamp > previous) activationTimes.set(sessionId, row.timestamp);
      }
    }

    return activationTimes;
  }

  /**
   * Returns students who were actually eligible for this group's session
   * date. This validates legacy expected-roster snapshots without mutating
   * them, so compensation visitors from older clients cannot become absentees.
   */
  static getEligibleStudentIdsForSession(sessionId: string): string[] {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const regularRows = db.getAllSync<{ studentId?: string; student_id?: string; id?: string }>(
      `SELECT DISTINCT enrollment.student_id as studentId
       FROM sessions session
       JOIN student_group_enrollments enrollment
         ON enrollment.center_id = session.center_id
        AND enrollment.group_id = session.group_id
        AND enrollment.status IN ('active', 'ended')
        AND (enrollment.start_date <= session.session_date OR SUBSTR(enrollment.created_at, 1, 10) <= session.session_date)
        AND (enrollment.end_date IS NULL OR enrollment.end_date >= session.session_date)
        AND NOT EXISTS (
          SELECT 1
          FROM session_expected_students compensation_expected
          JOIN sessions compensation_session
            ON compensation_session.center_id = compensation_expected.center_id
           AND compensation_session.id = compensation_expected.session_id
          WHERE compensation_expected.center_id = enrollment.center_id
            AND compensation_expected.student_id = enrollment.student_id
            AND compensation_session.group_id = enrollment.group_id
            AND compensation_expected.id LIKE ('exp-comp-' || compensation_expected.session_id || '-%')
            AND enrollment.id = ('enr-' || compensation_expected.id)
        )
       JOIN students student
         ON student.center_id = enrollment.center_id
        AND student.id = enrollment.student_id
        AND student.deleted_at IS NULL
       WHERE session.center_id = ? AND session.id = ?`,
      [centerId, sessionId],
    );
    const packageRows = db.getAllSync<{ studentId?: string; student_id?: string }>(
      `SELECT DISTINCT subscription.student_id as studentId
       FROM sessions session
       JOIN groups scoped_group
         ON scoped_group.center_id = session.center_id
        AND scoped_group.id = session.group_id
       JOIN student_package_subscriptions subscription
         ON subscription.center_id = session.center_id
        AND subscription.status IN ('active', 'ended', 'cancelled')
        AND subscription.start_date <= session.session_date
        AND (subscription.end_date IS NULL OR subscription.end_date >= session.session_date)
       JOIN students student
         ON student.center_id = subscription.center_id
        AND student.id = subscription.student_id
        AND student.deleted_at IS NULL
       JOIN package_subjects package_subject
         ON package_subject.center_id = subscription.center_id
        AND package_subject.package_id = subscription.package_id
        AND package_subject.subject_id = COALESCE(session.subject_id, scoped_group.subject_id)
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = subscription.center_id
        AND selected.subscription_id = subscription.id
        AND selected.subject_id = package_subject.subject_id
       WHERE session.center_id = ? AND session.id = ?
         AND (package_subject.group_id = scoped_group.id OR selected.group_id = scoped_group.id)
         AND COALESCE(selected.teacher_id, package_subject.default_teacher_id) =
             COALESCE(session.teacher_id, scoped_group.teacher_id)
         AND (selected.id IS NULL OR selected.group_id = scoped_group.id)
         AND (
           selected.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = subscription.center_id
               AND any_selection.subscription_id = subscription.id
           )
         )`,
      [centerId, sessionId],
    );
    return Array.from(new Set(
      [
        ...regularRows.map((row) => row.studentId ?? row.student_id ?? row.id),
        ...packageRows.map((row) => row.studentId ?? row.student_id),
      ]
        .map((studentId) => String(studentId ?? ""))
        .filter(Boolean),
    ));
  }

  /**
   * Preserves the session's saved roster while adding students whose
   * date-valid enrollment or package eligibility is still available locally.
   * Known legacy compensation visitors are excluded from the saved roster.
   */
  static getExpectedStudentIdsForSession(sessionId: string): string[] {
    const { centerId } = this.getActiveContext();
    const eligibleStudentIds = this.getEligibleStudentIdsForSession(sessionId);

    const db = DatabaseService.getDb();
    const snapshotRows = db.getAllSync<{ id: string; studentId: string }>(
      `SELECT id, student_id as studentId FROM session_expected_students
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    const snapshotStudentIds = getSessionExpectedStudentIds(sessionId, snapshotRows);
    if (snapshotStudentIds.length === 0) return eligibleStudentIds;

    const legacyMakeupVisitors = new Set(
      db.getAllSync<{ studentId: string }>(
        `SELECT DISTINCT compensation.student_id as studentId
         FROM session_expected_students compensation
         JOIN sessions session
           ON session.center_id = compensation.center_id
          AND session.id = compensation.session_id
         WHERE compensation.center_id = ? AND compensation.session_id = ?
           AND compensation.id LIKE ('exp-comp-' || compensation.session_id || '-%')
           AND EXISTS (
             SELECT 1 FROM student_group_enrollments legacy_enrollment
             WHERE legacy_enrollment.center_id = session.center_id
               AND legacy_enrollment.group_id = session.group_id
               AND legacy_enrollment.student_id = compensation.student_id
               AND legacy_enrollment.id = ('enr-' || compensation.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM student_group_enrollments real_enrollment
             WHERE real_enrollment.center_id = session.center_id
               AND real_enrollment.group_id = session.group_id
               AND real_enrollment.student_id = compensation.student_id
               AND real_enrollment.id NOT LIKE 'enr-exp-comp-%'
           )`,
        [centerId, sessionId],
      ).map((row) => row.studentId),
    );

    return Array.from(new Set([
      ...eligibleStudentIds,
      ...snapshotStudentIds.filter((studentId) => !legacyMakeupVisitors.has(studentId)),
    ]));
  }

  /** Read-only expected-student snapshot for a historical session. */
  static getExpectedStudents(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور والغياب.");
    }
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<Student>(
      `SELECT DISTINCT s.id, s.center_id as centerId, s.student_code as studentCode,
              s.full_name as fullName, s.card_code as cardCode, s.phone,
              s.parent_phone as parentPhone, s.grade, s.status,
              s.student_type as studentType, s.student_color as studentColor, s.notes,
              s.created_at as createdAt, s.updated_at as updatedAt
       FROM session_expected_students expected
       JOIN students s ON s.id = expected.student_id AND s.center_id = expected.center_id
       WHERE expected.center_id = ? AND expected.session_id = ?
       ORDER BY s.full_name COLLATE NOCASE ASC`,
      [centerId, sessionId],
    );

    if (rows.length > 0) {
      const expected = new Set(this.getExpectedStudentIdsForSession(sessionId));
      return rows.filter((student) => expected.has(student.id));
    }

    // Older sessions may have been created before roster snapshots were
    // introduced. Reconstruct their expected roster from the enrollment that
    // was active on the session date so reports do not incorrectly show zero.
    return db.getAllSync<Student>(
      `SELECT st.id, st.center_id as centerId, st.student_code as studentCode,
              st.full_name as fullName, st.card_code as cardCode, st.phone,
              st.parent_phone as parentPhone, st.grade, st.status,
              st.student_type as studentType, st.student_color as studentColor, st.notes,
              st.created_at as createdAt, st.updated_at as updatedAt
       FROM sessions session
       JOIN student_group_enrollments enrollment
         ON enrollment.center_id = session.center_id
        AND enrollment.group_id = session.group_id
        AND enrollment.status = 'active'
        AND (enrollment.start_date <= session.session_date OR SUBSTR(enrollment.created_at, 1, 10) <= session.session_date)
        AND (enrollment.end_date IS NULL OR enrollment.end_date >= session.session_date)
        AND NOT EXISTS (
          SELECT 1
          FROM session_expected_students compensation_expected
          JOIN sessions compensation_session
            ON compensation_session.center_id = compensation_expected.center_id
           AND compensation_session.id = compensation_expected.session_id
          WHERE compensation_expected.center_id = enrollment.center_id
            AND compensation_expected.student_id = enrollment.student_id
            AND compensation_session.group_id = enrollment.group_id
            AND compensation_expected.id LIKE ('exp-comp-' || compensation_expected.session_id || '-%')
            AND enrollment.id = ('enr-' || compensation_expected.id)
        )
       JOIN students st
         ON st.center_id = enrollment.center_id AND st.id = enrollment.student_id
       WHERE session.center_id = ? AND session.id = ?
       UNION
       SELECT packageStudent.id, packageStudent.center_id as centerId,
              packageStudent.student_code as studentCode,
              packageStudent.full_name as fullName, packageStudent.card_code as cardCode,
              packageStudent.phone, packageStudent.parent_phone as parentPhone,
              packageStudent.grade, packageStudent.status,
              packageStudent.student_type as studentType,
              packageStudent.student_color as studentColor, packageStudent.notes,
              packageStudent.created_at as createdAt, packageStudent.updated_at as updatedAt
       FROM sessions packageSession
       JOIN student_package_subscriptions packageSubscription
         ON packageSubscription.center_id = packageSession.center_id
        AND packageSubscription.status = 'active'
        AND packageSubscription.start_date <= packageSession.session_date
        AND (packageSubscription.end_date IS NULL OR packageSubscription.end_date >= packageSession.session_date)
       JOIN package_subjects packageSubject
         ON packageSubject.center_id = packageSubscription.center_id
        AND packageSubject.package_id = packageSubscription.package_id
        AND packageSubject.subject_id = COALESCE(packageSession.subject_id, (SELECT subject_id FROM groups WHERE center_id = packageSession.center_id AND id = packageSession.group_id))
       LEFT JOIN package_subject_teacher_overrides selectedPackageTeacher
         ON selectedPackageTeacher.center_id = packageSubscription.center_id
        AND selectedPackageTeacher.subscription_id = packageSubscription.id
        AND selectedPackageTeacher.subject_id = packageSubject.subject_id
       JOIN students packageStudent
         ON packageStudent.center_id = packageSubscription.center_id
        AND packageStudent.id = packageSubscription.student_id
       WHERE packageSession.center_id = ? AND packageSession.id = ?
         AND (
           packageSubject.group_id IS NULL
           OR packageSubject.group_id = packageSession.group_id
           OR selectedPackageTeacher.group_id = packageSession.group_id
         )
         AND COALESCE(selectedPackageTeacher.teacher_id, packageSubject.default_teacher_id) =
             COALESCE(packageSession.teacher_id, (SELECT teacher_id FROM groups WHERE center_id = packageSession.center_id AND id = packageSession.group_id))
         AND (
           selectedPackageTeacher.id IS NULL
           OR selectedPackageTeacher.group_id = packageSession.group_id
         )
         AND (
           selectedPackageTeacher.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides anyPackageSelection
             WHERE anyPackageSelection.center_id = packageSubscription.center_id
               AND anyPackageSelection.subscription_id = packageSubscription.id
           )
         )
       ORDER BY fullName COLLATE NOCASE ASC`,
      [centerId, sessionId],
    );
  }
}
