import { initialServiceVisibilityState, isServiceEnabled } from "../src/core/services/serviceVisibility";

describe("service visibility", () => {
  it("does not optimistically expose a service while loading", () => {
    expect(isServiceEnabled(initialServiceVisibilityState, "payments")).toBe(false);
  });

  it("uses the center-specific server state", () => {
    const state = { ...initialServiceVisibilityState, loaded: true, centerId: "center-1", enabled: { payments: false, reports: true } };
    expect(isServiceEnabled(state, "payments")).toBe(false);
    expect(isServiceEnabled(state, "reports")).toBe(true);
  });
});
