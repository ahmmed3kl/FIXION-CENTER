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
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import {
  GroupPaymentRequest,
  PaymentEvent,
  PaymentRequestCollectionStatistics,
  PaymentRequestDetailsResult,
  PaymentRequestFilterType,
  Permission,
  StudentPaymentRequestObligation,
} from "../../shared/types";
import { smartSearch } from "../../shared/utils/smartSearch";
import { useAuthStore } from "../auth/useAuthStore";
import { PaymentRepository } from "./PaymentRepository";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface GroupWithPaymentRequestSummary {
  id: string;
  centerId: string;
  name: string;
  grade: string;
  teacherId: string;
  teacherName: string;
  subjectId: string;
  subjectName: string;
  activeStudentsCount: number;
  activeRequestsCount: number;
}

export interface CreatePaymentRequestResult {
  request: GroupPaymentRequest;
  obligations: StudentPaymentRequestObligation[];
  affectedStudentsCount: number;
  groupName: string;
}

export class PaymentRequestRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError(
        "يجب تسجيل الدخول وتحديد المركز لإدارة متطالبات الدفع.",
      );
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  private static ensureViewPermission(permissions: Permission[]) {
    if (
      !PermissionService.hasAnyPermission(permissions, [
        "payments.view",
        "payments.create",
        "payments.edit",
        "payments.adjust",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض متطالبات الدفع.");
    }
  }

  private static ensureManagePermission(
    permissions: Permission[],
    action: "create" | "edit" | "archive",
  ) {
    const allowed: Permission[] =
      action === "create"
        ? ["payments.create", "payments.adjust", "payments.edit"]
        : action === "archive"
          ? ["payments.edit", "payments.adjust"]
          : ["payments.edit", "payments.adjust", "payments.create"];
    if (!PermissionService.hasAnyPermission(permissions, allowed)) {
      const actionLabel =
        action === "create"
          ? "إنشاء متطالبات الدفع"
          : action === "edit"
            ? "تعديل متطالبات الدفع"
            : "أرشفة متطالبات الدفع";
      throw new ForbiddenError(`ليس لديك صلاحية ${actionLabel}.`);
    }
  }

  private static validateRequestName(name: string): string {
    const trimmed = (name || "").trim();
    if (!trimmed) {
      throw new ValidationError("اسم المتطلب مطلوب ولا يمكن أن يكون فارغًا.");
    }
    if (trimmed.length > 120) {
      throw new ValidationError("اسم المتطلب يجب ألا يتجاوز 120 حرفًا.");
    }
    return trimmed;
  }

  private static validateRequestAmount(amount: number): number {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("السعر يجب أن يكون رقمًا أكبر من صفر.");
    }
    const rounded = Math.round(amount * 100) / 100;
    if (Math.abs(amount - rounded) > 0.000001) {
      throw new ValidationError("السعر يجب ألا يتجاوز منزلتين عشريتين.");
    }
    return rounded;
  }

  private static normalizeReferenceMonth(
    referenceMonth?: string | null,
  ): string | null {
    if (referenceMonth === undefined || referenceMonth === null) {
      return null;
    }
    const trimmed = String(referenceMonth).trim();
    if (!trimmed) return null;
    if (trimmed.length > 60) {
      throw new ValidationError("الشهر المرجعي يجب ألا يتجاوز 60 حرفًا.");
    }
    return trimmed;
  }

  /**
   * Lists active groups in the current center along with the count of actively enrolled
   * students and active payment requests for each group.
   */
  static getGroupsWithStudentCounts(): GroupWithPaymentRequestSummary[] {
    const { centerId, user } = this.getActiveContext();
    this.ensureViewPermission(user.permissions);

    const db = DatabaseService.getDb();
    const groups = db.getAllSync<any>(
      `SELECT g.id, g.center_id as centerId, g.name, g.grade,
              g.teacher_id as teacherId, g.subject_id as subjectId,
              t.name as teacherName, s.name as subjectName
       FROM groups g
       LEFT JOIN teachers t ON g.teacher_id = t.id
       LEFT JOIN subjects s ON g.subject_id = s.id
       WHERE g.center_id = ? AND g.status = 'active'
       ORDER BY g.name ASC`,
      [centerId],
    );

    const activeEnrollments = db.getAllSync<any>(
      `SELECT e.group_id as groupId, e.student_id as studentId
       FROM student_group_enrollments e
       WHERE e.center_id = ? AND e.status = 'active'`,
      [centerId],
    );

    const activeStudents = db.getAllSync<any>(
      `SELECT id FROM students
       WHERE center_id = ? AND deleted_at IS NULL`,
      [centerId],
    );
    const activeStudentIds = new Set(
      activeStudents
        .filter((s) => (s.status || "active") === "active")
        .map((s) => s.id),
    );

    const activeRequests = db.getAllSync<any>(
      `SELECT id, group_id as groupId, status
       FROM group_payment_requests
       WHERE center_id = ? AND status = 'active'`,
      [centerId],
    );

    return groups.map((g) => {
      const groupStudentIds = new Set(
        activeEnrollments
          .filter(
            (e) =>
              (e.groupId || e.group_id) === g.id &&
              activeStudentIds.has(e.studentId || e.student_id),
          )
          .map((e) => e.studentId || e.student_id),
      );
      const groupRequestsCount = activeRequests.filter(
        (r) => (r.groupId || r.group_id) === g.id && r.status === "active",
      ).length;

      return {
        id: g.id,
        centerId: g.centerId || g.center_id || centerId,
        name: g.name,
        grade: g.grade || "",
        teacherId: g.teacherId || g.teacher_id || "",
        teacherName: g.teacherName || "",
        subjectId: g.subjectId || g.subject_id || "",
        subjectName: g.subjectName || "",
        activeStudentsCount: groupStudentIds.size,
        activeRequestsCount: groupRequestsCount,
      };
    });
  }

  private static roundCurrency(val: number): number {
    return Math.round((Number(val) || 0) * 100) / 100;
  }

  /**
   * Fetches all confirmed (non-reversed) payment_request payments for a center,
   * deduplicated by operation_id / id so synchronization never double-counts.
   * Never reads from sync_operations — only confirmed rows in `payments` count.
   */
  private static getConfirmedRequestPaymentsMap(centerId: string): {
    byObligationId: Map<string, any[]>;
    byRequestAndStudent: Map<string, any[]>;
  } {
    const db = DatabaseService.getDb();
    const rawPayments = db.getAllSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              student_id as studentId,
              payment_request_obligation_id as paymentRequestObligationId,
              payment_request_id as paymentRequestId,
              amount, payment_type as paymentType, payment_method as paymentMethod,
              payment_date as paymentDate, is_reversed as isReversed,
              created_at as createdAt
       FROM payments
       WHERE center_id = ?`,
      [centerId],
    );

    const seenKeys = new Set<string>();
    const byObligationId = new Map<string, any[]>();
    const byRequestAndStudent = new Map<string, any[]>();

    for (const p of rawPayments) {
      const isRev =
        p.isReversed === 1 ||
        p.isReversed === true ||
        p.is_reversed === 1 ||
        p.is_reversed === true;
      if (isRev) continue;

      const pType = p.paymentType || p.payment_type;
      const obId =
        p.paymentRequestObligationId ||
        p.payment_request_obligation_id ||
        null;
      const reqId = p.paymentRequestId || p.payment_request_id || null;
      if (pType !== "payment_request" && !obId && !reqId) continue;

      const dedupKey = String(
        p.operationId || p.operation_id || p.id || "",
      ).trim();
      if (!dedupKey || seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      if (obId) {
        const list = byObligationId.get(obId) || [];
        list.push(p);
        byObligationId.set(obId, list);
      } else if (reqId) {
        const sId = p.studentId || p.student_id || "";
        const compositeKey = `${reqId}::${sId}`;
        const list = byRequestAndStudent.get(compositeKey) || [];
        list.push(p);
        byRequestAndStudent.set(compositeKey, list);
      }
    }

    return { byObligationId, byRequestAndStudent };
  }

  private static resolveObligationConfirmedState(
    row: any,
    requestStatus: "active" | "archived",
    paymentsMap: {
      byObligationId: Map<string, any[]>;
      byRequestAndStudent: Map<string, any[]>;
    },
  ): {
    amountDue: number;
    confirmedAmountPaid: number;
    amountOwed: number;
    isPaid: boolean;
    isPartiallyPaid: boolean;
    effectiveStatus: "paid" | "unpaid" | "cancelled";
    paymentId: string | null;
    paidAt: string | null;
  } {
    const obId = row.id;
    const reqId = row.requestId || row.request_id;
    const studentId = row.studentId || row.student_id;
    const amountDue = this.roundCurrency(row.amountDue ?? row.amount_due);

    const directPayments = paymentsMap.byObligationId.get(obId) || [];
    const fallbackPayments =
      directPayments.length > 0
        ? []
        : paymentsMap.byRequestAndStudent.get(`${reqId}::${studentId}`) || [];
    const matchedPayments = [...directPayments, ...fallbackPayments].sort(
      (a, b) =>
        String(b.createdAt || b.created_at || "").localeCompare(
          String(a.createdAt || a.created_at || ""),
        ),
    );

    const rawConfirmedPaid = this.roundCurrency(
      matchedPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
    );
    const confirmedAmountPaid = this.roundCurrency(
      Math.min(amountDue, Math.max(0, rawConfirmedPaid)),
    );

    const isPaid =
      amountDue > 0 && confirmedAmountPaid >= amountDue - 0.000001;
    const isPartiallyPaid = !isPaid && confirmedAmountPaid > 0;
    const isCancelled =
      !isPaid &&
      (row.status === "cancelled" || requestStatus === "archived");
    const effectiveStatus: "paid" | "unpaid" | "cancelled" = isPaid
      ? "paid"
      : isCancelled
        ? "cancelled"
        : "unpaid";

    const amountOwed =
      effectiveStatus === "cancelled" || isPaid
        ? 0
        : this.roundCurrency(Math.max(0, amountDue - confirmedAmountPaid));

    const latestPayment = matchedPayments[0];
    const paymentId =
      confirmedAmountPaid > 0
        ? latestPayment?.id || row.paymentId || row.payment_id || null
        : null;
    const paidAt = isPaid
      ? row.paidAt ||
        row.paid_at ||
        latestPayment?.createdAt ||
        latestPayment?.created_at ||
        latestPayment?.paymentDate ||
        latestPayment?.payment_date ||
        null
      : null;

    return {
      amountDue,
      confirmedAmountPaid,
      amountOwed,
      isPaid,
      isPartiallyPaid,
      effectiveStatus,
      paymentId,
      paidAt,
    };
  }

  private static computeStatisticsFromObligations(
    obligations: StudentPaymentRequestObligation[],
  ): PaymentRequestCollectionStatistics {
    const totalStudents = obligations.length;
    let paidStudentsCount = 0;
    let unpaidStudentsCount = 0;
    let totalExpectedAmount = 0;
    let totalCollectedAmount = 0;
    let totalOutstandingAmount = 0;

    for (const ob of obligations) {
      const due = this.roundCurrency(ob.amountDue);
      const paid = this.roundCurrency(ob.confirmedAmountPaid ?? ob.amountPaid);
      const owed =
        ob.amountOwed !== undefined
          ? this.roundCurrency(ob.amountOwed)
          : ob.status === "cancelled" || ob.status === "paid"
            ? 0
            : this.roundCurrency(Math.max(0, due - paid));
      const studentPaid =
        ob.isPaid !== undefined
          ? ob.isPaid
          : ob.status === "paid" && paid >= due - 0.000001 && due > 0;

      totalExpectedAmount = this.roundCurrency(totalExpectedAmount + due);
      totalCollectedAmount = this.roundCurrency(totalCollectedAmount + paid);
      totalOutstandingAmount = this.roundCurrency(
        totalOutstandingAmount + owed,
      );

      if (studentPaid) {
        paidStudentsCount += 1;
      } else {
        unpaidStudentsCount += 1;
      }
    }

    const collectionPercentage =
      totalExpectedAmount > 0
        ? this.roundCurrency(
            Math.min(100, (totalCollectedAmount / totalExpectedAmount) * 100),
          )
        : 0;

    return {
      totalStudents,
      paidStudentsCount,
      unpaidStudentsCount,
      totalExpectedAmount,
      totalCollectedAmount,
      totalOutstandingAmount,
      collectionPercentage,
    };
  }

  /**
   * Lists payment requests belonging to a specific group in the active center,
   * including paid/unpaid student counts and collection metrics derived from confirmed payments.
   */
  static getRequestsForGroup(
    groupId: string,
    includeArchived = true,
  ): GroupPaymentRequest[] {
    const { centerId, user } = this.getActiveContext();
    this.ensureViewPermission(user.permissions);

    const db = DatabaseService.getDb();
    const group = db.getFirstSync<any>(
      `SELECT id, name FROM groups WHERE center_id = ? AND id = ?`,
      [centerId, groupId],
    );
    if (!group) {
      throw new NotFoundError("المجموعة غير موجودة في هذا المركز.");
    }

    const rows = db.getAllSync<any>(
      includeArchived
        ? `SELECT id, operation_id as operationId, center_id as centerId,
                  group_id as groupId, name, amount, reference_month as referenceMonth,
                  status, created_by as createdBy, created_by_name as createdByName,
                  updated_by as updatedBy, updated_by_name as updatedByName,
                  archived_by as archivedBy, archived_at as archivedAt,
                  created_at as createdAt, updated_at as updatedAt
           FROM group_payment_requests
           WHERE center_id = ? AND group_id = ?
           ORDER BY created_at DESC`
        : `SELECT id, operation_id as operationId, center_id as centerId,
                  group_id as groupId, name, amount, reference_month as referenceMonth,
                  status, created_by as createdBy, created_by_name as createdByName,
                  updated_by as updatedBy, updated_by_name as updatedByName,
                  archived_by as archivedBy, archived_at as archivedAt,
                  created_at as createdAt, updated_at as updatedAt
           FROM group_payment_requests
           WHERE center_id = ? AND group_id = ? AND status = 'active'
           ORDER BY created_at DESC`,
      [centerId, groupId],
    );

    const obligations = db.getAllSync<any>(
      `SELECT id, request_id as requestId, student_id as studentId,
              amount_due as amountDue, amount_paid as amountPaid, status,
              payment_id as paymentId, paid_at as paidAt
       FROM student_payment_request_obligations
       WHERE center_id = ? AND group_id = ?`,
      [centerId, groupId],
    );
    const paymentsMap = this.getConfirmedRequestPaymentsMap(centerId);

    return rows.map((row) => {
      const reqStatus: "active" | "archived" =
        row.status === "archived" ? "archived" : "active";
      const reqObligations = obligations.filter(
        (ob) => (ob.requestId || ob.request_id) === row.id,
      );
      const resolvedStates = reqObligations.map((ob) =>
        this.resolveObligationConfirmedState(ob, reqStatus, paymentsMap),
      );

      const paidCount = resolvedStates.filter(
        (st) => st.effectiveStatus === "paid",
      ).length;
      const unpaidCount = resolvedStates.filter(
        (st) => st.effectiveStatus === "unpaid",
      ).length;
      const cancelledCount = resolvedStates.filter(
        (st) => st.effectiveStatus === "cancelled",
      ).length;
      const totalExpected = this.roundCurrency(
        resolvedStates.reduce((sum, st) => sum + st.amountDue, 0),
      );
      const totalCollectedAmount = this.roundCurrency(
        resolvedStates.reduce((sum, st) => sum + st.confirmedAmountPaid, 0),
      );
      const totalOutstandingAmount = this.roundCurrency(
        resolvedStates.reduce((sum, st) => sum + st.amountOwed, 0),
      );
      const collectionPercentage =
        totalExpected > 0
          ? this.roundCurrency(
              Math.min(100, (totalCollectedAmount / totalExpected) * 100),
            )
          : 0;

      return {
        id: row.id,
        operationId: row.operationId || row.operation_id,
        centerId: row.centerId || row.center_id,
        groupId: row.groupId || row.group_id,
        groupName: group.name,
        name: row.name,
        amount: Number(row.amount) || 0,
        referenceMonth: row.referenceMonth ?? row.reference_month ?? null,
        status: reqStatus,
        createdBy: row.createdBy || row.created_by,
        createdByName: row.createdByName ?? row.created_by_name ?? null,
        updatedBy: row.updatedBy ?? row.updated_by ?? null,
        updatedByName: row.updatedByName ?? row.updated_by_name ?? null,
        archivedBy: row.archivedBy ?? row.archived_by ?? null,
        archivedAt: row.archivedAt ?? row.archived_at ?? null,
        createdAt: row.createdAt || row.created_at,
        updatedAt: row.updatedAt ?? row.updated_at ?? null,
        paidCount,
        unpaidCount,
        cancelledCount,
        totalObligationsCount: reqObligations.length,
        totalCollectedAmount,
        totalOutstandingAmount,
        collectionPercentage,
      };
    });
  }

  /**
   * Fetches a single payment request by ID in the active center.
   */
  static getRequestById(requestId: string): GroupPaymentRequest | null {
    const { centerId, user } = this.getActiveContext();
    this.ensureViewPermission(user.permissions);

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              group_id as groupId, name, amount, reference_month as referenceMonth,
              status, created_by as createdBy, created_by_name as createdByName,
              updated_by as updatedBy, updated_by_name as updatedByName,
              archived_by as archivedBy, archived_at as archivedAt,
              created_at as createdAt, updated_at as updatedAt
       FROM group_payment_requests
       WHERE center_id = ? AND id = ?`,
      [centerId, requestId],
    );
    if (!row) return null;

    const group = db.getFirstSync<any>(
      `SELECT id, name FROM groups WHERE center_id = ? AND id = ?`,
      [centerId, row.groupId || row.group_id],
    );
    const obligations = db.getAllSync<any>(
      `SELECT id, request_id as requestId, student_id as studentId,
              amount_due as amountDue, amount_paid as amountPaid, status,
              payment_id as paymentId, paid_at as paidAt
       FROM student_payment_request_obligations
       WHERE center_id = ? AND request_id = ?`,
      [centerId, requestId],
    );
    const reqStatus: "active" | "archived" =
      row.status === "archived" ? "archived" : "active";
    const paymentsMap = this.getConfirmedRequestPaymentsMap(centerId);
    const resolvedStates = obligations.map((ob) =>
      this.resolveObligationConfirmedState(ob, reqStatus, paymentsMap),
    );

    const paidCount = resolvedStates.filter(
      (st) => st.effectiveStatus === "paid",
    ).length;
    const unpaidCount = resolvedStates.filter(
      (st) => st.effectiveStatus === "unpaid",
    ).length;
    const cancelledCount = resolvedStates.filter(
      (st) => st.effectiveStatus === "cancelled",
    ).length;
    const totalExpected = this.roundCurrency(
      resolvedStates.reduce((sum, st) => sum + st.amountDue, 0),
    );
    const totalCollectedAmount = this.roundCurrency(
      resolvedStates.reduce((sum, st) => sum + st.confirmedAmountPaid, 0),
    );
    const totalOutstandingAmount = this.roundCurrency(
      resolvedStates.reduce((sum, st) => sum + st.amountOwed, 0),
    );
    const collectionPercentage =
      totalExpected > 0
        ? this.roundCurrency(
            Math.min(100, (totalCollectedAmount / totalExpected) * 100),
          )
        : 0;

    return {
      id: row.id,
      operationId: row.operationId || row.operation_id,
      centerId: row.centerId || row.center_id,
      groupId: row.groupId || row.group_id,
      groupName: group?.name || row.groupName || "",
      name: row.name,
      amount: Number(row.amount) || 0,
      referenceMonth: row.referenceMonth ?? row.reference_month ?? null,
      status: reqStatus,
      createdBy: row.createdBy || row.created_by,
      createdByName: row.createdByName ?? row.created_by_name ?? null,
      updatedBy: row.updatedBy ?? row.updated_by ?? null,
      updatedByName: row.updatedByName ?? row.updated_by_name ?? null,
      archivedBy: row.archivedBy ?? row.archived_by ?? null,
      archivedAt: row.archivedAt ?? row.archived_at ?? null,
      createdAt: row.createdAt || row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at ?? null,
      paidCount,
      unpaidCount,
      cancelledCount,
      totalObligationsCount: obligations.length,
      totalCollectedAmount,
      totalOutstandingAmount,
      collectionPercentage,
    };
  }

  /**
   * Lists student obligations for a specific payment request in the active center.
   * Each obligation's payment status and amounts are verified against confirmed non-reversed payments.
   */
  static getRequestObligations(
    requestId: string,
    statusFilter: "all" | "paid" | "unpaid" | "cancelled" = "all",
  ): StudentPaymentRequestObligation[] {
    const { centerId, user } = this.getActiveContext();
    this.ensureViewPermission(user.permissions);

    const request = this.getRequestById(requestId);
    if (!request) {
      throw new NotFoundError("متطلب الدفع غير موجود في هذا المركز.");
    }

    const db = DatabaseService.getDb();
    const rawObligations = db.getAllSync<any>(
      `SELECT o.id, o.operation_id as operationId, o.center_id as centerId,
              o.request_id as requestId, o.group_id as groupId, o.student_id as studentId,
              o.amount_due as amountDue, o.amount_paid as amountPaid,
              o.status, o.payment_id as paymentId, o.paid_at as paidAt,
              o.created_at as createdAt, o.updated_at as updatedAt, o.cancelled_at as cancelledAt,
              s.full_name as studentName, s.student_code as studentCode, s.card_code as cardCode
       FROM student_payment_request_obligations o
       LEFT JOIN students s ON s.id = o.student_id AND s.center_id = o.center_id
       WHERE o.center_id = ? AND o.request_id = ?
       ORDER BY o.created_at ASC`,
      [centerId, requestId],
    );

    const students = db.getAllSync<any>(
      `SELECT id, full_name as fullName, student_code as studentCode, card_code as cardCode
       FROM students WHERE center_id = ?`,
      [centerId],
    );
    const studentsById = new Map(students.map((s) => [s.id, s]));
    const paymentsMap = this.getConfirmedRequestPaymentsMap(centerId);

    let mapped: StudentPaymentRequestObligation[] = rawObligations.map(
      (row) => {
        const studentId = row.studentId || row.student_id;
        const std = studentsById.get(studentId);
        const resolved = this.resolveObligationConfirmedState(
          row,
          request.status,
          paymentsMap,
        );
        return {
          id: row.id,
          operationId: row.operationId || row.operation_id,
          centerId: row.centerId || row.center_id,
          requestId: row.requestId || row.request_id,
          groupId: row.groupId || row.group_id,
          studentId,
          amountDue: resolved.amountDue,
          amountPaid: resolved.confirmedAmountPaid,
          confirmedAmountPaid: resolved.confirmedAmountPaid,
          amountOwed: resolved.amountOwed,
          isPaid: resolved.isPaid,
          isPartiallyPaid: resolved.isPartiallyPaid,
          status: resolved.effectiveStatus,
          paymentId: resolved.paymentId,
          paidAt: resolved.paidAt,
          createdAt: row.createdAt || row.created_at,
          updatedAt: row.updatedAt ?? row.updated_at ?? null,
          cancelledAt: row.cancelledAt ?? row.cancelled_at ?? null,
          requestName: request.name,
          referenceMonth: request.referenceMonth,
          requestStatus: request.status,
          groupName: request.groupName,
          studentName:
            row.studentName ||
            row.student_name ||
            std?.fullName ||
            std?.full_name ||
            "",
          studentCode:
            row.studentCode ||
            row.student_code ||
            std?.studentCode ||
            std?.student_code ||
            "",
          cardCode:
            row.cardCode ||
            row.card_code ||
            std?.cardCode ||
            std?.card_code ||
            null,
        };
      },
    );

    if (statusFilter === "paid") {
      mapped = mapped.filter((item) => item.isPaid === true);
    } else if (statusFilter === "unpaid") {
      mapped = mapped.filter(
        (item) => item.isPaid !== true && item.status !== "cancelled",
      );
    } else if (statusFilter === "cancelled") {
      mapped = mapped.filter((item) => item.status === "cancelled");
    }

    return mapped.sort((a, b) =>
      String(a.studentName || "").localeCompare(
        String(b.studentName || ""),
        "ar",
      ),
    );
  }

  /**
   * Computes real-time collection statistics for a specific payment request
   * from actual student obligations and confirmed non-reversed payment records.
   */
  static getRequestStatistics(
    requestId: string,
  ): PaymentRequestCollectionStatistics {
    const obligations = this.getRequestObligations(requestId, "all");
    return this.computeStatisticsFromObligations(obligations);
  }

  /**
   * Returns complete details for an individual payment request:
   * - Request metadata (name, amount, group, optional referenceMonth, status)
   * - Real-time collection statistics dashboard
   * - Assigned students list filtered by ('all' | 'paid' | 'unpaid') and searched by
   *   student name or student code strictly within this payment request and center.
   */
  static getRequestDetails(
    requestId: string,
    options?: {
      filter?: PaymentRequestFilterType;
      searchQuery?: string;
    },
  ): PaymentRequestDetailsResult {
    const request = this.getRequestById(requestId);
    if (!request) {
      throw new NotFoundError("متطلب الدفع غير موجود في هذا المركز.");
    }

    const allStudents = this.getRequestObligations(requestId, "all");
    const statistics = this.computeStatisticsFromObligations(allStudents);

    const filter: PaymentRequestFilterType = options?.filter || "all";
    let filtered = allStudents.filter((student) => {
      if (filter === "paid") return Boolean(student.isPaid);
      if (filter === "unpaid") return !Boolean(student.isPaid);
      return true;
    });

    const query = (options?.searchQuery || "").trim();
    if (query) {
      const normalizedQuery = query.toLowerCase();
      const directMatches = filtered.filter((s) => {
        const nameMatch = String(s.studentName || "")
          .toLowerCase()
          .includes(normalizedQuery);
        const codeMatch = String(s.studentCode || "")
          .toLowerCase()
          .includes(normalizedQuery);
        return nameMatch || codeMatch;
      });
      const smartMatches = smartSearch(filtered, query, [
        { get: (o) => o.studentName || "", weight: 1.4 },
        { get: (o) => o.studentCode || "", weight: 1.2 },
      ]);
      const mergedIds = new Set<string>();
      const combined: StudentPaymentRequestObligation[] = [];
      for (const item of [...directMatches, ...smartMatches]) {
        if (!mergedIds.has(item.id)) {
          mergedIds.add(item.id);
          combined.push(item);
        }
      }
      filtered = combined;
    }

    return {
      request,
      statistics,
      students: filtered,
      obligations: filtered,
      allStudents,
      activeFilter: filter,
      displayedCount: filtered.length,
    };
  }

  /**
   * Lists all payment request obligations for a specific student in the active center.
   */
  static getStudentObligations(
    studentId: string,
  ): StudentPaymentRequestObligation[] {
    const { centerId, user } = this.getActiveContext();
    this.ensureViewPermission(user.permissions);

    const db = DatabaseService.getDb();
    const rawObligations = db.getAllSync<any>(
      `SELECT o.id, o.operation_id as operationId, o.center_id as centerId,
              o.request_id as requestId, o.group_id as groupId, o.student_id as studentId,
              o.amount_due as amountDue, o.amount_paid as amountPaid,
              o.status, o.payment_id as paymentId, o.paid_at as paidAt,
              o.created_at as createdAt, o.updated_at as updatedAt, o.cancelled_at as cancelledAt,
              r.name as requestName, r.reference_month as referenceMonth, r.status as requestStatus,
              g.name as groupName
       FROM student_payment_request_obligations o
       LEFT JOIN group_payment_requests r ON r.id = o.request_id AND r.center_id = o.center_id
       LEFT JOIN groups g ON g.id = o.group_id AND g.center_id = o.center_id
       WHERE o.center_id = ? AND o.student_id = ?
       ORDER BY o.created_at DESC`,
      [centerId, studentId],
    );
    const paymentsMap = this.getConfirmedRequestPaymentsMap(centerId);

    return rawObligations.map((row) => {
      const reqStatus: "active" | "archived" =
        (row.requestStatus || row.request_status) === "archived"
          ? "archived"
          : "active";
      const resolved = this.resolveObligationConfirmedState(
        row,
        reqStatus,
        paymentsMap,
      );
      return {
        id: row.id,
        operationId: row.operationId || row.operation_id,
        centerId: row.centerId || row.center_id,
        requestId: row.requestId || row.request_id,
        groupId: row.groupId || row.group_id,
        studentId: row.studentId || row.student_id,
        amountDue: resolved.amountDue,
        amountPaid: resolved.confirmedAmountPaid,
        confirmedAmountPaid: resolved.confirmedAmountPaid,
        amountOwed: resolved.amountOwed,
        isPaid: resolved.isPaid,
        isPartiallyPaid: resolved.isPartiallyPaid,
        status: resolved.effectiveStatus,
        paymentId: resolved.paymentId,
        paidAt: resolved.paidAt,
        createdAt: row.createdAt || row.created_at,
        updatedAt: row.updatedAt ?? row.updated_at ?? null,
        cancelledAt: row.cancelledAt ?? row.cancelled_at ?? null,
        requestName: row.requestName || row.request_name || undefined,
        referenceMonth: row.referenceMonth ?? row.reference_month ?? null,
        requestStatus: reqStatus,
        groupName: row.groupName || row.group_name || undefined,
      };
    });
  }

  /**
   * Creates a group payment request and generates one independent financial obligation
   * for each student actively enrolled in the selected group at the time of creation.
   * Supports offline-first idempotency via operationId.
   */
  static async createRequest(params: {
    groupId: string;
    name: string;
    amount: number;
    referenceMonth?: string | null;
    operationId?: string;
  }): Promise<CreatePaymentRequestResult> {
    const { centerId, user } = this.getActiveContext();
    this.ensureManagePermission(user.permissions, "create");

    if (!params.groupId || !params.groupId.trim()) {
      throw new ValidationError("يجب اختيار المجموعة.");
    }
    const normalizedName = this.validateRequestName(params.name);
    const normalizedAmount = this.validateRequestAmount(params.amount);
    const normalizedMonth = this.normalizeReferenceMonth(params.referenceMonth);

    const db = DatabaseService.getDb();
    const operationId = params.operationId || `op-preq-${generateUUID()}`;

    // Idempotency check by operation_id
    const existingByOp = db.getFirstSync<any>(
      `SELECT id, operation_id as operationId, center_id as centerId,
              group_id as groupId, name, amount, reference_month as referenceMonth,
              status
       FROM group_payment_requests
       WHERE operation_id = ?`,
      [operationId],
    );
    if (existingByOp) {
      const existingCenterId = existingByOp.centerId || existingByOp.center_id;
      const existingGroupId = existingByOp.groupId || existingByOp.group_id;
      const existingMonth =
        existingByOp.referenceMonth ?? existingByOp.reference_month ?? null;
      if (
        existingCenterId !== centerId ||
        existingGroupId !== params.groupId ||
        existingByOp.name !== normalizedName ||
        Math.abs(Number(existingByOp.amount) - normalizedAmount) > 0.000001 ||
        existingMonth !== normalizedMonth
      ) {
        throw new ConflictError(
          "معرّف العملية مستخدم لمتطلب دفع ببيانات مختلفة.",
        );
      }
      const existingRequest = this.getRequestById(existingByOp.id)!;
      const existingObligations = this.getRequestObligations(existingByOp.id);
      return {
        request: existingRequest,
        obligations: existingObligations,
        affectedStudentsCount: existingObligations.length,
        groupName: existingRequest.groupName || "",
      };
    }

    const group = db.getFirstSync<any>(
      `SELECT id, name, status FROM groups WHERE center_id = ? AND id = ?`,
      [centerId, params.groupId],
    );
    if (!group) {
      throw new NotFoundError("المجموعة غير موجودة في هذا المركز.");
    }
    if (group.status !== "active") {
      throw new ValidationError("لا يمكن إنشاء متطلب دفع لمجموعة غير نشطة.");
    }

    // Identify students actively enrolled in this group at the moment of creation
    const activeEnrollments = db.getAllSync<any>(
      `SELECT student_id as studentId
       FROM student_group_enrollments
       WHERE center_id = ? AND group_id = ? AND status = 'active'`,
      [centerId, params.groupId],
    );
    const activeStudents = db.getAllSync<any>(
      `SELECT id, status, deleted_at as deletedAt
       FROM students
       WHERE center_id = ? AND deleted_at IS NULL`,
      [centerId],
    );
    const eligibleStudentIdsSet = new Set<string>();
    const validActiveStudents = new Set(
      activeStudents
        .filter(
          (s) =>
            (s.status || "active") === "active" &&
            !s.deletedAt &&
            !s.deleted_at,
        )
        .map((s) => s.id),
    );
    for (const enrollment of activeEnrollments) {
      const sId = enrollment.studentId || enrollment.student_id;
      if (sId && validActiveStudents.has(sId)) {
        eligibleStudentIdsSet.add(sId);
      }
    }
    const eligibleStudentIds = Array.from(eligibleStudentIdsSet);

    const requestId = `preq-${generateUUID()}`;
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();

    const createdObligations: StudentPaymentRequestObligation[] = [];

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO group_payment_requests
           (id, operation_id, center_id, group_id, name, amount, reference_month, status, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          requestId,
          operationId,
          centerId,
          params.groupId,
          normalizedName,
          normalizedAmount,
          normalizedMonth,
          user.id,
          user.fullName || null,
          now,
        ],
      );

      for (const studentId of eligibleStudentIds) {
        const obId = `prob-${generateUUID()}`;
        const obOpId = `${operationId}-ob-${studentId}`;
        db.runSync(
          `INSERT INTO student_payment_request_obligations
             (id, operation_id, center_id, request_id, group_id, student_id, amount_due, amount_paid, status, payment_id, paid_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', NULL, NULL, ?)`,
          [
            obId,
            obOpId,
            centerId,
            requestId,
            params.groupId,
            studentId,
            normalizedAmount,
            now,
          ],
        );

        const obligationRecord: StudentPaymentRequestObligation = {
          id: obId,
          operationId: obOpId,
          centerId,
          requestId,
          groupId: params.groupId,
          studentId,
          amountDue: normalizedAmount,
          amountPaid: 0,
          status: "unpaid",
          paymentId: null,
          paidAt: null,
          createdAt: now,
          updatedAt: null,
          cancelledAt: null,
          requestName: normalizedName,
          referenceMonth: normalizedMonth,
          requestStatus: "active",
          groupName: group.name,
        };
        createdObligations.push(obligationRecord);

        SyncRepository.enqueueOperation({
          centerId,
          userId: user.id,
          deviceId,
          operationType: "payment_request_obligation.create",
          entityType: "payment_request_obligation",
          entityId: obId,
          payload: obligationRecord,
          operationId: obOpId,
        });
      }

      const requestPayload: GroupPaymentRequest = {
        id: requestId,
        operationId,
        centerId,
        groupId: params.groupId,
        groupName: group.name,
        name: normalizedName,
        amount: normalizedAmount,
        referenceMonth: normalizedMonth,
        status: "active",
        createdBy: user.id,
        createdByName: user.fullName || null,
        createdAt: now,
        paidCount: 0,
        unpaidCount: createdObligations.length,
        cancelledCount: 0,
        totalObligationsCount: createdObligations.length,
      };

      SyncRepository.enqueueOperation({
        centerId,
        userId: user.id,
        deviceId,
        operationType: "payment_request.create",
        entityType: "payment_request",
        entityId: requestId,
        payload: {
          ...requestPayload,
          studentIds: eligibleStudentIds,
        },
        operationId,
      });

      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "payment_request",
        entityId: requestId,
        action: "payment_request.create",
        payload: {
          groupId: params.groupId,
          groupName: group.name,
          name: normalizedName,
          amount: normalizedAmount,
          referenceMonth: normalizedMonth,
          affectedStudentsCount: createdObligations.length,
          actorName: user.fullName,
        },
      });

      DatabaseService.notifyLocalChange({
        centerId,
        entityType: "payment_request",
        entityId: requestId,
      });
    });

    const request = this.getRequestById(requestId)!;
    const obligations = this.getRequestObligations(requestId);
    return {
      request,
      obligations,
      affectedStudentsCount: obligations.length,
      groupName: group.name,
    };
  }

  /**
   * Edits an existing active group payment request.
   * - Updates request name, amount, and optional reference month.
   * - If amount changes, updates ONLY unpaid obligations (`status = 'unpaid'`).
   * - Already-paid obligations (`status = 'paid'`) remain historically accurate.
   */
  static async updateRequest(params: {
    requestId: string;
    name: string;
    amount: number;
    referenceMonth?: string | null;
    operationId?: string;
  }): Promise<GroupPaymentRequest> {
    const { centerId, user } = this.getActiveContext();
    this.ensureManagePermission(user.permissions, "edit");

    const normalizedName = this.validateRequestName(params.name);
    const normalizedAmount = this.validateRequestAmount(params.amount);
    const normalizedMonth = this.normalizeReferenceMonth(params.referenceMonth);

    const existing = this.getRequestById(params.requestId);
    if (!existing) {
      throw new NotFoundError("متطلب الدفع غير موجود في هذا المركز.");
    }
    if (existing.status === "archived") {
      throw new ValidationError("لا يمكن تعديل متطلب دفع مؤرشف.");
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const operationId = params.operationId || `op-preq-upd-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const amountChanged =
      Math.abs(existing.amount - normalizedAmount) > 0.000001;

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE group_payment_requests
         SET name = ?, amount = ?, reference_month = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
         WHERE center_id = ? AND id = ?`,
        [
          normalizedName,
          normalizedAmount,
          normalizedMonth,
          user.id,
          user.fullName || null,
          now,
          centerId,
          params.requestId,
        ],
      );

      if (amountChanged) {
        db.runSync(
          `UPDATE student_payment_request_obligations
           SET amount_due = ?, updated_at = ?
           WHERE center_id = ? AND request_id = ? AND status = 'unpaid'`,
          [normalizedAmount, now, centerId, params.requestId],
        );
      }

      SyncRepository.enqueueOperation({
        centerId,
        userId: user.id,
        deviceId,
        operationType: "payment_request.update",
        entityType: "payment_request",
        entityId: params.requestId,
        payload: {
          id: params.requestId,
          centerId,
          groupId: existing.groupId,
          name: normalizedName,
          amount: normalizedAmount,
          referenceMonth: normalizedMonth,
          updatedBy: user.id,
          updatedByName: user.fullName || null,
          updatedAt: now,
          amountChanged,
        },
        operationId,
      });

      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "payment_request",
        entityId: params.requestId,
        action: "payment_request.update",
        payload: {
          groupId: existing.groupId,
          previousName: existing.name,
          newName: normalizedName,
          previousAmount: existing.amount,
          newAmount: normalizedAmount,
          previousReferenceMonth: existing.referenceMonth,
          newReferenceMonth: normalizedMonth,
          updatedBy: user.id,
          actorName: user.fullName,
        },
      });

      DatabaseService.notifyLocalChange({
        centerId,
        entityType: "payment_request",
        entityId: params.requestId,
      });
    });

    return this.getRequestById(params.requestId)!;
  }

  /**
   * Archives a group payment request safely without deleting financial history:
   * - Sets request status to 'archived'.
   * - Cancels unpaid obligations (`status = 'cancelled'`) so they no longer count toward unpaid debt.
   * - Preserves paid obligations (`status = 'paid'`) and their collected payment records.
   */
  static async archiveRequest(params: {
    requestId: string;
    reason?: string;
    operationId?: string;
  }): Promise<GroupPaymentRequest> {
    const { centerId, user } = this.getActiveContext();
    this.ensureManagePermission(user.permissions, "archive");

    const existing = this.getRequestById(params.requestId);
    if (!existing) {
      throw new NotFoundError("متطلب الدفع غير موجود في هذا المركز.");
    }
    if (existing.status === "archived") {
      return existing;
    }

    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const operationId = params.operationId || `op-preq-arch-${generateUUID()}`;
    const deviceId = DeviceService.getDeviceIdSync();

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE group_payment_requests
         SET status = 'archived', archived_by = ?, archived_at = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
         WHERE center_id = ? AND id = ?`,
        [
          user.id,
          now,
          user.id,
          user.fullName || null,
          now,
          centerId,
          params.requestId,
        ],
      );

      db.runSync(
        `UPDATE student_payment_request_obligations
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE center_id = ? AND request_id = ? AND status = 'unpaid'`,
        [now, now, centerId, params.requestId],
      );

      SyncRepository.enqueueOperation({
        centerId,
        userId: user.id,
        deviceId,
        operationType: "payment_request.archive",
        entityType: "payment_request",
        entityId: params.requestId,
        payload: {
          id: params.requestId,
          centerId,
          groupId: existing.groupId,
          status: "archived",
          archivedBy: user.id,
          archivedAt: now,
          reason: params.reason?.trim() || null,
        },
        operationId,
      });

      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "payment_request",
        entityId: params.requestId,
        action: "payment_request.archive",
        payload: {
          groupId: existing.groupId,
          name: existing.name,
          amount: existing.amount,
          reason: params.reason?.trim() || null,
          paidCountPreserved: existing.paidCount ?? 0,
          unpaidCountCancelled: existing.unpaidCount ?? 0,
          actorName: user.fullName,
        },
      });

      DatabaseService.notifyLocalChange({
        centerId,
        entityType: "payment_request",
        entityId: params.requestId,
      });
    });

    return this.getRequestById(params.requestId)!;
  }

  /**
   * Records a student payment against a specific payment request obligation
   * using the existing PaymentRepository payment collection architecture.
   */
  static async recordObligationPayment(params: {
    obligationId: string;
    amount?: number;
    paymentMethod?: string;
    paymentDate?: string;
    notes?: string;
    operationId?: string;
  }): Promise<PaymentEvent> {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "payments.create")) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل المدفوعات.");
    }

    const db = DatabaseService.getDb();
    const obligation = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, request_id as requestId,
              group_id as groupId, student_id as studentId,
              amount_due as amountDue, status
       FROM student_payment_request_obligations
       WHERE center_id = ? AND id = ?`,
      [centerId, params.obligationId],
    );
    if (!obligation) {
      throw new NotFoundError(
        "المطالبة المالية للطالب غير موجودة في هذا المركز.",
      );
    }

    const paymentsMap = this.getConfirmedRequestPaymentsMap(centerId);
    const resolved = this.resolveObligationConfirmedState(
      obligation,
      "active",
      paymentsMap,
    );
    const paymentAmount =
      params.amount !== undefined
        ? Number(params.amount)
        : resolved.amountOwed > 0
          ? resolved.amountOwed
          : Number(obligation.amountDue ?? obligation.amount_due) || 0;

    return PaymentRepository.recordPayment({
      studentId: obligation.studentId || obligation.student_id,
      amount: paymentAmount,
      paymentType: "payment_request",
      paymentRequestObligationId: obligation.id,
      paymentRequestId: obligation.requestId || obligation.request_id,
      paymentMethod: params.paymentMethod,
      paymentDate: params.paymentDate,
      notes: params.notes,
      operationId: params.operationId,
    });
  }
}
