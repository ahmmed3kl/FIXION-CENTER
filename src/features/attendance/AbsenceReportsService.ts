import { Attendance, MakeupOpportunity, Session, Student } from "../../shared/types";
import { AttendanceRepository } from "./AttendanceRepository";
import { AbsenceNoteRepository } from "./AbsenceNoteRepository";
import { DatabaseService } from "../../core/database";
import { MakeupService } from "./MakeupService";
import { SessionRepository } from "../sessions/SessionRepository";
import { StudentRepository } from "../students/StudentRepository";
import { sortSessionsByActivation } from "../sessions/sessionOrdering";
import { Logger } from "../../core/logger";
import { parseLocalDateOnly } from "../../shared/utils/date";
import {
  DEFAULT_TEACHER_WEEK_START_DAY,
  getTeacherWeekBounds,
  isWithinTeacherWeekCycle,
  normalizeTeacherWeekStartDay,
} from "../../shared/utils/teacherWeeks";
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
  originalSession?: Session;
  targetSession?: Session;
}

export interface MonthlyNeverAttendedRow {
  student: Student;
  teacherId: string;
  subjectId: string;
  teacherNames: string[];
  subjectName: string;
  groupNames: string[];
  cycleStartDate: string;
  cycleEndDate: string;
}

export interface MonthlyCrossGroupMakeupRow {
  student: Student;
  attendance: Attendance;
  originalSession: Session;
  targetSession: Session;
}

export interface AbsenceSessionReport {
  session: Session;
  expected: Student[];
  absent: Student[];
  present: Array<{ student: Student; attendance: Attendance }>;
  compensation: CompensationReportRow[];
  compensated: number;
  attendance: Attendance[];
  absenceNotes: Record<string, string>;
}

export { calculateSessionAttendanceCounts } from "./AttendanceCalculations";
export type { SessionAttendanceCounts } from "./AttendanceCalculations";

/** A started report session treats students without a presence outcome as absent. */
export function calculateAbsenceReportCounts(
  expected: Student[],
  attendance: Attendance[],
  advancedStudentIds: string[],
  sessionStarted = true,
) {
  const expectedIds = new Set(expected.map((student) => student.id));
  const advancedIds = new Set(advancedStudentIds);
  const presentIds = new Set(
    attendance
      .filter((item) => item.attendanceType !== "makeup" && (item.status === "present" || item.status === "late") && expectedIds.has(item.studentId))
      .map((item) => item.studentId),
  );
  const present = expected.filter((student) => presentIds.has(student.id) && !advancedIds.has(student.id));
  const makeupIds = new Set(
    attendance
      .filter((item) =>
        item.attendanceType === "makeup" &&
        (item.status === "present" || item.status === "late"),
      )
      .map((item) => item.studentId),
  );
  const absentFinal = sessionStarted
    ? expected.filter(
        (student) =>
          !presentIds.has(student.id) &&
          !advancedIds.has(student.id) &&
          !makeupIds.has(student.id),
      )
    : expected.filter((student) =>
        attendance.some(
          (item) =>
            item.studentId === student.id &&
            item.status === "absent" &&
            item.attendanceType !== "makeup",
        ) &&
        !presentIds.has(student.id) &&
        !advancedIds.has(student.id) &&
        !makeupIds.has(student.id),
      );
  const makeupCount = new Set(attendance.filter((item) => item.attendanceType === "makeup").map((item) => item.studentId)).size;
  return { total: expected.length, present, absent: absentFinal, compensated: makeupCount + advancedIds.size };
}

/** Read-only composition of the existing session, attendance, absence and makeup services. */
export class AbsenceReportsService {
  static getSessionsForMonth(month: string): AbsenceSessionSummary[] {
    const counters = new Map<string, number>();
    const sessionsById = new Map<string, Session>();
    for (const session of SessionRepository.getSessionsForMonth(month)) {
      if (session.status === "cancelled" || sessionsById.has(session.id)) continue;
      sessionsById.set(session.id, session);
    }
    const reportSessions = Array.from(sessionsById.values())
      // A timetable row is not an absence report. The report is created when
      // attendance is explicitly started and remains visible after manual
      // close; closing the app or passing the scheduled end time must not
      // create or remove a report.
      .filter((session) => session.status === "open" || session.status === "closed");
    const activationTimes = SessionRepository.getActivationTimestamps(reportSessions.map((session) => session.id));

    return sortSessionsByActivation(reportSessions, activationTimes).map((session) => {
      const report = this.getSessionReport(session.id);
      const sessionNumber = (counters.get(session.groupId) || 0) + 1;
      counters.set(session.groupId, sessionNumber);
      return { session, sessionNumber, total: report.expected.length, present: report.present.length, absent: report.absent.length, compensated: report.compensated };
    });
  }

