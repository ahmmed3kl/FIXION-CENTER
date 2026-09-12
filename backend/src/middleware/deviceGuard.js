const db = require("../db");
const { AppError } = require("./errorHandler");

/**
 * Device Gatekeeping Middleware:
 * Enforces that sync and center mutations are only accepted from verified, ACTIVE devices.
 * If an authenticated user connects with a new device, it is automatically registered
 * as active under their center.
 */
async function deviceGuard(req, res, next) {
  try {
    const deviceId = req.headers["x-device-id"];
    if (!deviceId) {
      throw new AppError(
        "DEVICE_REQUIRED",
        "X-Device-Id header is required for this operation.",
        "معرّف الجهاز مطلوب لإتمام العملية.",
        400,
      );
    }

    const deviceRes = await db.query(
      "SELECT id, center_id, status FROM devices WHERE id = $1",
      [deviceId],
    );

    if (deviceRes.rows.length === 0) {
      // Auto-register device as active for the authenticated user and center
      await db.query(
        `INSERT INTO devices (id, center_id, user_id, device_name, platform, app_version, status, last_seen_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           center_id = EXCLUDED.center_id,
           user_id = EXCLUDED.user_id,
           status = 'active',
           last_seen_at = NOW(),
           updated_at = NOW();`,
        [
          deviceId,
          req.centerId,
          req.user ? req.user.id : null,
          req.headers["x-device-name"] || "Mobile Tablet/Phone",
          req.headers["x-platform"] || "android",
          req.headers["x-app-version"] || "1.0.0",
        ],
      );

      req.deviceId = deviceId;
      req.device = { id: deviceId, center_id: req.centerId, status: "active" };
      return next();
    }

    const device = deviceRes.rows[0];

    if (device.center_id !== req.centerId) {
      throw new AppError(
        "TENANT_MISMATCH",
        `Device '${deviceId}' is registered to center '${device.center_id}', not '${req.centerId}'.`,
        "هذا الجهاز مسجل في مركز تعليمي آخر.",
        403,
      );
    }

    if (device.status !== "active") {
      throw new AppError(
        "DEVICE_INACTIVE",
        `Device '${deviceId}' is marked as '${device.status}'. Synchronization rejected.`,
        "تم تعطيل هذا الجهاز أو إلغاء ترخيصه. لا يمكن مزامنة البيانات.",
        403,
      );
    }

    // Attach device context to request
    req.device = device;
    req.deviceId = device.id;

    // Update last_seen_at timestamp asynchronously
    db.query("UPDATE devices SET last_seen_at = NOW() WHERE id = $1", [
      device.id,
    ]).catch(() => {});

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  deviceGuard,
};
