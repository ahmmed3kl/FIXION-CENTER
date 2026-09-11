import { DatabaseService } from "../../core/database";
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
    // Mock login verification: matches email or phone
    const normalized = identifier.trim().toLowerCase();
    const user = DEMO_USERS.find(
      (u) =>
        (u.email && u.email.toLowerCase() === normalized) ||
        u.phone === identifier.trim(),
    );

    if (!user || (password !== undefined && password !== "123456")) {
      throw new UnauthorizedError(
        "بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.",
      );
    }

    const token = `tok-${user.id}-${Date.now()}`;
    await SecureStorageService.setItem("session_token", token);
    await SecureStorageService.setItem("user_session", JSON.stringify(user));

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
    const db = DatabaseService.getDb();
    const all = db.getAllSync<Center>("SELECT id, name, code FROM centers");
    return all.filter((c: Center) => centerIds.includes(c.id));
  }
}
