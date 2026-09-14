const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { platformAuthMiddleware } = require("../middleware/platformAuth");

const router = express.Router();

router.post("/auth/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    if (!email || typeof password !== "string" || !password) throw new AppError("VALIDATION_ERROR", "Email and password are required.", "يرجى إدخال البريد الإلكتروني وكلمة المرور.", 400);
    const result = await db.query("SELECT id, full_name, email, password_hash, status FROM platform_admins WHERE LOWER(email) = $1", [email]);
    const admin = result.rows[0];
    const valid = admin ? await bcrypt.compare(password, admin.password_hash).catch(() => false) : false;
    if (!admin || !valid) throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", "بيانات الدخول غير صحيحة.", 401);
    if (admin.status !== "active") throw new AppError("FORBIDDEN", "Platform account is not active.", "تم تعليق حساب المسؤول.", 403);
    const token = jwt.sign({ sub: admin.id, role: "platform_admin", scope: "platform" }, config.jwtSecret, { expiresIn: "7d" });
    res.json({ token, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), user: { id: admin.id, fullName: admin.full_name, email: admin.email, role: "platform_admin", scope: "platform" } });
  } catch (error) { next(error); }
});

router.get("/overview", platformAuthMiddleware, async (req, res, next) => {
  try {
    const [centers, students, devices, sync] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended FROM centers"),
      db.query("SELECT COUNT(*)::int AS total FROM students"),
      db.query("SELECT COUNT(*)::int AS active FROM devices WHERE status = 'active'"),
      db.query("SELECT COUNT(*) FILTER (WHERE status = 'rejected')::int AS failed, 0::int AS pending FROM server_sync_operations"),
    ]);
    const syncData = sync.rows[0];
    res.json({ centers: centers.rows[0], students: students.rows[0], devices: devices.rows[0], sync: syncData, health: { api: "ok", database: "connected", sync: syncData.failed > 0 ? "degraded" : "ok" } });
  } catch (error) { next(error); }
});

router.get("/health", platformAuthMiddleware, async (req, res) => {
  const checkedAt = new Date().toISOString();
  let database = "healthy";
  let sync = "healthy";
  try { await db.query("SELECT 1"); } catch { database = "unavailable"; }
  if (database === "healthy") {
    try { const result = await db.query("SELECT COUNT(*) FILTER (WHERE status IN ('rejected','conflict'))::int AS failed, COUNT(*)::int AS total FROM server_sync_operations"); if ((result.rows[0]?.failed || 0) > 0) sync = "degraded"; } catch { sync = "unavailable"; }
  } else sync = "unavailable";
  const status = database === "unavailable" || sync === "unavailable" ? "unavailable" : sync === "degraded" ? "degraded" : "healthy";
  res.status(status === "unavailable" ? 503 : 200).json({ status, api: { status: "healthy" }, database: { status: database }, sync: { status: sync }, checked_at: checkedAt });
});

module.exports = router;