  static getMonthlyNeverAttended(
    month: string,
    sessions = this.getSessionsForMonth(month),
  ): MonthlyNeverAttendedRow[] {
    const monthlySessions = sessions.filter(({ session }) => session.sessionDate.slice(0, 7) === month);
    if (!monthlySessions.length) return [];
    const centerId = monthlySessions[0].session.centerId;
    if (!centerId) return [];
    const db = DatabaseService.getDb();
    const teacherWeekStarts = new Map<string, number>();
    const cycles = new Map<string, {
      teacherId: string;
      subjectId: string;
      subjectName: string;
      teacherName: string;
      cycleStartDate: string;
      cycleEndDate: string;
      sessions: AbsenceSessionSummary["session"][];
      expectedByStudent: Map<string, { student: Student; groups: Set<string> }>;
    }>();
    const attendanceBySession = new Map<string, Attendance[]>();

    for (const { session } of monthlySessions) {
      if (!session.teacherId || !session.subjectId) continue;
      let weekStartDay = teacherWeekStarts.get(session.teacherId);
      if (weekStartDay === undefined) {
        const teacher = db.getFirstSync<{ weekStartDay?: unknown }>(
          "SELECT week_start_day as weekStartDay FROM teachers WHERE center_id = ? AND id = ?",
          [centerId, session.teacherId],
        );
        weekStartDay = normalizeTeacherWeekStartDay(
          teacher?.weekStartDay ?? DEFAULT_TEACHER_WEEK_START_DAY,
        );
        teacherWeekStarts.set(session.teacherId, weekStartDay);
      }
      const bounds = getTeacherWeekBounds(session.sessionDate, weekStartDay);
      const key = `${session.teacherId}:${session.subjectId}:${bounds.startDate}`;
      let cycle = cycles.get(key);
      if (!cycle) {
        cycle = {
          teacherId: session.teacherId,
          subjectId: session.subjectId,
          subjectName: session.subjectName || "",
          teacherName: session.teacherName || "",
          cycleStartDate: bounds.startDate,
          cycleEndDate: bounds.endDate,
          sessions: [],
          expectedByStudent: new Map(),
        };
        cycles.set(key, cycle);
      }
      cycle.sessions.push(session);
      const attendance = AttendanceRepository.getSessionAttendance(session.id);
      attendanceBySession.set(session.id, attendance);
      for (const student of SessionRepository.getExpectedStudents(session.id)) {
        const expected = cycle.expectedByStudent.get(student.id) || {
          student,
          groups: new Set<string>(),
        };
        if (session.groupName) expected.groups.add(session.groupName);
        cycle.expectedByStudent.set(student.id, expected);
      }
    }

    const rows: MonthlyNeverAttendedRow[] = [];
    for (const cycle of cycles.values()) {
      const attended = new Set<string>();
      const cycleSessionIds = new Set(cycle.sessions.map((session) => session.id));
      for (const targetSession of cycle.sessions) {
        for (const record of attendanceBySession.get(targetSession.id) || []) {
          if (
            (record.status !== "present" && record.status !== "late") ||
            record.isExternal
          ) continue;
          if (record.attendanceType !== "makeup") {
            attended.add(record.studentId);
            continue;
          }

          if (!record.originalAbsenceId) continue;
          const sourceSession = SessionRepository.findById(record.originalAbsenceId);
          if (
            !sourceSession ||
            !cycleSessionIds.has(sourceSession.id) ||
            sourceSession.teacherId !== cycle.teacherId ||
            sourceSession.subjectId !== cycle.subjectId ||
            !isWithinTeacherWeekCycle(
              sourceSession.sessionDate,
              targetSession.sessionDate,
              teacherWeekStarts.get(cycle.teacherId) ?? DEFAULT_TEACHER_WEEK_START_DAY,
            ) ||
            !SessionRepository.getExpectedStudents(sourceSession.id)
              .some((student) => student.id === record.studentId) ||
            (() => {
              const sourceAtt = AttendanceRepository.getStudentAttendanceInSession(sourceSession.id, record.studentId);
              return Boolean(sourceAtt && (sourceAtt.status === "present" || sourceAtt.status === "late"));
            })()
          ) continue;
          attended.add(record.studentId);
        }
      }

      for (const [studentId, expected] of cycle.expectedByStudent) {
        if (attended.has(studentId)) continue;
        rows.push({
          student: expected.student,
          teacherId: cycle.teacherId,
          subjectId: cycle.subjectId,
          teacherNames: cycle.teacherName ? [cycle.teacherName] : [],
          subjectName: cycle.subjectName,
          groupNames: Array.from(expected.groups).sort(),
          cycleStartDate: cycle.cycleStartDate,
          cycleEndDate: cycle.cycleEndDate,
        });
      }
    }
    return rows.sort((a, b) =>
      a.student.fullName.localeCompare(b.student.fullName, "ar") ||
      a.cycleStartDate.localeCompare(b.cycleStartDate),
    );
  }

