import { DatabaseService, SqlDatabase } from "../src/core/database";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { PaymentRequestRepository } from "../src/features/payments/PaymentRequestRepository";

// Real SQLite engine from Node's built-in node:sqlite module
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite");

function createRealSqliteDatabase(): {
  adapter: SqlDatabase;
  raw: any;
  close: () => void;
} {
  const raw = new DatabaseSync(":memory:");

  const normalizeParams = (params?: any[]): any[] => {
    if (!params || params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0].map((v: any) => (v === undefined ? null : v));
    }
    return params.map((v: any) => (v === undefined ? null : v));
  };

  const adapter: SqlDatabase = {
    execSync(sql: string): void {
      raw.exec(sql);
    },
    runSync(
      sql: string,
      params?: any[],
    ): { changes: number; lastInsertRowId: number } {
      const stmt = raw.prepare(sql);
      const res = stmt.run(...normalizeParams(params));
      return {
        changes: Number(res?.changes ?? 0),
        lastInsertRowId: Number(res?.lastInsertRowid ?? 0),
      };
    },
    getFirstSync<T>(sql: string, params?: any[]): T | null {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...normalizeParams(params));
      return (row ?? null) as T | null;
    },
    getAllSync<T>(sql: string, params?: any[]): T[] {
      const stmt = raw.prepare(sql);
      const rows = stmt.all(...normalizeParams(params));
      return (rows ?? []) as T[];
    },
  };

  return {
    adapter,
    raw,
    close: () => raw.close(),
  };
}

/**
 * Schema-aware fixture insert: reads the real migrated table definition,
 * keeps only columns that actually exist, and fills any remaining NOT NULL
 * columns without a default with a neutral placeholder. This keeps fixtures
 * valid against the real SQLite schema produced by the migration chain.
 */
function insertRow(
  db: SqlDatabase,
  table: string,
  values: Record<string, any>,
): void {
  const columns = db.getAllSync<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: any;
    pk: number;
  }>(`PRAGMA table_info(${table})`);
  if (columns.length === 0) {
    throw new Error(`no such table: ${table}`);
  }
  const row: Record<string, any> = {};
  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(values, col.name)) {
      row[col.name] = values[col.name];
    } else if (col.notnull && col.dflt_value === null && !col.pk) {
      const type = String(col.type || "").toUpperCase();
      row[col.name] =
        type.includes("INT") || type.includes("REAL") || type.includes("NUM")
          ? 0
          : `${col.name}-${String(values.id ?? "x")}`;
    }
  }
  const names = Object.keys(row);
  db.runSync(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    names.map((n) => row[n]),
  );
}

function seedCenterGraph(
  db: SqlDatabase,
  opts: {
    centerId: string;
    teacherId: string;
    subjectId: string;
    groupId: string;
    groupName: string;
    students: Array<{ id: string; code: string; name: string }>;
  },
): void {
  const existingCenter = db.getFirstSync<{ id: string }>(
    "SELECT id FROM centers WHERE id = ?",
    [opts.centerId],
  );
  if (!existingCenter) {
    insertRow(db, "centers", {
      id: opts.centerId,
      name: `Center ${opts.centerId}`,
      code: opts.centerId.toUpperCase(),
      time_zone: "Africa/Cairo",
    });
  }
  insertRow(db, "teachers", {
    id: opts.teacherId,
    center_id: opts.centerId,
    name: "أ. مدرس",
    full_name: "أ. مدرس",
    phone: "01000000000",
    status: "active",
    created_at: "2026-09-01",
  });
  insertRow(db, "subjects", {
    id: opts.subjectId,
    center_id: opts.centerId,
    name: "مادة",
    code: opts.subjectId,
    status: "active",
    created_at: "2026-09-01",
  });
  insertRow(db, "groups", {
    id: opts.groupId,
    center_id: opts.centerId,
    name: opts.groupName,
    grade: "الثالث الثانوي",
    subject_id: opts.subjectId,
    teacher_id: opts.teacherId,
    monthly_fee: 300,
    session_price: 50,
    billing_type: "monthly",
    capacity: 50,
    status: "active",
    created_at: "2026-09-01",
  });
  for (const s of opts.students) {
    insertRow(db, "students", {
      id: s.id,
      center_id: opts.centerId,
      student_code: s.code,
      card_code: `card-${s.code}`,
      full_name: s.name,
      phone: "01011111111",
      parent_phone: "01022222222",
      grade: "الثالث الثانوي",
      status: "active",
      created_at: "2026-09-01",
    });
    insertRow(db, "student_group_enrollments", {
      id: `enr-${s.id}`,
      center_id: opts.centerId,
      student_id: s.id,
      group_id: opts.groupId,
      start_date: "2026-09-01",
      status: "active",
      billing_type: "monthly",
      monthly_price: 300,
      created_at: "2026-09-01",
    });
  }
}

