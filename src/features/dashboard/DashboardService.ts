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

export class DashboardService {
  static getTodaySummary(targetDate?: string): DashboardSummary {
    try {
      return this.readTodaySummary(targetDate);
    } catch (error: any) {
      const message = String(error?.message || error || "");
      // Android can keep a stale expo-sqlite native handle after hot reload
      // or a concurrent native transaction. Reopen it once and retry the
      // read instead of crashing the dashboard screen.
      if (message.includes("NativeDatabase.prepareSync") || message.includes("NullPointerException")) {
        DatabaseService.reinitialize();
        return this.readTodaySummary(targetDate);
      }
      throw error;
    }
  }

  private static readTodaySummary(targetDate?: string): DashboardSummary {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) {
      throw new UnauthorizedError("يجب تحديد مركز نشط.");
    }

    const db = DatabaseService.getDb();
    const dateStr = targetDate || getLocalDateOnly();

    // 1. Sessions for today
    const rawSessions = db.getAllSync<any>(
      "SELECT id, group_id as groupId, status, created_at as createdAt FROM sessions WHERE center_id = ? AND session_date = ?",
      [centerId, dateStr],
    );
    // Older app versions could create two records when a closed session was
    // started again. Treat those records as one business session in summary
    // metrics, choosing the record that contains the most attendance rows.
    const sessions = Array.from(
      rawSessions.reduce((map: Map<string, any>, session: any) => {
        // Keep legacy/test rows without a group snapshot independent.
        const key = session.groupId ? `${session.groupId}:${dateStr}` : String(session.id);
        const current = map.get(key);
        if (!current) { map.set(key, session); return map; }
        const currentCount = Number(db.getFirstSync<any>("SELECT COUNT(*) as count FROM attendance WHERE center_id = ? AND session_id = ?", [centerId, current.id])?.count || 0);
        const nextCount = Number(db.getFirstSync<any>("SELECT COUNT(*) as count FROM attendance WHERE center_id = ? AND session_id = ?", [centerId, session.id])?.count || 0);
        if (nextCount > currentCount || (nextCount === currentCount && String(session.createdAt || "") < String(current.createdAt || ""))) map.set(key, session);
        return map;
      }, new Map<string, any>()).values(),
    );

    const totalSessions = sessions.length;
    const openSessions = sessions.filter(
      (s: any) => s.status === "open",
    ).length;
    const closedSessions = sessions.filter(
      (s: any) => s.status === "closed",
    ).length;

    const sessionIds = sessions.map((s: any) => s.id);

    if (sessionIds.length === 0) {
      return {
        expectedCount: 0,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        makeupCount: 0,
        totalSessions: 0,
        openSessions: 0,
        closedSessions: 0,
        todayCollections: 0,
      };
    }

