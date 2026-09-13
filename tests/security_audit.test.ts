import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService } from "../src/core/database";
import { DeviceService } from "../src/core/device";
import {
    PermissionService,
    RolePermissions,
    resolveUserPermissions,
} from "../src/core/permissions";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { Permission, UserRole } from "../src/shared/types";

describe("Security & Data Integrity Audit Suite", () => {
  beforeAll(async () => {
    DatabaseService.init();
    ConnectivityService.setState("online");
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  describe("Point 1: Permission Fallback & Least Privilege Verification", () => {
    it("role === admin receives full Admin permissions", () => {
      const perms = resolveUserPermissions({ role: "admin" });
      expect(perms).toEqual(RolePermissions.admin);
      expect(perms).toContain<Permission>("teachers.create");
      expect(perms).toContain<Permission>("groups.create");
      expect(perms).toContain<Permission>("payments.reverse");
    });

    it("valid permissions array is preserved as-is without unwanted elevation", () => {
      const customPerms: Permission[] = ["students.view", "attendance.create"];
      const perms = resolveUserPermissions({
        role: "admin",
        permissions: customPerms,
      });
      expect(perms).toEqual(customPerms);
      expect(perms).not.toContain<Permission>("teachers.create");
    });

    it("secretary with missing permissions (undefined) receives ONLY secretary permissions, NEVER elevated to Admin", () => {
      const perms = resolveUserPermissions({
        role: "secretary",
        permissions: undefined,
      });
      expect(perms).toEqual(RolePermissions.secretary);
      expect(perms).not.toContain<Permission>("teachers.create");
      expect(perms).not.toContain<Permission>("groups.create");
      expect(perms).not.toContain<Permission>("payments.reverse");
      expect(perms).not.toContain<Permission>("teachers.deactivate");
      expect(PermissionService.hasPermission(perms, "teachers.create")).toBe(
        false,
      );
      expect(PermissionService.hasPermission(perms, "groups.create")).toBe(
        false,
      );
    });

    it("secretary with malformed permissions (null or empty array) receives ONLY secretary permissions", () => {
      const permsNull = resolveUserPermissions({
        role: "secretary",
        permissions: null,
      });
      expect(permsNull).toEqual(RolePermissions.secretary);
      expect(permsNull).not.toContain<Permission>("teachers.create");

      const permsEmpty = resolveUserPermissions({
        role: "secretary",
        permissions: [],
      });
      expect(permsEmpty).toEqual(RolePermissions.secretary);
      expect(permsEmpty).not.toContain<Permission>("teachers.create");
    });

    it("accountant with malformed/missing permissions receives ONLY accountant permissions, NEVER elevated to Admin", () => {
      const perms = resolveUserPermissions({
        role: "accountant",
        permissions: {},
      });
      expect(perms).toEqual(RolePermissions.accountant);
      expect(perms).not.toContain<Permission>("teachers.create");
      expect(perms).not.toContain<Permission>("students.create");
      expect(PermissionService.hasPermission(perms, "teachers.create")).toBe(
        false,
      );
      expect(PermissionService.hasPermission(perms, "students.create")).toBe(
        false,
      );
    });

    it("manager with missing permissions receives ONLY manager permissions, NEVER elevated to Admin", () => {
      const perms = resolveUserPermissions({
        role: "manager",
        permissions: null,
      });
      expect(perms).toEqual(RolePermissions.manager);
      expect(perms).not.toContain<Permission>("payments.reverse");
      expect(PermissionService.hasPermission(perms, "payments.reverse")).toBe(
        false,
      );
    });

    it("unknown or missing role with malformed permissions receives [] (ZERO permissions), NEVER Admin", () => {
      const permsUnknown = resolveUserPermissions({
        role: "unknown_intruder" as UserRole,
        permissions: {},
      });
      expect(permsUnknown).toEqual([]);
      expect(
        PermissionService.hasPermission(permsUnknown, "teachers.create"),
      ).toBe(false);
      expect(
        PermissionService.hasPermission(permsUnknown, "students.view"),
      ).toBe(false);

      const permsNullUser = resolveUserPermissions(null);
      expect(permsNullUser).toEqual([]);

      const permsUndefinedUser = resolveUserPermissions(undefined);
      expect(permsUndefinedUser).toEqual([]);
    });

    it("PermissionService.hasPermission with an object map requires explicit boolean true and rejects non-matching keys", () => {
      const mapPermissions = {
        "students.view": true,
        "attendance.create": false,
        "teachers.create": "truthy_string_not_boolean",
      };

      expect(
        PermissionService.hasPermission(mapPermissions as any, "students.view"),
      ).toBe(true);
      expect(
        PermissionService.hasPermission(
          mapPermissions as any,
          "attendance.create",
        ),
      ).toBe(false);
      expect(
        PermissionService.hasPermission(
          mapPermissions as any,
          "teachers.create",
        ),
      ).toBe(false);
      expect(
        PermissionService.hasPermission(mapPermissions as any, "groups.create"),
      ).toBe(false);
    });
  });

  describe("Point 3: Non-Fatal Bootstrap Verification", () => {
    it("pushMutations succeeds and pending mutations are drained even when bootstrapCenter throws", async () => {
      const centerId = "center-1";
      const deviceId = await DeviceService.getDeviceId();
      const user = useAuthStore.getState().currentUser!;

      // Enqueue a test mutation
      const opId = `op-test-resilience-${Date.now()}`;
      const teacherId = `tch-test-${Date.now()}`;
      SyncRepository.enqueueOperation({
        operationId: opId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "teacher",
        entityId: teacherId,
        operationType: "create",
        payload: {
          id: teacherId,
          name: "Test Resilience Teacher",
          phone: "01000000999",
        },
      });

      // Confirm mutation is currently pending
      const pendingBefore = SyncRepository.getPendingOperations(centerId);
      expect(pendingBefore.some((m) => m.operationId === opId)).toBe(true);

      // Mock bootstrap to fail (simulating 404 / network crash on bootstrap endpoint)
      const originalBootstrap = (SyncEngine as any).adapter.bootstrapCenter;
      const originalPush = (SyncEngine as any).adapter.pushOperations;

      let pushWasCalled = false;
      (SyncEngine as any).adapter.bootstrapCenter = jest
        .fn()
        .mockRejectedValue(new Error("HTTP 404 Not Found: /v1/sync/bootstrap"));

      (SyncEngine as any).adapter.pushOperations = jest
        .fn()
        .mockImplementation(async (cId: string, ops: any[]) => {
          pushWasCalled = true;
          return {
            syncedOperationIds: ops.map((op) => op.operationId),
            conflicts: [],
            serverCursor: "100",
          };
        });

      try {
        // Run full syncCenterNow
        const result = await SyncEngine.syncCenterNow(centerId);

        // Verification: bootstrap failed, but sync DID NOT fail, and push was called!
        expect(pushWasCalled).toBe(true);
        expect(result.errors).toBe(0);

        // Verify that pending mutation was successfully marked as synced
        const pendingAfter = SyncRepository.getPendingOperations(centerId);
        expect(pendingAfter.some((m) => m.operationId === opId)).toBe(false);
      } finally {
        // Restore original methods
        (SyncEngine as any).adapter.bootstrapCenter = originalBootstrap;
        (SyncEngine as any).adapter.pushOperations = originalPush;
      }
    });
  });

  describe("Point 4: SQLite Schema Self-Healing Idempotency", () => {
    it("ensureAcademicSchema runs multiple times safely without throwing or corrupting existing tables", () => {
      expect(() => {
        DatabaseService.ensureAcademicSchema();
        DatabaseService.ensureAcademicSchema();
        DatabaseService.ensureAcademicSchema();
      }).not.toThrow();

      const db = DatabaseService.getDb();
      // Verify academic tables exist and are queryable
      const teachers = db.getAllSync("SELECT * FROM teachers LIMIT 1");
      expect(Array.isArray(teachers)).toBe(true);

      const subjects = db.getAllSync("SELECT * FROM subjects LIMIT 1");
      expect(Array.isArray(subjects)).toBe(true);

      const groups = db.getAllSync("SELECT * FROM groups LIMIT 1");
      expect(Array.isArray(groups)).toBe(true);

      const teacherSubjects = db.getAllSync(
        "SELECT * FROM teacher_subjects LIMIT 1",
      );
      expect(Array.isArray(teacherSubjects)).toBe(true);

      const groupSchedules = db.getAllSync(
        "SELECT * FROM group_schedules LIMIT 1",
      );
      expect(Array.isArray(groupSchedules)).toBe(true);
    });
  });
});
