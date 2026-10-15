import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { Session, Student } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SessionRepository } from "../sessions/SessionRepository";
import { SessionDateService } from "../sessions/SessionDateService";
import { getDateOnlyInTimeZone } from "../../shared/utils/date";
import { MakeupService } from "./MakeupService";

export class AbsenceService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /** Returns only students with an explicit absent attendance record. */
  static getAbsenteesForSession(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور والغياب.");
    }
    const db = DatabaseService.getDb();
    const expectedStudents = SessionRepository.getExpectedStudents(sessionId);

    const absentRows = db.getAllSync<{ studentId: string }>(
      `SELECT student_id as studentId FROM attendance
       WHERE center_id = ? AND session_id = ? AND status = 'absent'
         AND attendance_type <> 'makeup'
         AND NOT EXISTS (
           SELECT 1 FROM attendance resolved
            WHERE resolved.center_id = attendance.center_id
              AND resolved.session_id = attendance.session_id
              AND resolved.student_id = attendance.student_id
              AND resolved.status IN ('present', 'late')
         )
         AND NOT EXISTS (
           SELECT 1 FROM advance_coverages coverage
            WHERE coverage.center_id = attendance.center_id
              AND coverage.student_id = attendance.student_id
              AND coverage.target_future_session_id = attendance.session_id
         )`,
      [centerId, sessionId],
    );
    const absentIds = new Set(absentRows.map((row) => row.studentId));
    return expectedStudents.filter((student) => absentIds.has(student.id));
  }

  /**
   * Checks if a student is absent from a session.
   */
  static isStudentAbsent(sessionId: string, studentId: string): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    if (!SessionRepository.getExpectedStudents(sessionId).some((student) => student.id === studentId)) return false;

    const explicitAbsence = db.getFirstSync<any>(
      `SELECT id FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?
         AND status = 'absent' AND attendance_type <> 'makeup'
         AND NOT EXISTS (
           SELECT 1 FROM attendance resolved
            WHERE resolved.center_id = attendance.center_id
              AND resolved.session_id = attendance.session_id
              AND resolved.student_id = attendance.student_id
              AND resolved.status IN ('present', 'late')
         )
         AND NOT EXISTS (
           SELECT 1 FROM advance_coverages coverage
            WHERE coverage.center_id = attendance.center_id
              AND coverage.student_id = attendance.student_id
              AND coverage.target_future_session_id = attendance.session_id
         )`,
      [centerId, sessionId, studentId],
    );
    return Boolean(explicitAbsence);
  }

  /**
   * Retrieves all absences for a student with makeup eligibility status.
   */
  static getStudentAbsences(studentId: string): {
    session: Session;
    canMakeup: boolean;
    nextEligibleSession?: Session | null;
  }[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الغياب.");
    }
    const db = DatabaseService.getDb();

    const expectedRows = db.getAllSync<any>(
      `SELECT ses.session_id as sessionId
       FROM session_expected_students ses
       WHERE ses.center_id = ? AND ses.student_id = ?`,
      [centerId, studentId],
    );

    const absences: {
      session: Session;
      canMakeup: boolean;
      nextEligibleSession?: Session | null;
    }[] = [];

    for (const row of expectedRows) {
      if (this.isStudentAbsent(row.sessionId, studentId)) {
        const session = SessionRepository.findById(row.sessionId);
        const now = new Date();
        const timeZone = SessionDateService.getCenterTimeZone(centerId);
        const today = getDateOnlyInTimeZone(now, timeZone);
        const nowTime = new Intl.DateTimeFormat("en-GB", {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(now);
        const sessionHasEnded = session && (
          session.sessionDate < today ||
          (session.sessionDate === today && String(session.endTime || "") <= nowTime)
        );
        if (session && session.status !== "cancelled" && sessionHasEnded) {
          const nextEligibleSession = MakeupService.getNextEligibleSession(
            studentId,
            row.sessionId,
          );
          absences.push({
            session,
            canMakeup: !!nextEligibleSession,
            nextEligibleSession,
          });
        }
      }
    }

    return absences;
  }
}
