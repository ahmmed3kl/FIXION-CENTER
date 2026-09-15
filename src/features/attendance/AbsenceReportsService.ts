import { Attendance, MakeupOpportunity, Session, Student } from "../../shared/types";
import { AbsenceService } from "./AbsenceService";
import { AttendanceRepository } from "./AttendanceRepository";
import { MakeupService } from "./MakeupService";
import { SessionRepository } from "../sessions/SessionRepository";
import { StudentRepository } from "../students/StudentRepository";

export interface AbsenceSessionSummary {
  session: Session;
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

export interface SessionAttendanceCounts {
  expected: number;
  present: number;
  absent: number;
  late: number;
  makeup: number;
}

/**
 * Canonical session aggregation. The expected snapshot is authoritative;
 * attendance rows can never add students to the regular roster. Makeup rows
 * are counted in their own dimension and are deliberately excluded from
 * regular present/absent calculations.
 */
export function calculateSessionAttendanceCounts(
  expectedStudentIds: string[],
  attendance: Pick<Attendance, "studentId" | "status" | "attendanceType">[],
  coveredInAdvanceIds: string[] = [],
): SessionAttendanceCounts {
  const expectedIds = new Set(expectedStudentIds);
  const regularRows = attendance.filter((item) => item.attendanceType !== "makeup");
  const presentIds = new Set(
    regularRows
      .filter((item) => (item.status === "present" || item.status === "late") && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const advancedIds = new Set(coveredInAdvanceIds.filter((id) => expectedIds.has(id)));
  const absent = expectedStudentIds.filter((id) => !presentIds.has(id) && !advancedIds.has(id)).length;
  const makeup = new Set(attendance.filter((item) => item.attendanceType === "makeup").map((item) => item.studentId)).size;
  const late = new Set(
    regularRows
      .filter((item) => item.status === "late" && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  ).size;
  return { expected: expectedStudentIds.length, present: presentIds.size, absent, late, makeup };
}

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
    return SessionRepository.getSessionsForMonth(month).map((session) => {
      const report = this.getSessionReport(session.id);
      return { session, total: report.expected.length, present: report.present.length, absent: report.absent.length, compensated: report.compensated };
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
