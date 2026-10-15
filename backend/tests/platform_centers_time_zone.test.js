const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

let queryImplementation = async () => {
  throw new Error("Unexpected database query in the time-zone route test.");
};
const databaseStub = {
  query: (...args) => queryImplementation(...args),
};

function stubModule(request, exports) {
  const filename = require.resolve(request);
  const stub = new Module(filename, module);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

stubModule("../src/db", databaseStub);
stubModule("../src/middleware/platformAuth", {
  platformAuthMiddleware: (_req, _res, next) => next(),
});
stubModule("../src/services/auditService", {
  record: async () => {},
});

const router = require("../src/routes/platformCenters");
const patchLayer = router.stack.find(
  (layer) => layer.route?.path === "/:centerId" && layer.route.methods.patch,
);
assert.ok(patchLayer, "platform centers router exposes a PATCH center route");
const patchHandler = patchLayer.route.stack[0].handle;

async function invokePatch(body) {
  let nextError = null;
  let responseBody = null;
  const response = {
    json(value) {
      responseBody = value;
      return this;
    },
  };

  await patchHandler(
    {
      params: { centerId: "center-test" },
      body,
      platformAdmin: { id: "admin-test" },
    },
    response,
    (error) => {
      nextError = error;
    },
  );

  return { nextError, responseBody };
}

test("rejects invalid IANA time zones before querying the database", async () => {
  let queryCount = 0;
  queryImplementation = async () => {
    queryCount += 1;
    return { rows: [] };
  };

  const { nextError } = await invokePatch({ timeZone: "Not/AZone" });

  assert.equal(nextError?.code, "VALIDATION_ERROR");
  assert.equal(nextError?.statusCode, 400);
  assert.equal(queryCount, 0);
});

test("validates other center fields before assigning the immutable time zone", async () => {
  let queryCount = 0;
  queryImplementation = async () => {
    queryCount += 1;
    return { rows: [] };
  };

  const { nextError } = await invokePatch({
    name: "x",
    timeZone: "Africa/Cairo",
  });

  assert.equal(nextError?.code, "VALIDATION_ERROR");
  assert.equal(queryCount, 0);
});

test("does not replace a center time zone after its first configuration", async () => {
  const calls = [];
  queryImplementation = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT name, phone, address, time_zone, status FROM centers/.test(sql)) {
      return {
        rows: [{
          name: "Test Center",
          phone: null,
          address: null,
          time_zone: "Africa/Cairo",
          status: "active",
        }],
      };
    }
    if (/UPDATE centers SET time_zone/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL in time-zone route test: ${sql}`);
  };

  const { nextError } = await invokePatch({ timeZone: "Europe/London" });

  assert.equal(nextError?.code, "CONFLICT");
  assert.equal(nextError?.statusCode, 409);
  assert.match(calls[1].sql, /time_zone IS NULL OR time_zone = \$1/);
  assert.equal(calls[1].params[0], "Europe/London");
});

test("allows the initial time-zone assignment and returns the configured value", async () => {
  const calls = [];
  queryImplementation = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT name, phone, address, time_zone, status FROM centers/.test(sql)) {
      return {
        rows: [{
          name: "Test Center",
          phone: null,
          address: null,
          time_zone: null,
          status: "active",
        }],
      };
    }
    if (/UPDATE centers SET time_zone/.test(sql)) {
      return {
        rows: [{
          id: "center-test",
          name: "Test Center",
          time_zone: "Africa/Cairo",
          status: "active",
        }],
      };
    }
    throw new Error(`Unexpected SQL in time-zone route test: ${sql}`);
  };

  const { nextError, responseBody } = await invokePatch({ timeZone: "Africa/Cairo" });

  assert.equal(nextError, null);
  assert.equal(responseBody.center.time_zone, "Africa/Cairo");
  assert.match(calls[1].sql, /time_zone IS NULL OR time_zone = \$1/);
});
