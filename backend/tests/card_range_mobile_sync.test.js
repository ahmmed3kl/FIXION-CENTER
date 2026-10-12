const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const express = require("express");

const db = require("../src/db");
const auth = require("../src/middleware/auth");
const deviceGuard = require("../src/middleware/deviceGuard");
const { errorHandler } = require("../src/middleware/errorHandler");

const originalQuery = db.query;
const originalAuthMiddleware = auth.authMiddleware;
const originalDeviceGuard = deviceGuard.deviceGuard;
const routePath = require.resolve("../src/routes/sync");
let server;
let baseUrl;
const rangesByCenter = {
  "center-a": [{
    id: "range-a",
    center_id: "center-a",
    start_code: "000100",
    end_code: "000199",
    status: "active",
  }],
  "center-b": [{
    id: "range-b",
    center_id: "center-b",
    start_code: "009000",
    end_code: "009099",
    status: "inactive",
  }],
};

before(async () => {
  db.query = async (sql, parameters) => {
    assert.match(sql, /WHERE center_id = \$1/);
    return { rows: rangesByCenter[parameters[0]] || [] };
  };
  auth.authMiddleware = (req, res, next) => {
    req.centerId = req.headers["x-center-id"];
    req.user = {
      role: "assistant",
      permissions: req.headers["x-test-deny"] ? {} : { "students.create": true },
    };
    next();
  };
  deviceGuard.deviceGuard = (req, res, next) => next();
  delete require.cache[routePath];
  const syncRouter = require(routePath);
  const app = express();
  app.use("/sync", syncRouter);
  app.use(errorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  db.query = originalQuery;
  auth.authMiddleware = originalAuthMiddleware;
  deviceGuard.deviceGuard = originalDeviceGuard;
  delete require.cache[routePath];
});

test("mobile range endpoint returns only ranges for the authenticated center", async () => {
  const response = await fetch(`${baseUrl}/sync/card-ranges`, {
    headers: { "X-Center-Id": "center-a", "X-Device-Id": "device-a" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    centerId: "center-a",
    cardRanges: rangesByCenter["center-a"],
  });
});

test("mobile range endpoint enforces student creation permission", async () => {
  const response = await fetch(`${baseUrl}/sync/card-ranges`, {
    headers: {
      "X-Center-Id": "center-a",
      "X-Device-Id": "device-a",
      "X-Test-Deny": "1",
    },
  });
  assert.equal(response.status, 403);
});
