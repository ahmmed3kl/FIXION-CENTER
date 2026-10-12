const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("../src/config");
const db = require("../src/db");
const { authMiddleware, defaultPermissionsForRole, requirePermission, resolveLivePermissions } = require("../src/middleware/auth");
const centerUsers = require("../src/routes/centerUsers");
const platformUsers = require("../src/routes/platformUsers");
const authRouter = require("../src/routes/auth");
const { errorHandler } = require("../src/middleware/errorHandler");

test("live permissions do not restore role defaults for empty or invalid stored permissions", () => {
  assert.deepEqual(resolveLivePermissions({ role: "manager", permissions: {} }), {});
  assert.deepEqual(resolveLivePermissions({ role: "assistant", permissions: [] }), {});
  assert.deepEqual(resolveLivePermissions({ role: "assistant", permissions: "[]" }), {});
  assert.deepEqual(resolveLivePermissions({ role: "manager", permissions: "invalid-json" }), {});
  assert.deepEqual(resolveLivePermissions({ role: "assistant", permissions: null }), {});
  assert.deepEqual(resolveLivePermissions({ role: "admin", permissions: { __explicit_empty__: true } }), { "*": true });
});

const platformAdmin = { id: "platform-admin-test", full_name: "Platform", email: "platform@example.test", status: "active" };
const platformToken = jwt.sign({ sub: platformAdmin.id, scope: "platform", role: "platform_admin" }, config.jwtSecret);
const centerManager = {
  id: "manager-test",
  center_id: "center-manager-test",
  full_name: "Manager",
  email: "manager@example.test",
  phone: null,
  role: "manager",
  permissions: { "users.manage": true, "students.view": true },
  status: "active",
};
const centerToken = jwt.sign({ sub: centerManager.id }, config.jwtSecret);

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function appFor(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

function platformAdminQuery(sql) {
  if (sql.includes("FROM platform_admins")) return { rows: [platformAdmin] };
  return null;
}

test("platform user creation persists role defaults and a primary center membership without exposing hashes", async (t) => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  let insertValues;
  let membershipValues;
  let membershipSql;
  db.query = async (sql) => platformAdminQuery(sql) || { rows: [] };
  db.withTransaction = async (callback) => callback({
    async query(sql, values = []) {
      if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: "center-platform-test" }] };
      if (sql.includes("LOWER(email)")) return { rows: [] };
      if (sql.startsWith("INSERT INTO users")) {
        insertValues = values;
        return { rows: [{ id: values[0], center_id: values[1], full_name: values[2], email: values[3], phone: values[4], password_hash: values[5], role: values[6], permissions: JSON.parse(values[7]), status: "active", created_at: "now", updated_at: "now" }] };
      }
      if (sql.startsWith("INSERT INTO user_centers")) { membershipValues = values; membershipSql = sql; return { rows: [] }; }
      if (sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  t.after(() => { db.query = originalQuery; db.withTransaction = originalWithTransaction; });

  await withServer(appFor("/v1/platform/centers/:centerId/users", platformUsers), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/platform/centers/center-platform-test/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${platformToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Assistant", email: "assistant@example.test", role: "assistant", password: "safe-password-123" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.user.id, insertValues[0]);
    assert.equal("password_hash" in body.user, false);
    assert.equal("permissions" in body.user, false);
    assert.deepEqual(JSON.parse(insertValues[7]), defaultPermissionsForRole("assistant"));
    assert.deepEqual(membershipValues.slice(1), [insertValues[0], "center-platform-test", "assistant"]);
    assert.match(membershipSql, /is_primary\) VALUES \(\$1,\$2,\$3,\$4,TRUE\)/i);

    const unsupportedRole = await fetch(`${baseUrl}/v1/platform/centers/center-platform-test/users`, {
      method: "POST",
      headers: { authorization: "Bearer " + platformToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy role", email: "legacy@example.test", role: "secretary", password: "safe-password-123" }),
    });
    assert.equal(unsupportedRole.status, 400);
  });
});

test("platform cannot create a second active center admin or duplicate an existing email", async (t) => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  let createAttempt = "admin";
  let userInsertCount = 0;
  db.query = async (sql) => platformAdminQuery(sql) || { rows: [] };
  db.withTransaction = async (callback) => callback({
    async query(sql) {
      if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: "center-unique-test" }] };
      if (sql.includes("LOWER(email)")) return createAttempt === "duplicate" ? { rows: [{ id: "existing-user" }] } : { rows: [] };
      if (sql.includes("role='admin'")) return { rows: [{ id: "existing-admin" }] };
      if (sql.startsWith("INSERT INTO users")) { userInsertCount += 1; return { rows: [] }; }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  t.after(() => { db.query = originalQuery; db.withTransaction = originalWithTransaction; });

  await withServer(appFor("/v1/platform/centers/:centerId/users", platformUsers), async (baseUrl) => {
    const post = (email) => fetch(`${baseUrl}/v1/platform/centers/center-unique-test/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${platformToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email, role: "admin", password: "safe-password-123" }),
    });
    assert.equal((await post("second-admin@example.test")).status, 409);
    createAttempt = "duplicate";
    assert.equal((await post("existing@example.test")).status, 409);
    assert.equal(userInsertCount, 0);
  });
});

test("ordinary platform profile edits leave permissions intact and password resets return no hash", async (t) => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  const permissions = { "students.view": true };
  let duplicateEmail = false;
  let updatedSql;
  let nextPasswordHash;
  db.query = async (sql, values = []) => {
    const auth = platformAdminQuery(sql);
    if (auth) return auth;
    if (sql.startsWith("UPDATE users SET password_hash")) { nextPasswordHash = values[0]; return { rows: [{ id: "user-edit-test" }] }; }
    if (sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.withTransaction = async (callback) => callback({
    async query(sql, values = []) {
      if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: "center-edit-test" }] };
      if (sql.includes("FOR UPDATE") && sql.includes("FROM users")) return { rows: [{ id: "user-edit-test", center_id: "center-edit-test", full_name: "Before", email: "before@example.test", role: "assistant", permissions, status: "active" }] };
      if (sql.includes("LOWER(email)=$1 AND id<>$2")) return { rows: duplicateEmail ? [{ id: "other-user" }] : [] };
      if (sql.startsWith("UPDATE users SET")) {
        updatedSql = sql;
        return { rows: [{ id: "user-edit-test", center_id: "center-edit-test", full_name: values[0], email: values[1], role: "assistant", permissions, status: "active" }] };
      }
      if (sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  t.after(() => { db.query = originalQuery; db.withTransaction = originalWithTransaction; });

  await withServer(appFor("/v1/platform/centers/:centerId/users", platformUsers), async (baseUrl) => {
    duplicateEmail = true;
    const duplicate = await fetch(`${baseUrl}/v1/platform/centers/center-edit-test/users/user-edit-test`, {
      method: "PATCH",
      headers: { authorization: "Bearer " + platformToken, "content-type": "application/json" },
      body: JSON.stringify({ email: "taken@example.test" }),
    });
    assert.equal(duplicate.status, 409);

    duplicateEmail = false;
    const patch = await fetch(`${baseUrl}/v1/platform/centers/center-edit-test/users/user-edit-test`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${platformToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "After", email: "after@example.test" }),
    });
    assert.equal(patch.status, 200);
    const patched = await patch.json();
    assert.equal(patched.user.full_name, "After");
    assert.equal("password_hash" in patched.user, false);
    assert.doesNotMatch(updatedSql.split("WHERE")[0], /permissions|password_hash/);

    const reset = await fetch(`${baseUrl}/v1/platform/centers/center-edit-test/users/user-edit-test/reset-password`, {
      method: "POST",
      headers: { authorization: `Bearer ${platformToken}`, "content-type": "application/json" },
      body: JSON.stringify({ password: "new-safe-password-456" }),
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.deepEqual(resetBody, { success: true });
    assert.equal(await bcrypt.compare("new-safe-password-456", nextPasswordHash), true);
    assert.equal(JSON.stringify(resetBody).includes(nextPasswordHash), false);
  });
});

test("center account creation grants role defaults only within manager grants and stores explicit empty permissions", async (t) => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  const inserts = [];
  const memberships = [];
  let listedCenterId;
  let listedQuery;
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE id = $1")) return { rows: [centerManager] };
    if (sql.includes("FROM centers WHERE id = $1")) return { rows: [{ status: "active" }] };
    if (sql.includes("FROM user_centers")) return { rows: [] };
    if (sql.includes("ORDER BY created_at DESC")) { listedCenterId = values[0]; listedQuery = sql; return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.withTransaction = async (callback) => callback({
    async query(sql, values = []) {
      if (sql.includes("FROM centers") && sql.includes("FOR UPDATE")) return { rows: [{ id: centerManager.center_id }] };
      if (sql.includes("LOWER(email)")) return { rows: [] };
      if (sql.startsWith("INSERT INTO users")) {
        inserts.push(values);
        return { rows: [{ id: values[0], center_id: values[1], full_name: values[2], email: values[3], phone: values[4], password_hash: values[5], role: values[6], permissions: JSON.parse(values[7]), status: "active" }] };
      }
      if (sql.startsWith("INSERT INTO user_centers")) { memberships.push({ sql, values }); return { rows: [] }; }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  t.after(() => { db.query = originalQuery; db.withTransaction = originalWithTransaction; });

  await withServer(appFor("/v1/center/users", centerUsers), async (baseUrl) => {
    const create = (email, body = {}) => fetch(`${baseUrl}/v1/center/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${centerToken}`, "x-center-id": centerManager.center_id, "content-type": "application/json" },
      body: JSON.stringify({ fullName: "New assistant", email, role: "assistant", password: "safe-password-123", ...body }),
    });
    const created = await create("limited@example.test");
    assert.equal(created.status, 201);
    const first = await created.json();
    const stored = JSON.parse(inserts[0][7]);
    assert.deepEqual(stored, { "students.view": true });
    assert.deepEqual(first.user.permissions, stored);
    assert.equal("password_hash" in first.user, false);
    assert.deepEqual(memberships[0].values.slice(1), [inserts[0][0], centerManager.center_id, "assistant"]);
    assert.match(memberships[0].sql, /is_primary\) VALUES \(\$1,\$2,\$3,\$4,TRUE\)/i);

    const explicitlyEmpty = await create("empty@example.test", { permissions: [] });
    assert.equal(explicitlyEmpty.status, 201);
    assert.deepEqual(JSON.parse(inserts[1][7]), { __explicit_empty__: true });

    const switched = await fetch(`${baseUrl}/v1/center/users`, {
      headers: { authorization: `Bearer ${centerToken}`, "x-center-id": "another-center", "content-type": "application/json" },
    });
    assert.equal(switched.status, 200);
    assert.equal(listedCenterId, centerManager.center_id);
    assert.match(listedQuery, /role='assistant' AND id <> \$2/);
  });
});

test("center account profile updates preserve permissions and password reset exposes no secret", async (t) => {
  const originalQuery = db.query;
  const originalWithTransaction = db.withTransaction;
  const permissions = { "students.view": true };
  let duplicateEmail = false;
  let passwordHash;
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE id = $1")) return { rows: [centerManager] };
    if (sql.includes("FROM centers WHERE id = $1")) return { rows: [{ status: "active" }] };
    if (sql.includes("FROM user_centers")) return { rows: [] };
    if (sql.includes("ORDER BY created_at DESC")) { listedCenterId = values[0]; return { rows: [] }; }
    if (sql.includes("FROM users WHERE center_id=$1 AND id=$2 AND role IN")) {
      return values[1] === "manager-target"
        ? { rows: [] }
        : { rows: [{ id: "assistant-profile", center_id: centerManager.center_id, full_name: "Before", email: "before@example.test", role: "assistant", permissions, status: "active" }] };
    }
    if (sql.startsWith("UPDATE users SET password_hash")) { passwordHash = values[0]; return { rows: [{ id: "assistant-profile" }] }; }
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.withTransaction = async (callback) => callback({
    async query(sql, values = []) {
      if (sql.includes("LOWER(email)=$1 AND id<>$2")) return { rows: duplicateEmail ? [{ id: "other-user" }] : [] };
      if (sql.startsWith("UPDATE users SET")) return { rows: [{ id: "assistant-profile", center_id: centerManager.center_id, full_name: values[0], email: values[1], role: "assistant", permissions, status: "active" }] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  });
  t.after(() => { db.query = originalQuery; db.withTransaction = originalWithTransaction; });

  await withServer(appFor("/v1/center/users", centerUsers), async (baseUrl) => {
    const headers = { authorization: `Bearer ${centerToken}`, "x-center-id": centerManager.center_id, "content-type": "application/json" };
    duplicateEmail = true;
    const duplicate = await fetch(`${baseUrl}/v1/center/users/assistant-profile`, {
      method: "PATCH", headers, body: JSON.stringify({ email: "taken@example.test" }),
    });
    assert.equal(duplicate.status, 409);

    duplicateEmail = false;
    const otherManager = await fetch(`${baseUrl}/v1/center/users/manager-target`, {
      method: "PATCH", headers, body: JSON.stringify({ fullName: "Not allowed" }),
    });
    assert.equal(otherManager.status, 404);

    const patch = await fetch(`${baseUrl}/v1/center/users/assistant-profile`, {
      method: "PATCH", headers, body: JSON.stringify({ fullName: "After", email: "after@example.test" }),
    });
    assert.equal(patch.status, 200);
    const patched = await patch.json();
    assert.deepEqual(patched.user.permissions, permissions);
    assert.equal("password_hash" in patched.user, false);

    const reset = await fetch(`${baseUrl}/v1/center/users/assistant-profile/reset-password`, {
      method: "POST", headers, body: JSON.stringify({ password: "new-safe-password-456" }),
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.deepEqual(resetBody, { success: true });
    assert.equal(await bcrypt.compare("new-safe-password-456", passwordHash), true);
    assert.equal(JSON.stringify(resetBody).includes(passwordHash), false);
  });
});

test("admin role retains global active-center access and permission bypass", async (t) => {
  const originalQuery = db.query;
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ ...centerManager, role: "admin", permissions: { __explicit_empty__: true } }] };
    if (sql.includes("FROM centers WHERE id = $1")) return { rows: [{ status: "active" }] };
    if (sql.includes("FROM user_centers")) return { rows: [] };
    if (sql.includes("ORDER BY created_at DESC")) { listedCenterId = values[0]; return { rows: [] }; }
    if (sql.includes("SELECT id FROM centers WHERE status = 'active'")) return { rows: [{ id: centerManager.center_id }, { id: "other-active-center" }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  t.after(() => { db.query = originalQuery; });

  const req = { headers: { authorization: `Bearer ${jwt.sign({ sub: centerManager.id }, config.jwtSecret)}`, "x-center-id": "other-active-center" } };
  let authError;
  await new Promise((resolve) => authMiddleware(req, {}, (error) => { authError = error; resolve(); }));
  assert.equal(authError, undefined);
  assert.equal(req.centerId, "other-active-center");
  assert.deepEqual(req.user.centerIds, [centerManager.center_id, "other-active-center"]);
  let permissionError;
  requirePermission("unlisted.permission")(req, {}, (error) => { permissionError = error; });
  assert.equal(permissionError, undefined);
});
test("login resolves user center memberships with a legacy primary-center fallback", async (t) => {
  const originalQuery = db.query;
  const hash = await bcrypt.hash("safe-password-123", 4);
  db.query = async (sql, values = []) => {
    if (sql.includes("FROM users u") && sql.includes("JOIN centers c")) {
      return { rows: [{ id: "member-user", center_id: "primary-center", full_name: "Multi-center", email: "member@example.test", phone: null, password_hash: hash, role: "accountant", permissions: { "students.view": true }, user_status: "active", center_name: "Primary", center_code: "P1", center_status: "active" }] };
    }
    if (sql.includes("FROM user_centers uc")) return { rows: [{ center_id: "assigned-center", name: "Assigned", code: "A1" }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  t.after(() => { db.query = originalQuery; });

  await withServer(appFor("/v1/auth", authRouter), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.test", password: "safe-password-123" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.user.centerIds, ["primary-center", "assigned-center"]);
    assert.equal(body.user.centers[1].name, "Assigned");
    assert.equal(body.user.centerId, "primary-center");
  });
});