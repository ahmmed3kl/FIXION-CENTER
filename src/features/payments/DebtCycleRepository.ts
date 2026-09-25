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
    const existingCycles = this.getCyclesForEnrollment(enrollmentId);

    // Cancelled / inactive / ended enrollments cannot generate new cycles
    if (enrollment.status !== "active") {
      return existingCycles;
    }

    const cutoffDate = normalizeDateOnly(targetDate) || new Date().toISOString().slice(0, 10);
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

      db.runSync(
        `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, cycle_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'monthly', ?)`,
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
    const existingCycles = this.getCyclesForPackageSubscription(subscriptionId);

    // Cancelled / inactive subscriptions: if ended, cannot generate cycles past effective end date
    if (
      subscription.status !== "active" &&
      (!subscription.endDate || subscription.startDate > subscription.endDate)
    ) {
      return existingCycles;
    }

    const cutoffDate = normalizeDateOnly(targetDate) || new Date().toISOString().slice(0, 10);
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

    // Fetch snapshotted package price
    const pkg = db.getFirstSync<any>(
      `SELECT price, name FROM packages WHERE center_id = ? AND id = ?`,
      [centerId, subscription.packageId],
    );
    const cyclePrice = Number(pkg?.price ?? 0);

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

      const cycleId = `dc-${generateUUID()}`;
      const operationId = `op-dc-pkg-${generateUUID()}`;
      const now = new Date().toISOString();

      db.runSync(
        `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, package_subscription_id, package_id, cycle_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'package', ?)`,
        [
          cycleId,
          centerId,
          subscription.studentId,
          subscription.id,
          subscription.packageId,
          nextCycleNum,
          nextStart,
          cycleEndDate,
          cyclePrice,
          subscription.id,
          subscription.packageId,
          now,
        ],
      );

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
          studentId: subscription.studentId,
          enrollmentId: subscription.id,
          groupId: subscription.packageId,
          packageSubscriptionId: subscription.id,
          packageId: subscription.packageId,
          cycleType: "package",
          cycleNumber: nextCycleNum,
          startDate: nextStart,
          endDate: cycleEndDate,
          cyclePrice,
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
          packageSubscriptionId: subscription.id,
          cycleNumber: nextCycleNum,
          startDate: nextStart,
          endDate: cycleEndDate,
          cyclePrice,
          cycleType: "package",
        },
      });

      nextCycleNum++;
      nextStart = nextCycleStart;
    }

    return this.getCyclesForPackageSubscription(subscriptionId);
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
              package_id as packageId, cycle_type as cycleType
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
        cycleNumber: cycle.cycleNumber,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        cyclePrice: cycle.cyclePrice,
        status,
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
}
