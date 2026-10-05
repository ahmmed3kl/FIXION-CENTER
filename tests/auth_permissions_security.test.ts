import { DatabaseService } from "../src/core/database";
import { ForbiddenError } from "../src/core/errors";
import {
  Permission,
  PermissionService,
  RolePermissions,
  resolveUserPermissions,
} from "../src/core/permissions";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("Auth and Permissions Security & Bootstrap Suite", () => {
  beforeEach(async () => {
    DatabaseService.init();
    await useAuthStore.getState().logout();
  });

  describe("Granular Roles Principle of Least Privilege (Zero Privilege Escalation)", () => {
    it("manager with limited permissions remains limited", () => {
      const user = {
        id: "usr-mgr-limited",
        role: "manager",
        permissions: ["students.view"] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(["students.view"]);
      expect(resolved).not.toContain("payments.create");
      expect(resolved).not.toContain("teachers.create");
      expect(resolved).not.toContain("groups.create");
    });

    it("manager with [] does NOT automatically become fully privileged", () => {
      const user = {
        id: "usr-mgr-empty",
        role: "manager",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
      expect(resolved.length).toBe(0);
    });

    it("assistant with [] does NOT gain permissions", () => {
      const user = {
        id: "usr-asst-empty",
        role: "assistant",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
      expect(resolved.length).toBe(0);
    });

    it("accountant with [] does NOT gain permissions", () => {
      const user = {
        id: "usr-acc-empty",
        role: "accountant",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
      expect(resolved.length).toBe(0);
    });

    it("secretary with [] does NOT gain permissions", () => {
      const user = {
        id: "usr-sec-empty",
        role: "secretary",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
      expect(resolved.length).toBe(0);
    });

    it("normal explicit permissions remain unchanged", () => {
      const explicitPermissions: Permission[] = [
        "students.view",
        "students.create",
        "attendance.view",
      ];
      const user = {
        id: "usr-sec-explicit",
        role: "secretary",
        permissions: explicitPermissions,
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(explicitPermissions);
    });

    it("explicit empty object marker { __explicit_empty__: true } returns []", () => {
      const user = {
        id: "usr-empty-marker",
        role: "assistant",
        permissions: { __explicit_empty__: true },
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
    });

    it("granular role with an object containing unknown or unmapped keys does not elevate", () => {
      const user = {
        id: "usr-unknown-keys",
        role: "assistant",
        permissions: { some_unknown_custom_permission: true },
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual([]);
    });
  });

  describe("Administrative Roles Superuser Resolution", () => {
    it('admin with {"*": true} gets full admin permissions', () => {
      const user = {
        id: "usr-admin-wildcard",
        role: "admin",
        permissions: { "*": true },
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(RolePermissions.admin);
      expect(resolved).toContain("students.view");
      expect(resolved).toContain("payments.reverse");
      expect(resolved).toContain("settings.view");
    });

    it('owner with {"*": true} gets full owner permissions', () => {
      const user = {
        id: "usr-owner-wildcard",
        role: "owner",
        permissions: { "*": true },
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(RolePermissions.owner);
      expect(resolved).toContain("students.view");
      expect(resolved).toContain("payments.reverse");
      expect(resolved).toContain("settings.view");
    });

    it("admin with corrupted [] from session restore cache is repaired to full admin permissions", () => {
      const user = {
        id: "usr-admin-corrupted",
        role: "admin",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(RolePermissions.admin);
      expect(resolved).toContain("students.view");
    });

    it("owner with corrupted [] from session restore cache is repaired to full owner permissions", () => {
      const user = {
        id: "usr-owner-corrupted",
        role: "owner",
        permissions: [] as Permission[],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(RolePermissions.owner);
      expect(resolved).toContain("students.view");
    });

    it('any role with explicit ["*"] in array gets full admin permissions', () => {
      const user = {
        id: "usr-wildcard-array",
        role: "admin",
        permissions: ["*"],
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toEqual(RolePermissions.admin);
    });
  });

  describe("Legacy Aliases Resolution", () => {
    it("maps legacy financial and operational permission aliases correctly", () => {
      const user = {
        id: "usr-legacy-acc",
        role: "accountant",
        permissions: {
          can_manage_financials: true,
          can_collect_payment: true,
          can_view_reports: true,
          can_close_session: true,
        },
      };
      const resolved = resolveUserPermissions(user);
      expect(resolved).toContain("payments.view");
      expect(resolved).toContain("payments.create");
      expect(resolved).toContain("payments.reverse");
      expect(resolved).toContain("payments.adjust");
      expect(resolved).toContain("reports.financial.view");
      expect(resolved).toContain("reports.view");
      expect(resolved).toContain("sessions.close");
      expect(resolved).toContain("daily_closing.close");
    });
  });

  describe("PermissionService Wildcard Support", () => {
    it("hasPermission recognizes wildcard in array", () => {
      expect(PermissionService.hasPermission(["*"] as any, "students.view")).toBe(true);
      expect(PermissionService.hasPermission(["*"] as any, "payments.reverse")).toBe(true);
    });

    it("hasPermission recognizes wildcard in object", () => {
      expect(PermissionService.hasPermission({ "*": true }, "students.view")).toBe(true);
      expect(PermissionService.hasPermission({ "*": true }, "payments.reverse")).toBe(true);
    });

    it("hasAnyPermission recognizes wildcard", () => {
      expect(PermissionService.hasAnyPermission(["*"] as any, ["students.view", "students.create"])).toBe(true);
      expect(PermissionService.hasAnyPermission({ "*": true }, ["students.view", "students.create"])).toBe(true);
    });

    it("hasAllPermissions recognizes wildcard", () => {
      expect(PermissionService.hasAllPermissions(["*"] as any, ["students.view", "students.create"])).toBe(true);
      expect(PermissionService.hasAllPermissions({ "*": true }, ["students.view", "students.create"])).toBe(true);
    });
  });

  describe("Integration with StudentRepository & Auth Store", () => {
    it("allows admin with restored session to read StudentRepository.getAll without ForbiddenError", async () => {
      // Simulate admin session restore with {"*": true} from backend
      useAuthStore.setState({
        currentUser: {
          id: "usr-admin-1",
          fullName: "مدير السنتر",
          email: "admin@center1.com",
          phone: "01000000001",
          role: "admin",
          centerId: "center-1",
          centerIds: ["center-1"],
          permissions: { "*": true } as any,
        },
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });

      // Calling StudentRepository.getAll() must NOT throw ForbiddenError
      expect(() => {
        StudentRepository.getAll(true);
      }).not.toThrow();

      const students = StudentRepository.getAll(true);
      expect(Array.isArray(students)).toBe(true);
    });

    it("allows admin with previously corrupted [] permissions to read StudentRepository.getAll", async () => {
      // Simulate admin session where previously corrupted [] was saved in store
      useAuthStore.setState({
        currentUser: {
          id: "usr-admin-1",
          fullName: "مدير السنتر",
          email: "admin@center1.com",
          phone: "01000000001",
          role: "admin",
          centerId: "center-1",
          centerIds: ["center-1"],
          permissions: [] as Permission[],
        },
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });

      // useAuthStore.getState() safety patch will resolve the admin's permissions
      const stateUser = useAuthStore.getState().currentUser;
      expect(stateUser?.permissions).toContain("students.view");

      // Calling StudentRepository.getAll() succeeds
      expect(() => {
        StudentRepository.getAll(true);
      }).not.toThrow();
    });

    it("strictly blocks an assistant or manager with [] permissions from reading StudentRepository.getAll", async () => {
      // An assistant or manager with [] has zero permissions and MUST be blocked
      useAuthStore.setState({
        currentUser: {
          id: "usr-asst-restricted",
          fullName: "مساعد بدون صلاحيات",
          email: "assistant@center1.com",
          phone: "01000000099",
          role: "assistant",
          centerId: "center-1",
          centerIds: ["center-1"],
          permissions: [] as Permission[],
        },
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });

      // State read must NOT elevate assistant
      const stateUser = useAuthStore.getState().currentUser;
      expect(stateUser?.permissions).toEqual([]);

      // Calling StudentRepository.getAll() must throw ForbiddenError
      expect(() => {
        StudentRepository.getAll(true);
      }).toThrow(ForbiddenError);
    });
  });
});
