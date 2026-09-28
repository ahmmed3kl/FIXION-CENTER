import { DatabaseService } from "../../core/database";
import { UnauthorizedError } from "../../core/errors";
import { useAuthStore } from "../auth/useAuthStore";
import { calculateSessionAttendanceCounts } from "../attendance/AttendanceCalculations";
import { getLocalDateOnly } from "../../shared/utils/date";

export interface DashboardSummary {
  expectedCount: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  makeupCount: number;
  totalSessions: number;
  openSessions: number;
  closedSessions: number;
  todayCollections: number;
}

/** Dashboard metrics are based on today's timetable and durable history. */
export class DashboardService {
  static getTodaySummary(targetDate?: string): DashboardSummary {
    try {
      return this.readTodaySummary(targetDate);
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (message.includes("NativeDatabase.prepareSync") || message.includes("NullPointerException")) {
        DatabaseService.reinitialize();
        return this.readTodaySummary(targetDate);
      }
      throw error;
    }
  }

  private static readTodaySummary(targetDate?: string): DashboardSummary {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) throw new UnauthorizedError("يجب تحديد مركز نشط.");
    const db = DatabaseService.getDb();
    const dateStr = targetDate || getLocalDateOnly();
    const dayOfWeek = new Date(`${dateStr}T12:00:00`).getDay();
    const groups = db.getAllSync<any>(
      `SELECT DISTINCT g.id, g.subject_id as subjectId, g.teacher_id as teacherId
       FROM groups g JOIN group_schedules gs
         ON gs.center_id = g.center_id AND gs.group_id = g.id
       WHERE g.center_id = ? AND g.status = 'active'
         AND gs.day_of_week = ? AND gs.status = 'active'`,
      [centerId, dayOfWeek],
    );

    const expectedForGroup = (groupId: string, subjectId?: string | null, teacherId?: string | null) => {
      const ids = new Set<string>();
      const enrolled = db.getAllSync<any>(
        `SELECT student_id as studentId FROM student_group_enrollments
         WHERE center_id = ? AND group_id = ? AND status = 'active'
           AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
        [centerId, groupId, dateStr, dateStr],
      );
      enrolled.forEach((row: any) => {
        const id = row.studentId ?? row.student_id;
        if (id) ids.add(String(id));
      });
      if (subjectId && teacherId) {
        const packageRows = db.getAllSync<any>(
          `SELECT DISTINCT sps.student_id as studentId
           FROM student_package_subscriptions sps
           JOIN package_subjects ps ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
           LEFT JOIN package_subject_teacher_overrides selected
             ON selected.center_id = sps.center_id AND selected.subscription_id = sps.id AND selected.subject_id = ps.subject_id
           WHERE sps.center_id = ? AND sps.status = 'active'
             AND sps.start_date <= ? AND (sps.end_date IS NULL OR sps.end_date >= ?)
             AND ps.subject_id = ? AND (ps.group_id IS NULL OR ps.group_id = ?)
             AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
             AND (selected.id IS NULL OR selected.group_id IS NULL OR selected.group_id = ?)
             AND (selected.id IS NOT NULL OR NOT EXISTS (
               SELECT 1 FROM package_subject_teacher_overrides any_selection
               WHERE any_selection.center_id = sps.center_id AND any_selection.subscription_id = sps.id
             ))`,
          [centerId, dateStr, dateStr, subjectId, groupId, teacherId, groupId],
        );
        packageRows.forEach((row: any) => {
          const id = row.studentId ?? row.student_id;
          if (id) ids.add(String(id));
        });
      }
      return Array.from(ids);
    };

    let expectedCount = 0;
    let presentCount = 0;
    let lateCount = 0;
    let absentCount = 0;
    let makeupCount = 0;
    let openSessions = 0;
    let closedSessions = 0;

    for (const group of groups) {
      const session = db.getFirstSync<any>(
        `SELECT id, status, subject_id as subjectId, teacher_id as teacherId
         FROM sessions WHERE center_id = ? AND group_id = ? AND session_date = ?
           AND status <> 'cancelled' ORDER BY created_at ASC LIMIT 1`,
        [centerId, group.id, dateStr],
      );
      let expectedIds = session
        ? db.getAllSync<any>(
            `SELECT student_id as studentId FROM session_expected_students
             WHERE center_id = ? AND session_id = ?`,
            [centerId, session.id],
          ).map((row: any) => String(row.studentId ?? row.student_id)).filter(Boolean)
        : [];
      if (!expectedIds.length) expectedIds = expectedForGroup(group.id, session?.subjectId || group.subjectId, session?.teacherId || group.teacherId);
      expectedCount += expectedIds.length;

      // Scheduled sessions are timetable rows only. Absence starts when the
      // operator explicitly opens the session; closing it does not erase data.
      if (!session || (session.status !== "open" && session.status !== "closed")) continue;
      if (session.status === "open") openSessions += 1;
      if (session.status === "closed") closedSessions += 1;
      const attendance = db.getAllSync<any>(
        `SELECT student_id as studentId, status, attendance_type as attendanceType
         FROM attendance WHERE center_id = ? AND session_id = ?`,
        [centerId, session.id],
      );
      const covered = db.getAllSync<any>(
        `SELECT student_id as studentId FROM advance_coverages
         WHERE center_id = ? AND target_future_session_id = ?`,
        [centerId, session.id],
      );
      const counts = calculateSessionAttendanceCounts(expectedIds, attendance, covered.map((row: any) => String(row.studentId)));
      // Makeup is a successful attendance for the daily totals; the separate
      // makeup counter preserves the compensation breakdown.
      presentCount += counts.present;
      lateCount += counts.late;
      absentCount += counts.absent;
      makeupCount += counts.makeup;
    }

    const paymentRows = db.getAllSync<any>(
      `SELECT amount FROM payments WHERE center_id = ?
       AND (payment_date = ? OR (payment_date IS NULL AND created_at LIKE ?))
       AND (is_reversed = 0 OR is_reversed IS NULL)`,
      [centerId, dateStr, `${dateStr}%`],
    );
    const todayCollections = paymentRows.reduce((sum: number, row: any) => sum + (Number(row.amount) || 0), 0);
    return { expectedCount, presentCount, lateCount, absentCount, makeupCount, totalSessions: groups.length, openSessions, closedSessions, todayCollections };
  }
}
