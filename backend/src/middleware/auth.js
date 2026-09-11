const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("./errorHandler");

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

    // Authoritatively derive tenant context from authenticated user
    req.user = user;
    req.centerId = user.center_id;

    // Tenant Isolation Consistency Check:
    // If client provided X-Center-Id header, it MUST match the authenticated user's center_id.
    const clientHeaderCenterId = req.headers["x-center-id"];
    if (clientHeaderCenterId && clientHeaderCenterId !== req.centerId) {
      throw new AppError(
        "TENANT_MISMATCH",
        `Access denied. Client header specifies center '${clientHeaderCenterId}', but authenticated session belongs to '${req.centerId}'.`,
        "غير مصرح لك بالوصول لبيانات مركز تعليمي آخر.",
        403,
      );
    }

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

    if (!permissions[permissionKey]) {
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
