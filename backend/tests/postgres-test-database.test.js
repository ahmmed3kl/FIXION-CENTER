const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const {
  assertPostgresTestDatabaseIdentity,
  resolvePostgresTestDatabase,
  withPostgresTestDatabase,
} = require("./postgres-test-database");

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "fixion-postgres-guard-"),
);
const missingApplicationEnvFile = path.join(temporaryDirectory, "missing.env");

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function testEnvironment(testUrl, extra = {}) {
  return {
    FIXION_TEST_DATABASE_ACK: "1",
    ...(testUrl ? { FIXION_TEST_DATABASE_URL: testUrl } : {}),
    ...extra,
  };
}

test("does not fall back to DATABASE_URL or backend/.env without an explicit test URL", () => {
  let poolLoadAttempts = 0;
  const appEnvFile = path.join(temporaryDirectory, "no-test-fallback.env");
  fs.writeFileSync(
    appEnvFile,
    "DATABASE_URL=postgresql://app_user@ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require\n",
  );
  const env = testEnvironment(undefined, {
    DATABASE_URL: "postgresql://app_user@127.0.0.1/app_database",
  });

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: appEnvFile }),
    /FIXION_TEST_DATABASE_URL is required/,
  );
  assert.equal(poolLoadAttempts, 0);
  assert.equal(env.DATABASE_URL, "postgresql://app_user@127.0.0.1/app_database");
});

test("rejects the configured Neon host before loading database resources", () => {
  let poolLoadAttempts = 0;
  const env = testEnvironment(
    "postgresql://test_user@ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
  );

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: missingApplicationEnvFile }),
    /Neon database hosts are prohibited/,
  );
  assert.equal(poolLoadAttempts, 0);
});

test("rejects remote and unknown PostgreSQL hosts before loading database resources", () => {
  let poolLoadAttempts = 0;
  const env = testEnvironment(
    "postgresql://test_user@postgres-test.example.invalid/fixion_acceptance_test",
  );

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: missingApplicationEnvFile }),
    /Only PostgreSQL hosts on the local loopback interface are allowed/,
  );
  assert.equal(poolLoadAttempts, 0);
});

test("rejects URL parameters that could redirect a loopback URL", () => {
  let poolLoadAttempts = 0;
  const env = testEnvironment(
    "postgresql://test_user@127.0.0.1/fixion_acceptance_test?host=production.example.invalid",
  );

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: missingApplicationEnvFile }),
    /can override its target/,
  );
  assert.equal(poolLoadAttempts, 0);
});

test("rejects an explicit target sharing the application database despite a different role", () => {
  let poolLoadAttempts = 0;
  const appEnvFile = path.join(temporaryDirectory, "application.env");
  fs.writeFileSync(
    appEnvFile,
    "DATABASE_URL=postgresql://app_user@localhost:5432/fixion_acceptance_test\n",
  );
  const env = testEnvironment(
    "postgresql://test_user@127.0.0.1:5432/fixion_acceptance_test",
  );

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: appEnvFile }),
    /same database configured for the application/,
  );
  assert.equal(poolLoadAttempts, 0);
});

test("rejects reuse of the application role even for a different local database", () => {
  let poolLoadAttempts = 0;
  const env = testEnvironment(
    "postgresql://app_user@127.0.0.1:5432/fixion_acceptance_test",
    {
      DATABASE_URL: "postgresql://app_user@localhost:5432/fixion_live",
    },
  );

  assert.throws(
    () => withPostgresTestDatabase(env, () => {
      poolLoadAttempts += 1;
    }, { applicationEnvFile: missingApplicationEnvFile }),
    /dedicated role different from the application role/,
  );
  assert.equal(poolLoadAttempts, 0);
});

test("requires a separate role and replaces DATABASE_URL before loading the pool", () => {
  const testUrl =
    "postgresql://fixion_test_user@127.0.0.1/fixion_acceptance_test?sslmode=disable";
  const canonicalTestUrl =
    "postgresql://fixion_test_user@127.0.0.1:5432/fixion_acceptance_test?sslmode=disable";
  const env = testEnvironment(testUrl, {
    DATABASE_URL: "postgresql://app_user@127.0.0.1:5432/fixion_live",
    PGHOST: "production.example.invalid",
    PGPORT: "6543",
    PGDATABASE: "live_database",
    PGUSER: "app_user",
    PGHOSTADDR: "203.0.113.22",
    PGSERVICE: "production",
    PGSERVICEFILE: "production.conf",
    PGPASSWORD: "must-be-cleared",
  });
  let loadedTarget;
  const { target, resources } = withPostgresTestDatabase(
    env,
    (validatedTarget) => {
      loadedTarget = validatedTarget;
      assert.equal(env.DATABASE_URL, canonicalTestUrl);
      assert.equal(env.PGHOST, "127.0.0.1");
      assert.equal(env.PGPORT, "5432");
      assert.equal(env.PGDATABASE, "fixion_acceptance_test");
      assert.equal(env.PGUSER, "fixion_test_user");
      assert.equal(env.PGHOSTADDR, "");
      assert.equal(env.PGSERVICE, "");
      assert.equal(env.PGSERVICEFILE, "");
      assert.equal(env.PGPASSWORD, "");
      return "pool-loaded-after-validation";
    },
    { applicationEnvFile: missingApplicationEnvFile },
  );

  assert.equal(target.database, "fixion_acceptance_test");
  assert.equal(target.user, "fixion_test_user");
  assert.equal(loadedTarget, target);
  assert.equal(resources, "pool-loaded-after-validation");
});

test("requires the explicit acknowledgement in addition to a safe destination", () => {
  const env = {
    FIXION_TEST_DATABASE_URL:
      "postgresql://fixion_test_user@localhost/fixion_acceptance_test",
  };

  assert.throws(
    () => resolvePostgresTestDatabase(env, {
      applicationEnvFile: missingApplicationEnvFile,
    }),
    /FIXION_TEST_DATABASE_ACK=1/,
  );
});

test("verifies server identity through a read-only preflight before setup", async () => {
  const target = resolvePostgresTestDatabase(
    testEnvironment(
      "postgresql://fixion_test_user@localhost:5432/fixion_acceptance_test",
    ),
    { applicationEnvFile: missingApplicationEnvFile },
  );
  let queryCount = 0;
  const db = {
    async query(sql) {
      queryCount += 1;
      assert.match(sql, /current_database\(\)/);
      assert.match(sql, /inet_server_addr\(\)/);
      return {
        rows: [{
          database_name: "fixion_acceptance_test",
          user_name: "fixion_test_user",
          server_address: "127.0.0.1",
          server_port: 5432,
        }],
      };
    },
  };

  await assertPostgresTestDatabaseIdentity(db, target.connectionString, target);
  assert.equal(queryCount, 1);

  await assert.rejects(
    () => assertPostgresTestDatabaseIdentity(db, "postgresql://other/target", target),
    /pool configuration does not match/,
  );
  assert.equal(queryCount, 1);

  db.query = async () => ({
    rows: [{
      database_name: "fixion_acceptance_test",
      user_name: "fixion_test_user",
      server_address: "203.0.113.20",
      server_port: 5432,
    }],
  });
  await assert.rejects(
    () => assertPostgresTestDatabaseIdentity(db, target.connectionString, target),
    /server identity did not match/,
  );
});
