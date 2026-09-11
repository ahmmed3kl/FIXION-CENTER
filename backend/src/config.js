const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  appEnv: process.env.APP_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  neonSqlEndpoint:
    process.env.NEON_SQL_ENDPOINT ||
    "https://ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/sql",
  jwtSecret: process.env.JWT_SECRET || "fallback_secret_for_local_tests_only",
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

if (!config.databaseUrl) {
  console.warn("WARNING: DATABASE_URL is not set in environment!");
}

if (
  config.appEnv === "production" &&
  config.jwtSecret === "fallback_secret_for_local_tests_only"
) {
  console.warn(
    "SECURITY WARNING: Running in production with default JWT_SECRET! Please set JWT_SECRET in environment variables.",
  );
}

module.exports = config;
