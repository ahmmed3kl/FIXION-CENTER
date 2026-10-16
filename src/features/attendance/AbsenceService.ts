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

  private static isStartedSession(centerId: string, sessionId: string): boolean {
    const session = SessionRepository.findById(sessionId);
    return Boolean(
      session &&
      session.centerId === centerId &&
      (session.status === "open" || session.status === "closed"),
    );
  }

  /** Missing attendance in a started session is an initial absence. */
  static getAbsenteesForSession(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور والغياب.");
    }
    if (!this.isStartedSession(centerId, sessionId)) return [];

    const db = DatabaseService.getDb();
    const expectedStudents = SessionRepository.getExpectedStudents(sessionId);
    const attendanceRows = db.getAllSync<{ studentId: string; status: string }>(
      `SELECT student_id as studentId, status FROM attendance
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    const attendedIds = new Set(
      attendanceRows
        .filter((row) => row.status === "present" || row.status === "late")
        .map((row) => row.studentId),
    );
    const advancedIds = new Set(
      db.getAllSync<{ studentId: string }>(
        `SELECT student_id as studentId FROM advance_coverages
         WHERE center_id = ? AND target_future_session_id = ?`,
        [centerId, sessionId],
      ).map((row) => row.studentId),
    );
    return expectedStudents.filter(
      (student) => !attendedIds.has(student.id) && !advancedIds.has(student.id),
    );
  }

  /**
   * Checks if a student is absent from a session.
   */
  static isStudentAbsent(sessionId: string, studentId: string): boolean {
    const { centerId } = this.getActiveContext();
    if (!this.isStartedSession(centerId, sessionId)) return false;
    const db = DatabaseService.getDb();

    if (!SessionRepository.getExpectedStudents(sessionId).some((student) => student.id === studentId)) return false;

    const attended = db.getFirstSync<any>(
      `SELECT id FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?
         AND status IN ('present', 'late')
       LIMIT 1`,
      [centerId, sessionId, studentId],
    );
    if (attended) return false;
    const covered = db.getFirstSync<any>(
      `SELECT id FROM advance_coverages
       WHERE center_id = ? AND student_id = ? AND target_future_session_id = ?
       LIMIT 1`,
      [centerId, studentId, sessionId],
    );
    return !covered;
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
