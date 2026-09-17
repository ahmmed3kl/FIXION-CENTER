/*
 * One-time destructive reset.
 *
 * Preserves the database schema and platform_admins, removes all tenant/
 * operational rows, then creates exactly two centers and one admin user.
 * Run only against the intended PostgreSQL database:
 *   $env:DATABASE_URL='...'; $env:RESET_ADMIN_PASSWORD='...'; node scripts/reset-operational-data.js
 */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../src/db");

const centers = [
  { id: "center-reset-1", name: "مركز النور 4821", code: "NOOR-4821" },
  { id: "center-reset-2", name: "مركز القمة 7394", code: "QIMMA-7394" },
];
const account = {
  id: "user-reset-admin",
  fullName: "مدير النظام",
  email: "admin.reset@fixion-center.com",
};

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; no data was changed.");
  }
  const password = process.env.RESET_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("RESET_ADMIN_PASSWORD is required; no data was changed.");
  }

  const hash = await bcrypt.hash(password, 12);
  await db.withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS center_data_state (
        center_id VARCHAR(64) PRIMARY KEY,
        reset_generation BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Keep schema/migrations and platform administrators. Every other table
    // is operational or tenant-scoped and is intentionally emptied.
    const result = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('platform_admins', 'schema_migrations', 'center_data_state')
    `);
    const tables = result.rows
      .map((row) => `public."${row.table_name.replace(/"/g, '""')}"`)
      .join(", ");
    if (tables) await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);

  for (const center of centers) {
      await client.query(
        `INSERT INTO centers (id, name, code, status)
         VALUES ($1, $2, $3, 'active')`,
      [center.id, center.name, center.code],
    );
    await client.query(
      `INSERT INTO center_data_state (center_id, reset_generation, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (center_id) DO UPDATE
       SET reset_generation = center_data_state.reset_generation + 1, updated_at = NOW()`,
      [center.id],
    );
  }

    await client.query(
      `INSERT INTO users
         (id, center_id, full_name, email, password_hash, role, permissions, status)
       VALUES ($1, $2, $3, $4, $5, 'admin', '{}'::jsonb, 'active')`,
      [account.id, centers[0].id, account.fullName, account.email, hash],
    );
    await client.query(
      `INSERT INTO user_centers (id, user_id, center_id, role, is_primary)
       VALUES ($1, $2, $3, 'admin', true), ($4, $2, $5, 'admin', false)`,
      ["uc-reset-1", account.id, centers[0].id, "uc-reset-2", centers[1].id],
    );
  });

  console.log(JSON.stringify({ centers, account: { ...account, password: "(provided via RESET_ADMIN_PASSWORD)" } }, null, 2));
}

main().catch((error) => {
  const details = [
    error?.message || String(error),
    error?.code ? `code=${error.code}` : null,
    error?.detail ? `detail=${error.detail}` : null,
    error?.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean).join(" | ");
  console.error(`Reset failed: ${details}`);
  process.exitCode = 1;
});
