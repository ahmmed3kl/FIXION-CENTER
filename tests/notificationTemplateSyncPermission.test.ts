import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { NotificationTemplateRepository } from "../src/features/notifications/NotificationTemplateRepository";

describe("Notification template sync permissions", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000002", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  it("keeps locally generated defaults out of the sync queue for a secretary", () => {
    NotificationTemplateRepository.ensureDefaultTemplates();

    const templates = NotificationTemplateRepository.getTemplates();
    const templateOperations = SyncRepository.getPendingOperations("center-1")
      .filter((operation) => operation.entityType === "notification_template");

    expect(templates.length).toBeGreaterThanOrEqual(4);
    expect(templateOperations).toHaveLength(0);
  });
});
