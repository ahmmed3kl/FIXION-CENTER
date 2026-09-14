const express = require("express");
const cors = require("cors");
const config = require("./config");
const { errorHandler } = require("./middleware/errorHandler");

const healthRouter = require("./routes/health");
const authRouter = require("./routes/auth");
const devicesRouter = require("./routes/devices");
const syncRouter = require("./routes/sync");
const servicesRouter = require("./routes/services");
const platformRouter = require("./routes/platform");
const platformCentersRouter = require("./routes/platformCenters");
const platformUsersRouter = require("./routes/platformUsers");
const platformServicesRouter = require("./routes/platformServices");
const platformCardRangesRouter = require("./routes/platformCardRanges");
const platformDevicesRouter = require("./routes/platformDevices");
const platformSyncRouter = require("./routes/platformSync");
const platformAuditRouter = require("./routes/platformAudit");
const platformSyncQuery = require("./services/platformSyncQuery");

const app = express();

// Trust reverse proxy headers (Render, Cloudflare, AWS, Nginx)
app.set("trust proxy", 1);

// Security and utility middlewares
app.use(cors({ origin: config.corsOrigin }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); next(); });
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Root info route
app.get("/", (req, res) => {
  res.json({
    service: "FIXION Backend API Service",
    status: "running",
    version: "1.0.0",
    healthCheck: "/v1/health",
  });
});

// Route mounting under /v1
app.use("/v1/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/devices", devicesRouter);
app.use("/v1/sync", syncRouter);
app.use("/v1/services", servicesRouter);
app.use("/v1/platform", platformRouter);
app.use("/v1/platform/centers", platformCentersRouter);
app.use("/v1/platform/centers/:centerId/users", platformUsersRouter);
app.use("/v1/platform/centers/:centerId/services", platformServicesRouter);
app.use("/v1/platform/centers/:centerId/card-ranges", platformCardRangesRouter);
app.use("/v1/platform/centers/:centerId/devices", platformDevicesRouter);
app.use("/v1/platform/centers/:centerId/sync", platformSyncRouter);
app.use("/v1/platform/audit-logs", platformAuditRouter.router);
app.get("/v1/platform/sync/summary", require("./middleware/platformAuth").platformAuthMiddleware, async (req,res,next)=>{ try { res.json({ summary: await platformSyncQuery.summary(req.query) }); } catch(e) { next(e); } });
app.get("/v1/platform/sync", require("./middleware/platformAuth").platformAuthMiddleware, async (req,res,next)=>{ try { res.json(await platformSyncQuery.listOperations(req.query)); } catch(e) { next(e); } });

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
      userMessage: "المسار المطلوب غير موجود في الخادم.",
    },
  });
});

// Centralized error handling
app.use(errorHandler);

// Only listen if started directly (allows importing in integration tests)
if (require.main === module) {
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log("====================================================");
    console.log(` FIXION Backend API Service running on port ${config.port}`);
    console.log(` Environment: ${config.appEnv}`);
    console.log(` Local: http://localhost:${config.port}/v1/health`);
    console.log(
      " Note: When connecting from physical mobile device, use your PC LAN IP.",
    );
    console.log("====================================================");
  });

  const shutdown = (signal) => {
    console.log(`${signal} signal received. Closing HTTP server gracefully...`);
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
