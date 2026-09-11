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

module.exports = {
  pool,
  query,
  withTransaction,
};
