import { DatabaseService } from "../../core/database";
import { SessionDebtBreakdown } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupScheduleRepository } from "../groups/GroupScheduleRepository";

type PlannedSession = {
  date: string;
  groupId: string;
  price: number;
  sessionId?: string;
  attended: boolean;
  directlyPaid: number;
};

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

/**
 * Calculates the current month's per-session debt view without mutating the
 * existing monthly debt-cycle ledger. This keeps old financial history intact
 * while allowing monthly prepayments and pay-as-you-go payments to be shown
 * against concrete scheduled sessions.
 */
export class SessionDebtService {
  static getCurrentMonthBreakdown(studentId: string, targetDate = isoDate(new Date())): SessionDebtBreakdown {
    const { activeCenterId } = useAuthStore.getState();
    if (!activeCenterId) throw new Error("يجب تحديد السنتر أولاً.");

    const target = new Date(`${targetDate}T12:00:00`);
    const monthStart = new Date(target.getFullYear(), target.getMonth(), 1, 12);
    const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12);
    const periodStart = isoDate(monthStart);
    const periodEnd = isoDate(monthEnd);
    const db = DatabaseService.getDb();
    
    const planned: PlannedSession[] = [];
    const enrollments = db.getAllSync<any>(
      `SELECT id, group_id as groupId, start_date as startDate, end_date as endDate
       FROM student_group_enrollments
       WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [activeCenterId, studentId],
    ).filter((enrollment) => enrollment.startDate <= periodEnd && (!enrollment.endDate || enrollment.endDate >= periodStart));
    for (const enrollment of enrollments) {
      const group = db.getFirstSync<any>(
        `SELECT id, session_price as sessionPrice, monthly_price as monthlyPrice, default_fee as defaultFee
         FROM groups WHERE center_id = ? AND id = ?`,
        [activeCenterId, enrollment.groupId],
      );
      if (!group) continue;
      const schedules = GroupScheduleRepository.getSchedulesForGroup(enrollment.groupId);
      const dates: string[] = [];
      for (let cursor = new Date(monthStart); cursor <= monthEnd; cursor = addDays(cursor, 1)) {
        if (cursor < new Date(`${enrollment.startDate}T12:00:00`)) continue;
        if (enrollment.endDate && cursor > new Date(`${enrollment.endDate}T12:00:00`)) continue;
        if (schedules.some((schedule) => schedule.dayOfWeek === cursor.getDay())) dates.push(isoDate(cursor));
      }
      // Monthly price is spread over this month's actual scheduled meetings;
      // otherwise the configured session price is used directly.
      const perSessionPrice = Number(group.monthlyPrice || 0) > 0
        ? Number(group.monthlyPrice) / Math.max(1, dates.length)
        : Number(group.sessionPrice || group.defaultFee || 0);
      for (const date of dates) {
        const session = db.getFirstSync<any>(
          `SELECT id FROM sessions WHERE center_id = ? AND group_id = ? AND session_date = ? ORDER BY id LIMIT 1`,
          [activeCenterId, enrollment.groupId, date],
        );
        const attendance = session ? db.getFirstSync<any>(
          `SELECT id FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ? AND status IN ('present','late')`,
          [activeCenterId, session.id, studentId],
        ) : null;
        const directPayment = session ? Number(db.getFirstSync<any>(
          `SELECT COALESCE(SUM(amount), 0) as amount FROM payments
           WHERE center_id = ? AND student_id = ? AND session_id = ? AND is_reversed = 0`,
          [activeCenterId, studentId, session.id],
        )?.amount || 0) : 0;
        planned.push({ date, groupId: enrollment.groupId, price: Math.max(0, perSessionPrice), sessionId: session?.id, attended: Boolean(attendance), directlyPaid: directPayment });
      }
    }

    // Package subscriptions use one monthly amount split evenly between the
    // selected subjects. Each subject's share is then spread across the
    // scheduled sessions of the enrolled group(s) for that subject.
    const packageSubscriptions = db.getAllSync<any>(
      `SELECT s.id, s.package_id as packageId, p.price
       FROM student_package_subscriptions s
       JOIN packages p ON p.center_id = s.center_id AND p.id = s.package_id
       WHERE s.center_id = ? AND s.student_id = ? AND s.status = 'active'`,
      [activeCenterId, studentId],
    );
    for (const subscription of packageSubscriptions) {
      const options = db.getAllSync<any>(
        `SELECT ps.subject_id as subjectId,
                COALESCE(o.teacher_id, ps.default_teacher_id) as teacherId
         FROM package_subjects ps
         LEFT JOIN package_subject_teacher_overrides o
           ON o.center_id = ps.center_id AND o.subscription_id = ?
          AND o.subject_id = ps.subject_id
         WHERE ps.center_id = ? AND ps.package_id = ?
         UNION ALL
         SELECT subject_id as subjectId, teacher_id as teacherId
         FROM package_subject_teacher_overrides
         WHERE center_id = ? AND subscription_id = ?
           AND subject_id NOT IN (
             SELECT subject_id FROM package_subjects
             WHERE center_id = ? AND package_id = ?
           )`,
        [subscription.id, activeCenterId, subscription.packageId, activeCenterId, subscription.id, activeCenterId, subscription.packageId],
      );
      if (!options.length) continue;
      const subjectShare = Number(subscription.price || 0) / options.length;
      for (const option of options) {
        const optionItems = planned.filter((item) => {
          const teacher = db.getFirstSync<any>(
            `SELECT teacher_id as teacherId, subject_id as subjectId FROM groups WHERE center_id = ? AND id = ?`,
            [activeCenterId, item.groupId],
          );
          return String(teacher?.teacherId) === String(option.teacherId)
            && (!option.subjectId || String(teacher?.subjectId) === String(option.subjectId));
        });
        if (!optionItems.length) continue;
        const sessionShare = subjectShare / optionItems.length;
        optionItems.forEach((item) => { item.price = sessionShare; });
      }
    }

    planned.sort((a, b) => a.date.localeCompare(b.date) || a.groupId.localeCompare(b.groupId));
    const monthlyPool = Number(db.getFirstSync<any>(
      `SELECT COALESCE(SUM(amount), 0) as amount FROM payments
       WHERE center_id = ? AND student_id = ? AND payment_date >= ? AND payment_date <= ?
         AND payment_type IN ('monthly','partial') AND is_reversed = 0`,
      [activeCenterId, studentId, periodStart, periodEnd],
    )?.amount || 0);

    let pool = monthlyPool;
    let futureUnpaidSessions = 0;
    let futurePaidSessions = 0;
    let attendedPaidSessions = 0;
    let attendedUnpaidSessions = 0;
    let currentDebt = 0;
    let sessionPriceTotal = 0;
    for (const item of planned) {
      sessionPriceTotal += item.price;
      const allocated = Math.min(item.price, item.directlyPaid + Math.max(0, pool));
      pool = Math.max(0, pool - Math.max(0, allocated - item.directlyPaid));
      const fullyPaid = item.price <= 0 || allocated >= item.price;
      if (item.attended) {
        if (fullyPaid) attendedPaidSessions += 1;
        else { attendedUnpaidSessions += 1; currentDebt += Math.max(0, item.price - allocated); }
      } else if (fullyPaid) {
        futurePaidSessions += 1;
      } else {
        futureUnpaidSessions += 1;
      }
    }

    return { periodStart, periodEnd, expectedSessions: planned.length, futureUnpaidSessions, futurePaidSessions, attendedPaidSessions, attendedUnpaidSessions, currentDebt, sessionPriceTotal };
  }
}
