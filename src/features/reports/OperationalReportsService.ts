import { DatabaseService } from "../../core/database";
import {
    ForbiddenError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import {
    DailyAttendanceReport,
    StudentAttendanceReport,
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { FinancialCalculationService } from "../payments/FinancialCalculationService";
import { calculateSessionAttendanceCounts } from "../attendance/AttendanceCalculations";
import { getLocalDateOnly } from "../../shared/utils/date";

export class OperationalReportsService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return {
      centerId: activeCenterId,
      user: { ...currentUser, permissions: resolveUserPermissions(currentUser) },
    };
  }

  /**
   * Report A: Daily Attendance Report
   * Returns per-session attendance stats for a given date.
   */
  static getDailyAttendanceReport(dateStr: string): DailyAttendanceReport {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasAnyPermission(user.permissions, [
        "reports.attendance.view",
        "reports.view",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تقارير الحضور.");
    }
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new ValidationError("صيغة التاريخ غير صحيحة.");
    }

    const db = DatabaseService.getDb();

    const loadedSessions = db.getAllSync<any>(
      `SELECT s.id, s.group_id, s.session_date, s.status, s.start_time, s.end_time,
              g.name as group_name, subj.name as subject_name, t.name as teacher_name
       FROM sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN teachers t ON COALESCE(s.teacher_id, g.teacher_id) = t.id
       WHERE s.center_id = ? AND s.session_date = ? AND s.status <> 'cancelled'
       ORDER BY s.start_time ASC`,
      [centerId, dateStr],
    );
    const today = getLocalDateOnly();
    const currentTime = new Date().toTimeString().slice(0, 5);
    // A session is not an absence report until it has ended. Future and
    // cancelled sessions remain schedule data, not missed attendance.
    const attendedSessionIds = new Set(
      db.getAllSync<any>(
        `SELECT DISTINCT session_id FROM attendance WHERE center_id = ?`,
        [centerId],
      ).map((row: any) => String(row.session_id ?? row.sessionId)),
    );
    const sessions = loadedSessions.filter(
      (session: any) =>
        dateStr < today ||
        (dateStr === today &&
          (String(session.start_time || "") <= currentTime || attendedSessionIds.has(String(session.id)))),
    );

    const sessionReport = sessions.map((s: any) => {
      let expected = db.getAllSync<any>(
        `SELECT student_id FROM session_expected_students WHERE center_id = ? AND session_id = ?`,
        [centerId, s.id],
      );
      const attendanceRows = db.getAllSync<any>(
        `SELECT student_id as studentId, status, attendance_type as attendanceType FROM attendance WHERE center_id = ? AND session_id = ?`,
        [centerId, s.id],
      ).map((row: any) => ({
        ...row,
        studentId: row.studentId ?? row.student_id,
        attendanceType: row.attendanceType ?? row.attendance_type,
      }));
      const coveredInAdvance = db.getAllSync<{ studentId: string }>(
        `SELECT student_id as studentId FROM advance_coverages WHERE center_id = ? AND target_future_session_id = ?`,
        [centerId, s.id],
      );

      if (expected.length === 0) {
        const enrolled = db.getAllSync<any>(
          `SELECT student_id
           FROM student_group_enrollments
           WHERE center_id = ? AND group_id = ? AND status = 'active'
             AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
          [centerId, s.group_id, s.session_date || dateStr, s.session_date || dateStr],
        );
        const ids = new Set<string>(enrolled.map((row) => String(row.student_id)));
        for (const row of attendanceRows) {
          if (row.attendanceType !== "makeup") ids.add(String(row.studentId));
        }
        expected = Array.from(ids, (studentId) => ({ studentId }));
      }

      const counts = calculateSessionAttendanceCounts(
        expected.map((row: any) => row.studentId ?? row.student_id).filter(Boolean),
        attendanceRows,
        coveredInAdvance.map((row) => row.studentId),
      );
      const expectedCount = counts.expected;
      const presentCount = counts.present;
      const lateCount = counts.late;
      const makeupCount = counts.makeup;
      const absentCount = counts.absent;
      const attendanceRate =
        expectedCount > 0
          ? Math.round((presentCount / expectedCount) * 100)
          : 0;

      return {
        sessionId: s.id,
        groupName: s.group_name || "",
        subjectName: s.subject_name || "",
        teacherName: s.teacher_name || "",
        startTime: s.start_time,
        endTime: s.end_time,
        status: s.status,
        expectedCount,
        presentCount,
        absentCount,
        lateCount,
        makeupCount,
        attendanceRate,
      };
    });

    const totals = {
      totalSessions: sessionReport.length,
      totalExpected: sessionReport.reduce((sum, s) => sum + s.expectedCount, 0),
      totalPresent: sessionReport.reduce((sum, s) => sum + s.presentCount, 0),
      totalAbsent: sessionReport.reduce((sum, s) => sum + s.absentCount, 0),
      attendanceRate:
        sessionReport.reduce((sum, s) => sum + s.expectedCount, 0) > 0
          ? Math.round(
              (sessionReport.reduce((sum, s) => sum + s.presentCount, 0) /
                sessionReport.reduce((sum, s) => sum + s.expectedCount, 0)) *
                100,
            )
          : 0,
    };

    return {
      date: dateStr,
      centerId,
      sessions: sessionReport,
      totals,
    };
  }

  /**
   * Report B: Student Attendance Report
   * Returns per-session attendance status for a student over a date range.
   */
  static getStudentAttendanceReport(
    studentId: string,
    fromDate: string,
    toDate: string,
  ): StudentAttendanceReport {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasAnyPermission(user.permissions, [
        "reports.attendance.view",
        "reports.view",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تقارير الحضور.");
    }
    if (!fromDate || !toDate || fromDate > toDate) {
      throw new ValidationError("نطاق التاريخ غير صحيح.");
    }

    const db = DatabaseService.getDb();

    const studentRow = db.getFirstSync<any>(
      `SELECT full_name FROM students WHERE center_id = ? AND id = ?`,
      [centerId, studentId],
    );

    // Get all sessions in range where the student was expected. The expected
    // snapshot is preferred, but legacy sessions may not have one; an actual
    // attendance row or a valid enrollment on the session date must still
    // keep the session visible in the report.
    const sessions = db.getAllSync<any>(
      `SELECT DISTINCT s.id, s.session_date, s.start_time, s.end_time,
              g.name as group_name, subj.name as subject_name
       FROM sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN session_expected_students ses
         ON ses.center_id = s.center_id AND ses.session_id = s.id AND ses.student_id = ?
       LEFT JOIN student_group_enrollments enr
         ON enr.center_id = s.center_id AND enr.group_id = s.group_id
        AND enr.student_id = ? AND enr.status = 'active'
        AND enr.start_date <= s.session_date
        AND (enr.end_date IS NULL OR enr.end_date >= s.session_date)
       WHERE s.center_id = ? AND s.session_date >= ? AND s.session_date <= ?
         AND (
           ses.student_id IS NOT NULL
           OR enr.id IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM attendance attended
             WHERE attended.center_id = s.center_id
               AND attended.session_id = s.id
               AND attended.student_id = ?
           )
         )
       ORDER BY s.session_date ASC`,
      [studentId, studentId, centerId, fromDate, toDate, studentId],
    );

    const attendanceMap = new Map<string, any>();
    const allAttendance = db.getAllSync<any>(
      `SELECT session_id, status, attendance_type, check_in_time, is_external
       FROM attendance
       WHERE center_id = ? AND student_id = ?`,
      [centerId, studentId],
    );
    for (const a of allAttendance) {
      attendanceMap.set(a.session_id, a);
    }

    const sessionDetails = sessions.map((s: any) => {
      const att = attendanceMap.get(s.id);
      let status: "present" | "late" | "absent" | "makeup" | "not_expected" =
        "absent";
      if (att) {
        if (att.attendance_type === "makeup") status = "makeup";
        else if (att.status === "late") status = "late";
        else status = "present";
      }
      return {
        sessionId: s.id,
        sessionDate: s.session_date,
        groupName: s.group_name || "",
        subjectName: s.subject_name || "",
        status,
        checkInTime: att?.check_in_time,
        isExternal: att?.is_external === 1 || att?.is_external === true,
      };
    });

    const presentCount = sessionDetails.filter(
      (s) => s.status === "present" || s.status === "late",
    ).length;
    const lateCount = sessionDetails.filter((s) => s.status === "late").length;
    const absentCount = sessionDetails.filter(
      (s) => s.status === "absent",
    ).length;
    const makeupCount = sessionDetails.filter(
      (s) => s.status === "makeup",
    ).length;
    const total = sessionDetails.length;
    const attendanceRate =
      total > 0 ? Math.round((presentCount / total) * 100) : 0;

    return {
      studentId,
      studentName: studentRow?.full_name || "",
      centerId,
      fromDate,
      toDate,
      sessions: sessionDetails,
      totals: {
        totalSessions: total,
        presentCount,
        lateCount,
        absentCount,
        makeupCount,
        attendanceRate,
      },
    };
  }

  /**
   * Report C: Daily Cash Report
   * Returns payment breakdown for a business date.
   * Does NOT introduce a second financial calculation engine — reads raw payments directly.
   */
  static getDailyCashReport(businessDate: string): {
    businessDate: string;
    centerId: string;
    totalCash: number;
    monthlyTotal: number;
    partialTotal: number;
    sessionTotal: number;
    externalMakeupTotal: number;
    packageTotal: number;
    paymentCount: number;
    payments: {
      id: string;
      studentId: string;
      amount: number;
      paymentType: string;
      paymentMethod: string;
      sessionId?: string | null;
    }[];
  } {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasAnyPermission(user.permissions, [
        "reports.financial.view",
        "reports.view",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض التقارير المالية.");
    }
    if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new ValidationError("صيغة التاريخ غير صحيحة.");
    }

    const db = DatabaseService.getDb();

    const allPaymentsForDate = db.getAllSync<any>(
      `SELECT id, student_id, amount, payment_type, payment_method, session_id, is_reversed, created_at, payment_date
       FROM payments
       WHERE center_id = ? AND (payment_date = ? OR (payment_date IS NULL AND created_at LIKE ?))
         AND (is_reversed = 0 OR is_reversed IS NULL)`,
      [centerId, businessDate, `${businessDate}%`],
    );

    // Deduplicate by ID
    const seen = new Set<string>();
    const activePayments = allPaymentsForDate.filter((p: any) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    let monthlyTotal = 0;
    let partialTotal = 0;
    let sessionTotal = 0;
    let externalMakeupTotal = 0;
    let packageTotal = 0;

    const extAttRows = db.getAllSync<any>(
      `SELECT student_id, session_id FROM attendance WHERE center_id = ? AND is_external = 1`,
      [centerId],
    );
    const extAttSet = new Set(
      extAttRows.map((r: any) => `${r.student_id}-${r.session_id}`),
    );

    for (const p of activePayments) {
      const amount = Number(p.amount) || 0;
      const pType = p.payment_type === "cash" ? "session" : p.payment_type;
      if (pType === "monthly" || pType === "full") monthlyTotal += amount;
      else if (pType === "partial") partialTotal += amount;
      else if (pType === "session") {
        const isExternal =
          (p.notes && p.notes.includes("خارجي")) ||
          (p.session_id && extAttSet.has(`${p.student_id}-${p.session_id}`));
        if (isExternal) externalMakeupTotal += amount;
        else sessionTotal += amount;
      } else if (pType === "package") packageTotal += amount;
    }

    const totalCash =
      monthlyTotal +
      partialTotal +
      sessionTotal +
      externalMakeupTotal +
      packageTotal;

    return {
      businessDate,
      centerId,
      totalCash,
      monthlyTotal,
      partialTotal,
      sessionTotal,
      externalMakeupTotal,
      packageTotal,
      paymentCount: activePayments.length,
      payments: activePayments.map((p: any) => ({
        id: p.id,
        studentId: p.student_id,
        amount: Number(p.amount) || 0,
        paymentType: p.payment_type === "cash" ? "session" : p.payment_type,
        paymentMethod: p.payment_method || "cash",
        sessionId: p.session_id || null,
      })),
    };
  }

  /**
   * Report D: Student Financial Summary
   * Uses the existing FinancialCalculationService — no second engine.
   */
  static getStudentFinancialSummary(studentId: string) {
    const { user } = this.getActiveContext();
    if (
      !PermissionService.hasAnyPermission(user.permissions, [
        "reports.financial.view",
        "reports.view",
        "payments.view",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض التقارير المالية.");
    }
    return FinancialCalculationService.getStudentFinancialStatus(studentId);
  }
}
