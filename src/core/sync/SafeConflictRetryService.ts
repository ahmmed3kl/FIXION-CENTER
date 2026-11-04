import { Permission, SyncConflict, SyncOperation } from "../../shared/types";
import { DatabaseService } from "../database";
import { ForbiddenError, ValidationError } from "../errors";
import { AuditService } from "../audit";
import { PermissionService } from "../permissions";
import { Logger } from "../logger";
import { SyncRepository, SyncEngine } from "./index";

export const SAFE_RETRY_BACKOFF_SECONDS = [30, 120, 300, 900, 1800] as const;
export const MAX_SAFE_RETRIES = 5;

export type RetryEligibilityReasonCode =
  | "ELIGIBLE_FOR_RETRY"
  | "FINANCIAL_PROTECTED"
  | "STALE_UPDATE"
  | "SMS_AMBIGUOUS_OUTCOME"
  | "SECURITY_ISOLATION_VIOLATION"
  | "UNRECOVERABLE_SYSTEM_ERROR"
  | "ALREADY_RESOLVED"
  | "CONCURRENT_ATTEMPT_ACTIVE"
  | "MAX_RETRIES_EXCEEDED"
  | "BACKOFF_WAIT_ACTIVE"
  | "PARENT_NOT_ARRIVED"
  | "PARENT_UNCONFIRMED_ON_SERVER"
  | "SESSION_CANCELLED"
  | "PULL_REQUIRED_FOR_SCHEDULE"
  | "SCHEDULE_CONFLICT_STILL_EXISTS"
  | "DUPLICATE_OR_UNRESOLVED_CONFLICT"
  | "UNVERIFIED_CONFLICT_TYPE"
  | "OPERATION_NOT_FOUND"
  | "PERMISSION_DENIED";

export interface RetryEligibilityResult {
  eligible: boolean;
  reasonCode: RetryEligibilityReasonCode;
  userMessage: string;
  entityType?: string;
  operationId?: string;
  remainingDelaySeconds?: number;
  safeRetryCount?: number;
}

export interface RetryExecutionResult {
  success: boolean;
  status: "synced" | "conflict" | "failed" | "rejected";
  reasonCode: string;
  message: string;
  operationId: string;
  safeRetryCount: number;
}

export class SafeConflictRetryService {
  private static readonly FINANCIAL_TYPES = new Set([
    "payment",
    "payment_reversal",
    "debt_cycle",
    "debt_adjustment",
    "daily_closing",
    "advance_coverage",
    "payment_collected",
  ]);

  private static readonly SECURITY_PATTERNS = [
    /outside the authenticated center/i,
    /CARD_BELONGS_TO_OTHER_CENTER/i,
    /CENTER_MISMATCH/i,
    /FOREIGN_CENTER/i,
    /FORBIDDEN/i,
    /UNAUTHORIZED/i,
    /Missing required permission/i,
    /ليس لديك الصلاحية/i,
  ];