/**
 * Helper that builds a real SQLite database migrated only up to version 32
 * (simulating an existing user installation right before migration 33).
 */
function createExistingV32RealSqliteDatabase(): {
  adapter: SqlDatabase;
  raw: any;
  close: () => void;
} {
  const real = createRealSqliteDatabase();
  // Run full migrations first, then roll back ONLY migration 33 tables/version to simulate a true v32 installation
  DatabaseService.runMigrations(real.adapter);

  real.adapter.execSync(
    "DROP TABLE IF EXISTS student_payment_request_obligations;",
  );
  real.adapter.execSync("DROP TABLE IF EXISTS group_payment_requests;");
  real.adapter.runSync("DELETE FROM schema_migrations WHERE version = 33");
  real.adapter.execSync("PRAGMA user_version = 32;");

  return real;
}

describe("Payment Requests SQLite Migration (Real SQLite Engine)", () => {
  const OWNER_CENTER_1 = {
    id: "usr-mig-owner-1",
    fullName: "مدير السنتر الأول",
    phone: "01000000001",
    role: "owner" as const,
    centerId: "center-1",
    centerIds: ["center-1", "center-2"],
    permissions: ["*" as any],
  };

  afterEach(() => {
    // Restore default test database singleton after each test
    (DatabaseService as any).db = null;
    (DatabaseService as any).initializedDbInstance = null;
    (DatabaseService as any).initializedMigrationVersion = 0;
    DatabaseService.init();
  });

  test("1. Fresh SQLite database creates all required Payment Requests tables, columns, and indexes", () => {
    const real = createRealSqliteDatabase();
    try {
      DatabaseService.runMigrations(real.adapter);
      DatabaseService.ensurePaymentRequestsSchema(real.adapter);

      // Verify tables exist in sqlite_master
      const tables = real.adapter
        .getAllSync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('group_payment_requests', 'student_payment_request_obligations') ORDER BY name`,
        )
        .map((r) => r.name);

      expect(tables).toEqual([
        "group_payment_requests",
        "student_payment_request_obligations",
      ]);

      // Verify group_payment_requests columns match repository queries
      const requestCols = real.adapter
        .getAllSync<{ name: string }>(
          "PRAGMA table_info(group_payment_requests)",
        )
        .map((c) => c.name);
      expect(requestCols).toEqual(
        expect.arrayContaining([
          "id",
          "operation_id",
          "center_id",
          "group_id",
          "name",
          "amount",
          "reference_month",
          "status",
          "created_by",
          "created_by_name",
          "updated_by",
          "updated_by_name",
          "archived_by",
          "archived_at",
          "created_at",
          "updated_at",
        ]),
      );

      // Verify student_payment_request_obligations columns match repository queries
      const obligationCols = real.adapter
        .getAllSync<{ name: string }>(
          "PRAGMA table_info(student_payment_request_obligations)",
        )
        .map((c) => c.name);
      expect(obligationCols).toEqual(
        expect.arrayContaining([
          "id",
          "operation_id",
          "center_id",
          "request_id",
          "group_id",
          "student_id",
          "amount_due",
          "amount_paid",
          "status",
          "payment_id",
          "paid_at",
          "created_at",
          "updated_at",
          "cancelled_at",
        ]),
      );

      // Verify payments table has payment_request_obligation_id and payment_request_id
      const paymentCols = real.adapter
        .getAllSync<{ name: string }>("PRAGMA table_info(payments)")
        .map((c) => c.name);
      expect(paymentCols).toEqual(
        expect.arrayContaining([
          "payment_request_obligation_id",
          "payment_request_id",
        ]),
      );

      // Verify indexes exist
      const indexes = real.adapter
        .getAllSync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
            'idx_payment_requests_center_group',
            'idx_payment_req_obligations_request',
            'idx_payment_req_obligations_student',
            'idx_payment_req_obligations_group',
            'idx_payments_request_obligation'
          ) ORDER BY name`,
        )
        .map((i) => i.name);

      expect(indexes).toEqual([
        "idx_payment_req_obligations_group",
        "idx_payment_req_obligations_request",
        "idx_payment_req_obligations_student",
        "idx_payment_requests_center_group",
        "idx_payments_request_obligation",
      ]);
    } finally {
      real.close();
    }
  });

  test("2. Existing database (v32) upgrades to v33 without losing student, payment, attendance, or sync data (including live handle upgrade)", () => {
    const real = createExistingV32RealSqliteDatabase();
    try {
      const db = real.adapter;

      // Verify group_payment_requests does NOT exist yet in v32
      expect(() =>
        db.getAllSync("SELECT * FROM group_payment_requests"),
      ).toThrow(/no such table: group_payment_requests/i);

      // Seed existing v32 production data: center, teacher, subject, group, student, enrollment, session, attendance, payment, sync_operations
      seedCenterGraph(db, {
        centerId: "center-1",
        teacherId: "t-existing-1",
        subjectId: "sub-existing-1",
        groupId: "grp-existing-1",
        groupName: "مجموعة الرياضيات 1",
        students: [{ id: "stu-existing-1", code: "1001", name: "يوسف محمود" }],
      });
      insertRow(db, "sessions", {
        id: "ses-existing-1",
        center_id: "center-1",
        group_id: "grp-existing-1",
        session_date: "2026-10-15",
        start_time: "16:00",
        end_time: "18:00",
        status: "closed",
        created_at: "2026-10-15",
      });
      insertRow(db, "attendance", {
        id: "att-existing-1",
        operation_id: "op-att-existing-1",
        center_id: "center-1",
        session_id: "ses-existing-1",
        student_id: "stu-existing-1",
        status: "present",
        check_in_time: "2026-10-15T16:05:00Z",
        created_at: "2026-10-15T16:05:00Z",
      });
      insertRow(db, "payments", {
        id: "pay-existing-1",
        operation_id: "op-pay-existing-1",
        center_id: "center-1",
        student_id: "stu-existing-1",
        amount: 400,
        payment_type: "monthly",
        payment_method: "cash",
        payment_date: "2026-10-15",
        is_reversed: 0,
        created_at: "2026-10-15T16:10:00Z",
        user_id: "usr-mig-owner-1",
      });
      insertRow(db, "sync_operations", {
        id: "sync-row-1",
        operation_id: "op-pay-existing-1",
        center_id: "center-1",
        user_id: "usr-mig-owner-1",
        device_id: "dev-1",
        operation_type: "payment.create",
        entity_type: "payment",
        entity_id: "pay-existing-1",
        payload: '{"id":"pay-existing-1"}',
        created_at: "2026-10-15T16:10:00Z",
        status: "pending",
        retry_count: 0,
      });

      // Simulate an already-open v32 DatabaseService singleton handle (e.g., before hot reload / upgrade)
      (DatabaseService as any).db = db;
      (DatabaseService as any).initializedDbInstance = db;
      (DatabaseService as any).initializedMigrationVersion = 32;

      // Calling DatabaseService.getDb() must automatically run pending Migration 33 on the live handle
      const upgradedDb = DatabaseService.getDb();
      expect(upgradedDb).toBe(db);

      // Verify Migration 33 tables now exist and are queryable
      const requests = upgradedDb.getAllSync(
        "SELECT * FROM group_payment_requests",
      );
      expect(requests).toEqual([]);

      // Verify all existing student, payment, attendance, and sync_operations records are 100% preserved
      const student = upgradedDb.getFirstSync<{ id: string; full_name: string }>(
        "SELECT id, full_name FROM students WHERE id = ?",
        ["stu-existing-1"],
      );
      expect(student).toEqual({
        id: "stu-existing-1",
        full_name: "يوسف محمود",
      });

      const attendance = upgradedDb.getFirstSync<{ id: string; status: string }>(
        "SELECT id, status FROM attendance WHERE id = ?",
        ["att-existing-1"],
      );
      expect(attendance).toEqual({
        id: "att-existing-1",
        status: "present",
      });

      const payment = upgradedDb.getFirstSync<{
        id: string;
        amount: number;
        payment_type: string;
      }>("SELECT id, amount, payment_type FROM payments WHERE id = ?", [
        "pay-existing-1",
      ]);
      expect(payment).toEqual({
        id: "pay-existing-1",
        amount: 400,
        payment_type: "monthly",
      });

      const syncOp = upgradedDb.getFirstSync<{
        operation_id: string;
        status: string;
      }>(
        "SELECT operation_id, status FROM sync_operations WHERE operation_id = ?",
        ["op-pay-existing-1"],
      );
      expect(syncOp).toEqual({
        operation_id: "op-pay-existing-1",
        status: "pending",
      });
    } finally {
      real.close();
    }
  });

  test("3. Running migration twice is safe and idempotent", () => {
    const real = createRealSqliteDatabase();
    try {
      const db = real.adapter;

      // First run
      DatabaseService.runMigrations(db);
      DatabaseService.ensurePaymentRequestsSchema(db);

      // Insert a payment request row between runs
      seedCenterGraph(db, {
        centerId: "center-1",
        teacherId: "t-1",
        subjectId: "s-1",
        groupId: "g-1",
        groupName: "Group 1",
        students: [],
      });
      insertRow(db, "group_payment_requests", {
        id: "pr-idem-1",
        operation_id: "op-idem-1",
        center_id: "center-1",
        group_id: "g-1",
        name: "مذكرة مراجعة",
        amount: 75,
        status: "active",
        created_by: "usr-1",
        created_at: "2026-11-01T10:00:00Z",
      });

      // Second & third runs
      expect(() => {
        DatabaseService.runMigrations(db);
        DatabaseService.ensurePaymentRequestsSchema(db);
        DatabaseService.runMigrations(db);
        DatabaseService.ensurePaymentRequestsSchema(db);
      }).not.toThrow();

      // Verify migration 33 is recorded exactly once
      const v33Rows = db.getAllSync<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations WHERE version = 33",
      );
      expect(v33Rows).toHaveLength(1);
      expect(v33Rows[0]).toEqual({
        version: 33,
        name: "group_payment_requests_and_obligations",
      });

      // Verify data inserted before re-running migrations is untouched
      const existingReq = db.getFirstSync<{ id: string; amount: number }>(
        "SELECT id, amount FROM group_payment_requests WHERE id = 'pr-idem-1'",
      );
      expect(existingReq).toEqual({ id: "pr-idem-1", amount: 75 });
    } finally {
      real.close();
    }
  });

  test("4. PaymentRequestRepository queries and payment collection/reversal work end-to-end on real SQLite after migration", async () => {
    const real = createRealSqliteDatabase();
    try {
      const db = real.adapter;
      DatabaseService.runMigrations(db);
      DatabaseService.ensurePaymentRequestsSchema(db);

      // Bind real SQLite database to DatabaseService singleton
      (DatabaseService as any).db = db;
      (DatabaseService as any).initializedDbInstance = db;
      (DatabaseService as any).initializedMigrationVersion = 33;

      useAuthStore.setState({
        currentUser: OWNER_CENTER_1,
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });

      // Seed center, teacher, subject, group, and 2 active students
      seedCenterGraph(db, {
        centerId: "center-1",
        teacherId: "t-real-1",
        subjectId: "sub-real-1",
        groupId: "grp-real-1",
        groupName: "مجموعة الكيمياء A",
        students: [
          { id: "stu-real-1", code: "2001", name: "سارة أحمد" },
          { id: "stu-real-2", code: "2002", name: "عمر خالد" },
        ],
      });

      // 1. Query groups with student counts
      const groups = PaymentRequestRepository.getGroupsWithStudentCounts();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        id: "grp-real-1",
        name: "مجموعة الكيمياء A",
        activeStudentsCount: 2,
        activeRequestsCount: 0,
      });

      // 2. Create payment request
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-real-1",
        name: "مذكرة الباب الأول",
        amount: 120,
        referenceMonth: "نوفمبر 2026",
      });
      expect(created.affectedStudentsCount).toBe(2);
      expect(created.request.amount).toBe(120);

      // 3. Query requests for group
      const groupRequests =
        PaymentRequestRepository.getRequestsForGroup("grp-real-1");
      expect(groupRequests).toHaveLength(1);
      expect(groupRequests[0]).toMatchObject({
        id: created.request.id,
        name: "مذكرة الباب الأول",
        amount: 120,
        totalObligationsCount: 2,
        paidCount: 0,
        unpaidCount: 2,
      });

      // 4. Verify student financial status includes the obligation
      const stu1FinBefore =
        FinancialCalculationService.getStudentFinancialStatus("stu-real-1");
      expect(stu1FinBefore.paymentRequestsRemainingDebt).toBe(120);

      // 5. Collect payment for student 1
      const detailsBefore = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      const stu1Obligation = detailsBefore.obligations.find(
        (o) => o.studentId === "stu-real-1",
      )!;
      const paymentEvent =
        await PaymentRequestRepository.recordObligationPayment({
          obligationId: stu1Obligation.id,
          paymentMethod: "cash",
        });
      expect(paymentEvent.id).toBeTruthy();

      // 6. Verify statistics on real SQLite
      const statsAfterPay = PaymentRequestRepository.getRequestStatistics(
        created.request.id,
      );
      expect(statsAfterPay).toMatchObject({
        totalStudents: 2,
        paidStudentsCount: 1,
        unpaidStudentsCount: 1,
        totalCollectedAmount: 120,
        totalOutstandingAmount: 120,
        collectionPercentage: 50,
      });

      // 7. Reverse the payment and verify statistics revert accurately
      await PaymentRepository.reversePayment({
        paymentId: paymentEvent.id,
        reason: "إلغاء تجريبي",
      });
      const statsAfterReversal = PaymentRequestRepository.getRequestStatistics(
        created.request.id,
      );
      expect(statsAfterReversal).toMatchObject({
        totalStudents: 2,
        paidStudentsCount: 0,
        unpaidStudentsCount: 2,
        totalCollectedAmount: 0,
        totalOutstandingAmount: 240,
        collectionPercentage: 0,
      });
    } finally {
      real.close();
    }
  });

  test("5. Existing migration versions (1..33) remain intact in schema_migrations and PRAGMA user_version", () => {
    const real = createRealSqliteDatabase();
    try {
      const db = real.adapter;
      DatabaseService.runMigrations(db);

      const applied = db.getAllSync<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version ASC",
      );

      // Versions 1 through 33 must all be present in exact order
      expect(applied.length).toBeGreaterThanOrEqual(33);
      for (let v = 1; v <= 33; v++) {
        expect(applied[v - 1].version).toBe(v);
      }
      expect(applied[32]).toEqual({
        version: 33,
        name: "group_payment_requests_and_obligations",
      });

      const pragmaRow = db.getFirstSync<{ user_version: number }>(
        "PRAGMA user_version",
      );
      expect(pragmaRow?.user_version).toBeGreaterThanOrEqual(33);
    } finally {
      real.close();
    }
  });

  test("6. Payment Requests data is strictly center-isolated in real SQLite", async () => {
    const real = createRealSqliteDatabase();
    try {
      const db = real.adapter;
      DatabaseService.runMigrations(db);
      DatabaseService.ensurePaymentRequestsSchema(db);

      (DatabaseService as any).db = db;
      (DatabaseService as any).initializedDbInstance = db;
      (DatabaseService as any).initializedMigrationVersion = 33;

      // Seed two centers with their own groups and students
      seedCenterGraph(db, {
        centerId: "center-1",
        teacherId: "t-c1",
        subjectId: "sub-c1",
        groupId: "grp-c1",
        groupName: "مجموعة سنتر 1",
        students: [{ id: "stu-c1", code: "3001", name: "طالب سنتر 1" }],
      });
      seedCenterGraph(db, {
        centerId: "center-2",
        teacherId: "t-c2",
        subjectId: "sub-c2",
        groupId: "grp-c2",
        groupName: "مجموعة سنتر 2",
        students: [{ id: "stu-c2", code: "3002", name: "طالب سنتر 2" }],
      });

      // Act as Center 1 owner and create a request
      useAuthStore.setState({
        currentUser: { ...OWNER_CENTER_1, centerId: "center-1" },
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });
      const c1Req = await PaymentRequestRepository.createRequest({
        groupId: "grp-c1",
        name: "ملزمة سنتر 1",
        amount: 90,
      });

      // Switch to Center 2
      useAuthStore.setState({
        currentUser: { ...OWNER_CENTER_1, centerId: "center-2" },
        activeCenterId: "center-2",
        isAuthenticated: true,
        isLoading: false,
      });
      await PaymentRequestRepository.createRequest({
        groupId: "grp-c2",
        name: "ملزمة سنتر 2",
        amount: 140,
      });

      // Center 2 cannot see Center 1 groups or requests
      const c2Groups = PaymentRequestRepository.getGroupsWithStudentCounts();
      expect(c2Groups.map((g) => g.id)).toEqual(["grp-c2"]);

      expect(() =>
        PaymentRequestRepository.getRequestsForGroup("grp-c1"),
      ).toThrow();
      expect(() =>
        PaymentRequestRepository.getRequestDetails(c1Req.request.id),
      ).toThrow();

      // Student balances are isolated by center
      const stu2StatusInC2 =
        FinancialCalculationService.getStudentFinancialStatus("stu-c2");
      expect(stu2StatusInC2.paymentRequestsRemainingDebt).toBe(140);

      const stu1StatusInC2 =
        FinancialCalculationService.getStudentFinancialStatus("stu-c1");
      expect(stu1StatusInC2.paymentRequestsRemainingDebt).toBe(0);

      useAuthStore.setState({
        currentUser: { ...OWNER_CENTER_1, centerId: "center-1" },
        activeCenterId: "center-1",
        isAuthenticated: true,
        isLoading: false,
      });
      const stu1StatusInC1 =
        FinancialCalculationService.getStudentFinancialStatus("stu-c1");
      expect(stu1StatusInC1.paymentRequestsRemainingDebt).toBe(90);
    } finally {
      real.close();
    }
  });
});

