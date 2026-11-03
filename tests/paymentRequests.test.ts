import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../src/core/errors";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { PaymentRequestRepository } from "../src/features/payments/PaymentRequestRepository";

describe("Group Payment Requests Feature (مطالبات الدفع)", () => {
  const OWNER_USER = {
    id: "usr-pr-owner",
    fullName: "مدير المركز",
    phone: "01000000001",
    role: "owner" as const,
    centerId: "center-1",
    centerIds: ["center-1", "center-2"],
    permissions: ["*" as any],
  };

  beforeAll(async () => {
    DatabaseService.init();
    const db = DatabaseService.getDb();

    // Ensure centers exist
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      ["center-1", "سنتر فيكشن 1", "C1", "Africa/Cairo"],
    );
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      ["center-2", "سنتر فيكشن 2", "C2", "Africa/Cairo"],
    );

    // Ensure teacher and subject exist
    db.runSync(
      `INSERT INTO teachers (id, center_id, full_name, phone, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO NOTHING`,
      ["teach-pr-1", "center-1", "أ. محمد حسن", "01011111111", "2026-09-01"],
    );
    db.runSync(
      `INSERT INTO subjects (id, center_id, name, grade, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO NOTHING`,
      ["subj-pr-1", "center-1", "الفيزياء", "الثالث الثانوي", "2026-09-01"],
    );

    // Create dedicated test groups in center-1 and center-2
    db.runSync(
      `INSERT INTO groups (id, center_id, name, grade, subject_id, teacher_id, monthly_Fee, session_price, billing_type, capacity, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'monthly', 50, 'active', ?)`,
      [
        "grp-pr-A",
        "center-1",
        "مجموعة الفيزياء A",
        "الثالث الثانوي",
        "subj-pr-1",
        "teach-pr-1",
        300,
        50,
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO groups (id, center_id, name, grade, subject_id, teacher_id, monthly_Fee, session_price, billing_type, capacity, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'monthly', 50, 'active', ?)`,
      [
        "grp-pr-B",
        "center-1",
        "مجموعة الفيزياء B",
        "الثالث الثانوي",
        "subj-pr-1",
        "teach-pr-1",
        350,
        60,
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO groups (id, center_id, name, grade, subject_id, teacher_id, monthly_Fee, session_price, billing_type, capacity, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'monthly', 50, 'active', ?)`,
      [
        "grp-pr-C2",
        "center-2",
        "مجموعة سنتر 2",
        "الثالث الثانوي",
        "subj-pr-1",
        "teach-pr-1",
        300,
        50,
        "2026-09-01",
      ],
    );

    // Create test students
    const testStudents = [
      {
        id: "std-pr-1",
        centerId: "center-1",
        code: "STD-PR-001",
        name: "أحمد محمود",
        status: "active",
      },
      {
        id: "std-pr-2",
        centerId: "center-1",
        code: "STD-PR-002",
        name: "سارة خالد",
        status: "active",
      },
      {
        id: "std-pr-3",
        centerId: "center-1",
        code: "STD-PR-003",
        name: "عمر طارق (مجموعتين)",
        status: "active",
      },
      {
        id: "std-pr-other",
        centerId: "center-1",
        code: "STD-PR-004",
        name: "يوسف سمير (مجموعة B فقط)",
        status: "active",
      },
      {
        id: "std-pr-inactive",
        centerId: "center-1",
        code: "STD-PR-005",
        name: "طالب غير نشط",
        status: "inactive",
      },
      {
        id: "std-pr-late",
        centerId: "center-1",
        code: "STD-PR-006",
        name: "طالب انضم لاحقًا",
        status: "active",
      },
      {
        id: "std-pr-c2",
        centerId: "center-2",
        code: "STD-PR-C2",
        name: "طالب سنتر 2",
        status: "active",
      },
    ];

    for (const s of testStudents) {
      db.runSync(
        `INSERT INTO students (id, center_id, student_code, full_name, phone, parent_phone, grade, status, created_at)
         VALUES (?, ?, ?, ?, '01012345678', '01087654321', 'الثالث الثانوي', ?, '2026-09-01')`,
        [s.id, s.centerId, s.code, s.name, s.status],
      );
    }

    // Enrollments:
    // grp-pr-A: std-pr-1 (active), std-pr-2 (active), std-pr-3 (active), std-pr-inactive (active enrollment, but student status = inactive)
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-A', '2026-09-01', 'active', 'monthly', 300, '2026-09-01')`,
      ["enr-pr-1", "std-pr-1"],
    );
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-A', '2026-09-01', 'active', 'monthly', 300, '2026-09-01')`,
      ["enr-pr-2", "std-pr-2"],
    );
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-A', '2026-09-01', 'active', 'monthly', 300, '2026-09-01')`,
      ["enr-pr-3A", "std-pr-3"],
    );
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-A', '2026-09-01', 'active', 'monthly', 300, '2026-09-01')`,
      ["enr-pr-inactive", "std-pr-inactive"],
    );

    // grp-pr-B: std-pr-3 (active in both A and B) and std-pr-other (active only in B)
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-B', '2026-09-01', 'active', 'monthly', 350, '2026-09-01')`,
      ["enr-pr-3B", "std-pr-3"],
    );
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', ?, 'grp-pr-B', '2026-09-01', 'active', 'monthly', 350, '2026-09-01')`,
      ["enr-pr-other", "std-pr-other"],
    );

    // grp-pr-C2: std-pr-c2
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-2', ?, 'grp-pr-C2', '2026-09-01', 'active', 'monthly', 300, '2026-09-01')`,
      ["enr-pr-c2", "std-pr-c2"],
    );
  });

  beforeEach(() => {
    useAuthStore.setState({
      isAuthenticated: true,
      currentUser: OWNER_USER,
      activeCenterId: "center-1",
    });
  });

  it("1 & 2. creates a request for one group and applies independent obligations to all active enrolled students in that group", async () => {
    const groupsSummary = PaymentRequestRepository.getGroupsWithStudentCounts();
    const groupA = groupsSummary.find((g) => g.id === "grp-pr-A");
    expect(groupA).toBeDefined();
    // Only 3 active students (std-pr-1, std-pr-2, std-pr-3); std-pr-inactive is excluded
    expect(groupA?.activeStudentsCount).toBe(3);

    const result = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة 1",
      amount: 75.5,
      referenceMonth: "نوفمبر 2026",
    });

    expect(result.groupName).toBe("مجموعة الفيزياء A");
    expect(result.request.name).toBe("مذكرة 1");
    expect(result.request.amount).toBe(75.5);
    expect(result.request.referenceMonth).toBe("نوفمبر 2026");
    expect(result.request.status).toBe("active");
    expect(result.affectedStudentsCount).toBe(3);
    expect(result.obligations).toHaveLength(3);

    const studentIds = result.obligations.map((o) => o.studentId).sort();
    expect(studentIds).toEqual(["std-pr-1", "std-pr-2", "std-pr-3"]);

    for (const ob of result.obligations) {
      expect(ob.groupId).toBe("grp-pr-A");
      expect(ob.centerId).toBe("center-1");
      expect(ob.amountDue).toBe(75.5);
      expect(ob.amountPaid).toBe(0);
      expect(ob.status).toBe("unpaid");
    }
  });

  it("3. ensures students in other groups are completely unaffected", () => {
    const otherGroupStudentObligations =
      PaymentRequestRepository.getStudentObligations("std-pr-other");
    expect(otherGroupStudentObligations).toHaveLength(0);

    const otherStatus =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-other");
    expect(otherStatus.paymentRequestObligations).toHaveLength(0);
    expect(otherStatus.paymentRequestsRemainingDebt).toBe(0);
  });

  it("4. handles a student belonging to multiple groups without accidental duplication and preserves exact group association", async () => {
    // std-pr-3 is enrolled in both grp-pr-A and grp-pr-B
    const std3ObligationsAfterA =
      PaymentRequestRepository.getStudentObligations("std-pr-3");
    expect(std3ObligationsAfterA).toHaveLength(1);
    expect(std3ObligationsAfterA[0].groupId).toBe("grp-pr-A");

    // Create a separate request on grp-pr-B
    const resultB = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-B",
      name: "مراجعة الفصل الأول",
      amount: 50,
    });
    expect(resultB.affectedStudentsCount).toBe(2); // std-pr-3 and std-pr-other

    const std3ObligationsAfterB =
      PaymentRequestRepository.getStudentObligations("std-pr-3");
    expect(std3ObligationsAfterB).toHaveLength(2);

    const statusForGroupA =
      FinancialCalculationService.getStudentFinancialStatusForGroup(
        "std-pr-3",
        "grp-pr-A",
      );
    expect(statusForGroupA.paymentRequestObligations).toHaveLength(1);
    expect(statusForGroupA.paymentRequestsRemainingDebt).toBe(75.5);

    const statusForGroupB =
      FinancialCalculationService.getStudentFinancialStatusForGroup(
        "std-pr-3",
        "grp-pr-B",
      );
    expect(statusForGroupB.paymentRequestObligations).toHaveLength(1);
    expect(statusForGroupB.paymentRequestsRemainingDebt).toBe(50);
  });

  it("5. prevents duplicate obligations for the same student and request", async () => {
    const requestsA = PaymentRequestRepository.getRequestsForGroup("grp-pr-A");
    const req = requestsA[0];
    expect(req).toBeDefined();

    const db = DatabaseService.getDb();
    expect(() =>
      db.runSync(
        `INSERT INTO student_payment_request_obligations
         (id, center_id, request_id, group_id, student_id, amount_due, amount_paid, status, operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'unpaid', ?, ?, ?)`,
        [
          "dup-ob-id",
          "center-1",
          req.id,
          "grp-pr-A",
          "std-pr-1",
          req.amount,
          "dup-op-id-999",
          "2026-11-01",
          "2026-11-01",
        ],
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("6. supports optional reference month (with and without month) and keeps request active regardless of reference month", async () => {
    const withoutMonth = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "شيت قوانين بدون شهر",
      amount: 30,
      referenceMonth: "   ",
    });
    expect(withoutMonth.request.referenceMonth).toBeNull();
    expect(withoutMonth.request.status).toBe("active");

    const withPastMonth = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "بوكليت قديم",
      amount: 40,
      referenceMonth: "يناير 2020",
    });
    expect(withPastMonth.request.referenceMonth).toBe("يناير 2020");
    // Must remain active; referenceMonth is NOT an expiration date
    expect(withPastMonth.request.status).toBe("active");
    const obligations = PaymentRequestRepository.getRequestObligations(
      withPastMonth.request.id,
    );
    expect(obligations.every((o) => o.status === "unpaid")).toBe(true);
  });

  it("7. rejects empty or invalid request name", async () => {
    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "",
        amount: 50,
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "    ",
        amount: 50,
      }),
    ).rejects.toThrow("اسم المتطلب مطلوب ولا يمكن أن يكون فارغًا.");
  });

  it("8. rejects zero, negative, NaN, or excessive-decimal amounts", async () => {
    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة تجربة",
        amount: 0,
      }),
    ).rejects.toThrow("السعر يجب أن يكون رقمًا أكبر من صفر.");

    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة تجربة",
        amount: -25,
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة تجربة",
        amount: 19.999,
      }),
    ).rejects.toThrow("السعر يجب ألا يتجاوز منزلتين عشريتين.");
  });

  it("9 & 10. records a payment against the exact obligation, updates student balance, and prevents duplicate payment collection", async () => {
    const created = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة تحصيل",
      amount: 85,
      referenceMonth: "نوفمبر 2026",
    });

    const std1Ob = created.obligations.find((o) => o.studentId === "std-pr-1")!;
    expect(std1Ob).toBeDefined();

    const beforeStatus =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-1");
    const debtBefore = beforeStatus.totalRemainingDebt;

    const paymentEvent =
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
        notes: "سداد نقدي للمذكرة",
      });

    expect(paymentEvent.paymentType).toBe("payment_request");
    expect(paymentEvent.paymentRequestObligationId).toBe(std1Ob.id);
    expect(paymentEvent.paymentRequestId).toBe(created.request.id);

    const updatedOb = PaymentRequestRepository.getRequestObligations(
      created.request.id,
    ).find((o) => o.id === std1Ob.id)!;
    expect(updatedOb.status).toBe("paid");
    expect(updatedOb.amountPaid).toBe(85);
    expect(updatedOb.paymentId).toBe(paymentEvent.id);
    expect(updatedOb.paidAt).toBeTruthy();

    const afterStatus =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-1");
    expect(afterStatus.totalRemainingDebt).toBeCloseTo(debtBefore - 85, 2);

    const updatedReq = PaymentRequestRepository.getRequestById(
      created.request.id,
    )!;
    expect(updatedReq).not.toBeNull();
    expect(updatedReq.paidCount).toBe(1);
    expect(updatedReq.unpaidCount).toBe(2);

    // 10. Prevent duplicate payment collection
    await expect(
      PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
      }),
    ).rejects.toThrow(ConflictError);

    await expect(
      PaymentRepository.recordPayment({
        studentId: "std-pr-1",
        amount: 85,
        paymentMethod: "cash",
        paymentType: "payment_request",
        paymentRequestObligationId: std1Ob.id,
      }),
    ).rejects.toThrow("تم سداد هذه المطالبة مسبقًا لهذا الطالب.");
  });

  it("11 & 12. edits an unpaid request and a request with already-paid students without altering paid historical records", async () => {
    const created = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة قابلة للتعديل",
      amount: 60,
      referenceMonth: "أكتوبر 2026",
    });

    // 11. Edit while all obligations are unpaid
    const updated1 = await PaymentRequestRepository.updateRequest({
      requestId: created.request.id,
      name: "مذكرة قابلة للتعديل - نسخة 2",
      amount: 70,
      referenceMonth: "نوفمبر 2026",
    });
    expect(updated1.name).toBe("مذكرة قابلة للتعديل - نسخة 2");
    expect(updated1.amount).toBe(70);
    expect(updated1.referenceMonth).toBe("نوفمبر 2026");

    const obsAfterFirstEdit = PaymentRequestRepository.getRequestObligations(
      created.request.id,
    );
    expect(obsAfterFirstEdit.every((o) => o.amountDue === 70)).toBe(true);

    // Student 1 pays 70 EGP
    const std1Ob = obsAfterFirstEdit.find((o) => o.studentId === "std-pr-1")!;
    const payRes = await PaymentRequestRepository.recordObligationPayment({
      obligationId: std1Ob.id,
      paymentMethod: "cash",
    });
    expect(payRes.amount).toBe(70);

    // 12. Edit amount to 95 EGP after Student 1 has already paid
    const updated2 = await PaymentRequestRepository.updateRequest({
      requestId: created.request.id,
      name: "مذكرة قابلة للتعديل - نسخة 3",
      amount: 95,
      referenceMonth: "ديسمبر 2026",
    });
    expect(updated2.amount).toBe(95);
    expect(updated2.updatedBy).toBe(OWNER_USER.id);

    const obsAfterSecondEdit = PaymentRequestRepository.getRequestObligations(
      created.request.id,
    );
    const paidStudentOb = obsAfterSecondEdit.find(
      (o) => o.studentId === "std-pr-1",
    )!;
    const unpaidStudent2Ob = obsAfterSecondEdit.find(
      (o) => o.studentId === "std-pr-2",
    )!;
    const unpaidStudent3Ob = obsAfterSecondEdit.find(
      (o) => o.studentId === "std-pr-3",
    )!;

    // Paid student obligation MUST remain historically accurate at 70 EGP
    expect(paidStudentOb.status).toBe("paid");
    expect(paidStudentOb.amountDue).toBe(70);
    expect(paidStudentOb.amountPaid).toBe(70);
    expect(paidStudentOb.paymentId).toBe(payRes.id);

    // Unpaid obligations MUST update to 95 EGP
    expect(unpaidStudent2Ob.status).toBe("unpaid");
    expect(unpaidStudent2Ob.amountDue).toBe(95);
    expect(unpaidStudent3Ob.status).toBe("unpaid");
    expect(unpaidStudent3Ob.amountDue).toBe(95);
  });

  it("13. archives a request with unpaid and paid students safely (cancels unpaid debt, preserves paid history)", async () => {
    const created = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة للأرشفة",
      amount: 110,
    });

    const std1Ob = created.obligations.find((o) => o.studentId === "std-pr-1")!;
    await PaymentRequestRepository.recordObligationPayment({
      obligationId: std1Ob.id,
      paymentMethod: "cash",
    });

    const std2BeforeArchive =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-2");
    const std2DebtBefore = Number(
      std2BeforeArchive.paymentRequestsRemainingDebt ?? 0,
    );
    expect(std2DebtBefore).toBeGreaterThanOrEqual(110);

    const archived = await PaymentRequestRepository.archiveRequest({
      requestId: created.request.id,
    });
    expect(archived.status).toBe("archived");
    expect(archived.archivedBy).toBe(OWNER_USER.id);
    expect(archived.paidCount).toBe(1);
    expect(archived.unpaidCount).toBe(0);

    // Idempotent second archive call
    const archivedAgain = await PaymentRequestRepository.archiveRequest({
      requestId: created.request.id,
    });
    expect(archivedAgain.status).toBe("archived");

    const obligationsAfterArchive =
      PaymentRequestRepository.getRequestObligations(created.request.id);
    const std1After = obligationsAfterArchive.find(
      (o) => o.studentId === "std-pr-1",
    )!;
    const std2After = obligationsAfterArchive.find(
      (o) => o.studentId === "std-pr-2",
    )!;

    // Paid obligation preserved
    expect(std1After.status).toBe("paid");
    expect(std1After.amountPaid).toBe(110);

    // Unpaid obligation cancelled and removed from unpaid debt
    expect(std2After.status).toBe("cancelled");
    expect(std2After.cancelledAt).toBeTruthy();

    const std2AfterArchive =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-2");
    expect(
      Number(std2AfterArchive.paymentRequestsRemainingDebt ?? 0),
    ).toBeCloseTo(std2DebtBefore - 110, 2);
  });

  it("14. supports payment reversal and restores the student obligation to unpaid", async () => {
    const created = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة لاختبار الإلغاء",
      amount: 65,
    });

    const std2Ob = created.obligations.find((o) => o.studentId === "std-pr-2")!;
    const payRes = await PaymentRequestRepository.recordObligationPayment({
      obligationId: std2Ob.id,
      paymentMethod: "wallet",
    });

    expect(payRes.id).toBeTruthy();

    await PaymentRepository.reversePayment({
      paymentId: payRes.id,
      reason: "خطأ في اختيار الطالب أثناء التحصيل",
    });

    const obligationsAfterReversal =
      PaymentRequestRepository.getRequestObligations(created.request.id);
    const std2ObAfter = obligationsAfterReversal.find(
      (o) => o.studentId === "std-pr-2",
    )!;

    expect(std2ObAfter.status).toBe("unpaid");
    expect(std2ObAfter.amountPaid).toBe(0);
    expect(std2ObAfter.paymentId).toBeNull();
    expect(std2ObAfter.paidAt).toBeNull();

    // And the student can pay again cleanly after reversal
    const repayRes = await PaymentRequestRepository.recordObligationPayment({
      obligationId: std2Ob.id,
      paymentMethod: "cash",
    });
    expect(repayRes.id).toBeTruthy();
    const std2ObRepaid = PaymentRequestRepository.getRequestObligations(
      created.request.id,
    ).find((o) => o.studentId === "std-pr-2")!;
    expect(std2ObRepaid.status).toBe("paid");
  });

  it("15 & 16. enqueues offline sync operations and guarantees idempotency on repeated operation_id", async () => {
    const fixedOpId = "op-idempotent-req-001";
    const firstCall = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة مزامنة",
      amount: 45,
      operationId: fixedOpId,
    });

    // 16. Repeated call with the same operationId returns the existing request & obligations without duplicating
    const secondCall = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة مزامنة",
      amount: 45,
      operationId: fixedOpId,
    });

    expect(secondCall.request.id).toBe(firstCall.request.id);
    expect(secondCall.obligations).toHaveLength(firstCall.obligations.length);

    // Verify sync outbox has operations queued for offline sync
    const pendingOps = SyncRepository.getPendingOperations("center-1");
    const requestCreateOps = pendingOps.filter(
      (op) =>
        op.entityType === "payment_request" &&
        op.entityId === firstCall.request.id,
    );
    expect(requestCreateOps.length).toBe(1);

    // Idempotent payment with same operationId
    const targetOb = firstCall.obligations[0];
    const payOpId = "op-idempotent-pay-001";
    const pay1 = await PaymentRequestRepository.recordObligationPayment({
      obligationId: targetOb.id,
      paymentMethod: "cash",
      operationId: payOpId,
    });
    const pay2 = await PaymentRequestRepository.recordObligationPayment({
      obligationId: targetOb.id,
      paymentMethod: "cash",
      operationId: payOpId,
    });
    expect(pay2.id).toBe(pay1.id);
    expect(pay2.paymentRequestObligationId).toBe(
      pay1.paymentRequestObligationId,
    );
  });

  it("17. enforces strict center isolation across groups, requests, obligations, and payments", async () => {
    // Switch to center-2
    useAuthStore.setState({
      isAuthenticated: true,
      currentUser: OWNER_USER,
      activeCenterId: "center-2",
    });

    const center2Groups =
      PaymentRequestRepository.getGroupsWithStudentCounts();
    expect(center2Groups.some((g) => g.id === "grp-pr-A")).toBe(false);
    expect(center2Groups.some((g) => g.id === "grp-pr-C2")).toBe(true);

    // Center 2 cannot access Center 1 group requests
    expect(() =>
      PaymentRequestRepository.getRequestsForGroup("grp-pr-A"),
    ).toThrow(NotFoundError);

    // Center 2 cannot create a request on Center 1 group
    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "اختراق سنتر",
        amount: 50,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("18. enforces permissions for viewing, creating, editing, archiving, and collecting payments", async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      activeCenterId: "center-1",
      currentUser: {
        id: "usr-no-perm",
        fullName: "مساعد بدون صلاحيات مالية",
        phone: "01099999999",
        role: "assistant",
        centerId: "center-1",
        centerIds: ["center-1"],
        permissions: ["attendance.view"],
      },
    });

    expect(() =>
      PaymentRequestRepository.getGroupsWithStudentCounts(),
    ).toThrow(ForbiddenError);

    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة غير مصرحة",
        amount: 50,
      }),
    ).rejects.toThrow(ForbiddenError);

    // User with view-only permission can view but cannot create/edit/archive
    useAuthStore.setState({
      isAuthenticated: true,
      activeCenterId: "center-1",
      currentUser: {
        id: "usr-view-only",
        fullName: "مستخدم عرض فقط",
        phone: "01088888888",
        role: "assistant",
        centerId: "center-1",
        centerIds: ["center-1"],
        permissions: ["payments.view"],
      },
    });

    expect(
      PaymentRequestRepository.getGroupsWithStudentCounts().length,
    ).toBeGreaterThan(0);

    await expect(
      PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة غير مصرحة",
        amount: 50,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("19. preserves existing monthly subscriptions, debt cycles, credit balances, and audit logs without interference", async () => {
    const statusBefore =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-1");
    expect(statusBefore.cycles.length).toBeGreaterThan(0);
    const cycleBefore = statusBefore.cycles[0];
    const monthlyRemainingBefore = statusBefore.monthlyRemainingDebt;

    // Create and pay a payment request for std-pr-1
    const reqRes = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "بوكليت امتحانات شاملة",
      amount: 120,
    });
    const std1Ob = reqRes.obligations.find((o) => o.studentId === "std-pr-1")!;
    await PaymentRequestRepository.recordObligationPayment({
      obligationId: std1Ob.id,
      paymentMethod: "cash",
    });

    const statusAfter =
      FinancialCalculationService.getStudentFinancialStatus("std-pr-1");
    const cycleAfter = statusAfter.cycles.find(
      (c) => c.id === cycleBefore.id,
    )!;

    // Monthly debt cycle and creditBalance MUST remain untouched by payment_request payments
    expect(cycleAfter.paidAmount).toBe(cycleBefore.paidAmount);
    expect(cycleAfter.remainingDebt).toBe(cycleBefore.remainingDebt);
    expect(statusAfter.monthlyRemainingDebt).toBe(monthlyRemainingBefore);
    expect(statusAfter.creditBalance).toBe(statusBefore.creditBalance);

    // Audit log entries exist for payment request actions
    const logs = AuditService.getLogs("center-1", 50);
    expect(
      logs.some((l) => l.action === "payment_request.create"),
    ).toBe(true);
  });

  it("20. handles student enrollment changes after request creation properly", async () => {
    const created = await PaymentRequestRepository.createRequest({
      groupId: "grp-pr-A",
      name: "مذكرة قبل تغير التسجيل",
      amount: 55,
    });

    const db = DatabaseService.getDb();

    // Case A: Student (std-pr-late) enrolls in grp-pr-A AFTER the request was created
    db.runSync(
      `INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, billing_type, monthly_price, created_at)
       VALUES (?, 'center-1', 'std-pr-late', 'grp-pr-A', '2026-11-05', 'active', 'monthly', 300, '2026-11-05')`,
      ["enr-pr-late"],
    );

    // Late-enrolled student must NOT automatically receive the old request
    const lateStudentObligations =
      PaymentRequestRepository.getStudentObligations("std-pr-late");
    expect(
      lateStudentObligations.some((o) => o.requestId === created.request.id),
    ).toBe(false);

    // Case B: Student (std-pr-2) leaves grp-pr-A AFTER the request was created
    db.runSync(
      `UPDATE student_group_enrollments SET status = 'ended', end_date = '2026-11-06' WHERE id = ?`,
      ["enr-pr-2"],
    );

    // Student leaving the group after creation must NOT lose an already-created obligation
    const std2Obligations =
      PaymentRequestRepository.getStudentObligations("std-pr-2");
    expect(
      std2Obligations.some((o) => o.requestId === created.request.id),
    ).toBe(true);

    // Restore enrollments back to initial state for subsequent tests
    db.runSync(`DELETE FROM student_group_enrollments WHERE id = ?`, [
      "enr-pr-late",
    ]);
    db.runSync(
      `UPDATE student_group_enrollments SET status = 'active', end_date = NULL WHERE id = ?`,
      ["enr-pr-2"],
    );
  });

  describe("Payment Request Details & Collection Statistics (تفاصيل المتطلب وإحصائيات التحصيل)", () => {
    it("21. calculates accurate total students, paid/unpaid counts, collected/outstanding amounts, and collection percentage across payment stages", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة المراجعة الشاملة - إحصائيات",
        amount: 100,
        referenceMonth: "نوفمبر 2026",
      });

      // Stage 0: 0 of 3 students paid
      const details0 = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(details0.request.name).toBe("مذكرة المراجعة الشاملة - إحصائيات");
      expect(details0.request.amount).toBe(100);
      expect(details0.request.groupName).toBe("مجموعة الفيزياء A");
      expect(details0.request.referenceMonth).toBe("نوفمبر 2026");

      expect(details0.statistics.totalStudents).toBe(3);
      expect(details0.statistics.paidStudentsCount).toBe(0);
      expect(details0.statistics.unpaidStudentsCount).toBe(3);
      expect(details0.statistics.totalExpectedAmount).toBe(300);
      expect(details0.statistics.totalCollectedAmount).toBe(0);
      expect(details0.statistics.totalOutstandingAmount).toBe(300);
      expect(details0.statistics.collectionPercentage).toBe(0);

      // Stage 1: 1 of 3 students pays full 100 EGP
      const std1Ob = details0.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
      });

      const details1 = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(details1.statistics.totalStudents).toBe(3);
      expect(details1.statistics.paidStudentsCount).toBe(1);
      expect(details1.statistics.unpaidStudentsCount).toBe(2);
      expect(details1.statistics.totalCollectedAmount).toBe(100);
      expect(details1.statistics.totalOutstandingAmount).toBe(200);
      expect(details1.statistics.collectionPercentage).toBe(33.33);

      // Stage 2: 2 of 3 students pay
      const std2Ob = details1.obligations.find(
        (o) => o.studentId === "std-pr-2",
      )!;
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std2Ob.id,
        paymentMethod: "wallet",
      });

      const details2 = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(details2.statistics.paidStudentsCount).toBe(2);
      expect(details2.statistics.unpaidStudentsCount).toBe(1);
      expect(details2.statistics.totalCollectedAmount).toBe(200);
      expect(details2.statistics.totalOutstandingAmount).toBe(100);
      expect(details2.statistics.collectionPercentage).toBe(66.67);

      // Stage 3: All 3 students paid
      const std3Ob = details2.obligations.find(
        (o) => o.studentId === "std-pr-3",
      )!;
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std3Ob.id,
        paymentMethod: "instapay",
      });

      const details3 = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(details3.statistics.paidStudentsCount).toBe(3);
      expect(details3.statistics.unpaidStudentsCount).toBe(0);
      expect(details3.statistics.totalCollectedAmount).toBe(300);
      expect(details3.statistics.totalOutstandingAmount).toBe(0);
      expect(details3.statistics.collectionPercentage).toBe(100);
    });

    it("22. switches cleanly between 'all' (الكل), 'paid' (دفعوا), and 'unpaid' (لم يدفعوا) filters and updates displayedCount", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة اختبار الفلاتر",
        amount: 80,
      });

      // Pay for std-pr-1 only
      const std1Ob = created.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
      });

      // Filter 1: 'all' (الكل)
      const allView = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { filter: "all" },
      );
      expect(allView.activeFilter).toBe("all");
      expect(allView.displayedCount).toBe(3);
      expect(allView.obligations).toHaveLength(3);

      // Filter 2: 'paid' (دفعوا)
      const paidView = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { filter: "paid" },
      );
      expect(paidView.activeFilter).toBe("paid");
      expect(paidView.displayedCount).toBe(1);
      expect(paidView.obligations).toHaveLength(1);
      expect(paidView.obligations[0].studentId).toBe("std-pr-1");
      expect(paidView.obligations[0].isPaid).toBe(true);
      expect(paidView.obligations[0].amountOwed).toBe(0);
      expect(paidView.obligations[0].paidAt).toBeTruthy();

      // Filter 3: 'unpaid' (لم يدفعوا)
      const unpaidView = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { filter: "unpaid" },
      );
      expect(unpaidView.activeFilter).toBe("unpaid");
      expect(unpaidView.displayedCount).toBe(2);
      expect(unpaidView.obligations).toHaveLength(2);
      expect(
        unpaidView.obligations.map((o) => o.studentId).sort(),
      ).toEqual(["std-pr-2", "std-pr-3"]);
      expect(unpaidView.obligations.every((o) => !o.isPaid)).toBe(true);
      expect(unpaidView.obligations.every((o) => o.amountOwed === 80)).toBe(
        true,
      );

      // Overall statistics remain invariant regardless of active filter
      expect(paidView.statistics.totalStudents).toBe(3);
      expect(paidView.statistics.paidStudentsCount).toBe(1);
      expect(paidView.statistics.unpaidStudentsCount).toBe(2);
    });

    it("23. searches students by name or student code strictly within the current payment request and never leaks students from other groups or centers", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة اختبار البحث",
        amount: 75,
      });

      // Search by Arabic student name ("سارة")
      const byName = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { searchQuery: "سارة" },
      );
      expect(byName.displayedCount).toBe(1);
      expect(byName.obligations[0].studentId).toBe("std-pr-2");
      expect(byName.obligations[0].studentName).toContain("سارة خالد");

      // Search by student code ("STD-PR-003" / case-insensitive "std-pr-003")
      const byCode = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { searchQuery: "std-pr-003" },
      );
      expect(byCode.displayedCount).toBe(1);
      expect(byCode.obligations[0].studentId).toBe("std-pr-3");
      expect(byCode.obligations[0].studentCode).toBe("STD-PR-003");

      // Search for a student in another group ("يوسف سمير" / "STD-PR-004" in grp-pr-B) -> MUST return 0
      const otherGroupSearch = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { searchQuery: "يوسف" },
      );
      expect(otherGroupSearch.displayedCount).toBe(0);
      expect(otherGroupSearch.obligations).toHaveLength(0);

      // Search for a student in another center ("طالب سنتر 2" / "STD-PR-C2") -> MUST return 0
      const otherCenterSearch = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { searchQuery: "STD-PR-C2" },
      );
      expect(otherCenterSearch.displayedCount).toBe(0);
      expect(otherCenterSearch.obligations).toHaveLength(0);
    });

    it("24. represents partial payments accurately and updates statistics upon full completion", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة السداد الجزئي",
        amount: 100,
      });

      const std1Ob = created.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;

      // Student 1 pays a partial amount of 40 EGP out of 100 EGP
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        amount: 40,
        paymentMethod: "cash",
      });

      const afterPartial = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      const std1Partial = afterPartial.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;

      // Partially paid student is NOT marked as fully paid yet, owes 60 EGP, and 40 EGP is counted in collected amount
      expect(std1Partial.confirmedAmountPaid).toBe(40);
      expect(std1Partial.amountPaid).toBe(40);
      expect(std1Partial.amountOwed).toBe(60);
      expect(std1Partial.isPaid).toBe(false);
      expect(std1Partial.isPartiallyPaid).toBe(true);
      expect(std1Partial.status).toBe("unpaid");

      expect(afterPartial.statistics.paidStudentsCount).toBe(0);
      expect(afterPartial.statistics.unpaidStudentsCount).toBe(3);
      expect(afterPartial.statistics.totalCollectedAmount).toBe(40);
      expect(afterPartial.statistics.totalOutstandingAmount).toBe(260);
      expect(afterPartial.statistics.collectionPercentage).toBe(13.33);

      // Partially paid student appears under 'unpaid' (لم يدفعوا) filter until fully paid
      const unpaidList = PaymentRequestRepository.getRequestDetails(
        created.request.id,
        { filter: "unpaid" },
      );
      expect(
        unpaidList.obligations.some((o) => o.studentId === "std-pr-1"),
      ).toBe(true);

      // Student 1 pays remaining 60 EGP
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        amount: 60,
        paymentMethod: "cash",
      });

      const afterFull = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      const std1Full = afterFull.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      expect(std1Full.confirmedAmountPaid).toBe(100);
      expect(std1Full.amountOwed).toBe(0);
      expect(std1Full.isPaid).toBe(true);
      expect(std1Full.isPartiallyPaid).toBe(false);
      expect(std1Full.status).toBe("paid");

      expect(afterFull.statistics.paidStudentsCount).toBe(1);
      expect(afterFull.statistics.unpaidStudentsCount).toBe(2);
      expect(afterFull.statistics.totalCollectedAmount).toBe(100);
      expect(afterFull.statistics.totalOutstandingAmount).toBe(200);
      expect(afterFull.statistics.collectionPercentage).toBe(33.33);
    });

    it("25. updates collection statistics immediately when a confirmed payment is reversed", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة إحصائيات الاسترداد",
        amount: 150,
      });

      const std1Ob = created.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      const std2Ob = created.obligations.find(
        (o) => o.studentId === "std-pr-2",
      )!;

      const pay1 = await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
      });
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std2Ob.id,
        paymentMethod: "wallet",
      });

      const statsBeforeReversal = PaymentRequestRepository.getRequestStatistics(
        created.request.id,
      );
      expect(statsBeforeReversal.paidStudentsCount).toBe(2);
      expect(statsBeforeReversal.unpaidStudentsCount).toBe(1);
      expect(statsBeforeReversal.totalCollectedAmount).toBe(300);
      expect(statsBeforeReversal.totalOutstandingAmount).toBe(150);
      expect(statsBeforeReversal.collectionPercentage).toBe(66.67);

      // Reverse payment 1
      await PaymentRepository.reversePayment({
        paymentId: pay1.id,
        reason: "إلغاء تحصيل مذكرة بالخطأ",
      });

      const detailsAfterReversal = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(detailsAfterReversal.statistics.paidStudentsCount).toBe(1);
      expect(detailsAfterReversal.statistics.unpaidStudentsCount).toBe(2);
      expect(detailsAfterReversal.statistics.totalCollectedAmount).toBe(150);
      expect(detailsAfterReversal.statistics.totalOutstandingAmount).toBe(300);
      expect(detailsAfterReversal.statistics.collectionPercentage).toBe(33.33);

      const std1After = detailsAfterReversal.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      expect(std1After.isPaid).toBe(false);
      expect(std1After.amountOwed).toBe(150);
      expect(std1After.confirmedAmountPaid).toBe(0);
    });

    it("26. never counts an unpaid obligation as paid merely because a sync operation is queued without a confirmed payment row, and avoids duplicate counting after sync", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة التحقق من المزامنة",
        amount: 90,
      });

      const std1Ob = created.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;

      // Enqueue a pending sync operation in sync_operations WITHOUT a confirmed payment row in `payments`
      SyncRepository.enqueueOperation({
        operationId: "op-queued-only-unconfirmed-999",
        centerId: "center-1",
        userId: OWNER_USER.id,
        deviceId: "dev-test-1",
        operationType: "payment.record",
        entityType: "payment",
        entityId: "fake-unconfirmed-pay-id",
        payload: {
          id: "fake-unconfirmed-pay-id",
          studentId: "std-pr-1",
          amount: 90,
          paymentSource: "payment_request",
          paymentRequestObligationId: std1Ob.id,
        },
      });

      // Even if obligation table row was somehow corrupted to 'paid' without a confirmed payment row:
      const db = DatabaseService.getDb();
      db.runSync(
        `UPDATE student_payment_request_obligations SET status = 'paid', amount_paid = 90 WHERE id = ?`,
        [std1Ob.id],
      );

      // Statistics & details MUST derive strictly from confirmed rows in `payments`
      const detailsUnconfirmed = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      const std1Unconfirmed = detailsUnconfirmed.obligations.find(
        (o) => o.studentId === "std-pr-1",
      )!;
      expect(std1Unconfirmed.isPaid).toBe(false);
      expect(std1Unconfirmed.status).toBe("unpaid");
      expect(std1Unconfirmed.confirmedAmountPaid).toBe(0);
      expect(std1Unconfirmed.amountOwed).toBe(90);
      expect(detailsUnconfirmed.statistics.paidStudentsCount).toBe(0);
      expect(detailsUnconfirmed.statistics.totalCollectedAmount).toBe(0);

      // Reset obligation status and record a real confirmed payment with an operationId
      db.runSync(
        `UPDATE student_payment_request_obligations SET status = 'unpaid', amount_paid = 0 WHERE id = ?`,
        [std1Ob.id],
      );

      const syncOpId = "op-confirmed-sync-dedup-001";
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
        operationId: syncOpId,
      });

      // Repeat call with same operationId (simulating offline sync replay)
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: std1Ob.id,
        paymentMethod: "cash",
        operationId: syncOpId,
      });

      const detailsAfterSync = PaymentRequestRepository.getRequestDetails(
        created.request.id,
      );
      expect(detailsAfterSync.statistics.paidStudentsCount).toBe(1);
      expect(detailsAfterSync.statistics.totalCollectedAmount).toBe(90);
      expect(detailsAfterSync.statistics.totalOutstandingAmount).toBe(180);
      expect(detailsAfterSync.statistics.collectionPercentage).toBe(33.33);
    });

    it("27. enforces center isolation on getRequestDetails and getRequestStatistics", async () => {
      const created = await PaymentRequestRepository.createRequest({
        groupId: "grp-pr-A",
        name: "مذكرة عزل المراكز - تفاصيل",
        amount: 70,
      });

      // Switch to center-2
      useAuthStore.setState({
        isAuthenticated: true,
        currentUser: OWNER_USER,
        activeCenterId: "center-2",
      });

      expect(() =>
        PaymentRequestRepository.getRequestDetails(created.request.id),
      ).toThrow(NotFoundError);

      expect(() =>
        PaymentRequestRepository.getRequestStatistics(created.request.id),
      ).toThrow(NotFoundError);
    });
  });
});

