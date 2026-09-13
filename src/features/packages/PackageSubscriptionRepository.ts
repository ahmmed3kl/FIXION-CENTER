import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import {
    PermissionService,
    resolveUserPermissions
} from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import {
    PackageTeacherOverride,
    StudentPackageSubscription
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { DebtCycleRepository } from "../payments/DebtCycleRepository";
import { StudentRepository } from "../students/StudentRepository";
import { TeacherRepository } from "../teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../teachers/TeacherSubjectRepository";
import { PackageRepository } from "./PackageRepository";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class PackageSubscriptionRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    const permissions = resolveUserPermissions(currentUser);
    const user = { ...currentUser, permissions };
    return { centerId: activeCenterId, user };
  }

  /**
   * Retrieves all package subscriptions for a student in the active center.
   */
  static getSubscriptionsForStudent(
    studentId: string,
    includeInactive = false,
  ): StudentPackageSubscription[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الاشتراكات.");
    }
    const db = DatabaseService.getDb();
    const query = includeInactive
      ? `SELECT sps.id, sps.center_id as centerId, sps.student_id as studentId,
                sps.package_id as packageId, sps.start_date as startDate,
                sps.end_date as endDate, sps.cancellation_date as cancellationDate,
                sps.status, sps.created_at as createdAt, sps.updated_at as updatedAt,
                p.name as packageName, p.price as packagePrice
         FROM student_package_subscriptions sps
         JOIN packages p ON sps.package_id = p.id
         WHERE sps.center_id = ? AND sps.student_id = ?
         ORDER BY sps.start_date DESC`
      : `SELECT sps.id, sps.center_id as centerId, sps.student_id as studentId,
                sps.package_id as packageId, sps.start_date as startDate,
                sps.end_date as endDate, sps.cancellation_date as cancellationDate,
                sps.status, sps.created_at as createdAt, sps.updated_at as updatedAt,
                p.name as packageName, p.price as packagePrice
         FROM student_package_subscriptions sps
         JOIN packages p ON sps.package_id = p.id
         WHERE sps.center_id = ? AND sps.student_id = ? AND sps.status = 'active'
         ORDER BY sps.start_date DESC`;

    return db.getAllSync<StudentPackageSubscription>(query, [
      centerId,
      studentId,
    ]);
  }

  /**
   * Retrieves a single subscription by ID within the active center.
   */
  static getSubscriptionById(id: string): StudentPackageSubscription | null {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الاشتراكات.");
    }
    const db = DatabaseService.getDb();
    return db.getFirstSync<StudentPackageSubscription>(
      `SELECT sps.id, sps.center_id as centerId, sps.student_id as studentId,
              sps.package_id as packageId, sps.start_date as startDate,
              sps.end_date as endDate, sps.cancellation_date as cancellationDate,
              sps.status, sps.created_at as createdAt, sps.updated_at as updatedAt,
              p.name as packageName, p.price as packagePrice
       FROM student_package_subscriptions sps
       JOIN packages p ON sps.package_id = p.id
       WHERE sps.center_id = ? AND sps.id = ?`,
      [centerId, id],
    );
  }

  /**
   * Subscribes a student to a package.
   * Automatically initializes the package debt cycle.
   */
  static async subscribeStudent(params: {
    studentId: string;
    packageId: string;
    startDate: string;
    endDate?: string;
    selectedOptionIds?: string[];
  }): Promise<StudentPackageSubscription> {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "packages.subscribe")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل اشتراك باقة للطالب.");
    }

    const student = StudentRepository.findById(params.studentId);
    if (!student) {
      throw new NotFoundError("الطالب غير موجود.");
    }

    const pkg = PackageRepository.getPackageById(params.packageId);
    if (!pkg || pkg.status !== "active") {
      throw new NotFoundError("الباقة غير موجودة أو غير نشطة.");
    }
    const packageOptions = PackageRepository.getPackageSubjects(params.packageId);
    const selectedOptionIds = params.selectedOptionIds ?? packageOptions.map((o) => o.id);
    const hasExplicitSelection = params.selectedOptionIds !== undefined;
    if (hasExplicitSelection && packageOptions.length > 0 && (selectedOptionIds.length < 1 || selectedOptionIds.length > (pkg.maxSelections || 1))) {
      throw new ValidationError(`يجب اختيار من 1 إلى ${pkg.maxSelections || 1} من اختيارات الباقة.`);
    }
    if (selectedOptionIds.some((id) => !packageOptions.some((o) => o.id === id))) {
      throw new ValidationError("يوجد اختيار غير تابع لهذه الباقة.");
    }

    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>(
      `SELECT id FROM student_package_subscriptions
       WHERE center_id = ? AND student_id = ? AND package_id = ? AND status = 'active'`,
      [centerId, params.studentId, params.packageId],
    );
    if (existing) {
      throw new ConflictError("الطالب مشترك بالفعل في هذه الباقة حالياً.");
    }

    const id = `sps-${generateUUID()}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO student_package_subscriptions (id, center_id, student_id, package_id, start_date, end_date, cancellation_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`,
      [
        id,
        centerId,
        params.studentId,
        params.packageId,
        params.startDate,
        params.endDate || null,
        now,
        now,
      ],
    );
    // Keep the student's selected package options in the existing audited
    // override table. The default teacher is stored deliberately so the
    // selection remains available offline and survives a mid-month switch.
    for (const optionId of selectedOptionIds) {
      const option = packageOptions.find((o) => o.id === optionId)!;
      db.runSync(
        `INSERT OR IGNORE INTO package_subject_teacher_overrides (id, center_id, subscription_id, subject_id, teacher_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`sel-${generateUUID()}`, centerId, id, option.subjectId, option.defaultTeacherId, now],
      );
    }

    const subscription: StudentPackageSubscription = {
      id,
      centerId,
      studentId: params.studentId,
      packageId: params.packageId,
      startDate: params.startDate,
      endDate: params.endDate || null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      packageName: pkg.name,
      packagePrice: pkg.price,
    };

    // Generate initial debt cycle for this package subscription
    DebtCycleRepository.generateCyclesForPackageSubscription(
      id,
      params.startDate,
    );

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-sps-sub-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.subscribe",
      entityType: "package_subscription",
      entityId: id,
      payload: subscription,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_subscription",
      entityId: id,
      action: "package_subscription.create",
      payload: {
        studentId: params.studentId,
        packageId: params.packageId,
        startDate: params.startDate,
        selectedOptionIds,
      },
    });

    return subscription;
  }

  /**
   * Cancels a package subscription.
   *
   * STRICT PAID CYCLE BOUNDARY RULE:
   * - If cancelled during an already-paid cycle, the student remains financially/academically
   *   eligible through the end of the paid cycle.
   * - effectiveEndDate = max(cancellationDate, paidCycle.endDate).
   * - Cancellation prevents any future cycles after effectiveEndDate.
   * - Already-generated historical/current debt cycles are preserved.
   */
  static async cancelSubscription(
    subscriptionId: string,
    cancellationDate: string,
  ): Promise<StudentPackageSubscription> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء اشتراك الباقة.");
    }

    const subscription = this.getSubscriptionById(subscriptionId);
    if (!subscription) {
      throw new NotFoundError("اشتراك الباقة غير موجود.");
    }
    if (subscription.status === "cancelled") {
      throw new ConflictError("الاشتراك ملغى بالفعل.");
    }

    const db = DatabaseService.getDb();

    // Check debt cycles for this subscription to determine paid boundary
    const cycles =
      DebtCycleRepository.getCyclesForPackageSubscription(subscriptionId);
    const activeCycle =
      cycles.find(
        (c) => c.startDate <= cancellationDate && c.endDate >= cancellationDate,
      ) || cycles[cycles.length - 1];

    let effectiveEndDate = cancellationDate;

    if (activeCycle) {
      // Check if active cycle is paid
      const payments = db.getAllSync<any>(
        `SELECT amount FROM payments WHERE center_id = ? AND debt_cycle_id = ? AND is_reversed = 0`,
        [centerId, activeCycle.id],
      );
      const totalPaid = payments.reduce(
        (acc: number, p: any) => acc + Number(p.amount),
        0,
      );
      const isPaid =
        activeCycle.status === "paid" || totalPaid >= activeCycle.cyclePrice;

      if (isPaid && activeCycle.endDate > cancellationDate) {
        effectiveEndDate = activeCycle.endDate;
      }
    }

    const now = new Date().toISOString();

    db.runSync(
      `UPDATE student_package_subscriptions
       SET status = 'cancelled', cancellation_date = ?, end_date = ?, updated_at = ?
       WHERE center_id = ? AND id = ?`,
      [cancellationDate, effectiveEndDate, now, centerId, subscriptionId],
    );

    const updatedSubscription: StudentPackageSubscription = {
      ...subscription,
      status: "cancelled",
      cancellationDate,
      endDate: effectiveEndDate,
      updatedAt: now,
    };

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-sps-cancel-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.cancel_subscription",
      entityType: "package_subscription",
      entityId: subscriptionId,
      payload: updatedSubscription,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_subscription",
      entityId: subscriptionId,
      action: "package_subscription.cancel",
      payload: {
        cancellationDate,
        effectiveEndDate,
      },
    });

    return updatedSubscription;
  }

  /**
   * Retrieves all teacher overrides for a package subscription.
   */
  static getTeacherOverrides(subscriptionId: string): PackageTeacherOverride[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تخصيصات المعلمين.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<PackageTeacherOverride>(
      `SELECT o.id, o.center_id as centerId, o.subscription_id as subscriptionId,
              o.subject_id as subjectId, o.teacher_id as teacherId, o.created_at as createdAt,
              t.name as teacherName
       FROM package_subject_teacher_overrides o
       JOIN teachers t ON o.teacher_id = t.id
       WHERE o.center_id = ? AND o.subscription_id = ?`,
      [centerId, subscriptionId],
    );
  }

  /**
   * Overrides a subject's teacher for this student's subscription.
   * Strictly validates that the teacher teaches this subject in the center.
   */
  static async setTeacherOverride(params: {
    subscriptionId: string;
    subjectId: string;
    teacherId: string;
  }): Promise<PackageTeacherOverride> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل معلمي باقة الطالب.");
    }

    const subscription = this.getSubscriptionById(params.subscriptionId);
    if (!subscription) {
      throw new NotFoundError("اشتراك الباقة غير موجود.");
    }

    // Validate package contains this subject
    const packageSubjects = PackageRepository.getPackageSubjects(
      subscription.packageId,
    );
    const subjectInPackage = packageSubjects.find(
      (ps) => ps.subjectId === params.subjectId,
    );
    if (!subjectInPackage) {
      throw new ValidationError("المادة غير موجودة ضمن هذه الباقة.");
    }

    const teacher = TeacherRepository.findById(params.teacherId);
    if (!teacher) {
      throw new NotFoundError("المعلم غير موجود.");
    }

    // MANDATORY VALIDATION: Teacher must teach this subject in the center
    const isAssigned = TeacherSubjectRepository.isTeacherAssignedToSubject(
      params.teacherId,
      params.subjectId,
    );
    if (!isAssigned) {
      throw new ValidationError("المدرس غير مخصص لتدريس هذه المادة في المركز.");
    }

    const db = DatabaseService.getDb();
    // Remove existing override if any
    db.runSync(
      `DELETE FROM package_subject_teacher_overrides
       WHERE center_id = ? AND subscription_id = ? AND subject_id = ?`,
      [centerId, params.subscriptionId, params.subjectId],
    );

    const id = `ovr-${generateUUID()}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO package_subject_teacher_overrides (id, center_id, subscription_id, subject_id, teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        centerId,
        params.subscriptionId,
        params.subjectId,
        params.teacherId,
        now,
      ],
    );

    const override: PackageTeacherOverride = {
      id,
      centerId,
      subscriptionId: params.subscriptionId,
      subjectId: params.subjectId,
      teacherId: params.teacherId,
      createdAt: now,
      teacherName: teacher.name,
    };

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-ovr-set-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.set_override",
      entityType: "package_teacher_override",
      entityId: id,
      payload: override,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_teacher_override",
      entityId: id,
      action: "package_override.set",
      payload: {
        subscriptionId: params.subscriptionId,
        subjectId: params.subjectId,
        teacherId: params.teacherId,
      },
    });

    return override;
  }

  /**
   * Removes a teacher override (reverting back to the package default teacher).
   */
  static async removeTeacherOverride(params: {
    subscriptionId: string;
    subjectId: string;
  }): Promise<void> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "packages.manage")) {
      throw new ForbiddenError("ليس لديك صلاحية إزالة تخصيص المعلم.");
    }

    const db = DatabaseService.getDb();
    db.runSync(
      `DELETE FROM package_subject_teacher_overrides
       WHERE center_id = ? AND subscription_id = ? AND subject_id = ?`,
      [centerId, params.subscriptionId, params.subjectId],
    );

    const deviceId = await DeviceService.getDeviceId();
    const operationId = `op-ovr-rm-${generateUUID()}`;

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "packages.remove_override",
      entityType: "package_teacher_override",
      entityId: `${params.subscriptionId}-${params.subjectId}`,
      payload: params,
    });

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "package_teacher_override",
      entityId: `${params.subscriptionId}-${params.subjectId}`,
      action: "package_override.remove",
      payload: params,
    });
  }
}
