import { Platform } from "react-native";
import { env } from "../../config/env";
import { ApiClient } from "../../core/api";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { UnauthorizedError } from "../../core/errors";
import {
    RolePermissions,
    resolveUserPermissions,
} from "../../core/permissions";
import { SecureStorageService } from "../../core/storage";
import { Center, User } from "../../shared/types";

export const DEMO_USERS: User[] = [
  {
    id: "usr-admin-1",
    fullName: "أحمد الإدريسي (المدير)",
    email: "admin@center1.com",
    phone: "01000000001",
    role: "admin",
    centerId: "center-1",
    centerIds: ["center-1", "center-2"],
    permissions: RolePermissions.admin,
  },
  {
    id: "usr-sec-1",
    fullName: "سارة يوسف (السكرتارية)",
    email: "secretary@center1.com",
    phone: "01000000002",
    role: "secretary",
    centerId: "center-1",
    centerIds: ["center-1"],
    permissions: RolePermissions.secretary,
  },
  {
    id: "usr-acc-1",
    fullName: "خالد ممدوح (المحاسب)",
    email: "accountant@center1.com",
    phone: "01000000003",
    role: "accountant",
    centerId: "center-1",
    centerIds: ["center-1"],
    permissions: RolePermissions.accountant,
  },
  {
    id: "usr-admin-2",
    fullName: "عمرو سالم (مدير فرع 2)",
    email: "admin@center2.com",
    phone: "01000000004",
    role: "admin",
    centerId: "center-2",
    centerIds: ["center-2"],
    permissions: RolePermissions.admin,
  },
];

export class AuthRepository {
  static async login(
    identifier: string,
    password?: string,
  ): Promise<{ user: User; token: string }> {
    const trimmedId = identifier.trim();
    const cleanPassword = password || "123456";

    // 1. Live Cloud API Authentication (Render + Neon PostgreSQL)
    if (!env.enableMockData) {
      // A login attempt must start from a clean client session. Otherwise a
      // stale token from a previous install/reset can be attached to other
      // requests while the new credentials are being verified.
      await SecureStorageService.clearSession();
      try {
        const client = ApiClient.getInstance();
        const response = await client.post<{
          token: string;
          user: {
            id: string;
            fullName: string;
            email: string;
            phone: string;
            role: any;
            centerId: string;
            centerName?: string;
            centerIds?: string[];
            centers?: Center[];
            permissions?: any;
          };
        }>("/auth/login", {
          identifier: trimmedId,
          password: cleanPassword,
        });

        const data = response.data;
        const resolvedPermissions = resolveUserPermissions(data.user);

        const demoMatch = DEMO_USERS.find(
          (u) =>
            u.id === data.user.id ||
            (u.email &&
              u.email.toLowerCase() === data.user.email?.toLowerCase()) ||
            u.phone === data.user.phone,
        );
        const resolvedCenterIds =
          data.user.centerIds?.length
            ? data.user.centerIds
            : demoMatch?.centerIds || [data.user.centerId];

        const user: User = {
          id: data.user.id,
          fullName: data.user.fullName,
          email: data.user.email,
          phone: data.user.phone,
          role: data.user.role,
          centerId: data.user.centerId,
          centerIds: resolvedCenterIds,
          permissions: resolvedPermissions,
        };

        await SecureStorageService.setItem("session_token", data.token);
        await SecureStorageService.setItem(
          "user_session",
          JSON.stringify(user),
        );
        await SecureStorageService.setItem(
          "active_center_id",
          data.user.centerId,
        );

        // Cache every center membership locally so the switcher can show all
        // centers, not only the center selected during login.
        try {
          const db = DatabaseService.getDb();
          const centers = data.user.centers?.length
            ? data.user.centers
            : [{ id: data.user.centerId, name: data.user.centerName || "المركز التعليمي", code: data.user.centerId }];
          for (const center of centers) {
            db.runSync(`INSERT OR REPLACE INTO centers (id, name, code) VALUES (?, ?, ?);`, [center.id, center.name || "المركز التعليمي", center.code || center.id]);
          }
        } catch {}

        // Auto-register device with live backend
        try {
          const deviceId = await DeviceService.getDeviceId();
          await client.post(
            "/devices/register",
            {
              deviceId,
              deviceName: `${Platform.OS.toUpperCase()}-Device-${deviceId.slice(-4)}`,
              platform: Platform.OS,
              appVersion: env.appVersion,
            },
            {
              headers: {
                Authorization: `Bearer ${data.token}`,
                "X-Center-Id": data.user.centerId,
                "X-Device-Id": deviceId,
              },
            },
          );
        } catch (devErr) {
          console.warn("Device registration notice:", devErr);
        }

        return { user, token: data.token };
      } catch (apiErr: any) {
        // If server returns invalid credentials, throw directly
        if (
          apiErr?.statusCode === 401 ||
          apiErr?.name === "UnauthorizedError" ||
          apiErr?.message?.includes("401") ||
          apiErr?.userMessage
        ) {
          throw new UnauthorizedError(
            apiErr?.userMessage ||
              "بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.",
          );
        }
        console.warn("API login attempt failed, checking fallback:", apiErr);
      }
    }

    // 2. Fallback / Mock Login Verification
    const normalized = trimmedId.toLowerCase();
    const user = DEMO_USERS.find(
      (u) =>
        (u.email && u.email.toLowerCase() === normalized) ||
        u.phone === trimmedId,
    );

    if (!user || (password !== undefined && password !== "123456")) {
      throw new UnauthorizedError(
        "بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.",
      );
    }

    const token = `tok-${user.id}-${Date.now()}`;
    await SecureStorageService.setItem("session_token", token);
    await SecureStorageService.setItem("user_session", JSON.stringify(user));
    await SecureStorageService.setItem(
      "active_center_id",
      user.centerId || user.centerIds?.[0] || "center-1",
    );

    return { user, token };
  }

