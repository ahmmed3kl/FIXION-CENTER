import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    UnauthorizedError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Attendance, AttendanceType, StudentGroupAttendanceSummary } from "../../shared/types";
import { getLocalDateOnly } from "../../shared/utils/date";
import { useAuthStore } from "../auth/useAuthStore";
import { AttendanceSessionService } from "./AttendanceSessionService";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class AttendanceRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز لتسجيل الحضور.",
      );
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Checks if attendance has already been recorded for this student in this session.
   * Strictly scopes query to the active authenticated center.
   */
  static isAlreadyAttended(sessionId: string, studentId: string): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>(
      "SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?",
      [centerId, sessionId, studentId],
    );
    return !!existing;
  }

  /**
   * Records student attendance offline in SQLite, enqueues sync operation, and records audit log.
   * Strictly verifies repository-level permission: attendance.create.
   */
  static async recordAttendance(params: {
    studentId: string;
    sessionId: string;
    status: "present" | "late";
    isLate: boolean;
    attendanceType?: AttendanceType;
    originalAbsenceId?: string;
    isExternal?: boolean;
    checkInTime?: string;
  }): Promise<Attendance> {
    const { centerId, user } = this.getActiveContext();

    if (
      !PermissionService.hasPermission(user.permissions, "attendance.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل الحضور.");
    }

    if (
      params.isExternal &&
      !PermissionService.hasPermission(user.permissions, "attendance.external")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل حضور طالب خارجي.");
    }

    if (
      params.attendanceType === "makeup" &&
      !PermissionService.hasPermission(user.permissions, "attendance.makeup")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل حضور تعويضي.");
    }

    const db = DatabaseService.getDb();

    // Check session status
    const session = db.getFirstSync<any>(
      `SELECT s.id, s.status, s.group_id as groupId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_date as sessionDate, s.start_time as startTime
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       WHERE s.center_id = ? AND s.id = ?`,
      [centerId, params.sessionId],
    );
    if (!session) {
      throw new ConflictError("الحصة غير موجودة في المركز الحالي.");
    }
    if (session?.status === "closed") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة مغلقة.");
    }
    if (session?.status === "cancelled") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة ملغاة.");
    }

    let canonicalOriginalAbsenceId = params.originalAbsenceId;
    if (params.attendanceType === "makeup") {
      if (!params.originalAbsenceId) {
        throw new ConflictError("يجب تحديد الحصة الأصلية للتعويض.");
      }
      const legacyPrefix = "absence-";
      const legacySuffix = `-${params.studentId}`;
      if (
        params.originalAbsenceId.startsWith(legacyPrefix) &&
        params.originalAbsenceId.endsWith(legacySuffix)
      ) {
        canonicalOriginalAbsenceId = params.originalAbsenceId.slice(
          legacyPrefix.length,
          -legacySuffix.length,
        );
      }

      const source = db.getFirstSync<any>(
        `SELECT s.id, s.status, s.group_id as groupId,
                COALESCE(s.subject_id, g.subject_id) as subjectId,
                COALESCE(s.teacher_id, g.teacher_id) as teacherId,
                s.session_date as sessionDate, s.start_time as startTime
         FROM sessions s
         JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
         WHERE s.center_id = ? AND s.id = ?`,
        [centerId, canonicalOriginalAbsenceId],
      );
      if (!source) {
        // Keep accepting opaque legacy IDs created by older clients. New
        // scanner flows always use MakeupService and pass a real source
        // session, so they receive the strict validation below.
        canonicalOriginalAbsenceId = params.originalAbsenceId;
      } else if (source.status === "cancelled") {
        throw new ConflictError("الحصة الأصلية للتعويض غير موجودة.");
      } else {
      const isAfter =
        session.sessionDate > source.sessionDate ||
        (session.sessionDate === source.sessionDate &&
          session.startTime > source.startTime);
      if (!isAfter || session.subjectId !== source.subjectId || session.teacherId !== source.teacherId) {
        throw new ConflictError("التعويض يجب أن يكون في الحصة التالية لنفس المادة والمدرس.");
      }

      const sourceExpected = db.getFirstSync<any>(
        `SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, source.id, params.studentId],
      );
      const sourceHasSnapshot = db.getFirstSync<any>(
        `SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1`,
        [centerId, source.id],
      );
      const legacyEnrollment = db.getFirstSync<any>(
        `SELECT 1 FROM student_group_enrollments
         WHERE center_id = ? AND group_id = ? AND student_id = ? AND status = 'active'
           AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
         LIMIT 1`,
        [centerId, source.groupId, params.studentId, source.sessionDate, source.sessionDate],
      );
      if (!sourceExpected && (sourceHasSnapshot || !legacyEnrollment)) {
        throw new ConflictError("الطالب غير متوقع في الحصة الأصلية.");
      }
      if (db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, source.id, params.studentId],
      )) {
        throw new ConflictError("لا يمكن تعويض حصة حضرها الطالب بالفعل.");
      }
      if (db.getFirstSync<any>(
        `SELECT id FROM attendance
         WHERE center_id = ? AND student_id = ?
           AND (original_absence_id = ? OR original_absence_id = ?)`,
        [centerId, params.studentId, canonicalOriginalAbsenceId, params.originalAbsenceId],
      )) {
        throw new ConflictError("تم تسجيل تعويض لهذا الغياب مسبقًا.");
      }
      const earlierSession = db.getFirstSync<any>(
        `SELECT s.id
         FROM sessions s
         JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
         WHERE s.center_id = ?
           AND COALESCE(s.subject_id, g.subject_id) = ?
           AND COALESCE(s.teacher_id, g.teacher_id) = ?
           AND s.status <> 'cancelled'
           AND (s.session_date > ? OR (s.session_date = ? AND s.start_time > ?))
           AND (s.session_date < ? OR (s.session_date = ? AND s.start_time < ?))
         ORDER BY s.session_date ASC, s.start_time ASC LIMIT 1`,
        [
          centerId,
          source.subjectId,
          source.teacherId,
          source.sessionDate,
          source.sessionDate,
          source.startTime,
          session.sessionDate,
          session.sessionDate,
          session.startTime,
        ],
      );
      if (earlierSession) {
        throw new ConflictError("لا يمكن تعويض غير الحصة التالية المؤهلة.");
      }
      }
    }

    // Do not rely only on the scanner UI for eligibility. Attendance can also
    // be recorded by imports, retries, or future screens, so enforce the same
    // expected-student/package/teacher/group rule at the repository boundary.
    // Makeup and explicitly external attendance use their own eligibility
    // rules and are intentionally exempt here.
    if (
      !params.isExternal &&
      params.attendanceType !== "makeup" &&
      !AttendanceSessionService.isExpected(params.sessionId, params.studentId)
    ) {
      throw new ConflictError("الطالب غير متوقع في المجموعة/الحصة الحالية.");
    }

    // Check duplicate
    if (this.isAlreadyAttended(params.sessionId, params.studentId)) {
      throw new ConflictError("تم تسجيل حضور الطالب مسبقًا لهذه الحصة.");
    }

    const attendanceId = `att-${generateUUID()}`;
    const operationId = `op-att-${generateUUID()}`;
    const deviceId = await DeviceService.getDeviceId();

    const now = new Date();
    // Keep a full ISO timestamp in SQLite and the outbox. PostgreSQL stores
    // this field as timestamptz; the old HH:mm:ss-only value could never be
    // uploaded and was parked as a permanent conflict.
    const checkInTime = params.checkInTime || now.toISOString();

    const attendanceType = params.attendanceType || "present";
    const isLateInt = params.isLate ? 1 : 0;
    const isExternalInt = params.isExternal ? 1 : 0;

    // Attendance and any external-session payment are one local mutation.
    // The audit and outbox records are committed with them so a crash cannot
    // leave attendance visible without a retryable sync operation.
    let attendanceRecord!: Attendance;
    DatabaseService.runInTransaction(() => {

    // 1. Save to SQLite immediately (with UNIQUE constraint safety)
    try {
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attendanceId,
          centerId,
          params.studentId,
          params.sessionId,
          checkInTime,
          params.status,
          isLateInt,
          attendanceType,
          canonicalOriginalAbsenceId || null,
          isExternalInt,
          operationId,
        ],
      );
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        throw new ConflictError("تم تسجيل حضور الطالب مسبقًا لهذه الحصة.");
      }
      throw err;
    }

    // 2. If external makeup/attendance, record cash session payment (NO monthly debt)
    if (params.isExternal) {
      const session = db.getFirstSync<any>(
        `SELECT session_price as sessionPrice FROM sessions WHERE center_id = ? AND id = ?`,
        [centerId, params.sessionId],
      );
      const sessionPrice = Number(session?.sessionPrice ?? 0);
      if (sessionPrice > 0) {
        const payId = `pay-${generateUUID()}`;
        const payOpId = `op-pay-ext-${generateUUID()}`;
        const payDate = now.toISOString().slice(0, 10);

        db.runSync(
          `INSERT INTO payments (id, operation_id, center_id, student_id, session_id, amount, payment_type, payment_method, payment_date, is_reversed, notes, created_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, 'session', 'cash', ?, 0, 'حضور خارجي', ?, ?)`,
          [
            payId,
            payOpId,
            centerId,
            params.studentId,
            params.sessionId,
            sessionPrice,
            payDate,
            now.toISOString(),
            user.id,
          ],
        );

        SyncRepository.enqueueOperation({
          operationId: payOpId,
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment.create",
          entityType: "payment",
          entityId: payId,
          payload: {
            id: payId,
            operationId: payOpId,
            centerId,
            studentId: params.studentId,
            sessionId: params.sessionId,
            amount: sessionPrice,
            paymentType: "session",
            paymentMethod: "cash",
            paymentDate: payDate,
            notes: "حضور خارجي",
            isReversed: false,
            createdAt: now.toISOString(),
            userId: user.id,
          },
        });

        AuditService.recordEvent({
          operationId: payOpId,
          centerId,
          userId: user.id,
          deviceId,
          entityType: "payment",
          entityId: payId,
          action: "payment.create_external_session",
          payload: {
            sessionId: params.sessionId,
            amount: sessionPrice,
          },
        });
      }
    }

    attendanceRecord = {
      id: attendanceId,
      centerId,
      studentId: params.studentId,
      sessionId: params.sessionId,
      checkInTime,
      status: params.status,
      isLate: params.isLate,
      attendanceType,
      originalAbsenceId: canonicalOriginalAbsenceId,
      isExternal: Boolean(params.isExternal),
      operationId,
    };

    // 3. Create sync operation in sync queue
    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "attendance.create",
      entityType: "attendance",
      entityId: attendanceId,
      // PostgreSQL does not accept `late` as a status; lateness is carried by
      // isLate. Keep the local record as `late` for reports, but send the
      // canonical server status so new and retried operations cannot hit the
      // attendance_status_check constraint.
      payload: {
        ...attendanceRecord,
        status: attendanceRecord.isLate ? "present" : attendanceRecord.status,
      },
      operationId,
    });

    // 4. Create audit log
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "attendance",
      entityId: attendanceId,
      action: "attendance.record",
      payload: {
        status: params.status,
        isLate: params.isLate,
        attendanceType,
        isExternal: Boolean(params.isExternal),
      },
    });
    });

    // Sync only after the transaction commits. Starting a sync from inside
    // the transaction can race the SQLite commit and leave the operation
    // invisible until a later retry.
    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync attendance notice:", e);
    });

    return attendanceRecord;
  }

  /**
   * Retrieves attendance history for a session in the active center.
   */
  static getSessionAttendance(sessionId: string): Attendance[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              check_in_time as checkInTime, status, is_late = 1 as isLate,
              attendance_type as attendanceType, original_absence_id as originalAbsenceId,
              is_external = 1 as isExternal,
              operation_id as operationId
       FROM attendance
       WHERE center_id = ? AND session_id = ?
       ORDER BY check_in_time DESC`,
      [centerId, sessionId],
    );
  }

  /**
   * Retrieves attendance history for a student across all sessions in the active center.
   */
  static getStudentAttendance(studentId: string): Attendance[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<any>(
      `SELECT a.id, a.center_id as centerId, a.student_id as studentId, a.session_id as sessionId,
              a.check_in_time as checkInTime, a.status, a.is_late = 1 as isLate,
              a.attendance_type as attendanceType, a.original_absence_id as originalAbsenceId,
              a.is_external = 1 as isExternal,
              a.operation_id as operationId,
              ss.group_id as groupId, g.name as groupName,
              subj.name as subjectName, t.name as teacherName
       FROM attendance a
       JOIN sessions ss ON ss.center_id = a.center_id AND ss.id = a.session_id
       LEFT JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = g.center_id AND subj.id = g.subject_id
       LEFT JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       WHERE a.center_id = ? AND a.student_id = ?
       ORDER BY a.check_in_time DESC`,
      [centerId, studentId],
    );
  }

  /**
   * Returns attendance and derived absence totals per group. Absence is
   * calculated from the expected-student snapshot, so a student who never
   * checked in is counted even though there is no attendance row for them.
   * Makeup attendance is kept on the group where it was actually recorded.
   */
  static getStudentGroupAttendanceSummaries(
    studentId: string,
  ): StudentGroupAttendanceSummary[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("Ù„ÙŠØ³ Ù„Ø¯ÙŠÙƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¹Ø±Ø¶ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø­Ø¶ÙˆØ±.");
    }
    const db = DatabaseService.getDb();
    const today = getLocalDateOnly();
    const expectedRows = db.getAllSync<any>(
      `SELECT ses.session_id as sessionId, ss.group_id as groupId,
              g.name as groupName, subj.name as subjectName, t.name as teacherName
       FROM session_expected_students ses
       JOIN sessions ss ON ss.center_id = ses.center_id AND ss.id = ses.session_id
       LEFT JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = g.center_id AND subj.id = g.subject_id
       LEFT JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       WHERE ses.center_id = ? AND ses.student_id = ?
         AND ss.status <> 'cancelled' AND ss.session_date <= ?`,
      [centerId, studentId, today],
    );
    const attendanceRows = db.getAllSync<any>(
      `SELECT a.id, a.session_id as sessionId, a.status,
              a.attendance_type as attendanceType,
              ss.group_id as groupId, g.name as groupName,
              subj.name as subjectName, t.name as teacherName
       FROM attendance a
       JOIN sessions ss ON ss.center_id = a.center_id AND ss.id = a.session_id
       LEFT JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = g.center_id AND subj.id = g.subject_id
       LEFT JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       WHERE a.center_id = ? AND a.student_id = ?
         AND ss.status <> 'cancelled' AND ss.session_date <= ?`,
      [centerId, studentId, today],
    );
    const attendanceBySession = new Map<string, any>();
    for (const row of attendanceRows) attendanceBySession.set(row.sessionId, row);
    const summaries = new Map<string, StudentGroupAttendanceSummary>();
    const ensure = (row: any) => {
      if (!row.groupId) return null;
      let summary = summaries.get(row.groupId);
      if (!summary) {
        summary = {
          groupId: row.groupId,
          groupName: row.groupName || "Ù…Ø¬Ù…ÙˆØ¹Ø©",
          subjectName: row.subjectName || undefined,
          teacherName: row.teacherName || undefined,
          expectedSessions: 0,
          presentCount: 0,
          absentCount: 0,
          makeupCount: 0,
        };
        summaries.set(row.groupId, summary);
      }
      return summary;
    };
    const countedAttendance = new Set<string>();

    for (const row of expectedRows) {
      const summary = ensure(row);
      if (!summary) continue;
      summary.expectedSessions += 1;
      const attendance = attendanceBySession.get(row.sessionId);
      if (attendance) {
        countedAttendance.add(attendance.id);
        if (attendance.status === "absent") summary.absentCount += 1;
        else {
          summary.presentCount += 1;
          if (attendance.attendanceType === "makeup") summary.makeupCount += 1;
        }
        continue;
      }
      const covered = db.getFirstSync<any>(
        `SELECT id FROM advance_coverages
         WHERE center_id = ? AND student_id = ? AND target_future_session_id = ? LIMIT 1`,
        [centerId, studentId, row.sessionId],
      );
      if (!covered) summary.absentCount += 1;
    }

    // A makeup session is normally not in the student's expected snapshot.
    // Add it to the destination group so the profile shows where the makeup
    // was actually attended instead of losing that information.
    for (const attendance of attendanceRows) {
      if (countedAttendance.has(attendance.id)) continue;
      const summary = ensure(attendance);
      if (!summary) continue;
      if (attendance.status === "absent") summary.absentCount += 1;
      else {
        summary.presentCount += 1;
        if (attendance.attendanceType === "makeup") summary.makeupCount += 1;
      }
    }

    return [...summaries.values()].sort((a, b) => a.groupName.localeCompare(b.groupName));
  }
}
