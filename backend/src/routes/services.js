const express = require("express");
const db = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { SERVICE_CATALOG } = require("../services/serviceCatalog");

// Read-only service visibility for the authenticated center user. The center
// is always derived by authMiddleware; no client-supplied center is trusted.
const router = express.Router();
router.use(authMiddleware);

router.get("/", async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT service_key, enabled, updated_at FROM center_services WHERE center_id = $1",
      [req.centerId],
    );
    const overrides = new Map(result.rows.map((row) => [row.service_key, row]));
    const services = Object.entries(SERVICE_CATALOG).map(([serviceKey, meta]) => {
      const override = overrides.get(serviceKey);
      return {
        serviceKey,
        name: meta.name,
        description: meta.description,
        availability: meta.availability,
        // Missing overrides retain the backend's default-enabled behavior.
        enabled: override ? override.enabled === true : true,
        updatedAt: override?.updated_at || null,
      };
    });
    res.json({ centerId: req.centerId, services });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
