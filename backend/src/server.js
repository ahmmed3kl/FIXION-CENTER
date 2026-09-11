const express = require("express");
const cors = require("cors");
const config = require("./config");
const { errorHandler } = require("./middleware/errorHandler");

const healthRouter = require("./routes/health");
const authRouter = require("./routes/auth");
const devicesRouter = require("./routes/devices");
const syncRouter = require("./routes/sync");

const app = express();

// Trust reverse proxy headers (Render, Cloudflare, AWS, Nginx)
app.set("trust proxy", 1);

// Security and utility middlewares
app.use(cors({ origin: config.corsOrigin }));
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
