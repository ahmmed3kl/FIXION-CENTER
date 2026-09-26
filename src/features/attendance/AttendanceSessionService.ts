import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ConflictError, ForbiddenError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Group, Session } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { EnrollmentRepository } from "../enrollments/EnrollmentRepository";
import { GroupRepository } from "../groups/GroupRepository";
import { SessionRepository } from "../sessions/SessionRepository";
import { GroupScheduleRepository } from "../groups/GroupScheduleRepository";
import { AuditService } from "../../core/audit";
import { calculateSessionAttendanceCounts } from "./AttendanceCalculations";

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
}

export interface MakeupEligibility {
  eligible: boolean;
  sourceGroupId?: string;
  sourceGroupName?: string;
  teacherName?: string;
  originalAbsenceId?: string;
}

/** Single source of truth for the normal attendance session flow. */
export class AttendanceSessionService {
  static getMakeupEligibility(sessionId: string, studentId: string): MakeupEligibility {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) return { eligible: false };
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<any>(
      `SELECT s.group_id as groupId, s.session_date as sessionDate,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              g.name as groupName, t.name as teacherName,
              subj.name as subjectName
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       LEFT JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       LEFT JOIN subjects subj ON subj.center_id = g.center_id AND subj.id = COALESCE(s.subject_id, g.subject_id)
       WHERE s.center_id = ? AND s.id = ?`,
      [activeCenterId, sessionId],
    );
    if (!session?.teacherId) return { eligible: false };
    const source = db.getFirstSync<any>(
      `SELECT g.id as groupId, g.name as groupName, s.id as originalSessionId
       FROM student_group_enrollments e
       JOIN groups g ON g.center_id = e.center_id AND g.id = e.group_id
       LEFT JOIN teachers sourceTeacher ON sourceTeacher.center_id = g.center_id AND sourceTeacher.id = g.teacher_id
       LEFT JOIN subjects sourceSubject ON sourceSubject.center_id = g.center_id AND sourceSubject.id = g.subject_id
       JOIN sessions s ON s.center_id = e.center_id AND s.group_id = e.group_id
         AND s.session_date < ? AND s.status <> 'cancelled'
       LEFT JOIN session_expected_students ex ON ex.center_id = s.center_id
         AND ex.session_id = s.id AND ex.student_id = e.student_id
       LEFT JOIN attendance a ON a.center_id = s.center_id
         AND a.session_id = s.id AND a.student_id = e.student_id
       LEFT JOIN attendance makeup ON makeup.center_id = s.center_id
         AND makeup.student_id = e.student_id
         AND (makeup.original_absence_id = s.id
              OR makeup.original_absence_id = ('absence-' || s.id || '-' || e.student_id))
       WHERE e.center_id = ? AND e.student_id = ? AND e.status = 'active'
         AND e.start_date <= s.session_date
         AND (e.end_date IS NULL OR e.end_date >= s.session_date)
         AND (g.teacher_id = ? OR LOWER(TRIM(sourceTeacher.name)) = LOWER(TRIM(?)))
         AND g.id <> ?
         AND (g.subject_id = ? OR LOWER(TRIM(sourceSubject.name)) = LOWER(TRIM(?)))
         -- A generated expected snapshot is preferred, but older/scheduled
         -- sessions may not have one. In that case the active enrollment and
         -- missing attendance still establish an absence eligible for makeup.
         AND (ex.id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM session_expected_students any_ex
           WHERE any_ex.center_id = s.center_id AND any_ex.session_id = s.id
         ))
         AND a.id IS NULL
         AND makeup.id IS NULL
       ORDER BY s.session_date DESC, s.start_time DESC LIMIT 1`,
      [session.sessionDate, activeCenterId, studentId, session.teacherId, session.teacherName || "", session.groupId, session.subjectId, session.subjectName || ""],
    );
    if (source) {
      return {
        eligible: true,
        sourceGroupId: source.groupId,
        sourceGroupName: source.groupName,
        teacherName: session.teacherName,
        // Store the canonical source session id. Legacy prefixed ids are still
        // recognized above so old local rows remain usable.
        originalAbsenceId: source.originalSessionId,
      };
    }

