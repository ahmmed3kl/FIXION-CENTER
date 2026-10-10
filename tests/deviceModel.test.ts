jest.mock("expo-device", () => ({ modelName: "POCO F3" }));

import {
  DeviceRepository,
  DeviceService,
  resolveDeviceModelName,
} from "../src/core/device";
import { DatabaseService } from "../src/core/database";

describe("device model reporting", () => {
  beforeEach(() => {
    DatabaseService.init();
    DeviceService.setCachedDeviceId("device-model-refresh-test");
  });

  it("uses Expo Device's reported model name", () => {
    expect(DeviceService.getDeviceModelName()).toBe("POCO F3");
  });

  it("uses the explicit unknown-model fallback when the platform provides no model", () => {
    expect(resolveDeviceModelName(null)).toBe("موديل غير معروف");
    expect(resolveDeviceModelName("   ")).toBe("موديل غير معروف");
    expect(resolveDeviceModelName("dev-123e4567-e89b-12d3-a456-426614174000")).toBe("موديل غير معروف");
    expect(resolveDeviceModelName("user-123e4567-e89b-12d3-a456-426614174000")).toBe("موديل غير معروف");
    expect(resolveDeviceModelName("ANDROID-Device-b3bb")).toBe("موديل غير معروف");
  });

  it("upgrades an existing local device record when Expo later reports its model", () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO devices (id, center_id, user_id, device_name, device_identifier, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-device-row",
        "center-device-model-test",
        "user-device-model-test",
        "ANDROID-Device-b3bb",
        "device-model-refresh-test",
        "active",
        new Date(0).toISOString(),
      ],
    );

    const device = DeviceRepository.registerOrGetDevice({
      centerId: "center-device-model-test",
      userId: "user-device-model-test",
    });

    expect(device.deviceName).toBe("POCO F3");
    expect(db.getFirstSync<{ device_name: string }>(
      "SELECT device_name FROM devices WHERE center_id = ? AND device_identifier = ?",
      ["center-device-model-test", "device-model-refresh-test"],
    )?.device_name).toBe("POCO F3");
  });
});
