import {
  ConnectivityService,
  resolveBackendReachability,
  resolveDeviceNetworkState,
} from "../src/core/connectivity";

describe("connectivity state interpretation", () => {
  it("treats only an explicit native disconnected value as device offline", () => {
    expect(resolveDeviceNetworkState({ isConnected: false })).toBe("disconnected");
    expect(resolveDeviceNetworkState({ isConnected: true })).toBe("connected");
    expect(resolveDeviceNetworkState({ isConnected: true, isInternetReachable: false }))
      .toBe("connected");
    expect(resolveDeviceNetworkState({ isConnected: null })).toBe("unknown");
    expect(resolveDeviceNetworkState({})).toBe("unknown");
  });

  it("distinguishes a healthy FIXION health response from an unreachable or degraded backend", () => {
    expect(
      resolveBackendReachability(200, { status: "ok", database: "connected" }),
    ).toBe("available");
    expect(resolveBackendReachability(null)).toBe("unavailable");
    expect(resolveBackendReachability(503, { status: "degraded" })).toBe("degraded");
    expect(resolveBackendReachability(200, { status: "ok", database: "disconnected" }))
      .toBe("degraded");
  });

  it("removes connectivity listeners when their subscription is disposed", () => {
    const previousState = ConnectivityService.getState();
    const listener = jest.fn();
    const unsubscribe = ConnectivityService.subscribe(listener);
    const subscribedCallCount = listener.mock.calls.length;

    ConnectivityService.setState(previousState === "offline" ? "online" : "offline");
    expect(listener).toHaveBeenCalledTimes(subscribedCallCount + 1);

    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    ConnectivityService.setState(previousState);
    expect(listener).toHaveBeenCalledTimes(callsAfterUnsubscribe);
  });
});
