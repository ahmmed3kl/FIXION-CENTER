const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("./errorHandler");

async function platformAuthMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !/^Bearer\s+[^\s]+$/i.test(header)) {
      throw new AppError("UNAUTHORIZED", "Authentication token required.", "يرجى تسجيل الدخول للمتابعة.", 401);
    }
    let decoded;
    try { decoded = jwt.verify(header.replace(/^Bearer\s+/i, ""), config.jwtSecret); }
    catch { throw new AppError("UNAUTHORIZED", "Invalid or expired session token.", "انتهت جلسة الدخول، سجل الدخول مرة أخرى.", 401); }
    if (decoded.scope !== "platform" || decoded.role !== "platform_admin" || !decoded.sub) {
      throw new AppError("FORBIDDEN", "Platform administrator scope required.", "ليس لديك صلاحية الوصول إلى هذه الصفحة.", 403);
    }
    const result = await db.query("SELECT id, full_name, email, status FROM platform_admins WHERE id = $1", [decoded.sub]);
    if (!result.rows[0]) throw new AppError("UNAUTHORIZED", "Platform account not found.", "حساب المسؤول غير موجود.", 401);
    if (result.rows[0].status !== "active") throw new AppError("FORBIDDEN", "Platform account is not active.", "تم تعليق حساب المسؤول.", 403);
    req.platformAdmin = result.rows[0];
    next();
  } catch (error) { next(error); }
}

module.exports = { platformAuthMiddleware };
