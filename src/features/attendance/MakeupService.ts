import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import {
    AdvanceCoverage,
    Attendance,
    MakeupOpportunity,
    Session,
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SessionRepository } from "../sessions/SessionRepository";
import { StudentRepository } from "../students/StudentRepository";
import { AttendanceRepository } from "./AttendanceRepository";
import { AttendanceSessionService } from "./AttendanceSessionService";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface MakeupEligibility {
  eligible: boolean;
  sourceGroupId?: string;
  sourceGroupName?: string;
  teacherName?: string;
  originalAbsenceId?: string;
}

export class MakeupService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Checks if a session is covered in advance for a student.
   */
  static isSessionCoveredInAdvance(
    studentId: string,
    sessionId: string,
  ): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id FROM advance_coverages
       WHERE center_id = ? AND student_id = ? AND target_future_session_id = ?`,
      [centerId, studentId, sessionId],
    );
    return !!row;
  }

  /**
   * Records advance attendance coverage.
   *
   * STRICT ADVANCE COVERAGE VALIDATION:
   * 1. advanceSession belongs to active center.
   * 2. targetFutureSession belongs to active center.
   * 3. advanceSession and targetFutureSession must share same subject and same effective teacher.
   * 4. targetFutureSession must be strictly in the future relative to advanceSession.
   * 5. Strictly 1-to-1:
   *    - one targetFutureSession cannot be covered multiple times.
   *    - one advanceSession cannot cover multiple future sessions.
   * 6. Student is academically eligible for the target future session.
   */
  static async recordAdvanceCoverage(
    studentId: string,
    advanceSessionId: string,
    targetFutureSessionId: string,
  ): Promise<AdvanceCoverage> {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "attendance.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل التغطية المسبقة.");
    }

    const student = StudentRepository.findById(studentId);
    if (!student) {
      throw new NotFoundError("الطالب غير موجود.");
    }

    const advanceSession = SessionRepository.findById(advanceSessionId);
    if (!advanceSession || advanceSession.centerId !== centerId) {
      throw new NotFoundError("حصة الحضور المسبق غير موجودة في هذا المركز.");
    }

    const targetFutureSession = SessionRepository.findById(
      targetFutureSessionId,
    );
    if (!targetFutureSession || targetFutureSession.centerId !== centerId) {
      throw new NotFoundError(
        "الحصة المستقبلية المراد تغطيتها غير موجودة في هذا المركز.",
      );
    }

    if (advanceSession.status === "closed") {
      throw new ConflictError("لا يمكن تسجيل حضور مسبق لحصة مغلقة.");
    }
    if (advanceSession.status === "cancelled") {
      throw new ConflictError("لا يمكن تسجيل حضور مسبق لحصة ملغاة.");
    }
    if (targetFutureSession.status === "cancelled") {
      throw new ConflictError("لا يمكن تغطية حصة ملغاة.");
    }
    if (targetFutureSession.status === "closed") {
      throw new ConflictError("لا يمكن تغطية حصة مقفلة.");
    }

    // Validation: Same subject and effective teacher
    if (
      advanceSession.subjectId !== targetFutureSession.subjectId ||
      advanceSession.teacherId !== targetFutureSession.teacherId
    ) {
      throw new ValidationError(
        "حصة الحضور المسبق والحصة المستقبلية يجب أن تكونا لنفس المادة ونفس المعلم.",
      );
    }

    // Validation: targetFutureSession strictly in the future relative to advanceSession
    const isStrictlyFuture =
      targetFutureSession.sessionDate > advanceSession.sessionDate ||
      (targetFutureSession.sessionDate === advanceSession.sessionDate &&
        targetFutureSession.startTime > advanceSession.startTime);

    if (!isStrictlyFuture) {
      throw new ValidationError(
        "الحصة المراد تغطيتها يجب أن تكون في موعد لاحق لحصة الحضور المسبق.",
      );
    }

    const db = DatabaseService.getDb();

    // Validation: 1-to-1 coverage - target cannot be double covered
    const existingTarget = db.getFirstSync<any>(
      `SELECT id FROM advance_coverages
       WHERE center_id = ? AND student_id = ? AND target_future_session_id = ?`,
      [centerId, studentId, targetFutureSessionId],
    );
    if (existingTarget) {
      throw new ConflictError("هذه الحصة المستقبلية مغطاة بحضور مسبق بالفعل.");
    }

    // Validation: 1-to-1 coverage - advance session cannot cover multiple sessions
    const existingAdvance = db.getFirstSync<any>(
      `SELECT id FROM advance_coverages
       WHERE center_id = ? AND student_id = ? AND advance_session_id = ?`,
      [centerId, studentId, advanceSessionId],
    );
    if (existingAdvance) {
      throw new ConflictError(
        "تم استخدام حضور هذه الحصة لتغطية حصة أخرى بالفعل.",
      );
    }

    // Coverage is only valid when the student is expected in the target
    // session. Matching teacher/subject alone is not enough. Legacy sessions
    // without a snapshot fall back to enrollment validity on that date.
    const targetExpected = AttendanceSessionService.isExpected(
      targetFutureSessionId,
      studentId,
    );
    const targetHasSnapshot = db.getFirstSync<any>(
      `SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1`,
      [centerId, targetFutureSessionId],
    );
    const targetEnrollment = db.getFirstSync<any>(
      `SELECT 1 FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND student_id = ? AND status = 'active'
         AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       LIMIT 1`,
      [
        centerId,
        targetFutureSession.groupId,
        studentId,
        targetFutureSession.sessionDate,
        targetFutureSession.sessionDate,
      ],
    );
    if (!targetExpected && (targetHasSnapshot || !targetEnrollment)) {
      throw new ValidationError("الطالب غير متوقع في الحصة المستقبلية.");
    }

    const id = `adv-cov-${generateUUID()}`;
    const operationId = `op-adv-cov-${generateUUID()}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO advance_coverages (id, operation_id, center_id, student_id, advance_session_id, target_future_session_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        operationId,
        centerId,
        studentId,
        advanceSessionId,
        targetFutureSessionId,
        user.id,
        now,
      ],
    );

    const coverage: AdvanceCoverage = {
      id,
      operationId,
      centerId,
      studentId,
      advanceSessionId,
      targetFutureSessionId,
      createdBy: user.id,
      createdAt: now,
    };

    const deviceId = await DeviceService.getDeviceId();

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "advance_coverage.create",
      entityType: "advance_coverage",
      entityId: id,
      payload: coverage,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "advance_coverage",
      entityId: id,
      action: "advance_coverage.create",
      payload: {
        studentId,
        advanceSessionId,
        targetFutureSessionId,
      },
    });

    return coverage;
  }

  /**
   * Identifies the NEXT ELIGIBLE session for a missed session.
   *
   * NEXT ELIGIBLE SESSION RULE:
   * - Must be same subject + same teacher.
   * - Must be strictly after the original missed session date/time.
   * - If that next eligible session is skipped/missed without makeup, the opportunity expires.
   */
  static getNextEligibleSession(
    studentId: string,
    originalAbsenceSessionId: string,
  ): Session | null {
    const { centerId } = this.getActiveContext();
    const originalSession = SessionRepository.findById(
      originalAbsenceSessionId,
    );
    if (!originalSession || originalSession.centerId !== centerId) {
      return null;
    }

    const db = DatabaseService.getDb();
    // Get all candidate sessions for same subject & teacher chronologically after originalSession
    const allSessions = db.getAllSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId, s.schedule_id as scheduleId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId, s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes, s.session_date as sessionDate,
              s.start_time as startTime, s.end_time as endTime, s.status
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       WHERE s.center_id = ? AND s.id != ?
         AND s.status NOT IN ('cancelled', 'closed')
       ORDER BY s.session_date ASC, s.start_time ASC`,
      [
        centerId,
        originalAbsenceSessionId,
      ],
    );

    const candidateSessions = allSessions.filter((s) => {
      if (
        s.subjectId !== originalSession.subjectId ||
        s.teacherId !== originalSession.teacherId ||
        s.id === originalAbsenceSessionId
      ) {
        return false;
      }
      const isAfter =
        s.sessionDate > originalSession.sessionDate ||
        (s.sessionDate === originalSession.sessionDate &&
          s.startTime > originalSession.startTime);
      return isAfter;
    });

    if (candidateSessions.length === 0) {
      return null;
    }

    // The next eligible session is strictly the FIRST candidate session
    // The first session for this teacher/subject is not necessarily a session
    // the student attends (the teacher can have several groups). Skip those
    // unrelated sessions instead of treating them as an expired opportunity;
    // otherwise the scanner shows the makeup badge but recording it fails with
    // the generic "invalid data" validation message.
    for (const candidate of candidateSessions) {
      const candidateHasSnapshot = db.getFirstSync<any>(
        `SELECT 1 FROM session_expected_students WHERE center_id = ? AND session_id = ? LIMIT 1`,
        [centerId, candidate.id],
      );
      const candidateExpected = AttendanceSessionService.isExpected(
        candidate.id,
        studentId,
      );
      const attended = db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, candidate.id, studentId],
      );
      if (attended) {
        // Once the next session the student was expected in has been attended,
        // the original absence has no remaining makeup opportunity.
        // Legacy sessions have no snapshot, so an attended row is likewise the
        // only evidence available and must consume the opportunity.
        if (candidateExpected || !candidateHasSnapshot) return null;
        continue;
      }
      if (!candidateExpected && candidateHasSnapshot) continue;
      return candidate;
    }

    return null;
  }

  /**
   * Returns a makeup option only when this open session is the next valid
   * session for a real absence. Snapshot existence is center/session scoped,
   * not inferred from the target student's rows.
   */
  static getEligibilityForSession(sessionId: string, studentId: string): MakeupEligibility {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const host = db.getFirstSync<any>(
      `SELECT s.id, s.group_id as groupId, s.session_date as sessionDate,
              s.start_time as startTime, s.status,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              t.name as teacherName
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       LEFT JOIN teachers t ON t.center_id = s.center_id
         AND t.id = COALESCE(s.teacher_id, g.teacher_id)
       WHERE s.center_id = ? AND s.id = ?`,
      [centerId, sessionId],
    );
    if (!host || host.status !== "open" || !host.subjectId || !host.teacherId) {
      return { eligible: false };
    }

    const sessions = db.getAllSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId,
              COALESCE(s.subject_id, g.subject_id) as subjectId,
              COALESCE(s.teacher_id, g.teacher_id) as teacherId,
              s.session_date as sessionDate, s.start_time as startTime,
              s.status, g.name as groupName
       FROM sessions s
       JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
       WHERE s.center_id = ? AND s.group_id <> ? AND s.status <> 'cancelled'
         AND COALESCE(s.subject_id, g.subject_id) = ?
         AND COALESCE(s.teacher_id, g.teacher_id) = ?
         AND (s.session_date < ? OR (s.session_date = ? AND s.start_time < ?))`,
      [centerId, host.groupId, host.subjectId, host.teacherId, host.sessionDate, host.sessionDate, host.startTime],
    );
    const studentSnapshots = db.getAllSync<any>(
      `SELECT session_id as sessionId FROM session_expected_students
       WHERE center_id = ? AND student_id = ?`,
      [centerId, studentId],
    );
    const sessionsWithSnapshots = db.getAllSync<any>(
      `SELECT DISTINCT session_id as sessionId FROM session_expected_students
       WHERE center_id = ?`,
      [centerId],
    );
    const snapshotSessionIds = new Set(
      sessionsWithSnapshots.map((row) => String(row.sessionId ?? row.session_id)),
    );
    const enrollments = db.getAllSync<any>(
      `SELECT center_id as centerId, student_id as studentId, group_id as groupId,
              start_date as startDate, end_date as endDate, status
       FROM student_group_enrollments
       WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [centerId, studentId],
    );

    const sourceSessions = sessions
      .filter((source) => {
        const isBeforeHost = source.sessionDate < host.sessionDate ||
          (source.sessionDate === host.sessionDate && source.startTime < host.startTime);
        if (
          source.centerId !== centerId || source.id === sessionId ||
          source.groupId === host.groupId || source.status === "cancelled" ||
          source.subjectId !== host.subjectId || source.teacherId !== host.teacherId ||
          !isBeforeHost
        ) return false;

        const hasSnapshot = snapshotSessionIds.has(source.id);
        const studentWasExpected = studentSnapshots.some(
          (row) => String(row.sessionId ?? row.session_id) === source.id,
        );
        if (hasSnapshot) return studentWasExpected;
        return enrollments.some((enrollment) =>
          enrollment.centerId === centerId && enrollment.studentId === studentId &&
          enrollment.groupId === source.groupId && enrollment.status === "active" &&
          enrollment.startDate <= source.sessionDate &&
          (!enrollment.endDate || enrollment.endDate >= source.sessionDate),
        );
      })
      .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.startTime.localeCompare(a.startTime));

    for (const source of sourceSessions) {
      const attendedOrCovered = db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, source.id, studentId],
      ) || this.isSessionCoveredInAdvance(studentId, source.id);
      const alreadyMadeUp = db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND student_id = ?
           AND (original_absence_id = ? OR original_absence_id = ('absence-' || ? || '-' || ?))`,
        [centerId, studentId, source.id, source.id, studentId],
      );
      if (attendedOrCovered || alreadyMadeUp) continue;

      if (this.getNextEligibleSession(studentId, source.id)?.id === sessionId) {
        return {
          eligible: true,
          sourceGroupId: source.groupId,
          sourceGroupName: source.groupName,
          teacherName: host.teacherName,
          originalAbsenceId: source.id,
        };
      }
    }
    return { eligible: false };
  }

  /**
   * Retrieves all active makeup opportunities for a student.
   */
  static getMakeupOpportunities(studentId: string): MakeupOpportunity[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور.");
    }

    const db = DatabaseService.getDb();

    // Find all sessions where student was expected
    const expectedRows = db.getAllSync<any>(
      `SELECT ses.session_id as sessionId
       FROM session_expected_students ses
       JOIN sessions s ON ses.session_id = s.id
       WHERE ses.center_id = ? AND ses.student_id = ?`,
      [centerId, studentId],
    );

    const opportunities: MakeupOpportunity[] = [];

    for (const row of expectedRows) {
      const sessionId = row.sessionId;
      // Check if student attended
      const attendance = db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, sessionId, studentId],
      );
      if (attendance) continue;

      // Check if covered in advance
      if (this.isSessionCoveredInAdvance(studentId, sessionId)) continue;

      // Check if already made up in another session
      const alreadyMadeUp = db.getFirstSync<any>(
        `SELECT id FROM attendance
         WHERE center_id = ? AND student_id = ?
           AND (original_absence_id = ? OR original_absence_id = ('absence-' || ? || '-' || ?))`,
        [centerId, studentId, sessionId, sessionId, studentId],
      );
      if (alreadyMadeUp) continue;

      // Check next eligible session
      const nextSession = this.getNextEligibleSession(studentId, sessionId);
      if (nextSession) {
        const originalSession = SessionRepository.findById(sessionId);
        opportunities.push({
          originalAbsenceSessionId: sessionId,
          subjectId: nextSession.subjectId || "",
          subjectName: originalSession?.subjectName || "",
          teacherId: nextSession.teacherId || "",
          teacherName: originalSession?.teacherName || "",
          nextEligibleSessionId: nextSession.id,
          nextEligibleSessionDate: nextSession.sessionDate,
          nextEligibleSessionStartTime: nextSession.startTime,
        });
      }
    }

    return opportunities;
  }

  /**
   * Records attendance as a makeup session linked to the original missed session.
   * Strictly enforces the next-eligible-session rule.
   */
  static async recordMakeupAttendance(params: {
    studentId: string;
    sessionId: string;
    originalAbsenceId: string;
    isLate?: boolean;
    checkInTime?: string;
  }): Promise<Attendance> {
    const existingAttendance = AttendanceRepository.getStudentAttendanceInSession(
      params.sessionId,
      params.studentId,
    );
    if (existingAttendance) {
      throw new ConflictError(
        existingAttendance.attendanceType === "makeup"
          ? "تم تسجيل حضور الطالب كتعويض مسبقًا."
          : "تم تسجيل حضور الطالب مسبقًا لهذه الحصة.",
      );
    }

    // Prefer the shared session-scoped eligibility query. It resolves legacy
    // sessions whose teacher/subject snapshot columns are missing and keeps
    // package students eligible when the source absence was real. Retain the
    // older next-session check as a fallback for records created by older
    // builds.
    const sharedEligibility = AttendanceSessionService.getMakeupEligibility(
      params.sessionId,
      params.studentId,
    );
    const nextEligible = sharedEligibility.eligible
      ? { id: params.sessionId }
      : this.getNextEligibleSession(params.studentId, params.originalAbsenceId);
    if (!nextEligible || nextEligible.id !== params.sessionId ||
        (sharedEligibility.eligible && sharedEligibility.originalAbsenceId !== params.originalAbsenceId)) {
      throw new ValidationError(
        "الحصة المحددة ليست الحصة التالية المؤهلة للتعويض أو انتهت صلاحية فرصة التعويض.",
      );
    }

    return AttendanceRepository.recordAttendance({
      studentId: params.studentId,
      sessionId: params.sessionId,
      status: params.isLate ? "late" : "present",
      isLate: Boolean(params.isLate),
      attendanceType: "makeup",
      originalAbsenceId: params.originalAbsenceId,
      checkInTime: params.checkInTime,
    });
  }
}
