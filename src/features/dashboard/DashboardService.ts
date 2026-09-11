import { DatabaseService } from "../../core/database";
import { UnauthorizedError } from "../../core/errors";
import { useAuthStore } from "../auth/useAuthStore";

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
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) {
      throw new UnauthorizedError("يجب تحديد مركز نشط.");
    }

    const db = DatabaseService.getDb();
    const dateStr = targetDate || new Date().toISOString().split("T")[0];

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

    // 2. Expected students from session_expected_students (Foundation for accurate expected calculations)
    const expectedRows = db.getAllSync<any>(
      `SELECT DISTINCT student_id FROM session_expected_students
       WHERE center_id = ? AND session_id IN (${sessionIds.map(() => "?").join(",")})`,
      [centerId, ...sessionIds],
    );
    const expectedCount = expectedRows.length;

    // 3. Recorded attendance for today's sessions
    const attendanceRows = db.getAllSync<any>(
      `SELECT id, status, is_late, attendance_type FROM attendance
       WHERE center_id = ? AND session_id IN (${sessionIds.map(() => "?").join(",")})`,
      [centerId, ...sessionIds],
    );

    let presentCount = 0;
    let lateCount = 0;
    let makeupCount = 0;

    for (const att of attendanceRows) {
      if (att.attendance_type === "makeup") {
        makeupCount++;
      }
      if (att.is_late === 1 || att.status === "late") {
        lateCount++;
      } else {
        presentCount++;
      }
    }

    // Calculated absent count based on expected students minus those who checked in
    const totalAttended = presentCount + lateCount;
    const absentCount = Math.max(0, expectedCount - totalAttended);

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
