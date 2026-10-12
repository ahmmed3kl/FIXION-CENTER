import { DatabaseService, SqlDatabase } from "../src/core/database";

interface NativeStatement {
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

class RealSqliteAdapter implements SqlDatabase {
  constructor(private readonly database: NativeDatabase) {}

  execSync(sql: string): void {
    this.database.exec(sql);
  }

  runSync(sql: string, ...parameters: unknown[]): unknown {
    const bindings = parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0] as unknown[]
      : parameters;
    return this.database.prepare(sql).run(...bindings);
  }

  getAllSync<T = unknown>(sql: string, ...parameters: unknown[]): T[] {
    const bindings = parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0] as unknown[]
      : parameters;
    return this.database.prepare(sql).all(...bindings) as T[];
  }

  getFirstSync<T = unknown>(sql: string, ...parameters: unknown[]): T | null {
    const bindings = parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0] as unknown[]
      : parameters;
    return (this.database.prepare(sql).get(...bindings) as T | undefined) ?? null;
  }
}

describe("card range SQLite migration", () => {
  it("adds the production-shaped table to an existing v25 database without replacing its data", () => {
    const native = new DatabaseSync(":memory:");
    const database = new RealSqliteAdapter(native);
    try {
      database.execSync(`
        CREATE TABLE centers (id TEXT PRIMARY KEY);
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE students (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
        INSERT INTO centers (id) VALUES ('center-a'), ('center-b');
        INSERT INTO students (id, full_name) VALUES ('student-a', 'بيانات محفوظة');
      `);
      for (let version = 1; version <= 25; version += 1) {
        database.runSync(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, `migration-${version}`, new Date(0).toISOString()],
        );
      }

      DatabaseService.runMigrations(database);

      expect(database.getFirstSync<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )?.version).toBe(26);
      expect(database.getFirstSync<{ full_name: string }>(
        "SELECT full_name FROM students WHERE id = ?",
        ["student-a"],
      )?.full_name).toBe("بيانات محفوظة");

      database.runSync(
        `INSERT INTO card_ranges (id, center_id, start_code, end_code, status)
         VALUES (?, ?, ?, ?, ?)`,
        ["range-a", "center-a", "000100", "000199", "active"],
      );
      expect(database.getFirstSync<{ start_code: string }>(
        "SELECT start_code FROM card_ranges WHERE id = ?",
        ["range-a"],
      )?.start_code).toBe("000100");
      expect(() => database.runSync(
        `INSERT INTO card_ranges (id, center_id, start_code, end_code, status)
         VALUES (?, ?, ?, ?, ?)`,
        ["range-invalid", "center-a", "100", "099", "active"],
      )).toThrow();
    } finally {
      native.close();
    }
  });
});
