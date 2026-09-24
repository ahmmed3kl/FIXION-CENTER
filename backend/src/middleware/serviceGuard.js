const db = require("../db");
const { AppError } = require("./errorHandler");
const { SERVICE_CATALOG, isSmsProviderConfigured } = require("../services/serviceCatalog");

async function isServiceEnabled(centerId, serviceKey) {
  if (!SERVICE_CATALOG[serviceKey]) throw new AppError("INVALID_SERVICE", "Unknown service.", "الخدمة غير معروفة.", 400);
  if (serviceKey === "sms" && !isSmsProviderConfigured()) return false;
  const result = await db.query("SELECT enabled FROM center_services WHERE center_id = $1 AND service_key = $2", [centerId, serviceKey]);
  return !result.rows[0] || result.rows[0].enabled === true;
}

async function requireService(centerId, serviceKey) {
  if (!(await isServiceEnabled(centerId, serviceKey))) throw new AppError("SERVICE_DISABLED", "Service is disabled for this center.", "الخدمة غير متاحة حاليًا لهذا المركز.", 403);
}

module.exports = { isServiceEnabled, requireService };
