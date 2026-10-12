const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { platformAuthMiddleware } = require("../middleware/platformAuth");
const { defaultPermissionsForRole } = require("../middleware/auth");
const { record } = require("../services/auditService");

const router = express.Router({ mergeParams: true });
router.use(platformAuthMiddleware);

const roles = new Set(["admin", "assistant", "secretary", "accountant", "manager"]);
const creatableRoles = new Set(["admin", "manager", "assistant"]);
const statuses = new Set(["active", "inactive", "suspended"]);
const safeFields = "id,center_id,full_name,email,phone,role,permissions,status,created_at,updated_at";

function validatePassword(password) {
  return typeof password === "string" &&
    password.length >= 12 &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password);
}

function safeUser(user) {
  return {
    id: user.id,
    center_id: user.center_id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

function auditState(user) {
  const value = safeUser(user);
  return { ...value, name: value.full_name };
}

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const values = [req.params.centerId];
    const where = ["u.center_id=$1"];
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim()}%`);
      where.push(`(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
    }
    if (req.query.role && roles.has(req.query.role)) {
      values.push(req.query.role);
      where.push(`u.role=$${values.length}`);
    }
    if (req.query.status && statuses.has(req.query.status)) {
      values.push(req.query.status);
      where.push(`u.status=$${values.length}`);
    }
    const clause = where.join(" AND ");
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM users u WHERE ${clause}`, values);
    const queryValues = values.concat([pageSize, (page - 1) * pageSize]);
    const rows = await db.query(
      `SELECT ${safeFields} FROM users u WHERE ${clause} ORDER BY u.created_at DESC LIMIT $${queryValues.length - 1} OFFSET $${queryValues.length}`,
      queryValues,
    );
    res.json({
      items: rows.rows.map(safeUser),
      pagination: {
        page,
        pageSize,
        total: count.rows[0].total,
        totalPages: Math.ceil(count.rows[0].total / pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:userId", async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ${safeFields} FROM users WHERE center_id=$1 AND id=$2`,
      [req.params.centerId, req.params.userId],
    );
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "User not found.", "المستخدم غير موجود.", 404);
    res.json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name || req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "");
    const password = req.body.password;
    if (name.length < 2 || name.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !creatableRoles.has(role) || !validatePassword(password)) {
      throw new AppError("VALIDATION_ERROR", "Invalid user fields.", "راجع بيانات المستخدم وكلمة المرور.", 400);
    }
    const permissions = defaultPermissionsForRole(role);
    const hash = await bcrypt.hash(password, 12);
    const user = await db.withTransaction(async (client) => {
      const center = await client.query("SELECT id FROM centers WHERE id=$1 FOR UPDATE", [req.params.centerId]);
      if (!center.rows[0]) throw new AppError("NOT_FOUND", "Center not found.", "المركز غير موجود.", 404);
      const duplicate = await client.query("SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1", [email]);
      if (duplicate.rows[0]) throw new AppError("CONFLICT", "An account with this email already exists.", "يوجد حساب بهذا البريد الإلكتروني بالفعل.", 409);
      if (role === "admin") {
        const existingAdmin = await client.query(
          "SELECT 1 FROM users WHERE center_id=$1 AND role='admin' AND status='active' LIMIT 1",
          [req.params.centerId],
        );
        if (existingAdmin.rows.length) {
          throw new AppError("CONFLICT", "An active center admin already exists.", "يوجد مسؤول نشط بالفعل لهذا المركز.", 409);
        }
      }
      const inserted = await client.query(
        "INSERT INTO users (id,center_id,full_name,email,phone,password_hash,role,permissions,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING " + safeFields,
        ["user-" + crypto.randomUUID(), req.params.centerId, name, email, req.body.phone || null, hash, role, JSON.stringify(permissions)],
      );
      const created = inserted.rows[0];
      await client.query(
        "INSERT INTO user_centers (id,user_id,center_id,role,is_primary) VALUES ($1,$2,$3,$4,TRUE)",
        ["uc-" + crypto.randomUUID(), created.id, req.params.centerId, role],
      );
      return created;
    });
    await record({
      actor: req.platformAdmin,
      centerId: req.params.centerId,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      after: auditState(user),
    });
    res.status(201).json({ user: safeUser(user) });
  } catch (error) { next(error); }
});
router.patch("/:userId", async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      // Serialize administrator demotions within a center. The partial unique
      // index prevents duplicate active admins; this lock also prevents two
      // concurrent demotions from both observing the same last active admin.
      await client.query("SELECT id FROM centers WHERE id=$1 FOR UPDATE", [req.params.centerId]);
      const beforeResult = await client.query(
        `SELECT ${safeFields} FROM users WHERE center_id=$1 AND id=$2 FOR UPDATE`,
        [req.params.centerId, req.params.userId],
      );
      const before = beforeResult.rows[0];
      if (!before) throw new AppError("NOT_FOUND", "User not found.", "المستخدم غير موجود.", 404);

      const keys = [];
      const values = [];
      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (name.length < 2 || name.length > 255) {
          throw new AppError("VALIDATION_ERROR", "Invalid name.", "اسم المستخدم غير صحيح.", 400);
        }
        keys.push("full_name");
        values.push(name);
      }
      if (req.body.email !== undefined) {
        const email = String(req.body.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new AppError("VALIDATION_ERROR", "Invalid email.", "البريد الإلكتروني غير صحيح.", 400);
        }
        const duplicate = await client.query(
          "SELECT id FROM users WHERE LOWER(email)=$1 AND id<>$2 LIMIT 1",
          [email, req.params.userId],
        );
        if (duplicate.rows[0]) {
          throw new AppError("CONFLICT", "An account with this email already exists.", "يوجد حساب بهذا البريد الإلكتروني بالفعل.", 409);
        }
        keys.push("email");
        values.push(email);
      }
      if (req.body.role !== undefined) {
        if (!roles.has(req.body.role)) {
          throw new AppError("VALIDATION_ERROR", "Invalid role.", "الدور غير مسموح.", 400);
        }
        if (req.body.role === "admin" && before.role !== "admin") {
          const existing = await client.query(
            "SELECT 1 FROM users WHERE center_id=$1 AND role='admin' AND status='active' AND id<>$2 LIMIT 1",
            [req.params.centerId, req.params.userId],
          );
          if (existing.rows.length) {
            throw new AppError("CONFLICT", "An active center admin already exists.", "يوجد مسؤول نشط بالفعل لهذا المركز.", 409);
          }
        }
        if (before.role === "admin" && before.status === "active" && req.body.role !== "admin") {
          const admins = await client.query(
            "SELECT COUNT(*)::int AS count FROM users WHERE center_id=$1 AND role='admin' AND status='active'",
            [req.params.centerId],
          );
          if (admins.rows[0].count <= 1) {
            throw new AppError(
              "CONFLICT",
              "The only active center admin cannot be demoted.",
              "لا يمكن تغيير دور المسؤول النشط الوحيد للمركز.",
              409,
            );
          }
        }
        keys.push("role");
        values.push(req.body.role);
      }
      if (!keys.length) {
        throw new AppError("VALIDATION_ERROR", "No editable fields.", "لا توجد بيانات قابلة للتعديل.", 400);
      }
      values.push(req.params.centerId, req.params.userId);
      const updated = await client.query(
        `UPDATE users SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")},updated_at=NOW()
         WHERE center_id=$${values.length - 1} AND id=$${values.length} RETURNING ${safeFields}`,
        values,
      );
      if (req.body.role !== undefined) {
        await client.query("UPDATE user_centers SET role=$1 WHERE user_id=$2", [req.body.role, req.params.userId]);
      }
      await record({
        client,
        actor: req.platformAdmin,
        centerId: req.params.centerId,
        action: "user.updated",
        entityType: "user",
        entityId: updated.rows[0].id,
        before: auditState(before),
        after: auditState(updated.rows[0]),
      });
      return updated.rows[0];
    });
    res.json({ user: safeUser(result) });
  } catch (error) {
    next(error);
  }
});

