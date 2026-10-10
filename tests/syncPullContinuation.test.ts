import { ISyncApiAdapter, BootstrapResponse } from "../src/core/api/SyncApiAdapter";
import { PullSyncResponse, PushSyncResponse } from "../src/core/api/contracts";
import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";

class BacklogAdapter implements ISyncApiAdapter {
  pullCalls = 0;
  lastHasMore: boolean | null = null;
  yieldObservedBeforeEnd = false;
  readonly changes: PullSyncResponse["changes"];

  constructor(
    count: number,
    private readonly didYieldToEventLoop: () => boolean = () => false,
  ) {
    this.changes = Array.from({ length: count }, (_, index) => {
      const sequenceNumber = index + 2;
      return {
        sequenceNumber,
        operationId: `pull-backlog-op-${count}-${sequenceNumber}`,
        entityType: "teacher",
        entityId: `pull-backlog-teacher-${count}-${sequenceNumber}`,
        action: "create",
        data: {
          id: `pull-backlog-teacher-${count}-${sequenceNumber}`,
          name: `Teacher ${sequenceNumber}`,
        },
        serverTimestamp: new Date().toISOString(),
      };
    });
  }

  async pushOperations(): Promise<PushSyncResponse> {
    return {
      success: true,
      syncedOperationIds: [],
      conflicts: [],
      serverCursor: "0",
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
    limit = 50,
  ): Promise<PullSyncResponse> {
    this.pullCalls += 1;
    const after = Number(cursor);
    const remaining = this.changes.filter((change) => change.sequenceNumber > after);
    const batch = remaining.slice(0, limit);
    const nextCursor = batch.length
      ? String(batch[batch.length - 1].sequenceNumber)
      : cursor;
    this.lastHasMore = remaining.length > batch.length;
    if (!this.lastHasMore) {
      this.yieldObservedBeforeEnd = this.didYieldToEventLoop();
    }
    return {
      changes: batch,
      nextCursor,
      hasMore: this.lastHasMore,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    throw new Error(`Unexpected bootstrap for ${centerId}`);
  }
}

class PushCursorAdapter implements ISyncApiAdapter {
  async pushOperations(
    _centerId: string,
    operations: Array<{ operationId: string }>,
  ): Promise<PushSyncResponse> {
    return {
      success: true,
      syncedOperationIds: operations.map((operation) => operation.operationId),
      conflicts: [],
      serverCursor: "102",
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
  ): Promise<PullSyncResponse> {
    const changes: PullSyncResponse["changes"] = cursor === "100"
      ? [{
          sequenceNumber: 101,
          operationId: "device-b-operation",
          entityType: "teacher",
          entityId: "device-b-teacher",
          action: "create",
          data: { id: "device-b-teacher", name: "Device B teacher" },
          serverTimestamp: new Date().toISOString(),
        }]
      : cursor === "101"
        ? [{
            sequenceNumber: 102,
            operationId: "device-a-operation",
            entityType: "teacher",
            entityId: "device-a-teacher",
            action: "create",
            data: { id: "device-a-teacher", name: "Device A teacher" },
            serverTimestamp: new Date().toISOString(),
          }]
        : [];
    const nextCursor = changes.length
      ? String(changes[changes.length - 1].sequenceNumber)
      : cursor;
    return {
      changes,
      nextCursor,
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    throw new Error(`Unexpected bootstrap for ${centerId}`);
  }
}

class InvalidChangeAdapter implements ISyncApiAdapter {
  async pushOperations(): Promise<PushSyncResponse> {
    return {
      success: true,
      syncedOperationIds: [],
      conflicts: [],
      serverCursor: "999",
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(_centerId: string, cursor: string): Promise<PullSyncResponse> {
    return {
      changes: [{
        sequenceNumber: 101,
        operationId: "invalid-server-operation",
        entityType: "unsupported_entity",
        entityId: "invalid-entity",
        action: "create",
        data: {},
        serverTimestamp: new Date().toISOString(),
      }],
      nextCursor: cursor === "100" ? "101" : cursor,
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    throw new Error(`Unexpected bootstrap for ${centerId}`);
  }
}

describe("Incremental pull backlog continuation", () => {
  beforeAll(() => {
    DatabaseService.init();
    ConnectivityService.setState("online");
  });

  it.each([501, 1000, 1518])(
    "pulls and applies all %i changes across yielding slices",
    async (changeCount) => {
      const centerId = `pull-backlog-center-${changeCount}`;
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)`,
        [
          `pull-backlog-seed-${changeCount}`,
          centerId,
          "Seed teacher",
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      SyncRepository.setServerCursor(centerId, "1");
      SyncRepository.setLastBootstrapTime(centerId);
      SyncEngine.clearRateLimitForTesting();

      let eventLoopYielded = false;
      setTimeout(() => {
        eventLoopYielded = true;
      }, 0);
      const adapter = new BacklogAdapter(changeCount, () => eventLoopYielded);
      SyncEngine.setAdapter(adapter);
      const result = await SyncEngine.syncCenterNow(centerId, { pullLimit: 50 });

      expect(result.state).toBe("online");
      expect(result.errors).toBe(0);
      expect(SyncRepository.getServerCursor(centerId)).toBe(
        String(changeCount + 1),
      );
      expect(adapter.pullCalls).toBe(Math.ceil(changeCount / 50));
      expect(adapter.lastHasMore).toBe(false);
      expect(adapter.yieldObservedBeforeEnd).toBe(true);

      const applied = db.getAllSync<{ id: string }>(
        "SELECT id FROM teachers WHERE center_id = ?",
        [centerId],
      );
      expect(applied).toHaveLength(changeCount + 1);

      SyncEngine.clearRateLimitForTesting();
      const pullCallsBeforeReplay = adapter.pullCalls;
      const repeated = await SyncEngine.syncCenterNow(centerId, { pullLimit: 50 });
      expect(repeated.errors).toBe(0);
      expect(adapter.pullCalls).toBe(pullCallsBeforeReplay + 1);
      expect(SyncRepository.getServerCursor(centerId)).toBe(
        String(changeCount + 1),
      );
      expect(db.getAllSync<{ id: string }>(
        "SELECT id FROM teachers WHERE center_id = ?",
        [centerId],
      )).toHaveLength(changeCount + 1);
    },
  );

  it("advances the local cursor from applied Pull changes, never from Push response", async () => {
    const centerId = `push-cursor-center-${Date.now()}`;
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)`,
      [
        `push-cursor-seed-${centerId}`,
        centerId,
        "Seed teacher",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    SyncRepository.setServerCursor(centerId, "100");
    SyncRepository.setLastBootstrapTime(centerId);
    SyncRepository.enqueueOperation({
      centerId,
      userId: "push-cursor-user",
      deviceId: "push-cursor-device",
      operationType: "create",
      entityType: "teacher",
      entityId: "device-a-teacher",
      payload: { id: "device-a-teacher", name: "Device A teacher" },
      operationId: "device-a-operation",
    });
    SyncEngine.setAdapter(new PushCursorAdapter());
    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();

    const firstSync = await SyncEngine.syncCenterNow(centerId);

    expect(firstSync.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe("101");
    expect(db.getFirstSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id = ?",
      [centerId, "device-b-teacher"],
    )?.id).toBe("device-b-teacher");

    SyncEngine.clearRateLimitForTesting();
    const secondSync = await SyncEngine.syncCenterNow(centerId);

    expect(secondSync.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe("102");
    expect(db.getFirstSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id = ?",
      [centerId, "device-a-teacher"],
    )?.id).toBe("device-a-teacher");
  });

  it("does not advance the cursor when a Pull batch cannot be applied", async () => {
    const centerId = `failed-pull-cursor-center-${Date.now()}`;
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)`,
      [
        `failed-pull-seed-${centerId}`,
        centerId,
        "Seed teacher",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    SyncRepository.setServerCursor(centerId, "100");
    SyncRepository.setLastBootstrapTime(centerId);
    SyncEngine.setAdapter(new InvalidChangeAdapter());
    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();

    const result = await SyncEngine.syncCenterNow(centerId);

    expect(result.state).toBe("error");
    expect(result.errors).toBe(1);
    expect(SyncRepository.getServerCursor(centerId)).toBe("100");
  });
});

describe("Notification pull constraint regression", () => {
  beforeAll(() => {
    DatabaseService.init();
    ConnectivityService.setState("online");
  });

  it("does not abort the pull when a server notification_event collides with a local row on (attendance_id, event_type)", async () => {
    const centerId = `notif-event-constraint-${Date.now()}`;
    const db = DatabaseService.getDb();
    const existingEventId = `local-notif-event-${Date.now()}`;
    const attendanceId = `att-${Date.now()}`;
    const operationId = `local-op-notif-${Date.now()}`;

    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)`,
      [`notif-seed-teacher-${Date.now()}`, centerId, "Seed teacher",
       new Date().toISOString(), new Date().toISOString()],
    );

    // Insert a local notification_event that occupies (center_id, attendance_id, event_type).
    db.runSync(
      `INSERT INTO notification_events
         (id, operation_id, center_id, student_id, session_id, attendance_id, event_type, template_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'user', ?)`,
      [existingEventId, operationId, centerId, "student-1", "session-1",
       attendanceId, "attendance_marked", new Date().toISOString()],
    );

    SyncRepository.setServerCursor(centerId, "1");
    SyncRepository.setLastBootstrapTime(centerId);
    SyncEngine.clearRateLimitForTesting();

    // Server sends a notification_event with the same attendance_id+event_type but a different id.
    // Before the fix this threw UNIQUE constraint violation and aborted the pull (errors: 1).
    const serverEventId = `server-notif-event-${Date.now()}`;
    SyncEngine.setAdapter({
      async pushOperations(): Promise<PushSyncResponse> {
        return { success: true, syncedOperationIds: [], conflicts: [], serverCursor: "1", processedAt: new Date().toISOString() };
      },
      async pullChanges(_centerId: string, cursor: string): Promise<PullSyncResponse> {
        if (cursor === "1") {
          return {
            changes: [{
              sequenceNumber: 2,
              operationId: "srv-notif-op-1",
              entityType: "notification_event",
              entityId: serverEventId,
              action: "create",
              data: {
                id: serverEventId,
                student_id: "student-1",
                session_id: "session-1",
                attendance_id: attendanceId,
                event_type: "attendance_marked",
                template_id: "template-updated-by-server",
                created_by: "system",
                created_at: new Date().toISOString(),
              },
              serverTimestamp: new Date().toISOString(),
            }, {
              sequenceNumber: 3,
              operationId: "srv-teacher-subsequent-1",
              entityType: "teacher",
              entityId: `teacher-after-collision-${Date.now()}`,
              action: "create",
              data: {
                id: `teacher-after-collision-${Date.now()}`,
                name: "Subsequent Teacher After Collision",
                status: "active",
              },
              serverTimestamp: new Date().toISOString(),
            }],
            nextCursor: "3",
            hasMore: false,
            serverTimestamp: new Date().toISOString(),
          };
        }
        return { changes: [], nextCursor: cursor, hasMore: false, serverTimestamp: new Date().toISOString() };
      },
      async bootstrapCenter(): Promise<BootstrapResponse> { throw new Error("Unexpected bootstrap"); },
    } as ISyncApiAdapter);

    const result = await SyncEngine.syncCenterNow(centerId);

    // Pull must NOT have failed — cursor must advance past both changes.
    expect(result.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe("3");

    // The existing local row must still exist (local row preserved without duplicate index collision).
    const localRow = db.getFirstSync<{ id: string }>(
      `SELECT id FROM notification_events WHERE center_id = ? AND attendance_id = ? AND event_type = ?`,
      [centerId, attendanceId, "attendance_marked"],
    );
    expect(localRow?.id).toBe(existingEventId);

    // Subsequent change in the same pull batch was committed and applied.
    const subsequentTeacher = db.getFirstSync<{ name: string }>(
      `SELECT name FROM teachers WHERE center_id = ? AND name = 'Subsequent Teacher After Collision'`,
      [centerId],
    );
    expect(subsequentTeacher).not.toBeNull();
  });

  it("does not abort the pull when a server notification_delivery collides on (notification_event_id, channel)", async () => {
    const centerId = `notif-delivery-constraint-${Date.now()}`;
    const db = DatabaseService.getDb();
    const eventId = `notif-event-for-delivery-${Date.now()}`;
    const localDeliveryId = `local-delivery-${Date.now()}`;

    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)`,
      [`delivery-seed-teacher-${Date.now()}`, centerId, "Seed teacher",
       new Date().toISOString(), new Date().toISOString()],
    );

    db.runSync(
      `INSERT INTO notification_events
         (id, operation_id, center_id, student_id, session_id, attendance_id, event_type, template_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'user', ?)`,
      [eventId, `op-for-event-${Date.now()}`, centerId, "student-2", "session-2",
       "attendance_marked", new Date().toISOString()],
    );

    // Local delivery row occupies (notification_event_id, channel) = (eventId, "sms").
    db.runSync(
      `INSERT INTO notification_deliveries
         (id, center_id, notification_event_id, channel, status, recipient, rendered_message,
          sent_at, failure_reason, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, 'sms', 'pending', '+201000000000', 'Test', NULL, NULL, 0, ?, ?)`,
      [localDeliveryId, centerId, eventId,
       new Date().toISOString(), new Date().toISOString()],
    );

    SyncRepository.setServerCursor(centerId, "1");
    SyncRepository.setLastBootstrapTime(centerId);
    SyncEngine.clearRateLimitForTesting();

    const serverDeliveryId = `server-delivery-${Date.now()}`;
    SyncEngine.setAdapter({
      async pushOperations(): Promise<PushSyncResponse> {
        return { success: true, syncedOperationIds: [], conflicts: [], serverCursor: "1", processedAt: new Date().toISOString() };
      },
      async pullChanges(_centerId: string, cursor: string): Promise<PullSyncResponse> {
        if (cursor === "1") {
          return {
            changes: [{
              sequenceNumber: 2,
              operationId: "srv-delivery-op-1",
              entityType: "notification_delivery",
              entityId: serverDeliveryId,
              action: "create",
              data: {
                id: serverDeliveryId,
                notification_event_id: eventId,
                channel: "sms",
                status: "sent",
                recipient: "+201000000000",
                rendered_message: "Test",
                retry_count: 0,
                provider_message_id: "prov-msg-12345",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              serverTimestamp: new Date().toISOString(),
            }, {
              sequenceNumber: 3,
              operationId: "srv-teacher-subsequent-2",
              entityType: "teacher",
              entityId: `teacher-after-delivery-collision-${Date.now()}`,
              action: "create",
              data: {
                id: `teacher-after-delivery-collision-${Date.now()}`,
                name: "Subsequent Teacher After Delivery Collision",
                status: "active",
              },
              serverTimestamp: new Date().toISOString(),
            }],
            nextCursor: "3",
            hasMore: false,
            serverTimestamp: new Date().toISOString(),
          };
        }
        return { changes: [], nextCursor: cursor, hasMore: false, serverTimestamp: new Date().toISOString() };
      },
      async bootstrapCenter(): Promise<BootstrapResponse> { throw new Error("Unexpected bootstrap"); },
    } as ISyncApiAdapter);

    const result = await SyncEngine.syncCenterNow(centerId);

    // Pull must NOT fail — cursor must advance past all batch changes.
    expect(result.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe("3");

    // The delivery row for this event must still exist and must not regress.
    const delivery = db.getFirstSync<{ id: string; status: string }>(
      `SELECT id, status FROM notification_deliveries
       WHERE center_id = ? AND notification_event_id = ? AND channel = 'sms'`,
      [centerId, eventId],
    );
    expect(delivery).not.toBeNull();
    expect(["pending", "queued", "sent", "failed"]).toContain(delivery?.status);

    // Subsequent change in the same batch was successfully applied.
    const subsequentTeacher = db.getFirstSync<{ name: string }>(
      `SELECT name FROM teachers WHERE center_id = ? AND name = 'Subsequent Teacher After Delivery Collision'`,
      [centerId],
    );
    expect(subsequentTeacher).not.toBeNull();
  });
});
