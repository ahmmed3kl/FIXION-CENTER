const express = require("express");
const db = require("../db");

const router = express.Router();

/**
 * Health check endpoint - returns basic operational status without leaking internal metadata
 */
router.get("/", async (req, res, next) => {
  try {
    await db.query("SELECT 1");
    res.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
