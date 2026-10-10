jest.mock("expo-device", () => ({ modelName: "POCO F3" }));

import { DeviceService, resolveDeviceModelName } from "../src/core/device";

describe("device model reporting", () => {
  it("uses Expo Device's reported model name", () => {
    expect(DeviceService.getDeviceModelName()).toBe("POCO F3");
  });

  it("uses the explicit unknown-model fallback when the platform provides no model", () => {
    expect(resolveDeviceModelName(null)).toBe("موديل غير معروف");
    expect(resolveDeviceModelName("   ")).toBe("موديل غير معروف");
  });
});
