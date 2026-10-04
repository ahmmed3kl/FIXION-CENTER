import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { useAuthStore } from "../auth/useAuthStore";

export interface TeacherSettlementFilters { teacherId: string; fromDate: string; toDate: string; groupId?: string; }
export interface TeacherSettlementRow { sessionId: string; sessionDate: string; startTime: string; groupId: string; groupName: string; teacherName: string; amount: number; paymentCount: number; }
export interface TeacherSettlement { teacherId: string; teacherName: string; fromDate: string; toDate: string; totalAmount: number; paymentCount: number; rows: TeacherSettlementRow[]; }

export class TeacherSettlementService {
  private static context() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    const permissions = resolveUserPermissions(currentUser);
    if (!PermissionService.hasAnyPermission(permissions, ["reports.financial.view", "reports.view", "daily_closing.view"])) throw new ForbiddenError("ليس لديك صلاحية عرض تسوية دخل المدرسين.");
    return { centerId: activeCenterId };
  }

  static getTeachers() {
    const { centerId } = this.context();
    return DatabaseService.getDb().getAllSync<{ id: string; name: string }>(
      "SELECT id, name FROM teachers WHERE center_id = ? AND COALESCE(NULLIF(status, ''), 'active') <> 'inactive' ORDER BY name",
      [centerId],
    );
  }

  static getGroups(teacherId: string) {
    const { centerId } = this.context();
    return DatabaseService.getDb().getAllSync<{ id: string; name: string }>(
      `SELECT DISTINCT g.id, g.name
       FROM groups g
       LEFT JOIN sessions s
         ON s.center_id = g.center_id AND s.group_id = g.id AND s.teacher_id = ?
       WHERE g.center_id = ?
         AND COALESCE(NULLIF(g.status, ''), 'active') <> 'inactive'
         AND (g.teacher_id = ? OR s.id IS NOT NULL)
       ORDER BY g.name`,
      [teacherId, centerId, teacherId],
    );
  }

  static getSettlement(filters: TeacherSettlementFilters): TeacherSettlement {
    const { centerId } = this.context();
    const db = DatabaseService.getDb();
    const teacher = db.getFirstSync<{ name: string }>("SELECT name FROM teachers WHERE center_id = ? AND id = ?", [centerId, filters.teacherId]);
    if (!teacher) throw new Error("المدرس غير موجود.");
    const rows = db.getAllSync<any>(`SELECT s.id as sessionId, s.session_date as sessionDate, s.start_time as startTime,
      g.id as groupId, g.name as groupName, t.name as teacherName,
      COALESCE(SUM(CASE WHEN p.is_reversed = 0 THEN p.amount ELSE 0 END), 0) as amount,
      COUNT(CASE WHEN p.is_reversed = 0 THEN p.id END) as paymentCount
      FROM sessions s JOIN groups g ON g.center_id = s.center_id AND g.id = s.group_id
      LEFT JOIN teachers t ON t.center_id = s.center_id AND t.id = COALESCE(s.teacher_id, g.teacher_id)
      LEFT JOIN payments p
        ON p.center_id = s.center_id
       AND (
         p.session_id = s.id
         OR (
           p.session_id IS NULL
           AND p.payment_date = s.session_date
           AND p.payment_type IN ('partial', 'session', 'cash')
           AND NOT EXISTS (
             SELECT 1 FROM debt_cycles package_cycle
             WHERE package_cycle.center_id = p.center_id
               AND package_cycle.id = p.debt_cycle_id
               AND package_cycle.cycle_type = 'package'
           )
           AND EXISTS (
             SELECT 1
             FROM student_group_enrollments payment_enrollment
             WHERE payment_enrollment.center_id = s.center_id
               AND payment_enrollment.student_id = p.student_id
               AND payment_enrollment.group_id = s.group_id
               AND payment_enrollment.status = 'active'
               AND payment_enrollment.start_date <= s.session_date
               AND (payment_enrollment.end_date IS NULL OR payment_enrollment.end_date >= s.session_date)
           )
           -- Legacy payments without session_id cannot be attributed with
           -- certainty when a group has multiple sessions on one date. Pick
           -- one deterministic session instead of counting the same cash in
           -- every session/teacher settlement.
           AND s.id = (
             SELECT s2.id
             FROM sessions s2
             WHERE s2.center_id = s.center_id
               AND s2.group_id = s.group_id
               AND s2.session_date = s.session_date
               AND EXISTS (
                 SELECT 1
                 FROM student_group_enrollments payment_enrollment2
                 WHERE payment_enrollment2.center_id = s2.center_id
                   AND payment_enrollment2.student_id = p.student_id
                   AND payment_enrollment2.group_id = s2.group_id
                   AND payment_enrollment2.status = 'active'
                   AND payment_enrollment2.start_date <= s2.session_date
                   AND (payment_enrollment2.end_date IS NULL OR payment_enrollment2.end_date >= s2.session_date)
               )
             ORDER BY s2.start_time ASC, s2.id ASC
             LIMIT 1
           )
         )
       )
      WHERE s.center_id = ? AND COALESCE(s.teacher_id, g.teacher_id) = ? AND s.session_date >= ? AND s.session_date <= ?
      ${filters.groupId ? "AND s.group_id = ?" : ""}
      GROUP BY s.id, s.session_date, s.start_time, g.id, g.name, t.name ORDER BY s.session_date DESC, s.start_time DESC`,
      filters.groupId ? [centerId, filters.teacherId, filters.fromDate, filters.toDate, filters.groupId] : [centerId, filters.teacherId, filters.fromDate, filters.toDate]);
    // Package payments are made once at any teacher's session. They belong to
    // the package wallet, so attribute their amount proportionally to the
    // selected teacher/group rows for operational settlement only.
    const packageRows = db.getAllSync<any>(
      `SELECT DISTINCT p.id as paymentId, p.payment_date as sessionDate,
              p.amount, g.id as groupId, g.name as groupName,
              t.id as teacherId,
              t.name as teacherName
       FROM payments p
       JOIN debt_cycles dc
         ON dc.center_id = p.center_id AND dc.id = p.debt_cycle_id
        AND dc.cycle_type = 'package'
       JOIN student_package_subscriptions sps
         ON sps.center_id = dc.center_id
        AND sps.id = dc.package_subscription_id
       JOIN package_subjects ps
         ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id
        AND selected.subscription_id = sps.id
        AND selected.subject_id = ps.subject_id
       JOIN groups g
         ON g.center_id = sps.center_id
        AND g.subject_id = ps.subject_id
        AND g.teacher_id = COALESCE(selected.teacher_id, ps.default_teacher_id)
        AND (
          (selected.id IS NOT NULL AND selected.group_id = g.id)
          OR (selected.id IS NULL AND ps.group_id = g.id)
        )
       JOIN teachers t ON t.center_id = g.center_id AND t.id = g.teacher_id
       WHERE p.center_id = ? AND p.is_reversed = 0
         AND p.payment_date >= ? AND p.payment_date <= ?
         AND (selected.id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM package_subject_teacher_overrides any_selection
           WHERE any_selection.center_id = sps.center_id
             AND any_selection.subscription_id = sps.id
         ))`,
      [centerId, filters.fromDate, filters.toDate],
    );
    const packageCountByPayment = new Map<string, number>();
    for (const row of packageRows) packageCountByPayment.set(row.paymentId, (packageCountByPayment.get(row.paymentId) || 0) + 1);
    const normalizedRows = rows.map((row) => ({ ...row, amount: Number(row.amount || 0), paymentCount: Number(row.paymentCount || 0) }));
    const packageSettlementRows = packageRows.map((row) => ({
        sessionId: `package-payment-${row.paymentId}-${row.groupId}`,
        sessionDate: row.sessionDate,
        startTime: "",
        groupId: row.groupId,
        groupName: row.groupName,
        teacherId: row.teacherId,
        teacherName: row.teacherName,
        amount: Number(row.amount || 0) / Math.max(1, packageCountByPayment.get(row.paymentId) || 1),
        paymentCount: 1,
      }));
    const filteredPackageRows = packageSettlementRows.filter((row) => row.teacherId === filters.teacherId && (!filters.groupId || row.groupId === filters.groupId));
    const combinedRows = [...normalizedRows, ...filteredPackageRows].sort((a, b) => String(b.sessionDate).localeCompare(String(a.sessionDate)) || String(b.startTime).localeCompare(String(a.startTime)));
    return { teacherId: filters.teacherId, teacherName: teacher.name, fromDate: filters.fromDate, toDate: filters.toDate, totalAmount: combinedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), paymentCount: combinedRows.reduce((sum, row) => sum + Number(row.paymentCount || 0), 0), rows: combinedRows };
  }
}
