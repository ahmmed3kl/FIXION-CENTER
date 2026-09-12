import { Platform } from "react-native";
import { DatabaseService } from "../database";
import { ForbiddenError } from "../errors";
import { SecureStorageService } from "../storage";

const DEVICE_ID_KEY = "fixion_permanent_device_id";

export interface DeviceRecord {
  id: string;
  centerId: string;
  userId: string;
  deviceName: string;
  deviceIdentifier: string;
  status: "active" | "inactive";
  lastSeenAt: string | null;
  createdAt: string;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class DeviceRepository {
  /**
   * Registers a device or retrieves existing record for the center.
   */
  static registerOrGetDevice(params: {
    centerId: string;
    userId: string;
    deviceName?: string;
  }): DeviceRecord {
    const db = DatabaseService.getDb();
    const deviceIdentifier = DeviceService.getDeviceIdSync();
    const deviceName =
      params.deviceName ||
      `${Platform.OS.toUpperCase()}-Device-${deviceIdentifier.slice(-4)}`;

    const existing = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, user_id as userId, device_name as deviceName,
              device_identifier as deviceIdentifier, status, last_seen_at as lastSeenAt,
              created_at as createdAt
       FROM devices
       WHERE center_id = ? AND device_identifier = ?`,
      [params.centerId, deviceIdentifier],
    );

    if (existing) {
      // Update last seen
      const now = new Date().toISOString();
      db.runSync(
        `UPDATE devices SET last_seen_at = ?, user_id = ? WHERE id = ?`,
        [now, params.userId, existing.id],
      );
      return {
        ...existing,
        lastSeenAt: now,
        userId: params.userId,
      };
    }

    const id = `dev-rec-${generateUUID()}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO devices (id, center_id, user_id, device_name, device_identifier, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        params.centerId,
        params.userId,
        deviceName,
        deviceIdentifier,
        now,
        now,
      ],
    );

    return {
      id,
      centerId: params.centerId,
      userId: params.userId,
      deviceName,
      deviceIdentifier,
      status: "active",
      lastSeenAt: now,
      createdAt: now,
    };
  }

  /**
   * Returns current status of device for center ('active' | 'inactive').
   * Defaults to 'active' if no record exists yet.
   */
  static getDeviceStatus(
    centerId: string,
    deviceIdentifier?: string,
  ): "active" | "inactive" {
    const db = DatabaseService.getDb();
    const devId = deviceIdentifier || DeviceService.getDeviceIdSync();

    const row = db.getFirstSync<{ status: "active" | "inactive" }>(
      `SELECT status FROM devices WHERE center_id = ? AND device_identifier = ?`,
      [centerId, devId],
    );

    return row?.status || "active";
  }

  /**
   * Sets device status ('active' | 'inactive') for testing or remote revocation.
   */
  static setDeviceStatus(
    centerId: string,
    deviceIdentifier: string,
    status: "active" | "inactive",
  ): void {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    const existing = db.getFirstSync<any>(
      `SELECT id FROM devices WHERE center_id = ? AND device_identifier = ?`,
      [centerId, deviceIdentifier],
    );

    if (existing) {
      db.runSync(
        `UPDATE devices SET status = ?, last_seen_at = ? WHERE id = ?`,
        [status, now, existing.id],
      );
    } else {
      const id = `dev-rec-${generateUUID()}`;
      db.runSync(
        `INSERT INTO devices (id, center_id, user_id, device_name, device_identifier, status, last_seen_at, created_at)
         VALUES (?, ?, 'system', 'Device', ?, ?, ?, ?)`,
        [id, centerId, deviceIdentifier, status, now, now],
      );
    }
  }

  /**
   * Asserts that device is active. Throws ForbiddenError if inactive.
   */
  static assertDeviceActive(centerId: string): void {
    const status = this.getDeviceStatus(centerId);
    if (status === "inactive") {
      throw new ForbiddenError(
        "Device is inactive",
        "هذا الجهاز غير نشط أو تم إلغاء تفعيله من قبل الإدارة. تم إيقاف العمليات والمزامنة لحماية البيانات.",
      );
    }
  }
}

export class DeviceService {
  private static cachedDeviceId: string | null = null;

  private static getOrInitPermanentDeviceId(): string {
    if (this.cachedDeviceId) {
      return this.cachedDeviceId;
    }

    try {
      const db = DatabaseService.getDb();
      db.execSync(
        `CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT);`,
      );
      const row = db.getFirstSync<{ value: string }>(
        `SELECT value FROM app_metadata WHERE key = ?`,
        [DEVICE_ID_KEY],
      );
      if (row?.value) {
        this.cachedDeviceId = row.value;
        return this.cachedDeviceId;
      }

      const newId = `dev-${generateUUID()}`;
      db.runSync(
        `INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?);`,
        [DEVICE_ID_KEY, newId],
      );
      this.cachedDeviceId = newId;
      SecureStorageService.setItem(DEVICE_ID_KEY, newId).catch(() => {});
      return this.cachedDeviceId;
    } catch {
      if (!this.cachedDeviceId) {
        this.cachedDeviceId = `dev-${generateUUID()}`;
      }
      return this.cachedDeviceId;
    }
  }

  static async getDeviceId(): Promise<string> {
    return this.getOrInitPermanentDeviceId();
  }

  static getDeviceIdSync(): string {
    return this.getOrInitPermanentDeviceId();
  }

  static setCachedDeviceId(id: string): void {
    this.cachedDeviceId = id;
  }

  static getDeviceInfo() {
    return {
      os: Platform.OS,
      version: Platform.Version,
    };
  }
}
