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
    CREATE TABLE IF NOT EXISTS center_data_state (
      center_id VARCHAR(64) PRIMARY KEY,
      reset_generation BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO center_data_state (center_id)
      SELECT id FROM centers
      ON CONFLICT (center_id) DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_exams (
      id TEXT PRIMARY KEY,
      center_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grade VARCHAR(128) NOT NULL,
      max_score NUMERIC(10, 2) NOT NULL DEFAULT 100,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS grade_scores (
      id TEXT PRIMARY KEY,
      center_id TEXT NOT NULL,
      exam_id TEXT NOT NULL REFERENCES grade_exams(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL,
      score NUMERIC(10, 2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      CONSTRAINT uq_grade_score UNIQUE (center_id, exam_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_grade_exams_grade ON grade_exams(center_id, grade, status);
    CREATE INDEX IF NOT EXISTS idx_grade_scores_exam ON grade_scores(center_id, exam_id);
  `);
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

  // Keep the server's historical snapshots in lockstep with the mobile
  // database.  Older Neon databases only had the original group/session
  // columns, so a bootstrap silently dropped the teacher, subject, pricing,
  // schedule and lateness metadata that the reports depend on.
  await pool.query(`
    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS session_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS session_duration_minutes INTEGER NOT NULL DEFAULT 120,
      ADD COLUMN IF NOT EXISTS late_after_minutes INTEGER NOT NULL DEFAULT 15;
    UPDATE groups
       SET session_price = CASE WHEN session_price = 0 THEN COALESCE(default_fee, 0) ELSE session_price END,
           monthly_price = CASE WHEN monthly_price = 0 THEN COALESCE(default_fee, 0) * 4 ELSE monthly_price END
     WHERE session_price = 0 OR monthly_price = 0;
  `);

  await pool.query(`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS schedule_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS subject_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS teacher_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS session_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS late_after_minutes INTEGER NOT NULL DEFAULT 15;
    UPDATE sessions s
       SET subject_id = COALESCE(s.subject_id, g.subject_id),
           teacher_id = COALESCE(s.teacher_id, g.teacher_id),
           session_price = CASE WHEN s.session_price = 0 THEN COALESCE(g.session_price, g.default_fee, 0) ELSE s.session_price END,
           late_after_minutes = COALESCE(s.late_after_minutes, g.late_after_minutes, 15)
      FROM groups g
     WHERE g.center_id = s.center_id AND g.id = s.group_id;
  `);

  // The mobile app supports external students. Older Neon databases used a
  // check constraint that rejected that valid value, leaving those students
  // permanently stuck in the sync conflict queue. Normalize only unknown
  // legacy values, then widen the constraint safely for existing databases.
  await pool.query(`
    UPDATE students
       SET student_type = 'registered'
     WHERE student_type IS NULL
        OR student_type NOT IN ('registered', 'external', 'guest', 'scholarship');
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_student_type_check;
    ALTER TABLE students
      ADD CONSTRAINT students_student_type_check
      CHECK (student_type IN ('registered', 'external', 'guest', 'scholarship'));
  `);

  // Package subjects are unique by teacher, not by subject alone. This lets a
  // package include the same subject with different teachers while preventing
  // the same teacher from being added twice.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.package_subjects')
          AND conname = 'uq_center_pkg_subject'
      ) THEN
        ALTER TABLE package_subjects DROP CONSTRAINT uq_center_pkg_subject;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_center_pkg_subject_teacher
      ON package_subjects(center_id, package_id, subject_id, default_teacher_id);
    ALTER TABLE package_subjects
      ADD COLUMN IF NOT EXISTS group_id VARCHAR(64);
    CREATE INDEX IF NOT EXISTS idx_pkg_subj_group
      ON package_subjects(center_id, group_id);
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

  await pool.query(`
    ALTER TABLE notification_deliveries
      ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(128);
  `);

  // Payment rows are also rebuilt during bootstrap.  Older Neon databases
  // did not persist the mobile-only payment type/date fields, which caused a
  // monthly payment to come back to a fresh device as a session payment and
  // stop reducing monthly debt.  Keep these fields server-side as part of the
  // canonical cash ledger.
  await pool.query(`
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS payment_type VARCHAR(32) NOT NULL DEFAULT 'session',
      ADD COLUMN IF NOT EXISTS payment_date DATE,
      ADD COLUMN IF NOT EXISTS notes TEXT;
    UPDATE payments
      SET payment_date = COALESCE(payment_date, created_at::date)
      WHERE payment_date IS NULL;
  `);

  // Preserve debt-cycle identity when a server snapshot is pulled back to a
  // device. Without these fields a pulled cycle loses its group/package
  // relation and every cycle defaults to number 1 locally.
  await pool.query(`
    ALTER TABLE debt_cycles
      ADD COLUMN IF NOT EXISTS group_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS package_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS cycle_number INTEGER;
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY center_id, COALESCE(enrollment_id, package_subscription_id, id)
               ORDER BY period_start, id
             ) AS number
      FROM debt_cycles
    )
    UPDATE debt_cycles c
       SET cycle_number = ranked.number
      FROM ranked
     WHERE c.id = ranked.id AND c.cycle_number IS NULL;
  `);
}

module.exports = {
  pool,
  query,
  withTransaction,
  ensureSchemaCompatibility,
};
