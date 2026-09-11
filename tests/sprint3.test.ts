import { DatabaseService } from "../src/core/database";
import {
    ConflictError,
    ForbiddenError,
    ValidationError
} from "../src/core/errors";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { DebtAdjustmentRepository } from "../src/features/payments/DebtAdjustmentRepository";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("Sprint 3 - FIXION Financial Core & Cash Payments", () => {
  beforeAll(async () => {
    // 1. Initialize SQLite schema & run all 3 migrations
    DatabaseService.init();

    // 2. Login as Demo Admin for center-1 setup
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  describe("1. Subscription-Based Debt Cycles & Boundary Rules", () => {
    let studentA: any;
    let groupA: any;
    let enrollmentA: any;

    beforeAll(() => {
      // Create student for cycle tests
      studentA = StudentRepository.createStudent({
        studentCode: "FIN-STD-001",
        fullName: "محمد أحمد المالي",
        phone: "01011112222",
        parentPhone: "01033334444",
        grade: "الصف الثالث الثانوي",
      });

      // Create group with monthly price 600
      groupA = GroupRepository.createGroup({
        name: "رياضيات متقدمة - دورات",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 600,
        sessionPrice: 150,
      });

      // Enroll student with start date 2026-09-15
      enrollmentA = EnrollmentRepository.enrollStudent({
        studentId: studentA.id,
        groupId: groupA.id,
        startDate: "2026-09-15",
      });
    });

    it("generates debt cycle starting on enrollment start_date (e.g. 15th to 14th of next month), NOT calendar months", async () => {
      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentA.id,
        "2026-09-20",
      );

      expect(cycles.length).toBe(1);
      const cycle1 = cycles[0];
      expect(cycle1.cycleNumber).toBe(1);
      expect(cycle1.startDate).toBe("2026-09-15");
      expect(cycle1.endDate).toBe("2026-10-14");
      expect(cycle1.cyclePrice).toBe(600);
      expect(cycle1.status).toBe("open");
    });

    it("generates subsequent cycle advancing 1 month (2026-10-15 to 2026-11-14)", async () => {
      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentA.id,
        "2026-10-25",
      );

      expect(cycles.length).toBe(2);
      const cycle2 = cycles[1];
      expect(cycle2.cycleNumber).toBe(2);
      expect(cycle2.startDate).toBe("2026-10-15");
      expect(cycle2.endDate).toBe("2026-11-14");
      expect(cycle2.cyclePrice).toBe(600);
    });

    it("snapshots cycle price at creation; updating group monthly price later only affects future cycles", async () => {
      // Update group monthly price to 750
      const db = DatabaseService.getDb();
      db.runSync(
        `UPDATE groups SET monthly_price = 750 WHERE center_id = ? AND id = ?`,
        ["center-1", groupA.id],
      );

      // Advance target date to 2026-11-25 to trigger cycle 3
      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentA.id,
        "2026-11-25",
      );

      expect(cycles.length).toBe(3);
      // Previously generated cycles retain original snapshotted price of 600
      expect(cycles[0].cyclePrice).toBe(600);
      expect(cycles[1].cyclePrice).toBe(600);

      // New cycle 3 snapshots the new group price of 750
      expect(cycles[2].cycleNumber).toBe(3);
      expect(cycles[2].startDate).toBe("2026-11-15");
      expect(cycles[2].endDate).toBe("2026-12-14");
      expect(cycles[2].cyclePrice).toBe(750);
    });

    it("strict enrollment end date bounding: NEVER generates cycles starting after enrollment.endDate", async () => {
      // Create student with finite enrollment
      const studentB = StudentRepository.createStudent({
        studentCode: "FIN-STD-002",
        fullName: "سارة محمود علي",
        phone: "01022223333",
        parentPhone: "01044445555",
        grade: "الصف الثالث الثانوي",
      });

      // Enrollment starting 2026-09-15 and ending 2026-11-20
      const enrollmentB = EnrollmentRepository.enrollStudent({
        studentId: studentB.id,
        groupId: groupA.id,
        startDate: "2026-09-15",
        endDate: "2026-11-20",
      });

      // Ask to generate cycles up to 2027-01-15
      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentB.id,
        "2027-01-15",
      );

      // Cycle 1: 2026-09-15 (starts <= 2026-11-20) -> Valid
      // Cycle 2: 2026-10-15 (starts <= 2026-11-20) -> Valid
      // Cycle 3: 2026-11-15 (starts <= 2026-11-20) -> Valid
      // Next cycle would start 2026-12-15 (> 2026-11-20) -> MUST NOT BE GENERATED!
      expect(cycles.length).toBe(3);
      expect(cycles[2].startDate).toBe("2026-11-15");

      // Verify no cycle starts after 2026-11-20
      const afterEndDate = cycles.filter((c) => c.startDate > "2026-11-20");
      expect(afterEndDate.length).toBe(0);
    });

    it("ended or inactive enrollment generates NO new cycles", async () => {
      const studentC = StudentRepository.createStudent({
        studentCode: "FIN-STD-003",
        fullName: "كريم يحيى فؤاد",
        phone: "01033331111",
        parentPhone: "01055552222",
        grade: "الصف الثالث الثانوي",
      });

      const enrollmentC = EnrollmentRepository.enrollStudent({
        studentId: studentC.id,
        groupId: groupA.id,
        startDate: "2026-09-01",
      });

      // Generate cycle 1
      await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentC.id,
        "2026-09-10",
      );

      // End enrollment
      EnrollmentRepository.endEnrollment(enrollmentC.id, "2026-09-20");

      // Try generating for next months
      const cyclesAfterEnd =
        await DebtCycleRepository.generateCyclesForEnrollment(
          enrollmentC.id,
          "2026-12-01",
        );

      // Stays at 1 cycle, no new cycles created
      expect(cyclesAfterEnd.length).toBe(1);
    });
  });

  describe("2. Strict Separation of Monthly Debt & Session Payments", () => {
    let studentIso: any;
    let groupIso: any;
    let enrollmentIso: any;

    beforeAll(async () => {
      studentIso = StudentRepository.createStudent({
        studentCode: "FIN-STD-ISO",
        fullName: "ياسر كمال فهمي",
        phone: "01066667777",
        parentPhone: "01088889999",
        grade: "الصف الثالث الثانوي",
      });

      groupIso = GroupRepository.createGroup({
        name: "فيزياء - عزل المديونية",
        teacherId: "teach-2",
        subjectId: "subj-2",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 1000,
        sessionPrice: 200,
      });

      enrollmentIso = EnrollmentRepository.enrollStudent({
        studentId: studentIso.id,
        groupId: groupIso.id,
        startDate: "2026-09-01",
      });

      // Generate initial cycle for September (due: 1000)
      await DebtCycleRepository.generateCyclesForEnrollment(
        enrollmentIso.id,
        "2026-09-05",
      );
    });

    it("verifies initial monthly debt is 1000 and session paid is 0", () => {
      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentIso.id,
        "2026-09-05",
      );

      expect(status.monthlyTotalDue).toBe(1000);
      expect(status.monthlyTotalPaid).toBe(0);
      expect(status.monthlyRemainingDebt).toBe(1000);
      expect(status.sessionTotalPaid).toBe(0);
    });

    it("CRITICAL: recording a session payment of 200 does NOT reduce monthly debt (remains 1000)", async () => {
      // Record session payment
      await PaymentRepository.recordPayment({
        studentId: studentIso.id,
        amount: 200,
        paymentType: "session",
        sessionId: "sess-1",
      });

      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentIso.id,
        "2026-09-05",
      );

      // Monthly debt MUST remain 1000!
      expect(status.monthlyTotalDue).toBe(1000);
      expect(status.monthlyTotalPaid).toBe(0);
      expect(status.monthlyRemainingDebt).toBe(1000);

      // Session total paid is exposed separately
      expect(status.sessionTotalPaid).toBe(200);
      expect(status.sessionPayments.length).toBe(1);
      expect(status.monthlyPayments.length).toBe(0);
    });

    it("recording a partial monthly payment of 400 reduces monthly debt (to 600), while session paid remains separate (200)", async () => {
      await PaymentRepository.recordPayment({
        studentId: studentIso.id,
        amount: 400,
        paymentType: "partial",
      });

      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentIso.id,
        "2026-09-05",
      );

      expect(status.monthlyTotalDue).toBe(1000);
      expect(status.monthlyTotalPaid).toBe(400);
      expect(status.monthlyRemainingDebt).toBe(600);
      expect(status.sessionTotalPaid).toBe(200);
    });
  });

  describe("3. Cash Payment Recording & Idempotency", () => {
    let studentPay: any;
    let groupPay: any;

    beforeAll(async () => {
      studentPay = StudentRepository.createStudent({
        studentCode: "FIN-STD-PAY",
        fullName: "نورهان هشام مصطفى",
        phone: "01011223344",
        parentPhone: "01055667788",
        grade: "الصف الثاني الثانوي",
      });

      groupPay = GroupRepository.createGroup({
        name: "كيمياء 2 ثانوي",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثاني الثانوي",
        monthlyPrice: 500,
        sessionPrice: 125,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: studentPay.id,
        groupId: groupPay.id,
        startDate: "2026-09-01",
      });

      await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );
    });

    it("records a cash payment with operation_id for idempotency and enqueues sync", async () => {
      const opId = "op-pay-unique-12345";
      const payment = await PaymentRepository.recordPayment({
        studentId: studentPay.id,
        amount: 500,
        paymentType: "monthly",
        operationId: opId,
      });

      expect(payment.amount).toBe(500);
      expect(payment.operationId).toBe(opId);
      expect(payment.paymentType).toBe("monthly");

      // Verify cycle is now paid
      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentPay.id,
        "2026-09-01",
      );
      expect(status.monthlyTotalPaid).toBe(500);
      expect(status.monthlyRemainingDebt).toBe(0);
      expect(status.cycles[0].status).toBe("paid");

      // Verify sync operation queued
      const pendingOps = SyncRepository.getPendingOperations("center-1");
      const queued = pendingOps.find((o) => o.operationId === opId);
      expect(queued).toBeDefined();
      expect(queued?.operationType).toBe("payment.create");
    });

    it("prevents duplicate payments with the same operation_id (idempotency enforcement)", async () => {
      await expect(
        PaymentRepository.recordPayment({
          studentId: studentPay.id,
          amount: 500,
          paymentType: "monthly",
          operationId: "op-pay-unique-12345", // duplicate
        }),
      ).rejects.toThrow();
    });

    it("rejects non-positive payment amount", async () => {
      await expect(
        PaymentRepository.recordPayment({
          studentId: studentPay.id,
          amount: 0,
          paymentType: "partial",
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        PaymentRepository.recordPayment({
          studentId: studentPay.id,
          amount: -100,
          paymentType: "partial",
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("4. Payment Reversals & Single-Reversal Enforcement", () => {
    let studentRev: any;
    let paymentToReverse: any;

    beforeAll(async () => {
      studentRev = StudentRepository.createStudent({
        studentCode: "FIN-STD-REV",
        fullName: "طارق سليم إبراهيم",
        phone: "01077889900",
        parentPhone: "01099001122",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "أحياء 3 ثانوي",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 500,
        sessionPrice: 125,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: studentRev.id,
        groupId: grp.id,
        startDate: "2026-09-01",
      });

      await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );

      // Record a payment of 500
      paymentToReverse = await PaymentRepository.recordPayment({
        studentId: studentRev.id,
        amount: 500,
        paymentType: "monthly",
      });
    });

    it("reverses a payment, marks is_reversed = 1, and inserts into payment_reversals", async () => {
      const reversal = await PaymentRepository.reversePayment({
        paymentId: paymentToReverse.id,
        reason: "خطأ في تسجيل المبلغ من السكرتارية",
      });

      expect(reversal.reversedAmount).toBe(500);
      expect(reversal.reason).toBe("خطأ في تسجيل المبلغ من السكرتارية");
      expect(reversal.paymentId).toBe(paymentToReverse.id);

      // Verify payment in DB is NOT hard-deleted, but is_reversed = 1
      const db = DatabaseService.getDb();
      const rawPay = db.getFirstSync<any>(
        `SELECT id, is_reversed FROM payments WHERE id = ?`,
        [paymentToReverse.id],
      );
      expect(rawPay).toBeDefined();
      expect(rawPay.isReversed).toBe(true);
    });

    it("reversal immediately and dynamically restores remaining debt in financial status", () => {
      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentRev.id,
        "2026-09-01",
      );

      // Payment was reversed, so monthly total paid is back to 0, remaining debt is 500
      expect(status.monthlyTotalPaid).toBe(0);
      expect(status.monthlyRemainingDebt).toBe(500);
      expect(status.reversals.length).toBe(1);
      expect(status.reversals[0].paymentId).toBe(paymentToReverse.id);
    });

    it("enforces single-reversal: attempting to reverse an already-reversed payment throws ConflictError", async () => {
      await expect(
        PaymentRepository.reversePayment({
          paymentId: paymentToReverse.id,
          reason: "محاولة إلغاء ثانية لنفس الدفعة",
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("requires non-empty reversal reason", async () => {
      // Create another payment
      const p2 = await PaymentRepository.recordPayment({
        studentId: studentRev.id,
        amount: 200,
        paymentType: "partial",
      });

      await expect(
        PaymentRepository.reversePayment({
          paymentId: p2.id,
          reason: "   ", // whitespace only
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("5. Manual Debt Adjustments (Admin Only)", () => {
    let studentAdj: any;
    let cycleAdj: any;

    beforeAll(async () => {
      studentAdj = StudentRepository.createStudent({
        studentCode: "FIN-STD-ADJ",
        fullName: "جميلة عادل توفيق",
        phone: "01033445566",
        parentPhone: "01077889911",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "لغة فرنسية",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 400,
        sessionPrice: 100,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: studentAdj.id,
        groupId: grp.id,
        startDate: "2026-09-01",
      });

      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );
      cycleAdj = cycles[0];
    });

    it("applies discount (-50) to debt cycle, recording before/after amounts and reason", async () => {
      const adj = await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: cycleAdj.id,
        adjustmentAmount: -50,
        reason: "خصم تفوق أكاديمي",
      });

      expect(adj.amountBefore).toBe(400);
      expect(adj.adjustmentAmount).toBe(-50);
      expect(adj.amountAfter).toBe(350);
      expect(adj.reason).toBe("خصم تفوق أكاديمي");

      // Dynamic calculation reflects new effective price of 350
      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentAdj.id,
        "2026-09-01",
      );
      expect(status.monthlyTotalDue).toBe(350);
      expect(status.monthlyRemainingDebt).toBe(350);
      expect(status.cycles[0].effectivePrice).toBe(350);
      expect(status.adjustments.length).toBe(1);
    });

    it("applies surcharge (+100) on top of existing adjustments", async () => {
      const adj2 = await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: cycleAdj.id,
        adjustmentAmount: 100,
        reason: "رسوم كتب وملازم إضافية",
      });

      // Amount before was 350 (400 - 50)
      expect(adj2.amountBefore).toBe(350);
      expect(adj2.adjustmentAmount).toBe(100);
      expect(adj2.amountAfter).toBe(450);

      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentAdj.id,
        "2026-09-01",
      );
      expect(status.monthlyTotalDue).toBe(450);
      expect(status.monthlyRemainingDebt).toBe(450);
      expect(status.adjustments.length).toBe(2);
    });

    it("rejects adjustment that causes total amount to be negative", async () => {
      await expect(
        DebtAdjustmentRepository.createAdjustment({
          debtCycleId: cycleAdj.id,
          adjustmentAmount: -600, // current is 450, 450 - 600 = -150
          reason: "خصم مبالغ فيه",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("requires adjustment reason", async () => {
      await expect(
        DebtAdjustmentRepository.createAdjustment({
          debtCycleId: cycleAdj.id,
          adjustmentAmount: -50,
          reason: "",
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("6. Repository Permissions & Role Enforcement", () => {
    let studentSec: any;
    let paymentSec: any;
    let cycleSec: any;

    beforeAll(async () => {
      // Create student and payment under admin
      studentSec = StudentRepository.createStudent({
        studentCode: "FIN-STD-SEC",
        fullName: "عمر شريف سامي",
        phone: "01099887766",
        parentPhone: "01044332211",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "فلسفة 3 ثانوي",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 300,
        sessionPrice: 75,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: studentSec.id,
        groupId: grp.id,
        startDate: "2026-09-01",
      });

      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );
      cycleSec = cycles[0];

      paymentSec = await PaymentRepository.recordPayment({
        studentId: studentSec.id,
        amount: 300,
        paymentType: "monthly",
      });

      // Switch auth context to Demo Secretary (01000000002)
      await useAuthStore.getState().login("01000000002", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    afterAll(async () => {
      // Restore Admin context for subsequent tests
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("secretary CAN view student financial status", () => {
      const status = FinancialCalculationService.getStudentFinancialStatus(
        studentSec.id,
        "2026-09-01",
      );
      expect(status.monthlyTotalDue).toBe(300);
      expect(status.monthlyTotalPaid).toBe(300);
    });

    it("secretary CAN record cash payments", async () => {
      const payment = await PaymentRepository.recordPayment({
        studentId: studentSec.id,
        amount: 50,
        paymentType: "partial",
      });
      expect(payment.amount).toBe(50);
    });

    it("secretary CANNOT reverse payments (ForbiddenError: payments.reverse required)", async () => {
      await expect(
        PaymentRepository.reversePayment({
          paymentId: paymentSec.id,
          reason: "محاولة إلغاء من السكرتير",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("secretary CANNOT create debt adjustments (ForbiddenError: payments.adjust required)", async () => {
      await expect(
        DebtAdjustmentRepository.createAdjustment({
          debtCycleId: cycleSec.id,
          adjustmentAmount: -50,
          reason: "محاولة تعديل من السكرتير",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("7. Multi-Center Isolation", () => {
    let center1Student: any;

    beforeAll(async () => {
      // In center-1
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      center1Student = StudentRepository.createStudent({
        studentCode: "FIN-STD-C1",
        fullName: "طالب مركز النور",
        phone: "01011110000",
        parentPhone: "01022220000",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "مجموعة مركز 1",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 500,
        sessionPrice: 125,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: center1Student.id,
        groupId: grp.id,
        startDate: "2026-09-01",
      });

      await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );

      await PaymentRepository.recordPayment({
        studentId: center1Student.id,
        amount: 250,
        paymentType: "partial",
      });
    });

    it("switching to center-2 completely isolates center-1 financial data", async () => {
      // Switch to center-2
      await useAuthStore.getState().selectCenter("center-2");

      // Attempting to fetch financial data for center-1 student from center-2 context
      const statusCenter2 =
        FinancialCalculationService.getStudentFinancialStatus(
          center1Student.id,
          "2026-09-01",
        );

      // In center-2, student has no cycles or payments
      expect(statusCenter2.cycles.length).toBe(0);
      expect(statusCenter2.payments.length).toBe(0);
      expect(statusCenter2.monthlyTotalDue).toBe(0);
      expect(statusCenter2.monthlyTotalPaid).toBe(0);

      // Direct queries to DebtCycleRepository in center-2 returns empty
      const cyclesC2 = DebtCycleRepository.getCyclesForStudent(
        center1Student.id,
      );
      expect(cyclesC2.length).toBe(0);

      // Direct queries to PaymentRepository in center-2 returns empty
      const paymentsC2 = PaymentRepository.getPaymentsForStudent(
        center1Student.id,
      );
      expect(paymentsC2.length).toBe(0);
    });

    it("switch back to center-1 restores full visibility of center-1 financial records", async () => {
      await useAuthStore.getState().selectCenter("center-1");

      const statusCenter1 =
        FinancialCalculationService.getStudentFinancialStatus(
          center1Student.id,
          "2026-09-01",
        );
      expect(statusCenter1.cycles.length).toBe(1);
      expect(statusCenter1.payments.length).toBe(1);
      expect(statusCenter1.monthlyTotalDue).toBe(500);
      expect(statusCenter1.monthlyTotalPaid).toBe(250);
      expect(statusCenter1.monthlyRemainingDebt).toBe(250);
    });
  });

  describe("8. Offline Sync Queue & Audit Logging", () => {
    it("enqueues all financial operations (payment, adjustment, reversal) with unique operation_id and logs audit", async () => {
      const studentSync = StudentRepository.createStudent({
        studentCode: "FIN-STD-SYNC",
        fullName: "أيمن رفعت الشريف",
        phone: "01033441122",
        parentPhone: "01055663344",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "تاريخ 3 ثانوي",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 300,
        sessionPrice: 75,
      });

      const enr = EnrollmentRepository.enrollStudent({
        studentId: studentSync.id,
        groupId: grp.id,
        startDate: "2026-09-01",
      });

      const cycles = await DebtCycleRepository.generateCyclesForEnrollment(
        enr.id,
        "2026-09-01",
      );

      // 1. Record payment
      const payment = await PaymentRepository.recordPayment({
        studentId: studentSync.id,
        amount: 300,
        paymentType: "monthly",
      });

      // 2. Apply adjustment
      const adj = await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: cycles[0].id,
        adjustmentAmount: -30,
        reason: "خصم أخوة",
      });

      // 3. Reverse payment
      const rev = await PaymentRepository.reversePayment({
        paymentId: payment.id,
        reason: "إلغاء دفعة للاختبار",
      });

      const pendingOps = SyncRepository.getPendingOperations("center-1");

      const payOp = pendingOps.find(
        (o) => o.operationId === payment.operationId,
      );
      expect(payOp).toBeDefined();
      expect(payOp?.operationType).toBe("payment.create");

      const adjOp = pendingOps.find((o) => o.operationId === adj.operationId);
      expect(adjOp).toBeDefined();
      expect(adjOp?.operationType).toBe("debt_adjustment.create");

      const revOp = pendingOps.find((o) => o.operationId === rev.operationId);
      expect(revOp).toBeDefined();
      expect(revOp?.operationType).toBe("payment.reverse");

      // Verify audit logs
      const db = DatabaseService.getDb();
      const auditLogs = db.getAllSync<any>(
        `SELECT * FROM audit_logs WHERE center_id = ? AND entity_id IN (?, ?, ?)`,
        ["center-1", payment.id, adj.id, rev.paymentId],
      );
      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
    });
  });
});
