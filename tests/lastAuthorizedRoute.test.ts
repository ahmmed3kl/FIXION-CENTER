import { AuthRepository, DEMO_USERS } from "../src/features/auth/AuthRepository";
import { LastAuthorizedRouteStore, createLastAuthorizedRoute, getSafeDefaultRoute, resolveLastAuthorizedRoute } from "../src/features/auth/lastAuthorizedRoute";
import { useAuthStore } from "../src/features/auth/useAuthStore";

const admin = DEMO_USERS[0];

describe("last authorized route", () => {
  beforeEach(async () => {
    await LastAuthorizedRouteStore.clear();
  });

  it("captures only a permitted, static route within the active center", () => {
    expect(createLastAuthorizedRoute(["(main)", "scanner"], admin, "center-1")).toEqual({
      userId: admin.id,
      centerId: "center-1",
      routeName: "scanner",
    });
    expect(createLastAuthorizedRoute(["(main)", "group-details"], admin, "center-1")).toBeNull();
    expect(createLastAuthorizedRoute(["(main)", "scanner"], admin, "center-3")).toBeNull();
  });

  it("restores only for the same user, center, and current permissions", () => {
    const route = createLastAuthorizedRoute(["(main)", "scanner"], admin, "center-1");
    expect(resolveLastAuthorizedRoute(route, admin, "center-1")).toBe("/(main)/scanner");
    expect(resolveLastAuthorizedRoute(route, DEMO_USERS[1], "center-1")).toBeNull();
    expect(resolveLastAuthorizedRoute(route, admin, "center-2")).toBeNull();
    expect(resolveLastAuthorizedRoute(route, { ...admin, permissions: [] }, "center-1")).toBeNull();
  });

  it("uses a safe fallback when dashboard permission is unavailable", () => {
    expect(getSafeDefaultRoute({ ...DEMO_USERS[1], permissions: [] })).toBe("/(main)/more");
  });

  it("persists only an authorized route and validates it again when restoring", async () => {
    const route = createLastAuthorizedRoute(["(main)", "grades"], admin, "center-1");
    if (!route) throw new Error("The admin grade route should be restorable.");

    await LastAuthorizedRouteStore.save(route);
    expect(await LastAuthorizedRouteStore.restore(admin, "center-1")).toBe("/(main)/grades");
    expect(await LastAuthorizedRouteStore.restore(DEMO_USERS[1], "center-1")).toBeNull();
  });

  it("does not restart session restoration for an already authenticated store", async () => {
    const previous = useAuthStore.getState();
    const restoreSpy = jest.spyOn(AuthRepository, "restoreSession");
    useAuthStore.setState({
      currentUser: admin,
      activeCenterId: "center-1",
      activeCenter: null,
      availableCenters: [],
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    try {
      await expect(useAuthStore.getState().restoreSession()).resolves.toBe(true);
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isLoading).toBe(false);
    } finally {
      restoreSpy.mockRestore();
      useAuthStore.setState(previous);
    }
  });
});