  static async restoreSession(): Promise<{ user: User; token: string } | null> {
    const token = await SecureStorageService.getItem("session_token");
    const userJson = await SecureStorageService.getItem("user_session");

    if (token && userJson) {
      try {
        const parsed = JSON.parse(userJson) as User;

        const normalizedPermissions = resolveUserPermissions(parsed);
        const user: User = { ...parsed, permissions: normalizedPermissions };

        // Proactively ensure device is registered on the live backend during restore
        if (!env.enableMockData && token && user.centerId) {
          DeviceService.getDeviceId()
            .then(async (deviceId) => {
              try {
                const client = ApiClient.getInstance();
                await client.post(
                  "/devices/register",
                  {
                    deviceId,
                    deviceName: `${Platform.OS.toUpperCase()}-Device-${deviceId.slice(-4)}`,
                    platform: Platform.OS,
                    appVersion: env.appVersion,
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "X-Center-Id": user.centerId,
                      "X-Device-Id": deviceId,
                    },
                  },
                );
              } catch (regErr) {
                console.warn(
                  "Device registration on restoreSession notice:",
                  regErr,
                );
              }
            })
            .catch(() => {});
        }

        return { user, token };
      } catch {
        return null;
      }
    }
    return null;
  }

  static async logout(): Promise<void> {
    await SecureStorageService.clearSession();
  }

  static getCentersForUser(centerIds: string[]): Center[] {
    try {
      const db = DatabaseService.getDb();
      const all = db.getAllSync<Center>("SELECT id, name, code FROM centers");
      const known = new Map(all.map((center) => [center.id, center]));
      return centerIds.map((id) => known.get(id) || {
        id,
        name: id === "center-2" ? "الفرع الثاني" : "المركز التعليمي",
        code: id,
      });
    } catch {}

    return centerIds.map((id) => ({
      id,
      name:
        id === "center-2"
          ? "الفرع الثاني - مدينة نصر"
          : "الفرع الرئيسي - مصر الجديدة",
      code: id,
    }));
  }
}
