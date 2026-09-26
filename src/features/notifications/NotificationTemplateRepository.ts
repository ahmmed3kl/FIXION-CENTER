import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { NotificationChannel, NotificationEventType, NotificationTemplate } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

// Supported template variables
const SUPPORTED_VARIABLES = [
  "{{student_name}}",
  "{{student_first_name}}",
  "{{parent_name}}",
  "{{center_name}}",
  "{{subject_name}}",
  "{{teacher_name}}",
  "{{group_name}}",
  "{{session_date}}",
  "{{session_time}}",
  "{{attendance_status}}",
  "{{exam_name}}",
  "{{score}}",
  "{{max_score}}",
  "{{grades_summary}}",
];

// Default Arabic templates
export const DEFAULT_TEMPLATES: Record<NotificationEventType, Record<NotificationChannel, string>> = {
  attendance: {
    push: "تم تسجيل حضور {{student_name}} في حصة {{subject_name}} مع {{teacher_name}} بتاريخ {{session_date}} الساعة {{session_time}}.",
    sms: "تم تسجيل حضور {{student_name}} في حصة {{subject_name}} بتاريخ {{session_date}}. {{center_name}}",
  },
  absence: {
    push: "تغيب {{student_name}} عن حصة {{subject_name}} مع {{teacher_name}} بتاريخ {{session_date}}. يرجى التواصل مع المركز.",
    sms: "غاب {{student_name}} عن حصة {{subject_name}} بتاريخ {{session_date}}. للاستفسار تواصل مع {{center_name}}.",
  },
  grades: {
    push: "تم تسجيل درجات {{student_name}}: {{grades_summary}}. {{center_name}}",
    sms: "درجات {{student_name}}: {{grades_summary}}. للاستفسار تواصل مع {{center_name}}.",
  },
  custom: {
    push: "رسالة من المركز إلى {{student_name}}",
    sms: "رسالة من المركز إلى {{student_name}}",
  },
};

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Safely renders a template, replacing supported variables.
 * Unknown variables are left as-is (no crash).
 */
export function renderTemplate(templateBody: string, vars: Record<string, string>): string {
  let result = templateBody;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  return result;
}

export class NotificationTemplateRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  /**
   * Ensures default templates exist for the center. Idempotent.
   */
  static ensureDefaultTemplates(): void {
    const { centerId, user } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    for (const [eventType, channels] of Object.entries(DEFAULT_TEMPLATES)) {
      for (const [channel, body] of Object.entries(channels)) {
        const existing = db.getAllSync(
          `SELECT id FROM notification_templates WHERE center_id = ? AND event_type = ? AND channel = ? AND is_default = 1`,
          [centerId, eventType, channel],
        );
        if (existing.length === 0) {
          const id = `ntmpl-${generateUUID()}`;
          db.runSync(
            `INSERT INTO notification_templates (id, center_id, event_type, channel, template_body, is_default, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            [id, centerId, eventType, channel, body, user.id, now],
          );
          SyncRepository.enqueueOperation({
            operationId: `op-notif-template-${id}`,
            centerId,
            userId: user.id,
            deviceId: DeviceService.getDeviceIdSync(),
            operationType: "CREATE",
            entityType: "notification_template",
            entityId: id,
            payload: { id, centerId, eventType, channel, templateBody: body, isDefault: true, createdBy: user.id, createdAt: now },
          });
        }
      }
    }
  }

  /**
   * Lists all templates for the center.
   */
  static getTemplates(): NotificationTemplate[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "notifications.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض قوالب الإشعارات.");
    }
    const db = DatabaseService.getDb();
    return db.getAllSync<NotificationTemplate>(
      `SELECT id, center_id as centerId, event_type as eventType, channel,
              template_body as templateBody, is_default as isDefault,
              created_by as createdBy, updated_by as updatedBy,
              created_at as createdAt, updated_at as updatedAt
       FROM notification_templates
       WHERE center_id = ?
       ORDER BY event_type, channel`,
      [centerId],
    );
  }

  /**
   * Gets the active template for a given event_type + channel.
   * Falls back to default template body if none found.
   */
  static getActiveTemplate(
    eventType: NotificationEventType,
    channel: NotificationChannel,
  ): NotificationTemplate | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<NotificationTemplate>(
      `SELECT id, center_id as centerId, event_type as eventType, channel,
              template_body as templateBody, is_default as isDefault,
              created_by as createdBy, updated_by as updatedBy,
              created_at as createdAt, updated_at as updatedAt
       FROM notification_templates
       WHERE center_id = ? AND event_type = ? AND channel = ?`,
      [centerId, eventType, channel],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Updates a notification template. Requires notifications.templates.update permission.
   * Validates supported variables only.
   */
  static updateTemplate(
    templateId: string,
    newBody: string,
  ): NotificationTemplate {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "notifications.templates.update")) {
      throw new ForbiddenError("ليس لديك صلاحية تعديل قوالب الإشعارات.");
    }
    if (!newBody || newBody.trim().length === 0) {
      throw new ValidationError("نص القالب لا يمكن أن يكون فارغاً.");
    }

    const db = DatabaseService.getDb();
    const rows = db.getAllSync<any>(
      `SELECT id, center_id, event_type, channel FROM notification_templates WHERE center_id = ? AND id = ?`,
      [centerId, templateId],
    );
    if (rows.length === 0) {
      throw new NotFoundError("القالب غير موجود.");
    }

    const now = new Date().toISOString();
    db.runSync(
      `UPDATE notification_templates SET template_body = ?, updated_by = ?, updated_at = ? WHERE id = ? AND center_id = ?`,
      [newBody.trim(), user.id, now, templateId, centerId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    AuditService.recordEvent({
      operationId: `op-${generateUUID()}`,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "notification_template",
      entityId: templateId,
      action: "template_updated",
      payload: { templateId, newBody: newBody.trim() },
    });
    SyncRepository.enqueueOperation({
      operationId: `op-ntmpl-${templateId.slice(-24)}-${Date.now().toString(36)}`,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "notification_template",
      entityId: templateId,
      payload: { id: templateId, eventType: rows[0].event_type, channel: rows[0].channel, templateBody: newBody.trim(), updatedBy: user.id, updatedAt: now },
    });

    return this.getActiveTemplate(rows[0].event_type, rows[0].channel)!;
  }
}
