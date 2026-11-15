import { AuditService } from "../../core/audit";
import { env } from "../../config/env";
import { DatabaseService } from "../../core/database";
import { LocalDataEvents } from "../../core/database/localDataEvents";
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
  NotificationChannel,
  NotificationDelivery,
  NotificationEvent,
  NotificationEventType,
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import {
  HomeworkEvaluationRepository,
  normalizeSessionDateOnly,
} from "../homework/HomeworkEvaluationRepository";
import {
  DEFAULT_TEMPLATES,
  NotificationTemplateRepository,
  renderTemplate,
} from "./NotificationTemplateRepository";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function deterministicHash32(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hex1}${hex2}`;
}

export interface HomeworkNotificationPreviewItem {
  studentId: string;
  studentName: string;
  studentCode: string;
  groupName: string;
  subjectName: string;
  teacherName: string;
  sessionDate: string;
  homeworkStatus: string;
  statusId: string;
  recipientPhone: string;
  renderedMessage: string;
}

/**
 * Provider interface — swappable per channel.
 * In Sprint 5 all providers use the mock/local implementation.
 */
export interface NotificationProvider {
  channel: NotificationChannel;
  send(
    recipient: string,
    message: string,
  ): Promise<{ success: boolean; error?: string }>;
}

/** Mock push provider — queues locally, does not call external APIs */
export class LocalPushNotificationProvider implements NotificationProvider {
  channel: NotificationChannel = "push";
  async send(
    recipient: string,
    message: string,
  ): Promise<{ success: boolean }> {
    return { success: true };
  }
}

/** Test/mock SMS provider. Production SMS is still delivered by ZADX on the
 * backend after the queued delivery syncs, so no fake local send is reported
 * to a real user. */
export class LocalSmsNotificationProvider implements NotificationProvider {
  channel: NotificationChannel = "sms";
  async send(
    _recipient: string,
    _message: string,
  ): Promise<{ success: boolean }> {
    return { success: true };
  }
}

/** Mock SMS provider — queues locally, does not call external APIs */
const PROVIDERS: Partial<Record<NotificationChannel, NotificationProvider>> = {
  push: new LocalPushNotificationProvider(),
  sms: new LocalSmsNotificationProvider(),
};

export class NotificationService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  static findExplicitAbsence(
    centerId: string,
    sessionId: string,
    studentId: string,
  ): { id: string } | null {
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<{
      groupId: string | null;
      status: string;
    }>(
      `SELECT group_id as groupId, status FROM sessions
        WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );
    if (
      !session?.groupId ||
      String(session.status || "").toLowerCase() === "cancelled"
    ) {
      return null;
    }

    const canonicalSessionId = SyncRepository.resolveSessionAlias(
      centerId,
      sessionId,
    );
    const aliases = db.getAllSync<{ localSessionId: string }>(
      `SELECT aliases.local_session_id as localSessionId
         FROM session_id_aliases aliases
         LEFT JOIN sessions source
           ON source.center_id = aliases.center_id
          AND source.id = aliases.local_session_id
         LEFT JOIN sessions canonical
           ON canonical.center_id = aliases.center_id
          AND canonical.id = aliases.canonical_session_id
        WHERE aliases.center_id = ?
          AND aliases.canonical_session_id = ?
          AND NOT (
            (canonical.status = 'cancelled' AND source.status IS NOT NULL
              AND source.status <> 'cancelled')
            OR (source.status = 'cancelled' AND canonical.status IS NOT NULL
              AND canonical.status <> 'cancelled')
          )`,
      [centerId, canonicalSessionId],
    );
    const logicalSessionIds = Array.from(new Set([
      sessionId,
      canonicalSessionId,
      ...aliases.map((alias) => String(alias.localSessionId)),
    ]));
    const placeholders = logicalSessionIds.map(() => "?").join(", ");
    const attendance = db.getAllSync<{
      id: string;
      status: string;
      attendanceType: string | null;
    }>(
      `SELECT id, status, attendance_type as attendanceType
         FROM attendance
        WHERE center_id = ? AND student_id = ?
          AND session_id IN (${placeholders})`,
      [centerId, studentId, ...logicalSessionIds],
    );
    if (
      attendance.some((row) =>
        ["present", "late"].includes(String(row.status || "").toLowerCase()),
      )
    ) {
      return null;
    }
    const explicitAbsence = attendance.find(
      (row) =>
        String(row.status || "").toLowerCase() === "absent" &&
        String(row.attendanceType || "present").toLowerCase() !== "makeup",
    );
    if (!explicitAbsence) return null;

    const coverage = db.getFirstSync<{ id: string }>(
      `SELECT id FROM advance_coverages
        WHERE center_id = ? AND student_id = ?
          AND target_future_session_id IN (${placeholders})
        LIMIT 1`,
      [centerId, studentId, ...logicalSessionIds],
    );
    if (coverage) return null;

    const makeupAttendance = db.getAllSync<{ originalAbsenceId?: string | null }>(
      `SELECT original_absence_id as originalAbsenceId
         FROM attendance
        WHERE center_id = ? AND student_id = ?
          AND attendance_type = 'makeup'
          AND status IN ('present', 'late')
          AND original_absence_id IS NOT NULL`,
      [centerId, studentId],
    );
    const hasCompensated = makeupAttendance.some((row) => {
      const orig = String(row.originalAbsenceId || "");
      if (logicalSessionIds.includes(orig)) return true;
      for (const sid of logicalSessionIds) {
        if (orig === `absence-${sid}-${studentId}`) return true;
      }
      return false;
    });
    if (hasCompensated) return null;

    return { id: String(explicitAbsence.id) };
  }

  /**
   * Creates a notification event and schedules push + SMS deliveries.
   * Idempotent per operationId — no duplicate events.
   * Attendance must remain valid regardless of notification delivery status.
   */
  static createNotificationEvent(params: {
    operationId: string;
    studentId: string;
    sessionId: string;
    attendanceId?: string;
    sourceAttendanceId?: string;
    eventType: NotificationEventType;
    vars: Record<string, string>;
    customMessage?: string;
    channels?: NotificationChannel[];
    recipientType?: "student" | "parent";
  }): NotificationEvent {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إرسال الإشعارات.");
    }
    const db = DatabaseService.getDb();
    const validAbsence =
      params.eventType === "absence"
        ? this.findExplicitAbsence(
            centerId,
            params.sessionId,
            params.studentId,
          )
        : null;
    if (params.eventType === "absence" && !validAbsence) {
      throw new ConflictError(
        "لا يمكن إرسال إشعار الغياب دون غياب صريح صالح ومؤكد حاليًا.",
      );
    }

    // 1. Business event identity check:
    // For attendance notifications, attendance_id + event_type is strictly unique per center.
    // Even if a different operation_id is generated on retry/re-entry, duplicate events are prevented.
    if (params.attendanceId && params.eventType === "attendance") {
      const existingByAttendance = db.getAllSync<NotificationEvent>(
        `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
                session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
                template_id as templateId, created_by as createdBy, created_at as createdAt
         FROM notification_events
         WHERE center_id = ? AND attendance_id = ? AND event_type = ?`,
        [centerId, params.attendanceId, params.eventType],
      );
      if (existingByAttendance.length > 0) {
        return existingByAttendance[0];
      }
    }

    // 2. Operation ID idempotency check
    const existing = db.getAllSync<NotificationEvent>(
      `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
              session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
              template_id as templateId, created_by as createdBy, created_at as createdAt
       FROM notification_events
       WHERE center_id = ? AND operation_id = ?`,
      [centerId, params.operationId],
    );
    if (existing.length > 0) {
      return existing[0];
    }

    // Fetch student + parent phone
    const studentRow = db.getFirstSync<any>(
      `SELECT full_name, phone, parent_phone FROM students WHERE center_id = ? AND id = ?`,
      [centerId, params.studentId],
    );

    const eventId = `nevt-${generateUUID()}`;
    const now = new Date().toISOString();

    try {
      db.runSync(
        `INSERT INTO notification_events (id, operation_id, center_id, student_id, session_id, attendance_id, event_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          params.operationId,
          centerId,
          params.studentId,
          params.sessionId,
          params.attendanceId || null,
          params.eventType,
          user.id,
          now,
        ],
      );
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        if (params.attendanceId && params.eventType === "attendance") {
          const row = db.getFirstSync<NotificationEvent>(
            `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
                    session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
                    template_id as templateId, created_by as createdBy, created_at as createdAt
             FROM notification_events
             WHERE center_id = ? AND attendance_id = ? AND event_type = ?`,
            [centerId, params.attendanceId, params.eventType],
          );
          if (row) return row;
        }
        const opRow = db.getFirstSync<NotificationEvent>(
          `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
                  session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
                  template_id as templateId, created_by as createdBy, created_at as createdAt
           FROM notification_events
           WHERE center_id = ? AND operation_id = ?`,
          [centerId, params.operationId],
        );
        if (opRow) return opRow;
      }
      throw err;
    }

    const deviceId = DeviceService.getDeviceIdSync();

    // Enqueue sync operation
    SyncRepository.enqueueOperation({
      centerId,
      userId: user.id,
      deviceId,
      operationType: "create",
      entityType: "notification_event",
      entityId: eventId,
      operationId: params.operationId,
      payload: {
        eventId,
        eventType: params.eventType,
        studentId: params.studentId,
        sessionId: params.sessionId,
        attendanceId:
          params.attendanceId ||
          params.sourceAttendanceId ||
          validAbsence?.id ||
          undefined,
      },
    });

    // Create delivery records for both channels
    const channels: NotificationChannel[] = params.channels || ["push", "sms"];
    for (const channel of channels) {
      const template = NotificationTemplateRepository.getActiveTemplate(
        params.eventType,
        channel,
      );
      const bodyTemplate =
        params.customMessage ?? template?.templateBody ??
        `إشعار للطالب ${params.vars.student_name ?? ""}`;
      const renderedTemplate = renderTemplate(bodyTemplate, params.vars);
      const rendered = params.eventType === "grades" &&
        params.vars.homework_evaluation?.trim() &&
        !bodyTemplate.includes("{{homework_evaluation}}")
        ? `${renderedTemplate}\n${params.vars.homework_evaluation}`
        : renderedTemplate;

      const recipient =
        channel === "sms"
          ? params.recipientType === "student"
            ? studentRow?.phone || ""
            : params.recipientType === "parent"
              ? studentRow?.parent_phone || ""
              : studentRow?.parent_phone || studentRow?.phone || ""
          : studentRow?.phone || "";

      const deliveryId = `ndlv-${generateUUID()}`;
      try {
        db.runSync(
          `INSERT INTO notification_deliveries (id, center_id, notification_event_id, channel, status, recipient, rendered_message, retry_count, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?)`,
          [deliveryId, centerId, eventId, channel, recipient, rendered, now],
        );
      } catch {
        // If delivery already exists (idempotency), skip silently
      }

      // SMS is sent only by the backend provider. The mobile app stores the
      // rendered delivery and queues a stable operation; it never calls ZADX.
      if (channel === "sms") {
        SyncRepository.enqueueOperation({
          centerId,
          userId: user.id,
          deviceId,
          operationType: "create",
          entityType: "notification_delivery",
          entityId: deliveryId,
          operationId: `op-sms-${deliveryId}`,
          payload: {
            delivery: {
              id: deliveryId,
              notificationEventId: eventId,
              channel: "sms",
              status: "pending",
              recipient,
              renderedMessage: rendered,
              retryCount: 0,
            },
          },
        });
      }
    }

    AuditService.recordEvent({
      operationId: params.operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "notification_event",
      entityId: eventId,
      action: "notification_created",
      payload: {
        eventType: params.eventType,
        studentId: params.studentId,
        sessionId: params.sessionId,
      },
    });

    return {
      id: eventId,
      operationId: params.operationId,
      centerId,
      studentId: params.studentId,
      sessionId: params.sessionId,
      attendanceId: params.attendanceId || null,
      eventType: params.eventType,
      createdBy: user.id,
      createdAt: now,
    };
  }

  /**
   * Lists notification events for a session.
   */
  static getEventsForSession(sessionId: string): NotificationEvent[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الإشعارات.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<NotificationEvent>(
      `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
              session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
              template_id as templateId, created_by as createdBy, created_at as createdAt
       FROM notification_events
       WHERE center_id = ? AND session_id = ?
       ORDER BY created_at DESC`,
      [centerId, sessionId],
    );
  }

  /**
   * Lists notification events for a student.
   */
  static getEventsForStudent(studentId: string): NotificationEvent[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الإشعارات.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<NotificationEvent>(
      `SELECT id, operation_id as operationId, center_id as centerId, student_id as studentId,
              session_id as sessionId, attendance_id as attendanceId, event_type as eventType,
              template_id as templateId, created_by as createdBy, created_at as createdAt
       FROM notification_events
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );
  }

  /**
   * Lists deliveries for a notification event.
   */
  static getDeliveriesForEvent(eventId: string): NotificationDelivery[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.view")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض الإشعارات.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<NotificationDelivery>(
      `SELECT id, center_id as centerId, notification_event_id as notificationEventId,
              channel, status, recipient, rendered_message as renderedMessage,
              sent_at as sentAt, failure_reason as failureReason,
              retry_count as retryCount, provider_message_id as providerMessageId,
              created_at as createdAt, updated_at as updatedAt
       FROM notification_deliveries
       WHERE center_id = ? AND notification_event_id = ?`,
      [centerId, eventId],
    );
  }

  /**
   * Sends pending deliveries for a notification event.
   * Attendance validity is NOT affected by delivery outcome.
   */
  static async sendPendingDeliveries(eventId: string): Promise<{
    sent: number;
    failed: number;
  }> {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const event = db.getFirstSync<{
      eventType: string;
      sessionId: string;
      studentId: string;
    }>(
      `SELECT event_type as eventType, session_id as sessionId,
              student_id as studentId
         FROM notification_events
        WHERE center_id = ? AND id = ?`,
      [centerId, eventId],
    );

    const deliveries = db.getAllSync<any>(
      `SELECT id, channel, recipient, rendered_message as renderedMessage, retry_count as retryCount
       FROM notification_deliveries
       WHERE center_id = ? AND notification_event_id = ? AND status = 'pending'`,
      [centerId, eventId],
    );

    let sent = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (const delivery of deliveries) {
      if (
        event?.eventType === "absence" &&
        !this.findExplicitAbsence(
          centerId,
          event.sessionId,
          event.studentId,
        )
      ) {
        db.runSync(
          `UPDATE notification_deliveries
              SET status = ?, failure_reason = ?, updated_at = ?
            WHERE center_id = ? AND id = ? AND status = 'pending'`,
          [
            "failed",
            "غياب الطالب لم يعد صريحًا أو صالحًا؛ أُوقف الإرسال.",
            new Date().toISOString(),
            centerId,
            delivery.id,
          ],
        );
        failed++;
        continue;
      }
      // SMS deliveries are processed by the backend ZADX provider in
      // production. Mock/test mode uses a deterministic local provider so
      // offline unit tests can verify idempotency without sending real SMS.
      if (delivery.channel === "sms" && !env.enableMockData) continue;
      const provider = PROVIDERS[delivery.channel as NotificationChannel];
      if (!provider) continue;

      try {
        const result = await provider.send(
          delivery.recipient,
          delivery.renderedMessage,
        );
        if (result.success) {
          db.runSync(
            `UPDATE notification_deliveries SET status = ?, sent_at = ?, updated_at = ? WHERE id = ?`,
            ["sent", now, now, delivery.id],
          );
          sent++;
        } else {
          db.runSync(
            `UPDATE notification_deliveries SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
            ["failed", result.error || "فشل الإرسال", now, delivery.id],
          );
          failed++;
        }
      } catch (err: any) {
        db.runSync(
          `UPDATE notification_deliveries SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
          ["failed", err?.message || "خطأ غير متوقع", now, delivery.id],
        );
        failed++;
      }
    }

    return { sent, failed };
  }

  static getDeliveryStatusCounts(eventId: string): Record<NotificationDelivery["status"], number> {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.view") &&
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض حالة الإشعارات.");
    }
    const rows = DatabaseService.getDb().getAllSync<{ status: NotificationDelivery["status"] }>(
      `SELECT status FROM notification_deliveries
       WHERE center_id = ? AND notification_event_id = ?`,
      [centerId, eventId],
    );
    return rows.reduce<Record<NotificationDelivery["status"], number>>(
      (counts, row) => {
        counts[row.status] = (counts[row.status] || 0) + 1;
        return counts;
      },
      {
        pending: 0,
        queued: 0,
        sending: 0,
        accepted: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        ambiguous_outcome: 0,
      },
    );
  }

  /**
   * Builds the template variable map for a student and session.
   */
  static buildTemplateVariables(
    studentId: string,
    sessionId: string,
    attendanceStatus: string = "حاضر",
  ): Record<string, string> {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const student = db.getFirstSync<any>(
      `SELECT full_name, phone, parent_phone FROM students WHERE center_id = ? AND id = ?`,
      [centerId, studentId],
    );

    const center = db.getFirstSync<any>(
      `SELECT name FROM centers WHERE id = ?`,
      [centerId],
    );

    const session = db.getFirstSync<any>(
      `SELECT s.session_date, s.start_time,
              g.name as group_name, subj.name as subject_name, t.name as teacher_name
       FROM sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN teachers t ON COALESCE(s.teacher_id, g.teacher_id) = t.id
       WHERE s.center_id = ? AND s.id = ?`,
      [centerId, sessionId],
    );

    const fullName = String(student?.full_name || "").trim();
    return {
      student_name: fullName,
      student_first_name: fullName.split(/\s+/)[0] || "",
      parent_name: "ولي الأمر",
      center_name: center?.name || "",
      subject_name: session?.subject_name || "",
      teacher_name: session?.teacher_name || "",
      group_name: session?.group_name || "",
      session_date: session?.session_date || "",
      session_time: session?.start_time || "",
      attendance_status: attendanceStatus,
    };
  }

  /**
   * Helper to trigger attendance notification after successful attendance check-in.
   */
  static notifyAttendance(params: {
    studentId: string;
    sessionId: string;
    attendanceId: string;
    isLate?: boolean;
    operationId?: string;
  }): NotificationEvent {
    const opId = params.operationId || `op-notif-att-${params.attendanceId}`;
    const vars = this.buildTemplateVariables(
      params.studentId,
      params.sessionId,
      params.isLate ? "متأخر" : "حاضر",
    );

    return this.createNotificationEvent({
      operationId: opId,
      studentId: params.studentId,
      sessionId: params.sessionId,
      attendanceId: params.attendanceId,
      eventType: "attendance",
      vars,
    });
  }

  /**
   * Helper for manual absence notifications for selected students in a session.
   * Creates notification events ONLY for the selected students.
   * Does NOT modify attendance records.
   */
  static notifyAbsentees(params: {
    sessionId: string;
    selectedStudentIds: string[];
    operationPrefix?: string;
  }): NotificationEvent[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إرسال الإشعارات.");
    }
    const selectedAbsences = new Map<string, string>();
    for (const studentId of new Set(params.selectedStudentIds)) {
      const absence = this.findExplicitAbsence(
        centerId,
        params.sessionId,
        studentId,
      );
      if (!absence) {
        throw new ConflictError(
          "تغيّرت حالة أحد الطلاب؛ لا يمكن إرسال إشعار إلا عن غياب صريح صالح حاليًا.",
        );
      }
      selectedAbsences.set(studentId, absence.id);
    }
    const prefix = params.operationPrefix || `op-notif-abs-${params.sessionId}`;
    const events: NotificationEvent[] = [];

    for (const studentId of selectedAbsences.keys()) {
      const opId = `${prefix}-${studentId}`;
      const vars = this.buildTemplateVariables(
        studentId,
        params.sessionId,
        "غائب",
      );

      const event = this.createNotificationEvent({
        operationId: opId,
        studentId,
        sessionId: params.sessionId,
        sourceAttendanceId: selectedAbsences.get(studentId),
        eventType: "absence",
        vars,
      });
      events.push(event);
    }

    return events;
  }

  static hasAbsenceNotification(sessionId: string): boolean {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "notifications.view") && !PermissionService.hasPermission(user.permissions, "notifications.send")) return false;
    return Boolean(DatabaseService.getDb().getFirstSync<any>(
      `SELECT id FROM notification_events WHERE center_id = ? AND session_id = ? AND event_type = 'absence' LIMIT 1`,
      [centerId, sessionId],
    ));
  }

  static hasGradeNotification(examId: string, studentId: string): boolean {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "notifications.view") && !PermissionService.hasPermission(user.permissions, "notifications.send")) return false;
    return Boolean(DatabaseService.getDb().getFirstSync<any>(
      `SELECT id FROM notification_events WHERE center_id = ? AND student_id = ? AND event_type = 'grades' AND operation_id LIKE ? LIMIT 1`,
      [centerId, studentId, `op-g-${examId.slice(-8)}-${studentId.slice(-8)}-%`],
    ));
  }

  /** Sends the student's grade summary to the guardian using the SMS template. */
  static notifyGrades(params: {
    studentId: string;
    summary: string;
    examId?: string;
    sessionId?: string | null;
    examName?: string;
    score?: number | null;
    maxScore?: number | null;
    operationId?: string;
  }): NotificationEvent {
    const { centerId } = this.getActiveContext();
    NotificationTemplateRepository.ensureDefaultTemplates();
    const db = DatabaseService.getDb();
    const student = db.getFirstSync<any>("SELECT full_name FROM students WHERE center_id = ? AND id = ?", [centerId, params.studentId]);
    const center = db.getFirstSync<any>("SELECT name FROM centers WHERE id = ?", [centerId]);
    const exam = params.examId
      ? db.getFirstSync<any>("SELECT session_id, center_id FROM grade_exams WHERE center_id = ? AND id = ?", [centerId, params.examId])
      : null;
    if (params.examId && !exam) throw new Error("الامتحان غير موجود في هذا المركز.");
    if (params.examId && params.sessionId && params.sessionId !== (exam?.session_id || null)) {
      throw new Error("الحصة المرتبطة لا تطابق حصة الامتحان.");
    }
    const sessionId = params.examId ? exam?.session_id || null : params.sessionId || null;
    const homeworkEvaluation = sessionId
      ? HomeworkEvaluationRepository.getForSession(sessionId, params.studentId)
      : null;
    const event = this.createNotificationEvent({
      operationId: params.operationId || `op-notif-grades-${params.studentId}-${Date.now()}`,
      studentId: params.studentId,
      sessionId: sessionId || "",
      eventType: "grades",
      vars: {
        student_name: student?.full_name || "",
        student_first_name: String(student?.full_name || "").trim().split(/\s+/)[0] || "",
        parent_name: "ولي الأمر",
        center_name: center?.name || "",
        exam_name: params.examName || "",
        score: params.score == null ? "" : String(params.score),
        max_score: params.maxScore == null ? "" : String(params.maxScore),
        grades_summary: params.summary,
        homework_evaluation: homeworkEvaluation?.statusName
          ? `حالة الواجب: ${homeworkEvaluation.statusName}`
          : "",
      },
    });
    return event;
  }

  static notifyCustomSms(params: { studentId: string; message: string; recipientType?: "student" | "parent"; operationId?: string }): NotificationEvent {
    const message = params.message.trim();
    if (!message) throw new Error("نص الرسالة مطلوب.");
    return this.createNotificationEvent({
      operationId: params.operationId || `op-notif-custom-${params.studentId}-${Date.now()}`,
      studentId: params.studentId,
      sessionId: "",
      eventType: "custom",
      vars: this.buildTemplateVariables(params.studentId, "", ""),
      customMessage: message,
      channels: ["sms"],
      recipientType: params.recipientType || "parent",
    });
  }

  /**
   * Builds template variables for a student's homework evaluation in a session.
   * Strictly validates that the student attended the session and has a saved homework evaluation.
   */
  static buildHomeworkNotificationVariables(
    studentId: string,
    sessionId: string,
  ): {
    vars: Record<string, string>;
    studentName: string;
    studentCode: string;
    phone: string;
    parentPhone: string;
    groupName: string;
    subjectName: string;
    teacherName: string;
    sessionDate: string;
    homeworkStatus: string;
    statusId: string;
    evaluationId: string;
  } {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const sessionRow = db.getFirstSync<any>(
      `SELECT id, group_id as groupId, subject_id as subjectId, teacher_id as teacherId,
              session_date as sessionDate, start_time as startTime
       FROM sessions
       WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );
    if (!sessionRow) {
      throw new NotFoundError("الحصة غير موجودة في هذا المركز.");
    }

    const studentRow = db.getFirstSync<any>(
      `SELECT id, full_name, student_code, phone, parent_phone, deleted_at
       FROM students
       WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
      [centerId, studentId],
    );
    if (!studentRow) {
      throw new NotFoundError("الطالب غير موجود في هذا المركز.");
    }

    const attendanceRows = db.getAllSync<any>(
      `SELECT id, status
       FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    const attended = attendanceRows.some((r) =>
      ["present", "late"].includes(String(r.status || "").toLowerCase()),
    );
    if (!attended) {
      throw new ValidationError(
        "لا يمكن إرسال حالة الواجب لطالب غائب أو لم يحضر الحصة.",
      );
    }

    const evaluation = HomeworkEvaluationRepository.getForSession(
      sessionId,
      studentId,
    );
    if (!evaluation || !evaluation.statusId || !evaluation.statusName) {
      throw new ValidationError(
        "لا يمكن إرسال حالة الواجب لطالب لم يتم تقييمه بعد.",
      );
    }

    const groupRow = sessionRow.groupId
      ? db.getFirstSync<any>(
          `SELECT g.name as groupName, g.name, s.name as subjectName, t.name as teacherName
           FROM groups g
           LEFT JOIN subjects s ON g.subject_id = s.id
           LEFT JOIN teachers t ON g.teacher_id = t.id
           WHERE g.center_id = ? AND g.id = ?`,
          [centerId, sessionRow.groupId],
        )
      : null;

    const center = db.getFirstSync<any>(
      `SELECT name FROM centers WHERE id = ?`,
      [centerId],
    );

    const fullName = String(studentRow.full_name || "").trim();
    const groupName = String(
      groupRow?.groupName || groupRow?.name || sessionRow.groupName || "",
    );
    const subjectName = String(
      groupRow?.subjectName || sessionRow.subjectName || "",
    );
    const teacherName = String(
      groupRow?.teacherName || sessionRow.teacherName || "",
    );
    const sessionDate = normalizeSessionDateOnly(sessionRow.sessionDate);
    const homeworkStatus = String(evaluation.statusName || "");

    const vars: Record<string, string> = {
      student_name: fullName,
      student_first_name: fullName.split(/\s+/)[0] || "",
      parent_name: "ولي الأمر",
      center_name: String(center?.name || ""),
      group_name: groupName,
      subject_name: subjectName,
      teacher_name: teacherName,
      session_date: sessionDate,
      session_time: String(sessionRow.startTime || ""),
      homework_status: homeworkStatus,
      homework_evaluation: `حالة الواجب: ${homeworkStatus}`,
    };

    return {
      vars,
      studentName: fullName,
      studentCode: String(studentRow.student_code || ""),
      phone: String(studentRow.phone || ""),
      parentPhone: String(studentRow.parent_phone || ""),
      groupName,
      subjectName,
      teacherName,
      sessionDate,
      homeworkStatus,
      statusId: evaluation.statusId,
      evaluationId: evaluation.id,
    };
  }

  /**
   * Generates personalized preview messages for selected evaluated students in a session
   * using the active homework notification template.
   */
  static previewHomeworkNotifications(params: {
    sessionId: string;
    studentIds: string[];
    channel?: NotificationChannel;
    recipientType?: "parent" | "student";
    customTemplateBody?: string;
  }): HomeworkNotificationPreviewItem[] {
    const { user } = this.getActiveContext();
    if (
      !PermissionService.hasAnyPermission(user.permissions, [
        "notifications.view",
        "notifications.send",
        "homework.manage",
        "grades.manage",
        "attendance.create",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية معاينة إشعارات الواجب.");
    }

    const uniqueStudentIds = Array.from(
      new Set((params.studentIds || []).filter(Boolean)),
    );
    if (uniqueStudentIds.length === 0) {
      throw new ValidationError("يرجى اختيار طالب واحد على الأقل لمعاينة الإشعار.");
    }

    NotificationTemplateRepository.ensureDefaultTemplates();
    const channel: NotificationChannel = params.channel || "sms";
    const activeTemplate = NotificationTemplateRepository.getActiveTemplate(
      "homework",
      channel,
    );
    const templateBody =
      params.customTemplateBody?.trim() ||
      activeTemplate?.templateBody ||
      DEFAULT_TEMPLATES.homework[channel];

    return uniqueStudentIds.map((studentId) => {
      const info = this.buildHomeworkNotificationVariables(
        studentId,
        params.sessionId,
      );
      const renderedMessage = renderTemplate(templateBody, info.vars);
      const recipientPhone =
        params.recipientType === "student"
          ? info.phone
          : info.parentPhone || info.phone;

      return {
        studentId,
        studentName: info.studentName,
        studentCode: info.studentCode,
        groupName: info.groupName,
        subjectName: info.subjectName,
        teacherName: info.teacherName,
        sessionDate: info.sessionDate,
        homeworkStatus: info.homeworkStatus,
        statusId: info.statusId,
        recipientPhone,
        renderedMessage,
      };
    });
  }

  /**
   * Sends individual homework evaluation notifications for one or more evaluated students.
   * - Rejects unevaluated or absent students.
   * - Uses a deterministic compact operationId (<= 48 chars) per (center, session, student, status)
   *   so repeated presses or sync retries never create duplicate notifications or exceed VARCHAR(64).
   */
  static notifyHomeworkEvaluations(params: {
    sessionId: string;
    studentIds: string[];
    recipientType?: "parent" | "student";
    channels?: NotificationChannel[];
    customTemplateBody?: string;
    operationIdByStudent?: Record<string, string>;
  }): NotificationEvent[] {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إرسال الإشعارات.");
    }

    const uniqueStudentIds = Array.from(
      new Set((params.studentIds || []).filter(Boolean)),
    );
    if (uniqueStudentIds.length === 0) {
      throw new ValidationError(
        "يرجى اختيار طالب واحد على الأقل لإرسال حالة الواجب.",
      );
    }

    NotificationTemplateRepository.ensureDefaultTemplates();

    // Validate all selected students upfront before creating any notification events
    const prepared = uniqueStudentIds.map((studentId) => {
      const info = this.buildHomeworkNotificationVariables(
        studentId,
        params.sessionId,
      );
      const explicitOpId = params.operationIdByStudent?.[studentId];
      const deterministicOpId = `op-hw-notif-${deterministicHash32(
        `${centerId}:${params.sessionId}:${studentId}:${info.statusId}`,
      )}`;
      return {
        studentId,
        info,
        operationId: explicitOpId || deterministicOpId,
      };
    });

    const events: NotificationEvent[] = [];
    for (const item of prepared) {
      const event = this.createNotificationEvent({
        operationId: item.operationId,
        studentId: item.studentId,
        sessionId: params.sessionId,
        eventType: "homework",
        vars: item.info.vars,
        customMessage: params.customTemplateBody?.trim() || undefined,
        channels: params.channels || ["push", "sms"],
        recipientType: params.recipientType || "parent",
      });
      events.push(event);
    }

    LocalDataEvents.emit();
    return events;
  }

  static hasHomeworkNotification(
    sessionId: string,
    studentId?: string,
  ): boolean {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.view") &&
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      return false;
    }
    const db = DatabaseService.getDb();
    if (studentId) {
      return Boolean(
        db.getFirstSync<any>(
          `SELECT id FROM notification_events
           WHERE center_id = ? AND session_id = ? AND student_id = ? AND event_type = 'homework'
           LIMIT 1`,
          [centerId, sessionId, studentId],
        ),
      );
    }
    return Boolean(
      db.getFirstSync<any>(
        `SELECT id FROM notification_events
         WHERE center_id = ? AND session_id = ? AND event_type = 'homework'
         LIMIT 1`,
        [centerId, sessionId],
      ),
    );
  }
}
