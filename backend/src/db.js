const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.warn("Transient idle client error in PostgreSQL pool:", err.message);
});

/**
 * Execute a single query with automatic connection management and transient drop retry
 */
async function query(text, params = [], retries = 2) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (
      retries > 0 &&
      (err.message?.includes("Connection terminated") ||
        err.code === "ECONNRESET" ||
        err.code === "57P01")
    ) {
      console.warn("Retrying database query after transient connection drop...");
      return query(text, params, retries - 1);
    }
    throw err;
  }
}

/**
 * Execute multiple database operations within a true ACID transaction (BEGIN ... COMMIT / ROLLBACK)
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  const errorHandler = (err) => {
    // Prevent unhandled 'error' event crash if connection drops
    console.warn("Client connection event during transaction:", err.message);
  };
  client.on("error", errorHandler);
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignored if connection already closed
    }
    throw err;
  } finally {
    client.removeListener("error", errorHandler);
    client.release();
  }
}

/**
 * Render starts the API directly and does not run backend/migrate.js.
 * Upgrade legacy Neon package tables before any sync request can use them.
 */
async function ensureSchemaCompatibility() {
  await pool.query(`
    ALTER TABLE packages
      ADD COLUMN IF NOT EXISTS grade VARCHAR(64) NOT NULL DEFAULT 'all',
      ADD COLUMN IF NOT EXISTS total_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_selections INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly',
      ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Older databases called the package amount `price`. Only reference that
  // column when it actually exists so modern schemas remain compatible.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'packages'
          AND column_name = 'price'
      ) THEN
        EXECUTE 'UPDATE packages
                 SET total_price = COALESCE(NULLIF(total_price, 0), price, 0)
                 WHERE total_price IS NULL OR total_price = 0';
      END IF;
    END $$;
  `);
}

module.exports = {
  pool,
  query,
  withTransaction,
  ensureSchemaCompatibility,
};