  static getNeverAttendedForSession(
    session: Session,
    monthlyRows: MonthlyNeverAttendedRow[],
    successfullyCompensatedStudentIds: ReadonlySet<string> = new Set(),
    currentAbsentStudentIds?: ReadonlySet<string>,
  ): MonthlyNeverAttendedRow[] {
    if (!session.teacherId || !session.subjectId || !session.centerId) return [];
    const expectedStudentIds = new Set(
      SessionRepository.getExpectedStudents(session.id).map((student) => student.id),
    );
    if (!expectedStudentIds.size) return [];
    const teacher = DatabaseService.getDb().getFirstSync<{ weekStartDay?: unknown }>(
      "SELECT week_start_day as weekStartDay FROM teachers WHERE center_id = ? AND id = ?",
      [session.centerId, session.teacherId],
    );
    const weekStartDay = normalizeTeacherWeekStartDay(
      teacher?.weekStartDay ?? DEFAULT_TEACHER_WEEK_START_DAY,
    );
    const cycleStartDate = getTeacherWeekBounds(session.sessionDate, weekStartDay).startDate;
    return monthlyRows.filter((row) =>
      row.teacherId === session.teacherId &&
      row.subjectId === session.subjectId &&
      row.cycleStartDate === cycleStartDate &&
      expectedStudentIds.has(row.student.id) &&
      !successfullyCompensatedStudentIds.has(row.student.id) &&
      (!currentAbsentStudentIds || currentAbsentStudentIds.has(row.student.id)),
    );
  }

  static getMonthlyCrossGroupMakeups(
    month: string,
    sessions = this.getSessionsForMonth(month),
  ): MonthlyCrossGroupMakeupRow[] {
    const rows: MonthlyCrossGroupMakeupRow[] = [];
    for (const { session: targetSession } of sessions) {
      for (const attendance of AttendanceRepository.getSessionAttendance(targetSession.id)) {
        if (
          attendance.attendanceType !== "makeup" ||
          (attendance.status !== "present" && attendance.status !== "late") ||
          attendance.isExternal ||
          !attendance.originalAbsenceId ||
          attendance.sessionId !== targetSession.id
        ) continue;
        const originalSession = SessionRepository.findById(attendance.originalAbsenceId);
        if (
          !originalSession ||
          originalSession.groupId === targetSession.groupId ||
          originalSession.teacherId !== targetSession.teacherId ||
          originalSession.subjectId !== targetSession.subjectId ||
          !SessionRepository.getExpectedStudents(originalSession.id)
            .some((student) => student.id === attendance.studentId) ||
          (() => {
            const origAtt = AttendanceRepository.getStudentAttendanceInSession(originalSession.id, attendance.studentId);
            return Boolean(origAtt && (origAtt.status === "present" || origAtt.status === "late"));
          })()
        ) continue;
        const student = StudentRepository.findByIdForAttendanceReport(attendance.studentId);
        if (student) rows.push({ student, attendance, originalSession, targetSession });
      }
    }
    return rows.sort((a, b) =>
      b.targetSession.sessionDate.localeCompare(a.targetSession.sessionDate) ||
      a.student.fullName.localeCompare(b.student.fullName, "ar"),
    );
  }

