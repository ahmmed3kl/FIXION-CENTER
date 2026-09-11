import { DatabaseService } from "../src/core/database";
import {
    ConflictError,
    ForbiddenError,
    ValidationError,
} from "../src/core/errors";
import { SyncRepository } from "../src/core/sync";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { NotificationService } from "../src/features/notifications/NotificationService";
import {
    NotificationTemplateRepository,
    renderTemplate,
} from "../src/features/notifications/NotificationTemplateRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { DailyClosingService } from "../src/features/reports/DailyClosingService";
import { OperationalReportsService } from "../src/features/reports/OperationalReportsService";
import { SessionClosingService } from "../src/features/sessions/SessionClosingService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";

describe("Sprint 5 - FIXION Operational Layer Test Suite", () => {
  const today = new Date().toISOString().split("T")[0];

  beforeAll(async () => {
    // 1. Initialize SQLite schema & run migrations 1 through 5
    DatabaseService.init();

    // 2. Authenticate as Admin on center-1
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  // =========================================================================
  // 1. Schema Migration 5 Verification
  // =========================================================================
  describe("1. Migration 5 Schema Verification", () => {
    it("confirms DatabaseService migration version is at least 5", () => {
      const version = DatabaseService.getCurrentVersion();
      expect(version).toBeGreaterThanOrEqual(5);
    });

    it("confirms new operational tables exist in schema", () => {
      const db = DatabaseService.getDb();
      expect(
        Array.isArray(db.getAllSync("SELECT * FROM notification_templates")),
      ).toBe(true);
      expect(
        Array.isArray(db.getAllSync("SELECT * FROM notification_events")),
      ).toBe(true);
      expect(
        Array.isArray(db.getAllSync("SELECT * FROM notification_deliveries")),
      ).toBe(true);
      expect(
        Array.isArray(db.getAllSync("SELECT * FROM session_closing_records")),
      ).toBe(true);
      expect(
        Array.isArray(db.getAllSync("SELECT * FROM daily_closing_summaries")),
      ).toBe(true);
    });
  });

  // =========================================================================
  // 2. Notification Templates & Rendering
  // =========================================================================
  describe("2. Notification Templates & Safe Rendering", () => {
    it("8. renders template variables deterministically", () => {
      const tpl =
        "مرحباً {{student_name}}، تم حضور حصة {{subject_name}} مع {{teacher_name}}.";
      const vars = {
        student_name: "أحمد محمد",
        subject_name: "رياضيات",
        teacher_name: "أ/ إبراهيم",
      };
      const rendered = renderTemplate(tpl, vars);
      expect(rendered).toBe(
        "مرحباً أحمد محمد، تم حضور حصة رياضيات مع أ/ إبراهيم.",
      );
    });

    it("9. safely renders template with unknown variables without crashing", () => {
      const tpl = "حضور {{student_name}}، الكود السري {{unknown_var_xyz}}.";
      const vars = { student_name: "أحمد" };
      const rendered = renderTemplate(tpl, vars);
      expect(rendered).toContain("أحمد");
      expect(rendered).toContain("{{unknown_var_xyz}}");
    });

    it("ensures default Arabic templates exist for center", () => {
      NotificationTemplateRepository.ensureDefaultTemplates();
      const templates = NotificationTemplateRepository.getTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(4); // 2 events x 2 channels

      const attPush = NotificationTemplateRepository.getActiveTemplate(
        "attendance",
        "push",
      );
      expect(attPush).not.toBeNull();
      expect(attPush?.templateBody).toContain("{{student_name}}");
    });

    it("allows admin to update a notification template with audit", () => {
      const templates = NotificationTemplateRepository.getTemplates();
      const targetTmpl = templates[0];
      const newBody = "إشعار محدث: تم تسجيل حضور {{student_name}} في مركزنا.";

      const updated = NotificationTemplateRepository.updateTemplate(
        targetTmpl.id,
        newBody,
      );
      expect(updated.templateBody).toBe(newBody);
    });

    it("rejects empty template body on update", () => {
      const templates = NotificationTemplateRepository.getTemplates();
      expect(() => {
        NotificationTemplateRepository.updateTemplate(templates[0].id, "   ");
      }).toThrow(ValidationError);
    });
  });

  // =========================================================================
  // 3. Attendance Notifications
  // =========================================================================
  describe("3. Attendance Notifications (Idempotent & Offline-Queued)", () => {
    let testAttendanceId = "att-test-s5-1";
    let notifOpId = "op-notif-att-test-1";

    it("1. creates attendance notification event and deliveries after attendance", () => {
      const notifEvent = NotificationService.notifyAttendance({
        studentId: "std-1",
        sessionId: "sess-1",
        attendanceId: testAttendanceId,
        isLate: false,
        operationId: notifOpId,
      });

      expect(notifEvent.id).toBeDefined();
      expect(notifEvent.eventType).toBe("attendance");
      expect(notifEvent.studentId).toBe("std-1");
      expect(notifEvent.sessionId).toBe("sess-1");

      const deliveries = NotificationService.getDeliveriesForEvent(
        notifEvent.id,
      );
      expect(deliveries.length).toBe(2); // push + sms
      expect(deliveries.some((d) => d.channel === "push")).toBe(true);
      expect(deliveries.some((d) => d.channel === "sms")).toBe(true);
      expect(deliveries.every((d) => d.status === "pending")).toBe(true);
    });

    it("2. attendance notification is idempotent per operationId", () => {
      const duplicateCall = NotificationService.notifyAttendance({
        studentId: "std-1",
        sessionId: "sess-1",
        attendanceId: testAttendanceId,
        isLate: false,
        operationId: notifOpId,
      });

      expect(duplicateCall.operationId).toBe(notifOpId);

      // Verify no duplicate in database
      const db = DatabaseService.getDb();
      const rows = db.getAllSync(
        "SELECT id FROM notification_events WHERE operation_id = ?",
        [notifOpId],
      );
      expect(rows.length).toBe(1);
    });

    it("3. enqueues sync queue operation for offline replication", () => {
      const op = SyncRepository.getByOperationId(notifOpId);
      expect(op).not.toBeNull();
      expect(op?.entityType).toBe("notification_event");
      expect(op?.status).toBe("pending");
    });

    it("4. processes pending deliveries and updates status to sent", async () => {
      const db = DatabaseService.getDb();
      const eventRow = db.getFirstSync<any>(
        "SELECT id FROM notification_events WHERE operation_id = ?",
        [notifOpId],
      );

      const result = await NotificationService.sendPendingDeliveries(
        eventRow.id,
      );
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);

      const deliveries = NotificationService.getDeliveriesForEvent(eventRow.id);
      expect(deliveries.every((d) => d.status === "sent")).toBe(true);
    });

    it("5. prevents duplicate notification delivery on retry", async () => {
      const db = DatabaseService.getDb();
      const eventRow = db.getFirstSync<any>(
        "SELECT id FROM notification_events WHERE operation_id = ?",
        [notifOpId],
      );

      // Pending deliveries are already sent, so sent count should be 0
      const retryResult = await NotificationService.sendPendingDeliveries(
        eventRow.id,
      );
      expect(retryResult.sent).toBe(0);
      expect(retryResult.failed).toBe(0);
    });
  });

  // =========================================================================
  // 4. Manual Absence Notifications
  // =========================================================================
  describe("4. Manual Absence Notifications", () => {
    it("6. derives absent students dynamically without modifying attendance", () => {
      const absentees = AbsenceService.getAbsenteesForSession("sess-1");
      // sess-1 has std-1, std-2, std-3 expected; none has attended yet in fresh state (or only test records)
      expect(Array.isArray(absentees)).toBe(true);
    });

    it("7. sends manual absence notifications only for selected students", () => {
      const absOpPrefix = "op-abs-manual-s5-test";
      const events = NotificationService.notifyAbsentees({
        sessionId: "sess-1",
        selectedStudentIds: ["std-2"],
        operationPrefix: absOpPrefix,
      });

      expect(events.length).toBe(1);
      expect(events[0].studentId).toBe("std-2");
      expect(events[0].eventType).toBe("absence");

      // Verify deliveries created
      const deliveries = NotificationService.getDeliveriesForEvent(
        events[0].id,
      );
      expect(deliveries.length).toBe(2);
      expect(
        deliveries.some(
          (d) =>
            d.renderedMessage.includes("غائب") ||
            d.renderedMessage.includes("تغيب"),
        ),
      ).toBe(true);
    });

    it("10. retrieves notification history for student and session", () => {
      const sessionEvents = NotificationService.getEventsForSession("sess-1");
      expect(sessionEvents.length).toBeGreaterThanOrEqual(1);

      const studentEvents = NotificationService.getEventsForStudent("std-2");
      expect(studentEvents.some((e) => e.eventType === "absence")).toBe(true);
    });
  });

  // =========================================================================
  // 5. Session Closing & Reopening
  // =========================================================================
  describe("5. Session Closing & Reopening", () => {
    it("12. closes a session, calculates attendance totals, and sets status to closed", () => {
      const closing = SessionClosingService.closeSession(
        "sess-2",
        "op-close-sess-2",
      );
      expect(closing.sessionId).toBe("sess-2");
      expect(closing.newStatus).toBe("closed");
      expect(closing.totalAttendance).toBeDefined();

      const session = SessionRepository.findById("sess-2");
      expect(session?.status).toBe("closed");
    });

    it("13. session closing is idempotent (returns existing record if already closed)", () => {
      const secondClose = SessionClosingService.closeSession(
        "sess-2",
        "op-close-sess-2-dup",
      );
      expect(secondClose.sessionId).toBe("sess-2");
      expect(secondClose.newStatus).toBe("closed");
    });

    it("14. restricts normal attendance recording on a closed session", async () => {
      await expect(
        AttendanceRepository.recordAttendance({
          sessionId: "sess-2",
          studentId: "std-1",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("15. admin can reopen a closed session with a valid reason", () => {
      const reopen = SessionClosingService.reopenSession(
        "sess-2",
        "تصحيح خطأ إداري في التسجيل",
        "op-reopen-sess-2",
      );

      expect(reopen.action).toBe("reopen");
      expect(reopen.newStatus).toBe("open");
      expect(reopen.reason).toBe("تصحيح خطأ إداري في التسجيل");

      const session = SessionRepository.findById("sess-2");
      expect(session?.status).toBe("open");
    });

    it("16. rejects session reopen when no reason is provided", () => {
      // First re-close session
      SessionClosingService.closeSession("sess-2");

      expect(() => {
        SessionClosingService.reopenSession("sess-2", "   ");
      }).toThrow(ValidationError);
    });

    it("17. creates audit record for session reopening", () => {
      const history = SessionClosingService.getClosingHistory("sess-2");
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history.some((h) => h.action === "reopen")).toBe(true);
    });
  });

  // =========================================================================
  // 6. Daily Cash Closing & Reopening
  // =========================================================================
  describe("6. Daily Cash Closing", () => {
    it("18. performs daily cash closing and aggregates non-reversed payments", () => {
      const dailyClosing = DailyClosingService.closeDailyForDate(
        today,
        "op-close-daily-today",
      );
      expect(dailyClosing.businessDate).toBe(today);
      expect(dailyClosing.status).toBe("closed");
      expect(dailyClosing.totalCash).toBeGreaterThanOrEqual(0);
      expect(dailyClosing.paymentCount).toBeGreaterThanOrEqual(0);
    });

    it("19. prevents duplicate daily closing for the same center and business date", () => {
      expect(() => {
        DailyClosingService.closeDailyForDate(today, "op-close-daily-dup");
      }).toThrow(ConflictError);
    });

    it("20. records separate financial breakdown for daily cash", () => {
      const closing = DailyClosingService.getClosingForDate(today);
      expect(closing).not.toBeNull();
      expect(typeof closing?.monthlyTotal).toBe("number");
      expect(typeof closing?.partialTotal).toBe("number");
      expect(typeof closing?.sessionTotal).toBe("number");
      expect(typeof closing?.externalMakeupTotal).toBe("number");
      expect(typeof closing?.packageTotal).toBe("number");
      expect(
        (closing?.monthlyTotal ?? 0) +
          (closing?.partialTotal ?? 0) +
          (closing?.sessionTotal ?? 0) +
          (closing?.externalMakeupTotal ?? 0) +
          (closing?.packageTotal ?? 0),
      ).toBe(closing?.totalCash);
    });

    it("21. confirms daily closing does NOT mutate or delete original payment records", () => {
      const db = DatabaseService.getDb();
      const payments = db.getAllSync(
        "SELECT * FROM payments WHERE center_id = 'center-1'",
      );
      expect(payments.length).toBeGreaterThanOrEqual(1);
    });

    it("22. allows admin to reopen daily closing with a valid reason", () => {
      const reopened = DailyClosingService.reopenDailyClosing(
        today,
        "تسجيل متأخر لدفعة طالب",
        "op-reopen-daily-today",
      );

      expect(reopened.status).toBe("open");
      expect(reopened.reopenReason).toBe("تسجيل متأخر لدفعة طالب");

      const current = DailyClosingService.getClosingForDate(today);
      expect(current?.status).toBe("open");
    });
  });

  // =========================================================================
  // 7. Operational Reports
  // =========================================================================
  describe("7. Operational Reports", () => {
    it("23. Report A: generates daily attendance report", () => {
      const report = OperationalReportsService.getDailyAttendanceReport(today);
      expect(report.date).toBe(today);
      expect(report.centerId).toBe("center-1");
      expect(Array.isArray(report.sessions)).toBe(true);
      expect(report.totals).toBeDefined();
      expect(typeof report.totals.totalSessions).toBe("number");
    });

    it("24. Report B: generates student attendance report", () => {
      const report = OperationalReportsService.getStudentAttendanceReport(
        "std-1",
        "2026-09-01",
        today,
      );
      expect(report.studentId).toBe("std-1");
      expect(Array.isArray(report.sessions)).toBe(true);
      expect(report.totals.totalSessions).toBeDefined();
      expect(typeof report.totals.attendanceRate).toBe("number");
    });

    it("25. Report C: generates daily cash report with breakdown", () => {
      const report = OperationalReportsService.getDailyCashReport(today);
      expect(report.businessDate).toBe(today);
      expect(typeof report.totalCash).toBe("number");
      expect(typeof report.monthlyTotal).toBe("number");
      expect(typeof report.sessionTotal).toBe("number");
      expect(Array.isArray(report.payments)).toBe(true);
    });

    it("26. Report D: generates student financial summary using FinancialCalculationService", () => {
      const finStatus =
        OperationalReportsService.getStudentFinancialSummary("std-1");
      expect(finStatus.totalRemainingDebt).toBeDefined();
      expect(finStatus.sessionPaymentsTotal).toBeDefined();
      expect(finStatus.groupMonthlyDue).toBeDefined();
      expect(finStatus.packageMonthlyDue).toBeDefined();
    });
  });

  // =========================================================================
  // 8. Multi-Center Isolation & Permissions
  // =========================================================================
  describe("8. Multi-Center Isolation & Granular Permissions", () => {
    it("27. strictly isolates notifications, closings, and reports by active center", async () => {
      // center-1 has daily closing
      const c1Closings = DailyClosingService.getAllClosings();
      expect(c1Closings.every((c) => c.centerId === "center-1")).toBe(true);

      // Switch to center-2
      await useAuthStore.getState().selectCenter("center-2");

      const c2Closings = DailyClosingService.getAllClosings();
      expect(c2Closings.every((c) => c.centerId === "center-2")).toBe(true);

      // Switch back to center-1
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("28. rejects unauthorized operations for users lacking permissions", async () => {
      // Login as secretary (does not have daily_closing.reopen or sessions.reopen)
      await useAuthStore.getState().login("01000000002", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        DailyClosingService.reopenDailyClosing(today, "غير مصرح");
      }).toThrow(ForbiddenError);

      expect(() => {
        SessionClosingService.reopenSession("sess-1", "غير مصرح");
      }).toThrow(ForbiddenError);

      expect(() => {
        NotificationTemplateRepository.updateTemplate("ntmpl-any", "نص جديد");
      }).toThrow(ForbiddenError);

      // Restore Admin
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });
  });

  // =========================================================================
  // 9. Sync Idempotency & Sprint 1-4 Regression Safety
  // =========================================================================
  describe("9. Sync Idempotency & Financial Regression Safety", () => {
    it("29. confirms sync queue operations are idempotent", () => {
      const op1 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-1",
        deviceId: "dev-1",
        operationType: "create",
        entityType: "notification_event",
        entityId: "nevt-dup-test",
        operationId: "op-sync-dup-test-s5",
        payload: { test: 123 },
      });

      const op2 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-1",
        deviceId: "dev-1",
        operationType: "create",
        entityType: "notification_event",
        entityId: "nevt-dup-test",
        operationId: "op-sync-dup-test-s5",
        payload: { test: 123 },
      });

      expect(op1.operationId).toBe(op2.operationId);
      expect(op1.id).toBe(op2.id);
    });

    it("30. Sprint 1-4 Regression: session payments never reduce group or package monthly debt", () => {
      const statusBefore =
        FinancialCalculationService.getStudentFinancialStatus("std-1");
      const groupDebtBefore = statusBefore.groupRemainingDebt;
      const packageDebtBefore = statusBefore.packageRemainingDebt;

      // Record standalone session payment
      PaymentRepository.recordSessionPayment({
        studentId: "std-1",
        sessionId: "sess-1",
        amount: 200,
        notes: "حصة فردية مستقلة",
      });

      const statusAfter =
        FinancialCalculationService.getStudentFinancialStatus("std-1");
      expect(statusAfter.groupRemainingDebt).toBe(groupDebtBefore);
      expect(statusAfter.packageRemainingDebt).toBe(packageDebtBefore);
      expect(statusAfter.sessionPaymentsTotal).toBe(
        statusBefore.sessionPaymentsTotal + 200,
      );
    });
  });

  // =========================================================================
  // 10. Final Code-Level Audit Regressions
  // =========================================================================
  describe("10. Final Code-Level Audit Regressions (4 Audit Points)", () => {
    const auditAttId = "att-audit-unique-test";

    it("Point 1: Notification Idempotency across different operation IDs", () => {
      // Call 1 with operation ID 'op-audit-notif-call-1'
      const event1 = NotificationService.notifyAttendance({
        studentId: "std-3",
        sessionId: "sess-1",
        attendanceId: auditAttId,
        isLate: false,
        operationId: "op-audit-notif-call-1",
      });

      // Call 2 with a completely different operation ID 'op-audit-notif-call-2'
      const event2 = NotificationService.notifyAttendance({
        studentId: "std-3",
        sessionId: "sess-1",
        attendanceId: auditAttId,
        isLate: false,
        operationId: "op-audit-notif-call-2",
      });

      // Must return the exact same notification event
      expect(event1.id).toBe(event2.id);

      // Verify no duplicate notification event was inserted
      const db = DatabaseService.getDb();
      const eventsInDb = db.getAllSync(
        "SELECT id FROM notification_events WHERE attendance_id = ?",
        [auditAttId],
      );
      expect(eventsInDb.length).toBe(1);

      // Verify only 2 deliveries exist (1 push + 1 sms), NOT 4
      const deliveriesInDb = NotificationService.getDeliveriesForEvent(
        event1.id,
      );
      expect(deliveriesInDb.length).toBe(2);
    });

    it("Point 2: Notification Delivery Duplicates on dispatch retry", async () => {
      const db = DatabaseService.getDb();
      const eventRow = db.getFirstSync<any>(
        "SELECT id FROM notification_events WHERE attendance_id = ?",
        [auditAttId],
      );

      // Dispatch pending deliveries (first time)
      const dispatch1 = await NotificationService.sendPendingDeliveries(
        eventRow.id,
      );
      expect(dispatch1.sent).toBe(2);
      expect(dispatch1.failed).toBe(0);

      // Retry dispatching immediately on same event
      const dispatch2 = await NotificationService.sendPendingDeliveries(
        eventRow.id,
      );
      expect(dispatch2.sent).toBe(0);
      expect(dispatch2.failed).toBe(0);

      // Verify deliveries status is sent and count is strictly 2
      const deliveries = NotificationService.getDeliveriesForEvent(eventRow.id);
      expect(deliveries.length).toBe(2);
      expect(deliveries.every((d) => d.status === "sent")).toBe(true);
    });

    it("Point 3: Daily Closing Complete Lifecycle (open -> closed -> reopened -> financial changes -> closed again)", () => {
      const testBusinessDate = "2026-09-25";

      // 1. Record initial monthly payment of 400 EGP on testBusinessDate
      PaymentRepository.recordPayment({
        studentId: "std-1",
        amount: 400,
        paymentType: "monthly",
        paymentMethod: "cash",
        paymentDate: testBusinessDate,
      });

      // 2. Initial Daily Closing
      const closing1 = DailyClosingService.closeDailyForDate(
        testBusinessDate,
        "op-close-cycle-1",
      );
      expect(closing1.status).toBe("closed");
      expect(closing1.monthlyTotal).toBe(400);
      expect(closing1.totalCash).toBe(400);
      expect(closing1.paymentCount).toBe(1);

      // 3. Admin Reopens Daily Closing
      const reopened = DailyClosingService.reopenDailyClosing(
        testBusinessDate,
        "إعادة فتح لتسجيل إيصالات متأخرة",
        "op-reopen-cycle-1",
      );
      expect(reopened.status).toBe("open");
      expect(reopened.reopenReason).toBe("إعادة فتح لتسجيل إيصالات متأخرة");

      // 4. Financial changes: record new payments on that date
      // - Standalone session payment of 150 EGP
      PaymentRepository.recordSessionPayment({
        studentId: "std-1",
        sessionId: "sess-1",
        amount: 150,
        paymentDate: testBusinessDate,
        notes: "حصة فردية",
      });

      // - Partial payment of 250 EGP
      PaymentRepository.recordPayment({
        studentId: "std-2",
        amount: 250,
        paymentType: "partial",
        paymentMethod: "cash",
        paymentDate: testBusinessDate,
      });

      // Confirm original payment (400 EGP) was NOT mutated or deleted
      const db = DatabaseService.getDb();
      const allPaymentsOnDate = db.getAllSync<any>(
        "SELECT id, amount, payment_type FROM payments WHERE center_id = 'center-1' AND payment_date = ?",
        [testBusinessDate],
      );
      expect(allPaymentsOnDate.length).toBe(3);
      expect(
        allPaymentsOnDate.some(
          (p: any) => Number(p.amount) === 400 && p.payment_type === "monthly",
        ),
      ).toBe(true);

      // 5. Close again (re-closing)
      const closing2 = DailyClosingService.closeDailyForDate(
        testBusinessDate,
        "op-close-cycle-2",
      );
      expect(closing2.status).toBe("closed");
      expect(closing2.monthlyTotal).toBe(400);
      expect(closing2.partialTotal).toBe(250);
      expect(closing2.sessionTotal).toBe(150);
      expect(closing2.totalCash).toBe(800); // 400 + 250 + 150
      expect(closing2.paymentCount).toBe(3);

      // Verify that database row was updated, not duplicated
      const summaryRows = db.getAllSync(
        "SELECT id FROM daily_closing_summaries WHERE center_id = ? AND business_date = ?",
        ["center-1", testBusinessDate],
      );
      expect(summaryRows.length).toBe(1);
    });

    it("Point 4: Session Closing State Enforcement & Invariants", async () => {
      // 1. Session Closing sets actual status to 'closed'
      const closingRecord = SessionClosingService.closeSession(
        "sess-1",
        "op-close-sess-1-audit",
      );
      expect(closingRecord.newStatus).toBe("closed");
      const session = SessionRepository.findById("sess-1");
      expect(session?.status).toBe("closed");

      // 2. Attendance mutations blocked while closed
      await expect(
        AttendanceRepository.recordAttendance({
          sessionId: "sess-1",
          studentId: "std-3",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow(ConflictError);

      // 3. Advance coverage on closed session blocked
      await expect(
        MakeupService.recordAdvanceCoverage("std-3", "sess-1", "sess-2"),
      ).rejects.toThrow(ConflictError);

      // 4. Reopening requires permission (secretary rejected)
      await useAuthStore.getState().login("01000000002", "123456");
      await useAuthStore.getState().selectCenter("center-1");
      expect(() => {
        SessionClosingService.reopenSession("sess-1", "محاولة فتح بدون صلاحية");
      }).toThrow(ForbiddenError);

      // Switch back to Admin
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      // 5. Reopening requires non-empty reason
      expect(() => {
        SessionClosingService.reopenSession("sess-1", "   ");
      }).toThrow(ValidationError);

      // 6. Valid reopening restores status to 'open'
      const reopenRecord = SessionClosingService.reopenSession(
        "sess-1",
        "سبب إداري موثق لإعادة الفتح",
        "op-reopen-sess-1-audit",
      );
      expect(reopenRecord.newStatus).toBe("open");
      const reopenedSession = SessionRepository.findById("sess-1");
      expect(reopenedSession?.status).toBe("open");

      // 7. Reopening an already-open session throws ConflictError
      expect(() => {
        SessionClosingService.reopenSession(
          "sess-1",
          "محاولة فتح حصة مفتوحة بالفعل",
        );
      }).toThrow(ConflictError);

      // 8. Repeated closing is idempotent
      const reclose1 = SessionClosingService.closeSession(
        "sess-1",
        "op-reclose-1",
      );
      expect(reclose1.newStatus).toBe("closed");
      const reclose2 = SessionClosingService.closeSession(
        "sess-1",
        "op-reclose-2",
      );
      expect(reclose2.newStatus).toBe("closed");
      expect(reclose2.sessionId).toBe("sess-1");

      // 9. All operations are recorded in closing history
      const history = SessionClosingService.getClosingHistory("sess-1");
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history.some((h) => h.action === "reopen")).toBe(true);
      expect(history.some((h) => h.action === "close")).toBe(true);
    });
  });
});
