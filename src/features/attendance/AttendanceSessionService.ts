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
import { calculateSessionAttendanceCounts } from "./AbsenceReportsService";

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
         AND makeup.original_absence_id = ('absence-' || s.id || '-' || e.student_id)
       WHERE e.center_id = ? AND e.student_id = ? AND e.status = 'active'
         AND (g.teacher_id = ? OR LOWER(TRIM(sourceTeacher.name)) = LOWER(TRIM(?)))
         AND g.id <> ?
         AND (g.subject_id = ? OR LOWER(TRIM(sourceSubject.name)) = LOWER(TRIM(?)))
         -- A generated expected snapshot is preferred, but older/scheduled
         -- sessions may not have one. In that case the active enrollment and
         -- missing attendance still establish an absence eligible for makeup.
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
        originalAbsenceId: `absence-${source.originalSessionId}-${studentId}`,
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
          originalAbsenceId: `absence-${sessionId}-${studentId}`,
        }
      : { eligible: false };
  }
  static getTodayGroups(date = AttendanceSessionService.localDate()): Group[] {
    return GroupRepository.getGroupsForDay(new Date(`${date}T12:00:00`).getDay());
  }

  static ensureSessionForGroup(groupId: string, date = AttendanceSessionService.localDate()): Session {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new ForbiddenError("يجب تسجيل الدخول أولاً.");
    const db = DatabaseService.getDb();
    const existing = SessionRepository.getSessionsForDate(date).find((session) => session.groupId === groupId);
    if (existing) {
      // A session can have been generated before enrollments were synced (or
      // by an older build), leaving its expected-student snapshot empty. Do
      // not return that stale session as if it had no students; hydrate the
      // snapshot from the current active enrollments first.
      if (existing.status !== "closed" && existing.status !== "cancelled") {
        const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(groupId);
        const now = new Date().toISOString();
        DatabaseService.runInTransaction(() => {
          for (const enrollment of enrollments) {
            db.runSync(
              "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
              [`exp-${existing.id}-${enrollment.studentId}`, existing.centerId, existing.id, enrollment.studentId, now],
            );
          }
        });
      }
      return existing;
    }
    const group = GroupRepository.findById(groupId);
    if (!group) throw new ConflictError("المجموعة غير موجودة.");
    const schedule = GroupScheduleRepository.getSchedulesForGroup(groupId).find((item) => item.dayOfWeek === new Date(`${date}T12:00:00`).getDay());
    if (!schedule) throw new ConflictError("لا يوجد موعد للمجموعة اليوم.");
    const now = new Date().toISOString();
    const sessionId = `sess-att-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    db.runSync(`INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`, [sessionId, activeCenterId, group.id, schedule.id, group.subjectId, group.teacherId, group.sessionPrice, group.lateAfterMinutes, date, schedule.startTime, schedule.endTime, now]);
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(group.id);
    for (const enrollment of enrollments) db.runSync("INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)", [`exp-${sessionId}-${enrollment.studentId}`, activeCenterId, sessionId, enrollment.studentId, now]);
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-session-att-${sessionId}`;
    AuditService.recordEvent({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, entityType: "session", entityId: sessionId, action: "session.attendance_start", payload: { groupId: group.id, scheduleId: schedule.id, sessionDate: date } });
    SyncRepository.enqueueOperation({ operationId, centerId: activeCenterId, userId: currentUser.id, deviceId, operationType: "CREATE", entityType: "session", entityId: sessionId, payload: { groupId: group.id, scheduleId: schedule.id, subjectId: group.subjectId, teacherId: group.teacherId, sessionPrice: group.sessionPrice, lateAfterMinutes: group.lateAfterMinutes, sessionDate: date, startTime: schedule.startTime, endTime: schedule.endTime, expectedStudentIds: enrollments.map((item) => item.studentId), status: "open", createdAt: now } });
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
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(session.groupId);
      const now = new Date().toISOString();
      for (const enrollment of enrollments) {
        db.runSync(
          "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [`exp-${sessionId}-${enrollment.studentId}`, session.centerId, sessionId, enrollment.studentId, now],
        );
      }
    }
    const deviceId = DeviceService.getDeviceIdSync();
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
        updatedAt: new Date().toISOString(),
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
    const db = DatabaseService.getDb();
    if (db.getFirstSync("SELECT 1 FROM session_expected_students WHERE session_id = ? AND student_id = ?", [sessionId, studentId])) return true;

    // A student can be enrolled after a scheduled session was generated. For
    // an open session, honor the current active enrollment and extend the
    // local expected snapshot before recording attendance.
    const session = db.getFirstSync<{ id: string; centerId: string; groupId: string; sessionDate: string; status: string }>(
      "SELECT id, center_id as centerId, group_id as groupId, session_date as sessionDate, status FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (!session || (session.status !== "open" && session.status !== "scheduled")) return false;
    const enrolled = Boolean(db.getFirstSync<any>(
      `SELECT 1 FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND student_id = ?
         AND status = 'active'
       LIMIT 1`,
      [session.centerId, session.groupId, studentId],
    ));
    if (!enrolled) return false;
    const now = new Date().toISOString();
    db.runSync(
      "INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [`exp-${sessionId}-${studentId}`, session.centerId, sessionId, studentId, now],
    );
    return true;
  }

  static getSummary(sessionId: string): AttendanceSummary {
    const db = DatabaseService.getDb();
    const expected = db.getAllSync<any>("SELECT student_id as studentId FROM session_expected_students WHERE session_id = ?", [sessionId]);
    const attendance = db.getAllSync<any>("SELECT student_id as studentId, status, attendance_type as attendanceType FROM attendance WHERE session_id = ?", [sessionId]);
    const counts = calculateSessionAttendanceCounts(expected.map((row) => row.studentId), attendance);
    return { total: counts.expected, present: counts.present, absent: counts.absent };
  }
}
