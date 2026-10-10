import { describe, expect, it } from "vitest";
import type { Device } from "../types";
import { deviceModel, lastAccount } from "./DevicesPage";

const device = (fields: Partial<Device> = {}): Device => ({
  id: "device-identifier-long-1234567890",
  center_id: "center-1",
  user_id: "user-1",
  device_name: "iPhone 15 Pro Max",
  platform: "ios",
  status: "active",
  last_seen_at: "2026-10-09T12:30:00.000Z",
  created_at: "2026-10-01T12:00:00.000Z",
  full_name: "أحمد محمد",
  user_email: "ahmed@example.com",
  ...fields,
});

describe("device labels", () => {
  it("displays the reported device model and a clear fallback for generated or missing names", () => {
    expect(deviceModel(device())).toBe("iPhone 15 Pro Max");
    expect(deviceModel(device({ device_name: "ANDROID-Device-b3bb" }))).toBe("موديل غير معروف");
    expect(deviceModel(device({ device_name: null }))).toBe("موديل غير معروف");
    expect(deviceModel(device({ device_name: "موديل غير معروف" }))).toBe("موديل غير معروف");
    expect(deviceModel(device({ device_name: "dev-123e4567-e89b-12d3-a456-426614174000" }))).toBe("موديل غير معروف");
    expect(deviceModel(device({ device_name: "Mobile Tablet/Phone" }))).toBe("موديل غير معروف");
    expect(deviceModel(device({ device_name: "user-123e4567-e89b-12d3-a456-426614174000" }))).toBe("موديل غير معروف");
  });

  it("shows the last associated account without claiming it is currently active", () => {
    expect(lastAccount(device())).toBe("أحمد محمد");
    expect(lastAccount(device({ full_name: null }))).toBe("ahmed@example.com");
    expect(lastAccount(device({ full_name: null, user_email: null }))).toBe("بيانات الحساب غير متاحة");
  });
});