async function setStatus(req, res, next, status) {
  try {
    const result = await db.withTransaction(async (client) => {
      await client.query("SELECT id FROM centers WHERE id=$1 FOR UPDATE", [req.params.centerId]);
      const beforeResult = await client.query(
        `SELECT ${safeFields} FROM users WHERE center_id=$1 AND id=$2 FOR UPDATE`,
        [req.params.centerId, req.params.userId],
      );
      const before = beforeResult.rows[0];
      if (!before) throw new AppError("NOT_FOUND", "User not found.", "المستخدم غير موجود.", 404);

      if (status === "inactive" && before.role === "admin" && before.status === "active") {
        const admins = await client.query(
          "SELECT COUNT(*)::int AS count FROM users WHERE center_id=$1 AND role='admin' AND status='active'",
          [req.params.centerId],
        );
        if (admins.rows[0].count <= 1) {
          throw new AppError(
            "CONFLICT",
            "The only active center admin cannot be deactivated.",
            "لا يمكن تعطيل المسؤول الوحيد النشط للمركز.",
            409,
          );
        }
      }

      const updated = await client.query(
        `UPDATE users SET status=$1,updated_at=NOW() WHERE center_id=$2 AND id=$3 RETURNING ${safeFields}`,
        [status, req.params.centerId, req.params.userId],
      );
      await record({
        client,
        actor: req.platformAdmin,
        centerId: req.params.centerId,
        action: status === "active" ? "user.activated" : "user.deactivated",
        entityType: "user",
        entityId: updated.rows[0].id,
        before: auditState(before),
        after: auditState(updated.rows[0]),
      });
      return updated.rows[0];
    });
    res.json({ user: safeUser(result) });
  } catch (error) {
    next(error);
  }
}

router.post("/:userId/deactivate", (req, res, next) => setStatus(req, res, next, "inactive"));
router.post("/:userId/activate", (req, res, next) => setStatus(req, res, next, "active"));

router.post("/:userId/reset-password", async (req, res, next) => {
  try {
    if (!validatePassword(req.body.password)) {
      throw new AppError("VALIDATION_ERROR", "Invalid password.", "كلمة المرور غير صحيحة.", 400);
    }
    const hash = await bcrypt.hash(req.body.password, 12);
    const result = await db.query(
      "UPDATE users SET password_hash=$1,updated_at=NOW() WHERE center_id=$2 AND id=$3 RETURNING id",
      [hash, req.params.centerId, req.params.userId],
    );
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "User not found.", "المستخدم غير موجود.", 404);
    await record({
      actor: req.platformAdmin,
      centerId: req.params.centerId,
      action: "user.password_reset",
      entityType: "user",
      entityId: result.rows[0].id,
      metadata: { result: "completed" },
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
