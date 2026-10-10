jest.mock("expo-device", () => ({ modelName: "POCO F3" }));

import { AxiosHeaders, AxiosResponse } from "axios";
import { ApiClient } from "../src/core/api";
import { HttpSyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import { DeviceService } from "../src/core/device";
import { PullSyncResponse } from "../src/core/api/contracts";

function response<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
}

describe("device registration during sync", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("refreshes device metadata before pull and avoids repeating registration during the cooldown", async () => {
    DeviceService.setCachedDeviceId("device-registration-sync-test");
    const client = ApiClient.getInstance();
    const register = jest
      .spyOn(client, "post")
      .mockResolvedValue(response({}));
    const pullResponse: PullSyncResponse = {
      changes: [],
      nextCursor: "0",
      hasMore: false,
      serverTimestamp: new Date(0).toISOString(),
    };
    const pull = jest
      .spyOn(client, "get")
      .mockResolvedValue(response(pullResponse));
    const adapter = new HttpSyncApiAdapter();

    await adapter.pullChanges("center-registration-test", "0");
    await adapter.pullChanges("center-registration-test", "0");

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toBe("/devices/register");
    expect(register.mock.calls[0][1]).toMatchObject({
      deviceId: "device-registration-sync-test",
      deviceName: "POCO F3",
    });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      pull.mock.invocationCallOrder[0],
    );
  });
});
