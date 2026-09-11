const fs = require("fs");
const path = require("path");

const CONNECTION_STRING =
  "postgresql://neondb_owner:npg_CvDl5LXdj0RZ@ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const SQL_ENDPOINT =
  "https://ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/sql";

async function runQuery(query) {
  const res = await fetch(SQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Neon-Connection-String": CONNECTION_STRING,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON response: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function migrate() {
  console.log("--- Connecting to Neon Database ---");
  const check = await runQuery(
    "SELECT current_database(), current_user, version();",
  );
  console.log("Database Info:", check.rows[0]);

  const schemaPath = path.join(__dirname, "neon_schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  console.log("--- Applying Schema and Migrations ---");
  try {
    await runQuery(sql);
    console.log(
      "SUCCESS: Full schema and seed data applied cleanly in one transaction!",
    );
  } catch (err) {
    console.warn(
      "Batch failed, trying statement by statement... Reason:",
      err.message,
    );
    // Split SQL by semicolons while respecting comments and blocks
    const cleanedSql = sql
      .replace(/--.*$/gm, "") // Remove comments
      .replace(/\r\n/g, "\n");

    // Split into individual statements
    const statements = cleanedSql
      .split(";")
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length > 0 &&
          s.toUpperCase() !== "BEGIN" &&
          s.toUpperCase() !== "COMMIT",
      );

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await runQuery(stmt);
      } catch (stmtErr) {
        console.error(`Error at statement ${i + 1}:`, stmt.slice(0, 100));
        throw stmtErr;
      }
    }
    console.log("SUCCESS: All statements applied individually!");
  }

  console.log("--- Verifying Created Tables ---");
  const tables = await runQuery(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `);
  console.log(
    "Tables in database:",
    tables.rows.map((r) => r.table_name),
  );

  const centerCount = await runQuery("SELECT COUNT(*) as count FROM centers;");
  const userCount = await runQuery("SELECT COUNT(*) as count FROM users;");
  const teacherCount = await runQuery(
    "SELECT COUNT(*) as count FROM teachers;",
  );
  const groupCount = await runQuery("SELECT COUNT(*) as count FROM groups;");

  console.log("--- Seed Verification ---");
  console.log("Centers:", centerCount.rows[0].count);
  console.log("Users:", userCount.rows[0].count);
  console.log("Teachers:", teacherCount.rows[0].count);
  console.log("Groups:", groupCount.rows[0].count);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
