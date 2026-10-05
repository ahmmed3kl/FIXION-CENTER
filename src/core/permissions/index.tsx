import React from "react";
import { Permission, UserRole } from "../../shared/types";
export type { Permission, UserRole };

const baseRolePermissions: Record<"admin" | "manager" | "secretary" | "accountant", Permission[]> = {
  admin: [
    "dashboard.view",
    "students.view",
    "students.create",
    "students.edit",
    "students.update",
    "students.deactivate",
    "students.delete",
    "students.restore",
    "students.profile.view",
    "students.cards.manage",
    "teachers.view",
    "teachers.create",
    "teachers.update",
    "teachers.deactivate",
    "subjects.view",
    "subjects.create",
    "subjects.update",
    "subjects.deactivate",
    "subjects.teachers.manage",
    "groups.view",
    "groups.create",
    "groups.update",
    "groups.deactivate",
    "groups.schedule.manage",
    "groups.students.view",
    "grades.view",
    "grades.manage",
    "enrollments.view",
    "enrollments.create",
    "enrollments.update",
    "enrollments.end",
    "sessions.view",
    "sessions.generate",
    "sessions.update",
    "sessions.cancel",
    "sessions.close",
    "sessions.reopen",
    "attendance.view",
    "attendance.create",
    "attendance.makeup",
    "attendance.external",
    "attendance.edit",
    "attendance.close",
    "packages.view",
    "packages.create",
    "packages.update",
    "packages.manage",
    "packages.subscribe",
    "payments.view",
    "payments.create",
    "payments.reverse",
    "payments.adjust",
    "payments.edit",
    "payments.debt.view",
    "reports.view",
    "reports.attendance.view",
    "reports.financial.view",
    "users.view",
    "users.manage",
    "devices.view",
    "settings.view",
    "sync.manage",
    "audit.view",
    "notifications.view",
    "notifications.send",
    "notifications.templates.update",
    "notifications.templates.view",
    "notifications.templates.manage",
    "center.settings.view",
    "center.settings.manage",
    "sync.view",
    "daily_closing.view",
    "daily_closing.close",
    "daily_closing.reopen",
  ],
  manager: [
    "dashboard.view",
    "students.view",
    "students.create",
    "students.edit",
    "students.update",
    "students.deactivate",
    "students.cards.manage",
    "teachers.view",
    "teachers.create",
    "teachers.update",
    "teachers.deactivate",
    "subjects.view",
    "subjects.create",
    "subjects.update",
    "subjects.deactivate",
    "subjects.teachers.manage",
    "groups.view",
    "groups.create",
    "groups.update",
    "groups.deactivate",
    "groups.schedule.manage",
    "grades.view",
    "grades.manage",
    "enrollments.view",
    "enrollments.create",
    "enrollments.update",
    "enrollments.end",
    "sessions.view",
    "sessions.generate",
    "sessions.update",
    "sessions.cancel",
    "sessions.close",
    "attendance.view",
    "attendance.create",
    "attendance.makeup",
    "attendance.external",
    "packages.view",
    "packages.manage",
    "payments.view",
    "payments.create",
    "reports.view",
    "reports.attendance.view",
    "reports.financial.view",
    "users.view",
    "users.manage",
    "settings.view",
    "devices.view",
    "sync.manage",
    "audit.view",
    "notifications.view",
    "notifications.send",
    "daily_closing.view",
    "daily_closing.close",
  ],
  secretary: [
    "dashboard.view",
    "students.view",
    "students.create",
    "students.edit",
    "students.update",
    "students.cards.manage",
    "teachers.view",
    "subjects.view",
    "groups.view",
    "grades.view",
    "grades.manage",
    "enrollments.view",
    "enrollments.create",
    "enrollments.update",
    "enrollments.end",
    "sessions.view",
    "attendance.view",
    "attendance.create",
    "attendance.makeup",
    "attendance.external",
    "packages.view",
    "packages.subscribe",
    "payments.view",
    "payments.create",
    "notifications.view",
    "notifications.send",
    "reports.attendance.view",
  ],
  accountant: [
    "dashboard.view",
    "students.view",
    "groups.view",
    "enrollments.view",
    "packages.view",
    "payments.view",
    "payments.create",
    "payments.reverse",
    "reports.view",
    "reports.attendance.view",
    "reports.financial.view",
    "sessions.view",
    "daily_closing.view",
    "daily_closing.close",
  ],
};

// Keep the mobile role model aligned with the backend. Owners have the full
// administrative set; assistants use the operational secretary set. This
// prevents valid backend users from becoming permissionless when offline.
export const RolePermissions: Record<UserRole, Permission[]> = {
  ...baseRolePermissions,
  // A center manager is the operational administrator of that center. Keep
  // the complete service catalog available offline; server-side center
  // scoping still prevents access to another center.
  manager: baseRolePermissions.admin.filter((permission) => permission !== "payments.reverse"),
  owner: baseRolePermissions.admin,
  assistant: baseRolePermissions.secretary,
};

