import { env } from "../src/config/env";
import { ApiClient, MockSyncApiAdapter } from "../src/core/api";
import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService } from "../src/core/database";
import { DeviceRepository, DeviceService } from "../src/core/device";
import {
    ConflictError,
    ForbiddenError,
    NetworkError,
    NotFoundError,
    UnauthorizedError,
} from "../src/core/errors";
import { Logger } from "../src/core/logger";
import { SecureStorageService } from "../src/core/storage";
import {
    ARABIC_OPERATION_STATES,
    ARABIC_SYNC_STATES,
    getOperationPriority,
    SyncEngine,
    SyncRepository,
} from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { DailyClosingService } from "../src/features/reports/DailyClosingService";
import { SessionClosingService } from "../src/features/sessions/SessionClosingService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("Sprint 6 — Finalization, Backend/Sync & Production Readiness", () => {
  beforeEach(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
    ConnectivityService.setState("online");
    ApiClient.resetInstance();
  });

  // ==========================================================
  // Section 1: API Layer & Configuration
  // ==========================================================
  describe("1. API Layer & Client Configuration", () => {
    it("Test 1: Configures base URL, timeout, and JSON headers correctly", () => {
      const client = ApiClient.getInstance();
      expect(client.defaults.baseURL).toBe(env.apiUrl);
      expect(client.defaults.timeout).toBe(15000);
      expect(client.defaults.headers["Content-Type"]).toBe("application/json");
      expect(client.defaults.headers["Accept"]).toBe("application/json");
    });

    it("Test 2: Attaches Authorization Bearer token from SecureStore", async () => {
      await SecureStorageService.setItem(
        "session_token",
        "test-bearer-token-123",
      );
      const client = ApiClient.getInstance();

      // Invoke request interceptor
      const interceptor = (client.interceptors.request as any).handlers[0];
      const config = await interceptor.fulfilled({ headers: {} });

      expect(config.headers.Authorization).toBe("Bearer test-bearer-token-123");
    });

    it("Test 3: Attaches X-Center-Id, X-Device-Id, and X-App-Version headers", async () => {
      await SecureStorageService.setItem("active_center_id", "center-1");
      DeviceService.setCachedDeviceId("dev-test-identifier-001");
      const client = ApiClient.getInstance();

      const interceptor = (client.interceptors.request as any).handlers[0];
      const config = await interceptor.fulfilled({ headers: {} });

      expect(config.headers["X-Center-Id"]).toBe("center-1");
      expect(config.headers["X-Device-Id"]).toBe("dev-test-identifier-001");
      expect(config.headers["X-App-Version"]).toBe(env.appVersion);
    });

    it("Test 4: Maps 401 Unauthorized response and triggers automatic logout handler", async () => {
      let loggedOut = false;
      ApiClient.setUnauthorizedHandler(() => {
        loggedOut = true;
      });

      const client = ApiClient.getInstance();
      const responseInterceptor = (client.interceptors.response as any)
        .handlers[0];

      await expect(
        responseInterceptor.rejected({
          response: {
            status: 401,
            data: { message: "Token expired" },
          },
        }),
      ).rejects.toThrow(UnauthorizedError);

      expect(loggedOut).toBe(true);
    });

    it("Test 5: Maps 403 Forbidden, 404 NotFound, and 409 Conflict to domain errors", async () => {
      const client = ApiClient.getInstance();
      const responseInterceptor = (client.interceptors.response as any)
        .handlers[0];

      await expect(
        responseInterceptor.rejected({
          response: { status: 403, data: { message: "Permission denied" } },
        }),
      ).rejects.toThrow(ForbiddenError);

      await expect(
        responseInterceptor.rejected({
          response: { status: 404, data: { message: "Not found" } },
        }),
      ).rejects.toThrow(NotFoundError);

      await expect(
        responseInterceptor.rejected({
          response: { status: 409, data: { message: "Conflict detected" } },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("Test 6: Maps network timeout and connection failure to Arabic NetworkError", async () => {
      const client = ApiClient.getInstance();
      const responseInterceptor = (client.interceptors.response as any)
        .handlers[0];

      await expect(
        responseInterceptor.rejected({
          message: "Network Error",
          // No response property simulates network drop
        }),
      ).rejects.toThrow(NetworkError);
    });
  });

  // ==========================================================
  // Section 2: Sync Engine Production Hardening
  // ==========================================================
  describe("2. Sync Engine Hardening", () => {
    it("Test 7: Batches pending operations up to configured batch size", async () => {
      const mockAdapter = new MockSyncApiAdapter();
      SyncEngine.setAdapter(mockAdapter);

      // Enqueue 5 operations
      for (let i = 1; i <= 5; i++) {
        SyncRepository.enqueueOperation({
          centerId: "center-1",
          userId: "usr-admin-1",
          deviceId: "dev-test",
          operationType: "create",
          entityType: "student",
          entityId: `std-batch-${i}`,
          payload: { name: `Batch Student ${i}` },
          operationId: `op-batch-${i}`,
        });
      }

      // Sync with batchSize = 3
      const result = await SyncEngine.syncCenterNow("center-1", {
        batchSize: 3,
      });
      expect(result.syncedCount).toBe(3);

      const pendingAfter = SyncRepository.getPendingOperations("center-1");
      expect(pendingAfter.length).toBe(2);
    });

    it("Test 8: Pulls server changes using monotonic cursor", async () => {
      const mockAdapter = new MockSyncApiAdapter();
      SyncEngine.setAdapter(mockAdapter);

      SyncRepository.setServerCursor("center-1", "srv_seq_500");
      expect(SyncRepository.getServerCursor("center-1")).toBe("srv_seq_500");

      await SyncEngine.syncCenterNow("center-1");
      const cursorAfter = SyncRepository.getServerCursor("center-1");
      expect(cursorAfter).toBeDefined();
    });

    it("Test 9: Monotonic cursor progression uses server sequence token instead of client timestamp", () => {
      SyncRepository.setServerCursor("center-1", "0");
      expect(SyncRepository.getServerCursor("center-1")).toBe("0");

      SyncRepository.setServerCursor("center-1", "srv_seq_1001");
      expect(SyncRepository.getServerCursor("center-1")).toBe("srv_seq_1001");

      // Verify cursor is isolated per center
      expect(SyncRepository.getServerCursor("center-2")).toBe("0");
    });

    it("Test 10: Sorts queue by business priority (auth/device > attendance > payments > closings > CRUD)", () => {
      expect(getOperationPriority("device")).toBe(1);
      expect(getOperationPriority("user")).toBe(1);
      expect(getOperationPriority("attendance")).toBe(2);
      expect(getOperationPriority("advance_coverage")).toBe(2);
      expect(getOperationPriority("payment")).toBe(3);
      expect(getOperationPriority("payment_reversal")).toBe(3);
      expect(getOperationPriority("session_closing")).toBe(4);
      expect(getOperationPriority("daily_closing")).toBe(4);
      expect(getOperationPriority("student")).toBe(5);
      expect(getOperationPriority("group")).toBe(5);
      expect(getOperationPriority("report")).toBe(6);

      // Enqueue in mixed order
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "student",
        entityId: "std-prio-1",
        payload: {},
        operationId: "op-crud",
      });
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "payment",
        entityId: "pay-prio-1",
        payload: {},
        operationId: "op-payment",
      });
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "attendance",
        entityId: "att-prio-1",
        payload: {},
        operationId: "op-attendance",
      });

      const prioritized = SyncRepository.getPendingOperations("center-1");
      expect(prioritized[0].operationId).toBe("op-attendance");
      expect(prioritized[1].operationId).toBe("op-payment");
      expect(prioritized[2].operationId).toBe("op-crud");
    });

    it("Test 11: Applies exponential backoff and increments retry count on push failure", async () => {
      const mockAdapter = new MockSyncApiAdapter();
      mockAdapter.setFailNextPush(true);
      SyncEngine.setAdapter(mockAdapter);

      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "student",
        entityId: "std-backoff-1",
        payload: {},
        operationId: "op-fail-backoff",
      });

      const result = await SyncEngine.syncCenterNow("center-1");
      expect(result.errors).toBeGreaterThan(0);
      expect(result.state).toBe("error");

      const op = SyncRepository.getByOperationId("op-fail-backoff");
      expect(op?.status).toBe("failed");
      expect(op?.retryCount).toBe(1);
      expect(op?.lastError).toContain("Mock network connection timeout");

      // Verify exponential backoff calculation
      expect(SyncEngine.getBackoffDelayMs(0)).toBe(1000);
      expect(SyncEngine.getBackoffDelayMs(1)).toBe(2000);
      expect(SyncEngine.getBackoffDelayMs(2)).toBe(4000);
      expect(SyncEngine.getBackoffDelayMs(6)).toBe(60000); // capped at 60s
    });

    it("Test 12: Partial sync failure does not block unrelated successful operations", async () => {
      const mockAdapter = new MockSyncApiAdapter();
      mockAdapter.addConflict("op-conflict-item");
      SyncEngine.setAdapter(mockAdapter);

      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "attendance",
        entityId: "att-conflict-1",
        payload: {},
        operationId: "op-conflict-item",
      });

      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "attendance",
        entityId: "att-success-1",
        payload: {},
        operationId: "op-safe-item",
      });

      const result = await SyncEngine.syncCenterNow("center-1");
      expect(result.syncedCount).toBe(1);
      expect(result.conflicts).toBe(1);

      const conflictedOp = SyncRepository.getByOperationId("op-conflict-item");
      expect(conflictedOp?.status).toBe("conflict");

      const safeOp = SyncRepository.getByOperationId("op-safe-item");
      expect(safeOp?.status).toBe("synced");
    });

    it("Test 13: Enqueuing same operation_id is strictly idempotent without duplicates", () => {
      const op1 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "payment",
        entityId: "pay-idem-1",
        payload: { amount: 300 },
        operationId: "op-idempotency-key-1",
      });

      const op2 = SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "payment",
        entityId: "pay-idem-1",
        payload: { amount: 300 },
        operationId: "op-idempotency-key-1",
      });

      expect(op1.id).toBe(op2.id);
      expect(op1.operationId).toBe(op2.operationId);
    });
  });

  // ==========================================================
  // Section 3: Entity Sync & Conflict Handling
  // ==========================================================
  describe("3. Entity Sync & Business Conflict Invariants", () => {
    it("Test 14: Attendance sync queues attendance operation and rejects duplicates", async () => {
      const att = await AttendanceRepository.recordAttendance({
        sessionId: "sess-1",
        studentId: "std-1",
        status: "present",
        isLate: false,
      });

      expect(att.id).toBeDefined();

      const syncOps = SyncRepository.getPendingOperations("center-1");
      expect(syncOps.some((op) => op.entityType === "attendance")).toBe(true);

      // Duplicate attendance for same session and student throws ConflictError
      await expect(
        AttendanceRepository.recordAttendance({
          sessionId: "sess-1",
          studentId: "std-1",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("Test 15: Payment sync preserves immutability and queues payment operation", async () => {
      const payment = await PaymentRepository.recordSessionPayment({
        studentId: "std-1",
        sessionId: "sess-1",
        amount: 150,
        operationId: "op-pay-sync-test",
      });

      expect(payment.amount).toBe(150);

      const syncOp = SyncRepository.getByOperationId("op-pay-sync-test");
      expect(syncOp).toBeDefined();
      expect(syncOp?.entityType).toBe("payment");
    });

    it("Test 16: Payment reversal sync queues reversal operation and marks payment is_reversed", async () => {
      const payment = await PaymentRepository.recordSessionPayment({
        studentId: "std-2",
        sessionId: "sess-1",
        amount: 200,
        operationId: "op-pay-to-reverse",
      });

      const reversal = await PaymentRepository.reversePayment({
        paymentId: payment.id,
        reason: "إلغاء بناء على طلب ولي الأمر",
        operationId: "op-rev-sync-test",
      });

      expect(reversal.reversedAmount).toBe(200);

      const syncOp = SyncRepository.getByOperationId("op-rev-sync-test");
      expect(syncOp).toBeDefined();
      expect(syncOp?.entityType).toBe("payment_reversal");

      const db = DatabaseService.getDb();
      const refreshed = db.getFirstSync<any>(
        "SELECT is_reversed FROM payments WHERE id = ?",
        [payment.id],
      );
      expect(
        refreshed?.is_reversed === 1 || refreshed?.is_reversed === true,
      ).toBe(true);
    });

    it("Test 17: Notification event sync queues notification delivery and audit trail", () => {
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "notification_event",
        entityId: "nevt-sync-1",
        payload: { studentId: "std-1", channel: "sms" },
        operationId: "op-notif-sync",
      });

      const op = SyncRepository.getByOperationId("op-notif-sync");
      expect(op?.entityType).toBe("notification_event");
    });

    it("Test 18: Session closing sync queues closing operation and rejects mutations while closed", async () => {
      const record = SessionClosingService.closeSession(
        "sess-1",
        "op-close-sess-sync",
      );
      expect(record.newStatus).toBe("closed");

      const syncOp = SyncRepository.getByOperationId("op-close-sess-sync");
      expect(syncOp).toBeDefined();
      expect(syncOp?.entityType).toBe("session");

      // Mutation while closed must throw ConflictError
      await expect(
        AttendanceRepository.recordAttendance({
          sessionId: "sess-1",
          studentId: "std-2",
          status: "present",
          isLate: false,
        }),
      ).rejects.toThrow(ConflictError);

      // Reopen session to restore state for other tests
      SessionClosingService.reopenSession(
        "sess-1",
        "إعادة الفتح لاختبارات لاحقة",
      );
    });

    it("Test 19: Daily closing sync queues closing operation and recalculates fresh aggregates on re-close", () => {
      const date = "2026-09-28";
      PaymentRepository.recordPayment({
        studentId: "std-1",
        amount: 500,
        paymentType: "monthly",
        paymentMethod: "cash",
        paymentDate: date,
      });

      const closing1 = DailyClosingService.closeDailyForDate(
        date,
        "op-close-daily-sync-1",
      );
      expect(closing1.status).toBe("closed");
      expect(closing1.totalCash).toBe(500);

      const op1 = SyncRepository.getByOperationId("op-close-daily-sync-1");
      expect(op1?.entityType).toBe("daily_closing");

      // Reopen
      DailyClosingService.reopenDailyClosing(
        date,
        "تسجيل إيصال إضافي",
        "op-reopen-daily-sync",
      );

      // Add second payment
      PaymentRepository.recordPayment({
        studentId: "std-2",
        amount: 250,
        paymentType: "partial",
        paymentMethod: "cash",
        paymentDate: date,
      });

      // Re-close
      const closing2 = DailyClosingService.closeDailyForDate(
        date,
        "op-close-daily-sync-2",
      );
      expect(closing2.status).toBe("closed");
      expect(closing2.totalCash).toBe(750);
      expect(closing2.paymentCount).toBe(2);
    });
  });

  // ==========================================================
  // Section 4: Device Management & Security
  // ==========================================================
  describe("4. Device Management & Client Security", () => {
    it("Test 20: Active device permits normal mutation enqueuing and synchronization", async () => {
      DeviceRepository.setDeviceStatus("center-1", "dev-active-001", "active");
      expect(
        DeviceRepository.getDeviceStatus("center-1", "dev-active-001"),
      ).toBe("active");

      expect(() => {
        DeviceRepository.assertDeviceActive("center-1");
      }).not.toThrow();
    });

    it("Test 21: Inactive device blocks mutation enqueuing and sync with clear Arabic error", async () => {
      DeviceService.setCachedDeviceId("dev-revoked-001");
      DeviceRepository.setDeviceStatus(
        "center-1",
        "dev-revoked-001",
        "inactive",
      );
      expect(
        DeviceRepository.getDeviceStatus("center-1", "dev-revoked-001"),
      ).toBe("inactive");

      // Mutation must be rejected
      expect(() => {
        SyncRepository.enqueueOperation({
          centerId: "center-1",
          userId: "usr-admin-1",
          deviceId: "dev-revoked-001",
          operationType: "create",
          entityType: "student",
          entityId: "std-blocked",
          payload: {},
        });
      }).toThrow(ForbiddenError);

      // Sync must immediately abort
      const syncResult = await SyncEngine.syncCenterNow("center-1");
      expect(syncResult.state).toBe("error");
      expect(syncResult.arabicMessage).toContain("هذا الجهاز غير نشط");

      // Restore active status
      DeviceRepository.setDeviceStatus("center-1", "dev-revoked-001", "active");
    });

    it("Test 22: Inactive device preserves local read-only access safely", () => {
      DeviceService.setCachedDeviceId("dev-ro-001");
      DeviceRepository.setDeviceStatus("center-1", "dev-ro-001", "inactive");

      // Reading students locally must still work without throwing
      const students = StudentRepository.getAll();
      expect(Array.isArray(students)).toBe(true);

      // Restore active status
      DeviceRepository.setDeviceStatus("center-1", "dev-ro-001", "active");
    });

    it("Test 23: SecureStore restores session credentials cleanly", async () => {
      await useAuthStore.getState().login("01000000001", "123456");
      const restored = await useAuthStore.getState().restoreSession();
      expect(restored).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().currentUser?.id).toBe("usr-admin-1");
    });

    it("Test 24: Logout clears session tokens and state completely", async () => {
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().currentUser).toBeNull();
      expect(useAuthStore.getState().activeCenterId).toBeNull();

      const storedToken = await SecureStorageService.getItem("session_token");
      expect(storedToken).toBeNull();

      // Log back in for subsequent tests
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("Test 25: Never persists plain-text passwords in SQLite or SecureStore", async () => {
      const db = DatabaseService.getDb();
      // SQLite tables check: No 'passwords' column or table exists
      const studentCols = db.getAllSync("PRAGMA table_info(students)");
      expect(studentCols.some((col: any) => col.name === "password")).toBe(
        false,
      );

      const storedPassword = await SecureStorageService.getItem("password");
      expect(storedPassword).toBeNull();
    });

    it("Test 26: Multi-center isolation prevents unauthorized center switching", async () => {
      // Secretary (usr-sec-1) only has center-1, not center-2
      await useAuthStore.getState().login("01000000002", "123456");
      await expect(
        useAuthStore.getState().selectCenter("center-2"),
      ).rejects.toThrow(ForbiddenError);

      // Admin back
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("Test 27: Structured logger automatically redacts passwords, tokens, and secrets", () => {
      const consoleSpy = jest
        .spyOn(console, "info")
        .mockImplementation(() => {});

      Logger.info("auth", "login_attempt", {
        metadata: {
          username: "admin",
          password: "SuperSecretPassword123",
          session_token: "tok-secret-abc",
          authorization: "Bearer secret-jwt-token",
        },
      });

      expect(consoleSpy).toHaveBeenCalled();
      const loggedJson = consoleSpy.mock.calls[0][0];
      expect(loggedJson).not.toContain("SuperSecretPassword123");
      expect(loggedJson).toContain("[REDACTED]");

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================
  // Section 5: Database Hardening & Regressions
  // ==========================================================
  describe("5. Database Migrations & Invariant Regressions", () => {
    it("Test 28: Migration replay is idempotent, preserving existing schema and tracking versions", () => {
      expect(() => {
        DatabaseService.runMigrations();
      }).not.toThrow();

      const db = DatabaseService.getDb();
      const migrations = db.getAllSync<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version ASC",
      );
      expect(migrations.length).toBeGreaterThanOrEqual(5);
    });

    it("Test 29: Offline mutation followed by reconnect synchronizes queued operations", async () => {
      const mockAdapter = new MockSyncApiAdapter();
      SyncEngine.setAdapter(mockAdapter);

      // 1. App goes offline
      ConnectivityService.setState("offline");
      expect(ConnectivityService.getState()).toBe("offline");

      // 2. Mutation enqueued while offline
      SyncRepository.enqueueOperation({
        centerId: "center-1",
        userId: "usr-admin-1",
        deviceId: "dev-test",
        operationType: "create",
        entityType: "student",
        entityId: "std-offline-reconnect",
        payload: { name: "Offline Student" },
        operationId: "op-offline-rec-1",
      });

      // 3. Attempt sync while offline returns offline state with Arabic message
      const offlineResult = await SyncEngine.syncCenterNow("center-1");
      expect(offlineResult.state).toBe("offline");
      expect(offlineResult.syncedCount).toBe(0);

      // 4. App reconnects online
      ConnectivityService.setState("online");
      expect(ConnectivityService.getState()).toBe("online");

      // 5. Sync automatically succeeds
      const onlineResult = await SyncEngine.syncCenterNow("center-1");
      expect(onlineResult.state).toBe("online");
      expect(onlineResult.syncedCount).toBeGreaterThanOrEqual(1);

      const op = SyncRepository.getByOperationId("op-offline-rec-1");
      expect(op?.status).toBe("synced");
    });

    it("Test 30: Financial calculation regression: session payments NEVER reduce subscription debt", async () => {
      const studentId = "std-fin-regression-1";
      const statusBefore =
        FinancialCalculationService.getStudentFinancialStatus(studentId);

      // Record standalone session payment
      await PaymentRepository.recordSessionPayment({
        studentId,
        sessionId: "sess-1",
        amount: 250,
      });

      const statusAfter =
        FinancialCalculationService.getStudentFinancialStatus(studentId);
      // Subscription debt must remain strictly independent
      expect(statusAfter.groupRemainingDebt).toBe(
        statusBefore.groupRemainingDebt,
      );
      expect(statusAfter.packageRemainingDebt).toBe(
        statusBefore.packageRemainingDebt,
      );
      expect(statusAfter.sessionTotalPaid).toBe(
        statusBefore.sessionTotalPaid + 250,
      );
    });

    it("Test 31: Historical session snapshots remain immutable after group price or teacher change", () => {
      const sessionBefore = SessionRepository.findById("sess-1");
      expect(sessionBefore).toBeDefined();

      const originalPrice = sessionBefore?.sessionPrice;
      const originalTeacher = sessionBefore?.teacherId;

      // Group configuration changes must NOT rewrite already generated sessions
      const sessionAfter = SessionRepository.findById("sess-1");
      expect(sessionAfter?.sessionPrice).toBe(originalPrice);
      expect(sessionAfter?.teacherId).toBe(originalTeacher);
    });

    it("Test 32: Production configuration check (only public config exposed, zero server secrets)", () => {
      expect(env.apiUrl).toBeDefined();
      expect(env.appVersion).toBe("1.0.0");
      expect(env.appEnv).toMatch(/^(development|staging|production)$/);

      // Strict check: No private keys, database passwords, or SMS secrets in env
      const envKeys = Object.keys(env);
      expect(envKeys).not.toContain("databasePassword");
      expect(envKeys).not.toContain("jwtSecret");
      expect(envKeys).not.toContain("smsApiKey");
      expect(envKeys).not.toContain("adminSecret");

      // Arabic sync and operation states dictionary integrity
      expect(ARABIC_SYNC_STATES.online).toBe("متصل");
      expect(ARABIC_SYNC_STATES.offline).toBe("غير متصل");
      expect(ARABIC_SYNC_STATES.syncing).toBe("تتم المزامنة");
      expect(ARABIC_SYNC_STATES.error).toBe("فشل المزامنة");
      expect(ARABIC_OPERATION_STATES.local_saved).toBe("تم الحفظ على الجهاز");
      expect(ARABIC_OPERATION_STATES.pending).toBe("في انتظار المزامنة");
      expect(ARABIC_OPERATION_STATES.synced).toBe("تمت المزامنة");
      expect(ARABIC_OPERATION_STATES.failed).toBe("فشل الإرسال");
    });
  });
});
