jest.mock("expo-device", () => ({ modelName: "Test Device" }));

import { DatabaseService } from "../src/core/database";
import { canAccessRoute } from "../src/core/permissions/routeAccess";
import { SyncRepository } from "../src/core/sync";
import { AuthRepository, DEMO_USERS } from "../src/features/auth/AuthRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { User } from "../src/shared/types";

describe("permission refresh preserves local work", () => {
  beforeEach(async () => {
    DatabaseService.init();
    await useAuthStore.getState().logout();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("applies a server-side read-permission revocation without deleting cached data or pending operations", async () => {
    const user: User = { ...DEMO_USERS[1], permissions: ["students.view"] };
    useAuthStore.setState({
      currentUser: user,
      activeCenterId: "center-1",
      isAuthenticated: true,
    });
    const db = DatabaseService.getDb();
    db.runSync(
      "INSERT INTO students (id, center_id, student_code, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ["student-cached", "center-1", "cached-1", "بيانات محلية", new Date().toISOString()],
    );
    SyncRepository.enqueueOperation({
      operationId: "pending-local-operation",
      centerId: "center-1",
      userId: user.id,
      deviceId: "test-device",
      operationType: "UPDATE",
      entityType: "student",
      entityId: "student-cached",
      payload: { fullName: "تعديل محلي معلق" },
    });

    jest.spyOn(AuthRepository, "refreshSessionUser").mockResolvedValue({
      ...user,
      permissions: [],
    });

    await useAuthStore.getState().refreshPermissions();

    expect(useAuthStore.getState().currentUser?.permissions).toEqual([]);
    expect(canAccessRoute("students", useAuthStore.getState().currentUser?.permissions)).toBe(false);
    expect(db.getFirstSync<{ id: string }>(
      "SELECT id FROM students WHERE center_id = ? AND id = ?",
      ["center-1", "student-cached"],
    )?.id).toBe("student-cached");
    expect(SyncRepository.getByOperationId("pending-local-operation")?.status).toBe("pending");
  });
});
