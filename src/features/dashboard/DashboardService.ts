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
    const sessions = db.getAllSync<any>(
      "SELECT id, status FROM sessions WHERE center_id = ? AND session_date = ?",
      [centerId, dateStr],
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
      // Legacy/synced sessions can arrive before their roster snapshot. Keep
      // the dashboard useful by deriving the same-date roster from active
      // enrollments, and include a regular attendance row as a last-resort
      // signal so a completed scan is never displayed as zero.
      if (expected.length === 0) {
        const session = db.getFirstSync<any>(
          "SELECT group_id as groupId, session_date as sessionDate FROM sessions WHERE center_id = ? AND id = ?",
          [centerId, sessionId],
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
        const ids = new Set<string>(enrolled.map((row) => String(row.studentId)));
        for (const row of attendance) {
          if (row.attendanceType !== "makeup") ids.add(String(row.studentId));
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
      `SELECT amount FROM payments WHERE center_id = ? AND created_at LIKE ?`,
      [centerId, `${dateStr}%`],
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
