const db = require("../db");
const { AppError } = require("./errorHandler");
const { SERVICE_CATALOG, isSmsProviderConfigured } = require("../services/serviceCatalog");

async function isServiceEnabled(centerId, serviceKey, options = {}) {
  if (!centerId) {
    throw new AppError("TENANT_REQUIRED", "Center context is required.", "سياق المركز مطلوب.", 403);
  }
  if (
    options &&
    options.expectedCenterId !== undefined &&
    String(centerId) !== String(options.expectedCenterId)
  ) {
    throw new AppError(
      "TENANT_MISMATCH",
      "Cross-center service check denied.",
      "غير مصرح بالوصول إلى بيانات مركز آخر.",
      403,
    );
  }
  if (!SERVICE_CATALOG[serviceKey]) throw new AppError("INVALID_SERVICE", "Unknown service.", "الخدمة غير معروفة.", 400);
  if (serviceKey === "sms" && !isSmsProviderConfigured()) return false;
  const cache = options && options.cache instanceof Map ? options.cache : null;
  const cacheKey = `${String(centerId)}:${String(serviceKey)}`;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const result = await db.query("SELECT enabled FROM center_services WHERE center_id = $1 AND service_key = $2", [centerId, serviceKey]);
  const enabled = !result.rows[0] || result.rows[0].enabled === true;
  if (cache) {
    cache.set(cacheKey, enabled);
  }
  return enabled;
}

async function requireService(centerId, serviceKey, options = {}) {
  if (!(await isServiceEnabled(centerId, serviceKey, options))) throw new AppError("SERVICE_DISABLED", "Service is disabled for this center.", "الخدمة غير متاحة حاليًا لهذا المركز.", 403);
}

module.exports = { isServiceEnabled, requireService };
