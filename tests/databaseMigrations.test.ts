import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseService, MIGRATIONS, SqlDatabase } from "../src/core/database";

function sqliteValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

class SqliteCliDatabase implements SqlDatabase {
  constructor(private readonly filename: string) {}

  private parameters(params: unknown[]): unknown[] {
    return params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;
  }

  execSync(sql: string): void {
    execFileSync("sqlite3", ["-batch", this.filename, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  runSync(sql: string, ...params: unknown[]): { changes: number } {
    const values = this.parameters(params);
    let index = 0;
    const interpolated = sql.replace(/\?/g, () => sqliteValue(values[index++]));
    const result = this.getAllSync<{ changes: number }>(
      `${interpolated}; SELECT changes() AS changes;`,
    );
    return { changes: Number(result[result.length - 1]?.changes || 0) };
  }

  getAllSync<T = unknown>(sql: string, ...params: unknown[]): T[] {
    const values = this.parameters(params);
    let index = 0;
    const interpolated = sql.replace(/\?/g, () => sqliteValue(values[index++]));
    const output = execFileSync(
      "sqlite3",
      ["-batch", "-json", this.filename, interpolated],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output ? (JSON.parse(output) as T[]) : [];
  }

  getFirstSync<T = unknown>(sql: string, ...params: unknown[]): T | null {
    return this.getAllSync<T>(sql, ...params)[0] || null;
  }
}

describe("SQLite migration ordering and upgrades", () => {
  let tempDirectory: string;

  beforeAll(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-migrations-"));
  });

  afterAll(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("applies every migration in ascending order on a new database", () => {
    const database = new SqliteCliDatabase(path.join(tempDirectory, "new.sqlite"));
    const versions = MIGRATIONS.map((migration) => migration.version);

    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);

    DatabaseService.runMigrations(database);

    const applied = database.getAllSync<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied.map((row) => row.version)).toEqual(versions);
    expect(database.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    )?.user_version).toBe(Math.max(...versions));
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'",
    )?.name).toBe("sync_metadata");
    expect(database.getFirstSync<{ notnull: number }>(
      "SELECT \"notnull\" FROM pragma_table_info('students') WHERE name='card_code'",
    )?.notnull).toBe(0);
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_homework_evaluations'",
    )?.name).toBe("session_homework_evaluations");

    const schemaObjects = database.getAllSync<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')",
    );
    const databaseSource = fs.readFileSync(
      path.join(__dirname, "../src/core/database/index.ts"),
      "utf8",
    );
    const migrationsSource = databaseSource.slice(
      databaseSource.indexOf("export const MIGRATIONS"),
      databaseSource.indexOf("\n];", databaseSource.indexOf("export const MIGRATIONS")),
    );
    const expectedTables = [
      "schema_migrations",
      ...Array.from(
        migrationsSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi),
        (match) => match[1],
      ),
    ];
    const droppedIndexes = new Set(Array.from(
      migrationsSource.matchAll(/DROP INDEX IF EXISTS\s+([A-Za-z0-9_]+)/gi),
      (match) => match[1],
    ));
    const expectedIndexes = Array.from(
      migrationsSource.matchAll(/CREATE(?: UNIQUE)? INDEX IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi),
      (match) => match[1],
    ).filter((name) => !droppedIndexes.has(name));
    const existingNames = new Set(schemaObjects.map((object) => object.name));
    expect(expectedTables.filter((name) => !existingNames.has(name))).toEqual([]);
    expect(expectedIndexes.filter((name) => !existingNames.has(name))).toEqual([]);
  });

  it("upgrades an existing v1-v22 database without resetting its rows", () => {
    const database = new SqliteCliDatabase(path.join(tempDirectory, "existing.sqlite"));
    database.execSync(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of MIGRATIONS.filter((item) => item.version < 23)) {
      migration.up(database);
      database.runSync(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, "2026-01-01T00:00:00.000Z"],
      );
    }

    database.runSync(
      "INSERT INTO centers (id, name, code) VALUES (?, ?, ?)",
      ["migration-existing-center", "Existing Center", "MIGRATION-KEEP"],
    );

    DatabaseService.runMigrations(database);

    const applied = database.getAllSync<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied.map((row) => row.version)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM centers WHERE id = ?",
      "migration-existing-center",
    )?.name).toBe("Existing Center");
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM pragma_table_info('packages') WHERE name='max_selections'",
    )?.name).toBe("max_selections");
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM pragma_table_info('debt_cycles') WHERE name='server_revision'",
    )?.name).toBe("server_revision");
    expect(database.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    )?.user_version).toBe(23);
  });

  it("can run again at v23 without duplicate migration records or schema changes", () => {
    const database = new SqliteCliDatabase(path.join(tempDirectory, "rerun.sqlite"));
    DatabaseService.runMigrations(database);

    const readSchema = () => database.getAllSync<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
    const before = readSchema();
    DatabaseService.runMigrations(database);
    const after = readSchema();
    const applied = database.getAllSync<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );

    expect(after).toEqual(before);
    expect(applied.map((row) => row.version)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    expect(database.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    )?.user_version).toBe(23);
  });

  it("repairs missing sync metadata when the migration ledger already marks it applied", () => {
    const database = new SqliteCliDatabase(path.join(tempDirectory, "missing-sync-metadata.sqlite"));
    DatabaseService.runMigrations(database);
    database.runSync(
      "INSERT INTO centers (id, name, code) VALUES (?, ?, ?)",
      ["keep-center", "Keep Center", "KEEP"],
    );
    database.execSync("DROP TABLE sync_metadata;");

    expect(() => database.getFirstSync(
      "SELECT center_id FROM sync_metadata WHERE center_id = ?",
      "center-reset-1",
    )).toThrow();

    DatabaseService.ensureSyncMetadataSchema(database);
    DatabaseService.ensureSyncMetadataSchema(database);
    database.runSync(
      `INSERT INTO sync_metadata (center_id, last_error, updated_at)
       VALUES (?, ?, ?)`,
      ["center-reset-1", "test error", "2026-10-06T00:00:00.000Z"],
    );

    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'",
    )?.name).toBe("sync_metadata");
    expect(database.getFirstSync<{ last_error: string }>(
      "SELECT last_error FROM sync_metadata WHERE center_id = ?",
      "center-reset-1",
    )?.last_error).toBe("test error");
    expect(database.getFirstSync<{ name: string }>(
      "SELECT name FROM centers WHERE id = ?",
      "keep-center",
    )?.name).toBe("Keep Center");
    expect(database.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    )?.user_version).toBe(23);
  });
});
