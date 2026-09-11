import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import { ConflictError } from "../src/core/errors";
import { PermissionService, RolePermissions } from "../src/core/permissions";
import { SyncRepository } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { DashboardService } from "../src/features/dashboard/DashboardService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("Sprint 1 - FIXION Mobile App Foundation & Complete Working Flow", () => {
  beforeAll(async () => {
    // Initialize SQLite Database schema and seed data
    DatabaseService.init();

    // Login as Demo Admin for test setup
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  describe("1. Card Code Normalization", () => {
    it("must PRESERVE leading zeros (e.g. 00125 remains 00125)", () => {
      expect(ScannerService.normalizeCardCode("00125")).toBe("00125");
      expect(ScannerService.normalizeCardCode("00001")).toBe("00001");
      expect(ScannerService.normalizeCardCode("010")).toBe("010");
    });

    it("must convert Eastern Arabic digits to Latin digits while preserving leading zeros", () => {
      expect(ScannerService.normalizeCardCode("٠٠١٢٥")).toBe("00125");
      expect(ScannerService.normalizeCardCode("٠١٠٤٥٢")).toBe("010452");
    });

    it("must trim surrounding whitespace", () => {
      expect(ScannerService.normalizeCardCode("   00125   ")).toBe("00125");
      expect(ScannerService.normalizeCardCode("  ٠٠١٢٦  ")).toBe("00126");
    });

    it("must handle empty or invalid input safely", () => {
      expect(ScannerService.normalizeCardCode("")).toBe("");
      expect(ScannerService.normalizeCardCode("   ")).toBe("");
    });
  });

  describe("2. Student Lookup & Center Isolation", () => {
    it("finds the correct student in active center-1 using normalized code", async () => {
      await useAuthStore.getState().selectCenter("center-1");

      const student = StudentRepository.findByCardCode("00125");
      expect(student).not.toBeNull();
      expect(student?.id).toBe("std-1");
      expect(student?.fullName).toBe("أحمد محمد محمود");
      expect(student?.centerId).toBe("center-1");
      expect(student?.cardCode).toBe("00125");
    });

    it("enforces multi-center isolation: switching to center-2 returns center-2 student for same card code", async () => {
      // Switch authenticated active center to center-2
      await useAuthStore.getState().selectCenter("center-2");

      const studentInCenter2 = StudentRepository.findByCardCode("00125");
      expect(studentInCenter2).not.toBeNull();
      expect(studentInCenter2?.id).toBe("std-4");
      expect(studentInCenter2?.fullName).toBe("مصطفى كمال الدين");
      expect(studentInCenter2?.centerId).toBe("center-2");

      // Switch back to center-1
      await useAuthStore.getState().selectCenter("center-1");
      const studentInCenter1 = StudentRepository.findByCardCode("00125");
      expect(studentInCenter1?.id).toBe("std-1");
      expect(studentInCenter1?.fullName).toBe("أحمد محمد محمود");
    });

    it("returns null when card code does not exist in the active center", () => {
      const student = StudentRepository.findByCardCode("99999");
      expect(student).toBeNull();
    });
  });

  describe("3. Permission Checks", () => {
    it("verifies admin role has full attendance and payment permissions", () => {
      const adminPerms = RolePermissions.admin;
      expect(
        PermissionService.hasPermission(adminPerms, "attendance.create"),
      ).toBe(true);
      expect(
        PermissionService.hasPermission(adminPerms, "payments.create"),
      ).toBe(true);
      expect(
        PermissionService.hasPermission(adminPerms, "sessions.close"),
      ).toBe(true);
    });

    it("verifies secretary has attendance permissions but not sensitive management permissions", () => {
      const secPerms = RolePermissions.secretary;
      expect(
        PermissionService.hasPermission(secPerms, "attendance.create"),
      ).toBe(true);
      expect(PermissionService.hasPermission(secPerms, "payments.create")).toBe(
        true,
      );
      expect(PermissionService.hasPermission(secPerms, "sessions.close")).toBe(
        false,
      );
      expect(PermissionService.hasPermission(secPerms, "users.manage")).toBe(
        false,
      );
    });

    it("verifies accountant does NOT have attendance.create permission", () => {
      const accPerms = RolePermissions.accountant;
      expect(PermissionService.hasPermission(accPerms, "payments.create")).toBe(
        true,
      );
      expect(
        PermissionService.hasPermission(accPerms, "attendance.create"),
      ).toBe(false);
    });
  });

  describe("4. Late Attendance Calculation", () => {
    it("flags check-in as present if within grace period", () => {
      // Session starts at 14:00, check-in at 14:10 (grace is 15 mins)
      const res = ScannerService.calculateLateStatus("14:00", "14:10", 15);
      expect(res.isLate).toBe(false);
      expect(res.status).toBe("present");
    });

    it("flags check-in as late if after grace period", () => {
      // Session starts at 14:00, check-in at 14:25 (grace is 15 mins)
      const res = ScannerService.calculateLateStatus("14:00", "14:25", 15);
      expect(res.isLate).toBe(true);
      expect(res.status).toBe("late");
    });
  });

  describe("5. Offline Attendance Creation, Sync Queue & Audit Log", () => {
    it("records attendance in SQLite, queues sync operation, and records audit log", async () => {
      await useAuthStore.getState().selectCenter("center-1");

      const attendance = await AttendanceRepository.recordAttendance({
        studentId: "std-2",
        sessionId: "sess-1",
        status: "present",
        isLate: false,
        attendanceType: "present",
        checkInTime: "14:05:00",
      });

      expect(attendance).toBeDefined();
      expect(attendance.studentId).toBe("std-2");
      expect(attendance.sessionId).toBe("sess-1");
      expect(attendance.status).toBe("present");
      expect(attendance.operationId).toMatch(/^op-att-/);

      // Verify operation queued in sync_operations
      const pendingOps = SyncRepository.getPendingOperations("center-1");
      const queuedOp = pendingOps.find(
        (op) => op.operationId === attendance.operationId,
      );
      expect(queuedOp).toBeDefined();
      expect(queuedOp?.operationType).toBe("attendance.create");
      expect(queuedOp?.entityType).toBe("attendance");
      expect(queuedOp?.status).toBe("pending");

      // Verify audit log created
      const logs = AuditService.getLogs("center-1");
      const auditLog = logs.find(
        (l) => l.operationId === attendance.operationId,
      );
      expect(auditLog).toBeDefined();
      expect(auditLog?.action).toBe("attendance.record");
    });

    it("supports makeup attendance type and optional originalAbsenceId", async () => {
      const attendance = await AttendanceRepository.recordAttendance({
        studentId: "std-3",
        sessionId: "sess-1",
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: "abs-prev-009",
        checkInTime: "14:06:00",
      });

      expect(attendance.attendanceType).toBe("makeup");
      expect(attendance.originalAbsenceId).toBe("abs-prev-009");
    });

    it("prevents duplicate attendance scans for the same student in the same session", async () => {
      // std-2 has already attended sess-1 above
      expect(AttendanceRepository.isAlreadyAttended("sess-1", "std-2")).toBe(
        true,
      );

      await expect(
        AttendanceRepository.recordAttendance({
          studentId: "std-2",
          sessionId: "sess-1",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe("6. Event-Driven Financial Model & Dynamic Balance Calculation", () => {
    it("calculates student balance dynamically from subscriptions minus immutable payment events", () => {
      // std-1 has sub-1 of 400 EGP, and seeded payment of 250 EGP
      const finStatus = PaymentRepository.getStudentFinancialStatus("std-1");

      expect(finStatus.totalDue).toBe(400);
      expect(finStatus.totalPaid).toBe(250);
      expect(finStatus.remainingBalance).toBe(150);
      expect(finStatus.subscriptions.length).toBe(1);
      expect(finStatus.payments.length).toBe(1);
    });

    it("recording a payment adds an immutable event, queues sync, and dynamically updates remaining balance", async () => {
      // Record a partial payment of 100 EGP
      const paymentEvent = await PaymentRepository.recordPayment({
        studentId: "std-1",
        amount: 100,
        paymentType: "partial",
      });

      expect(paymentEvent.amount).toBe(100);
      expect(paymentEvent.operationId).toMatch(/^op-pay-/);

      // Verify balance dynamically updated: 400 - (250 + 100) = 50 EGP
      const updatedStatus =
        PaymentRepository.getStudentFinancialStatus("std-1");
      expect(updatedStatus.totalPaid).toBe(350);
      expect(updatedStatus.remainingBalance).toBe(50);

      // Verify queued in sync_operations
      const pending = SyncRepository.getPendingOperations("center-1");
      const queuedPay = pending.find(
        (op) => op.operationId === paymentEvent.operationId,
      );
      expect(queuedPay).toBeDefined();
      expect(queuedPay?.operationType).toBe("payment.create");
    });
  });

  describe("7. Dashboard Calculations with session_expected_students", () => {
    it("calculates expected students and attendance correctly from session_expected_students", () => {
      const summary = DashboardService.getTodaySummary();

      // In center-1 sess-1: expected students are std-1, std-2, std-3 (total 3)
      expect(summary.expectedCount).toBe(3);

      // std-2 (present) and std-3 (makeup) attended
      expect(summary.presentCount + summary.lateCount).toBe(2);

      // Absent count = 3 - 2 = 1 (std-1 hasn't attended yet)
      expect(summary.absentCount).toBe(1);

      // Today's collections include seed 250 + new 100 = 350
      expect(summary.todayCollections).toBeGreaterThanOrEqual(100);
    });
  });

  describe("8. SQLite Schema Migrations & Upgrade Safety", () => {
    it("reports schema version 1 after running initial migrations", () => {
      const version = DatabaseService.getCurrentVersion();
      expect(version).toBeGreaterThanOrEqual(1);
    });

    it("running migrations multiple times is idempotent and does not corrupt existing data", () => {
      // Re-run migrations
      DatabaseService.runMigrations();
      expect(DatabaseService.getCurrentVersion()).toBeGreaterThanOrEqual(1);

      // Verify existing student std-1 is completely intact
      const student = StudentRepository.findByCardCode("00125");
      expect(student).not.toBeNull();
      expect(student?.id).toBe("std-1");
    });
  });

  describe("9. Sync Queue Idempotency & Error/Retry Handling", () => {
    it("enqueueOperation is idempotent when using the same operation_id", () => {
      const opId = "op-idempotency-test-01";
      const op1 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-1",
        deviceId: "dev-test-1",
        operationType: "test.op",
        entityType: "test",
        entityId: "test-1",
        payload: { test: true },
        operationId: opId,
      });

      // Calling enqueueOperation again with identical operationId should return op1 without error
      const op2 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-1",
        deviceId: "dev-test-1",
        operationType: "test.op",
        entityType: "test",
        entityId: "test-1",
        payload: { test: true },
        operationId: opId,
      });

      expect(op2.operationId).toBe(opId);
      expect(op2.id).toBe(op1.id);
    });

    it("tracks status transitions, increments retry_count, and records last_error", () => {
      const opId = "op-retry-test-02";
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-1",
        deviceId: "dev-test-1",
        operationType: "test.retry",
        entityType: "test",
        entityId: "test-2",
        payload: { attempt: 1 },
        operationId: opId,
      });

      // 1. Transition to syncing
      SyncRepository.markAsSyncing(opId);
      let op = SyncRepository.getByOperationId(opId);
      expect(op?.status).toBe("syncing");

      // 2. Transition to failed on error
      SyncRepository.markAsFailed(opId, "Connection timeout to server");
      op = SyncRepository.getByOperationId(opId);
      expect(op?.status).toBe("failed");
      expect(op?.retryCount).toBe(1);
      expect(op?.lastError).toBe("Connection timeout to server");

      // 3. Mark as synced
      SyncRepository.markAsSynced(opId);
      op = SyncRepository.getByOperationId(opId);
      expect(op?.status).toBe("synced");
      expect(op?.syncedAt).toBeDefined();
    });
  });

  describe("10. Repository-Level Permission Enforcement (Defense in Depth)", () => {
    it("AttendanceRepository rejects recordAttendance when user role lacks attendance.create", async () => {
      // Simulate accountant logging in (accountant has no attendance.create permission)
      const state = useAuthStore.getState();
      const originalUser = state.currentUser;

      // Set user as accountant
      useAuthStore.setState({
        currentUser: {
          id: "usr-accountant",
          fullName: "المحاسب",
          phone: "01099998888",
          role: "accountant",
          permissions: RolePermissions.accountant,
          centerIds: ["center-1"],
        },
      });

      await expect(
        AttendanceRepository.recordAttendance({
          studentId: "std-1",
          sessionId: "sess-2",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow("ليس لديك صلاحية تسجيل الحضور.");

      // Restore original admin user
      useAuthStore.setState({ currentUser: originalUser });
    });

    it("PaymentRepository rejects recordPayment when user lacks payments.create", async () => {
      const state = useAuthStore.getState();
      const originalUser = state.currentUser;

      // Set user with restricted permissions (no payments.create)
      useAuthStore.setState({
        currentUser: {
          id: "usr-restricted",
          fullName: "مستخدم مقيد",
          phone: "01099990000",
          role: "secretary",
          permissions: ["students.view", "attendance.view"],
          centerIds: ["center-1"],
        },
      });

      await expect(
        PaymentRepository.recordPayment({
          studentId: "std-1",
          amount: 50,
        }),
      ).rejects.toThrow("ليس لديك صلاحية تسجيل المدفوعات.");

      // Restore original admin user
      useAuthStore.setState({ currentUser: originalUser });
    });
  });
});
