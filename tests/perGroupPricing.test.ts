/**
 * FIXION — Per-Group Student Monthly Pricing Test Suite
 * Covers 12 specific regression test scenarios on Real SQLite.
 */

import { DatabaseSync } from "node:sqlite";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { PaymentRequestRepository } from "../src/features/payments/PaymentRequestRepository";

const OWNER_CENTER_1: any = {
  id: "usr-owner-1",
  centerId: "center-1",
  centerIds: ["center-1"],
  fullName: "مالك السنتر",
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
        changes: Number(res.changes),
        lastInsertRowId: Number(res.lastInsertRowid),
      };
    },
    getAllSync<T>(sql: string, params?: any[]): T[] {
      const stmt = raw.prepare(sql);
      return stmt.all(...normalizeParams(params)) as T[];
    },
    getFirstSync<T>(sql: string, params?: any[]): T | null {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...normalizeParams(params));
      return (row as T) || null;
    },
  };

  return {
    adapter,
    raw,
    close: () => {
      try {
        raw.close();
      } catch {}
    },
  };
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

function seedGroup(db: SqlDatabase, id: string, name: string, subjectId: string, price: number) {
  insertRow(db, "groups", {
    id,
    center_id: "center-1",
    name,
    teacher_id: "tea-1",
    subject_id: subjectId,
    grade: "G3",
    monthly_price: price,
    default_fee: price,
    status: "active",
    created_at: "2026-09-01",
  });
}

function seedSchedule(db: SqlDatabase, id: string, groupId: string, dayOfWeek = 2) {
  insertRow(db, "group_schedules", {
    id,
    center_id: "center-1",
    group_id: groupId,
    day_of_week: dayOfWeek,
    start_time: "14:00",
    end_time: "16:00",
    status: "active",
    created_at: "2026-09-01",
  });
}

function seedStudent(db: SqlDatabase, id: string, code: string, name: string) {
  insertRow(db, "students", {
    id,
    center_id: "center-1",
    student_code: code,
    full_name: name,
    card_code: `CARD-${code}`,
    phone: `01011111${code}`,
    parent_phone: `01022222${code}`,
    grade: "G3",
    status: "active",
    created_at: "2026-09-01",
  });
}

