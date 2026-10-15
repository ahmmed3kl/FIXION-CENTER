jest.mock("../src/core/database", () => ({
  DatabaseService: { getDb: jest.fn() },
}));
jest.mock("../src/features/auth/useAuthStore", () => ({
  useAuthStore: {
    getState: () => ({
      activeCenterId: "notification-center",
      currentUser: {
        id: "notification-user",
        permissions: ["notifications.send"],
      },
    }),
  },
}));
jest.mock("../src/core/permissions", () => ({
  PermissionService: {
    hasPermission: (permissions: string[], permission: string) =>
      permissions.includes(permission),
  },
}));
jest.mock("../src/core/device", () => ({
  DeviceService: { getDeviceIdSync: () => "notification-device" },
}));
jest.mock("../src/core/sync", () => ({
  SyncRepository: {
    resolveSessionAlias: (_centerId: string, sessionId: string) => sessionId,
    enqueueOperation: jest.fn(),
  },
}));
jest.mock("../src/core/audit", () => ({
  AuditService: { recordEvent: jest.fn() },
}));
jest.mock("../src/config/env", () => ({ env: { enableMockData: true } }));
jest.mock("../src/features/homework/HomeworkEvaluationRepository", () => ({
  HomeworkEvaluationRepository: {},
}));
jest.mock("../src/features/notifications/NotificationTemplateRepository", () => ({
  NotificationTemplateRepository: { getActiveTemplate: () => null },
  renderTemplate: (template: string) => template,
}));

import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { NotificationService } from "../src/features/notifications/NotificationService";

const centerId = "notification-center";
const sessionId = "notification-session";
const studentId = "notification-student";

function installDatabase(options: {
  status?: string;
  attendanceType?: string;
  deliveries?: Array<{ id: string; channel: string; recipient: string; renderedMessage: string; retryCount: number }>;
} = {}) {
  const events: Array<Record<string, any>> = [];
  const insertedStatements: Array<{ sql: string; params: any[] }> = [];
  const deliveries = options.deliveries || [];
  const attendanceRows = options.status
    ? [{
        id: "notification-attendance",
        status: options.status,
        attendanceType: options.attendanceType || "present",
      }]
    : [];

  const db = {
    getFirstSync: jest.fn((sql: string, params: any[] = []) => {
      if (sql.includes("FROM sessions")) {
        return { groupId: "notification-group", status: "open" };
      }
      if (sql.includes("FROM advance_coverages")) return null;
      if (sql.includes("FROM students")) {
        return {
          full_name: "Student",
          phone: "01012345678",
          parent_phone: "01112345678",
        };
      }
      if (sql.includes("FROM notification_events")) {
        return events.find(
          (event) =>
            event.center_id === params[0] && event.id === params[1],
        ) || null;
      }
      return null;
    }),
    getAllSync: jest.fn((sql: string, params: any[] = []) => {
      if (sql.includes("FROM session_id_aliases")) return [];
      if (sql.includes("FROM attendance")) return attendanceRows;
      if (sql.includes("FROM notification_deliveries")) return deliveries;
      if (sql.includes("FROM notification_events")) {
        return events.filter(
          (event) =>
            event.center_id === params[0] &&
            event.operation_id === params[1],
        );
      }
      return [];
    }),
    runSync: jest.fn((sql: string, params: any[] = []) => {
      insertedStatements.push({ sql, params });
      if (sql.includes("INSERT INTO notification_events")) {
        events.push({
          id: params[0],
          operation_id: params[1],
          center_id: params[2],
          student_id: params[3],
          session_id: params[4],
          attendance_id: params[5],
          event_type: params[6],
          created_by: params[7],
          created_at: params[8],
          eventType: params[6],
          sessionId: params[4],
          studentId: params[3],
        });
      }
      return { changes: 1 };
    }),
  };
  (DatabaseService.getDb as jest.Mock).mockReturnValue(db);
  return { db, events, insertedStatements };
}

describe("explicit absence notification validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses a stale absence report after attendance changes to present", () => {
    const { db } = installDatabase({ status: "present" });

    expect(() =>
      NotificationService.notifyAbsentees({
        sessionId,
        selectedStudentIds: [studentId],
        operationPrefix: "stale-absence-send",
      }),
    ).toThrow(/غياب صريح صالح/);
    expect(db.runSync).not.toHaveBeenCalled();
    expect(SyncRepository.enqueueOperation).not.toHaveBeenCalled();
  });

  it("creates only an explicit absence event and keeps its source ID out of the local unique attendance column", () => {
    const { db, events, insertedStatements } = installDatabase({
      status: "absent",
    });

    const first = NotificationService.notifyAbsentees({
      sessionId,
      selectedStudentIds: [studentId],
      operationPrefix: "stable-absence-send",
    });
    const second = NotificationService.notifyAbsentees({
      sessionId,
      selectedStudentIds: [studentId],
      operationPrefix: "stable-absence-send",
    });

    expect(first[0].id).toBe(second[0].id);
    expect(events).toHaveLength(1);
    const eventInsert = insertedStatements.find((statement) =>
      statement.sql.includes("INSERT INTO notification_events"),
    );
    expect(eventInsert?.params[5]).toBeNull();
    const queuedEvent = (SyncRepository.enqueueOperation as jest.Mock).mock.calls
      .map(([operation]) => operation)
      .find((operation) => operation.entityType === "notification_event");
    expect(queuedEvent.payload.attendanceId).toBe("notification-attendance");
    expect(db.runSync).toHaveBeenCalledTimes(3);
  });

  it("marks pending local deliveries failed instead of sending after the absence is resolved", async () => {
    const { db, insertedStatements } = installDatabase({
      status: "present",
      deliveries: [{
        id: "pending-absence-delivery",
        channel: "push",
        recipient: "01012345678",
        renderedMessage: "absence",
        retryCount: 0,
      }],
    });
    db.getFirstSync.mockImplementation((sql: string) => {
      if (sql.includes("FROM sessions")) {
        return { groupId: "notification-group", status: "open" };
      }
      if (sql.includes("FROM notification_events")) {
        return {
          eventType: "absence",
          sessionId,
          studentId,
        };
      }
      return null;
    });

    const result = await NotificationService.sendPendingDeliveries(
      "existing-absence-event",
    );

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(
      insertedStatements.some((statement) =>
        statement.sql.includes("SET status = ?, sent_at = ?"),
      ),
    ).toBe(false);
    expect(
      insertedStatements.some((statement) =>
        statement.sql.includes("SET status = ?, failure_reason = ?"),
      ),
    ).toBe(true);
  });
});
