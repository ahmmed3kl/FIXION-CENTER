import { DatabaseService, LocalDataEvents } from "../../core/database";
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
import {
  calculateSessionAttendanceCounts,
  excludeCompensationVisitorsFromExpectedRoster,
} from "./AttendanceCalculations";
import { stableSessionId } from "../../shared/utils/stableIds";
import { DEFAULT_TEACHER_WEEK_START_DAY, isTeacherMakeupCycleOpen } from "../../shared/utils/teacherWeeks";
import { normalizeAcademicGrade } from "../../shared/utils/smartSearch";
import { SessionDateService } from "../sessions/SessionDateService";

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  notStarted: number;
  makeup: number;
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
  static getCurrentSessionDate(now = new Date()): string {
    return SessionDateService.getCurrentSessionDate(undefined, now);
  }

  static getMakeupEligibility(sessionId: string, studentId: string): MakeupEligibility {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) return { eligible: false };
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<any>(
      `SELECT s.group_id as groupId, s.session_date as sessionDate,
              s.start_time as startTime,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              g.name as groupName, g.grade as groupGrade, t.name as teacherName,
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
      `SELECT g.id as groupId, g.name as groupName, s.id as originalSessionId,
              s.session_date as originalSessionDate,
              g.grade as groupGrade,
              COALESCE(sourceTeacher.week_start_day, 6) as weekStartDay
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       LEFT JOIN teachers sourceTeacher ON sourceTeacher.center_id = g.center_id AND sourceTeacher.id = COALESCE(s.teacher_id, g.teacher_id)
       LEFT JOIN subjects sourceSubject ON sourceSubject.center_id = g.center_id AND sourceSubject.id = COALESCE(s.subject_id, g.subject_id)
       WHERE s.center_id = ?
         AND (
           s.session_date < ?
           OR (s.session_date = ? AND (COALESCE(s.start_time, '') < COALESCE(?, '') OR s.id <> ?))
         )
         AND s.status <> 'cancelled'
         AND (COALESCE(s.teacher_id, g.teacher_id) = ? OR LOWER(TRIM(sourceTeacher.name)) = LOWER(TRIM(?)))
         AND g.id <> ?
         AND (COALESCE(s.subject_id, g.subject_id) = ? OR LOWER(TRIM(sourceSubject.name)) = LOWER(TRIM(?)))
         AND (? IS NULL OR g.grade = ? OR REPLACE(REPLACE(g.grade, 'الصف ', ''), 'صف ', '') = REPLACE(REPLACE(?, 'الصف ', ''), 'صف ', ''))
         -- A source session can come from a regular enrollment or a package
         -- roster snapshot. This keeps package students eligible for makeup.
         AND (
           EXISTS (
             SELECT 1 FROM session_expected_students expected
             WHERE expected.center_id = s.center_id
               AND expected.session_id = s.id
               AND expected.student_id = ?
           )
           OR EXISTS (
             SELECT 1 FROM student_group_enrollments e
             WHERE e.center_id = s.center_id
               AND e.group_id = s.group_id
               AND e.student_id = ?
               AND e.status IN ('active', 'ended')
               AND (e.start_date <= s.session_date OR SUBSTR(e.created_at, 1, 10) <= s.session_date)
               AND (e.end_date IS NULL OR e.end_date >= s.session_date)
           )
         )
         AND EXISTS (
           SELECT 1 FROM attendance absent
           WHERE absent.center_id = s.center_id
             AND absent.session_id = s.id AND absent.student_id = ?
             AND absent.status = 'absent'
             AND COALESCE(absent.attendance_type, 'present') <> 'makeup'
         )
         AND NOT EXISTS (
           SELECT 1 FROM attendance present
           WHERE present.center_id = s.center_id
             AND present.session_id = s.id AND present.student_id = ?
             AND present.status IN ('present', 'late')
         )
         AND NOT EXISTS (
           SELECT 1 FROM advance_coverages coverage
           WHERE coverage.center_id = s.center_id
             AND coverage.student_id = ? AND coverage.target_future_session_id = s.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM attendance makeup
           WHERE makeup.center_id = s.center_id AND makeup.student_id = ?
             AND (makeup.original_absence_id = s.id
                  OR makeup.original_absence_id = ('absence-' || s.id || '-' || ?))
         )
       ORDER BY s.session_date DESC, s.start_time DESC LIMIT 1`,
      [activeCenterId, session.sessionDate, session.sessionDate, session.startTime, sessionId, session.teacherId, session.teacherName || "", session.groupId, session.subjectId, session.subjectName || "", session.groupGrade || null, session.groupGrade || null, session.groupGrade || null, studentId, studentId, studentId, studentId, studentId, studentId, studentId],
    );
    if (
      source &&
      (!session.groupGrade || !source.groupGrade || normalizeAcademicGrade(source.groupGrade) === normalizeAcademicGrade(session.groupGrade)) &&
      isTeacherMakeupCycleOpen(
        source.originalSessionDate,
        session.sessionDate,
        source.weekStartDay ?? DEFAULT_TEACHER_WEEK_START_DAY,
        this.localDate(),
      )
    ) {
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

    // Without a concrete historical session there is no canonical absence id
    // to link to, so do not show a makeup action that will fail validation.
    return { eligible: false };
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
       JOIN students enrolled_student
         ON enrolled_student.center_id = sps.center_id
        AND enrolled_student.id = sps.student_id
        AND enrolled_student.deleted_at IS NULL
       JOIN package_subjects ps
         ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id
        AND selected.subscription_id = sps.id
        AND selected.subject_id = ps.subject_id
       WHERE sps.center_id = ? AND sps.status = 'active'
         AND sps.start_date <= ? AND (sps.end_date IS NULL OR sps.end_date >= ?)
         AND ps.subject_id = ?
         AND (ps.group_id = ? OR selected.group_id = ?)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
         AND (selected.id IS NULL OR selected.group_id = ?)
         AND (
           selected.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = sps.center_id
               AND any_selection.subscription_id = sps.id
           )
         )`,
      [activeCenterId, sessionDate, sessionDate, subjectId, groupId, groupId, teacherId, groupId],
    );
    return rows.map((row) => String(row.studentId ?? row.student_id ?? "")).filter(Boolean);
  }

  /** Build the immutable roster for a session date, including package-only
   * subscribers selected for this exact subject/teacher/group. */
  static getExpectedStudentIdsForGroup(
    group: Pick<Group, "subjectId" | "teacherId">,
    groupId: string,
    sessionDate: string,
  ): string[] {
    const regular = EnrollmentRepository.getActiveEnrollmentsForGroup(groupId, sessionDate).map((item) => item.studentId);
    const lateEnrollments = this.getLateSameDayEnrollmentStudentIds(groupId, sessionDate);
    const packageStudents = this.getPackageExpectedStudentIds(groupId, group.subjectId, group.teacherId, sessionDate);
    return Array.from(new Set([...regular, ...lateEnrollments, ...packageStudents]));
  }

  private static getLateSameDayEnrollmentStudentIds(
    groupId: string,
    sessionDate: string,
  ): string[] {
    const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(groupId)
      .filter((enrollment) =>
        enrollment.startDate > sessionDate &&
        (!enrollment.endDate || enrollment.endDate >= sessionDate)
      );
    if (!enrollments.length) return [];

    const schedules = GroupScheduleRepository.getSchedulesForGroup(groupId);
    return enrollments
      .filter((enrollment) =>
        GroupScheduleRepository.isLateEnrollmentForSessionDate(
          groupId,
          sessionDate,
          enrollment.startDate,
          enrollment.createdAt,
          schedules,
        )
      )
      .map((enrollment) => enrollment.studentId);
  }

  static ensureSessionForGroup(
    groupId: string,
    date = AttendanceSessionService.localDate(),
    scheduleId?: string,
    legacySessionId?: string,
  ): Session {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new ForbiddenError("يجب تسجيل الدخول أولاً.");
    const db = DatabaseService.getDb();
    const group = GroupRepository.findById(groupId);
    if (!group || group.status !== "active") throw new ConflictError("المجموعة غير موجودة أو غير مفعلة.");
    const dayOfWeek = new Date(`${date}T12:00:00`).getDay();
    const schedulesForDay = GroupScheduleRepository.getSchedulesForGroup(groupId)
      .filter((item) => item.dayOfWeek === dayOfWeek);
    if (scheduleId && legacySessionId) {
      throw new ConflictError("اختر موعدًا مجدولًا أو جلسة قديمة بلا موعد، وليس الاثنين معًا.");
    }
    if (legacySessionId) {
      const selectedLegacySession = SessionRepository.findById(legacySessionId);
      if (
        !selectedLegacySession ||
        selectedLegacySession.centerId !== activeCenterId ||
        selectedLegacySession.groupId !== groupId ||
        selectedLegacySession.sessionDate !== date ||
        selectedLegacySession.scheduleId
      ) {
        throw new ConflictError("الجلسة المحددة بلا موعد لا تطابق المركز أو المجموعة أو التاريخ الحالي.");
      }
      if (selectedLegacySession.status === "cancelled") {
        throw new ConflictError("الجلسة ملغاة ولا يمكن إعادة تفعيلها.");
      }
      return selectedLegacySession;
    }
    if (!scheduleId) {
      const unscheduledSessions = SessionRepository.getSessionsForDate(date)
        .filter((session) =>
          session.centerId === activeCenterId &&
          session.groupId === groupId &&
          session.sessionDate === date &&
          !session.scheduleId,
        );
      if (unscheduledSessions.length > 0) {
        throw new ConflictError("لا يمكن اختيار جلسة قديمة بلا موعد اعتمادًا على المجموعة والتاريخ فقط؛ حدّد معرّف الجلسة أو موعد الحصة.");
      }
    }
    const matchingSchedule = scheduleId
      ? schedulesForDay.find((item) => item.id === scheduleId)
      : schedulesForDay.length === 1
        ? schedulesForDay[0]
        : null;
    if (scheduleId && !matchingSchedule) {
      throw new ConflictError("الموعد المحدد غير موجود أو لا يخص المجموعة في هذا اليوم.");
    }
    if (!scheduleId && schedulesForDay.length > 1) {
      throw new ConflictError("للمجموعة أكثر من موعد اليوم؛ اختر موعد الحصة قبل بدء الحضور.");
    }
    const resolvedScheduleId = matchingSchedule?.id;
    if (!resolvedScheduleId && schedulesForDay.length === 0) {
      throw new ConflictError("لا يوجد موعد مجدول أو جلسة بلا موعد يمكن تحديدها لهذه المجموعة اليوم.");
    }
    if (!resolvedScheduleId) {
      throw new ConflictError("تعذر تحديد هوية الحصة المجدولة بأمان.");
    }
    const stableId = stableSessionId(activeCenterId, groupId, resolvedScheduleId || "", date);
    const canonicalStableId = SyncRepository.resolveSessionAlias(activeCenterId, stableId);
    const byStableId = db.getFirstSync<any>(
      "SELECT id, center_id as centerId, group_id as groupId, schedule_id as scheduleId, subject_id as subjectId, teacher_id as teacherId, session_price as sessionPrice, late_after_minutes as lateAfterMinutes, session_date as sessionDate, start_time as startTime, end_time as endTime, status, created_at as createdAt FROM sessions WHERE center_id = ? AND id = ?",
      [activeCenterId, canonicalStableId],
    );
    if (
      byStableId &&
      byStableId.groupId === groupId &&
      byStableId.sessionDate === date &&
      byStableId.scheduleId === resolvedScheduleId
    ) {
      if (byStableId.status === "cancelled") {
        throw new ConflictError("الجلسة ملغاة ولا يمكن إعادة تفعيلها.");
      }
      return byStableId as Session;
    }
    const cancelledSlot = SessionRepository.getSessionsForDate(date)
      .find((session) => session.groupId === groupId && session.scheduleId === resolvedScheduleId && session.status === "cancelled");
    if (cancelledSlot) throw new ConflictError("الجلسة ملغاة ولا يمكن إعادة تفعيلها.");
    // A timetable slot has its own attendance session; never reuse another
    // slot from the same group's date.
    const existingSessions = SessionRepository.getSessionsForDate(date)
      .filter((session) =>
        session.centerId === activeCenterId &&
        session.groupId === groupId &&
        session.sessionDate === date &&
        session.scheduleId === resolvedScheduleId,
      );
    if (existingSessions.length > 1) {
      throw new ConflictError("توجد جلسات مكررة لنفس الموعد والتاريخ؛ لم يتم اختيار واحدة تلقائيًا.");
    }
    const existing = existingSessions[0];
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
        // Keep an open session's roster in sync with date-valid enrollments.
        // Activation records the default absence for each newly expected student.
        const expectedStudentIds = this.getExpectedStudentIdsForGroup(
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
    SessionDateService.getCenterTimeZone(activeCenterId);
    const schedule = matchingSchedule;
    if (!schedule) throw new ConflictError("لا يوجد موعد للمجموعة اليوم.");
    const now = new Date().toISOString();
    let sessionId = stableSessionId(activeCenterId, group.id, schedule.id, date);
    const stableIdOwner = db.getFirstSync<any>(
      `SELECT group_id as groupId, schedule_id as scheduleId, session_date as sessionDate
         FROM sessions WHERE center_id = ? AND id = ?`,
      [activeCenterId, sessionId],
    );
    if (
      stableIdOwner &&
      (stableIdOwner.groupId !== group.id ||
        stableIdOwner.scheduleId !== schedule.id ||
        stableIdOwner.sessionDate !== date)
    ) {
      sessionId = stableSessionId(activeCenterId, group.id, `${schedule.id}:collision`, date);
      const fallbackOwner = db.getFirstSync<any>(
        `SELECT group_id as groupId, schedule_id as scheduleId, session_date as sessionDate
           FROM sessions WHERE center_id = ? AND id = ?`,
        [activeCenterId, sessionId],
      );
      if (
        fallbackOwner &&
        (fallbackOwner.groupId !== group.id ||
          fallbackOwner.scheduleId !== schedule.id ||
          fallbackOwner.sessionDate !== date)
      ) {
        throw new ConflictError("تعذر إنشاء معرّف آمن لهذه الجلسة بسبب تعارض معرّف موجود.");
      }
    }
    const expectedStudentIds = this.getExpectedStudentIdsForGroup(group, group.id, date);
    const deviceId = DeviceService.getDeviceIdSync();
    const operationDeviceKey = stableSessionId(deviceId, sessionId, "attendance-start", date);
    const operationId = `op-session-att-${sessionId}-${operationDeviceKey.slice(-12)}`;
    try {
      DatabaseService.runInTransaction(() => {
        db.runSync(`INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`, [sessionId, activeCenterId, group.id, schedule.id, group.subjectId, group.teacherId, group.sessionPrice, group.lateAfterMinutes, date, schedule.startTime, schedule.endTime, now]);
        for (const studentId of expectedStudentIds) db.runSync("INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)", [`exp-${sessionId}-${studentId}`, activeCenterId, sessionId, studentId, now]);
        AuditService.recordEvent({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, entityType: "session", entityId: sessionId, action: "session.attendance_start", payload: { groupId: group.id, scheduleId: schedule.id, sessionDate: date } });
        SyncRepository.enqueueOperation({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, operationType: "CREATE", entityType: "session", entityId: sessionId, payload: { groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, expectedStudentIds, status: "open", createdAt: now } });
      });
    } catch (error) {
      if (!String((error as any)?.message || error).toLowerCase().includes("unique")) throw error;
      const racedSessions = SessionRepository.getSessionsForDate(date).filter(
        (item) =>
          item.centerId === activeCenterId &&
          item.groupId === group.id &&
          item.sessionDate === date &&
          item.status !== "cancelled" &&
          item.scheduleId === resolvedScheduleId,
      );
      if (racedSessions.length === 1) return racedSessions[0];
      if (racedSessions.length > 1) {
        throw new ConflictError("حدث تعارض بين جلسات مكررة للموعد نفسه؛ يلزم حل التعارض قبل المتابعة.");
      }
      const inserted = db.getFirstSync<any>("SELECT id, center_id as centerId, group_id as groupId, schedule_id as scheduleId, subject_id as subjectId, teacher_id as teacherId, session_price as sessionPrice, late_after_minutes as lateAfterMinutes, session_date as sessionDate, start_time as startTime, end_time as endTime, status, created_at as createdAt FROM sessions WHERE center_id = ? AND id = ?", [activeCenterId, sessionId]);
      if (
        inserted &&
        inserted.groupId === group.id &&
        inserted.scheduleId === schedule.id &&
        inserted.sessionDate === date
      ) {
        return inserted as Session;
      }
      throw error;
    }
    // A session is a dependency for every attendance record. Queue its sync
    // immediately when attendance starts instead of waiting for the global
    // foreground interval, while preserving offline-first local operation.
    SyncEngine.syncCenterNow(activeCenterId).catch((error) => {
      console.warn("Background session-start sync notice:", error);
    });
    return { id: sessionId, centerId: activeCenterId, groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, status: "open", createdAt: now, groupName: group.name, teacherName: group.teacherName, subjectName: group.subjectName };
  }

  static getTodaySessions(date = AttendanceSessionService.localDate()): Session[] {
    // Include closed sessions as well. A closed session is still the same
    // historical session for this group/day and must be shown so an operator
    // can explicitly reopen it instead of creating a second session.
    const sessions = SessionRepository.getSessionsForDate(date).filter((session) => session.status !== "cancelled");
    const scheduledGroupIds = new Set(GroupRepository.getGroupsForDay(new Date(`${date}T12:00:00`).getDay()).map((group) => group.id));
    return sessions.filter((session) => scheduledGroupIds.has(session.groupId));
  }

  private static localDate(date = new Date()): string {
    return SessionDateService.getCurrentSessionDate(undefined, date);
  }

  private static recordInitialAbsenceIfMissing(
    centerId: string,
    sessionId: string,
    studentId: string,
    user: { id: string; fullName: string },
    deviceId: string,
    recordedAt: string,
  ): string | null {
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<{ id: string }>(
      `SELECT id FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (existing) return null;

    const attendanceId = `att-default-${sessionId}-${studentId}`;
    const operationId = `op-att-default-${sessionId}-${studentId}`;
    const inserted = db.runSync(
      `INSERT OR IGNORE INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status,
          is_late, attendance_type, original_absence_id, is_external, operation_id)
       VALUES (?, ?, ?, ?, ?, 'absent', 0, 'present', NULL, 0, ?)`,
      [attendanceId, centerId, studentId, sessionId, recordedAt, operationId],
    );
    if (Number(inserted.changes) !== 1) {
      const concurrentRecord = db.getFirstSync<{ id: string }>(
        `SELECT id FROM attendance
         WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, sessionId, studentId],
      );
      if (concurrentRecord) return null;
      throw new ConflictError("تعذر حفظ سجل الغياب المبدئي دون المساس بسجلات الحضور الموجودة.");
    }

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: attendanceId,
      payload: {
        id: attendanceId,
        centerId,
        studentId,
        sessionId,
        checkInTime: recordedAt,
        status: "absent",
        isLate: false,
        attendanceType: "present",
        originalAbsenceId: null,
        isExternal: false,
        operationId,
      },
    });
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "attendance",
      entityId: attendanceId,
      action: "attendance.record",
      payload: {
        status: "absent",
        studentId,
        sessionId,
        reason: "session_start",
        actorName: user.fullName,
      },
    });
    return attendanceId;
  }

  static activate(sessionId: string): Session {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser || !PermissionService.hasPermission(currentUser.permissions, "attendance.create")) {
      throw new ForbiddenError("ليس لديك صلاحية بدء جلسة الحضور.");
    }
    const canonicalSessionId = SyncRepository.resolveSessionAlias(activeCenterId, sessionId);
    const session = SessionRepository.findById(canonicalSessionId);
    // A closed session is reopened only through the explicit reopen action.
    if (!session) throw new ConflictError("جلسة الحضور غير موجودة.");
    if (session.status !== "scheduled" && session.status !== "open") {
      throw new ConflictError("لا يمكن بدء جلسة مغلقة أو ملغاة.");
    }

    const db = DatabaseService.getDb();
    let sessionWasActivated = false;
    const activationOperationId = `op-session-activate-${session.id}`;
    if (session.status === "scheduled") {
      DatabaseService.runInTransaction(() => {
        const currentSession = db.getFirstSync<{ status: string }>(
          "SELECT status FROM sessions WHERE center_id = ? AND id = ?",
          [session.centerId, session.id],
        );
        const currentStatus = String(currentSession?.status || "").toLowerCase();
        if (!currentSession || currentStatus === "cancelled" || currentStatus === "closed") {
          throw new ConflictError("لا يمكن بدء جلسة مغلقة أو ملغاة.");
        }
        if (currentStatus !== "scheduled" && currentStatus !== "open") {
          throw new ConflictError("حالة الجلسة لا تسمح ببدء الحضور.");
        }
        if (currentStatus === "scheduled") {
          const now = new Date().toISOString();
          db.runSync(
            "UPDATE sessions SET status = 'open', updated_at = ? WHERE center_id = ? AND id = ? AND status = 'scheduled'",
            [now, session.centerId, session.id],
          );
          AuditService.recordEvent({
            operationId: activationOperationId,
            centerId: session.centerId,
            userId: currentUser.id,
            deviceId: DeviceService.getDeviceIdSync(),
            entityType: "session",
            entityId: session.id,
            action: "session.activated",
            payload: { groupId: session.groupId, scheduleId: session.scheduleId, sessionDate: session.sessionDate },
          });
          sessionWasActivated = true;
        }
      });
    }
    // Always reconcile the expected snapshot before attendance starts. A
    // non-zero but stale snapshot must also receive students enrolled later.
    {
      // Activation must not mutate the historical roster.  Session generation
      // already captured students valid on session.sessionDate; only hydrate
      // an empty legacy snapshot using that same date.
      const expectedStudentIds = this.getExpectedStudentIdsForGroup(
        { id: session.groupId, subjectId: session.subjectId, teacherId: session.teacherId } as Group,
        session.groupId,
        session.sessionDate,
      );
      const now = new Date().toISOString();
      for (const studentId of expectedStudentIds) {
        db.runSync(
          "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [`exp-${session.id}-${studentId}`, session.centerId, session.id, studentId, now],
        );
      }
    }
    const deviceId = DeviceService.getDeviceIdSync();
    const activationWasAudited = Boolean(db.getFirstSync<{ id: string }>(
      `SELECT id FROM audit_logs
       WHERE center_id = ? AND entity_type = 'session' AND entity_id = ?
         AND action = 'session.activated'
       LIMIT 1`,
      [session.centerId, session.id],
    ));
    const activationOperationExists = Boolean(
      SyncRepository.getByOperationId(activationOperationId),
    );
    const shouldEnqueueActivation =
      sessionWasActivated || activationWasAudited || activationOperationExists;
    const reconciliationUpdatedAt = sessionWasActivated
      ? new Date().toISOString()
      : undefined;
    const expectedStudentIds = SessionRepository.getExpectedStudentIdsForSession(session.id);
    const expectedRosterKey = JSON.stringify(
      Array.from(new Set(expectedStudentIds.map(String))).sort(),
    );
    const advancedStudentIds = new Set(
      db.getAllSync<{ studentId: string }>(
        `SELECT student_id as studentId FROM advance_coverages
         WHERE center_id = ? AND target_future_session_id = ?`,
        [session.centerId, session.id],
      ).map((row) => row.studentId),
    );
    const initialAbsenceIds: string[] = [];
    const defaultAbsenceRecordedAt = new Date().toISOString();
    DatabaseService.runInTransaction(() => {
      const currentSession = db.getFirstSync<{ status: string }>(
        "SELECT status FROM sessions WHERE center_id = ? AND id = ?",
        [session.centerId, session.id],
      );
      if (!currentSession || currentSession.status !== "open") {
        throw new ConflictError("لا يمكن تسجيل الغياب المبدئي إلا بعد بدء الجلسة.");
      }

      for (const studentId of expectedStudentIds) {
        if (advancedStudentIds.has(studentId)) continue;
        const attendanceId = this.recordInitialAbsenceIfMissing(
          session.centerId,
          session.id,
          studentId,
          currentUser,
          deviceId,
          defaultAbsenceRecordedAt,
        );
        if (attendanceId) initialAbsenceIds.push(attendanceId);
      }
    });
    const queuedReconciliation = shouldEnqueueActivation
      ? null
      : db.getAllSync<{ operationId: string; payload: string }>(
          `SELECT operation_id as operationId, payload
           FROM sync_operations
           WHERE center_id = ? AND entity_type = 'session' AND entity_id = ?
             AND operation_type = 'session.reconcile'
             AND status IN ('pending', 'syncing', 'failed', 'conflict')
           ORDER BY created_at ASC`,
          [session.centerId, session.id],
        ).find((operation) => {
          const payload =
            typeof operation.payload === "string"
              ? JSON.parse(operation.payload || "{}")
              : operation.payload || {};
          const queuedStudentIds =
            payload.expectedStudentIds || payload.expected_student_ids || [];
          const queuedRosterKey = JSON.stringify(
            Array.isArray(queuedStudentIds)
              ? Array.from(new Set(queuedStudentIds.map(String))).sort()
              : [],
          );
          return (
            String(payload.groupId || payload.group_id || "") ===
              session.groupId &&
            String(payload.scheduleId || payload.schedule_id || "") ===
              String(session.scheduleId || "") &&
            String(payload.sessionDate || payload.session_date || "") ===
              session.sessionDate &&
            queuedRosterKey === expectedRosterKey
          );
        }) || null;
    const reconciliationOperationId =
      queuedReconciliation?.operationId ||
      `op-session-reconcile-${stableSessionId(
        session.centerId,
        session.groupId,
        `${session.scheduleId || session.id}|${expectedRosterKey}`,
        session.sessionDate,
      )}`;
    SyncRepository.enqueueOperation({
      operationId: shouldEnqueueActivation
        ? activationOperationId
        : reconciliationOperationId,
      centerId: session.centerId,
      userId: currentUser.id,
      deviceId,
      operationType: shouldEnqueueActivation ? "UPDATE" : "session.reconcile",
      entityType: "session",
      entityId: session.id,
      // Send a complete session representation. This safely repairs older
      // local sessions that were created before a failed sync and therefore
      // do not yet exist on the server.
      payload: {
        ...(shouldEnqueueActivation ? { action: "activate" } : {}),
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
    for (const attendanceId of initialAbsenceIds) {
      LocalDataEvents.emit({
        centerId: session.centerId,
        entityType: "attendance",
        entityId: attendanceId,
      });
    }
    return session;
  }

  static isExpected(sessionId: string, studentId: string, includeClosed = false): boolean {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) return false;
    const db = DatabaseService.getDb();
    const rawSession = db.getFirstSync<{ id: string; centerId: string; groupId: string; subjectId?: string | null; teacherId?: string | null; sessionDate: string; status: string }>(
      "SELECT id, center_id as centerId, group_id as groupId, subject_id as subjectId, teacher_id as teacherId, session_date as sessionDate, status FROM sessions WHERE center_id = ? AND id = ?",
      [activeCenterId, sessionId],
    );
    if (
      !rawSession ||
      (rawSession.status !== "open" && rawSession.status !== "scheduled" &&
        !(includeClosed && rawSession.status === "closed"))
    ) return false;

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
    const snapshotEntries = db.getAllSync<{ id: string; studentId: string }>(
      `SELECT id, student_id as studentId FROM session_expected_students
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [session.centerId, sessionId, studentId],
    );
    if (snapshotEntries.length > 0) {
      return SessionRepository.getExpectedStudentIdsForSession(sessionId).includes(studentId);
    }

    // A student may be added to an old/legacy session only when their
    // enrollment was valid on the session date.  Never use today's active
    // enrollment to rewrite a historical roster.
    const enrolled = SessionRepository.getEligibleStudentIdsForSession(sessionId).includes(studentId);
    if (enrolled) {
      if (rawSession.status === "closed") return true;
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
         AND (ps.group_id = ? OR selected.group_id = ?)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
       AND (selected.id IS NULL OR selected.group_id = ?)
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
        session.groupId,
        session.teacherId,
        session.groupId,
      ],
    ));
    if (!packageEligible) return false;

    if (rawSession.status === "closed") return true;
    const now = new Date().toISOString();
    db.runSync(
      "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [`exp-${sessionId}-${studentId}`, session.centerId, sessionId, studentId, now],
    );
    return true;
  }

  static getSummary(sessionId: string): AttendanceSummary {
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<{ id: string; centerId: string; groupId: string; subjectId?: string | null; teacherId?: string | null; sessionDate: string; status: string }>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_date as sessionDate, s.status
       FROM sessions s JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       WHERE s.id = ?`,
      [sessionId],
    );
    if (!session) return { total: 0, present: 0, absent: 0, notStarted: 0, makeup: 0 };
    const eligibleIds = SessionRepository.getExpectedStudentIdsForSession(sessionId);
    // Prefer live eligibility when available; use a saved non-compensation
    // roster only when local enrollment/package data yields no students.
    let normalizedExpected = eligibleIds;
    const attendance = db.getAllSync<any>(
      `SELECT student_id as studentId, status,
              attendance_type as attendanceType,
              original_absence_id as originalAbsenceId
       FROM attendance WHERE center_id = ? AND session_id = ?`,
      [session.centerId, sessionId],
    );
    const normalizedAttendance = attendance.map((row: any) => {
      const item = {
        ...row,
        studentId: row.studentId ?? row.student_id,
        attendanceType: row.attendanceType ?? row.attendance_type,
        originalAbsenceId: row.originalAbsenceId ?? row.original_absence_id,
      };
      if (
        item.attendanceType !== "makeup" ||
        (item.status !== "present" && item.status !== "late") ||
        !item.originalAbsenceId
      ) {
        return { ...item, originalAbsenceValid: false };
      }

      const originalSession = db.getFirstSync<any>(
        `SELECT s.id, s.group_id as groupId, s.session_date as sessionDate, s.status,
                COALESCE(s.subject_id, g.subject_id) as subjectId,
                COALESCE(s.teacher_id, g.teacher_id) as teacherId
         FROM sessions s
         JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
         WHERE s.center_id = ? AND s.id = ? AND s.status <> 'cancelled'`,
        [session.centerId, item.originalAbsenceId],
      );
      if (
        !originalSession ||
        originalSession.subjectId !== session.subjectId ||
        originalSession.teacherId !== session.teacherId
      ) {
        return { ...item, originalAbsenceValid: false };
      }

      const sourceHasSnapshot = Boolean(db.getFirstSync<any>(
        `SELECT 1 FROM session_expected_students
         WHERE center_id = ? AND session_id = ? LIMIT 1`,
        [session.centerId, originalSession.id],
      ));
      const sourceExpected = sourceHasSnapshot
        ? Boolean(db.getFirstSync<any>(
          `SELECT 1 FROM session_expected_students
           WHERE center_id = ? AND session_id = ? AND student_id = ?
             AND id NOT LIKE ?`,
          [
            session.centerId,
            originalSession.id,
            item.studentId,
            `exp-comp-${originalSession.id}-%`,
          ],
        ))
        : Boolean(db.getFirstSync<any>(
          `SELECT 1 FROM student_group_enrollments
           WHERE center_id = ? AND group_id = ? AND student_id = ?
             AND status IN ('active', 'ended')
             AND (start_date <= ? OR SUBSTR(created_at, 1, 10) <= ?) AND (end_date IS NULL OR end_date >= ?)
           LIMIT 1`,
          [
            session.centerId,
            originalSession.groupId,
            item.studentId,
            originalSession.sessionDate,
            originalSession.sessionDate,
            originalSession.sessionDate,
          ],
        )) || this.getPackageExpectedStudentIds(
          originalSession.groupId,
          originalSession.subjectId,
          originalSession.teacherId,
          originalSession.sessionDate,
        ).includes(item.studentId);
      const attendedOriginal = Boolean(db.getFirstSync<any>(
        `SELECT 1 FROM attendance
         WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [session.centerId, originalSession.id, item.studentId],
      ));
      return {
        ...item,
        originalAbsenceValid: sourceExpected && !attendedOriginal,
      };
    });
    normalizedExpected = excludeCompensationVisitorsFromExpectedRoster(
      normalizedExpected,
      normalizedAttendance,
      eligibleIds,
    );
    const coveredInAdvance = db.getAllSync<{ studentId: string }>(
      "SELECT student_id as studentId FROM advance_coverages WHERE center_id = ? AND target_future_session_id = ?",
      [session.centerId, sessionId],
    );
    const counts = calculateSessionAttendanceCounts(
      normalizedExpected,
      normalizedAttendance,
      coveredInAdvance.map((row: any) => row.studentId ?? row.student_id).filter(Boolean),
      session.status === "open" || session.status === "closed",
    );
    return {
      total: counts.expected,
      present: counts.present,
      absent: counts.absent,
      notStarted: counts.notStarted,
      makeup: counts.makeup,
    };
  }

  /**
   * Adds a compensation student to the session's expected roster so the
   * attendance validation passes. Called only after the operator explicitly
   * confirms compensation attendance.
   */
  /**
   * Adds a newly enrolled student to an already-open session's roster and
   * persists the roster change to the outbox before attendance is recorded.
   */
  static addEnrolledStudentToOpenSession(sessionId: string, studentId: string): void {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new ForbiddenError("يجب تسجيل الدخول أولاً.");
    if (!PermissionService.hasPermission(currentUser.permissions, "attendance.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل الحضور.");
    }
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<any>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId,
              s.session_date as sessionDate, s.status, s.schedule_id as scheduleId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes,
              s.start_time as startTime, s.end_time as endTime,
              s.created_at as createdAt, s.updated_at as updatedAt
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       WHERE s.center_id = ? AND s.id = ?`,
      [activeCenterId, sessionId],
    );
    if (!session) throw new ConflictError("جلسة الحضور غير موجودة.");
    if (session.status !== "open") throw new ConflictError("لا يمكن إضافة طالب إلى جلسة حضور غير مفتوحة.");

    const enrolled = Boolean(db.getFirstSync<any>(
      `SELECT 1 FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND student_id = ?
         AND status IN ('active', 'ended')
         AND (start_date <= ? OR SUBSTR(created_at, 1, 10) <= ?) AND (end_date IS NULL OR end_date >= ?)
       LIMIT 1`,
      [activeCenterId, session.groupId, studentId, session.sessionDate, session.sessionDate, session.sessionDate],
    ));
    const packageEligible = this.getPackageExpectedStudentIds(
      session.groupId,
      session.subjectId,
      session.teacherId,
      session.sessionDate,
    ).includes(studentId);
    if (!enrolled && !packageEligible) {
      throw new ConflictError("يجب تسجيل الطالب في المجموعة الحالية أو باقتها قبل تسجيل الحضور.");
    }

    const now = new Date().toISOString();
    const operationId = `op-session-roster-add-${sessionId}-${studentId}`;
    const deviceId = DeviceService.getDeviceIdSync();
    let initialAbsenceId: string | null = null;
    DatabaseService.runInTransaction(() => {
      const rosterInsert = db.runSync(
        `INSERT OR IGNORE INTO session_expected_students
         (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`exp-${sessionId}-${studentId}`, activeCenterId, sessionId, studentId, now],
      );
      if (Number(rosterInsert.changes) === 1) {
        AuditService.recordEvent({
          operationId,
          centerId: activeCenterId,
          userId: currentUser.id,
          deviceId,
          entityType: "session",
          entityId: sessionId,
          action: "session.roster.add",
          payload: { sessionId, studentId, groupId: session.groupId },
        });
        SyncRepository.enqueueOperation({
          operationId,
          centerId: activeCenterId,
          userId: currentUser.id,
          deviceId,
          operationType: "UPDATE",
          entityType: "session",
          entityId: sessionId,
          payload: {
            ...session,
            expectedStudentIds: [studentId],
            updatedAt: now,
          },
        });
      }

      const coveredInAdvance = db.getFirstSync<{ id: string }>(
        `SELECT id FROM advance_coverages
         WHERE center_id = ? AND student_id = ? AND target_future_session_id = ?`,
        [activeCenterId, studentId, sessionId],
      );
      if (!coveredInAdvance) {
        initialAbsenceId = this.recordInitialAbsenceIfMissing(
          activeCenterId,
          sessionId,
          studentId,
          currentUser,
          deviceId,
          now,
        );
      }
    });
    if (initialAbsenceId) {
      LocalDataEvents.emit({
        centerId: activeCenterId,
        entityType: "attendance",
        entityId: initialAbsenceId,
      });
    }
  }
}