    // Fallback for centers that have an active enrollment but no historical
    // expected-student snapshot/session yet. The teacher/group relationship is
    // still authoritative for allowing a same-teacher makeup attendance.
    const enrolledWithTeacher = db.getFirstSync<any>(
      `SELECT g.id as groupId, g.name as groupName
       FROM student_group_enrollments e
       JOIN groups g ON g.center_id = e.center_id AND g.id = e.group_id
       LEFT JOIN teachers sourceTeacher ON sourceTeacher.center_id = g.center_id AND sourceTeacher.id = g.teacher_id
       LEFT JOIN subjects sourceSubject ON sourceSubject.center_id = g.center_id AND sourceSubject.id = g.subject_id
       WHERE e.center_id = ? AND e.student_id = ? AND e.status = 'active'
         AND (g.teacher_id = ? OR LOWER(TRIM(sourceTeacher.name)) = LOWER(TRIM(?))) AND g.id <> ?
         AND (g.subject_id = ? OR LOWER(TRIM(sourceSubject.name)) = LOWER(TRIM(?)))
       ORDER BY e.start_date DESC LIMIT 1`,
      [activeCenterId, studentId, session.teacherId, session.teacherName || "", session.groupId, session.subjectId, session.subjectName || ""],
    );
    return enrolledWithTeacher
      ? {
          eligible: true,
          sourceGroupId: enrolledWithTeacher.groupId,
          sourceGroupName: enrolledWithTeacher.groupName,
          teacherName: session.teacherName,
          originalAbsenceId: sessionId,
        }
      : { eligible: false };
  }
  static getTodayGroups(date = AttendanceSessionService.localDate()): Group[] {
    return GroupRepository.getGroupsForDay(new Date(`${date}T12:00:00`).getDay());
  }

  /**
   * Package subscribers are expected from the first scheduled class too.
   * They do not have a regular group-enrollment row, so the session roster
   * must include them before anyone scans; otherwise absences and dashboard
   * totals incorrectly start at zero.
   */
  private static getPackageExpectedStudentIds(
    groupId: string,
    subjectId: string | null | undefined,
    teacherId: string | null | undefined,
    sessionDate: string,
  ): string[] {
    if (!subjectId || !teacherId) return [];
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) return [];
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<{ studentId?: string; student_id?: string }>(
      `SELECT DISTINCT sps.student_id as studentId
       FROM student_package_subscriptions sps
       JOIN package_subjects ps
         ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id
        AND selected.subscription_id = sps.id
        AND selected.subject_id = ps.subject_id
       WHERE sps.center_id = ? AND sps.status = 'active'
         AND sps.start_date <= ? AND (sps.end_date IS NULL OR sps.end_date >= ?)
         AND ps.subject_id = ?
         AND (ps.group_id IS NULL OR ps.group_id = ?)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
         AND (
           selected.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = sps.center_id
               AND any_selection.subscription_id = sps.id
           )
         )`,
      [activeCenterId, sessionDate, sessionDate, subjectId, groupId, teacherId],
    );
    return rows.map((row) => String(row.studentId ?? row.student_id ?? "")).filter(Boolean);
  }

  /** Build the immutable roster for a session date, including package-only
   * subscribers selected for this exact subject/teacher/group. */
  static getExpectedStudentIdsForGroup(
    group: Group,
    groupId: string,
    sessionDate: string,
  ): string[] {
    const regular = EnrollmentRepository.getActiveEnrollmentsForGroup(groupId, sessionDate).map((item) => item.studentId);
    const packageStudents = this.getPackageExpectedStudentIds(groupId, group.subjectId, group.teacherId, sessionDate);
    return Array.from(new Set([...regular, ...packageStudents]));
  }

  static ensureSessionForGroup(
    groupId: string,
    date = AttendanceSessionService.localDate(),
    scheduleId?: string,
  ): Session {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new ForbiddenError("يجب تسجيل الدخول أولاً.");
    const db = DatabaseService.getDb();
    const existing = SessionRepository.getSessionsForDate(date).find(
      (session) =>
        session.groupId === groupId &&
        (!scheduleId || session.scheduleId === scheduleId),
    );
    if (existing) {
      // A session can have been generated before enrollments were synced (or
      // by an older build), leaving its expected-student snapshot empty. Do
      // not return that stale session as if it had no students; hydrate the
      // snapshot from the current active enrollments first.
      if (existing.status !== "closed" && existing.status !== "cancelled") {
        // The expected roster is an immutable snapshot for the session date.
        // Never add students who enrolled after this session took place. Only
        // hydrate a completely empty legacy snapshot; a non-empty snapshot is
        // authoritative and must not be expanded on every activation.
        const hasExpected = db.getFirstSync<{ id: string }>(
          "SELECT id FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1",
          [existing.centerId, existing.id],
        );
        const expectedStudentIds = hasExpected
          ? []
          : this.getExpectedStudentIdsForGroup(
              { id: groupId, subjectId: existing.subjectId, teacherId: existing.teacherId } as Group,
              groupId,
              existing.sessionDate,
            );
        const now = new Date().toISOString();
        DatabaseService.runInTransaction(() => {
          for (const studentId of expectedStudentIds) {
            db.runSync(
              "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
              [`exp-${existing.id}-${studentId}`, existing.centerId, existing.id, studentId, now],
            );
          }
        });
      }
      return existing;
    }
    const group = GroupRepository.findById(groupId);
    if (!group) throw new ConflictError("المجموعة غير موجودة.");
    const schedule = GroupScheduleRepository.getSchedulesForGroup(groupId).find(
      (item) =>
        item.dayOfWeek === new Date(`${date}T12:00:00`).getDay() &&
        (!scheduleId || item.id === scheduleId),
    );
    if (!schedule) throw new ConflictError("لا يوجد موعد للمجموعة اليوم.");
    const now = new Date().toISOString();
    const sessionId = `sess-att-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const expectedStudentIds = this.getExpectedStudentIdsForGroup(group, group.id, date);
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-session-att-${sessionId}`;
    DatabaseService.runInTransaction(() => {
      db.runSync(`INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`, [sessionId, activeCenterId, group.id, schedule.id, group.subjectId, group.teacherId, group.sessionPrice, group.lateAfterMinutes, date, schedule.startTime, schedule.endTime, now]);
      for (const studentId of expectedStudentIds) db.runSync("INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)", [`exp-${sessionId}-${studentId}`, activeCenterId, sessionId, studentId, now]);
      AuditService.recordEvent({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, entityType: "session", entityId: sessionId, action: "session.attendance_start", payload: { groupId: group.id, scheduleId: schedule.id, sessionDate: date } });
      SyncRepository.enqueueOperation({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, operationType: "CREATE", entityType: "session", entityId: sessionId, payload: { groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, expectedStudentIds, status: "open", createdAt: now } });
    });
    // A session is a dependency for every attendance record. Queue its sync
    // immediately when attendance starts instead of waiting for the global
    // foreground interval, while preserving offline-first local operation.
    SyncEngine.syncCenterNow(activeCenterId).catch((error) => {
      console.warn("Background session-start sync notice:", error);
    });
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
    let sessionWasActivated = false;
    if (session.status === "scheduled") {
      db.runSync("UPDATE sessions SET status = 'open', updated_at = ? WHERE center_id = ? AND id = ?", [new Date().toISOString(), session.centerId, session.id]);
      sessionWasActivated = true;
    }
    // Always reconcile the expected snapshot before attendance starts. A
    // non-zero but stale snapshot must also receive students enrolled later.
    {
      // Activation must not mutate the historical roster.  Session generation
      // already captured students valid on session.sessionDate; only hydrate
      // an empty legacy snapshot using that same date.
      const existingExpected = db.getFirstSync<{ id: string }>(
        "SELECT id FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1",
        [session.centerId, sessionId],
      );
      const expectedStudentIds = existingExpected
        ? []
        : this.getExpectedStudentIdsForGroup(
            { id: session.groupId, subjectId: session.subjectId, teacherId: session.teacherId } as Group,
            session.groupId,
            session.sessionDate,
          );
      const now = new Date().toISOString();
      for (const studentId of expectedStudentIds) {
        db.runSync(
          "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [`exp-${sessionId}-${studentId}`, session.centerId, sessionId, studentId, now],
        );
      }
    }
    const deviceId = DeviceService.getDeviceIdSync();
    const reconciliationUpdatedAt = sessionWasActivated
      ? new Date().toISOString()
      : undefined;
    const expectedStudentIds = db.getAllSync<{ studentId: string }>(
      "SELECT student_id as studentId FROM session_expected_students WHERE center_id = ? AND session_id = ?",
      [session.centerId, session.id],
    ).map((row) => row.studentId);
    SyncRepository.enqueueOperation({
      centerId: session.centerId,
      userId: currentUser.id,
      deviceId,
      operationType: sessionWasActivated ? "UPDATE" : "session.reconcile",
      entityType: "session",
      entityId: session.id,
      // Send a complete session representation. This safely repairs older
      // local sessions that were created before a failed sync and therefore
      // do not yet exist on the server.
      payload: {
        groupId: session.groupId,
        scheduleId: session.scheduleId,
        subjectId: session.subjectId,
        teacherId: session.teacherId,
        sessionPrice: session.sessionPrice,
        lateAfterMinutes: session.lateAfterMinutes,
        sessionDate: session.sessionDate,
        startTime: session.startTime,
        endTime: session.endTime,
        expectedStudentIds,
        status: "open",
        ...(reconciliationUpdatedAt ? { updatedAt: reconciliationUpdatedAt } : {}),
      },
    });
    // This is intentionally outside the activation branch: a locally open
    // session that predates this fix is reconciled with the server each time
    // an operator starts attendance for it.
    SyncEngine.syncCenterNow(session.centerId).catch((error) => {
      console.warn("Background session-activation sync notice:", error);
    });
    return session;
  }

  static isExpected(sessionId: string, studentId: string): boolean {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) return false;
    const db = DatabaseService.getDb();
    const rawSession = db.getFirstSync<{ id: string; centerId: string; groupId: string; subjectId?: string | null; teacherId?: string | null; sessionDate: string; status: string }>(
      "SELECT id, center_id as centerId, group_id as groupId, subject_id as subjectId, teacher_id as teacherId, session_date as sessionDate, status FROM sessions WHERE center_id = ? AND id = ?",
      [activeCenterId, sessionId],
    );
    if (!rawSession || (rawSession.status !== "open" && rawSession.status !== "scheduled")) return false;

    // Older locally-generated sessions may not have the historical subject and
    // teacher snapshot columns populated. Resolve those values from the group
    // before checking package eligibility; otherwise a valid package student
    // is incorrectly rejected as "not expected" after an app update.
    let session = rawSession;
    if (!rawSession.subjectId || !rawSession.teacherId) {
      const group = db.getFirstSync<{ subjectId?: string | null; teacherId?: string | null }>(
        "SELECT subject_id as subjectId, teacher_id as teacherId FROM groups WHERE center_id = ? AND id = ?",
        [rawSession.centerId, rawSession.groupId],
      );
      session = {
        ...rawSession,
        subjectId: rawSession.subjectId || group?.subjectId || null,
        teacherId: rawSession.teacherId || group?.teacherId || null,
      };
    }
    if (db.getFirstSync(
      `SELECT 1 FROM session_expected_students
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [session.centerId, sessionId, studentId],
    )) return true;

    // A student may be added to an old/legacy session only when their
    // enrollment was valid on the session date.  Never use today's active
    // enrollment to rewrite a historical roster.
    const hasExpectedSnapshot = Boolean(
      db.getFirstSync<any>(
        "SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1",
        [session.centerId, sessionId],
      ),
    );
    const enrolled = !hasExpectedSnapshot && Boolean(db.getFirstSync<any>(
      `SELECT 1 FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND student_id = ?
         AND status = 'active'
         AND start_date <= ?
         AND (end_date IS NULL OR end_date >= ?)
       LIMIT 1`,
      [session.centerId, session.groupId, studentId, session.sessionDate, session.sessionDate],
    ));
    if (enrolled) {
      const now = new Date().toISOString();
      db.runSync(
        "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [`exp-${sessionId}-${studentId}`, session.centerId, sessionId, studentId, now],
      );
      return true;
    }

    // Package students may not have a regular group enrollment. Their
    // selected package option is still a valid attendance expectation for
    // the matching subject, teacher, and (when configured) group.
    const packageEligible = Boolean(
      session.subjectId &&
      session.teacherId &&
      db.getFirstSync<any>(
      `SELECT 1
       FROM student_package_subscriptions sps
       JOIN package_subjects ps
         ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id
        AND selected.subscription_id = sps.id
        AND selected.subject_id = ps.subject_id
       WHERE sps.center_id = ? AND sps.student_id = ? AND sps.status = 'active'
         AND sps.start_date <= ? AND (sps.end_date IS NULL OR sps.end_date >= ?)
         AND ps.subject_id = ?
         AND (ps.group_id IS NULL OR ps.group_id = ?)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
         AND (
           selected.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = sps.center_id
               AND any_selection.subscription_id = sps.id
           )
         )
       LIMIT 1`,
      [
        session.centerId,
        studentId,
        session.sessionDate,
        session.sessionDate,
        session.subjectId,
        session.groupId,
        session.teacherId,
      ],
    ));
    if (!packageEligible) return false;

    const now = new Date().toISOString();
    db.runSync(
      "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [`exp-${sessionId}-${studentId}`, session.centerId, sessionId, studentId, now],
    );
    return true;
  }

  static getSummary(sessionId: string): AttendanceSummary {
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<{ centerId: string }>(
      "SELECT center_id as centerId FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (!session) return { total: 0, present: 0, absent: 0 };
    const expected = db.getAllSync<any>(
      "SELECT student_id as studentId FROM session_expected_students WHERE center_id = ? AND session_id = ?",
      [session.centerId, sessionId],
    );
    let normalizedExpected = expected
      .map((row: any) => row.studentId ?? row.student_id)
      .filter(Boolean)
      .map(String);
    const attendance = db.getAllSync<any>(
      "SELECT student_id as studentId, status, attendance_type as attendanceType FROM attendance WHERE center_id = ? AND session_id = ?",
      [session.centerId, sessionId],
    );
    const normalizedAttendance = attendance.map((row: any) => ({
      ...row,
      studentId: row.studentId ?? row.student_id,
      attendanceType: row.attendanceType ?? row.attendance_type,
    }));
    // Legacy sessions may have no immutable roster snapshot. Reconstruct the
    // same historical roster used by the dashboard, then include a regular
    // attendance row as a last-resort signal so the session counter cannot
    // show zero while the student's attendance is visibly recorded.
    if (normalizedExpected.length === 0) {
      const sessionInfo = db.getFirstSync<any>(
        "SELECT group_id as groupId, session_date as sessionDate FROM sessions WHERE center_id = ? AND id = ?",
        [session.centerId, sessionId],
      );
      const enrollments = sessionInfo
        ? EnrollmentRepository.getActiveEnrollmentsForGroup(sessionInfo.groupId, sessionInfo.sessionDate)
        : [];
      const ids = new Set<string>(enrollments.map((row: any) => String(row.studentId ?? row.student_id)));
      for (const row of normalizedAttendance) {
        if (row.studentId && row.attendanceType !== "makeup") ids.add(String(row.studentId));
      }
      normalizedExpected = Array.from(ids);
    }
    const coveredInAdvance = db.getAllSync<{ studentId: string }>(
      "SELECT student_id as studentId FROM advance_coverages WHERE center_id = ? AND target_future_session_id = ?",
      [session.centerId, sessionId],
    );
    const counts = calculateSessionAttendanceCounts(
      normalizedExpected,
      normalizedAttendance,
      coveredInAdvance.map((row: any) => row.studentId ?? row.student_id).filter(Boolean),
    );
    return { total: counts.expected, present: counts.present, absent: counts.absent };
  }
}
