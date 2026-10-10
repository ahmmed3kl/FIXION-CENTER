import { canAccessRoute, resolvePermissionRouteName } from "../src/core/permissions/routeAccess";

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

  it("resolves the main route group to the dashboard while its index route initializes", () => {
    expect(resolvePermissionRouteName(["(main)"])).toBe("index");
    expect(canAccessRoute("index", ["dashboard.view"])).toBe(true);
    expect(canAccessRoute("index", [])).toBe(false);
  });
});
