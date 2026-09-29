import React from "react";
import { Permission, UserRole } from "../../shared/types";

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
  can_manage_packages: ["packages.view", "packages.create", "packages.update", "packages.manage", "packages.subscribe"],
  can_manage_reports: ["reports.view", "reports.attendance.view", "reports.financial.view"],
  can_manage_users: ["users.view", "users.manage"],
  can_manage_settings: ["settings.view"],
  can_manage_notifications: ["notifications.view", "notifications.send", "notifications.templates.update"],
};

/**
 * Resolves user permissions strictly adhering to the Principle of Least Privilege:
 * 1. If user has a valid, non-empty Permission[] array, use it directly.
 * 2. If permissions are missing, empty, or malformed:
 *    - Falls back strictly to that SPECIFIC role's permissions (RolePermissions[role]).
 *    - NEVER elevates a non-admin role (secretary, accountant, manager) to admin.
 *    - Unknown or missing roles receive an empty array [] (zero permissions).
 */
export function resolveUserPermissions(
  user?: { role?: string; permissions?: any } | null,
): Permission[] {
  if (!user) return [];

  // 1. Valid non-empty array
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    return user.permissions as Permission[];
  }

  // The API historically returned an object of boolean legacy flags, while
  // the mobile app uses canonical dotted permission names. Translate the
  // object instead of silently discarding it and falling back to a broader
  // role.
  if (user.permissions && typeof user.permissions === "object" && !Array.isArray(user.permissions)) {
    const mapped = new Set<Permission>();
    for (const [key, enabled] of Object.entries(user.permissions)) {
      if (enabled !== true) continue;
      if (key in legacyPermissionAliases) {
        legacyPermissionAliases[key].forEach((permission) => mapped.add(permission));
      } else if (key.includes(".")) {
        mapped.add(key as Permission);
      }
    }
    if (mapped.size > 0 || Object.keys(user.permissions).length > 0) {
      return Array.from(mapped);
    }
  }

  // 2. Strict role-based permissions fallback (Principle of Least Privilege)
  const role = user.role as UserRole;
  if (role && RolePermissions[role]) {
    return RolePermissions[role];
  }

  // 3. Unknown role / malformed: NEVER elevate to Admin.
  return [];
}

export class PermissionService {
  static hasPermission(
    userPermissions: Permission[] | any,
    required: Permission,
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return userPermissions.includes(required);
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return userPermissions[required] === true;
    }
    return false;
  }

  static hasAnyPermission(
    userPermissions: Permission[] | any,
    required: Permission[],
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return required.some((p) => userPermissions.includes(p));
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return required.some((p) => userPermissions[p] === true);
    }
    return false;
  }

  static hasAllPermissions(
    userPermissions: Permission[] | any,
    required: Permission[],
  ): boolean {
    if (!userPermissions) return false;
    if (Array.isArray(userPermissions)) {
      return required.every((p) => userPermissions.includes(p));
    }
    if (typeof userPermissions === "object" && userPermissions !== null) {
      return required.every((p) => userPermissions[p] === true);
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
