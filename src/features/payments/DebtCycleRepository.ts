import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { DebtCycle } from "../../shared/types";
import { getLocalDateOnly } from "../../shared/utils/date";
import { useAuthStore } from "../auth/useAuthStore";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Billing is monthly, not every 28 days.
 *
 * A fixed 28-day period drifts two or three days earlier every calendar
 * month (for example: 1 Sep -> 29 Sep -> 27 Oct).  That makes a student
 * appear due in the middle of the month after a few cycles.  We therefore
 * keep the original billing day as an anchor and advance by calendar months.
 */
export const BILLING_CYCLE_MONTHS = 1;

/**
 * Normalizes both SQLite DATE values and ISO timestamps to YYYY-MM-DD.
 * Old/bootstrap data can contain timestamps or malformed/empty dates; those
 * must never be passed to Date#toISOString because that throws a RangeError.
 */
function normalizeDateOnly(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function addDays(dateOnly: string, days: number): string {
  const normalized = normalizeDateOnly(dateOnly);
  if (!normalized || !Number.isFinite(days)) return normalized || "";

  const [year, month, day] = normalized.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : normalized;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Advance by calendar months while preserving the original billing day. */
function addCalendarMonths(
  dateOnly: string,
  months: number,
  anchorDay?: number,
): string {
  const normalized = normalizeDateOnly(dateOnly);
  if (!normalized || !Number.isFinite(months)) return normalized || "";

  const [year, month, day] = normalized.split("-").map(Number);
  const anchor = Math.max(1, Math.min(31, anchorDay ?? day));
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12 + 1;
  const targetDay = Math.min(anchor, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/**
 * Public helper retained for callers/tests.  For dates such as Jan 31 the
 * caller that needs a stable Jan-31 anchor should pass anchorDay=31.
 */
export function getNextCycleStartDate(
  currentStartDate: string,
  anchorDay?: number,
): string {
  return addCalendarMonths(currentStartDate, BILLING_CYCLE_MONTHS, anchorDay);
}

export function getCycleEndDate(nextCycleStartDate: string): string {
  return addDays(nextCycleStartDate, -1);
}

function getCycleStartForNumber(firstStartDate: string, cycleNumber: number): string {
  const first = normalizeDateOnly(firstStartDate);
  if (!first || !Number.isFinite(cycleNumber) || cycleNumber < 1) return "";
  const anchorDay = Number(first.slice(8, 10));
  return addCalendarMonths(first, cycleNumber - 1, anchorDay);
}

export class DebtCycleRepository {
  /**
   * Creates the current cycle when a center starts using the app mid-term.
   *
   * This is intentionally a normal debt cycle (rather than a mutable balance
   * column), so all existing calculation, payment, reversal and reporting
   * code continues to work. The caller can then record any amount already
   * paid against this cycle as an ordinary payment event.
   */
  static async createOpeningCycle(params: {
    studentId: string;
    enrollmentId?: string;
    packageSubscriptionId?: string;
    packageId?: string;
    groupId?: string;
    cycleType: "monthly" | "package" | "per_session";
    cycleNumber?: number;
    periodStart: string;
    periodEnd: string;
    amountDue: number;
    notes?: string;
  }): Promise<DebtCycle> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.adjust")) {
      throw new ForbiddenError("ليس لديك صلاحية ترحيل الرصيد الافتتاحي.");
    }
    const start = normalizeDateOnly(params.periodStart);
    const end = normalizeDateOnly(params.periodEnd);
    const amount = Number(params.amountDue);
    if (!start || !end || end < start) throw new Error("فترة الاشتراك غير صحيحة.");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("قيمة المديونية غير صحيحة.");
    if (!params.enrollmentId && !params.packageSubscriptionId) {
      throw new Error("يجب اختيار اشتراك مجموعة أو اشتراك باقة.");
    }
    const db = DatabaseService.getDb();
    const ownerId = params.enrollmentId || params.packageSubscriptionId!;
    const cycleNumber = Math.max(1, Number(params.cycleNumber || 1));
    const duplicate = db.getFirstSync<{ id: string }>(
      `SELECT id FROM debt_cycles
       WHERE center_id = ? AND COALESCE(enrollment_id, package_subscription_id) = ? AND cycle_number = ?`,
      [centerId, ownerId, cycleNumber],
    );
    if (duplicate) throw new Error("يوجد رصيد افتتاحي مسجل لهذا الاشتراك بالفعل.");

    const now = new Date().toISOString();
    const cycleId = `dc-${generateUUID()}`;
    const operationId = `op-dc-opening-${generateUUID()}`;
    // SQLite's legacy schema requires enrollment_id. For package cycles the
    // subscription id is retained locally; the server sync layer already
    // normalizes this relation to NULL when no matching enrollment exists.
    const localEnrollmentId = params.enrollmentId || params.packageSubscriptionId!;
    const cycle: DebtCycle = {
      id: cycleId,
      centerId,
      studentId: params.studentId,
      enrollmentId: localEnrollmentId,
      groupId: params.groupId || params.packageId,
      packageSubscriptionId: params.packageSubscriptionId,
      packageId: params.packageId,
      cycleType: params.cycleType,
      billingMode: params.cycleType === "package" ? "package" : params.cycleType === "per_session" ? "per_session" : "monthly",
      cycleNumber,
      startDate: start,
      endDate: end,
      cyclePrice: amount,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    db.runSync(
      `INSERT INTO debt_cycles
       (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, package_subscription_id, package_id, cycle_type, billing_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      [cycleId, centerId, params.studentId, localEnrollmentId, cycle.groupId || null, cycleNumber, start, end, amount, params.packageSubscriptionId || null, params.packageId || null, params.cycleType, cycle.billingMode, now, now],
    );
    const deviceId = DeviceService.getDeviceIdSync();
    SyncRepository.enqueueOperation({
      centerId, userId: user.id, deviceId, operationType: "debt_cycle.create", entityType: "debt_cycle", entityId: cycleId, operationId,
      payload: { ...cycle, operationId, notes: params.notes || "opening_balance" },
    });
    AuditService.recordEvent({
      operationId, centerId, userId: user.id, deviceId, entityType: "debt_cycle", entityId: cycleId,
      action: "debt_cycle.opening_balance", payload: { ...params, cycleId, cycleNumber, periodStart: start, periodEnd: end, amountDue: amount },
    });
    return cycle;
  }

  private static getFirstScheduledDate(groupId: string, startDate: string): string {
    const normalizedStartDate = normalizeDateOnly(startDate);
    if (!normalizedStartDate) return "";
    const { activeCenterId } = useAuthStore.getState();
    const db = DatabaseService.getDb();
    const schedules = db.getAllSync<{ dayOfWeek: number }>(
      `SELECT day_of_week as dayOfWeek FROM group_schedules
       WHERE center_id = ? AND group_id = ? AND status = 'active'`,
      [activeCenterId, groupId],
    );
    if (!schedules.length) return normalizedStartDate;
    const start = new Date(`${normalizedStartDate}T12:00:00`);
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = new Date(start);
      candidate.setDate(start.getDate() + offset);
      if (schedules.some((schedule) => schedule.dayOfWeek === candidate.getDay())) {
        return candidate.toISOString().slice(0, 10);
      }
    }
    return normalizedStartDate;
  }

  /**
   * Package subscriptions are financially effective from the first real
   * class the student can attend, not from the day the package was entered.
   * A package may contain several groups, so use the earliest scheduled class
   * among the selected package options.  Older package rows may not have a
   * group attached; in that case the subscription start date remains the
   * safe backwards-compatible fallback.
   */
  private static getFirstPackageScheduledDate(
    subscriptionId: string,
    packageId: string,
    startDate: string,
  ): string {
    const normalizedStartDate = normalizeDateOnly(startDate);
    if (!normalizedStartDate) return "";

    const { activeCenterId } = useAuthStore.getState();
    const db = DatabaseService.getDb();
    const packageSubjects = db.getAllSync<{
      subjectId: string;
      groupId?: string | null;
    }>(
      `SELECT subject_id as subjectId, group_id as groupId
       FROM package_subjects
       WHERE center_id = ? AND package_id = ?`,
      [activeCenterId, packageId],
    );

    // Overrides are created for the options selected on this subscription.
    // Restricting to them prevents an unselected package group from moving
    // the billing start date earlier than the student's actual first class.
    const selectedSubjects = new Set(
      db
        .getAllSync<{ subjectId: string }>(
          `SELECT DISTINCT subject_id as subjectId
           FROM package_subject_teacher_overrides
           WHERE center_id = ? AND subscription_id = ?`,
          [activeCenterId, subscriptionId],
        )
        .map((row) => row.subjectId),
    );
    const selectedPackageSubjects = selectedSubjects.size
      ? packageSubjects.filter((row) => selectedSubjects.has(row.subjectId))
      : packageSubjects;
    const groupIds = Array.from(
      new Set(
        selectedPackageSubjects
          .map((row) => row.groupId)
          .filter((groupId): groupId is string => Boolean(groupId)),
      ),
    );
    const candidates: string[] = [];

    // Student assignment stores the concrete group chosen for each package
    // option as a normal enrollment.  Use that relationship when the package
    // definition itself has no group_id (the normal, reusable package case).
    // This keeps billing anchored to the first real class instead of the day
    // the administrator created the subscription.
    if (groupIds.length === 0) {
      const selectedEnrollments = db.getAllSync<{ groupId: string; startDate: string }>(
        `SELECT DISTINCT e.group_id as groupId, e.start_date as startDate
         FROM student_package_subscriptions sps
         JOIN student_group_enrollments e
           ON e.center_id = sps.center_id AND e.student_id = sps.student_id
          AND e.status = 'active'
         JOIN groups g
           ON g.center_id = e.center_id AND g.id = e.group_id
         JOIN package_subjects ps
           ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
          AND ps.subject_id = g.subject_id
         LEFT JOIN package_subject_teacher_overrides selected
           ON selected.center_id = sps.center_id
          AND selected.subscription_id = sps.id
          AND selected.subject_id = ps.subject_id
         WHERE sps.center_id = ? AND sps.id = ?
           AND (selected.id IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = sps.center_id
               AND any_selection.subscription_id = sps.id
           ))
           AND g.teacher_id = COALESCE(selected.teacher_id, ps.default_teacher_id)
           AND (selected.group_id IS NULL OR selected.group_id = e.group_id)`,
        [activeCenterId, subscriptionId],
      );
      for (const row of selectedEnrollments) {
        // A legacy enrollment can predate this package subscription.  The
        // package must never start billing before the subscription was
        // created, so clamp the candidate to the subscription start date.
        const enrollmentStart = normalizeDateOnly(row.startDate) || normalizedStartDate;
        const start = enrollmentStart < normalizedStartDate ? normalizedStartDate : enrollmentStart;
        candidates.push(this.getFirstScheduledDate(row.groupId, start));
      }
    }

    for (const groupId of groupIds) {
      // A group without an active schedule has no "actual class" to anchor
      // to, so ignore it when another package group has a real schedule.
      const hasSchedule = db.getFirstSync<{ id: string }>(
        `SELECT id FROM group_schedules
         WHERE center_id = ? AND group_id = ? AND status = 'active'
         LIMIT 1`,
        [activeCenterId, groupId],
      );
      if (hasSchedule) {
        candidates.push(this.getFirstScheduledDate(groupId, normalizedStartDate));
      }
    }

    return candidates.sort()[0] || normalizedStartDate;
  }
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Retrieves all debt cycles for a student in the active center.
   */
  static getCyclesForStudent(studentId: string): DebtCycle[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DebtCycle>(
      `SELECT c.id, c.center_id as centerId, c.student_id as studentId,
              c.enrollment_id as enrollmentId, c.group_id as groupId,
              c.cycle_number as cycleNumber, c.start_date as startDate,
              c.end_date as endDate, c.cycle_price as cyclePrice,
              c.status, c.created_at as createdAt, c.updated_at as updatedAt,
              c.package_subscription_id as packageSubscriptionId,
              c.package_id as packageId,
              c.cycle_type as cycleType,
              c.billing_mode as billingMode,
              c.server_revision as serverRevision,
              p.name as packageName,
              COALESCE(p.name, g.name) as groupName
       FROM debt_cycles c
       LEFT JOIN groups g ON c.group_id = g.id
       LEFT JOIN packages p ON c.package_id = p.id
       WHERE c.center_id = ? AND c.student_id = ?
       ORDER BY c.start_date ASC, c.cycle_number ASC`,
      [centerId, studentId],
    );
  }

  /**
   * Retrieves all debt cycles for a specific enrollment.
   */
  static getCyclesForEnrollment(enrollmentId: string): DebtCycle[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DebtCycle>(
      `SELECT c.id, c.center_id as centerId, c.student_id as studentId,
              c.enrollment_id as enrollmentId, c.group_id as groupId,
              c.cycle_number as cycleNumber, c.start_date as startDate,
              c.end_date as endDate, c.cycle_price as cyclePrice,
              c.status, c.created_at as createdAt, c.updated_at as updatedAt,
              c.package_subscription_id as packageSubscriptionId,
              c.package_id as packageId,
              c.cycle_type as cycleType,
              c.billing_mode as billingMode,
              c.server_revision as serverRevision,
              g.name as groupName
       FROM debt_cycles c
       LEFT JOIN groups g ON c.group_id = g.id
       WHERE c.center_id = ? AND c.enrollment_id = ?
       ORDER BY c.cycle_number ASC`,
      [centerId, enrollmentId],
    );
  }

  /**
   * Retrieves all debt cycles for a package subscription.
   */
  static getCyclesForPackageSubscription(subscriptionId: string): DebtCycle[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<DebtCycle>(
      `SELECT c.id, c.center_id as centerId, c.student_id as studentId,
              c.enrollment_id as enrollmentId, c.group_id as groupId,
              c.cycle_number as cycleNumber, c.start_date as startDate,
              c.end_date as endDate, c.cycle_price as cyclePrice,
              c.status, c.created_at as createdAt, c.updated_at as updatedAt,
              c.package_subscription_id as packageSubscriptionId,
              c.package_id as packageId,
              c.cycle_type as cycleType,
              c.billing_mode as billingMode,
              c.server_revision as serverRevision,
              p.name as packageName,
              p.name as groupName
       FROM debt_cycles c
       LEFT JOIN packages p ON c.package_id = p.id
       WHERE c.center_id = ? AND c.package_subscription_id = ?
       ORDER BY c.cycle_number ASC`,
      [centerId, subscriptionId],
    );
  }

  /**
   * Retrieves a single debt cycle by ID.
   */
  static getCycleById(cycleId: string): DebtCycle | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض البيانات المالية.");
    }
    const db = DatabaseService.getDb();
    return db.getFirstSync<DebtCycle>(
      `SELECT c.id, c.center_id as centerId, c.student_id as studentId,
              c.enrollment_id as enrollmentId, c.group_id as groupId,
              c.cycle_number as cycleNumber, c.start_date as startDate,
              c.end_date as endDate, c.cycle_price as cyclePrice,
              c.status, c.created_at as createdAt, c.updated_at as updatedAt,
              c.package_subscription_id as packageSubscriptionId,
              c.package_id as packageId,
              c.cycle_type as cycleType,
              c.billing_mode as billingMode,
              c.server_revision as serverRevision,
              p.name as packageName,
              COALESCE(p.name, g.name) as groupName
       FROM debt_cycles c
       LEFT JOIN groups g ON c.group_id = g.id
       LEFT JOIN packages p ON c.package_id = p.id
       WHERE c.center_id = ? AND c.id = ?`,
      [centerId, cycleId],
    );
  }

  /**
   * Generates debt cycles for an enrollment up to targetDate.
   * - The first period starts on the first scheduled group class on/after
   *   enrollment.startDate, so booking early does not start the debt clock.
   * - Every period is one calendar month anchored to the first billing day.
   *   This prevents the due date from drifting earlier by 2-3 days each month.
   * - Strict enrollment end date bounding: never generates cycles starting after enrollment.endDate.
   * - Inactive / ended enrollments cannot generate new cycles.
   * - Snapshots cycle_price at creation time; changing group prices later only affects future cycles.
   */
  static generateCyclesForEnrollment(
    enrollmentId: string,
    targetDate?: string,
  ): DebtCycle[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "payments.view") &&
      !PermissionService.hasPermission(user.permissions, "payments.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إدارة الدورات المالية.");
    }
    const db = DatabaseService.getDb();

    // 1. Fetch enrollment
    const enrollment = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, group_id as groupId,
              start_date as startDate, end_date as endDate, status,
              special_monthly_price as specialMonthlyPrice
       FROM student_group_enrollments
       WHERE center_id = ? AND id = ?`,
      [centerId, enrollmentId],
    );

    if (!enrollment) {
      throw new NotFoundError("سجل التسجيل غير موجود.");
    }

    // Existing cycles for this enrollment
    let existingCycles = this.getCyclesForEnrollment(enrollmentId);

    // Package-selected group enrollments are attendance/reporting records,
    // not a second monthly billing ledger. A package has exactly one debt
    // cycle for its full price, so suppress group cycles covered by the
    // active package (including cycles created by older app versions).
    const packageCoverage = db.getFirstSync<any>(
      `SELECT sps.id as subscriptionId, sps.start_date as packageStartDate
       FROM student_package_subscriptions sps
       JOIN package_subjects ps
         ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
       JOIN groups covered_group
         ON covered_group.center_id = sps.center_id AND covered_group.id = ?
       LEFT JOIN package_subject_teacher_overrides selected
         ON selected.center_id = sps.center_id
        AND selected.subscription_id = sps.id
        AND selected.subject_id = ps.subject_id
       WHERE sps.center_id = ? AND sps.student_id = ? AND sps.status = 'active'
         AND ps.subject_id = covered_group.subject_id
         AND (ps.group_id = covered_group.id OR selected.group_id = covered_group.id)
         AND COALESCE(selected.teacher_id, ps.default_teacher_id) = covered_group.teacher_id
         AND (selected.id IS NULL OR selected.group_id = covered_group.id)
         AND (selected.id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM package_subject_teacher_overrides any_selection
           WHERE any_selection.center_id = sps.center_id AND any_selection.subscription_id = sps.id
         ))
       ORDER BY sps.start_date DESC LIMIT 1`,
      [enrollment.groupId, centerId, enrollment.studentId],
    );
    if (packageCoverage) {
      const packageStart = normalizeDateOnly(packageCoverage.packageStartDate) || "";
      const now = new Date().toISOString();
      const deviceId = DeviceService.getDeviceIdSync();
      for (const cycle of existingCycles.filter((item) =>
        (item.status === "open" || item.status === "partial") &&
        (!packageStart || (normalizeDateOnly(item.startDate) || "") >= packageStart),
      )) {
        const paidSum = db.getFirstSync<{ paid: number }>(
          `SELECT COALESCE(SUM(amount), 0) as paid FROM payments
            WHERE center_id = ? AND debt_cycle_id = ?
              AND (is_reversed = 0 OR is_reversed IS NULL)`,
          [centerId, cycle.id],
        );
        const retainedCyclePrice = Math.max(0, Number(paidSum?.paid || 0));
        // Package coverage suppresses the duplicate group obligation, but it
        // must not hide a payment already linked to that legacy cycle.
        db.runSync(`UPDATE debt_cycles SET cycle_price = ?, status = 'cancelled', updated_at = ? WHERE center_id = ? AND id = ?`, [retainedCyclePrice, now, centerId, cycle.id]);
        SyncRepository.enqueueOperation({
          operationId: `op-dc-package-suppress-${generateUUID()}`,
          centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "debt_cycle", entityId: cycle.id,
          payload: { ...cycle, cyclePrice: retainedCyclePrice, status: "cancelled", expectedRevision: Number(cycle.serverRevision || 0), updatedAt: now },
        });
      }
      existingCycles = this.getCyclesForEnrollment(enrollmentId);
      return existingCycles;
    }

    // Cancelled / inactive / ended enrollments cannot generate new cycles
    if (enrollment.status !== "active") {
      return existingCycles;
    }

    const cutoffDate = normalizeDateOnly(targetDate) || getLocalDateOnly();
    const enrollmentStartDate = normalizeDateOnly(enrollment.startDate);
    const enrollmentEndDate = normalizeDateOnly(enrollment.endDate);
    // A malformed legacy enrollment must not crash the student details screen.
    // Leave its existing cycles visible and wait for a repaired date to create
    // any new cycle.
    if (!enrollmentStartDate) return existingCycles;
    const deviceId = DeviceService.getDeviceIdSync();

    let nextStart: string;
    let nextCycleNum: number;
    let firstCycleStart: string;

    if (existingCycles.length === 0) {
      // A new enrollment starts financially on the first actual scheduled
      // class on/after the enrollment date, never before the student can attend.
      nextStart = this.getFirstScheduledDate(enrollment.groupId, enrollmentStartDate);
      nextCycleNum = 1;
      firstCycleStart = nextStart;
    } else {
      const lastCycle = existingCycles[existingCycles.length - 1];
      firstCycleStart = normalizeDateOnly(existingCycles[0].startDate) || "";
      if (!firstCycleStart) return existingCycles;
      const lastEndDate = normalizeDateOnly(lastCycle.endDate);
      const lastStartDate = normalizeDateOnly(lastCycle.startDate);
      if (!lastEndDate && !lastStartDate) return existingCycles;
      nextCycleNum = lastCycle.cycleNumber + 1;
      // Use the anchored calendar date for the next cycle.  If older data
      // used 28-day periods, skip forward until the new cycle is strictly
      // after the last stored period so historical rows are never changed or
      // overlapped.
      nextStart = getCycleStartForNumber(firstCycleStart, nextCycleNum);
      const lastStoredBoundary = lastEndDate || lastStartDate || "";
      while (lastStoredBoundary && nextStart <= lastStoredBoundary) {
        nextCycleNum += 1;
        nextStart = getCycleStartForNumber(firstCycleStart, nextCycleNum);
      }
    }

    // Generate cycles while nextStart <= cutoffDate and within enrollment validity
    while (nextStart <= cutoffDate) {
      // Bounding check: No cycle may start after the enrollment's effective end date
      if (enrollmentEndDate && nextStart > enrollmentEndDate) {
        break;
      }

      // Determine snapshotted cycle price at creation time
      let cyclePrice = 0;
      if (enrollment.specialMonthlyPrice != null) {
        cyclePrice = Number(enrollment.specialMonthlyPrice);
      } else {
        const group = db.getFirstSync<any>(
          `SELECT monthly_price as monthlyPrice, default_fee as defaultFee FROM groups WHERE center_id = ? AND id = ?`,
          [centerId, enrollment.groupId],
        );
        cyclePrice = Number(group?.monthlyPrice ?? group?.defaultFee ?? 0);
      }

      const nextCycleStart = getCycleStartForNumber(firstCycleStart, nextCycleNum + 1);
      const cycleEndDate = enrollmentEndDate && enrollmentEndDate < getCycleEndDate(nextCycleStart)
        ? enrollmentEndDate
        : getCycleEndDate(nextCycleStart);

      const cycleId = `dc-${generateUUID()}`;
      const operationId = `op-dc-${generateUUID()}`;
      const now = new Date().toISOString();

      let insertedCycle = { changes: 1 };
      try {
        insertedCycle = db.runSync(
          `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, cycle_type, billing_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'monthly', 'pending', ?)`,
          [
            cycleId,
            centerId,
            enrollment.studentId,
            enrollment.id,
            enrollment.groupId,
            nextCycleNum,
            nextStart,
            cycleEndDate,
            cyclePrice,
            now,
          ],
        );
      } catch (error) {
        if (!String((error as any)?.message || error).toLowerCase().includes("unique")) throw error;
        insertedCycle = { changes: 0 };
      }

      // Another bootstrap/sync pass may have created this natural cycle
      // between the read above and the insert. Keep generation idempotent and
      // do not enqueue a second operation for a row that was ignored.
      if (!insertedCycle.changes) {
        nextCycleNum++;
        nextStart = nextCycleStart;
        continue;
      }

      // Queue for sync
      SyncRepository.enqueueOperation({
        centerId,
        userId: user.id,
        deviceId,
        operationType: "debt_cycle.create",
        entityType: "debt_cycle",
        entityId: cycleId,
        payload: {
          id: cycleId,
          centerId,
          studentId: enrollment.studentId,
          enrollmentId: enrollment.id,
          groupId: enrollment.groupId,
          cycleNumber: nextCycleNum,
          startDate: nextStart,
          endDate: cycleEndDate,
          cyclePrice,
          cycleType: "monthly",
          billingMode: "pending",
          status: "open",
          createdAt: now,
        },
        operationId,
      });

      // Record in audit log
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "debt_cycle",
        entityId: cycleId,
        action: "debt_cycle.generate",
        payload: {
          cycleNumber: nextCycleNum,
          startDate: nextStart,
          endDate: cycleEndDate,
          cyclePrice,
        },
      });

      nextCycleNum++;
      nextStart = nextCycleStart;
    }

    return this.getCyclesForEnrollment(enrollmentId);
  }

  /**
   * Generates debt cycles for a package subscription up to targetDate.
   * - Exactly ONE debt cycle per calendar month (NOT one per subject).
   * - Strict subscription end date bounding: never generates cycles starting after subscription.endDate.
   * - Inactive / ended / cancelled subscriptions cannot generate new cycles past their boundary.
   * - Snapshots cycle_price at creation time from packages.price.
   */
  static generateCyclesForPackageSubscription(
    subscriptionId: string,
    targetDate?: string,
  ): DebtCycle[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "payments.view") &&
      !PermissionService.hasPermission(user.permissions, "payments.create")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إدارة الدورات المالية.");
    }
    const db = DatabaseService.getDb();

    // 1. Fetch subscription
    const subscription = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, package_id as packageId,
              start_date as startDate, end_date as endDate, cancellation_date as cancellationDate, status
       FROM student_package_subscriptions
       WHERE center_id = ? AND id = ?`,
      [centerId, subscriptionId],
    );

    if (!subscription) {
      throw new NotFoundError("اشتراك الباقة غير موجود.");
    }

    // Existing cycles for this package subscription
    let existingCycles = this.getCyclesForPackageSubscription(subscriptionId);

    // Cancelled/inactive subscriptions never create a new billing cycle.
    // Existing cycles remain readable and payable/reversible according to
    // their own status, but generation must stop immediately.
    if (subscription.status !== "active") {
      return existingCycles;
    }

    const cutoffDate = normalizeDateOnly(targetDate) || getLocalDateOnly();
    const subscriptionStartDate = normalizeDateOnly(subscription.startDate);
    const subscriptionEndDate = normalizeDateOnly(subscription.endDate);
    if (!subscriptionStartDate) return existingCycles;
    const deviceId = DeviceService.getDeviceIdSync();

    let nextStart: string;
    let nextCycleNum: number;
    let firstCycleStart: string;

    if (existingCycles.length === 0) {
      // Billing starts at the first actual class in the earliest scheduled
      // group selected for this package, while preserving the old start-date
      // fallback for legacy packages without group/schedule metadata.
      nextStart = this.getFirstPackageScheduledDate(
        subscription.id,
        subscription.packageId,
        subscriptionStartDate,
      );
      nextCycleNum = 1;
      firstCycleStart = nextStart;
    } else {
      const lastCycle = existingCycles[existingCycles.length - 1];
      firstCycleStart = normalizeDateOnly(existingCycles[0].startDate) || "";
      if (!firstCycleStart) return existingCycles;
      const lastEndDate = normalizeDateOnly(lastCycle.endDate);
      const lastStartDate = normalizeDateOnly(lastCycle.startDate);
      if (!lastEndDate && !lastStartDate) return existingCycles;
      nextCycleNum = lastCycle.cycleNumber + 1;
      nextStart = getCycleStartForNumber(firstCycleStart, nextCycleNum);
      const lastStoredBoundary = lastEndDate || lastStartDate || "";
      while (lastStoredBoundary && nextStart <= lastStoredBoundary) {
        nextCycleNum += 1;
        nextStart = getCycleStartForNumber(firstCycleStart, nextCycleNum);
      }
    }

    // Fetch the snapshotted package price. A package is one monthly
    // obligation and must remain one debt cycle; operational reports perform
    // the teacher/group allocation separately.
    const pkg = db.getFirstSync<any>(
      `SELECT price, name FROM packages WHERE center_id = ? AND id = ?`,
      [centerId, subscription.packageId],
    );
    const packagePrice = Number(pkg?.price ?? 0);
    this.repairLegacyPackageCycles(subscription.id, existingCycles, packagePrice);
    existingCycles = this.getCyclesForPackageSubscription(subscriptionId);
    // The debt ledger is intentionally one cycle for the whole package. The
    // selected groups are used for reporting/teacher settlement only; they
    // must never create separate package debts.
    const allocations = [{ enrollmentId: subscription.id, groupId: subscription.packageId, cyclePrice: packagePrice }];

    // Generate cycles while nextStart <= cutoffDate and within subscription validity
    while (nextStart <= cutoffDate) {
      // Bounding check: No cycle may start after the subscription's effective end date
      if (subscriptionEndDate && nextStart > subscriptionEndDate) {
        break;
      }

      const nextCycleStart = getCycleStartForNumber(firstCycleStart, nextCycleNum + 1);
      const cycleEndDate = subscriptionEndDate && subscriptionEndDate < getCycleEndDate(nextCycleStart)
        ? subscriptionEndDate
        : getCycleEndDate(nextCycleStart);

      const now = new Date().toISOString();

      for (const allocation of allocations) {
        const cycleId = `dc-${generateUUID()}`;
        const operationId = `op-dc-pkg-${generateUUID()}`;
        let insertedCycle = { changes: 1 };
        try {
          insertedCycle = db.runSync(
            `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, package_subscription_id, package_id, cycle_type, billing_mode, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'package', 'package', ?)`,
            [cycleId, centerId, subscription.studentId, allocation.enrollmentId, allocation.groupId, nextCycleNum, nextStart, cycleEndDate, allocation.cyclePrice, subscription.id, subscription.packageId, now],
          );
        } catch (error) {
          if (!String((error as any)?.message || error).toLowerCase().includes("unique")) throw error;
          insertedCycle = { changes: 0 };
        }
        if (!insertedCycle.changes) continue;

        SyncRepository.enqueueOperation({
          centerId, userId: user.id, deviceId, operationType: "debt_cycle.create", entityType: "debt_cycle", entityId: cycleId,
          payload: { id: cycleId, centerId, studentId: subscription.studentId, enrollmentId: allocation.enrollmentId, groupId: allocation.groupId, packageSubscriptionId: subscription.id, packageId: subscription.packageId, cycleType: "package", billingMode: "package", cycleNumber: nextCycleNum, startDate: nextStart, endDate: cycleEndDate, cyclePrice: allocation.cyclePrice, status: "open", createdAt: now },
          operationId,
        });
        AuditService.recordEvent({
          operationId, centerId, userId: user.id, deviceId, entityType: "debt_cycle", entityId: cycleId, action: "debt_cycle.generate",
          payload: { packageSubscriptionId: subscription.id, cycleNumber: nextCycleNum, startDate: nextStart, endDate: cycleEndDate, cyclePrice: allocation.cyclePrice, cycleType: "package" },
        });
      }

      nextCycleNum++;
      nextStart = nextCycleStart;
    }

    return this.getCyclesForPackageSubscription(subscriptionId);
  }

  /** Collapse old per-group package cycles into one package ledger cycle. */
  private static repairLegacyPackageCycles(subscriptionId: string, cycles: DebtCycle[], packagePrice = 0): void {
    const { centerId, user } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const deviceId = DeviceService.getDeviceIdSync();
    const byNumber = new Map<number, DebtCycle[]>();
    for (const cycle of cycles.filter((item) => item.cycleType === "package" && item.status !== "cancelled")) {
      const list = byNumber.get(cycle.cycleNumber) || [];
      list.push(cycle);
      byNumber.set(cycle.cycleNumber, list);
    }
    for (const list of byNumber.values()) {
      if (list.length < 2) continue;
      const canonical = list.find((item) => item.enrollmentId === subscriptionId) || list[0];
      const rawTotal = list.reduce((sum, item) => sum + Number(item.cyclePrice || 0), 0);
      // A previous build created one full-price package cycle per selected
      // group.  Do not carry that inflation forward; proportional legacy
      // rows (which already sum to the package amount) are preserved.
      const duplicatedFullPrice = packagePrice > 0 && rawTotal > packagePrice + 0.01 &&
        list.every((item) => Math.abs(Number(item.cyclePrice || 0) - packagePrice) < 0.01);
      const totalPrice = duplicatedFullPrice ? packagePrice : rawTotal;
      const now = new Date().toISOString();
      db.runSync(
        `UPDATE debt_cycles SET enrollment_id = ?, group_id = ?, cycle_price = ?, status = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
        [subscriptionId, canonical.packageId || canonical.groupId || "", totalPrice, canonical.status === "cancelled" ? "open" : canonical.status, now, centerId, canonical.id],
      );
      SyncRepository.enqueueOperation({
        operationId: `op-dc-package-repair-${generateUUID()}`, centerId, userId: user.id, deviceId,
        operationType: "UPDATE", entityType: "debt_cycle", entityId: canonical.id,
        payload: { ...canonical, enrollmentId: subscriptionId, groupId: canonical.packageId || canonical.groupId, cyclePrice: totalPrice, expectedRevision: Number(canonical.serverRevision || 0), updatedAt: now },
      });
      for (const duplicate of list) {
        if (duplicate.id === canonical.id) continue;
        const payments = db.getAllSync<any>(
          `SELECT id, operation_id as operationId, student_id as studentId, amount, payment_type as paymentType, payment_method as paymentMethod, payment_date as paymentDate, subscription_id as subscriptionId, session_id as sessionId, notes, is_reversed as isReversed, created_at as createdAt, user_id as userId FROM payments WHERE center_id = ? AND debt_cycle_id = ?`,
          [centerId, duplicate.id],
        );
        for (const payment of payments) {
          db.runSync(`UPDATE payments SET debt_cycle_id = ?, updated_at = ? WHERE center_id = ? AND id = ?`, [canonical.id, now, centerId, payment.id]);
          SyncRepository.enqueueOperation({
            operationId: `op-payment-package-repair-${generateUUID()}`, centerId, userId: user.id, deviceId,
            operationType: "UPDATE", entityType: "payment", entityId: payment.id,
            payload: { ...payment, debtCycleId: canonical.id, updatedAt: now },
          });
        }
        db.runSync(`UPDATE debt_cycles SET status = 'cancelled', cycle_price = 0, updated_at = ? WHERE center_id = ? AND id = ?`, [now, centerId, duplicate.id]);
        SyncRepository.enqueueOperation({
          operationId: `op-dc-package-repair-${generateUUID()}`, centerId, userId: user.id, deviceId,
          operationType: "UPDATE", entityType: "debt_cycle", entityId: duplicate.id,
          payload: { ...duplicate, cyclePrice: 0, status: "cancelled", expectedRevision: Number(duplicate.serverRevision || 0), updatedAt: now },
        });
      }
    }
  }

  /**
   * Updates cycle status (open, partial, paid).
   */
  static updateCycleStatus(
    cycleId: string,
    status: "open" | "partial" | "paid",
  ): void {
    const { centerId, user } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const cycle = db.getFirstSync<any>(
      `SELECT id, student_id as studentId, enrollment_id as enrollmentId,
              group_id as groupId, cycle_number as cycleNumber,
              start_date as startDate, end_date as endDate,
              cycle_price as cyclePrice, package_subscription_id as packageSubscriptionId,
              package_id as packageId, cycle_type as cycleType,
              billing_mode as billingMode, server_revision as serverRevision
       FROM debt_cycles WHERE center_id = ? AND id = ?`,
      [centerId, cycleId],
    );
    if (!cycle) throw new NotFoundError("دورة المديونية غير موجودة.");

    db.runSync(
      `UPDATE debt_cycles SET status = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
      [status, now, centerId, cycleId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-dc-status-${generateUUID()}`;
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "debt_cycle",
      entityId: cycleId,
      payload: {
        id: cycleId,
        studentId: cycle.studentId,
        enrollmentId: cycle.enrollmentId,
        groupId: cycle.groupId,
        packageSubscriptionId: cycle.packageSubscriptionId,
        packageId: cycle.packageId,
        cycleType: cycle.cycleType,
        billingMode: cycle.billingMode,
        cycleNumber: cycle.cycleNumber,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        cyclePrice: cycle.cyclePrice,
        status,
        expectedRevision: Number(cycle.serverRevision || 0),
        updatedAt: now,
      },
    });
    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "debt_cycle",
      entityId: cycleId,
      action: "debt_cycle.status_update",
      payload: { status },
    });
  }

  /** Selects the settlement policy for a group billing period. */
  static setBillingMode(
    cycleId: string,
    billingMode: "monthly" | "per_session" | "package",
  ): DebtCycle {
    const { centerId, user } = this.getActiveContext();
    const db = DatabaseService.getDb();
    // Read directly here instead of getCycleById: the first payment may be
    // recorded by an account that can create payments but cannot view all
    // payment/debt records. Billing-mode selection must not require the
    // broader payments.view permission.
    const cycle = db.getFirstSync<any>(
      `SELECT id, student_id as studentId, enrollment_id as enrollmentId,
              group_id as groupId, package_subscription_id as packageSubscriptionId,
              package_id as packageId, cycle_number as cycleNumber,
              cycle_type as cycleType, billing_mode as billingMode,
              start_date as startDate, end_date as endDate,
              cycle_price as cyclePrice, status, created_at as createdAt,
              updated_at as updatedAt, server_revision as serverRevision
       FROM debt_cycles WHERE center_id = ? AND id = ? LIMIT 1`,
      [centerId, cycleId],
    );
    if (!cycle) throw new NotFoundError("دورة المديونية غير موجودة.");
    if (cycle.cycleType === "package" && billingMode !== "package") {
      throw new Error("مديونية الباقة لا تُحاسب بنظام الحصة.");
    }
    const nextCycleType = billingMode === "per_session"
      ? "per_session"
      : cycle.cycleType === "per_session" ? "monthly" : cycle.cycleType;
    const now = new Date().toISOString();
    db.runSync(
      `UPDATE debt_cycles SET billing_mode = ?, cycle_type = CASE WHEN ? = 'per_session' THEN 'per_session' WHEN cycle_type = 'per_session' THEN 'monthly' ELSE cycle_type END, updated_at = ? WHERE center_id = ? AND id = ?`,
      [billingMode, billingMode, now, centerId, cycleId],
    );
    const operationId = `op-dc-mode-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();
    SyncRepository.enqueueOperation({
      operationId, centerId, userId: user.id, deviceId,
      operationType: "UPDATE", entityType: "debt_cycle", entityId: cycleId,
      payload: { ...cycle, billingMode, cycleType: nextCycleType, expectedRevision: Number(cycle.serverRevision || 0), updatedAt: now },
    });
    AuditService.recordEvent({
      operationId, centerId, userId: user.id, deviceId,
      entityType: "debt_cycle", entityId: cycleId,
      action: "debt_cycle.billing_mode_set", payload: { billingMode },
    });
    return { ...cycle, billingMode, cycleType: nextCycleType, updatedAt: now };
  }
}
