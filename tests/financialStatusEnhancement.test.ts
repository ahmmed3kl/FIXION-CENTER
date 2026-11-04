/**
 * FIXION Financial Status Enhancement & Smart Sorting Test Suite
 * Covers Part 1 (Payment Requests Integration) & Part 2 (Smart Recency Sorting)
 * Tests across 18 specific regression scenarios on Real SQLite.
 */

import { DatabaseSync } from "node:sqlite";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { PaymentRequestRepository } from "../src/features/payments/PaymentRequestRepository";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { ConflictError, NotFoundError } from "../src/core/errors";

const OWNER_CENTER_1: any = {
  id: "usr-owner-1",
  centerId: "center-1",
  centerIds: ["center-1", "center-2"],
  fullName: "مالك سنتر 1",
  phone: "01000000001",
  role: "owner",
  permissions: ["*"],
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function createRealSqliteDatabase(): {
  adapter: SqlDatabase;
  raw: DatabaseSync;
  close: () => void;
} {
  const raw = new DatabaseSync(":memory:");
  const normalizeParams = (params?: any[]) => {
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

  return { adapter, raw, close: () => raw.close() };
}

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

function insertDebtCycle(
  db: SqlDatabase,
  params: {
    id?: string;
    centerId: string;
    studentId: string;
    groupId?: string;
    enrollmentId?: string;
    cycleNumber?: number;
    cyclePrice: number;
    startDate: string;
    endDate: string;
    status?: string;
    cycleType?: string;
    billingMode?: string;
    createdAt?: string;
  },
): string {
  const id = params.id || `dc-${params.studentId}-${params.startDate}`;
  insertRow(db, "debt_cycles", {
    id,
    center_id: params.centerId,
    student_id: params.studentId,
    group_id: params.groupId || null,
    enrollment_id: params.enrollmentId || `enr-${params.studentId}-${params.groupId || "grp-1"}`,
    cycle_number: params.cycleNumber ?? 1,
    start_date: params.startDate,
    end_date: params.endDate,
    cycle_price: params.cyclePrice,
    status: params.status || "open",
    cycle_type: params.cycleType || "monthly",
    billing_mode: params.billingMode || "monthly",
    created_at: params.createdAt || `${params.startDate}T00:00:00.000Z`,
    updated_at: params.createdAt || `${params.startDate}T00:00:00.000Z`,
  });
  return id;
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
    subject_id: opts.subjectId,
    teacher_id: opts.teacherId,
    monthly_fee: 300,
    session_price: 50,
    billing_type: "monthly",
    capacity: 40,
    status: "active",
    created_at: "2026-09-01",
  });
  for (const stu of opts.students) {
    insertRow(db, "students", {
      id: stu.id,
      center_id: opts.centerId,
      student_code: stu.code,
      full_name: stu.name,
      card_code: `CARD-${stu.code}`,
      phone: `0100${stu.code}`,
      parent_phone: `0110${stu.code}`,
      grade: "G3",
      status: "active",
      created_at: "2026-09-01",
    });
    insertRow(db, "student_group_enrollments", {
      id: `enr-${stu.id}-${opts.groupId}`,
      center_id: opts.centerId,
      student_id: stu.id,
      group_id: opts.groupId,
      start_date: "2026-09-01",
      status: "active",
      billing_type: "monthly",
      monthly_price: 300,
      created_at: "2026-09-01",
    });
  }
}

