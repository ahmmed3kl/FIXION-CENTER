const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("../src/config");
const db = require("../src/db");
const devicesRouter = require("../src/routes/devices");
const { errorHandler } = require("../src/middleware/errorHandler");

async function run() {
  const originalQuery = db.query;
  const upserts = [];
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE id = $1")) {
      return {
        rows: [{
          id: "user-registration-test",
          center_id: "center-registration-test",
          full_name: "مسؤول المركز",
          email: "admin@example.test",
          role: "secretary",
          permissions: [],
          status: "active",
        }],
      };
    }
    if (sql.includes("FROM user_centers uc")) return { rows: [] };
    if (sql.includes("INSERT INTO devices")) {
      upserts.push({ sql, values });
      return {
        rows: [{
          id: values[0],
          status: "active",
          created_at: "2026-10-10T00:00:00.000Z",
        }],
      };
    }
    throw new Error(`Unexpected test query: ${sql}`);
  };

  const app = express();
  app.use(express.json());
  app.use("/v1/devices", devicesRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1/devices/register`;
    const token = jwt.sign(
      { sub: "user-registration-test" },
      config.jwtSecret,
      { expiresIn: "1h" },
    );
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Center-Id": "center-registration-test",
      "Content-Type": "application/json",
    };

    const knownModel = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: "device-registration-test",
        deviceName: "iPhone 15 Pro Max",
      }),
    });
    assert.equal(knownModel.status, 200);
    assert.equal(upserts[0].values[3], "iPhone 15 Pro Max");

    const legacyReconnect = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: "device-registration-test",
        deviceName: "موديل غير معروف",
      }),
    });
    assert.equal(legacyReconnect.status, 200);
    assert.equal(upserts[1].values[3], null);
    assert.match(upserts[1].sql, /WHEN EXCLUDED\.device_name IS NULL\s+THEN devices\.device_name/);
    assert.match(upserts[1].sql, /center_id = EXCLUDED\.center_id/);

    const unauthorizedCenter = await fetch(baseUrl, {
      method: "POST",
      headers: { ...headers, "X-Center-Id": "different-center" },
      body: JSON.stringify({ deviceId: "device-registration-test", deviceName: "POCO F3" }),
    });
    assert.equal(unauthorizedCenter.status, 403);
    assert.equal(upserts.length, 2);
    console.log("device_registration: all assertions passed");
  } finally {
    server.close();
    db.query = originalQuery;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
