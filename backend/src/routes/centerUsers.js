const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { authMiddleware, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware, requirePermission("users.manage"));
const roles = new Set(["manager", "assistant"]);
const safeFields = "id,center_id,full_name,email,phone,role,permissions,status,created_at,updated_at";
const allowedPermissions = new Set([
  "dashboard.view", "students.view", "students.create", "students.edit", "students.update", "students.delete", "students.restore", "students.profile.view",
  "groups.view", "groups.create", "groups.update", "groups.deactivate", "groups.students.view", "groups.schedule.manage",
  "attendance.view", "attendance.create", "attendance.edit", "attendance.close", "attendance.makeup",
  "payments.view", "payments.create", "payments.edit", "payments.debt.view", "payments.reverse", "payments.adjust",
  "packages.view", "packages.subscribe", "grades.view", "grades.manage", "reports.view", "reports.attendance.view", "reports.financial.view",
  "notifications.view", "notifications.send", "notifications.templates.view", "notifications.templates.manage", "center.settings.view", "center.settings.manage", "devices.view", "sync.view", "sync.manage", "settings.view", "users.manage",
]);
function passwordValid(value) { return typeof value === "string" && value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value); }
function safeUser(row) { return { id: row.id, centerId: row.center_id, fullName: row.full_name, email: row.email, phone: row.phone || null, role: row.role, permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions || "[]") : (row.permissions || []), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
function cleanPermissions(value) {
  // The auth middleware evaluates permissions as a JSON object keyed by the
  // permission name. Accept both the mobile-friendly array form and the
  // persisted object form, but always store the canonical object shape.
  const keys = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value).filter((key) => value[key])
      : [];
  return Object.fromEntries(Array.from(new Set(keys.filter((permission) => allowedPermissions.has(permission)))).map((permission) => [permission, true]));
}
function validateRole(role) { if (!roles.has(role)) throw new AppError("VALIDATION_ERROR", "Invalid center account role.", "نوع الحساب يجب أن يكون مديرًا أو مساعدًا.", 400); }

router.get("/", async (req, res, next) => {
  try {
    const result = await db.query(`SELECT ${safeFields} FROM users WHERE center_id=$1 AND role IN ('manager','assistant') ORDER BY created_at DESC`, [req.centerId]);
    res.json({ items: result.rows.map(safeUser) });
  } catch (error) { next(error); }
});

router.post("/", async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "");
    if (fullName.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || !passwordValid(req.body.password)) throw new AppError("VALIDATION_ERROR", "Invalid account fields.", "راجع الاسم والبريد وكلمة المرور.", 400);
    validateRole(role);
    const permissions = cleanPermissions(req.body.permissions);
    const hash = await bcrypt.hash(req.body.password, 12);
    const result = await db.query(`INSERT INTO users (id,center_id,full_name,email,phone,password_hash,role,permissions,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING ${safeFields}`, [`user-${crypto.randomUUID()}`, req.centerId, fullName, email, req.body.phone || null, hash, role, JSON.stringify(permissions)]);
    res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) { next(error); }
});

router.patch("/:userId", async (req, res, next) => {
  try {
    const before = await db.query(`SELECT ${safeFields} FROM users WHERE center_id=$1 AND id=$2 AND role IN ('manager','assistant')`, [req.centerId, req.params.userId]);
    if (!before.rows[0]) throw new AppError("NOT_FOUND", "Account not found.", "الحساب غير موجود.", 404);
    const keys = [], values = [];
    if (req.body.fullName !== undefined) { const value = String(req.body.fullName).trim(); if (value.length < 2) throw new AppError("VALIDATION_ERROR", "Invalid name.", "اسم الحساب غير صحيح.", 400); keys.push("full_name"); values.push(value); }
    if (req.body.email !== undefined) { const value = String(req.body.email).trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(value)) throw new AppError("VALIDATION_ERROR", "Invalid email.", "البريد الإلكتروني غير صحيح.", 400); keys.push("email"); values.push(value); }
    if (req.body.role !== undefined) { validateRole(req.body.role); keys.push("role"); values.push(req.body.role); }
    if (req.body.permissions !== undefined) { keys.push("permissions"); values.push(JSON.stringify(cleanPermissions(req.body.permissions))); }
    if (req.body.password !== undefined && req.body.password !== "") {
      if (!passwordValid(req.body.password)) throw new AppError("VALIDATION_ERROR", "Invalid password.", "كلمة المرور يجب أن تكون 12 حرفًا على الأقل وتحتوي على حرف ورقم.", 400);
      keys.push("password_hash"); values.push(await bcrypt.hash(req.body.password, 12));
    }
    if (!keys.length) throw new AppError("VALIDATION_ERROR", "No editable fields.", "لا توجد بيانات قابلة للتعديل.", 400);
    values.push(req.centerId, req.params.userId);
    const result = await db.query(`UPDATE users SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")},updated_at=NOW() WHERE center_id=$${values.length - 1} AND id=$${values.length} AND role IN ('manager','assistant') RETURNING ${safeFields}`, values);
    res.json({ user: safeUser(result.rows[0]) });
  } catch (error) { next(error); }
});

router.post("/:userId/:action", async (req, res, next) => {
  try {
    if (!["activate", "deactivate"].includes(req.params.action)) throw new AppError("NOT_FOUND", "Action not found.", "الإجراء غير موجود.", 404);
    const status = req.params.action === "activate" ? "active" : "inactive";
    const result = await db.query(`UPDATE users SET status=$1,updated_at=NOW() WHERE center_id=$2 AND id=$3 AND role IN ('manager','assistant') RETURNING ${safeFields}`, [status, req.centerId, req.params.userId]);
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "Account not found.", "الحساب غير موجود.", 404);
    res.json({ user: safeUser(result.rows[0]) });
  } catch (error) { next(error); }
});

module.exports = router;
