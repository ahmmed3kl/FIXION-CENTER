import { Permission } from "../../shared/types";

export const routePermissions: Partial<Record<string, Permission[]>> = {
  index: ["dashboard.view"],
  students: ["students.view"],
  scanner: ["attendance.create"],
  academic: [
    "teachers.view",
    "teachers.create",
    "teachers.update",
    "subjects.view",
    "subjects.create",
    "subjects.update",
    "center.settings.view",
    "center.settings.manage",
  ],
  groups: ["groups.view"],
  "group-details": ["groups.students.view", "students.view"],
  "grade-groups": ["grades.view"],
  grades: ["grades.view"],
  "center-accounts": ["users.view"],
  "deleted-students": ["students.view"],
  packages: ["packages.view"],
  notifications: [
    "notifications.view",
    "notifications.send",
    "notifications.templates.view",
    "notifications.templates.manage",
    "notifications.templates.update",
  ],
  "absence-reports": ["attendance.view", "reports.attendance.view"],
  "absence-group": ["attendance.view", "reports.attendance.view"],
  reports: ["reports.view", "reports.attendance.view", "reports.financial.view", "attendance.view", "payments.debt.view"],
  "financial-reports": ["reports.financial.view", "payments.debt.view"],
  "opening-balance": ["payments.adjust"],
  "debt-adjustments": ["payments.adjust"],
  "homework-evaluations": ["homework.manage"],
  "sync-debug": ["sync.view", "sync.manage"],
  closing: ["daily_closing.view"],
};

const unrestrictedRoutes = new Set(["more", "center-switch"]);
const routeAllPermissions: Partial<Record<string, Permission[]>> = {
  "group-details": ["groups.view"],
};

export function resolvePermissionRouteName(segments: readonly string[]): string {
  if (segments.length === 1 && segments[0] === "(main)") return "index";
  return segments.find((segment) => segment in routePermissions || unrestrictedRoutes.has(segment))
    || segments[segments.length - 1]
    || "unlisted-route";
}

export function canAccessRoute(
  routeName: string,
  permissions: Permission[] | Record<string, boolean> | null | undefined,
): boolean {
  const required = routePermissions[routeName];
  if (!required) return unrestrictedRoutes.has(routeName);
  if (!permissions) return false;
  const requiredAll = routeAllPermissions[routeName] || [];
  const allAllowed = requiredAll.every((permission) =>
    Array.isArray(permissions)
      ? permissions.includes("*" as Permission) || permissions.includes(permission)
      : permissions["*"] === true || permissions[permission] === true,
  );
  if (!allAllowed) return false;
  if (Array.isArray(permissions)) {
    return permissions.includes("*" as Permission) ||
      required.some((permission) => permissions.includes(permission));
  }
  return permissions["*"] === true ||
    required.some((permission) => permissions[permission] === true);
}
