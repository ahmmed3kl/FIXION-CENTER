const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("../src/config");
const db = require("../src/db");
const devicesRouter = require("../src/routes/platformDevices");
const { errorHandler } = require("../src/middleware/errorHandler");

async function run() {
  const originalQuery = db.query;
  let deviceListQuery;
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM platform_admins")) {
      return {
        rows: [{
          id: "platform-admin-test",
          full_name: "مدير المنصة",
          email: "platform@example.test",
          status: "active",
        }],
      };
    }
    if (sql.includes("FROM devices d")) {
      deviceListQuery = { sql, values };
      return {
        rows: [{
          id: "device-1",
          center_id: "center-2",
          user_id: "multi-center-user",
          device_name: "POCO F3",
          full_name: "مستخدم مرتبط بالمركز",
          user_email: "user@example.test",
        }],
      };
    }
    throw new Error(`Unexpected test query: ${sql}`);
  };

  const app = express();
  app.use("/v1/platform/centers/:centerId/devices", devicesRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const token = jwt.sign(
      {
        sub: "platform-admin-test",
        scope: "platform",
        role: "platform_admin",
      },
      config.jwtSecret,
      { expiresIn: "1h" },
    );
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/platform/centers/center-2/devices`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].full_name, "مستخدم مرتبط بالمركز");
    assert.match(deviceListQuery.sql, /u\.center_id=d\.center_id OR EXISTS/);
    assert.match(deviceListQuery.sql, /uc\.user_id=u\.id AND uc\.center_id=d\.center_id/);
    assert.match(deviceListQuery.sql, /WHERE d\.center_id=\$1/);
    assert.deepEqual(deviceListQuery.values, ["center-2"]);
    console.log("platform_device_account_scope: all assertions passed");
  } finally {
    server.close();
    db.query = originalQuery;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