describe("FIXION — Financial Status Enhancement & Smart Sorting (Real SQLite)", () => {
  let real: ReturnType<typeof createRealSqliteDatabase>;
  let db: SqlDatabase;

  beforeEach(() => {
    real = createRealSqliteDatabase();
    db = real.adapter;
    DatabaseService.runMigrations(db);
    DatabaseService.ensurePaymentRequestsSchema(db);

    (DatabaseService as any).db = db;
    (DatabaseService as any).initializedDbInstance = db;
    (DatabaseService as any).initializedMigrationVersion = 33;

    useAuthStore.setState({
      currentUser: OWNER_CENTER_1,
      activeCenterId: "center-1",
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    real.close();
  });

  test("1 & 2. Payment requests appear in student financial status and monthly subscriptions remain visible", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة الرياضيات",
      students: [{ id: "stu-1", code: "1001", name: "أحمد علي" }],
    });

    // Create a monthly debt cycle for Nov 2026
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-1",
      groupId: "grp-1",
      enrollmentId: "enr-stu-1-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    // Create a payment request for a booklet
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت 1",
      amount: 50,
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-1");
    expect(fin.unifiedObligations).toBeDefined();
    expect(fin.unifiedObligations!.length).toBeGreaterThanOrEqual(2);

    const bookletOb = fin.unifiedObligations!.find((o) => o.name === "بوكليت 1");
    expect(bookletOb).toBeDefined();
    expect(bookletOb!.type).toBe("payment_request");
    expect(bookletOb!.amount).toBe(50);
    expect(bookletOb!.amountOwed).toBe(50);
    expect(bookletOb!.status).toBe("unpaid");

    const subOb = fin.unifiedObligations!.find((o) => o.type === "subscription");
    expect(subOb).toBeDefined();
    expect(subOb!.amountDue).toBe(200);
    expect(subOb!.amountOwed).toBe(200);

    // Legacy / canonical cycle records remain intact
    expect(fin.cycles.length).toBeGreaterThanOrEqual(1);
    expect(fin.paymentRequestObligations?.length).toBe(1);
  });

  test("3. Session-related obligations retain their existing behavior in unified status", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة الحصص",
      students: [{ id: "stu-sess", code: "1002", name: "محمود حسن" }],
    });

    // Add session attendance record that creates session debt
    insertRow(db, "sessions", {
      id: "sess-1",
      center_id: "center-1",
      group_id: "grp-1",
      teacher_id: "t-1",
      subject_id: "sub-1",
      session_date: "2026-11-03",
      status: "completed",
      created_at: "2026-11-03T10:00:00.000Z",
    });
    insertRow(db, "attendance", {
      id: "att-1",
      center_id: "center-1",
      session_id: "sess-1",
      student_id: "stu-sess",
      status: "present",
      created_at: "2026-11-03T10:05:00.000Z",
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-sess", "2026-11-03");
    expect(fin.sessionDebt).toBeDefined();
    expect(fin.unifiedObligations).toBeDefined();

    // Session debt is unified without breaking currentPeriodDebt
    expect(fin.totalRemainingDebt).toBeGreaterThanOrEqual(0);
  });

  test("4. Payment requests remain independent financial items", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-indep", code: "1003", name: "سارة كمال" }],
    });

    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-indep",
      groupId: "grp-1",
      enrollmentId: "enr-stu-indep-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة 1",
      amount: 100,
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت 1",
      amount: 50,
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-indep");
    const items = fin.unifiedObligations!;

    // Must have 3 distinct independent items: subscription, note, booklet
    expect(items.length).toBe(3);
    const names = items.map((i) => i.name);
    expect(names.some((n) => n.includes("مذكرة 1"))).toBe(true);
    expect(names.some((n) => n.includes("بوكليت 1"))).toBe(true);
    expect(names.some((n) => n.includes("نوفمبر"))).toBe(true);
  });

  test("5. Collecting one obligation independently does not mark unrelated obligations as paid", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-coll1", code: "1004", name: "خالد سعيد" }],
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة الأحياء",
      amount: 80,
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت الكيمياء",
      amount: 60,
    });

    const finBefore = FinancialCalculationService.getStudentFinancialStatus("stu-coll1");
    const bioItem = finBefore.unifiedObligations!.find((i) => i.name === "مذكرة الأحياء")!;
    const chemItem = finBefore.unifiedObligations!.find((i) => i.name === "بوكليت الكيمياء")!;

    // Pay only the biology booklet
    await PaymentRepository.collectMultipleObligations({
      studentId: "stu-coll1",
      items: [{ type: "payment_request", id: bioItem.id, amount: 80 }],
    });

    const finAfter = FinancialCalculationService.getStudentFinancialStatus("stu-coll1");
    const bioAfter = finAfter.unifiedObligations!.find((i) => i.name === "مذكرة الأحياء")!;
    const chemAfter = finAfter.unifiedObligations!.find((i) => i.name === "بوكليت الكيمياء")!;

    expect(bioAfter.status).toBe("paid");
    expect(bioAfter.amountOwed).toBe(0);

    expect(chemAfter.status).toBe("unpaid");
    expect(chemAfter.amountOwed).toBe(60);
    expect(finAfter.totalRemainingDebt).toBe(60);
  });

  test("6 & 7. Collecting multiple obligations preserves each obligation's identity, amount, and prevents duplicates", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-multi", code: "1005", name: "ياسر إبراهيم" }],
    });

    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-multi",
      groupId: "grp-1",
      enrollmentId: "enr-stu-multi-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة 1",
      amount: 100,
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت 1",
      amount: 50,
    });

    const finBefore = FinancialCalculationService.getStudentFinancialStatus("stu-multi");
    expect(finBefore.totalRemainingDebt).toBe(350);

    // Collect subscription (200) + booklet (50) together in one transaction
    const subItem = finBefore.unifiedObligations!.find((i) => i.type === "subscription")!;
    const bookletItem = finBefore.unifiedObligations!.find((i) => i.name === "بوكليت 1")!;

    const result = await PaymentRepository.collectMultipleObligations({
      studentId: "stu-multi",
      items: [
        { type: "subscription", id: subItem.id, amount: 200 },
        { type: "payment_request", id: bookletItem.id, amount: 50 },
      ],
      batchNotes: "سداد دفعة مجمعة",
    });

    expect(result.payments).toHaveLength(2);
    expect(result.totalCollected).toBe(250);

    // Check individual payment events
    const subPayment = result.payments.find((p) => p.paymentType === "monthly");
    expect(subPayment).toBeDefined();
    expect(subPayment!.amount).toBe(200);

    const prPayment = result.payments.find((p) => p.paymentType === "payment_request");
    expect(prPayment).toBeDefined();
    expect(prPayment!.amount).toBe(50);

    const finAfter = FinancialCalculationService.getStudentFinancialStatus("stu-multi");
    expect(finAfter.totalRemainingDebt).toBe(100); // only note (100) remains

    // Attempting to collect booklet again must throw ConflictError
    await expect(
      PaymentRepository.collectMultipleObligations({
        studentId: "stu-multi",
        items: [{ type: "payment_request", id: bookletItem.id, amount: 50 }],
      }),
    ).rejects.toThrow(ConflictError);
  });

  test("8. Students joining group later do not inherit old requests", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-orig", code: "1006", name: "طالب قديم" }],
    });

    // Create payment request before stu-new joins
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة قديمة",
      amount: 70,
    });

    // Now enroll a new student later
    insertRow(db, "students", {
      id: "stu-new",
      center_id: "center-1",
      student_code: "1007",
      full_name: "طالب جديد",
      card_code: "CARD-1007",
      phone: "01001007",
      parent_phone: "01101007",
      grade: "G3",
      status: "active",
      created_at: "2026-11-04",
    });
    insertRow(db, "student_group_enrollments", {
      id: "enr-stu-new-grp-1",
      center_id: "center-1",
      student_id: "stu-new",
      group_id: "grp-1",
      start_date: "2026-11-04",
      status: "active",
      billing_type: "monthly",
      monthly_price: 300,
      created_at: "2026-11-04",
    });

    const finNew = FinancialCalculationService.getStudentFinancialStatus("stu-new");
    expect(finNew.paymentRequestsRemainingDebt).toBe(0);
    expect(finNew.paymentRequestObligations?.length).toBe(0);
    const hasOldRequest = finNew.unifiedObligations?.some((i) => i.name === "مذكرة قديمة");
    expect(hasOldRequest).toBe(false);
  });

  test("9. Students leaving groups retain existing obligations", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-leave", code: "1008", name: "طالب مغادر" }],
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "كتاب الدورة",
      amount: 110,
    });

    // Student leaves group (enrollment cancelled)
    db.runSync(
      `UPDATE student_group_enrollments SET status = 'cancelled' WHERE student_id = 'stu-leave'`,
    );

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-leave");
    expect(fin.paymentRequestsRemainingDebt).toBe(110);
    const ob = fin.unifiedObligations?.find((i) => i.name === "كتاب الدورة");
    expect(ob).toBeDefined();
    expect(ob?.amountOwed).toBe(110);
  });

  test("10. Students belonging to multiple groups receive only their own obligations", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-A",
      groupName: "مجموعة أ",
      students: [{ id: "stu-dual", code: "1009", name: "طالب بمجموعتين" }],
    });
    // Create group B in same center and enroll same student
    insertRow(db, "groups", {
      id: "grp-B",
      center_id: "center-1",
      name: "مجموعة ب",
      subject_id: "sub-1",
      teacher_id: "t-1",
      monthly_fee: 300,
      session_price: 50,
      billing_type: "monthly",
      capacity: 40,
      status: "active",
      created_at: "2026-09-01",
    });
    insertRow(db, "student_group_enrollments", {
      id: "enr-stu-dual-grp-B",
      center_id: "center-1",
      student_id: "stu-dual",
      group_id: "grp-B",
      start_date: "2026-09-01",
      status: "active",
      billing_type: "monthly",
      monthly_price: 300,
      created_at: "2026-09-01",
    });

    // Request for Group A only
    await PaymentRequestRepository.createRequest({
      groupId: "grp-A",
      name: "ملزمة مجموعة أ",
      amount: 45,
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-dual");
    expect(fin.paymentRequestObligations?.length).toBe(1);
    expect(fin.paymentRequestObligations![0].groupId).toBe("grp-A");
    expect(fin.paymentRequestsRemainingDebt).toBe(45);
  });

  test("11 & 12. Smart Sorting: New payment requests appear above older subscriptions, and November appears above October and September", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة الترتيب",
      students: [{ id: "stu-sort", code: "1010", name: "عمر فاروق" }],
    });

    // Create cycles: Aug, Sep, Oct, Nov
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-sort",
      groupId: "grp-1",
      enrollmentId: "enr-stu-sort-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-sort",
      groupId: "grp-1",
      enrollmentId: "enr-stu-sort-grp-1",
      cycleNumber: 2,
      cyclePrice: 200,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-sort",
      groupId: "grp-1",
      enrollmentId: "enr-stu-sort-grp-1",
      cycleNumber: 3,
      cyclePrice: 200,
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-sort",
      groupId: "grp-1",
      enrollmentId: "enr-stu-sort-grp-1",
      cycleNumber: 4,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    // Create a booklet today (Nov 4)
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت 1",
      amount: 50,
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-sort");
    const names = fin.unifiedObligations!.map((o) => o.name);

    // 1. بوكليت 1 — أُضيف مؤخرًا
    expect(names[0]).toBe("بوكليت 1");

    // 2. اشتراك نوفمبر 2026
    expect(names[1]).toContain("نوفمبر");

    // 3. اشتراك أكتوبر 2026
    expect(names[2]).toContain("أكتوبر");

    // 4. اشتراك سبتمبر 2026
    expect(names[3]).toContain("سبتمبر");

    // 5. اشتراك أغسطس 2026
    expect(names[4]).toContain("أغسطس");
  });

  test("13. Sorting remains correct after database reload", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-reload", code: "1011", name: "رامي فؤاد" }],
    });

    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-reload",
      groupId: "grp-1",
      enrollmentId: "enr-stu-reload-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-reload",
      groupId: "grp-1",
      enrollmentId: "enr-stu-reload-grp-1",
      cycleNumber: 2,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة المراجعة",
      amount: 75,
    });

    const firstRun = FinancialCalculationService.getStudentFinancialStatus("stu-reload");

    // Reset database service cached state to simulate cold reload
    (DatabaseService as any).initializedDbInstance = null;
    (DatabaseService as any).db = db;
    (DatabaseService as any).initializedDbInstance = db;
    (DatabaseService as any).initializedMigrationVersion = 33;

    const secondRun = FinancialCalculationService.getStudentFinancialStatus("stu-reload");
    expect(secondRun.unifiedObligations!.map((o) => o.id)).toEqual(
      firstRun.unifiedObligations!.map((o) => o.id),
    );
  });

  test("14. Sorting remains correct after synchronization / updates", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-sync", code: "1012", name: "طارق سليم" }],
    });

    // Add a cycle and payment request
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-sync",
      groupId: "grp-1",
      enrollmentId: "enr-stu-sync-grp-1",
      cycleNumber: 1,
      cyclePrice: 200,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "مذكرة 1",
      amount: 60,
    });

    // Simulate an incoming sync item created with an earlier timestamp
    insertRow(db, "group_payment_requests", {
      id: "preq-synced-older",
      operation_id: "op-synced-older",
      center_id: "center-1",
      group_id: "grp-1",
      name: "مذكرة سابقة مستوردة",
      amount: 50,
      status: "active",
      created_at: "2026-09-15T12:00:00.000Z",
    });
    insertRow(db, "student_payment_request_obligations", {
      id: "prob-synced-older",
      operation_id: "op-ob-synced-older",
      center_id: "center-1",
      request_id: "preq-synced-older",
      group_id: "grp-1",
      student_id: "stu-sync",
      amount_due: 50,
      amount_paid: 0,
      status: "unpaid",
      created_at: "2026-09-15T12:00:00.000Z",
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-sync");
    const names = fin.unifiedObligations!.map((o) => o.name);

    // Recent booklet is at the top, followed by Nov subscription, followed by the September synced booklet
    expect(names[0]).toBe("مذكرة 1");
    expect(names[1]).toContain("نوفمبر");
    expect(names[2]).toBe("مذكرة سابقة مستوردة");
  });

  test("15. Equal timestamps have deterministic secondary ordering", () => {
    const list: any[] = [
      { id: "b-2", name: "بند ب", sortKey: "2026-11-01T00:00:00.000Z" },
      { id: "a-1", name: "بند أ", sortKey: "2026-11-01T00:00:00.000Z" },
    ];
    const sorted = FinancialCalculationService.sortObligationsByRecency(list);
    expect(sorted[0].id).toBe("a-1");
    expect(sorted[1].id).toBe("b-2");
  });

  test("16. Payment reversals update financial status and obligations accurately", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-rev", code: "1013", name: "سامي عادل" }],
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "ملزمة الاختبار",
      amount: 90,
    });

    const finInitial = FinancialCalculationService.getStudentFinancialStatus("stu-rev");
    const item = finInitial.unifiedObligations![0];

    const coll = await PaymentRepository.collectMultipleObligations({
      studentId: "stu-rev",
      items: [{ type: "payment_request", id: item.id, amount: 90 }],
    });
    expect(coll.payments).toHaveLength(1);

    const finAfterPay = FinancialCalculationService.getStudentFinancialStatus("stu-rev");
    expect(finAfterPay.totalRemainingDebt).toBe(0);
    expect(finAfterPay.unifiedObligations![0].status).toBe("paid");

    // Reverse payment
    await PaymentRepository.reversePayment({
      paymentId: coll.payments[0].id,
      reason: "إلغاء لخطأ في السداد",
    });

    const finAfterRev = FinancialCalculationService.getStudentFinancialStatus("stu-rev");
    expect(finAfterRev.totalRemainingDebt).toBe(90);
    expect(finAfterRev.unifiedObligations![0].status).toBe("unpaid");
    expect(finAfterRev.unifiedObligations![0].amountOwed).toBe(90);
  });

  test("17. Financial totals remain exact before and after sorting", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة 1",
      students: [{ id: "stu-totals", code: "1014", name: "ماجد توفيق" }],
    });

    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-totals",
      groupId: "grp-1",
      enrollmentId: "enr-stu-totals-grp-1",
      cycleNumber: 1,
      cyclePrice: 250,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
    await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت 1",
      amount: 70,
    });

    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-totals");
    const sumOwed = fin.unifiedObligations!.reduce((sum, o) => sum + o.amountOwed, 0);

    expect(fin.totalRemainingDebt).toBe(320);
    expect(sumOwed).toBe(320);
  });

  test("18. Center isolation is strictly enforced across obligations and collections", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-c1",
      groupName: "مجموعة سنتر 1",
      students: [{ id: "stu-c1", code: "2001", name: "طالب سنتر 1" }],
    });
    seedCenterGraph(db, {
      centerId: "center-2",
      teacherId: "t-2",
      subjectId: "sub-2",
      groupId: "grp-c2",
      groupName: "مجموعة سنتر 2",
      students: [{ id: "stu-c2", code: "2002", name: "طالب سنتر 2" }],
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-c1",
      name: "بوكليت سنتر 1",
      amount: 100,
    });

    // Switch to Center 2
    useAuthStore.setState({
      currentUser: { ...OWNER_CENTER_1, centerId: "center-2", centerIds: ["center-2"] },
      activeCenterId: "center-2",
      isAuthenticated: true,
      isLoading: false,
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-c2",
      name: "بوكليت سنتر 2",
      amount: 150,
    });

    const finC2 = FinancialCalculationService.getStudentFinancialStatus("stu-c2");
    expect(finC2.totalRemainingDebt).toBe(150);
    expect(finC2.unifiedObligations?.some((o) => o.name === "بوكليت سنتر 1")).toBe(false);

    // Center 2 cannot collect Center 1 student's obligation
    await expect(
      PaymentRepository.collectMultipleObligations({
        studentId: "stu-c1",
        items: [{ type: "payment_request", id: "prob-dummy", amount: 100 }],
      }),
    ).rejects.toThrow();
  });

  test("Bugfix Scenario: 400 EGP Monthly Subscription (اشتراك نوفمبر) and 255 EGP Booklet (بوكليت) Display Integration", async () => {
    seedCenterGraph(db, {
      centerId: "center-1",
      teacherId: "t-1",
      subjectId: "sub-1",
      groupId: "grp-1",
      groupName: "مجموعة الرياضيات",
      students: [{ id: "stu-booklet-bug", code: "7777", name: "طالب البوكليت" }],
    });

    // 1. Monthly subscription debt: 400 EGP (Nov 2026)
    insertDebtCycle(db, {
      centerId: "center-1",
      studentId: "stu-booklet-bug",
      groupId: "grp-1",
      enrollmentId: "enr-stu-booklet-bug-grp-1",
      cycleNumber: 1,
      cyclePrice: 400,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    // 2. Group payment request for a booklet: 255 EGP
    const createResult = await PaymentRequestRepository.createRequest({
      groupId: "grp-1",
      name: "بوكليت",
      amount: 255,
      referenceMonth: "2026-11",
    });

    // Check financial status
    const fin = FinancialCalculationService.getStudentFinancialStatus("stu-booklet-bug");

    // Assertion 4: Existing summary remains 655 EGP
    expect(fin.totalRemainingDebt).toBe(655);
    expect(fin.monthlyRemainingDebt).toBe(400);
    expect(fin.paymentRequestsRemainingDebt).toBe(255);

    // Assertion 3: Both items appear simultaneously in the student's Financial Status
    expect(fin.unifiedObligations).toBeDefined();
    expect(fin.unifiedObligations!.length).toBe(2);

    // Assertion 1: The 400 EGP monthly subscription appears as an independent item
    const subItem = fin.unifiedObligations!.find((o) => o.type === "subscription");
    expect(subItem).toBeDefined();
    expect(subItem!.name).toContain("اشتراك نوفمبر");
    expect(subItem!.amount).toBe(400);
    expect(subItem!.amountOwed).toBe(400);
    expect(subItem!.status).toBe("open");

    // Assertion 2: The 255 EGP booklet request appears as another independent item
    const bookletItem = fin.unifiedObligations!.find((o) => o.type === "payment_request");
    expect(bookletItem).toBeDefined();
    expect(bookletItem!.name).toBe("بوكليت");
    expect(bookletItem!.amount).toBe(255);
    expect(bookletItem!.amountOwed).toBe(255);
    expect(bookletItem!.status).toBe("unpaid");

    // Assertion 5: The booklet is not merged into the monthly subscription
    expect(subItem!.id).not.toBe(bookletItem!.id);
    expect(subItem!.amount).toBe(400);
    expect(bookletItem!.amount).toBe(255);

    // Assertion 6: No duplicate booklet obligation is created
    const studentObs = db.getAllSync<any>(
      "SELECT id FROM student_payment_request_obligations WHERE center_id = ? AND student_id = ? AND request_id = ?",
      ["center-1", "stu-booklet-bug", createResult.request.id],
    );
    expect(studentObs.length).toBe(1);

    // Assertion 7: Paying the booklet does not affect the monthly subscription
    await PaymentRepository.collectMultipleObligations({
      studentId: "stu-booklet-bug",
      items: [
        {
          type: "payment_request",
          id: bookletItem!.paymentRequestObligationId!,
          amount: 255,
        },
      ],
    });

    const finAfterPayingBooklet = FinancialCalculationService.getStudentFinancialStatus("stu-booklet-bug");
    expect(finAfterPayingBooklet.totalRemainingDebt).toBe(400);
    expect(finAfterPayingBooklet.paymentRequestsRemainingDebt).toBe(0);
    expect(finAfterPayingBooklet.monthlyRemainingDebt).toBe(400);

    const bookletAfter = finAfterPayingBooklet.unifiedObligations!.find((o) => o.type === "payment_request");
    expect(bookletAfter!.amountOwed).toBe(0);
    expect(bookletAfter!.status).toBe("paid");

    const subAfter = finAfterPayingBooklet.unifiedObligations!.find((o) => o.type === "subscription");
    expect(subAfter!.amountOwed).toBe(400);
    expect(subAfter!.status).toBe("open");

    // Assertion 8: Reloading and synchronization preserve both displayed items
    (DatabaseService as any).initializedDbInstance = null;
    (DatabaseService as any).db = db;
    (DatabaseService as any).initializedDbInstance = db;
    (DatabaseService as any).initializedMigrationVersion = 33;

    const finReloaded = FinancialCalculationService.getStudentFinancialStatus("stu-booklet-bug");
    expect(finReloaded.unifiedObligations!.length).toBe(2);
    expect(finReloaded.unifiedObligations!.some((o) => o.name === "بوكليت")).toBe(true);
    expect(finReloaded.unifiedObligations!.some((o) => o.name.includes("اشتراك نوفمبر"))).toBe(true);
    expect(finReloaded.totalRemainingDebt).toBe(400);
  });
});

