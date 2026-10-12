const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../src/db");
const config = require("../src/config");
const { authMiddleware } = require("../src/middleware/auth");
const { errorHandler } = require("../src/middleware/errorHandler");
const centerUsers = require("../src/routes/centerUsers");
const platformUsers = require("../src/routes/platformUsers");

const activeManager = {
  id: "manager-1",
  center_id: "center-1",
  full_name: "Manager",
  email: "manager@example.com",
  phone: null,
  role: "manager",
  permissions: { "users.manage": true, "students.view": true },
  status: "active",
};

function token(payload) {
  return jwt.sign(payload, config.jwtSecret);
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function request(baseUrl, path, jwtToken, method, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwtToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("existing tokens are rejected when the primary center is suspended", async () => {
  const originalQuery = db.query;
  const queried = [];
  db.query = async (sql) => {
    queried.push(sql);
    if (sql.includes("FROM users WHERE id")) return { rows: [{ ...activeManager, role: "admin" }] };
    if (sql.includes("FROM centers WHERE id")) return { rows: [{ status: "suspended" }] };
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const req = {
      headers: { authorization: `Bearer ${token({ sub: activeManager.id })}`, "x-center-id": "center-2" },
    };
    let error;
    await new Promise((resolve) => authMiddleware(req, {}, (nextError) => {
      error = nextError;
      resolve();
    }));

    assert.equal(error?.code, "FORBIDDEN");
    assert.match(error.message, /center account is currently suspended/i);
    assert.equal(queried.some((sql) => sql.includes("FROM user_centers")), false);
  } finally {
    db.query = originalQuery;
  }
});

test("center managers cannot grant permissions they lack or promote an assistant", async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("FROM users WHERE id = $1")) return { rows: [activeManager] };
    if (sql.includes("FROM centers WHERE id = $1")) return { rows: [{ status: "active" }] };
    if (sql.includes("FROM user_centers")) return { rows: [] };
    if (sql.includes("SELECT id,center_id,full_name,email,phone,role,permissions,status,created_at,updated_at FROM users")) {
      return {
        rows: [{
          id: "assistant-1",
          center_id: "center-1",
          full_name: "Assistant",
          email: "assistant@example.com",
          role: "assistant",
          permissions: {},
          status: "active",
        }],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const app = express();
  app.use(express.json());
  app.use("/center/users", centerUsers);
  app.use(errorHandler);

  try {
    const managerToken = token({ sub: activeManager.id });
    await withServer(app, async (baseUrl) => {
      const create = await request(baseUrl, "/center/users", managerToken, "POST", {
        fullName: "New Assistant",
        email: "new-assistant@example.com",
        role: "assistant",
        password: "strong-password-123",
        permissions: ["students.view", "payments.create"],
      });
      assert.equal(create.status, 403);
      assert.equal((await create.json()).error.code, "FORBIDDEN");

      const grant = await request(baseUrl, "/center/users/assistant-1", managerToken, "PATCH", {
        permissions: ["payments.create"],
      });
      assert.equal(grant.status, 403);
      assert.equal((await grant.json()).error.code, "FORBIDDEN");

      const promote = await request(baseUrl, "/center/users/assistant-1", managerToken, "PATCH", {
        role: "manager",
      });
      assert.equal(promote.status, 403);
      assert.equal((await promote.json()).error.code, "FORBIDDEN");
    });

    assert.equal(calls.some(({ sql }) => sql.startsWith("INSERT INTO users")), false);
    assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  } finally {
    db.query = originalQuery;
  }
});

test("platform PATCH cannot demote the final active admin and serializes center changes", async () => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  const statements = [];
  let committed = false;
  let rolledBack = false;
  db.query = async (sql) => {
    if (sql.includes("FROM platform_admins")) {
      return { rows: [{ id: "platform-1", full_name: "Platform Admin", email: "platform@example.com", status: "active" }] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  db.withTransaction = async (callback) => {
    const client = {
      async query(sql) {
        statements.push(sql);
        if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: "center-1" }] };
        if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "admin-1",
              center_id: "center-1",
              full_name: "Center Admin",
              email: "admin@example.com",
              role: "admin",
              permissions: {},
              status: "active",
            }],
          };
        }
        if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 1 }] };
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
    try {
      const result = await callback(client);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const app = express();
  app.use(express.json());
  app.use("/platform/centers/:centerId/users", platformUsers);
  app.use(errorHandler);

  try {
    const platformToken = token({ sub: "platform-1", role: "platform_admin", scope: "platform" });
    await withServer(app, async (baseUrl) => {
      const response = await request(
        baseUrl,
        "/platform/centers/center-1/users/admin-1",
        platformToken,
        "PATCH",
        { role: "manager" },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "CONFLICT");
    });

    assert.equal(committed, false);
    assert.equal(rolledBack, true);
    assert.match(statements[0], /FROM centers WHERE id=\$1 FOR UPDATE/);
    assert.ok(statements.some((sql) => sql.includes("COUNT(*)::int")));
    assert.equal(statements.some((sql) => sql.startsWith("UPDATE users")), false);
  } finally {
    db.query = originalQuery;
    db.withTransaction = originalWithTransaction;
  }
});

test("platform cannot deactivate the final active admin", async () => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  const statements = [];
  let rolledBack = false;
  db.query = async (sql) => {
    if (sql.includes("FROM platform_admins")) {
      return { rows: [{ id: "platform-1", full_name: "Platform Admin", email: "platform@example.com", status: "active" }] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  db.withTransaction = async (callback) => {
    const client = {
      async query(sql) {
        statements.push(sql);
        if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: "center-1" }] };
        if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "admin-1",
              center_id: "center-1",
              full_name: "Center Admin",
              email: "admin@example.com",
              role: "admin",
              permissions: {},
              status: "active",
            }],
          };
        }
        if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 1 }] };
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
    try {
      return await callback(client);
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const app = express();
  app.use(express.json());
  app.use("/platform/centers/:centerId/users", platformUsers);
  app.use(errorHandler);

  try {
    const platformToken = token({ sub: "platform-1", role: "platform_admin", scope: "platform" });
    await withServer(app, async (baseUrl) => {
      const response = await request(
        baseUrl,
        "/platform/centers/center-1/users/admin-1/deactivate",
        platformToken,
        "POST",
        {},
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "CONFLICT");
    });

    assert.equal(rolledBack, true);
    assert.match(statements[0], /FROM centers WHERE id=\$1 FOR UPDATE/);
    assert.ok(statements.some((sql) => sql.includes("COUNT(*)::int")));
    assert.equal(statements.some((sql) => sql.startsWith("UPDATE users")), false);
  } finally {
    db.query = originalQuery;
    db.withTransaction = originalWithTransaction;
  }
});
