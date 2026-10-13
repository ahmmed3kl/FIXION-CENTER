import { canAccessRoute, resolvePermissionRouteName } from "../src/core/permissions/routeAccess";
import { canSwitchCenters } from "../src/features/auth/centerAccess";

describe("route permission access", () => {
  it("denies direct access to protected routes without read permission", () => {
    expect(canAccessRoute("groups", ["students.view"])).toBe(false);
  });

  it("allows a protected route when the user has its read permission", () => {
    expect(canAccessRoute("groups", ["groups.view"])).toBe(true);
  });

  it("requires group access and a separate roster permission for group details", () => {
    expect(canAccessRoute("group-details", ["groups.view"])).toBe(false);
    expect(canAccessRoute("group-details", ["groups.view", "groups.students.view"])).toBe(true);
  });

  it("allows academic access when any supported academic section is readable", () => {
    expect(canAccessRoute("academic", ["teachers.view"])).toBe(true);
    expect(canAccessRoute("academic", ["groups.view"])).toBe(false);
  });

  it("fails closed for unlisted routes but keeps the explicitly public navigation routes available", () => {
    expect(canAccessRoute("unlisted-route", [])).toBe(false);
    expect(canAccessRoute("more", [])).toBe(true);
  });

  it("finds protected route names whether or not the router includes its group segment", () => {
    expect(resolvePermissionRouteName(["(main)", "groups"])).toBe("groups");
    expect(resolvePermissionRouteName(["groups", "[groupId]"])).toBe("groups");
  });

  it("resolves the center-switch route and restricts it to administrative roles", () => {
    const routeName = resolvePermissionRouteName(["(main)", "center-switch"]);
    expect(routeName).toBe("center-switch");
    expect(canSwitchCenters({ role: "admin" })).toBe(true);
    expect(canSwitchCenters({ role: "owner" })).toBe(true);
    expect(canSwitchCenters({ role: "manager" })).toBe(false);
    expect(canSwitchCenters({ role: "assistant" })).toBe(false);
    expect(canSwitchCenters({ role: "accountant" })).toBe(false);
    expect(canSwitchCenters({ role: "secretary" })).toBe(false);
  });

  it("resolves the main route group and dashboard route to the dashboard permission", () => {
    expect(resolvePermissionRouteName(["(main)"])).toBe("dashboard");
    expect(resolvePermissionRouteName(["(main)", "dashboard"])).toBe("dashboard");
    expect(canAccessRoute("dashboard", ["dashboard.view"])).toBe(true);
    expect(canAccessRoute("dashboard", [])).toBe(false);
  });
});
