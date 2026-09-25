import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ForbiddenError, UnauthorizedError } from "../../core/errors";
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

/** Mock SMS provider — queues locally, does not call external APIs */
const PROVIDERS: Partial<Record<NotificationChannel, NotificationProvider>> = {
  push: new LocalPushNotificationProvider(),
};

export class NotificationService {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
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
    eventType: NotificationEventType;
    vars: Record<string, string>;
  }): NotificationEvent {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "notifications.send")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إرسال الإشعارات.");
    }
    const db = DatabaseService.getDb();

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
      },
    });

    // Create delivery records for both channels
    const channels: NotificationChannel[] = ["push", "sms"];
    for (const channel of channels) {
      const template = NotificationTemplateRepository.getActiveTemplate(
        params.eventType,
        channel,
      );
      const bodyTemplate =
        template?.templateBody ??
        `إشعار للطالب ${params.vars.student_name ?? ""}`;
      const rendered = renderTemplate(bodyTemplate, params.vars);

      const recipient =
        channel === "sms"
          ? studentRow?.parent_phone || studentRow?.phone || ""
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
              retry_count as retryCount, created_at as createdAt, updated_at as updatedAt
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
      // SMS deliveries are processed by the backend ZADX provider after the
      // queued notification_delivery operation reaches the server.
      if (delivery.channel === "sms") continue;
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

    return {
      student_name: student?.full_name || "",
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
    const prefix = params.operationPrefix || `op-notif-abs-${params.sessionId}`;
    const events: NotificationEvent[] = [];

    for (const studentId of params.selectedStudentIds) {
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
        eventType: "absence",
        vars,
      });
      events.push(event);
    }

    return events;
  }

  /** Sends the student's grade summary to the guardian using the SMS template. */
  static notifyGrades(params: {
    studentId: string;
    summary: string;
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
    const event = this.createNotificationEvent({
      operationId: params.operationId || `op-notif-grades-${params.studentId}-${Date.now()}`,
      studentId: params.studentId,
      sessionId: "",
      eventType: "grades",
      vars: {
        student_name: student?.full_name || "",
        parent_name: "ولي الأمر",
        center_name: center?.name || "",
        exam_name: params.examName || "",
        score: params.score == null ? "" : String(params.score),
        max_score: params.maxScore == null ? "" : String(params.maxScore),
        grades_summary: params.summary,
      },
    });
    return event;
  }
}
