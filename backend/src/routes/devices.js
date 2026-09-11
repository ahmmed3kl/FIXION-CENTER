const express = require("express");
const db = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");

const router = express.Router();

/**
 * Register or update device under the authenticated center
 */
router.post("/register", authMiddleware, async (req, res, next) => {
  try {
    const { deviceIdentifier, deviceName, platform, appVersion } = req.body;
    const deviceId = deviceIdentifier || req.body.deviceId;

    if (!deviceId) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Device identifier is required.",
        "معرّف الجهاز مطلوب.",
        400,
      );
    }

    // Security check: Verify device does not belong to another center
    const existing = await db.query(
      "SELECT id, center_id, status FROM devices WHERE id = $1",
      [deviceId],
    );

    if (
      existing.rows.length > 0 &&
      existing.rows[0].center_id !== req.centerId
    ) {
      throw new AppError(
        "TENANT_MISMATCH",
        "This physical device is already bound to another center.",
        "هذا الجهاز مسجل بالفعل في مركز تعليمي آخر.",
        403,
      );
    }

    // Upsert device under the authenticated center
    const upsertRes = await db.query(
      `INSERT INTO devices (id, center_id, user_id, device_name, platform, app_version, status, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         device_name = COALESCE(EXCLUDED.device_name, devices.device_name),
         platform = COALESCE(EXCLUDED.platform, devices.platform),
         app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id, status, created_at;`,
      [
        deviceId,
        req.centerId,
        req.user.id,
        deviceName || "Mobile Tablet/Phone",
        platform || "android",
        appVersion || "1.0.0",
      ],
    );

    const device = upsertRes.rows[0];

    return res.json({
      deviceId: device.id,
      status: device.status,
      registeredAt: device.created_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
