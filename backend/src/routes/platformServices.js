const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { platformAuthMiddleware } = require("../middleware/platformAuth");
const { SERVICE_CATALOG, isSmsProviderConfigured } = require("../services/serviceCatalog");
const zadxSmsProvider = require("../services/zadxSmsProvider");
const { record } = require("../services/auditService");

const router = express.Router({ mergeParams: true });
router.use(platformAuthMiddleware);

router.get("/", async (req, res, next) => {
  try {
    const result = await db.query("SELECT service_key, enabled, updated_at FROM center_services WHERE center_id = $1", [req.params.centerId]);
    const overrides = new Map(result.rows.map((row) => [row.service_key, row]));
    let balance = null;
    if (isSmsProviderConfigured()) {
      try {
        const raw = await zadxSmsProvider.getBalance();
        balance = {
          remainingCredits: raw?.remainingCredits ?? raw?.remaining_credits ?? raw?.credits ?? raw?.balance ?? null,
          plan: raw?.plan ?? raw?.planName ?? null,
          expiry: raw?.expiry ?? raw?.expiresAt ?? raw?.expires_at ?? null,
        };
      } catch (error) {
        console.warn("SMS balance check failed", { provider: "zadx", category: error.category || "provider_error", httpStatus: error.httpStatus || null });
      }
    }
    res.json({ sms: { provider: isSmsProviderConfigured() ? "zadx" : null, configured: isSmsProviderConfigured(), balance }, services: Object.entries(SERVICE_CATALOG).map(([serviceKey, meta]) => ({
      serviceKey,
      name: meta.name,
      description: meta.description,
      availability: serviceKey === "sms" && !isSmsProviderConfigured() ? "not_configured" : "available",
      enabled: overrides.has(serviceKey) ? overrides.get(serviceKey).enabled : true,
      updatedAt: overrides.get(serviceKey)?.updated_at || null,
    })) });
  } catch (error) { next(error); }
});

router.patch("/:serviceKey", async (req, res, next) => {
  try {
    const key = req.params.serviceKey;
    if (!SERVICE_CATALOG[key]) throw new AppError("INVALID_SERVICE", "Unknown service.", "الخدمة غير معروفة.", 400);
    if (key === "sms" && !isSmsProviderConfigured()) throw new AppError("SERVICE_NOT_CONFIGURED", "SMS provider is not configured.", "مزود الرسائل غير مهيأ بعد.", 409);
    if (typeof req.body.enabled !== "boolean") throw new AppError("VALIDATION_ERROR", "enabled must be boolean.", "حالة الخدمة غير صحيحة.", 400);
    const before = await db.query("SELECT enabled FROM center_services WHERE center_id=$1 AND service_key=$2", [req.params.centerId, key]);
    const old = before.rows[0]?.enabled ?? true;
    const result = await db.query("INSERT INTO center_services (id,center_id,service_key,enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (center_id,service_key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW() RETURNING service_key, enabled, updated_at", [`svc-${crypto.randomUUID()}`, req.params.centerId, key, req.body.enabled]);
    await record({ actor: req.platformAdmin, centerId: req.params.centerId, action: req.body.enabled ? "service.enabled" : "service.disabled", entityType: "service", entityId: key, before: { enabled: old }, after: { enabled: result.rows[0].enabled } });
    const meta = SERVICE_CATALOG[key];
    res.json({ service: { serviceKey: key, name: meta.name, description: meta.description, availability: key === "sms" ? "available" : meta.availability, enabled: result.rows[0].enabled, updatedAt: result.rows[0].updated_at } });
  } catch (error) { next(error); }
});

module.exports = router;
