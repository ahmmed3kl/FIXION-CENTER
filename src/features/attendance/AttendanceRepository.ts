import { AuditService } from "../../core/audit";
import { DatabaseService, LocalDataEvents } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    DuplicateAttendanceError,
    ForbiddenError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { Logger } from "../../core/logger";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Attendance, AttendanceType, StudentGroupAttendanceSummary } from "../../shared/types";
import {
  DEFAULT_TEACHER_WEEK_START_DAY,
  isTeacherMakeupCycleOpen,
  TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR,
  TEACHER_MAKEUP_CYCLE_EXPIRED_MESSAGE,
} from "../../shared/utils/teacherWeeks";
import { useAuthStore } from "../auth/useAuthStore";
import { AttendanceSessionService } from "./AttendanceSessionService";
import { SessionDateService } from "../sessions/SessionDateService";
import { parseLocalDateOnly, parseLocalTimeParts } from "../../shared/utils/date";
import { normalizeAcademicGrade } from "../../shared/utils/smartSearch";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface StudentAttendanceHistoryRecord extends Omit<Attendance, "status" | "checkInTime"> {
  status: Attendance["status"] | "absent" | "excused" | "attended_elsewhere";
  checkInTime?: string | null;
  sessionDate?: string | null;
  startTime?: string | null;
  isDerivedAbsence: boolean;
  absenceNote?: string | null;
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
    const attendance = this.getStudentAttendanceInSession(sessionId, studentId);
    return Boolean(attendance && !this.isSessionStartAbsenceRecord(attendance));
  }

  static isSessionStartAbsenceRecord(
    attendance: Pick<Attendance, "id" | "status" | "attendanceType" | "originalAbsenceId"> | null | undefined,
  ): boolean {
    return Boolean(
      attendance &&
      attendance.id.startsWith("att-default-") &&
      attendance.status === "absent" &&
      attendance.attendanceType !== "makeup" &&
      !attendance.originalAbsenceId,
    );
  }

  static getStudentAttendanceInSession(sessionId: string, studentId: string): Attendance | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId,
              session_id as sessionId, check_in_time as checkInTime,
              status, is_late as isLate, attendance_type as attendanceType,
              original_absence_id as originalAbsenceId,
              is_external as isExternal, operation_id as operationId
       FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (!row) return null;
    return {
      ...row,
      isLate: Boolean(row.isLate),
      isExternal: Boolean(row.isExternal),
      attendanceType: row.attendanceType || "present",
    } as Attendance;
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
    /** Scanner flows must record payment separately after an explicit payment confirmation. */
    suppressExternalPayment?: boolean;
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
    if (params.attendanceType === "makeup" && !params.originalAbsenceId?.trim()) {
      throw new ConflictError("يجب تحديد جلسة الغياب الأصلية قبل تسجيل الحضور التعويضي.");
    }

    const db = DatabaseService.getDb();

    const student = db.getFirstSync<{ status: string; deletedAt?: string | null }>(
      "SELECT status, deleted_at as deletedAt FROM students WHERE center_id = ? AND id = ?",
      [centerId, params.studentId],
    );
    if (!student || student.deletedAt || student.status === "deleted") {
      throw new ConflictError("الطالب غير موجود أو تم حذفه من هذا المركز.");
    }

    // Check session status
    const session = db.getFirstSync<any>(
      `SELECT s.id, s.status, s.group_id as groupId,
              g.session_price as sessionPrice, g.grade as groupGrade,
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
    if (session.status !== "open") {
      throw new ConflictError("ابدأ جلسة الحضور قبل تسجيل الطالب.");
    }
    if (session?.status === "closed") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة مغلقة.");
    }
    if (session?.status === "cancelled") {
      throw new ConflictError("لا يمكن تسجيل الحضور في حصة ملغاة.");
    }

    let canonicalOriginalAbsenceId = params.originalAbsenceId;
    if (params.attendanceType === "makeup" && params.originalAbsenceId) {
      // Strict makeup validation: requires a real historical absence session
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
                g.grade as groupGrade,
                s.session_date as sessionDate, s.start_time as startTime
         FROM sessions s
         JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
         WHERE s.center_id = ? AND s.id = ?`,
        [centerId, canonicalOriginalAbsenceId],
      );
      if (!source) {
        throw new ConflictError("الحصة الأصلية للتعويض غير موجودة.");
      } else if (source.status === "cancelled") {
        throw new ConflictError("الحصة الأصلية للتعويض غير موجودة.");
      } else {
        const isAfter =
          session.sessionDate > source.sessionDate ||
          (session.sessionDate === source.sessionDate &&
            (session.startTime > source.startTime || session.id !== source.id));
        const gradesMatch = !session.groupGrade || !source.groupGrade ||
          normalizeAcademicGrade(session.groupGrade) === normalizeAcademicGrade(source.groupGrade);
        if (!isAfter || session.subjectId !== source.subjectId || session.teacherId !== source.teacherId || !gradesMatch) {
          throw new ConflictError("التعويض يجب أن يكون في الحصة التالية لنفس المادة والمدرس ونفس المرحلة الدراسية.");
        }
        const teacherWeek = db.getFirstSync<{ weekStartDay?: number | null }>(
          "SELECT week_start_day as weekStartDay FROM teachers WHERE center_id = ? AND id = ?",
          [centerId, source.teacherId],
        );
        const weekStartDay = teacherWeek?.weekStartDay ?? DEFAULT_TEACHER_WEEK_START_DAY;
        if (!isTeacherMakeupCycleOpen(
          source.sessionDate,
          session.sessionDate,
          weekStartDay,
          AttendanceSessionService.getCurrentSessionDate(),
        )) {
          throw new ConflictError(
            TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR,
            TEACHER_MAKEUP_CYCLE_EXPIRED_MESSAGE,
          );
        }

        const sourceExpected = db.getFirstSync<any>(
          `SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? AND student_id = ?`,
          [centerId, source.id, params.studentId],
        );
        const legacyEnrollment = db.getFirstSync<any>(
          `SELECT 1 FROM student_group_enrollments
           WHERE center_id = ? AND group_id = ? AND student_id = ?
             AND status IN ('active', 'ended')
             AND (start_date <= ? OR SUBSTR(created_at, 1, 10) <= ?) AND (end_date IS NULL OR end_date >= ?)
           LIMIT 1`,
          [centerId, source.groupId, params.studentId, source.sessionDate, source.sessionDate, source.sessionDate],
        );
        if (!sourceExpected && !legacyEnrollment) {
          throw new ConflictError("الطالب غير متوقع في الحصة الأصلية.");
        }
        const sourceAttendance = db.getAllSync<{
          status: string;
          attendanceType?: string | null;
        }>(
          `SELECT status, attendance_type as attendanceType FROM attendance
           WHERE center_id = ? AND session_id = ? AND student_id = ?`,
          [centerId, source.id, params.studentId],
        );
        if (sourceAttendance.some((row) => row.status === "present" || row.status === "late")) {
          throw new ConflictError("لا يمكن تعويض حصة حضرها الطالب بالفعل.");
        }
        if (!sourceAttendance.some(
          (row) => row.status === "absent" && row.attendanceType !== "makeup",
        )) {
          throw new ConflictError("لا توجد حالة غياب صريحة للطالب في الحصة الأصلية.");
        }
        const existingMakeup = db.getAllSync<{ originalAbsenceId?: string | null }>(
          `SELECT original_absence_id as originalAbsenceId FROM attendance
           WHERE center_id = ? AND student_id = ?`,
          [centerId, params.studentId],
        ).some((row) =>
          row.originalAbsenceId === canonicalOriginalAbsenceId ||
          row.originalAbsenceId === params.originalAbsenceId,
        );
        if (existingMakeup) {
          throw new ConflictError("تم تسجيل تعويض لهذا الغياب مسبقًا.");
        }
        const betweenSessions = db.getAllSync<any>(
          `SELECT s.id
           FROM sessions s
           JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
           WHERE s.center_id = ?
             AND COALESCE(s.subject_id, g.subject_id) = ?
             AND COALESCE(s.teacher_id, g.teacher_id) = ?
             AND s.status <> 'cancelled'
             AND (s.session_date > ? OR (s.session_date = ? AND s.start_time > ?))
             AND (s.session_date < ? OR (s.session_date = ? AND s.start_time < ?))
           ORDER BY s.session_date ASC, s.start_time ASC`,
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
        if (betweenSessions.some((candidate) =>
          AttendanceSessionService.isExpected(candidate.id, params.studentId, true),
        )) {
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

    const existingAttendance = this.getStudentAttendanceInSession(
      params.sessionId,
      params.studentId,
    );
    if (
      existingAttendance &&
      !this.isSessionStartAbsenceRecord(existingAttendance)
    ) {
      throw new DuplicateAttendanceError();
    }

    const attendanceId = existingAttendance?.id || `att-${generateUUID()}`;
    const operationId = `op-att-${generateUUID()}`;
    const deviceId = await DeviceService.getDeviceId();

    const now = new Date();
    const externalBusinessDate = params.isExternal
      ? SessionDateService.getCurrentSessionDate(centerId, now)
      : undefined;
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

    // 1. Save to SQLite immediately, promoting only a marked session-start
    // absence in place so the unique session/student row remains idempotent.
    if (existingAttendance) {
      const updated = db.runSync(
        `UPDATE attendance
            SET check_in_time = ?, status = ?, is_late = ?,
                attendance_type = ?, original_absence_id = ?,
                is_external = ?, operation_id = ?
          WHERE center_id = ? AND id = ? AND session_id = ? AND student_id = ?
            AND status = 'absent' AND attendance_type = 'present'
            AND original_absence_id IS NULL AND operation_id = ?`,
        [
          checkInTime,
          params.status,
          isLateInt,
          attendanceType,
          canonicalOriginalAbsenceId || null,
          isExternalInt,
          operationId,
          centerId,
          attendanceId,
          params.sessionId,
          params.studentId,
          existingAttendance.operationId,
        ],
      );
      if (Number(updated.changes) !== 1) {
        throw new DuplicateAttendanceError();
      }
    } else {
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
          throw new DuplicateAttendanceError();
        }
        throw err;
      }
    }

    // 2. If external makeup/attendance, record cash session payment (NO monthly debt)
    if (params.isExternal && !params.suppressExternalPayment) {
      const sessionPrice = Number(session.sessionPrice ?? 0);
      if (!Number.isFinite(sessionPrice) || sessionPrice <= 0) {
        throw new ValidationError(
          "سعر الحصة غير محدد للمجموعة. حدّد سعرًا موجبًا في تفاصيل المجموعة قبل تسجيل الحضور الخارجي.",
        );
      }
      if (sessionPrice > 0) {
        const payId = `pay-${generateUUID()}`;
        const payOpId = `op-pay-ext-${generateUUID()}`;
        const payDate = externalBusinessDate;
        if (!payDate) {
          throw new Error("External attendance payment date was not resolved.");
        }

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
            actorName: user.fullName,
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
      operationType: existingAttendance ? "UPDATE" : "attendance.create",
      entityType: "attendance",
      entityId: attendanceId,
      // PostgreSQL does not accept `late` as a status; lateness is carried by
      // isLate. Keep the local record as `late` for reports, but send the
      // canonical server status so new and retried operations cannot hit the
      // attendance_status_check constraint.
      payload: {
        ...attendanceRecord,
        status: attendanceRecord.isLate ? "present" : attendanceRecord.status,
        ...(existingAttendance
          ? {
              action: "attendance.promote_default_absence",
              expectedOperationId: existingAttendance.operationId,
            }
          : {}),
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
        studentId: params.studentId,
        isLate: params.isLate,
        attendanceType,
        isExternal: Boolean(params.isExternal),
        replacedSessionStartAbsence: Boolean(existingAttendance),
        actorName: user.fullName,
      },
    });
    DatabaseService.notifyLocalChange({ centerId, entityType: "attendance", entityId: attendanceId });
    });

    // Sync only after the transaction commits. Starting a sync from inside
    // the transaction can race the SQLite commit and leave the operation
    // invisible until a later retry.
    SyncEngine.syncCenterNow(centerId).catch((e) => {
      console.warn("Background auto-sync attendance notice:", e);
    });

    // Notify dashboard and other screens that attendance data has changed
    LocalDataEvents.emit({ centerId, entityType: "attendance", entityId: attendanceId });

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
  static getStudentAttendance(studentId: string): StudentAttendanceHistoryRecord[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    const attendanceRows = db.getAllSync<any>(
      `SELECT a.id, a.center_id as centerId, a.student_id as studentId, a.session_id as sessionId,
              a.check_in_time as checkInTime, a.status, a.is_late = 1 as isLate,
              a.attendance_type as attendanceType, a.original_absence_id as originalAbsenceId,
              a.is_external = 1 as isExternal,
              a.operation_id as operationId,
              ss.group_id as groupId, g.name as groupName, ss.session_date as sessionDate,
              ss.start_time as startTime, subj.name as subjectName, t.name as teacherName,
              absence_note.note_text as absenceNote,
              0 as isDerivedAbsence
       FROM attendance a
       LEFT JOIN sessions ss ON ss.center_id = a.center_id AND ss.id = a.session_id
       LEFT JOIN absence_notes absence_note
         ON absence_note.center_id = a.center_id
        AND absence_note.session_id = a.session_id
        AND absence_note.student_id = a.student_id
       LEFT JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = ss.center_id
         AND subj.id = COALESCE(ss.subject_id, g.subject_id)
       LEFT JOIN teachers t ON t.center_id = ss.center_id
         AND t.id = COALESCE(ss.teacher_id, g.teacher_id)
       WHERE a.center_id = ? AND a.student_id = ?
       ORDER BY ss.session_date DESC, ss.start_time DESC, a.check_in_time DESC`,
      [centerId, studentId],
    );
    const noteOnlyAbsenceRows = db.getAllSync<any>(
      `SELECT 'derived-absence-' || note.id as id,
              note.center_id as centerId, note.student_id as studentId,
              note.session_id as sessionId, NULL as checkInTime,
              'absent' as status, 0 as isLate, 'present' as attendanceType,
              NULL as originalAbsenceId, 0 as isExternal,
              'derived-absence-' || note.id as operationId,
              ss.group_id as groupId, g.name as groupName,
              ss.session_date as sessionDate, ss.start_time as startTime,
              subj.name as subjectName, t.name as teacherName,
              note.note_text as absenceNote, 1 as isDerivedAbsence
       FROM absence_notes note
       LEFT JOIN sessions ss ON ss.center_id = note.center_id AND ss.id = note.session_id
       LEFT JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = ss.center_id
         AND subj.id = COALESCE(ss.subject_id, g.subject_id)
       LEFT JOIN teachers t ON t.center_id = ss.center_id
         AND t.id = COALESCE(ss.teacher_id, g.teacher_id)
       WHERE note.center_id = ? AND note.student_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM attendance existing
           WHERE existing.center_id = note.center_id
             AND existing.session_id = note.session_id
             AND existing.student_id = note.student_id
         )`,
      [centerId, studentId],
    );
    const records: StudentAttendanceHistoryRecord[] = [
      ...attendanceRows,
      ...noteOnlyAbsenceRows,
    ].map((row) => {
      const sessionDate = typeof row.sessionDate === "string" && row.sessionDate.trim()
        ? row.sessionDate.trim()
        : null;
      const checkInTime = typeof row.checkInTime === "string" && row.checkInTime.trim()
        ? row.checkInTime.trim()
        : null;
      const startTime = typeof row.startTime === "string" && row.startTime.trim()
        ? row.startTime.trim()
        : null;

      if (!parseLocalDateOnly(sessionDate)) {
        Logger.warn("attendance", "student_history_session_date_unavailable", {
          centerId,
          entityType: "attendance",
          metadata: {
            attendanceId: String(row.id),
            sessionId: String(row.sessionId),
            source: "sessions.session_date",
            reason: sessionDate ? "invalid" : "missing",
          },
        });
      }
      if (
        (row.status === "present" || row.status === "late") &&
        !parseLocalTimeParts(checkInTime)
      ) {
        Logger.warn("attendance", "student_history_check_in_time_unavailable", {
          centerId,
          entityType: "attendance",
          metadata: {
            attendanceId: String(row.id),
            sessionId: String(row.sessionId),
            source: "attendance.check_in_time",
            reason: checkInTime ? "invalid" : "missing",
          },
        });
      }

      return {
        ...row,
        checkInTime,
        sessionDate,
        startTime,
        isLate: Boolean(row.isLate),
        isExternal: Boolean(row.isExternal),
        attendanceType: row.attendanceType || "present",
        isDerivedAbsence: Boolean(row.isDerivedAbsence),
      };
    });
    return records.sort((a, b) =>
      `${b.sessionDate} ${b.startTime} ${b.checkInTime}`.localeCompare(
        `${a.sessionDate} ${a.startTime} ${a.checkInTime}`,
      ),
    );
  }

  static async cancelAttendance(attendanceId: string): Promise<StudentAttendanceHistoryRecord> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "attendance.edit")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل سجلات الحضور.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>(
      `SELECT a.id, a.center_id as centerId, a.student_id as studentId,
              a.session_id as sessionId, a.check_in_time as checkInTime,
              a.status, a.is_late as isLate, a.attendance_type as attendanceType,
              a.original_absence_id as originalAbsenceId,
              a.is_external as isExternal, a.operation_id as operationId,
              ss.group_id as groupId, g.name as groupName,
              ss.session_date as sessionDate, ss.start_time as startTime,
              subj.name as subjectName, t.name as teacherName
       FROM attendance a
       JOIN sessions ss ON ss.center_id = a.center_id AND ss.id = a.session_id
       JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = ss.center_id
         AND subj.id = COALESCE(ss.subject_id, g.subject_id)
       LEFT JOIN teachers t ON t.center_id = ss.center_id
         AND t.id = COALESCE(ss.teacher_id, g.teacher_id)
       JOIN students st ON st.center_id = a.center_id AND st.id = a.student_id
       WHERE a.center_id = ? AND a.id = ?`,
      [centerId, attendanceId],
    );
    if (!existing) {
      throw new ConflictError("سجل الحضور غير موجود في المركز الحالي.");
    }
    if (existing.status === "absent") {
      return { ...existing, isLate: Boolean(existing.isLate), isExternal: Boolean(existing.isExternal), isDerivedAbsence: false };
    }

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-att-cancel-${generateUUID()}`;
    const canceledAt = new Date().toISOString();
    let canceled = false;
    let result: StudentAttendanceHistoryRecord = {
      ...existing,
      status: "absent",
      isLate: false,
      isExternal: Boolean(existing.isExternal),
      isDerivedAbsence: false,
    };

    DatabaseService.runInTransaction(() => {
      const current = db.getFirstSync<any>(
        `SELECT status FROM attendance WHERE center_id = ? AND id = ?`,
        [centerId, attendanceId],
      );
      if (!current || current.status === "absent") return;

      const updateResult = db.runSync(
        `UPDATE attendance SET status = 'absent', is_late = 0
         WHERE center_id = ? AND id = ? AND session_id = ? AND student_id = ?`,
        [centerId, attendanceId, existing.sessionId, existing.studentId],
      );
      if (updateResult.changes !== 1) return;
      canceled = true;

      const previousEffectiveStatus = existing.isLate ? "late" : existing.status;

      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        operationType: "UPDATE",
        entityType: "attendance",
        entityId: attendanceId,
        payload: {
          id: attendanceId,
          centerId,
          studentId: existing.studentId,
          sessionId: existing.sessionId,
          status: "absent",
          isLate: false,
          attendanceType: existing.attendanceType || "present",
          originalAbsenceId: existing.originalAbsenceId || null,
          expectedOperationId: existing.operationId || null,
          action: "attendance.cancel",
          canceledAt,
          previousStatus: previousEffectiveStatus,
          actorName: user.fullName,
        },
      });
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "attendance",
        entityId: attendanceId,
        action: "attendance.cancel",
        payload: {
          studentId: existing.studentId,
          sessionId: existing.sessionId,
          attendanceType: existing.attendanceType || "present",
          previousStatus: previousEffectiveStatus,
          status: "absent",
          actorName: user.fullName,
          canceledAt,
        },
      });
      result = { ...result, status: "absent", isLate: false };
    });

    if (!canceled) {
      const current = db.getFirstSync<any>(
        `SELECT status, is_late as isLate FROM attendance WHERE center_id = ? AND id = ?`,
        [centerId, attendanceId],
      );
      if (current?.status !== "absent") {
        throw new ConflictError("تعذر تحديث سجل الحضور. لم يتم إنشاء عملية مزامنة.");
      }
      return { ...existing, status: "absent", isLate: Boolean(current.isLate), isDerivedAbsence: false };
    }

    SyncEngine.syncCenterNow(centerId).catch((error) => {
      console.warn("Background auto-sync attendance cancellation notice:", error);
    });
    LocalDataEvents.emit({ centerId, entityType: "attendance", entityId: attendanceId });
    return result;
  }

  /**
   * Returns attendance outcomes and not-yet-started expected sessions per
   * group. Makeup attendance stays with the group where it was recorded.
   */
  static getStudentGroupAttendanceSummaries(
    studentId: string,
  ): StudentGroupAttendanceSummary[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }
    const db = DatabaseService.getDb();
    const today = AttendanceSessionService.getCurrentSessionDate();
    const expectedRows = db.getAllSync<any>(
      `SELECT DISTINCT ss.id as sessionId, ss.group_id as groupId,
              ss.status as sessionStatus,
              g.name as groupName, subj.name as subjectName, t.name as teacherName
       FROM sessions ss
       LEFT JOIN session_expected_students ses
         ON ses.center_id = ss.center_id AND ses.session_id = ss.id AND ses.student_id = ?
       LEFT JOIN student_group_enrollments enr
         ON enr.center_id = ss.center_id AND enr.group_id = ss.group_id
        AND enr.student_id = ? AND enr.status = 'active'
        AND enr.start_date <= ss.session_date
        AND (enr.end_date IS NULL OR enr.end_date >= ss.session_date)
       LEFT JOIN attendance actual
         ON actual.center_id = ss.center_id AND actual.session_id = ss.id
        AND actual.student_id = ?
       JOIN groups g ON g.center_id = ss.center_id AND g.id = ss.group_id
       LEFT JOIN subjects subj ON subj.center_id = g.center_id AND subj.id = g.subject_id
       LEFT JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       WHERE ss.center_id = ?
         AND ss.status <> 'cancelled' AND ss.session_date <= ?
         AND (ses.student_id IS NOT NULL OR enr.id IS NOT NULL OR actual.id IS NOT NULL)`,
      [studentId, studentId, studentId, centerId, today],
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
    const statusRank = (status: string) =>
      status === "present" || status === "late" ? 2 : status === "absent" ? 1 : 0;
    for (const row of attendanceRows) {
      const current = attendanceBySession.get(row.sessionId);
      if (!current || statusRank(row.status) > statusRank(current.status)) {
        attendanceBySession.set(row.sessionId, row);
      }
    }
    const summaries = new Map<string, StudentGroupAttendanceSummary>();
    const ensure = (row: any) => {
      if (!row.groupId) return null;
      let summary = summaries.get(row.groupId);
      if (!summary) {
        summary = {
          groupId: row.groupId,
          groupName: row.groupName || "مجموعة",
          subjectName: row.subjectName || undefined,
          teacherName: row.teacherName || undefined,
          expectedSessions: 0,
          presentCount: 0,
          absentCount: 0,
          notStartedCount: 0,
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
      if (!covered) {
        if (row.sessionStatus === "open" || row.sessionStatus === "closed") {
          summary.absentCount += 1;
        } else {
          summary.notStartedCount += 1;
        }
      }
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
