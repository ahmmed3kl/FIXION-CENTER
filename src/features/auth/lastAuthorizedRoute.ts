import { SecureStorageService } from "../../core/storage";
import { canAccessRoute, resolvePermissionRouteName } from "../../core/permissions/routeAccess";
import { User } from "../../shared/types";

const routeHrefs = {
  dashboard: "/(main)/dashboard",
  more: "/(main)/more",
  students: "/(main)/students",
  scanner: "/(main)/scanner",
  groups: "/(main)/groups",
  "grade-groups": "/(main)/grade-groups",
  grades: "/(main)/grades",
  academic: "/(main)/academic",
  "center-accounts": "/(main)/center-accounts",
  "deleted-students": "/(main)/deleted-students",
  "homework-evaluations": "/(main)/homework-evaluations",
  closing: "/(main)/closing",
  notifications: "/(main)/notifications",
  reports: "/(main)/reports",
  "absence-reports": "/(main)/absence-reports",
  packages: "/(main)/packages",
  "sync-debug": "/(main)/sync-debug",
  "financial-reports": "/(main)/financial-reports",
  "opening-balance": "/(main)/opening-balance",
  "debt-adjustments": "/(main)/debt-adjustments",
} as const;

export type RestorableRouteName = keyof typeof routeHrefs;
export type RestorableRouteHref = (typeof routeHrefs)[RestorableRouteName];

export interface LastAuthorizedRoute {
  userId: string;
  centerId: string;
  routeName: RestorableRouteName;
}

const storageKey = "last_authorized_route";
let storageQueue: Promise<void> = Promise.resolve();

function isRestorableRouteName(value: unknown): value is RestorableRouteName {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(routeHrefs, value);
}

function enqueueStorageOperation(operation: () => Promise<void>): Promise<void> {
  const pending = storageQueue.then(operation, operation);
  storageQueue = pending.catch(() => undefined);
  return pending;
}

export function createLastAuthorizedRoute(
  segments: readonly string[],
  user: User | null | undefined,
  centerId: string | null | undefined,
): LastAuthorizedRoute | null {
  if (!user || !centerId || !user.centerIds?.includes(centerId)) return null;

  const routeName = resolvePermissionRouteName(segments);
  if (!isRestorableRouteName(routeName) || !canAccessRoute(routeName, user.permissions)) {
    return null;
  }

  return { userId: user.id, centerId, routeName };
}

export function resolveLastAuthorizedRoute(
  value: unknown,
  user: User | null | undefined,
  centerId: string | null | undefined,
): RestorableRouteHref | null {
  if (!user || !centerId || !user.centerIds?.includes(centerId)) return null;
  if (!value || typeof value !== "object") return null;

  const snapshot = value as Partial<LastAuthorizedRoute>;
  if (
    snapshot.userId !== user.id ||
    snapshot.centerId !== centerId ||
    !isRestorableRouteName(snapshot.routeName) ||
    !canAccessRoute(snapshot.routeName, user.permissions)
  ) {
    return null;
  }

  return routeHrefs[snapshot.routeName];
}

export function getSafeDefaultRoute(
  user: User | null | undefined,
): RestorableRouteHref {
  return user && canAccessRoute("dashboard", user.permissions)
    ? routeHrefs.dashboard
    : routeHrefs.more;
}

export class LastAuthorizedRouteStore {
  static async save(route: LastAuthorizedRoute): Promise<void> {
    await enqueueStorageOperation(() =>
      SecureStorageService.setItem(storageKey, JSON.stringify(route)),
    );
  }

  static async clear(): Promise<void> {
    await enqueueStorageOperation(() => SecureStorageService.removeItem(storageKey));
  }

  static async restore(
    user: User,
    centerId: string,
  ): Promise<RestorableRouteHref | null> {
    await storageQueue;
    const stored = await SecureStorageService.getItem(storageKey);
    if (!stored) return null;

    let value: unknown;
    try {
      value = JSON.parse(stored);
    } catch (error) {
      console.warn("Ignoring malformed saved navigation route.", error);
      await this.clear();
      return null;
    }

    const href = resolveLastAuthorizedRoute(value, user, centerId);
    if (!href) await this.clear();
    return href;
  }
}
