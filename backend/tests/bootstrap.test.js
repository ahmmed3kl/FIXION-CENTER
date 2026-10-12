const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const express = require("express");

const db = require("../src/db");
const auth = require("../src/middleware/auth");
const deviceGuard = require("../src/middleware/deviceGuard");
const SyncProcessor = require("../src/services/SyncProcessor");
const { errorHandler } = require("../src/middleware/errorHandler");

const originalWithTransaction = db.withTransaction;
const originalPoolQuery = db.pool.query;
const originalAuthMiddleware = auth.authMiddleware;
const originalDeviceGuard = deviceGuard.deviceGuard;
const originalAcquireLock = SyncProcessor.acquireCenterSyncLock;
const routePath = require.resolve("../src/routes/sync");
let server;
let baseUrl;
let failCardRanges = false;
let scopedQueries = [];
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
  auth.authMiddleware = (req, res, next) => {
    req.centerId = req.headers["x-center-id"];
    req.user = { role: "admin", permissions: {} };
    next();
  };
  deviceGuard.deviceGuard = (req, res, next) => next();
  SyncProcessor.acquireCenterSyncLock = async () => {};
  db.withTransaction = (callback) => callback({
    query: async (sql, parameters) => {
      const table = sql.match(/\bFROM\s+([a-z_]+)/i)?.[1];
      if (table && parameters?.length) {
        scopedQueries.push({ table, centerId: parameters[0] });
      }
      if (table === "card_ranges" && failCardRanges) {
        const error = new Error('relation "card_ranges" does not exist');
        error.code = "42P01";
        error.table = "card_ranges";
        throw error;
      }
      if (table === "card_ranges") {
        return { rows: rangesByCenter[parameters[0]] || [] };
      }
      if (table === "server_sync_operations") {
        return { rows: [{ max_seq: "7" }] };
      }
      return { rows: [] };
    },
  });

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
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  db.withTransaction = originalWithTransaction;
  db.pool.query = originalPoolQuery;
  auth.authMiddleware = originalAuthMiddleware;
  deviceGuard.deviceGuard = originalDeviceGuard;
  SyncProcessor.acquireCenterSyncLock = originalAcquireLock;
  delete require.cache[routePath];
});

test("bootstrap includes configured card ranges in the response", async () => {
  failCardRanges = false;
  scopedQueries = [];
  const response = await fetch(`${baseUrl}/sync/bootstrap`, {
    headers: { "X-Center-Id": "center-a", "X-Device-Id": "device-a" },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.cardRanges, rangesByCenter["center-a"]);
  assert.equal(snapshot.latestServerSeq, 7);
  assert.ok(scopedQueries.length > 0);
  assert.ok(scopedQueries.every((query) => query.centerId === "center-a"));
});

test("bootstrap succeeds with an empty card-range configuration", async () => {
  failCardRanges = false;
  const response = await fetch(`${baseUrl}/sync/bootstrap`, {
    headers: { "X-Center-Id": "center-unconfigured", "X-Device-Id": "device-a" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).cardRanges, []);
});

test("a missing card_ranges table remains a generic 500 but logs the failing table and PostgreSQL code", async () => {
  failCardRanges = true;
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const response = await fetch(`${baseUrl}/sync/bootstrap`, {
      headers: { "X-Center-Id": "center-a", "X-Device-Id": "device-a" },
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(body), /42P01|card_ranges|does not exist/);
    assert.equal(logged.length, 1);
    const diagnostic = JSON.parse(logged[0][1]);
    assert.equal(diagnostic.code, "42P01");
    assert.equal(diagnostic.table, "card_ranges");
    assert.equal(diagnostic.centerId, "center-a");
    assert.equal(diagnostic.path, "/sync/bootstrap");
  } finally {
    console.error = originalConsoleError;
    failCardRanges = false;
  }
});

test("card-range bootstrap query is center-scoped", async () => {
  const centerA = await fetch(`${baseUrl}/sync/bootstrap`, {
    headers: { "X-Center-Id": "center-a", "X-Device-Id": "device-a" },
  });
  const centerB = await fetch(`${baseUrl}/sync/bootstrap`, {
    headers: { "X-Center-Id": "center-b", "X-Device-Id": "device-b" },
  });
  assert.deepEqual((await centerA.json()).cardRanges, rangesByCenter["center-a"]);
  assert.deepEqual((await centerB.json()).cardRanges, rangesByCenter["center-b"]);
});

test("startup schema compatibility declares card_ranges with idempotent DDL", async () => {
  const statements = [];
  db.pool.query = async (sql) => {
    statements.push(sql);
    return { rows: [] };
  };
  await db.ensureSchemaCompatibility();
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS card_ranges/);
  assert.match(statements[0], /uq_card_range_identity/);
  assert.match(statements[0], /idx_card_ranges_codes/);
});
