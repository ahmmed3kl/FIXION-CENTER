const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { platformAuthMiddleware } = require("../middleware/platformAuth");
const { record } = require("../services/auditService");

const router = express.Router();
router.use(platformAuthMiddleware);
const validStatuses = new Set(["active", "suspended"]);

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const values = []; const where = [];
    if (search) { values.push(`%${search}%`); where.push(`(c.name ILIKE $${values.length} OR c.code ILIKE $${values.length})`); }
    if (status && validStatuses.has(status)) { values.push(status); where.push(`c.status = $${values.length}`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM centers c ${clause}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await db.query(`SELECT c.id, c.name, c.code, c.phone, c.address, c.status, c.created_at,
      (SELECT COUNT(*)::int FROM students s WHERE s.center_id = c.id AND s.status = 'active') AS student_count,
      (SELECT COUNT(*)::int FROM devices d WHERE d.center_id = c.id AND d.status = 'active') AS active_device_count,
      (SELECT COUNT(*)::int FROM server_sync_operations o WHERE o.center_id = c.id AND o.status = 'rejected') AS failed_operations,
      0::int AS pending_operations
      FROM centers c ${clause} ORDER BY c.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    res.json({ items: rows.rows, pagination: { page, pageSize, total: count.rows[0].total, totalPages: Math.ceil(count.rows[0].total / pageSize) } });
  } catch (error) { next(error); }
});

router.get("/:centerId", async (req, res, next) => {
  try {
    const result = await db.query(`SELECT c.id, c.name, c.code, c.phone, c.address, c.status, c.created_at, c.updated_at,
      (SELECT COUNT(*)::int FROM students s WHERE s.center_id = c.id AND s.status = 'active') AS student_count,
      (SELECT COUNT(*)::int FROM devices d WHERE d.center_id = c.id AND d.status = 'active') AS active_device_count,
      (SELECT COUNT(*)::int FROM users u WHERE u.center_id = c.id AND u.status = 'active') AS user_count,
      (SELECT COUNT(*)::int FROM server_sync_operations o WHERE o.center_id = c.id AND o.status = 'rejected') AS failed_operations,
      0::int AS pending_operations FROM centers c WHERE c.id = $1`, [req.params.centerId]);
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "Center not found.", "المركز غير موجود.", 404);
    res.json({ center: result.rows[0] });
  } catch (error) { next(error); }
});

router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const code = String(req.body.code || "").trim();
    if (name.length < 2 || name.length > 255 || !code || code.length > 64) throw new AppError("VALIDATION_ERROR", "Valid center name and code are required.", "اسم المركز والكود مطلوبان.", 400);
    const id = `center-${crypto.randomUUID()}`;
    const result = await db.query("INSERT INTO centers (id, name, code, phone, address, status) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id, name, code, phone, address, status, created_at, updated_at", [id, name, code, req.body.phone || null, req.body.address || null]);
    await record({ actor: req.platformAdmin, centerId: id, action: "center.created", entityType: "center", entityId: id, after: { name, code, phone: req.body.phone || null, address: req.body.address || null, status: "active" } });
    res.status(201).json({ center: result.rows[0] });
  } catch (error) { next(error); }
});

router.patch("/:centerId", async (req, res, next) => {
  try {
    const allowed = ["name", "phone", "address", "status"]; const keys = Object.keys(req.body).filter((key) => allowed.includes(key));
    if (!keys.length || (req.body.status && !validStatuses.has(req.body.status))) throw new AppError("VALIDATION_ERROR", "No valid editable fields were provided.", "البيانات المدخلة غير صحيحة.", 400);
    const beforeResult = await db.query("SELECT name, phone, address, status FROM centers WHERE id = $1", [req.params.centerId]);
    const values = keys.map((key) => key === "name" ? String(req.body[key]).trim() : req.body[key]);
    if (keys.includes("name") && (values[keys.indexOf("name")].length < 2 || values[keys.indexOf("name")].length > 255)) throw new AppError("VALIDATION_ERROR", "Invalid center name.", "اسم المركز غير صحيح.", 400);
    const set = keys.map((key, index) => `${key} = $${index + 1}`); values.push(req.params.centerId);
    const result = await db.query(`UPDATE centers SET ${set.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING id, name, code, phone, address, status, created_at, updated_at`, values);
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "Center not found.", "المركز غير موجود.", 404);
    const changed = keys.reduce((state, key, index) => ({ ...state, [key]: values[index] }), {});
    const action = changed.status === "suspended" ? "center.suspended" : changed.status === "active" && beforeResult.rows[0]?.status === "suspended" ? "center.reactivated" : "center.updated";
    await record({ actor: req.platformAdmin, centerId: req.params.centerId, action, entityType: "center", entityId: req.params.centerId, before: beforeResult.rows[0] || null, after: result.rows[0] });
    res.json({ center: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