    // Aggregate each session independently. The expected snapshot is the
    // roster authority; makeup rows are never allowed to become regular
    // present rows or to reduce the regular absent count.
    const counts = sessionIds.map((sessionId) => {
      const attendance = db.getAllSync<any>(
        "SELECT student_id as studentId, status, attendance_type as attendanceType FROM attendance WHERE center_id = ? AND session_id = ?",
        [centerId, sessionId],
      );
      let expected = db.getAllSync<any>(
        "SELECT student_id as studentId FROM session_expected_students WHERE center_id = ? AND session_id = ?",
        [centerId, sessionId],
      );
      expected = expected.map((row: any) => ({
        studentId: row.studentId ?? row.student_id,
      })).filter((row: any) => row.studentId);
      // Legacy/synced sessions can arrive before their roster snapshot. Keep
      // the dashboard useful by deriving the same-date roster from active
      // enrollments, and include a regular attendance row as a last-resort
      // signal so a completed scan is never displayed as zero.
      if (expected.length === 0) {
        const session = db.getFirstSync<any>(
          `SELECT group_id as groupId, session_date as sessionDate,
                  COALESCE(subject_id, (SELECT subject_id FROM groups WHERE center_id = ? AND id = group_id)) as subjectId,
                  COALESCE(teacher_id, (SELECT teacher_id FROM groups WHERE center_id = ? AND id = group_id)) as teacherId
             FROM sessions WHERE center_id = ? AND id = ?`,
          [centerId, centerId, centerId, sessionId],
        );
        const enrolled = session
          ? db.getAllSync<any>(
              `SELECT student_id as studentId
               FROM student_group_enrollments
               WHERE center_id = ? AND group_id = ? AND status = 'active'
                 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
              [centerId, session.groupId, session.sessionDate, session.sessionDate],
            )
          : [];
        const ids = new Set<string>(enrolled.map((row) => String(row.studentId ?? row.student_id)));
        if (session) {
          const packageRows = db.getAllSync<any>(
            `SELECT DISTINCT sps.student_id as studentId
               FROM student_package_subscriptions sps
               JOIN package_subjects ps
                 ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
               LEFT JOIN package_subject_teacher_overrides selected
                 ON selected.center_id = sps.center_id
                AND selected.subscription_id = sps.id
                AND selected.subject_id = ps.subject_id
              WHERE sps.center_id = ? AND sps.status = 'active'
                AND sps.start_date <= ? AND (sps.end_date IS NULL OR sps.end_date >= ?)
                AND ps.subject_id = ?
                AND (ps.group_id IS NULL OR ps.group_id = ?)
                AND COALESCE(selected.teacher_id, ps.default_teacher_id) = ?
                AND (
                  selected.id IS NOT NULL
                  OR NOT EXISTS (
                    SELECT 1 FROM package_subject_teacher_overrides any_selection
                    WHERE any_selection.center_id = sps.center_id
                      AND any_selection.subscription_id = sps.id
                  )
                )`,
            [centerId, session.sessionDate, session.sessionDate, session.subjectId, session.groupId, session.teacherId],
          );
          for (const row of packageRows) {
            const studentId = row.studentId ?? row.student_id;
            if (studentId) ids.add(String(studentId));
          }
        }
        for (const row of attendance) {
          const studentId = row.studentId ?? row.student_id;
          if (studentId && row.attendanceType !== "makeup") ids.add(String(studentId));
        }
        expected = Array.from(ids, (studentId) => ({ studentId }));
      }
      const coveredInAdvance = db.getAllSync<{ studentId: string }>(
        "SELECT student_id as studentId FROM advance_coverages WHERE center_id = ? AND target_future_session_id = ?",
        [centerId, sessionId],
      );
      return calculateSessionAttendanceCounts(
        expected.map((row) => row.studentId),
        attendance,
        coveredInAdvance.map((row) => row.studentId),
      );
    });
    const expectedCount = counts.reduce((sum, item) => sum + item.expected, 0);
    const presentCount = counts.reduce((sum, item) => sum + item.present, 0);
    const lateCount = counts.reduce((sum, item) => sum + item.late, 0);
    const absentCount = counts.reduce((sum, item) => sum + item.absent, 0);
    const makeupCount = counts.reduce((sum, item) => sum + item.makeup, 0);

    // 4. Today's collections
    const paymentRows = db.getAllSync<any>(
      `SELECT amount FROM payments
       WHERE center_id = ?
         AND (payment_date = ? OR (payment_date IS NULL AND created_at LIKE ?))
         AND (is_reversed = 0 OR is_reversed IS NULL)`,
      [centerId, dateStr, `${dateStr}%`],
    );
    const todayCollections = paymentRows.reduce(
      (sum: number, p: any) => sum + (Number(p.amount) || 0),
      0,
    );

    return {
      expectedCount,
      presentCount,
      lateCount,
      absentCount,
      makeupCount,
      totalSessions,
      openSessions,
      closedSessions,
      todayCollections,
    };
  }
}
