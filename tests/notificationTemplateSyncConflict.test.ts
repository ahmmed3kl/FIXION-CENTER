import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { NotificationTemplateRepository } from "../src/features/notifications/NotificationTemplateRepository";

describe("Notification template sync conflict resolution", () => {
  const centerId = "center-1";

  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter(centerId);
  });

  beforeEach(() => {
    const db = DatabaseService.getDb();
    db.runSync("DELETE FROM notification_templates WHERE center_id = ?", [centerId]);
  });

  it("safely updates an existing template without UNIQUE constraint failed on id", () => {
    const db = DatabaseService.getDb();
    const existingId = "ntmpl-227641fa-a914-41d7-b79f-e3cba35ca69b";

    // 1. Seed existing template in local SQLite
    db.runSync(
      `INSERT OR REPLACE INTO notification_templates
        (id, center_id, event_type, channel, template_body, is_default, created_by, created_at)
       VALUES (?, ?, 'grades', 'sms', 'الدرجات القديمة', 1, 'system', '2026-10-17T07:00:00.000Z')`,
      [existingId, centerId],
    );

    // 2. Simulate server change for the exact same template ID (e.g. pulled from server stream)
    expect(() => {
      SyncEngine.applyServerChanges(centerId, [
        {
          serverSeq: 101,
          operationId: "op-srv-template-1",
          entityType: "notification_template",
          entityId: existingId,
          operationType: "UPDATE",
          data: {
            id: existingId,
            centerId,
            eventType: "grades",
            channel: "sms",
            templateBody: "درجات الطالب المحدثة: {{grades_summary}}",
            isDefault: true,
            updatedBy: "user-admin",
            updatedAt: "2026-10-17T07:05:00.000Z",
          },
        },
      ]);
    }).not.toThrow();

    // 3. Verify the template was updated in-place without throwing UNIQUE constraint failed
    const updated = db.getFirstSync<any>(
      `SELECT id, template_body, updated_by FROM notification_templates WHERE center_id = ? AND id = ?`,
      [centerId, existingId],
    );
    expect(updated).toBeTruthy();
    expect(updated.template_body).toBe("درجات الطالب المحدثة: {{grades_summary}}");
  });

  it("resolves natural key conflict when local ID differs from incoming server ID", () => {
    const db = DatabaseService.getDb();
    const localId = "ntmpl-local-generated-uuid";
    const serverId = "ntmpl-server-authoritative-uuid";

    // Local default template generated offline before sync
    db.runSync(
      `INSERT OR REPLACE INTO notification_templates
        (id, center_id, event_type, channel, template_body, is_default, created_by, created_at)
       VALUES (?, ?, 'attendance', 'sms', 'نص الحضور المحلي', 1, 'system', '2026-10-17T07:00:00.000Z')`,
      [localId, centerId],
    );

    // Incoming change from server with same (center_id, event_type, channel, is_default)
    expect(() => {
      SyncEngine.applyServerChanges(centerId, [
        {
          serverSeq: 102,
          operationId: "op-srv-template-2",
          entityType: "notification_template",
          entityId: serverId,
          operationType: "UPDATE",
          data: {
            id: serverId,
            centerId,
            eventType: "attendance",
            channel: "sms",
            templateBody: "تم تسجيل حضور {{student_name}}",
            isDefault: true,
            updatedBy: "server",
            updatedAt: "2026-10-17T07:06:00.000Z",
          },
        },
      ]);
    }).not.toThrow();

    const result = db.getFirstSync<any>(
      `SELECT id, template_body FROM notification_templates WHERE center_id = ? AND event_type = ? AND channel = ?`,
      [centerId, "attendance", "sms"],
    );
    expect(result).toBeTruthy();
    expect(result.id).toBe(serverId);
    expect(result.template_body).toBe("تم تسجيل حضور {{student_name}}");
  });
});
