import { Attendance, MakeupOpportunity, Session, Student } from "../../shared/types";
import { AbsenceService } from "./AbsenceService";
import { AttendanceRepository } from "./AttendanceRepository";
import { MakeupService } from "./MakeupService";
import { SessionRepository } from "../sessions/SessionRepository";
import { StudentRepository } from "../students/StudentRepository";
import { getLocalDateOnly } from "../../shared/utils/date";
export interface AbsenceSessionSummary {
  session: Session;
  sessionNumber?: number;
  total: number;
  present: number;
  absent: number;
  compensated: number;
}

export interface CompensationReportRow {
  student: Student;
  kind: "completed" | "eligible" | "advanced";
  attendance?: Attendance;
  opportunity?: MakeupOpportunity;
}

export interface AbsenceSessionReport {
  session: Session;
  expected: Student[];
  absent: Student[];
  present: Array<{ student: Student; attendance: Attendance }>;
  compensation: CompensationReportRow[];
  compensated: number;
  attendance: Attendance[];
}

export { calculateSessionAttendanceCounts } from "./AttendanceCalculations";
export type { SessionAttendanceCounts } from "./AttendanceCalculations";

/** Counts final student states once, never raw attendance rows. */
export function calculateAbsenceReportCounts(
  expected: Student[],
  absent: Student[],
  attendance: Attendance[],
  advancedStudentIds: string[],
) {
  const expectedIds = new Set(expected.map((student) => student.id));
  const advancedIds = new Set(advancedStudentIds);
  const presentIds = new Set(
    attendance
      .filter((item) => item.attendanceType !== "makeup" && (item.status === "present" || item.status === "late") && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const present = expected.filter((student) => presentIds.has(student.id) && !advancedIds.has(student.id));
  // The expected snapshot is authoritative. AbsenceService is still queried
  // by the report composition for eligibility, but raw attendance (including
  // makeup attendance) cannot remove an expected student from this list.
  const absentFinal = expected.filter((student) => !presentIds.has(student.id) && !advancedIds.has(student.id));
  const makeupCount = new Set(attendance.filter((item) => item.attendanceType === "makeup").map((item) => item.studentId)).size;
  return { total: expected.length, present, absent: absentFinal, compensated: makeupCount + advancedIds.size };
}

/** Read-only composition of the existing session, attendance, absence and makeup services. */
export class AbsenceReportsService {
  static getSessionsForMonth(month: string): AbsenceSessionSummary[] {
    const counters = new Map<string, number>();
    const today = getLocalDateOnly();
    const currentTime = new Date().toTimeString().slice(0, 5);
    const dailySessions = new Map<string, Session>();
    for (const session of SessionRepository.getSessionsForMonth(month)) {
      if (session.status === "cancelled") continue;
      const key = `${session.groupId}:${session.sessionDate}`;
      // Keep the first canonical session for a group/day. This also prevents
      // old duplicate rows from producing duplicate absence/SMS reports.
      if (!dailySessions.has(key)) dailySessions.set(key, session);
    }
    return Array.from(dailySessions.values())
      .filter((session) =>
        session.status === "open" ||
        (session.status !== "cancelled" &&
          (session.sessionDate < today ||
            (session.sessionDate === today && String(session.endTime || "") <= currentTime))),
      )
      .slice().sort((a, b) => `${a.groupId}-${a.sessionDate}-${a.startTime}`.localeCompare(`${b.groupId}-${b.sessionDate}-${b.startTime}`)).map((session) => {
      const report = this.getSessionReport(session.id);
      const sessionNumber = (counters.get(session.groupId) || 0) + 1;
      counters.set(session.groupId, sessionNumber);
      return { session, sessionNumber, total: report.expected.length, present: report.present.length, absent: report.absent.length, compensated: report.compensated };
    });
  }

  static getSessionReport(sessionId: string): AbsenceSessionReport {
    const session = SessionRepository.findById(sessionId);
    if (!session) throw new Error("الحصة غير موجودة في المركز الحالي.");

    const expected = SessionRepository.getExpectedStudents(sessionId);
    const attendance = AttendanceRepository.getSessionAttendance(sessionId);
    const byStudent = new Map(expected.map((student) => [student.id, student]));
    const absentFromService = AbsenceService.getAbsenteesForSession(sessionId);
    const advancedStudentIds = expected
      .filter((student) => MakeupService.isSessionCoveredInAdvance(student.id, sessionId))
      .map((student) => student.id);
    const counts = calculateAbsenceReportCounts(expected, absentFromService, attendance, advancedStudentIds);
    const presentAttendance = new Map(
      attendance
        .filter((item) => item.attendanceType !== "makeup" && (item.status === "present" || item.status === "late") && byStudent.has(item.studentId))
        .map((item) => [item.studentId, item]),
    );
    const present = counts.present.map((student) => ({ student, attendance: presentAttendance.get(student.id)! }));

    const compensation: CompensationReportRow[] = attendance
      .filter((item) => item.attendanceType === "makeup")
      .flatMap((item) => {
        const student = byStudent.get(item.studentId) || StudentRepository.findByIdForAttendanceReport(item.studentId);
        return student ? [{ student, kind: "completed" as const, attendance: item }] : [];
      });

    for (const student of expected) {
      if (advancedStudentIds.includes(student.id)) {
        compensation.push({ student, kind: "advanced" });
        continue;
      }
      const opportunity = MakeupService.getMakeupOpportunities(student.id)
        .find((item) => item.nextEligibleSessionId === sessionId);
      if (opportunity) compensation.push({ student, kind: "eligible", opportunity });
    }

    return { session, expected, absent: counts.absent, present, compensation, compensated: compensation.length, attendance };
  }
}
