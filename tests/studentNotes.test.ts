import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { DeviceService } from "../src/core/device";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { StudentNoteRepository } from "../src/features/students/StudentNoteRepository";
import { User } from "../src/shared/types";

interface NativeStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

interface NativeSqlite {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeSqliteConstructor {
  new (filename: string): NativeSqlite;
}

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: NativeSqliteConstructor;
};

class RealSqliteDatabase implements SqlDatabase {
  private readonly connection: NativeSqlite;

  constructor(filename: string) {
    this.connection = new DatabaseSync(filename);
  }

  execSync(sql: string): void {
    this.connection.exec(sql);
  }

  runSync(sql: string, ...parameters: any[]): unknown {
    return this.connection.prepare(sql).run(...this.flatten(parameters));
  }

  getAllSync<T = any>(sql: string, ...parameters: any[]): T[] {
    return this.connection.prepare(sql).all(...this.flatten(parameters)) as T[];
  }

  getFirstSync<T = any>(sql: string, ...parameters: any[]): T | null {
    return (this.connection.prepare(sql).get(...this.flatten(parameters)) as T | undefined) || null;
  }

  close(): void {
    this.connection.close();
  }

  private flatten(parameters: any[]): any[] {
    return parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0]
      : parameters;
  }
}

const CENTER_ID = "student-note-center";
const STUDENT_ID = "student-note-student";
const USER_ID = "student-note-author";

describe("student note management", () => {
  let tempDirectory: string;
  let database: RealSqliteDatabase;

  beforeAll(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-student-notes-"));
  });

  afterAll(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    database = new RealSqliteDatabase(path.join(tempDirectory, `${Date.now()}-${Math.random()}.sqlite`));
    DatabaseService.runMigrations(database);
    DatabaseService.setMockDb(database);
    DeviceService.setCachedDeviceId("student-note-device");
    database.runSync(
      "INSERT INTO centers (id, name, code) VALUES (?, ?, ?)",
      [CENTER_ID, "Notes Test Center", "NOTE-TEST"],
    );
    database.runSync(
      `INSERT INTO students
       (id, center_id, full_name, phone, parent_phone, grade, status, created_at, student_code, updated_at)
       VALUES (?, ?, 'Test Student', '', '', 'Grade 1', 'active', ?, 'NOTE-1', ?)`,
      [STUDENT_ID, CENTER_ID, "2026-01-01", "2026-01-01"],
    );
    const user: User = {
      id: USER_ID,
      fullName: "Note Author",
      email: "note-author@example.invalid",
      phone: "01000000000",
      role: "assistant",
      centerId: CENTER_ID,
      centerIds: [CENTER_ID],
      permissions: ["students.update"],
    };
    useAuthStore.setState({
      currentUser: user,
      activeCenterId: CENTER_ID,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    database.close();
    useAuthStore.setState({ currentUser: null, activeCenterId: null, isAuthenticated: false });
  });

  it("creates independent notes, updates one, and logically deletes only the selected note", () => {
    const first = StudentNoteRepository.create(STUDENT_ID, "ملاحظة أولى");
    const second = StudentNoteRepository.create(STUDENT_ID, "ملاحظة ثانية");

    expect(StudentNoteRepository.listForStudent(STUDENT_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, text: "ملاحظة أولى", createdByName: "Note Author" }),
        expect.objectContaining({ id: second.id, text: "ملاحظة ثانية", createdByName: "Note Author" }),
      ]),
    );

    const originalNote = StudentNoteRepository.listForStudent(STUDENT_ID)
      .find((note) => note.id === first.id);
    expect(originalNote).toBeDefined();

    StudentNoteRepository.update(first.id, "ملاحظة معدلة");
    expect(StudentNoteRepository.listForStudent(STUDENT_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          text: "ملاحظة معدلة",
          createdAt: originalNote?.createdAt,
          createdBy: USER_ID,
          createdByName: "Note Author",
          updatedAt: expect.any(String),
        }),
        expect.objectContaining({ id: second.id, text: "ملاحظة ثانية" }),
      ]),
    );

    StudentNoteRepository.remove(first.id);
    expect(StudentNoteRepository.listForStudent(STUDENT_ID)).toEqual([
      expect.objectContaining({ id: second.id, text: "ملاحظة ثانية" }),
    ]);
    expect(database.getFirstSync<{ deletedAt: string | null }>(
      "SELECT deleted_at as deletedAt FROM student_notes WHERE id = ?",
      [first.id],
    )?.deletedAt).toBeTruthy();
  });
});
