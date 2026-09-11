const db = require("../db");
const { AppError } = require("./errorHandler");

/**
 * Device Gatekeeping Middleware:
 * Enforces that sync and center mutations are only accepted from verified, ACTIVE devices belonging to the center.
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
      "SELECT id, center_id, status FROM devices WHERE id = $1 AND center_id = $2",
      [deviceId, req.centerId],
    );

    if (deviceRes.rows.length === 0) {
      throw new AppError(
        "DEVICE_NOT_FOUND",
        `Device '${deviceId}' is not registered under center '${req.centerId}'.`,
        "هذا الجهاز غير مسجل في المركز التعليمي.",
        403,
      );
    }

    const device = deviceRes.rows[0];

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

    // Update last_seen_at timestamp
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
