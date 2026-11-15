import * as fs from "fs";
import * as path from "path";
import { DatabaseService } from "../src/core/database";
import { SyncEngine } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import {
  getCairoTodayDateOnly,
  PaymentStatisticsService,
} from "../src/features/payments/PaymentStatisticsService";

describe("Payment Statistics (إحصائيات الدفع)", () => {
  beforeEach(async () => {
    jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "idle",
    } as any);
    DatabaseService.init();
    await useAuthStore.getState().logout();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function seedPaymentStatisticsScenario() {
    const db = DatabaseService.getDb();

    db.runSync(
      `INSERT OR IGNORE INTO subjects (id, center_id, name, status)
       VALUES ('sub-ps', 'center-1', 'الرياضيات', 'active')`,
    );
    db.runSync(
      `INSERT OR IGNORE INTO teachers (id, center_id, name, phone, status)
       VALUES ('tch-ps', 'center-1', 'أ/ طارق', '01011112222', 'active')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status)
       VALUES ('grp-ps', 'center-1', 'مجموعة الصف الثالث', 'tch-ps', 'sub-ps', 'الصف الثالث الثانوي', 300, 100, 300, 'active')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time)
       VALUES ('sch-ps-1', 'center-1', 'grp-ps', 6, '17:00', '19:00')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status)
       VALUES ('ses-ps-1', 'center-1', 'grp-ps', 'sch-ps-1', '2026-09-05', '17:00', '19:00', 'closed')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status)
       VALUES ('ses-ps-2', 'center-1', 'grp-ps', 'sch-ps-1', '2026-09-12', '17:00', '19:00', 'closed')`,
    );

    const students = [
      { id: "stu-monthly", name: "أحمد محمد علي", code: "101", phone: "01010000101" },
      { id: "stu-discounted", name: "سارة محمود", code: "102", phone: "01010000102" },
      { id: "stu-session", name: "كريم حسن", code: "103", phone: "01010000103" },
      { id: "stu-partial", name: "نور الدين", code: "104", phone: "01010000104" },
      { id: "stu-unpaid", name: "يوسف إبراهيم", code: "105", phone: "01010000105" },
      { id: "stu-free", name: "ملك عادل", code: "106", phone: "01010000106" },
    ];
    for (const s of students) {
      db.runSync(
        `INSERT OR REPLACE INTO students (id, center_id, full_name, student_code, phone, grade, status)
         VALUES (?, 'center-1', ?, ?, ?, 'الصف الثالث الثانوي', 'active')`,
        [s.id, s.name, s.code, s.phone],
      );
    }

    // Monthly enrollments starting 2026-09-01 (monthly cycle 1: 2026-09-01 to 2026-09-30)
    // stu-monthly: regular 300, paid 300 on 2026-09-03
    // stu-discounted: discounted to 150, paid 150 on 2026-09-04 -> MUST be monthly, NOT partial
    // stu-partial: regular 300, paid 120 on 2026-09-06 -> partial (180 remaining)
    // stu-unpaid: regular 300, paid 0 until 2026-10-05 -> unpaid on 2026-09-25, monthly on 2026-10-10
    // stu-free: 100% exempt (0 due) -> MUST NOT appear in unpaid
    // stu-session: per-session billing, 2 session payments (one of 300 == monthly price!) on 2026-09-05 & 2026-09-12 -> MUST stay in session category with 1 aggregated row
    const enrollments = [
      { id: "enr-monthly", studentId: "stu-monthly", pricingType: "regular", customPrice: null },
      { id: "enr-discounted", studentId: "stu-discounted", pricingType: "custom", customPrice: 150 },
      { id: "enr-session", studentId: "stu-session", pricingType: "regular", customPrice: null },
      { id: "enr-partial", studentId: "stu-partial", pricingType: "regular", customPrice: null },
      { id: "enr-unpaid", studentId: "stu-unpaid", pricingType: "regular", customPrice: null },
      { id: "enr-free", studentId: "stu-free", pricingType: "free", customPrice: 0 },
    ];
    for (const e of enrollments) {
      db.runSync(
        `INSERT OR REPLACE INTO student_group_enrollments
           (id, center_id, student_id, group_id, start_date, status, pricing_type, custom_monthly_price)
         VALUES (?, 'center-1', ?, 'grp-ps', '2026-09-01', 'active', ?, ?)`,
        [e.id, e.studentId, e.pricingType, e.customPrice],
      );
    }

    // Debt cycles for September 2026 (plus a second October cycle for stu-monthly to test multi-obligation deduplication)
    const cycles = [
      { id: "cyc-monthly-1", enrId: "enr-monthly", studentId: "stu-monthly", num: 1, start: "2026-09-01", end: "2026-09-30", price: 300, mode: "monthly", type: "monthly" },
      { id: "cyc-monthly-2", enrId: "enr-monthly", studentId: "stu-monthly", num: 2, start: "2026-10-01", end: "2026-10-31", price: 300, mode: "monthly", type: "monthly" },
      { id: "cyc-discounted-1", enrId: "enr-discounted", studentId: "stu-discounted", num: 1, start: "2026-09-01", end: "2026-09-30", price: 150, mode: "monthly", type: "monthly" },
      { id: "cyc-session-1", enrId: "enr-session", studentId: "stu-session", num: 1, start: "2026-09-01", end: "2026-09-30", price: 0, mode: "per_session", type: "per_session" },
      { id: "cyc-partial-1", enrId: "enr-partial", studentId: "stu-partial", num: 1, start: "2026-09-01", end: "2026-09-30", price: 300, mode: "monthly", type: "monthly" },
      { id: "cyc-unpaid-1", enrId: "enr-unpaid", studentId: "stu-unpaid", num: 1, start: "2026-09-01", end: "2026-09-30", price: 300, mode: "monthly", type: "monthly" },
      { id: "cyc-free-1", enrId: "enr-free", studentId: "stu-free", num: 1, start: "2026-09-01", end: "2026-09-30", price: 0, mode: "monthly", type: "monthly" },
    ];
    for (const c of cycles) {
      db.runSync(
        `INSERT OR REPLACE INTO debt_cycles
           (id, center_id, enrollment_id, student_id, group_id, cycle_number, start_date, end_date, cycle_price, billing_mode, cycle_type, status)
         VALUES (?, 'center-1', ?, ?, 'grp-ps', ?, ?, ?, ?, ?, ?, 'open')`,
        [c.id, c.enrId, c.studentId, c.num, c.start, c.end, c.price, c.mode, c.type],
      );
    }

    // Payments
    const payments = [
      // stu-monthly pays Sept on 2026-09-03 and Oct on 2026-10-02
      { id: "pay-m-1", studentId: "stu-monthly", cycleId: "cyc-monthly-1", sessionId: null, amount: 300, type: "monthly", date: "2026-09-03" },
      { id: "pay-m-2", studentId: "stu-monthly", cycleId: "cyc-monthly-2", sessionId: null, amount: 300, type: "monthly", date: "2026-10-02" },
      // stu-discounted pays full discounted amount 150 on 2026-09-04
      { id: "pay-d-1", studentId: "stu-discounted", cycleId: "cyc-discounted-1", sessionId: null, amount: 150, type: "monthly", date: "2026-09-04" },
      // stu-session pays 300 (same as monthly price!) for ses-ps-1 and 100 for ses-ps-2
      { id: "pay-s-1", studentId: "stu-session", cycleId: null, sessionId: "ses-ps-1", amount: 300, type: "session", date: "2026-09-05" },
      { id: "pay-s-2", studentId: "stu-session", cycleId: null, sessionId: "ses-ps-2", amount: 100, type: "session", date: "2026-09-12" },
      // stu-partial pays 120 out of 300 on 2026-09-06
      { id: "pay-p-1", studentId: "stu-partial", cycleId: "cyc-partial-1", sessionId: null, amount: 120, type: "partial", date: "2026-09-06" },
      // stu-unpaid pays LATER on 2026-10-05 (so unpaid on 2026-09-25, monthly on 2026-10-10)
      { id: "pay-u-1", studentId: "stu-unpaid", cycleId: "cyc-unpaid-1", sessionId: null, amount: 300, type: "monthly", date: "2026-10-05" },
      // Payment request payment must NOT merge into monthly or session categories
      { id: "pay-pr-1", studentId: "stu-unpaid", cycleId: null, sessionId: null, amount: 50, type: "payment_request", date: "2026-09-10" },
    ];
    for (const p of payments) {
      db.runSync(
        `INSERT OR REPLACE INTO payments
           (id, operation_id, center_id, student_id, debt_cycle_id, session_id, amount, payment_type, payment_method, payment_date, is_reversed, created_at, user_id)
         VALUES (?, ?, 'center-1', ?, ?, ?, ?, ?, 'cash', ?, 0, ?, 'usr-1')`,
        [p.id, `op-${p.id}`, p.studentId, p.cycleId, p.sessionId, p.amount, p.type, p.date, `${p.date}T12:00:00Z`],
      );
    }
  }

  it("1. UI layout & navigation: renamed to إحصائيات الدفع, horizontal categories, search above list, preserved route", () => {
    const screenSource = fs.readFileSync(
      path.join(__dirname, "../src/app/(main)/financial-reports.tsx"),
      "utf8",
    );
    const moreSource = fs.readFileSync(
      path.join(__dirname, "../src/app/(main)/more.tsx"),
      "utf8",
    );

    expect(moreSource).toContain('route: "/(main)/financial-reports"');
    expect(moreSource).toContain("إحصائيات الدفع");

    expect(screenSource).toContain("إحصائيات الدفع");
    expect(screenSource).not.toContain("مديونية المجموعات");
    expect(screenSource).toContain("دفع شهري");
    expect(screenSource).toContain("دفع بالحصة");
    expect(screenSource).toContain("دفع جزئي");
    expect(screenSource).toContain("لم يدفع");
    expect(screenSource).toContain("Horizontal Payment Category Tabs");
    expect(screenSource).toContain("getCairoTodayDateOnly");

    const tabsIdx = screenSource.indexOf("{/* Horizontal Payment Category Tabs */}");
    const filtersIdx = screenSource.indexOf("{/* Search and Amount Range Filters Immediately Above Student List */}");
    const listIdx = screenSource.indexOf("{/* Selected Category Student List */}");
    expect(tabsIdx).toBeGreaterThan(-1);
    expect(filtersIdx).toBeGreaterThan(tabsIdx);
    expect(listIdx).toBeGreaterThan(filtersIdx);
  });

  it("2, 3, 4, 5, 6, 7 & 8. Classifies categories by obligation type, keeps session separate, handles discounts/exemptions, and prevents duplicate counts", () => {
    seedPaymentStatisticsScenario();

    const stats = PaymentStatisticsService.getGroupPaymentStatistics("grp-ps", "2026-09-25");

    // Monthly: stu-monthly (300) and stu-discounted (150, NOT partial!)
    expect(stats.counts.monthly).toBe(2);
    expect(stats.categories.monthly.map((r) => r.studentId)).toEqual(
      expect.arrayContaining(["stu-monthly", "stu-discounted"]),
    );
    const discountedRow = stats.categories.monthly.find((r) => r.studentId === "stu-discounted");
    expect(discountedRow?.amountPaid).toBe(150);
    expect(discountedRow?.paymentDate).toBe("2026-09-04");

    // Session: stu-session ONLY (even though first session payment was 300 == monthly price!)
    // Aggregated into 1 row with total 400 and 2 sessions covered
    expect(stats.counts.session).toBe(1);
    expect(stats.categories.session[0]).toMatchObject({
      studentId: "stu-session",
      amountPaid: 400,
      sessionsCount: 2,
      paymentDate: "2026-09-12",
    });

    // Partial: stu-partial ONLY (120 paid out of 300 -> 180 remaining)
    expect(stats.counts.partial).toBe(1);
    expect(stats.categories.partial[0]).toMatchObject({
      studentId: "stu-partial",
      originalDue: 300,
      amountPaid: 120,
      remainingBalance: 180,
    });

    // Unpaid: stu-unpaid ONLY (stu-free has 0 obligation due and MUST NOT appear)
    expect(stats.counts.unpaid).toBe(1);
    expect(stats.categories.unpaid[0]).toMatchObject({
      studentId: "stu-unpaid",
      originalDue: 300,
      remainingBalance: 300,
    });
    expect(stats.categories.unpaid.some((r) => r.studentId === "stu-free")).toBe(false);
  });

  it("8 & 9. Multi-obligation deduplication and historical date accuracy (later payments do not alter earlier report dates)", () => {
    seedPaymentStatisticsScenario();

    // On 2026-09-25: stu-unpaid has NOT paid yet, and stu-monthly only has Sept cycle (300)
    const septStats = PaymentStatisticsService.getGroupPaymentStatistics("grp-ps", "2026-09-25");
    expect(septStats.counts.unpaid).toBe(1);
    expect(septStats.categories.monthly.find((r) => r.studentId === "stu-monthly")?.amountPaid).toBe(300);

    // On 2026-10-10: stu-unpaid paid Sept on 2026-10-05 -> appears in monthly;
    // stu-monthly has BOTH Sept & Oct cycles paid -> still 1 deduplicated row (amountPaid = 600)!
    const octStats = PaymentStatisticsService.getGroupPaymentStatistics("grp-ps", "2026-10-10");
    expect(octStats.counts.monthly).toBe(3);
    expect(octStats.categories.monthly.some((r) => r.studentId === "stu-unpaid")).toBe(true);
    const monthlyRowOct = octStats.categories.monthly.find((r) => r.studentId === "stu-monthly");
    expect(monthlyRowOct?.amountPaid).toBe(600);
    expect(monthlyRowOct?.paymentDate).toBe("2026-10-02");

    // Re-checking 2026-09-25 still yields historical result
    const septRecheck = PaymentStatisticsService.getGroupPaymentStatistics("grp-ps", "2026-09-25");
    expect(septRecheck.counts.unpaid).toBe(1);

    // Cairo date-only helper returns YYYY-MM-DD in Africa/Cairo
    const cairoDate = getCairoTodayDateOnly(new Date("2026-09-25T22:30:00.000Z"));
    expect(cairoDate).toBe("2026-09-26");
  });

  it("10 & 11. Smart search and amount range filters work within the selected category without mutating financial records", () => {
    seedPaymentStatisticsScenario();

    const beforeStatus = FinancialCalculationService.getStudentFinancialStatusForGroup(
      "stu-partial",
      "grp-ps",
      "2026-09-25",
    );
    const stats = PaymentStatisticsService.getGroupPaymentStatistics("grp-ps", "2026-09-25");
    const afterStatus = FinancialCalculationService.getStudentFinancialStatusForGroup(
      "stu-partial",
      "grp-ps",
      "2026-09-25",
    );

    expect(afterStatus.totalDue).toBe(beforeStatus.totalDue);
    expect(afterStatus.totalPaid).toBe(beforeStatus.totalPaid);

    // Search by normalized Arabic name in monthly
    const byName = PaymentStatisticsService.filterRows(
      stats.categories.monthly,
      "monthly",
      "احمد",
      "",
      "",
    );
    expect(byName.map((r) => r.studentId)).toEqual(["stu-monthly"]);

    // Search by student code
    const byCode = PaymentStatisticsService.filterRows(
      stats.categories.monthly,
      "monthly",
      "102",
      "",
      "",
    );
    expect(byCode.map((r) => r.studentId)).toEqual(["stu-discounted"]);

    // Amount range filter in monthly (200..400 excludes 150)
    const byAmount = PaymentStatisticsService.filterRows(
      stats.categories.monthly,
      "monthly",
      "",
      "200",
      "400",
    );
    expect(byAmount.map((r) => r.studentId)).toEqual(["stu-monthly"]);
  });
});
