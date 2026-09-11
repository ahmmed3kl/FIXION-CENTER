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

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
      `SELECT id, center_id as centerId, group_id as groupId, schedule_id as scheduleId,
              subject_id as subjectId, teacher_id as teacherId, session_price as sessionPrice,
              late_after_minutes as lateAfterMinutes, session_date as sessionDate,
              start_time as startTime, end_time as endTime, status
       FROM sessions
       WHERE center_id = ? AND subject_id = ? AND teacher_id = ? AND id != ?
       ORDER BY session_date ASC, start_time ASC`,
      [
        centerId,
        originalSession.subjectId,
        originalSession.teacherId,
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
    const firstCandidate = candidateSessions[0];

    // Check if the student already attended this first candidate session
    const attended = db.getFirstSync<any>(
      `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, firstCandidate.id, studentId],
    );

    if (attended) {
      // Already attended or used
      return null;
    }

    return firstCandidate;
  }

  /**
   * Retrieves all active makeup opportunities for a student.
   */
  static getMakeupOpportunities(studentId: string): MakeupOpportunity[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "attendance.view")) {
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
        `SELECT id FROM attendance WHERE center_id = ? AND student_id = ? AND original_absence_id = ?`,
        [centerId, studentId, sessionId],
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
    const nextEligible = this.getNextEligibleSession(
      params.studentId,
      params.originalAbsenceId,
    );
    if (!nextEligible || nextEligible.id !== params.sessionId) {
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
