const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("./errorHandler");

// Keep server-side defaults aligned with the mobile role fallback. Platform
// user creation historically stored `{}` and relied on the client to infer
// permissions, which made offline UI and online sync disagree.
const ROLE_DEFAULT_PERMISSIONS = {
  admin: "*",
  owner: "*",
  manager: ["dashboard.view","students.view","students.create","students.edit","students.update","students.deactivate","students.cards.manage","teachers.view","teachers.create","teachers.update","teachers.deactivate","subjects.view","subjects.create","subjects.update","subjects.deactivate","subjects.teachers.manage","groups.view","groups.create","groups.update","groups.deactivate","groups.schedule.manage","grades.view","grades.manage","enrollments.view","enrollments.create","enrollments.update","enrollments.end","sessions.view","sessions.generate","sessions.update","sessions.cancel","sessions.close","sessions.reopen","attendance.view","attendance.create","attendance.makeup","attendance.external","packages.view","packages.manage","packages.subscribe","payments.view","payments.create","payments.reverse","payments.adjust","reports.view","reports.attendance.view","reports.financial.view","users.view","devices.view","settings.view","sync.manage","audit.view","notifications.view","notifications.send","notifications.templates.update","daily_closing.view","daily_closing.close"],
  secretary: ["dashboard.view","students.view","students.create","students.edit","students.update","students.cards.manage","teachers.view","subjects.view","groups.view","grades.view","grades.manage","enrollments.view","enrollments.create","enrollments.update","enrollments.end","sessions.view","attendance.view","attendance.create","attendance.makeup","attendance.external","packages.view","packages.subscribe","payments.view","payments.create","notifications.view","notifications.send","reports.attendance.view"],
  assistant: ["dashboard.view","students.view","students.create","students.edit","students.update","students.cards.manage","teachers.view","subjects.view","groups.view","grades.view","grades.manage","enrollments.view","enrollments.create","enrollments.update","enrollments.end","sessions.view","attendance.view","attendance.create","attendance.makeup","attendance.external","packages.view","packages.subscribe","payments.view","payments.create","notifications.view","notifications.send","reports.attendance.view"],
  accountant: ["dashboard.view","students.view","groups.view","enrollments.view","packages.view","payments.view","payments.create","payments.reverse","reports.view","reports.attendance.view","reports.financial.view","sessions.view","daily_closing.view","daily_closing.close"],
};

function resolveLivePermissions(user) {
  let value = user.permissions;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  if (Array.isArray(value) && value.length) return value;
  if (value && typeof value === "object" && Object.keys(value).length) return value;
  const defaults = ROLE_DEFAULT_PERMISSIONS[user.role] || [];
  return defaults === "*" ? { "*": true } : Object.fromEntries(defaults.map((key) => [key, true]));
}

/**
 * Authentication middleware that strictly verifies JWT and derives center_id authoritatively.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(
        "UNAUTHORIZED",
        "Authentication token required.",
        "يرجى تسجيل الدخول أولاً للمتابعة.",
        401,
      );
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (jwtErr) {
      throw new AppError(
        "UNAUTHORIZED",
        "Invalid or expired session token.",
        "انتهت صلاحية جلسة الدخول. يرجى تسجيل الدخول مرة أخرى.",
        401,
      );
    }

    // Live permission & status resolution from PostgreSQL database
    // Ensures status changes or role updates take effect immediately without token expiration
    const userRes = await db.query(
      "SELECT id, center_id, full_name, email, phone, role, permissions, status FROM users WHERE id = $1",
      [decoded.sub],
    );

    if (userRes.rows.length === 0) {
      throw new AppError(
        "UNAUTHORIZED",
        "User account not found.",
        "حساب المستخدم غير مسجل.",
        401,
      );
    }

    const user = userRes.rows[0];

    if (user.status !== "active") {
      throw new AppError(
        "FORBIDDEN",
        "User account has been suspended or deactivated.",
        "تم تعطيل أو تعليق هذا الحساب. يرجى التواصل مع الإدارة.",
        403,
      );
    }

    // A user may be assigned to more than one center through user_centers.
    // The requested header is accepted only when that membership exists.
    const memberships = await db.query(
      `SELECT uc.center_id, c.status as center_status
       FROM user_centers uc
       JOIN centers c ON c.id = uc.center_id
       WHERE uc.user_id = $1`,
      [user.id],
    );
    const activeMembershipCenterIds = memberships.rows
      .filter((row) => row.center_status === "active")
      .map((row) => row.center_id);
    // Keep the legacy primary center as an allowed center even when older
    // data has not copied it into user_centers yet.
    let allowedCenters = Array.from(new Set([user.center_id, ...activeMembershipCenterIds]));
    // Center manager/assistant accounts are single-center identities. Even if
    // stale membership rows or a forged x-center-id header exist, they cannot
    // switch tenant context like a platform/admin account.
    if (user.role === "manager" || user.role === "assistant") {
      allowedCenters = [user.center_id];
    }
    // The system owner/admin manages every active center. Other roles remain
    // restricted to their explicit user_centers memberships.
    if (user.role === "admin" || user.role === "owner") {
      const allCenters = await db.query("SELECT id FROM centers WHERE status = 'active' ORDER BY name ASC");
      allowedCenters = allCenters.rows.map((row) => row.id);
    }
    const clientHeaderCenterId = req.headers["x-center-id"];
    const requestedCenterId = (user.role === "manager" || user.role === "assistant")
      ? user.center_id
      : (clientHeaderCenterId || decoded.centerId || user.center_id);
    if (!allowedCenters.includes(requestedCenterId)) {
      throw new AppError(
        "TENANT_MISMATCH",
        `Access denied. User is not assigned to center '${requestedCenterId}'.`,
        "غير مصرح لك بالوصول لبيانات مركز تعليمي آخر.",
        403,
      );
    }

    // Authoritatively derive the selected tenant context after membership validation.
    req.user = { ...user, permissions: resolveLivePermissions(user), center_id: requestedCenterId, centerIds: allowedCenters };
    req.centerId = requestedCenterId;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role / Permission Authorization guard
 */
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) {
      return next(
        new AppError(
          "UNAUTHORIZED",
          "Unauthenticated",
          "يرجى تسجيل الدخول",
          401,
        ),
      );
    }

    // Admin role has all permissions by definition
    if (req.user.role === "admin" || req.user.role === "owner") {
      return next();
    }

    const permissions =
      typeof req.user.permissions === "string"
        ? JSON.parse(req.user.permissions)
        : req.user.permissions || {};

    const allowed = Array.isArray(permissions)
      ? permissions.includes(permissionKey)
      : permissions[permissionKey] === true || permissions["*"] === true;
    if (!allowed) {
      return next(
        new AppError(
          "FORBIDDEN",
          `Missing required permission: ${permissionKey}`,
          "ليس لديك الصلاحية الكافية للقيام بهذا الإجراء.",
          403,
        ),
      );
    }

    next();
  };
}

module.exports = {
  authMiddleware,
  requirePermission,
};