  private static readonly UNRECOVERABLE_SYSTEM_PATTERNS = [
    /column\s+["']?.*["']?\s+does not exist/i,
    /relation\s+["']?.*["']?\s+does not exist/i,
    /syntax error/i,
    /invalid input syntax/i,
    /inconsistent types deduced/i,
    /uq_center_card_code/i,
    /violates check constraint/i,
  ];

  private static readonly DUPLICATE_CONFLICT_PATTERNS = [
    /DUPLICATE_CARD_CODE/i,
    /CARD_BELONGS_TO_OTHER_CENTER/i,
    /STUDENT_ALREADY_ENROLLED/i,
    /ALREADY_ENROLLED/i,
    /DUPLICATE_ENTRY/i,
    /UNIQUE constraint failed/i,
    /CARD_ALREADY_ASSIGNED/i,
    /STUDENT_CARD_ALREADY_ACTIVE/i,
    /STUDENT_CODE_EXISTS/i,
  ];

  /** In-memory registry of actively claimed operations to prevent concurrent duplicate claims. */
  private static readonly activeClaims = new Set<string>();

  /** Reset in-memory claims (useful for tests). */
  static resetClaims(): void {
    this.activeClaims.clear();
  }

  /**
   * Helper to verify if an entity's parent has been confirmed on the server,
   * meaning no unconfirmed (pending, syncing, conflict, failed) operations exist for it.
   */
  private static isParentConfirmedOnServer(
    db: any,
    centerId: string,
    parentEntityTypes: string[],
    parentEntityId: string,
  ): boolean {
    const placeholders = parentEntityTypes.map(() => "?").join(", ");
    const unconfirmedOp = db.getFirstSync(
      `SELECT operation_id, status FROM sync_operations
       WHERE center_id = ? AND entity_type IN (${placeholders}) AND entity_id = ?
         AND status IN ('pending', 'syncing', 'conflict', 'failed')`,
      [centerId, ...parentEntityTypes, parentEntityId],
    );
    return !unconfirmedOp;
  }

  /**
   * Evaluates whether a conflicted operation is safely eligible for retry.
   * This is a read-only audit check that does not modify the database.
   */
  static evaluateEligibility(
    centerId: string,
    operationId: string,
    user?: { id: string; permissions: string[] },
  ): RetryEligibilityResult {
    if (!centerId || !operationId) {
      return {
        eligible: false,
        reasonCode: "OPERATION_NOT_FOUND",
        userMessage: "معرف المركز أو معرف العملية غير صالح.",
        operationId,
      };
    }

    if (user) {
      const rawUserId = String(user.id ?? "").trim();
      if (!rawUserId || rawUserId.toLowerCase() === "unknown") {
        return {
          eligible: false,
          reasonCode: "PERMISSION_DENIED",
          userMessage: "يجب تحديد مستخدم صالح وموثوق للمتابعة.",
          operationId,
        };
      }
      if (!PermissionService.hasPermission(user.permissions as Permission[], "sync.manage")) {
        return {
          eligible: false,
          reasonCode: "PERMISSION_DENIED",
          userMessage: "ليس لديك صلاحية إدارة تعارضات المزامنة (sync.manage).",
          operationId,
        };
      }
    }

    const db = DatabaseService.getDb();
    const op = db.getFirstSync<any>(
      `SELECT operation_id as operationId, center_id as centerId, entity_type as entityType,
              entity_id as entityId, payload, status, retry_count as retryCount,
              last_error as lastError, next_retry_at as nextRetryAt
       FROM sync_operations
       WHERE center_id = ? AND operation_id = ?`,
      [centerId, operationId],
    );

    const conflict = db.getFirstSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId, entity_type as entityType,
              entity_id as entityId, reason, local_payload as localPayload,
              server_payload as serverPayload, created_at as createdAt, resolved_at as resolvedAt,
              safe_retry_count as safeRetryCount, last_safe_retry_at as lastSafeRetryAt
       FROM sync_conflicts
       WHERE center_id = ? AND operation_id = ?`,
      [centerId, operationId],
    );

    if (!op || !conflict) {
      return {
        eligible: false,
        reasonCode: "OPERATION_NOT_FOUND",
        userMessage: "لم يتم العثور على سجل العملية أو التعارض في هذا المركز.",
        operationId,
      };
    }

    const rawEntityType = String(op.entityType || conflict.entityType || "");
    const normalizedEntityType = rawEntityType.trim().toLowerCase();
    const errorText = `${conflict.reason || ""} ${op.lastError || ""}`;
    const safeRetries = Number(conflict.safeRetryCount || 0);

    // 1. Strict Financial Protection
    if (this.FINANCIAL_TYPES.has(normalizedEntityType)) {
      return {
        eligible: false,
        reasonCode: "FINANCIAL_PROTECTED",
        userMessage: "عملية مالية - ممنوع إعادة المحاولة قطعيًا لحماية سلامة الحسابات والأرصدة.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 2. Reject STALE_UPDATE
    if (errorText.includes("STALE_UPDATE")) {
      return {
        eligible: false,
        reasonCode: "STALE_UPDATE",
        userMessage: "تم تجاوز هذا التعديل بنسخة أحدث على الخادم (لم يُطبق التعديل المحلي) - لا يمكن إعادة المحاولة.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 3. Reject SMS Ambiguous Outcome
    if (
      normalizedEntityType === "notification_delivery" &&
      (errorText.includes("ambiguous_outcome") || errorText.includes("interrupted_during_send"))
    ) {
      return {
        eligible: false,
        reasonCode: "SMS_AMBIGUOUS_OUTCOME",
        userMessage: "حالة إرسال الرسالة غير مؤكدة - ممنوع إعادة المحاولة لتجنب تكرار الإرسال والخصم المالي.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 4. Reject Security & Center Isolation Violations
    for (const pattern of this.SECURITY_PATTERNS) {
      if (pattern.test(errorText)) {
        return {
          eligible: false,
          reasonCode: "SECURITY_ISOLATION_VIOLATION",
          userMessage: "تعارض في الصلاحيات أو عزل المركز - يتطلب مراجعة إدارية يدوية.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }
    }

    // 5. Reject Unrecoverable System / Schema Errors
    for (const pattern of this.UNRECOVERABLE_SYSTEM_PATTERNS) {
      if (pattern.test(errorText)) {
        return {
          eligible: false,
          reasonCode: "UNRECOVERABLE_SYSTEM_ERROR",
          userMessage: "خطأ تقني أو بنيوي في قاعدة البيانات - يتطلب مراجعة تقنية متخصصة.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }
    }

    // 5.5 Reject Duplicate and Non-Retryable Data Conflicts
    for (const pattern of this.DUPLICATE_CONFLICT_PATTERNS) {
      if (pattern.test(errorText)) {
        return {
          eligible: false,
          reasonCode: "DUPLICATE_OR_UNRESOLVED_CONFLICT",
          userMessage: "التعارض ناتج عن تكرار بيانات موجودة مسبقاً (مثل كود كارت مكرر أو تسجيل طالب مكرر)؛ لا يمكن حله بإعادة المحاولة ويتطلب تدخلاً يدوياً.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }
    }

    // 6. Check if Already Resolved or Synced
    if (conflict.resolvedAt || op.status === "synced") {
      return {
        eligible: false,
        reasonCode: "ALREADY_RESOLVED",
        userMessage: "العملية محسومة أو تمت مزامنتها مسبقاً.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 7. Check if Currently Syncing or Concurrently Claimed
    const claimKey = `${centerId}:${operationId}`;
    if (op.status === "syncing" || this.activeClaims.has(claimKey)) {
      return {
        eligible: false,
        reasonCode: "CONCURRENT_ATTEMPT_ACTIVE",
        userMessage: "العملية قيد المزامنة حالياً أو محجوزة بواسطة محاولة أخرى نشطة.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 8. Enforce Maximum Safe Retries (5 attempts)
    if (safeRetries >= MAX_SAFE_RETRIES) {
      return {
        eligible: false,
        reasonCode: "MAX_RETRIES_EXCEEDED",
        userMessage: "تم بلوغ الحد الأقصى للمحاولات (5 محاولات). تتطلب العملية مراجعة يدوية دون إرسال إضافي.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    // 9. Enforce Backoff Schedule
    // Attempt 1 (safeRetries === 0) is allowed immediately. For subsequent attempts (safeRetries >= 1), enforce backoff.
    if (safeRetries > 0 && conflict.lastSafeRetryAt) {
      const lastRetryTime = new Date(conflict.lastSafeRetryAt).getTime();
      if (!isNaN(lastRetryTime)) {
        const backoffIndex = Math.min(Math.max(0, safeRetries - 1), SAFE_RETRY_BACKOFF_SECONDS.length - 1);
        const backoffDelaySeconds = SAFE_RETRY_BACKOFF_SECONDS[backoffIndex];
        const elapsedSeconds = Math.floor((Date.now() - lastRetryTime) / 1000);
        if (elapsedSeconds < backoffDelaySeconds) {
          const remaining = backoffDelaySeconds - elapsedSeconds;
          return {
            eligible: false,
            reasonCode: "BACKOFF_WAIT_ACTIVE",
            userMessage: `يجب الانتظار قبل إعادة المحاولة (الوقت المتبقي: ${remaining} ثانية).`,
            entityType: normalizedEntityType,
            operationId,
            remainingDelaySeconds: remaining,
            safeRetryCount: safeRetries,
          };
        }
      }
    }

    // 10. Specific Domain Resolution Verification
    let payloadObj: any = null;
    try {
      payloadObj =
        typeof op.payload === "string" ? JSON.parse(op.payload || "{}") : op.payload;
    } catch {}

    if (normalizedEntityType === "group_schedule") {
      const groupId = payloadObj?.groupId || payloadObj?.group_id;
      if (!groupId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "بيانات المجموعة غير محددة في الموعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const groupRow = db.getFirstSync<{ status: string }>(
        `SELECT status FROM groups WHERE id = ? AND center_id = ?`,
        [groupId, centerId],
      );
      if (!groupRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "المجموعة التابع لها هذا الموعد غير موجودة محلياً.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const groupStatus = String(groupRow?.status || "").toLowerCase();
      if (groupStatus !== "active") {
        return {
          eligible: false,
          reasonCode: "ALREADY_RESOLVED",
          userMessage: "المجموعة التابع لها هذا الموعد ليست نشطة (محذوفة أو مؤرشفة).",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      // Check if there is a pending delete/archive operation for this group in sync_operations
      const pendingGroupAction = db.getFirstSync<any>(
        `SELECT operation_id FROM sync_operations
         WHERE center_id = ? AND entity_type = 'group' AND entity_id = ?
           AND operation_type IN ('DELETE', 'ARCHIVE')
           AND status IN ('pending', 'syncing', 'conflict', 'failed')`,
        [centerId, groupId],
      );
      if (pendingGroupAction) {
        return {
          eligible: false,
          reasonCode: "ALREADY_RESOLVED",
          userMessage: "توجد عملية جارية لحذف أو أرشفة المجموعة التابع لها هذا الموعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      // Verify group parent confirmed on server
      if (!this.isParentConfirmedOnServer(db, centerId, ["group"], groupId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل المجموعة المرتبطة بالجدول لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      // Require recent Pull from server to ensure fresh schedule and room data
      const lastFullSync = SyncRepository.getLastFullSyncTime(centerId);
      const lastBootstrap = SyncRepository.getLastBootstrapTime(centerId);
      const latestPullTime = Math.max(
        lastFullSync ? new Date(lastFullSync).getTime() : 0,
        lastBootstrap ? new Date(lastBootstrap).getTime() : 0,
      );

      const conflictCreatedAt = conflict.createdAt || op.createdAt;
      const conflictCreatedTime = conflictCreatedAt ? new Date(conflictCreatedAt).getTime() : 0;
      const MAX_PULL_STALENESS_MS = 10 * 60 * 1000;
      const isPullFresh =
        latestPullTime > 0 &&
        Date.now() - latestPullTime <= MAX_PULL_STALENESS_MS &&
        (!conflictCreatedTime || latestPullTime >= conflictCreatedTime);

      if (!isPullFresh) {
        return {
          eligible: false,
          reasonCode: "PULL_REQUIRED_FOR_SCHEDULE",
          userMessage: "يجب إجراء مزامنة (Pull) حديثة لجلب أحدث جداول المدرسين والقاعات من الخادم قبل إعادة المحاولة.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      // If error was schedule conflict, verify that no conflicting schedule overlaps
      if (
        errorText.includes("TEACHER_SCHEDULE_CONFLICT") ||
        errorText.includes("ROOM_SCHEDULE_CONFLICT")
      ) {
        const dayOfWeek = payloadObj?.dayOfWeek ?? payloadObj?.day_of_week;
        const startTime = payloadObj?.startTime ?? payloadObj?.start_time;
        const endTime = payloadObj?.endTime ?? payloadObj?.end_time;
        let teacherId = payloadObj?.teacherId ?? payloadObj?.teacher_id;

        if (!teacherId && groupId) {
          const grp = db.getFirstSync<{ teacher_id: string }>(
            `SELECT teacher_id FROM groups WHERE id = ? AND center_id = ?`,
            [groupId, centerId],
          );
          teacherId = grp?.teacher_id;
        }

        if (dayOfWeek !== undefined && startTime && endTime) {
          const existingSchedules = db.getAllSync<any>(
            `SELECT gs.id, gs.start_time as startTime, gs.end_time as endTime,
                    g.teacher_id as teacherId
             FROM group_schedules gs
             JOIN groups g ON g.id = gs.group_id
             WHERE gs.center_id = ? AND gs.id != ? AND gs.day_of_week = ?
               AND g.status = 'active'`,
            [centerId, op.entityId, dayOfWeek],
          );

          for (const sched of existingSchedules) {
            const hasTeacherMatch = teacherId && sched.teacherId === teacherId;
            if (hasTeacherMatch) {
              const overlap = startTime < sched.endTime && endTime > sched.startTime;
              if (overlap) {
                return {
                  eligible: false,
                  reasonCode: "SCHEDULE_CONFLICT_STILL_EXISTS",
                  userMessage: "التعارض الزمني لا يزال قائماً مع موعد آخر لنفس المدرس.",
                  entityType: normalizedEntityType,
                  operationId,
                  safeRetryCount: safeRetries,
                };
              }
            }
          }
        }
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بأمان بعد التحقق من المزامنة الحديثة وعدم وجود تداخل.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    if (normalizedEntityType === "attendance" || normalizedEntityType === "makeup") {
      const sessionId =
        payloadObj?.sessionId || payloadObj?.session_id || op.entityId;
      const studentId = payloadObj?.studentId || payloadObj?.student_id;

      if (!sessionId || !studentId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "بيانات الحصة أو الطالب غير مكتملة في العملية.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const sessionRow = db.getFirstSync<{ id: string; status?: string }>(
        `SELECT id, status FROM sessions WHERE id = ? AND center_id = ?`,
        [sessionId, centerId],
      );
      if (!sessionRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "حصة الحضور لم تصل بعد من الخادم. يرجى المزامنة أولاً لجلب بيانات الحصة.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (String(sessionRow.status || "").toLowerCase() === "cancelled") {
        return {
          eligible: false,
          reasonCode: "SESSION_CANCELLED",
          userMessage: "لا يمكن تسجيل أو إعادة محاولة حضور لحصة ملغاة.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["session"], sessionId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل الحصة المرتبطة بالحضور لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const studentRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM students WHERE id = ? AND center_id = ?`,
        [studentId, centerId],
      );
      if (!studentRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "سجل الطالب لم يصل بعد من الخادم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["student"], studentId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل الطالب المرتبط بالحضور لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بعد التأكد من وصول الحصة والطالب وتأكيد مزامنتهما.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    if (normalizedEntityType === "student_card") {
      const studentId = payloadObj?.studentId || payloadObj?.student_id;
      if (!studentId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "معرف الطالب غير محدد في بيانات الكارت.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }
      const studentRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM students WHERE id = ? AND center_id = ?`,
        [studentId, centerId],
      );
      if (!studentRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "سجل الطالب المرتبط بالكارت لم يصل بعد من الخادم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["student"], studentId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل الطالب المرتبط بالكارت لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بعد التأكد من وصول سجل الطالب وتأكيد مزامنته.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    if (
      normalizedEntityType === "enrollment" ||
      normalizedEntityType === "student_group_enrollment"
    ) {
      const studentId = payloadObj?.studentId || payloadObj?.student_id;
      const groupId = payloadObj?.groupId || payloadObj?.group_id;

      if (!studentId || !groupId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "بيانات الطالب أو المجموعة غير مكتملة في سجل التسجيل.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const stRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM students WHERE id = ? AND center_id = ?`,
        [studentId, centerId],
      );
      const grpRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM groups WHERE id = ? AND center_id = ?`,
        [groupId, centerId],
      );

      if (!stRow || !grpRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "السجل الأب (الطالب أو المجموعة) لم يصل بعد من الخادم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["student"], studentId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل الطالب المرتبط بالتسجيل لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["group"], groupId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل المجموعة المرتبطة بالتسجيل لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بعد التأكد من وصول الطالب والمجموعة وتأكيد مزامنتهما.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    if (normalizedEntityType === "notification_delivery") {
      const eventId =
        payloadObj?.notificationEventId ||
        payloadObj?.notification_event_id ||
        payloadObj?.delivery?.notification_event_id;
      if (!eventId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "معرف حدث الإشعار غير موجود في عملية التسليم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }
      const eventRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM notification_events WHERE id = ? AND center_id = ?`,
        [eventId, centerId],
      );
      if (!eventRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "حدث الإشعار الأب لم يصل بعد من الخادم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["notification_event"], eventId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "حدث الإشعار الأب لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بعد التأكد من وجود حدث الإشعار الأب وتأكيد مزامنته.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    if (normalizedEntityType === "payment_request_obligation") {
      const requestId =
        payloadObj?.requestId ||
        payloadObj?.request_id ||
        payloadObj?.paymentRequestId ||
        payloadObj?.payment_request_id;
      const studentId = payloadObj?.studentId || payloadObj?.student_id;

      if (!requestId || !studentId) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "بيانات متطلب الدفع أو الطالب غير مكتملة في العملية.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      const reqRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM group_payment_requests WHERE id = ? AND center_id = ?`,
        [requestId, centerId],
      );
      const studentRow = db.getFirstSync<{ id: string }>(
        `SELECT id FROM students WHERE id = ? AND center_id = ?`,
        [studentId, centerId],
      );

      if (!reqRow || !studentRow) {
        return {
          eligible: false,
          reasonCode: "PARENT_NOT_ARRIVED",
          userMessage: "السجل الأب (متطلب الدفع أو الطالب) لم يصل بعد من الخادم.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (
        !this.isParentConfirmedOnServer(db, centerId, [
          "payment_request",
          "group_payment_request",
        ], requestId)
      ) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "متطلب الدفع المرتبط بهذا الالتزام لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      if (!this.isParentConfirmedOnServer(db, centerId, ["student"], studentId)) {
        return {
          eligible: false,
          reasonCode: "PARENT_UNCONFIRMED_ON_SERVER",
          userMessage: "سجل الطالب المرتبط بهذا الالتزام لم يتم تأكيد مزامنته على الخادم بعد.",
          entityType: normalizedEntityType,
          operationId,
          safeRetryCount: safeRetries,
        };
      }

      return {
        eligible: true,
        reasonCode: "ELIGIBLE_FOR_RETRY",
        userMessage: "العملية مؤهلة لإعادة المحاولة بأمان بعد التأكد من تأكيد مزامنة متطلب الدفع والطالب.",
        entityType: normalizedEntityType,
        operationId,
        safeRetryCount: safeRetries,
      };
    }

    return {
      eligible: false,
      reasonCode: "UNVERIFIED_CONFLICT_TYPE",
      userMessage: "نوع العملية لا يحتوي على تحقق مؤتمت صريح من زوال سبب التعارض؛ يرجى المراجعة اليدوية.",
      entityType: normalizedEntityType,
      operationId,
      safeRetryCount: safeRetries,
    };
  }

  /**
   * Atomically claims a conflicted operation for retry.
   * Guarantees that only one execution claims the row, and rejects if the operation
   * is financial, not in conflict, or claimed elsewhere.
   */
  static claimOperation(
    centerId: string,
    operationId: string,
    user: { id: string; permissions: string[] },
    deviceId = "system",
  ): boolean {
    const rawUserId = String(user?.id ?? "").trim();
    if (!rawUserId || rawUserId.toLowerCase() === "unknown") {
      throw new ValidationError(
        "A valid acting user ID is required to claim a conflict retry",
        "يجب تحديد مستخدم صالح وموثوق لتوثيق محاولة إعادة العملية.",
      );
    }

    if (!PermissionService.hasPermission(user.permissions as Permission[], "sync.manage")) {
      throw new ForbiddenError(
        "User does not have sync.manage permission",
        "ليس لديك الصلاحية الكافية لإعادة محاولة تعارضات المزامنة.",
      );
    }

    const claimKey = `${centerId}:${operationId}`;
    if (this.activeClaims.has(claimKey)) {
      return false;
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    let claimed = false;
    DatabaseService.runInTransaction((txDb) => {
      const updateResult = txDb.runSync(
        `UPDATE sync_operations
         SET status = 'syncing',
             next_retry_at = NULL,
             last_error = '[محاولة إعادة آمنة]'
         WHERE center_id = ?
           AND operation_id = ?
           AND status = 'conflict'
           AND LOWER(TRIM(entity_type)) NOT IN ('payment', 'payment_reversal', 'debt_cycle', 'debt_adjustment', 'daily_closing', 'advance_coverage', 'payment_collected')`,
        [centerId, operationId],
      );

      if (Number(updateResult?.changes || 0) > 0) {
        txDb.runSync(
          `UPDATE sync_conflicts
           SET safe_retry_count = COALESCE(safe_retry_count, 0) + 1,
               last_safe_retry_at = ?
           WHERE center_id = ? AND operation_id = ? AND resolved_at IS NULL`,
          [now, centerId, operationId],
        );
        claimed = true;
      }
    });

    if (claimed) {
      this.activeClaims.add(claimKey);
      const op = db.getFirstSync<any>(
        `SELECT entity_type as entityType, entity_id as entityId FROM sync_operations WHERE operation_id = ? AND center_id = ?`,
        [operationId, centerId],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: rawUserId,
        deviceId,
        entityType: op?.entityType || "unknown",
        entityId: op?.entityId || "unknown",
        action: "SAFE_CONFLICT_RETRY_CLAIMED",
        payload: {
          claimedAt: now,
        },
      });
    }

    return claimed;
  }

  /**
   * Releases an active claim and reverts status to conflict if execution did not succeed.
   */
  static releaseClaim(centerId: string, operationId: string, revertReason?: string): void {
    const claimKey = `${centerId}:${operationId}`;
    this.activeClaims.delete(claimKey);
    const db = DatabaseService.getDb();
    db.runSync(
      `UPDATE sync_operations
       SET status = 'conflict',
           last_error = COALESCE(?, last_error)
       WHERE center_id = ? AND operation_id = ? AND status = 'syncing'`,
      [revertReason || null, centerId, operationId],
    );
  }

  /**
   * Executes a safe retry for an eligible conflict.
   * Preserves operation_id, serializes with sync locks, and requires official server confirmation.
   */
  static async retryConflict(params: {
    centerId: string;
    operationId: string;
    user: { id: string; permissions: string[] };
    deviceId?: string;
  }): Promise<RetryExecutionResult> {
    const { centerId, operationId, user } = params;
    const rawUserId = String(user?.id ?? "").trim();
    const deviceId = params.deviceId || "system";

    const eligibility = this.evaluateEligibility(centerId, operationId, user);
    if (!eligibility.eligible) {
      return {
        success: false,
        status: "rejected",
        reasonCode: eligibility.reasonCode,
        message: eligibility.userMessage,
        operationId,
        safeRetryCount: eligibility.safeRetryCount || 0,
      };
    }

    // Rule 1: Check if sync engine is already active or locked for this center
    if (SyncEngine.isSyncLocked(centerId)) {
      return {
        success: false,
        status: "rejected",
        reasonCode: "CONCURRENT_ATTEMPT_ACTIVE",
        message: "توجد دورة مزامنة نشطة حالياً للمركز؛ يرجى الانتظار حتى اكتمالها.",
        operationId,
        safeRetryCount: eligibility.safeRetryCount || 0,
      };
    }

    // Rule 2: Acquire SyncEngine lock BEFORE atomic claim to prevent orphaned syncing state
    return await SyncEngine.withSyncLocks(centerId, async () => {
      const claimed = this.claimOperation(centerId, operationId, user, deviceId);
      if (!claimed) {
        return {
          success: false,
          status: "rejected",
          reasonCode: "CLAIM_FAILED",
          message: "فشل حجز العملية للمزامنة. قد تكون العملية قيد المزامنة حالياً أو تم تعديل حالتها.",
          operationId,
          safeRetryCount: eligibility.safeRetryCount || 0,
        };
      }

      const claimKey = `${centerId}:${operationId}`;
      const db = DatabaseService.getDb();

      try {
        const op = db.getFirstSync<any>(
          `SELECT operation_id as operationId, center_id as centerId, user_id as userId,
                  device_id as deviceId, operation_type as operationType,
                  entity_type as entityType, entity_id as entityId, payload,
                  created_at as createdAt, retry_count as retryCount
           FROM sync_operations
           WHERE center_id = ? AND operation_id = ?`,
          [centerId, operationId],
        );

        if (!op) {
          this.releaseClaim(centerId, operationId, "لم يتم العثور على العملية بعد الحجز.");
          return {
            success: false,
            status: "failed",
            reasonCode: "OPERATION_NOT_FOUND",
            message: "لم يتم العثور على العملية في قاعدة البيانات المحلية.",
            operationId,
            safeRetryCount: eligibility.safeRetryCount || 0,
          };
        }

        const conflictRow = db.getFirstSync<any>(
          `SELECT safe_retry_count as safeRetryCount FROM sync_conflicts WHERE center_id = ? AND operation_id = ?`,
          [centerId, operationId],
        );
        const safeRetryCount = Number(conflictRow?.safeRetryCount || 1);

        let parsedPayload: any = op.payload;
        if (typeof op.payload === "string") {
          try {
            parsedPayload = JSON.parse(op.payload || "{}");
          } catch {
            parsedPayload = {};
          }
        }

        // Push through adapter with the EXACT SAME operation_id
        const adapter = SyncEngine.getAdapter();
        const pushResponse = await adapter.pushOperations(centerId, [
          {
            operationId: op.operationId, // ORIGINAL ID STRICTLY PRESERVED!
            centerId: op.centerId,
            userId: op.userId,
            deviceId: op.deviceId,
            operationType: op.operationType,
            entityType: op.entityType,
            entityId: op.entityId,
            payload: parsedPayload,
            createdAt: op.createdAt,
            retryCount: op.retryCount,
          },
        ]);

        const now = new Date().toISOString();

        // Rule 8: Officially confirmed by server
        if (pushResponse.syncedOperationIds && pushResponse.syncedOperationIds.includes(operationId)) {
          SyncRepository.markAsSynced(operationId, { resolveOnlyThisOperation: true });
          db.runSync(
            `UPDATE sync_conflicts
             SET resolved_at = ?, resolved_by = ?, resolution_note = ?
             WHERE center_id = ? AND operation_id = ?`,
            [
              now,
              rawUserId,
              "تمت إعادة المحاولة وتأكيد المزامنة بنجاح من الخادم",
              centerId,
              operationId,
            ],
          );
          AuditService.recordEvent({
            operationId,
            centerId,
            userId: rawUserId,
            deviceId,
            entityType: op.entityType,
            entityId: op.entityId,
            action: "SAFE_CONFLICT_RETRY_SUCCEEDED",
            payload: {
              attemptNumber: safeRetryCount,
              resolvedAt: now,
            },
          });
          return {
            success: true,
            status: "synced",
            reasonCode: "SYNCED_SUCCESSFULLY",
            message: "تمت إعادة المحاولة بنجاح وتأكيدها من الخادم.",
            operationId,
            safeRetryCount,
          };
        }

        // Server returned a conflict
        const conflict = (pushResponse.conflicts || []).find((c) => c.operationId === operationId);
        if (conflict) {
          SyncRepository.markAsConflict(
            operationId,
            conflict.reason,
            { serverState: conflict.serverState, resolution: conflict.resolution },
          );

          if (safeRetryCount >= MAX_SAFE_RETRIES) {
            db.runSync(
              `UPDATE sync_operations
               SET last_error = '[مراجعة يدوية مطلوبة]: تم بلوغ الحد الأقصى للمحاولات (5 محاولات)',
                   next_retry_at = NULL
               WHERE center_id = ? AND operation_id = ?`,
              [centerId, operationId],
            );
          } else {
            const backoffIndex = Math.min(Math.max(0, safeRetryCount - 1), SAFE_RETRY_BACKOFF_SECONDS.length - 1);
            const backoffSec = SAFE_RETRY_BACKOFF_SECONDS[backoffIndex];
            const nextRetryAt = new Date(Date.now() + backoffSec * 1000).toISOString();
            db.runSync(
              `UPDATE sync_operations
               SET next_retry_at = ?
               WHERE center_id = ? AND operation_id = ?`,
              [nextRetryAt, centerId, operationId],
            );
          }

          AuditService.recordEvent({
            operationId,
            centerId,
            userId: rawUserId,
            deviceId,
            entityType: op.entityType,
            entityId: op.entityId,
            action: "SAFE_CONFLICT_RETRY_FAILED_CONFLICT",
            payload: {
              attemptNumber: safeRetryCount,
              serverReason: conflict.reason,
            },
          });

          return {
            success: false,
            status: "conflict",
            reasonCode: "SERVER_CONFLICT_RETURNED",
            message: `أعاد الخادم تعارضاً: ${conflict.reason}`,
            operationId,
            safeRetryCount,
          };
        }

        // If neither confirmed nor conflict returned: DO NOT mark as synced!
        this.releaseClaim(centerId, operationId, "لم يؤكد الخادم قبول العملية ولم يُرجع تعارضاً.");
        return {
          success: false,
          status: "failed",
          reasonCode: "SERVER_UNCONFIRMED",
          message: "لم يؤكد الخادم قبول العملية.",
          operationId,
          safeRetryCount,
        };
      } catch (error: any) {
        const errorMsg = error?.message || "تعذر إكمال إعادة المحاولة عبر الخادم.";
        this.releaseClaim(centerId, operationId, errorMsg);
        return {
          success: false,
          status: "failed",
          reasonCode: "NETWORK_OR_SERVER_ERROR",
          message: errorMsg,
          operationId,
          safeRetryCount: eligibility.safeRetryCount || 0,
        };
      } finally {
        this.activeClaims.delete(claimKey);
      }
    });
  }
}

