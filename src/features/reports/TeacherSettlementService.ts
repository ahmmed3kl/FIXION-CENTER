import { DatabaseService } from "../../core/database";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { useAuthStore } from "../auth/useAuthStore";

export interface TeacherSettlementFilters { teacherId: string; fromDate: string; toDate: string; groupId?: string; }
export interface TeacherSettlementRow { sessionId: string; sessionDate: string; startTime: string; groupId: string; groupName: string; teacherName: string; amount: number; paymentCount: number; }
export interface TeacherSettlement { teacherId: string; teacherName: string; fromDate: string; toDate: string; totalAmount: number; paymentCount: number; rows: TeacherSettlementRow[]; }

export class TeacherSettlementService {
  private static context() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    if (!PermissionService.hasAnyPermission(currentUser.permissions, ["reports.financial.view", "reports.view", "daily_closing.view"])) throw new ForbiddenError("ليس لديك صلاحية عرض تسوية دخل المدرسين.");
    return { centerId: activeCenterId };
  }

  static getTeachers() { const { centerId } = this.context(); return DatabaseService.getDb().getAllSync<{ id: string; name: string }>("SELECT id, name FROM teachers WHERE center_id = ? AND status = 'active' ORDER BY name", [centerId]); }
  static getGroups(teacherId: string) { const { centerId } = this.context(); return DatabaseService.getDb().getAllSync<{ id: string; name: string }>("SELECT id, name FROM groups WHERE center_id = ? AND teacher_id = ? AND status = 'active' ORDER BY name", [centerId, teacherId]); }

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
      LEFT JOIN payments p ON p.center_id = s.center_id AND p.session_id = s.id
      WHERE s.center_id = ? AND COALESCE(s.teacher_id, g.teacher_id) = ? AND s.session_date >= ? AND s.session_date <= ?
      ${filters.groupId ? "AND s.group_id = ?" : ""}
      GROUP BY s.id, s.session_date, s.start_time, g.id, g.name, t.name ORDER BY s.session_date DESC, s.start_time DESC`,
      filters.groupId ? [centerId, filters.teacherId, filters.fromDate, filters.toDate, filters.groupId] : [centerId, filters.teacherId, filters.fromDate, filters.toDate]);
    return { teacherId: filters.teacherId, teacherName: teacher.name, fromDate: filters.fromDate, toDate: filters.toDate, totalAmount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), paymentCount: rows.reduce((sum, row) => sum + Number(row.paymentCount || 0), 0), rows: rows.map((row) => ({ ...row, amount: Number(row.amount || 0), paymentCount: Number(row.paymentCount || 0) })) };
  }
}
