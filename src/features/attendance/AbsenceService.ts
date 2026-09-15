import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { Session, Student } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SessionRepository } from "../sessions/SessionRepository";
import { MakeupService } from "./MakeupService";

export class AbsenceService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Dynamically derives absent students for a session.
   * Absence = session_expected_students MINUS (present + makeup attendance + advance coverage).
   */
  static getAbsenteesForSession(sessionId: string): Student[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات الحضور والغياب.");
    }
    const db = DatabaseService.getDb();

    // 1. Expected students snapshot
    const expectedStudents = db.getAllSync<any>(
      `SELECT s.id, s.center_id as centerId, s.student_code as studentCode,
              s.full_name as fullName, s.phone, s.parent_phone as parentPhone,
              s.grade, s.status, s.student_type as studentType
       FROM session_expected_students ses
       JOIN students s ON ses.student_id = s.id
       WHERE ses.center_id = ? AND ses.session_id = ?`,
      [centerId, sessionId],
    );

    // 2. Filter out students with recorded attendance or advance coverage
    const absentees: Student[] = [];
    for (const student of expectedStudents) {
      const isCovered = MakeupService.isSessionCoveredInAdvance(
        student.id,
        sessionId,
      );
      if (isCovered) continue;

      const attended = db.getFirstSync<any>(
        `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, sessionId, student.id],
      );
      if (attended) continue;

      absentees.push(student);
    }

    return absentees;
  }

  /**
   * Checks if a student is absent from a session.
   */
  static isStudentAbsent(sessionId: string, studentId: string): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const isExpected = db.getFirstSync<any>(
      `SELECT id FROM session_expected_students
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (!isExpected) return false;

    const attended = db.getFirstSync<any>(
      `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (attended) return false;

    const isCovered = MakeupService.isSessionCoveredInAdvance(
      studentId,
      sessionId,
    );
    if (isCovered) return false;

    return true;
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
        if (session) {
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
