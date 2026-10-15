const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const dotenv = require("dotenv");

const applicationEnvFile = path.resolve(__dirname, "../.env");
const defaultDatabasePort = 5432;
const disallowedConnectionParameters = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "password",
  "port",
  "service",
  "servicefile",
  "user",
  "username",
]);
const allowedConnectionParameters = new Set(["application_name", "sslmode"]);

function normalizeHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith("127.");
  return (
    net.isIP(normalized) === 6 &&
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(normalized)
  );
}

function parsePostgresUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL connection URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} must use the postgres or postgresql protocol.`);
  }
  if (parsed.hash) {
    throw new Error(`${label} must not contain a URL fragment.`);
  }

  for (const parameter of parsed.searchParams.keys()) {
    if (disallowedConnectionParameters.has(parameter.toLowerCase())) {
      throw new Error(
        `${label} contains a connection parameter that can override its target.`,
      );
    }
    if (!allowedConnectionParameters.has(parameter.toLowerCase())) {
      throw new Error(`${label} contains an unsupported connection parameter.`);
    }
  }

  let database;
  let user;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    user = decodeURIComponent(parsed.username);
  } catch {
    throw new Error(
      `${label} contains an invalid encoded database or user name.`,
    );
  }

  if (!parsed.hostname || !database || database.includes("/") || !user) {
    throw new Error(
      `${label} must specify a host, database, and PostgreSQL user.`,
    );
  }

  const port = Number(parsed.port || defaultDatabasePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must specify a valid PostgreSQL port.`);
  }
  parsed.port = String(port);

  return {
    connectionString: parsed.toString(),
    host: normalizeHost(parsed.hostname),
    port,
    database,
    user,
  };
}

function readApplicationDatabaseUrls(env, envFile) {
  const urls = [];
  if (String(env.DATABASE_URL || "").trim()) {
    urls.push({
      label: "application DATABASE_URL",
      value: String(env.DATABASE_URL).trim(),
    });
  }

  if (envFile && fs.existsSync(envFile)) {
    const fileEnvironment = dotenv.parse(fs.readFileSync(envFile));
    if (String(fileEnvironment.DATABASE_URL || "").trim()) {
      urls.push({
        label: "application environment file DATABASE_URL",
        value: String(fileEnvironment.DATABASE_URL).trim(),
      });
    }
  }
  return urls;
}

function databaseHostKey(host) {
  return isLoopbackHost(host) ? "loopback" : normalizeHost(host);
}

function resolvePostgresTestDatabase(env = process.env, options = {}) {
  const testUrl = String(env.FIXION_TEST_DATABASE_URL || "").trim();
  if (!testUrl) {
    throw new Error(
      "FIXION_TEST_DATABASE_URL is required; DATABASE_URL and backend/.env are not test-database fallbacks.",
    );
  }
  if (env.FIXION_TEST_DATABASE_ACK !== "1") {
    throw new Error(
      "Set FIXION_TEST_DATABASE_ACK=1 to explicitly enable the isolated PostgreSQL test run; this acknowledgement does not establish database isolation.",
    );
  }

  const target = parsePostgresUrl(testUrl, "FIXION_TEST_DATABASE_URL");
  if (target.host.endsWith(".neon.tech")) {
    throw new Error(
      "Neon database hosts are prohibited for PostgreSQL integration tests.",
    );
  }
  if (!isLoopbackHost(target.host)) {
    throw new Error(
      "Only PostgreSQL hosts on the local loopback interface are allowed; remote or unknown endpoints are refused before loading the database pool.",
    );
  }
  if (
    ["postgres", "template0", "template1"].includes(
      target.database.toLowerCase(),
    )
  ) {
    throw new Error(
      "A dedicated non-default PostgreSQL database is required for tests.",
    );
  }

  const envFile =
    options.applicationEnvFile === undefined
      ? applicationEnvFile
      : options.applicationEnvFile;
  for (const applicationUrl of readApplicationDatabaseUrls(env, envFile)) {
    const application = parsePostgresUrl(
      applicationUrl.value,
      applicationUrl.label,
    );
    if (
      databaseHostKey(target.host) === databaseHostKey(application.host) &&
      target.port === application.port &&
      target.database === application.database
    ) {
      throw new Error(
        "The explicit PostgreSQL test target is the same database configured for the application.",
      );
    }
    if (
      application.user &&
      target.user.toLowerCase() === application.user.toLowerCase()
    ) {
      throw new Error(
        "The PostgreSQL test target must use a dedicated role different from the application role.",
      );
    }
  }

  return target;
}

function withPostgresTestDatabase(env, loadDatabaseResources, options = {}) {
  if (typeof loadDatabaseResources !== "function") {
    throw new TypeError("A lazy database-resource loader is required.");
  }

  const target = resolvePostgresTestDatabase(env, options);
  // The application config may parse backend/.env after this point. Setting
  // the validated test URL and libpq-compatible routing variables first
  // prevents dotenv or ambient PG* variables from supplying a different target.
  env.DATABASE_URL = target.connectionString;
  env.PGHOST = target.host;
  env.PGPORT = String(target.port);
  env.PGDATABASE = target.database;
  env.PGUSER = target.user;
  env.PGHOSTADDR = "";
  env.PGSERVICE = "";
  env.PGSERVICEFILE = "";
  env.PGPASSWORD = "";
  return {
    target,
    resources: loadDatabaseResources(target),
  };
}

function isLoopbackAddress(address) {
  if (address === null || address === undefined) return false;

  const normalizedAddress = String(address).split("/")[0];
  return isLoopbackHost(normalizedAddress);
}

async function assertPostgresTestDatabaseIdentity(
  db,
  configDatabaseUrl,
  target,
) {
  if (String(configDatabaseUrl || "").trim() !== target.connectionString) {
    throw new Error(
      "The PostgreSQL pool configuration does not match the validated test URL.",
    );
  }

  const result = await db.query(
    `SELECT current_database() AS database_name,
            current_user AS user_name,
            inet_server_addr()::text AS server_address,
            inet_server_port() AS server_port`,
  );
  const identity = result.rows?.[0];
  if (
    !identity ||
    identity.database_name !== target.database ||
    identity.user_name !== target.user ||
    Number(identity.server_port) !== target.port ||
    !isLoopbackAddress(identity.server_address)
  ) {
    throw new Error(
      "PostgreSQL server identity did not match the dedicated local test target; refusing schema setup and test writes.",
    );
  }
  return {
    database: identity.database_name,
    user: identity.user_name,
    host: identity.server_address,
    port: Number(identity.server_port),
  };
}

module.exports = {
  assertPostgresTestDatabaseIdentity,
  resolvePostgresTestDatabase,
  withPostgresTestDatabase,
};
