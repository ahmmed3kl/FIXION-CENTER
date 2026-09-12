import { Platform } from "react-native";
import { env } from "../../config/env";
import { ApiClient } from "../../core/api";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { UnauthorizedError } from "../../core/errors";
import { RolePermissions } from "../../core/permissions";
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
            permissions?: any;
          };
        }>("/auth/login", {
          identifier: trimmedId,
          password: cleanPassword,
        });

        const data = response.data;
        const user: User = {
          id: data.user.id,
          fullName: data.user.fullName,
          email: data.user.email,
          phone: data.user.phone,
          role: data.user.role,
          centerId: data.user.centerId,
          centerIds: [data.user.centerId],
          permissions:
            data.user.permissions ||
            RolePermissions[data.user.role as keyof typeof RolePermissions] ||
            RolePermissions.admin,
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

        // Ensure center exists in local SQLite
        try {
          const db = DatabaseService.getDb();
          db.runSync(
            `INSERT INTO centers (id, name, code) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code;`,
            [
              data.user.centerId,
              data.user.centerName || "المركز التعليمي",
              data.user.centerId,
            ],
          );
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
        const user = JSON.parse(userJson) as User;
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
      const filtered = all.filter((c: Center) => centerIds.includes(c.id));
      if (filtered.length > 0) return filtered;
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