const legacyPermissionAliases: Record<string, Permission[]> = {
  can_view_dashboard: ["dashboard.view"],
  can_manage_students: ["students.view", "students.create", "students.edit", "students.update"],
  can_manage_teachers: ["teachers.view", "teachers.create", "teachers.update"],
  can_manage_subjects: ["subjects.view", "subjects.create", "subjects.update"],
  can_manage_groups: ["groups.view", "groups.create", "groups.update", "groups.schedule.manage"],
  can_manage_enrollments: ["enrollments.view", "enrollments.create", "enrollments.update", "enrollments.end"],
  can_mark_attendance: ["attendance.view", "attendance.create", "attendance.makeup"],
  can_manage_payments: ["payments.view", "payments.create", "payments.reverse", "payments.adjust"],
  can_manage_financials: ["payments.view", "payments.create", "payments.reverse", "payments.adjust", "reports.financial.view"],
  can_collect_payment: ["payments.view", "payments.create"],
  can_view_reports: ["reports.view", "reports.attendance.view", "reports.financial.view"],
  can_close_session: ["sessions.close", "sessions.reopen", "daily_closing.view", "daily_closing.close"],
  can_manage_packages: ["packages.view", "packages.create", "packages.update", "packages.manage", "packages.subscribe"],
  can_manage_reports: ["reports.view", "reports.attendance.view", "reports.financial.view"],
  can_manage_users: ["users.view", "users.manage"],
  can_manage_settings: ["settings.view"],
  can_manage_notifications: ["notifications.view", "notifications.send", "notifications.templates.update"],
};

/**
 * Resolves user permissions strictly adhering to the Principle of Least Privilege:
 * 1. If permissions are an array, use it exactly, including explicit [].
 * 2. If permissions are missing or malformed:
 *    - Falls back strictly to that SPECIFIC role's permissions (RolePermissions[role]).
 *    - Applies role defaults only when permissions are absent or malformed.
 *    - Unknown or missing roles receive an empty array [] (zero permissions).
 * 1. Admin and Owner are authoritative tenant administrators:
 *    - {"*": true} or ["*"] resolves to full administrative permissions (RolePermissions.admin).
 *    - In addition, an admin/owner with an empty representation (due to DB empty object or
 *      corrupted session-restore cache) resolves to RolePermissions.admin.
 * 2. Granular operational roles (manager, assistant, secretary, accountant):
 *    - Preserve their explicit permissions array or granular object flags strictly.
 *    - An explicit empty array [] REMAINS [] (zero permissions) - NEVER elevated.
 *    - If permissions are an object with specific keys, only those mapped keys are granted.
 *    - If permissions are completely absent (undefined/null or empty {}), falls back to that
 *      role's default permissions only when no explicit restriction exists.
 * 3. Unknown role / malformed: NEVER elevate to Admin.
 */
export function resolveUserPermissions(
  user?: { role?: string; permissions?: any } | null,
): Permission[] {
  if (!user) return [];

  // 1. Explicit permission array; [] deliberately means no permissions.
  const role = user.role as UserRole;
  const isSuperUserRole = role === "admin" || role === "owner";

  // 1. Array representation
  if (Array.isArray(user.permissions)) {
    // If the array explicitly contains the wildcard "*", resolve to full admin permissions.
    if (user.permissions.includes("*" as any)) {
      return RolePermissions.admin;
    }
    // Authoritative admin/owner role fallback:
    // If an admin or owner account has an empty array (due to the known session-restore bug
    // that converted {"*": true} into []), restore their authoritative admin permissions.
    if (isSuperUserRole && user.permissions.length === 0) {
      return RolePermissions.admin;
    }
    // For all other roles (manager, assistant, secretary, accountant):
    // Strict adherence to Principle of Least Privilege: NEVER elevate an empty array []
    // or an explicitly limited array. Return the exact array contents.
    return user.permissions as Permission[];
  }

  // 2. Object representation
  if (user.permissions && typeof user.permissions === "object") {
    // Wildcard superuser object representation {"*": true}
    if (user.permissions["*"] === true || user.permissions["*"] === 1) {
      return RolePermissions.admin;
    }

    // Explicit empty flag used by backend centerUsers ({ __explicit_empty__: true })
    if (user.permissions.__explicit_empty__ === true) {
      return [];
    }

    const mapped = new Set<Permission>();
    for (const [key, enabled] of Object.entries(user.permissions)) {
      if (enabled !== true) continue;
      if (key in legacyPermissionAliases) {
        legacyPermissionAliases[key].forEach((permission) => mapped.add(permission));
      } else if (key.includes(".")) {
        mapped.add(key as Permission);
      }
    }

    // If valid mapped permissions were found, return them strictly without elevation.
    if (mapped.size > 0) {
      return Array.from(mapped);
    }

    // If the object has keys but none mapped to valid permissions,
    // do NOT fall back to broad role permissions if it wasn't admin/owner.
    if (Object.keys(user.permissions).length > 0 && !isSuperUserRole) {
      return [];
    }
  }

  // 3. Strict role-based permissions fallback (when permissions are missing/absent or empty {} for admin/owner)
  if (role && RolePermissions[role]) {
    return RolePermissions[role];
  }

  // 4. Unknown role / malformed: NEVER elevate.
  return [];
}

export class PermissionService {
  static hasPermission(
    userPermissions: Permission[] | any,
    required: Permission,
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return userPermissions.includes(required) || userPermissions.includes("*" as any);
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return userPermissions[required] === true || userPermissions["*"] === true;
    }
    return false;
  }

  static hasAnyPermission(
    userPermissions: Permission[] | any,
    required: Permission[],
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return userPermissions.includes("*" as any) || required.some((p) => userPermissions.includes(p));
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return userPermissions["*"] === true || required.some((p) => userPermissions[p] === true);
    }
    return false;
  }

  static hasAllPermissions(
    userPermissions: Permission[] | any,
    required: Permission[],
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return userPermissions.includes("*" as any) || required.every((p) => userPermissions.includes(p));
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return userPermissions["*"] === true || required.every((p) => userPermissions[p] === true);
    }
    return false;
  }
}

interface PermissionGateProps {
  permission: Permission;
  userPermissions: Permission[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const PermissionGate: React.FC<PermissionGateProps> = ({
  permission,
  userPermissions,
  children,
  fallback = null,
}) => {
  const allowed = PermissionService.hasPermission(userPermissions, permission);
  return allowed ? <>{children}</> : <>{fallback}</>;
};