  static getSessionReport(sessionId: string): AbsenceSessionReport {
    const session = SessionRepository.findById(sessionId);
    if (!session) throw new Error("الحصة غير موجودة في المركز الحالي.");
    if (!parseLocalDateOnly(session.sessionDate)) {
      Logger.warn("attendance", "absence_report_session_date_unavailable", {
        centerId: session.centerId,
        entityType: "session",
        metadata: {
          sessionId: session.id,
          source: "sessions.session_date",
          reason: session.sessionDate ? "invalid" : "missing",
        },
      });
    }

    const expected = SessionRepository.getExpectedStudents(sessionId);
    const attendance = AttendanceRepository.getSessionAttendance(sessionId);
    const byStudent = new Map(expected.map((student) => [student.id, student]));
    const advancedStudentIds = expected
      .filter((student) => MakeupService.isSessionCoveredInAdvance(student.id, sessionId))
      .map((student) => student.id);
    const counts = calculateAbsenceReportCounts(
      expected,
      attendance,
      advancedStudentIds,
      session.status === "open" || session.status === "closed",
    );
    const presentAttendance = new Map(
      attendance
        .filter((item) => item.attendanceType !== "makeup" && (item.status === "present" || item.status === "late") && byStudent.has(item.studentId))
        .map((item) => [item.studentId, item]),
    );
    const present = counts.present.map((student) => ({ student, attendance: presentAttendance.get(student.id)! }));

    const compensation: CompensationReportRow[] = attendance
      .filter((item) =>
        item.attendanceType === "makeup" &&
        (item.status === "present" || item.status === "late") &&
        !item.isExternal &&
        Boolean(item.originalAbsenceId),
      )
      .flatMap((item) => {
        const originalSession = SessionRepository.findById(item.originalAbsenceId!);
        const origAtt = AttendanceRepository.getStudentAttendanceInSession(item.originalAbsenceId!, item.studentId);
        if (
          !originalSession ||
          !SessionRepository.getExpectedStudents(originalSession.id)
            .some((student) => student.id === item.studentId) ||
          (origAtt && (origAtt.status === "present" || origAtt.status === "late"))
        ) return [];
        const student = byStudent.get(item.studentId) || StudentRepository.findByIdForAttendanceReport(item.studentId);
        return student
          ? [{ student, kind: "completed" as const, attendance: item, originalSession }]
          : [];
      });

    // Also surface students expected in this session who completed makeup in another group
    try {
      const db = DatabaseService.getDb();
      const compensatedElsewhereRows = db.getAllSync<any>(
        `SELECT a.id, a.center_id as centerId, a.student_id as studentId,
                a.session_id as targetSessionId, a.check_in_time as checkInTime,
                a.status, a.is_late as isLate, a.attendance_type as attendanceType,
                a.original_absence_id as originalAbsenceId
         FROM attendance a
         WHERE a.center_id = ?
           AND a.attendance_type = 'makeup'
           AND (a.status = 'present' OR a.status = 'late')
           AND a.session_id <> ?
           AND (
             a.original_absence_id = ?
             OR a.original_absence_id = ('absence-' || ? || '-' || a.student_id)
           )`,
        [session.centerId, sessionId, sessionId, sessionId],
      );
      for (const row of compensatedElsewhereRows) {
        if (!compensation.some((c) => c.student.id === row.studentId && c.kind === "completed")) {
          const compStudent = byStudent.get(row.studentId) || StudentRepository.findByIdForAttendanceReport(row.studentId);
          const origAtt = AttendanceRepository.getStudentAttendanceInSession(sessionId, row.studentId);
          const isPresentInOrig = origAtt && (origAtt.status === "present" || origAtt.status === "late");
          if (compStudent && !isPresentInOrig) {
            const targetSession = SessionRepository.findById(row.targetSessionId);
            compensation.push({
              student: compStudent,
              kind: "completed",
              attendance: {
                id: row.id,
                centerId: row.centerId,
                studentId: row.studentId,
                sessionId: row.targetSessionId,
                checkInTime: row.checkInTime,
                status: row.status,
                isLate: Boolean(row.isLate),
                attendanceType: "makeup",
                originalAbsenceId: sessionId,
                operationId: "",
              },
              originalSession: session,
              targetSession: targetSession || undefined,
            } as any);
          }
        }
      }
    } catch {
      // In-memory or partial test mocks
    }
    const absenceNotes = Object.fromEntries(
      AbsenceNoteRepository.getForSession(sessionId).map((note) => [note.studentId, note.text]),
    );

    for (const student of expected) {
      if (advancedStudentIds.includes(student.id)) {
        compensation.push({ student, kind: "advanced" });
        continue;
      }
      const opportunity = MakeupService.getMakeupOpportunities(student.id)
        .find((item) => item.nextEligibleSessionId === sessionId);
      if (opportunity) compensation.push({ student, kind: "eligible", opportunity });
    }

    return { session, expected, absent: counts.absent, present, compensation, compensated: compensation.length, attendance, absenceNotes };
  }
}
