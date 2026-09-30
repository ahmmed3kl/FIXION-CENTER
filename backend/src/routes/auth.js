const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

/**
 * Normal Center Login:
 * Email/Phone + Password -> Authenticate -> Single Authoritative Center Context
 */
router.post("/login", async (req, res, next) => {
  try {
    const identifier = (
      req.body.identifier ||
      req.body.email ||
      req.body.phone ||
      ""
    )
      .trim()
      .toLowerCase();
    const password = req.body.password;

    if (!identifier || !password) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Email or phone number and password are required.",
        "يرجى إدخال البريد الإلكتروني/رقم الهاتف وكلمة المرور.",
        400,
      );
    }

    // Lookup user by email or phone
    const userRes = await db.query(
      `SELECT u.id, u.center_id, u.full_name, u.email, u.phone, u.password_hash, u.role, u.permissions, u.status as user_status,
              c.name as center_name, c.code as center_code, c.status as center_status
       FROM users u
       JOIN centers c ON c.id = u.center_id
       WHERE LOWER(u.email) = $1 OR u.phone = $1`,
      [identifier],
    );

    if (userRes.rows.length === 0) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid identifier or password.",
        "بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.",
        401,
      );
    }

    const user = userRes.rows[0];

    // Password verification: checks bcrypt hash (or demo fallback if plaintext seeded)
    let passwordValid = false;
    try {
      passwordValid = await bcrypt.compare(password, user.password_hash);
    } catch {
      passwordValid = false;
    }

    // Fallback for isolated local test seeds if seeded as plaintext
    if (!passwordValid && user.password_hash === password) {
      passwordValid = true;
    }

    if (!passwordValid) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid identifier or password.",
        "بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.",
        401,
      );
    }

    if (user.user_status !== "active") {
      throw new AppError(
        "FORBIDDEN",
        "User account is deactivated.",
        "تم تعطيل هذا الحساب. يرجى التواصل مع الإدارة.",
        403,
      );
    }

    if (user.center_status !== "active") {
      throw new AppError(
        "FORBIDDEN",
        "Educational center account is currently suspended.",
        "حساب المركز التعليمي معلق حالياً.",
        403,
      );
    }

    const centerMemberships = await db.query(
      `SELECT uc.center_id, c.name, c.code
       FROM user_centers uc
       JOIN centers c ON c.id = uc.center_id
       WHERE uc.user_id = $1 AND c.status = 'active'
       ORDER BY uc.is_primary DESC, c.name ASC`,
      [user.id],
    );
    // The legacy users.center_id is also a valid membership. Older accounts
    // may have a user_centers row for only some of their centers, which used
    // to make the primary center disappear from the switcher.
    const membershipCenters = centerMemberships.rows.map((row) => ({ id: row.center_id, name: row.name, code: row.code }));
    if (!membershipCenters.some((center) => center.id === user.center_id)) {
      membershipCenters.unshift({ id: user.center_id, name: user.center_name, code: user.center_code });
    }
    let centerIds = membershipCenters.map((center) => center.id);
    let centers = membershipCenters;
    if (user.role === "admin" || user.role === "owner") {
      const allCenters = await db.query("SELECT id, name, code FROM centers WHERE status = 'active' ORDER BY name ASC");
      centers = allCenters.rows;
      centerIds = centers.map((center) => center.id);
    }

    // Minimal JWT claims as specified in approved design:
    // sub, centerId, role, iat, exp
    const expiresIn = "7d";
    const token = jwt.sign(
      {
        sub: user.id,
        centerId: user.center_id,
        role: user.role,
      },
      config.jwtSecret,
      { expiresIn },
    );

    const permissions =
      typeof user.permissions === "string"
        ? JSON.parse(user.permissions)
        : user.permissions || {};

    return res.json({
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        centerId: user.center_id,
        centerName: user.center_name,
        centerIds,
        centers,
        permissions,
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// Refresh the authenticated user's center memberships without requiring a
// second password login. This is important when a platform admin assigns a
// new center while the app still has a valid seven-day session token.
router.get("/me", authMiddleware, async (req, res, next) => {
  try {
    const centersResult = await db.query(
      "SELECT id, name, code FROM centers WHERE id = ANY($1::text[]) AND status = 'active' ORDER BY name ASC",
      [req.user.centerIds || []],
    );
    const selected = centersResult.rows.find((center) => center.id === req.centerId) || centersResult.rows[0];
    res.json({
      user: {
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email,
        phone: req.user.phone,
        role: req.user.role,
        centerId: req.centerId,
        centerName: selected?.name,
        centerIds: centersResult.rows.map((center) => center.id),
        centers: centersResult.rows,
        permissions: req.user.permissions,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
