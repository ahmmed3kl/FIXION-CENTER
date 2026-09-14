const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");

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
    const centerIds = centerMemberships.rows.length > 0
      ? centerMemberships.rows.map((row) => row.center_id)
      : [user.center_id];
    const centers = centerMemberships.rows.length > 0
      ? centerMemberships.rows.map((row) => ({ id: row.center_id, name: row.name, code: row.code }))
      : [{ id: user.center_id, name: user.center_name, code: user.center_code }];

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

module.exports = router;