describe("FIXION — Per-Group Student Monthly Pricing (Regular / Discounted / Free)", () => {
  let realDb: ReturnType<typeof createRealSqliteDatabase>;

  beforeEach(() => {
    realDb = createRealSqliteDatabase();
    (DatabaseService as any).db = realDb.adapter;
    (DatabaseService as any).initializedDbInstance = realDb.adapter;
    (DatabaseService as any).initializedMigrationVersion = 34;
    DatabaseService.runMigrations(realDb.adapter);
    DatabaseService.ensurePaymentRequestsSchema(realDb.adapter);

    useAuthStore.setState({
      currentUser: OWNER_CENTER_1,
      activeCenterId: "center-1",
      isAuthenticated: true,
      isLoading: false,
    });

    // Seed center, teacher, subject using insertRow
    insertRow(realDb.adapter, "centers", {
      id: "center-1",
      name: "السنتر الرئيسي",
      code: "C1",
      time_zone: "Africa/Cairo",
    });
    insertRow(realDb.adapter, "teachers", {
      id: "tea-1",
      center_id: "center-1",
      name: "أستاذ أحمد",
      status: "active",
      created_at: "2026-09-01",
    });
    insertRow(realDb.adapter, "subjects", {
      id: "sub-math",
      center_id: "center-1",
      name: "رياضيات",
      code: "MATH",
      status: "active",
      created_at: "2026-09-01",
    });
    insertRow(realDb.adapter, "subjects", {
      id: "sub-phy",
      center_id: "center-1",
      name: "فيزياء",
      code: "PHY",
      status: "active",
      created_at: "2026-09-01",
    });
  });

  afterEach(() => {
    realDb.close();
  });

  test("1. Regular student uses the normal group price", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-regular", "101", "طالب منتظم");

    // Enroll with no special monthly price specified (or equal to normal price: 400)
    const enrollment = EnrollmentRepository.enrollStudent({
      studentId: "stu-regular",
      groupId: "grp-math",
      startDate: "2026-09-01",
    });

    expect(enrollment.specialMonthlyPrice).toBe(400);

    // Generate financial status
    const status = FinancialCalculationService.getStudentFinancialStatus("stu-regular", "2026-09-01");

    expect(status.cycles).toHaveLength(1);
    expect(status.cycles[0].cyclePrice).toBe(400);
    expect(status.cycles[0].remainingDebt).toBe(400);
    expect(status.cycles[0].status).toBe("open");
    expect(status.totalRemainingDebt).toBe(400);
  });

  test("2. Discounted student uses the custom amount", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-disc", "102", "طالب مخفض");

    // Enroll with discounted price: 200 EGP
    const enrollment = EnrollmentRepository.enrollStudent({
      studentId: "stu-disc",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });

    expect(enrollment.specialMonthlyPrice).toBe(200);

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-disc", "2026-09-01");

    expect(status.cycles).toHaveLength(1);
    expect(status.cycles[0].cyclePrice).toBe(200);
    expect(status.cycles[0].remainingDebt).toBe(200);
    expect(status.totalRemainingDebt).toBe(200);
  });

  test("3. Free student uses zero", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-free", "103", "طالب مجاني");

    // Enroll with zero (0 EGP)
    const enrollment = EnrollmentRepository.enrollStudent({
      studentId: "stu-free",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 0,
    });

    expect(enrollment.specialMonthlyPrice).toBe(0);

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-free", "2026-09-01");

    expect(status.cycles).toHaveLength(1);
    expect(status.cycles[0].cyclePrice).toBe(0);
    expect(status.cycles[0].remainingDebt).toBe(0);
    expect(status.totalRemainingDebt).toBe(0);
  });

  test("4. One student can have different prices in two groups", () => {
    // Math: normal 400 EGP. Physics: normal 300 EGP.
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedGroup(realDb.adapter, "grp-phy", "مجموعة الفيزياء", "sub-phy", 300);
    seedSchedule(realDb.adapter, "sch-1", "grp-math", 2);
    seedSchedule(realDb.adapter, "sch-2", "grp-phy", 2);
    seedStudent(realDb.adapter, "stu-ahmed", "104", "أحمد");

    // Student Ahmed:
    // - Mathematics group: normal price 400 EGP, student price 200 EGP.
    // - Physics group: normal price 300 EGP, student price 0 EGP.
    const enrMath = EnrollmentRepository.enrollStudent({
      studentId: "stu-ahmed",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });
    const enrPhy = EnrollmentRepository.enrollStudent({
      studentId: "stu-ahmed",
      groupId: "grp-phy",
      startDate: "2026-09-01",
      specialMonthlyPrice: 0,
    });

    expect(enrMath.specialMonthlyPrice).toBe(200);
    expect(enrPhy.specialMonthlyPrice).toBe(0);

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-ahmed", "2026-09-01");

    expect(status.cycles).toHaveLength(2);
    const mathCycle = status.cycles.find((c) => c.groupId === "grp-math");
    const phyCycle = status.cycles.find((c) => c.groupId === "grp-phy");

    expect(mathCycle?.cyclePrice).toBe(200);
    expect(mathCycle?.remainingDebt).toBe(200);
    expect(phyCycle?.cyclePrice).toBe(0);
    expect(phyCycle?.remainingDebt).toBe(0);
    // Total remaining balance is only 200 EGP
    expect(status.totalRemainingDebt).toBe(200);
  });

  test("5. Editing one group amount does not affect another group", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedGroup(realDb.adapter, "grp-phy", "مجموعة الفيزياء", "sub-phy", 300);
    seedSchedule(realDb.adapter, "sch-1", "grp-math", 2);
    seedSchedule(realDb.adapter, "sch-2", "grp-phy", 3);
    seedStudent(realDb.adapter, "stu-multi", "105", "طالب متعدد المجموعات");

    const enrMath = EnrollmentRepository.enrollStudent({
      studentId: "stu-multi",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });
    const enrPhy = EnrollmentRepository.enrollStudent({
      studentId: "stu-multi",
      groupId: "grp-phy",
      startDate: "2026-09-01",
      specialMonthlyPrice: 0,
    });

    // Update Math amount from 200 to 250
    EnrollmentRepository.updateMonthlyPrice(enrMath.id, 250);

    // Verify enrollment records in SQLite
    const enrollments = EnrollmentRepository.getActiveEnrollmentsForStudent("stu-multi");
    const updatedMath = enrollments.find((e) => e.groupId === "grp-math");
    const preservedPhy = enrollments.find((e) => e.groupId === "grp-phy");

    expect(updatedMath?.specialMonthlyPrice).toBe(250);
    expect(preservedPhy?.specialMonthlyPrice).toBe(0);
  });

  test("6. New monthly cycles use the latest enrollment-specific amount", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-future", "106", "طالب دورات مستقبلية");

    const enr = EnrollmentRepository.enrollStudent({
      studentId: "stu-future",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });

    // Initial cycle (cycle 1) generated for September at 200 EGP
    const statusSept = FinancialCalculationService.getStudentFinancialStatus("stu-future", "2026-09-01");
    expect(statusSept.cycles).toHaveLength(1);
    expect(statusSept.cycles[0].cyclePrice).toBe(200);

    // Admin updates amount to 300 EGP
    EnrollmentRepository.updateMonthlyPrice(enr.id, 300);

    // Next month (October) cycle is generated
    const statusOct = FinancialCalculationService.getStudentFinancialStatus("stu-future", "2026-10-01");
    expect(statusOct.cycles).toHaveLength(2);

    const cycle1 = statusOct.cycles.find((c) => c.cycleNumber === 1);
    const cycle2 = statusOct.cycles.find((c) => c.cycleNumber === 2);

    // Cycle 1 retains 200 EGP
    expect(cycle1?.cyclePrice).toBe(200);
    // Cycle 2 receives new 300 EGP amount
    expect(cycle2?.cyclePrice).toBe(300);
  });

  test("7. Existing monthly cycles remain unchanged after editing", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-past", "107", "طالب قديم");

    const enr = EnrollmentRepository.enrollStudent({
      studentId: "stu-past",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });

    const status1 = FinancialCalculationService.getStudentFinancialStatus("stu-past", "2026-09-01");
    const cycle1Id = status1.cycles[0].id;
    expect(status1.cycles[0].cyclePrice).toBe(200);

    // Pay 200 for cycle 1
    PaymentRepository.recordPayment({
      studentId: "stu-past",
      amount: 200,
      paymentType: "monthly",
      debtCycleId: cycle1Id,
    });

    // Update enrollment price to 350
    EnrollmentRepository.updateMonthlyPrice(enr.id, 350);

    // Check financial status again
    const status2 = FinancialCalculationService.getStudentFinancialStatus("stu-past", "2026-09-01");
    const cycle1Refreshed = status2.cycles.find((c) => c.id === cycle1Id);

    // Cycle 1 must remain 200, paid, remainingDebt = 0
    expect(cycle1Refreshed?.cyclePrice).toBe(200);
    expect(cycle1Refreshed?.paidAmount).toBe(200);
    expect(cycle1Refreshed?.remainingDebt).toBe(0);
    expect(cycle1Refreshed?.status).toBe("paid");
  });

  test("8. Free enrollment does not generate a payable monthly debt", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-free2", "108", "طالب مجاني 2");

    EnrollmentRepository.enrollStudent({
      studentId: "stu-free2",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 0,
    });

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-free2", "2026-09-01");

    // Total remaining debt must be 0
    expect(status.monthlyRemainingDebt).toBe(0);
    expect(status.totalRemainingDebt).toBe(0);
    // Outstanding obligations list must have NO payable obligations
    expect(status.outstandingObligations).toHaveLength(0);
  });

  test("9. Payment requests remain at their full independent amounts", async () => {
    // Normal monthly: 400 EGP, Student: 0 EGP (free)
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-free-req", "109", "طالب مجاني ومطلب دفع");

    EnrollmentRepository.enrollStudent({
      studentId: "stu-free-req",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 0,
    });

    // Create payment request for booklet: 255 EGP
    await PaymentRequestRepository.createRequest({
      groupId: "grp-math",
      name: "بوكليت الفصل الأول",
      amount: 255,
      referenceMonth: "2026-09",
    });

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-free-req", "2026-09-01");

    // Monthly debt is 0, Booklet is 255 -> Total: 255 EGP
    expect(status.monthlyRemainingDebt).toBe(0);
    expect(status.paymentRequestsRemainingDebt).toBe(255);
    expect(status.totalRemainingDebt).toBe(255);

    // Outstanding obligations must show booklet obligation at 255 EGP
    expect(status.outstandingObligations).toBeDefined();
    expect(status.outstandingObligations).toHaveLength(1);
    expect(status.outstandingObligations![0].type).toBe("payment_request");
    expect(status.outstandingObligations![0].amountOwed).toBe(255);
  });

  test("10. Discounts never modify booklet or note prices", async () => {
    // Normal monthly: 400 EGP, Student monthly: 200 EGP
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-disc-req", "110", "طالب مخفض وبوكليت");

    EnrollmentRepository.enrollStudent({
      studentId: "stu-disc-req",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 200,
    });

    await PaymentRequestRepository.createRequest({
      groupId: "grp-math",
      name: "بوكليت",
      amount: 255,
      referenceMonth: "2026-09",
    });

    const status = FinancialCalculationService.getStudentFinancialStatus("stu-disc-req", "2026-09-01");

    // Monthly subscription: 200 EGP
    // Booklet: 255 EGP
    // Total: 455 EGP
    expect(status.monthlyRemainingDebt).toBe(200);
    expect(status.paymentRequestsRemainingDebt).toBe(255);
    expect(status.totalRemainingDebt).toBe(455);

    expect(status.outstandingObligations).toBeDefined();
    expect(status.outstandingObligations).toHaveLength(2);
    const monthlyObligation = status.outstandingObligations!.find((o) => o.type === "subscription");
    const bookletObligation = status.outstandingObligations!.find((o) => o.type === "payment_request");

    expect(monthlyObligation?.amountOwed).toBe(200);
    expect(bookletObligation?.amountOwed).toBe(255);
  });

  test("11. Offline synchronization preserves the correct enrollment-specific amounts", () => {
    seedGroup(realDb.adapter, "grp-math", "مجموعة الرياضيات", "sub-math", 400);
    seedSchedule(realDb.adapter, "sch-1", "grp-math");
    seedStudent(realDb.adapter, "stu-sync", "111", "طالب مزامنة");

    const enr = EnrollmentRepository.enrollStudent({
      studentId: "stu-sync",
      groupId: "grp-math",
      startDate: "2026-09-01",
      specialMonthlyPrice: 150,
    });

    // Check sync_operations table contains the CREATE operation with specialMonthlyPrice = 150
    const ops = realDb.adapter.getAllSync<{ entity_type: string; operation_type: string; payload: string }>(
      `SELECT entity_type, operation_type, payload FROM sync_operations WHERE entity_id = ?`,
      [enr.id],
    );

    expect(ops.length).toBeGreaterThanOrEqual(1);
    const createOp = ops.find((op) => op.operation_type === "CREATE");
    expect(createOp).toBeDefined();
    const payload = JSON.parse(createOp!.payload);
    expect(payload.specialMonthlyPrice).toBe(150);

    // Now perform offline update
    EnrollmentRepository.updateMonthlyPrice(enr.id, 0);

    const updateOps = realDb.adapter.getAllSync<{ entity_type: string; operation_type: string; payload: string }>(
      `SELECT entity_type, operation_type, payload FROM sync_operations WHERE entity_id = ? AND operation_type = 'UPDATE'`,
      [enr.id],
    );

    expect(updateOps.length).toBeGreaterThanOrEqual(1);
    const updatePayload = JSON.parse(updateOps[updateOps.length - 1].payload);
    expect(updatePayload.specialMonthlyPrice).toBe(0);
  });

  test("12. Existing student records remain intact after migration", () => {
    // Simulate an existing database before migration 34 by inserting an enrollment with special_monthly_price IS NULL
    seedGroup(realDb.adapter, "grp-legacy", "مجموعة قديمة", "sub-math", 500);
    seedSchedule(realDb.adapter, "sch-leg", "grp-legacy");
    seedStudent(realDb.adapter, "stu-legacy", "112", "طالب قديم موجود مسبقا");

    // Direct insert with special_monthly_price = NULL
    insertRow(realDb.adapter, "student_group_enrollments", {
      id: "enr-legacy-1",
      center_id: "center-1",
      student_id: "stu-legacy",
      group_id: "grp-legacy",
      start_date: "2026-08-01",
      status: "active",
      special_monthly_price: null,
      created_at: "2026-08-01",
    });

    // Existing debt cycle already stored for August at 500 EGP
    insertRow(realDb.adapter, "debt_cycles", {
      id: "dc-legacy-1",
      center_id: "center-1",
      student_id: "stu-legacy",
      enrollment_id: "enr-legacy-1",
      group_id: "grp-legacy",
      cycle_number: 1,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      cycle_price: 500,
      status: "paid",
      cycle_type: "monthly",
      billing_mode: "pending",
      created_at: "2026-08-01",
    });

    // Payment already recorded
    insertRow(realDb.adapter, "payments", {
      id: "pay-legacy-1",
      operation_id: "op-leg-1",
      center_id: "center-1",
      student_id: "stu-legacy",
      debt_cycle_id: "dc-legacy-1",
      amount: 500,
      payment_type: "monthly",
      created_at: "2026-08-05",
      user_id: "usr-owner-1",
    });

    // Now execute migration 34 logic
    realDb.adapter.runSync(`
      UPDATE student_group_enrollments
      SET special_monthly_price = (
        SELECT COALESCE(g.monthly_price, g.default_fee, 0)
        FROM groups g
        WHERE g.id = student_group_enrollments.group_id
          AND g.center_id = student_group_enrollments.center_id
      )
      WHERE special_monthly_price IS NULL;
    `);

    // Verify enrollment now has special_monthly_price = 500
    const row = realDb.adapter.getFirstSync<{ special_monthly_price: number }>(
      `SELECT special_monthly_price FROM student_group_enrollments WHERE id = 'enr-legacy-1'`,
    );
    expect(row?.special_monthly_price).toBe(500);

    // Verify existing cycle and payment remain completely untouched
    const cycleRow = realDb.adapter.getFirstSync<{ cycle_price: number; status: string }>(
      `SELECT cycle_price, status FROM debt_cycles WHERE id = 'dc-legacy-1'`,
    );
    expect(cycleRow?.cycle_price).toBe(500);
    expect(cycleRow?.status).toBe("paid");

    const paymentRow = realDb.adapter.getFirstSync<{ amount: number }>(
      `SELECT amount FROM payments WHERE id = 'pay-legacy-1'`,
    );
    expect(paymentRow?.amount).toBe(500);
  });
});
