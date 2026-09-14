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

export function getNextCycleStartDate(currentStartDate: string): string {
  const parts = currentStartDate.split("-").map((p) => parseInt(p, 10));
  let year = parts[0];
  let month = parts[1];
  const day = parts[2];

  month += 1;
  if (month > 12) {
    year += 1;
    month = 1;
  }

  const maxDays = new Date(year, month, 0).getDate();
  const nextDay = Math.min(day, maxDays);

  const yStr = String(year).padStart(4, "0");
  const mStr = String(month).padStart(2, "0");
  const dStr = String(nextDay).padStart(2, "0");
  return `${yStr}-${mStr}-${dStr}`;
}

export function getCycleEndDate(nextCycleStartDate: string): string {
  const [y, m, d] = nextCycleStartDate.split("-").map((p) => parseInt(p, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export class DebtCycleRepository {
  private static getFirstScheduledDate(groupId: string, startDate: string): string {
    const { activeCenterId } = useAuthStore.getState();
    const db = DatabaseService.getDb();
    const schedules = db.getAllSync<{ dayOfWeek: number }>(
      `SELECT day_of_week as dayOfWeek FROM group_schedules
       WHERE center_id = ? AND group_id = ? AND status = 'active'`,
      [activeCenterId, groupId],
    );
    if (!schedules.length) return startDate;
    const start = new Date(`${startDate}T12:00:00`);
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = new Date(start);
      candidate.setDate(start.getDate() + offset);
      if (schedules.some((schedule) => schedule.dayOfWeek === candidate.getDay())) {
        return candidate.toISOString().slice(0, 10);
      }
    }
    return startDate;
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

    const cutoffDate = targetDate || new Date().toISOString().slice(0, 10);
    const deviceId = DeviceService.getDeviceIdSync();

    let nextStart: string;
    let nextCycleNum: number;

    if (existingCycles.length === 0) {
      // A new enrollment starts financially on the first actual scheduled
      // class on/after the enrollment date, never before the student can attend.
      nextStart = this.getFirstScheduledDate(enrollment.groupId, enrollment.startDate);
      nextCycleNum = 1;
    } else {
      const lastCycle = existingCycles[existingCycles.length - 1];
      nextStart = getNextCycleStartDate(lastCycle.startDate);
      nextCycleNum = lastCycle.cycleNumber + 1;
    }

    // Generate cycles while nextStart <= cutoffDate and within enrollment validity
    while (nextStart <= cutoffDate) {
      // Bounding check: No cycle may start after the enrollment's effective end date
      if (enrollment.endDate && nextStart > enrollment.endDate) {
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

      const nextCycleStart = getNextCycleStartDate(nextStart);
      const cycleEndDate = getCycleEndDate(nextCycleStart);

      const cycleId = `dc-${generateUUID()}`;
      const operationId = `op-dc-${generateUUID()}`;
      const now = new Date().toISOString();

      db.runSync(
        `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
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
   * - Exactly ONE debt cycle per monthly cycle (NOT one per subject).
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

    const cutoffDate = targetDate || new Date().toISOString().slice(0, 10);
    const deviceId = DeviceService.getDeviceIdSync();

    let nextStart: string;
    let nextCycleNum: number;

    if (existingCycles.length === 0) {
      nextStart = subscription.startDate;
      nextCycleNum = 1;
    } else {
      const lastCycle = existingCycles[existingCycles.length - 1];
      nextStart = getNextCycleStartDate(lastCycle.startDate);
      nextCycleNum = lastCycle.cycleNumber + 1;
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
      if (subscription.endDate && nextStart > subscription.endDate) {
        break;
      }

      const nextCycleStart = getNextCycleStartDate(nextStart);
      const cycleEndDate = getCycleEndDate(nextCycleStart);

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
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    db.runSync(
      `UPDATE debt_cycles SET status = ?, updated_at = ? WHERE center_id = ? AND id = ?`,
      [status, now, centerId, cycleId],
    );
  }
}
