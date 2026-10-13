import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BootstrapResponse, ISyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import {
  PullSyncResponse,
  PushSyncResponse,
  ServerChangeRecord,
  SyncOperationPayload,
} from "../src/core/api/contracts";
import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService, SqlDatabase } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";

jest.mock("expo-device", () => ({ modelName: null }));

interface NativeStatement {
  all(...parameters: any[]): unknown[];
  get(...parameters: any[]): unknown;
  run(...parameters: any[]): unknown;
}

interface NativeSqlite {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeSqliteConstructor {
  new (filename: string): NativeSqlite;
}

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: NativeSqliteConstructor;
};

class RealSqliteDatabase implements SqlDatabase {
  constructor(
    readonly filename: string,
    private readonly connection: NativeSqlite = new DatabaseSync(filename),
  ) {}

  execSync(sql: string): void {
    this.connection.exec(sql);
  }

  runSync(sql: string, ...parameters: any[]): unknown {
    return this.connection.prepare(sql).run(...this.flatten(parameters));
  }

  getAllSync<T = any>(sql: string, ...parameters: any[]): T[] {
    return this.connection.prepare(sql).all(...this.flatten(parameters)) as T[];
  }

  getFirstSync<T = any>(sql: string, ...parameters: any[]): T | null {
    return (this.connection.prepare(sql).get(...this.flatten(parameters)) as T | undefined) || null;
  }

  close(): void {
    this.connection.close();
  }

  private flatten(parameters: any[]): any[] {
    return parameters.length === 1 && Array.isArray(parameters[0])
      ? parameters[0]
      : parameters;
  }
}

class SharedServerAdapter implements ISyncApiAdapter {
  sequence = 100;
  pullCalls = 0;
  pushCalls = 0;
  loseNextPushResponse = false;
  readonly changes: ServerChangeRecord[] = [];
  private readonly operationSequences = new Map<string, number>();

  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.pushCalls += 1;
    const syncedOperationIds: string[] = [];
    for (const operation of operations) {
      let sequence = this.operationSequences.get(operation.operationId);
      if (!sequence) {
        sequence = ++this.sequence;
        this.operationSequences.set(operation.operationId, sequence);
        this.changes.push({
          sequenceNumber: sequence,
          operationId: operation.operationId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          action: operation.operationType.toLowerCase() as "create" | "update" | "delete",
          data: operation.payload,
          serverTimestamp: new Date().toISOString(),
        });
      }
      syncedOperationIds.push(operation.operationId);
    }

    if (this.loseNextPushResponse) {
      this.loseNextPushResponse = false;
      throw new Error("simulated response loss after server commit");
    }
    return {
      success: true,
      syncedOperationIds,
      conflicts: [],
      serverCursor: String(this.sequence),
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
    limit = 50,
  ): Promise<PullSyncResponse> {
    this.pullCalls += 1;
    const batch = this.changes
      .filter((change) => change.sequenceNumber > Number(cursor))
      .slice(0, limit);
    const remaining = this.changes.filter(
      (change) => change.sequenceNumber > Number(cursor),
    );
    const nextCursor = batch.length
      ? String(batch[batch.length - 1].sequenceNumber)
      : cursor;
    return {
      changes: batch,
      nextCursor,
      hasMore: remaining.length > batch.length,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    throw new Error(`Unexpected bootstrap request for ${centerId}`);
  }
}

class InvalidChangeAdapter extends SharedServerAdapter {
  async pullChanges(
    _centerId: string,
    cursor: string,
  ): Promise<PullSyncResponse> {
    this.pullCalls += 1;
    return {
      changes: [{
        sequenceNumber: Number(cursor) + 1,
        operationId: "unsupported-server-change",
        entityType: "unsupported_entity",
        entityId: "unsupported-entity",
        action: "create",
        data: {},
        serverTimestamp: new Date().toISOString(),
      }],
      nextCursor: String(Number(cursor) + 1),
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }
}

class SpecificRetryAdapter implements ISyncApiAdapter {
  calls: SyncOperationPayload[][] = [];
  bootstrapGroups: BootstrapResponse["groups"] | null = null;
  bootstrapCalls = 0;
  response: PushSyncResponse = {
    success: true,
    syncedOperationIds: [],
    conflicts: [],
    serverCursor: "100",
    processedAt: new Date().toISOString(),
  };

  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.calls.push(operations);
    return this.response;
  }

  async pullChanges(
    _centerId: string,
    cursor: string,
  ): Promise<PullSyncResponse> {
    return {
      changes: [],
      nextCursor: cursor,
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }

  async bootstrapCenter(_centerId: string): Promise<BootstrapResponse> {
    this.bootstrapCalls += 1;
    if (!this.bootstrapGroups) throw new Error("Unexpected bootstrap request");
    return { groups: this.bootstrapGroups } as BootstrapResponse;
  }
}

class StaleTeacherUpdateAdapter extends SharedServerAdapter {
  async pushOperations(
    _centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    this.pushCalls += 1;
    return {
      success: true,
      syncedOperationIds: [],
      conflicts: operations.map((operation) => ({
        operationId: operation.operationId,
        entityType: operation.entityType,
        entityId: operation.entityId,
        reason: "STALE_UPDATE: server has a newer version of this record.",
        resolution: "server_wins",
        serverState: { weekStartDay: 4 },
      })),
      serverCursor: String(this.sequence),
      processedAt: new Date().toISOString(),
    };
  }
}

describe("SyncEngine against independent persistent SQLite databases", () => {
  let tempDirectory: string;
  let originalDatabase: SqlDatabase;
  let originalAdapter: ISyncApiAdapter;
  const openedDatabases: RealSqliteDatabase[] = [];

  function createClientDatabase(name: string, centerId: string, cursor = "100"): RealSqliteDatabase {
    const database = new RealSqliteDatabase(path.join(tempDirectory, `${name}.sqlite`));
    openedDatabases.push(database);
    DatabaseService.runMigrations(database);
    database.runSync(
      `INSERT INTO teachers (id, center_id, name, status, created_at, updated_at)
       VALUES (?, ?, 'Local seed', 'active', ?, ?)`,
      [`seed-${name}`, centerId, new Date().toISOString(), new Date().toISOString()],
    );
    DatabaseService.setMockDb(database);
    SyncRepository.setServerCursor(centerId, cursor);
    SyncRepository.setLastBootstrapTime(centerId);
    return database;
  }

  function enqueueTeacher(
    centerId: string,
    deviceNumber: number,
    operationId: string,
    teacherId = `engine-teacher-${deviceNumber}`,
  ): void {
    SyncRepository.enqueueOperation({
      centerId,
      userId: `engine-user-${deviceNumber}`,
      deviceId: `engine-device-${deviceNumber}`,
      operationType: "create",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        name: `Device ${deviceNumber} teacher`,
      },
      operationId,
    });
  }

  beforeAll(() => {
    DatabaseService.init();
    originalDatabase = DatabaseService.getDb();
    originalAdapter = SyncEngine.getAdapter();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fixion-sync-engine-"));
  });

  afterAll(() => {
    openedDatabases.forEach((database) => database.close());
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    DatabaseService.setMockDb(originalDatabase);
    SyncEngine.setAdapter(originalAdapter);
    ConnectivityService.setState("online");
  });

  beforeEach(() => {
    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();
  });

  it("runs four independent real SyncEngine clients through push, pull, retry, offline recovery, and restart", async () => {
    const centerId = `engine-center-${Date.now()}`;
    const server = new SharedServerAdapter();
    SyncEngine.setAdapter(server);
    const clients = Array.from({ length: 4 }, (_, index) =>
      createClientDatabase(`device-${index + 1}`, centerId),
    );

    for (let index = 0; index < clients.length; index += 1) {
      DatabaseService.setMockDb(clients[index]);
      enqueueTeacher(centerId, index + 1, `engine-create-${index + 1}`);
      SyncEngine.clearRateLimitForTesting();
      const result = await SyncEngine.syncCenterNow(centerId);
      expect(result.state).toBe("online");
      expect(result.syncedCount).toBe(1);
      expect(result.errors).toBe(0);
      if (index === 0) {
        expect(SyncRepository.getServerCursor(centerId)).toBe("100");
      }
    }

    for (const client of clients) {
      DatabaseService.setMockDb(client);
      SyncEngine.clearRateLimitForTesting();
      const result = await SyncEngine.syncCenterNow(centerId);
      expect(result.errors).toBe(0);
      expect(SyncRepository.getServerCursor(centerId)).toBe(String(server.sequence));
      expect(client.getAllSync<{ id: string }>(
        "SELECT id FROM teachers WHERE center_id = ? AND id LIKE 'engine-teacher-%'",
        [centerId],
      )).toHaveLength(4);
    }

    DatabaseService.setMockDb(clients[0]);
    enqueueTeacher(centerId, 1, "engine-response-loss", "engine-teacher-loss");
    server.loseNextPushResponse = true;
    SyncEngine.clearRateLimitForTesting();
    const lostResponse = await SyncEngine.syncCenterNow(centerId);
    expect(lostResponse.state).toBe("error");
    expect(clients[0].getFirstSync<{ status: string }>(
      "SELECT status FROM sync_operations WHERE operation_id = ?",
      ["engine-response-loss"],
    )?.status).toBe("failed");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(SyncRepository.getPendingOperations(centerId).some(
      (operation) => operation.operationId === "engine-response-loss",
    )).toBe(true);
    SyncEngine.clearRateLimitForTesting();
    const retried = await SyncEngine.syncCenterNow(centerId);
    expect(retried.syncedCount).toBe(1);
    expect(server.changes.filter(
      (change) => change.operationId === "engine-response-loss",
    )).toHaveLength(1);
    expect(SyncRepository.getPendingOperations(centerId)).toHaveLength(0);

    enqueueTeacher(centerId, 1, "engine-offline-reconnect", "engine-teacher-offline");
    ConnectivityService.setState("offline");
    SyncEngine.clearRateLimitForTesting();
    const offline = await SyncEngine.syncCenterNow(centerId);
    expect(offline.state).toBe("offline");
    expect(SyncRepository.getPendingOperations(centerId)).toHaveLength(1);
    const pushesWhileOffline = server.pushCalls;

    ConnectivityService.setState("online");
    SyncEngine.clearRateLimitForTesting();
    const reconnected = await SyncEngine.syncCenterNow(centerId);
    expect(reconnected.syncedCount).toBe(1);
    expect(server.pushCalls).toBe(pushesWhileOffline + 1);

    const cursorBeforeRestart = SyncRepository.getServerCursor(centerId);
    const closedIndex = openedDatabases.indexOf(clients[0]);
    if (closedIndex >= 0) openedDatabases.splice(closedIndex, 1);
    clients[0].close();
    const restartedDatabase = new RealSqliteDatabase(clients[0].filename);
    openedDatabases.push(restartedDatabase);
    DatabaseService.setMockDb(restartedDatabase);
    expect(SyncRepository.getServerCursor(centerId)).toBe(cursorBeforeRestart);

    SyncEngine.clearRateLimitForTesting();
    const afterRestart = await SyncEngine.syncCenterNow(centerId);
    expect(afterRestart.errors).toBe(0);
    expect(SyncRepository.getServerCursor(centerId)).toBe(String(server.sequence));
    expect(restartedDatabase.getAllSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id LIKE 'engine-teacher-%'",
      [centerId],
    )).toHaveLength(6);

    const pullsBeforeRateLimit = server.pullCalls;
    const rateLimited = await SyncEngine.syncCenterNow(centerId);
    expect(rateLimited.state).toBe("online");
    expect(server.pullCalls).toBe(pullsBeforeRateLimit);
  });

  it("synchronizes a teacher week-start change from one persistent device database to another", async () => {
    const centerId = `teacher-week-sync-${Date.now()}`;
    const teacherId = "shared-week-teacher";
    const timestamp = new Date().toISOString();
    const firstDevice = createClientDatabase("teacher-week-device-1", centerId);
    const secondDevice = createClientDatabase("teacher-week-device-2", centerId);
    for (const database of [firstDevice, secondDevice]) {
      database.runSync(
        `INSERT INTO teachers (id, center_id, name, status, week_start_day, created_at, updated_at)
         VALUES (?, ?, 'Shared teacher', 'active', 6, ?, ?)`,
        [teacherId, centerId, timestamp, timestamp],
      );
    }

    const server = new SharedServerAdapter();
    SyncEngine.setAdapter(server);
    try {
      const changedAt = new Date(Date.now() + 1).toISOString();
      firstDevice.runSync(
        "UPDATE teachers SET week_start_day = ?, updated_at = ? WHERE center_id = ? AND id = ?",
        [2, changedAt, centerId, teacherId],
      );
      DatabaseService.setMockDb(firstDevice);
      SyncRepository.enqueueOperation({
        operationId: "teacher-week-device-1-update",
        centerId,
        userId: "admin-user",
        deviceId: "device-1",
        operationType: "UPDATE",
        entityType: "teacher",
        entityId: teacherId,
        payload: {
          id: teacherId,
          teacherId,
          weekStartDay: 2,
          baseUpdatedAt: timestamp,
          updatedAt: changedAt,
        },
      });

      const firstSync = await SyncEngine.syncCenterNow(centerId);
      expect(firstSync.errors).toBe(0);

      DatabaseService.setMockDb(secondDevice);
      SyncEngine.clearRateLimitForTesting();
      const secondSync = await SyncEngine.syncCenterNow(centerId);
      expect(secondSync.errors).toBe(0);
      expect(secondDevice.getFirstSync<{ week_start_day: number; name: string }>(
        "SELECT week_start_day, name FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 2, name: "Shared teacher" });
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("keeps a newer server week-start over an older pending local edit through conflict resolution and restart", async () => {
    const centerId = `teacher-week-stale-${Date.now()}`;
    const teacherId = "stale-week-teacher";
    const baseUpdatedAt = "2026-10-01T10:00:00.000Z";
    const localUpdatedAt = "2026-10-02T10:00:00.000Z";
    const serverUpdatedAt = "2026-10-03T10:00:00.000Z";
    const device = createClientDatabase("teacher-week-stale-device", centerId);
    device.runSync(
      `INSERT INTO teachers (id, center_id, name, status, week_start_day, created_at, updated_at)
       VALUES (?, ?, 'Teacher', 'active', 6, ?, ?)`,
      [teacherId, centerId, baseUpdatedAt, baseUpdatedAt],
    );
    device.runSync(
      "UPDATE teachers SET week_start_day = ?, updated_at = ? WHERE center_id = ? AND id = ?",
      [2, localUpdatedAt, centerId, teacherId],
    );
    SyncRepository.enqueueOperation({
      operationId: "old-pending-week-start",
      centerId,
      userId: "admin-user",
      deviceId: "offline-device",
      operationType: "UPDATE",
      entityType: "teacher",
      entityId: teacherId,
      payload: {
        id: teacherId,
        teacherId,
        weekStartDay: 2,
        baseUpdatedAt,
        updatedAt: localUpdatedAt,
      },
    });

    const server = new StaleTeacherUpdateAdapter();
    server.sequence = 101;
    server.changes.push({
      sequenceNumber: 101,
      operationId: "newer-server-week-start",
      entityType: "teacher",
      entityId: teacherId,
      action: "update",
      data: {
        id: teacherId,
        name: "Teacher",
        status: "active",
        weekStartDay: 4,
        updatedAt: serverUpdatedAt,
      },
      serverTimestamp: serverUpdatedAt,
    });
    SyncEngine.setAdapter(server);
    DatabaseService.setMockDb(device);
    try {
      const firstSync = await SyncEngine.syncCenterNow(centerId);
      expect(firstSync.conflicts).toBe(1);
      expect(device.getFirstSync<{ week_start_day: number }>(
        "SELECT week_start_day FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 4 });
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("conflict");
      expect(SyncRepository.getConflicts(centerId).map((conflict) => conflict.operationId))
        .toContain("old-pending-week-start");

      SyncEngine.clearRateLimitForTesting();
      const resolvedSync = await SyncEngine.syncCenterNow(centerId);
      expect(resolvedSync.errors).toBe(0);
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("synced");
      expect(SyncRepository.getConflicts(centerId)).toHaveLength(0);

      const closedIndex = openedDatabases.indexOf(device);
      if (closedIndex >= 0) openedDatabases.splice(closedIndex, 1);
      device.close();
      const reopenedDevice = new RealSqliteDatabase(device.filename);
      openedDatabases.push(reopenedDevice);
      DatabaseService.setMockDb(reopenedDevice);
      expect(reopenedDevice.getFirstSync<{ week_start_day: number }>(
        "SELECT week_start_day FROM teachers WHERE center_id = ? AND id = ?",
        [centerId, teacherId],
      )).toEqual({ week_start_day: 4 });
      expect(SyncRepository.getByOperationId("old-pending-week-start")?.status).toBe("synced");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("keeps the persisted cursor unchanged when real SyncEngine cannot apply a pull batch", async () => {
    const centerId = `engine-failed-apply-${Date.now()}`;
    const database = createClientDatabase("failed-apply", centerId);
    SyncEngine.setAdapter(new InvalidChangeAdapter());

    const result = await SyncEngine.syncCenterNow(centerId);

    expect(result.state).toBe("error");
    expect(result.errors).toBe(1);
    expect(SyncRepository.getServerCursor(centerId)).toBe("100");
    expect(database.getFirstSync<{ id: string }>(
      "SELECT id FROM teachers WHERE center_id = ? AND id = 'unsupported-entity'",
      [centerId],
    )).toBeNull();
  });

  it("retries only the selected legacy group schedule update with its original operation id and payload", async () => {
    const centerId = `engine-targeted-retry-${Date.now()}`;
    const database = createClientDatabase("targeted-retry", centerId);
    const targetOperationId = "legacy-schedule-update-10";
    SyncRepository.enqueueOperation({
      operationId: "other-schedule-history",
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: { id: "legacy-schedule-id", startTime: "08:00", endTime: "09:00" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', last_error = 'Unrelated historical conflict'
       WHERE operation_id = ?`,
      ["other-schedule-history"],
    );
    const originalPayload = {
      id: "legacy-schedule-id",
      groupId: "legacy-group-id",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "11:00",
      updatedAt: "2026-10-10T10:00:00.000Z",
    };
    SyncRepository.enqueueOperation({
      operationId: targetOperationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: originalPayload,
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', retry_count = 10,
           last_error = 'column "updated_at" does not exist'
       WHERE operation_id = ?`,
      [targetOperationId],
    );
    SyncRepository.enqueueOperation({
      operationId: "unrelated-pending-operation",
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group",
      entityId: "unrelated-group-id",
      payload: { id: "unrelated-group-id" },
    });

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      adapter.response.syncedOperationIds = [targetOperationId];
      const result = await SyncEngine.retryLegacyGroupScheduleUpdate(
        centerId,
        targetOperationId,
      );

      expect(result).toBe("synced");
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]).toHaveLength(1);
      expect(adapter.calls[0][0]).toMatchObject({
        operationId: targetOperationId,
        centerId,
        operationType: "UPDATE",
        entityType: "group_schedule",
        entityId: "legacy-schedule-id",
        payload: originalPayload,
      });
      expect(SyncRepository.getByOperationId(targetOperationId)?.retryCount).toBe(10);
      expect(SyncRepository.getByOperationId(targetOperationId)?.status).toBe("synced");
      expect(SyncRepository.getByOperationId("unrelated-pending-operation")?.status).toBe("pending");
      expect(SyncRepository.getByOperationId("other-schedule-history")?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("rejects targeted retry for a teacher schedule conflict without sending it", async () => {
    const centerId = `engine-targeted-conflict-${Date.now()}`;
    const database = createClientDatabase("targeted-conflict", centerId);
    const operationId = "legacy-schedule-teacher-conflict";
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: "legacy-schedule-id",
      payload: { id: "legacy-schedule-id" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', retry_count = 10,
           last_error = 'TEACHER_SCHEDULE_CONFLICT: column "updated_at" does not exist'
       WHERE operation_id = ?`,
      [operationId],
    );

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      await expect(
        SyncEngine.retryLegacyGroupScheduleUpdate(centerId, operationId),
      ).rejects.toThrow("العملية غير مؤهلة لإعادة المحاولة الآمنة");
      expect(adapter.calls).toHaveLength(0);
      expect(SyncRepository.getByOperationId(operationId)?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });

  it("reconciles a group-delete conflict from fresh server state before deciding whether to retry", async () => {
    const centerId = `engine-group-delete-retry-${Date.now()}`;
    const database = createClientDatabase("group-delete-retry", centerId);
    const operationId = `op-grp-delete-${Date.now()}-group-1`;
    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: "retry-user",
      deviceId: "retry-device",
      operationType: "DELETE",
      entityType: "group",
      entityId: "group-1",
      payload: { id: "group-1" },
    });
    database.runSync(
      `UPDATE sync_operations
       SET status = 'conflict', last_error = 'column "status" does not exist'
       WHERE operation_id = ?`,
      [operationId],
    );

    const adapter = new SpecificRetryAdapter();
    SyncEngine.setAdapter(adapter);
    try {
      adapter.bootstrapGroups = [{ id: "group-1", deleted: false }];
      adapter.response.syncedOperationIds = [operationId];
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, operationId),
      ).resolves.toBe("synced");
      expect(adapter.bootstrapCalls).toBe(1);
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]).toHaveLength(1);
      expect(adapter.calls[0][0]).toMatchObject({
        operationId,
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-1",
      });
      expect(SyncRepository.getByOperationId(operationId)?.status).toBe("synced");

      const alreadyDeletedId = `op-grp-delete-${Date.now()}-group-2`;
      SyncRepository.enqueueOperation({
        operationId: alreadyDeletedId,
        centerId,
        userId: "retry-user",
        deviceId: "retry-device",
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-2",
        payload: { id: "group-2" },
      });
      database.runSync(
        `UPDATE sync_operations
         SET status = 'conflict', last_error = 'column "status" does not exist'
         WHERE operation_id = ?`,
        [alreadyDeletedId],
      );
      adapter.bootstrapGroups = [{ id: "group-2", deleted: true }];
      const pushesBeforeAlreadyDeleted = adapter.calls.length;
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, alreadyDeletedId),
      ).resolves.toBe("already_deleted");
      expect(adapter.calls).toHaveLength(pushesBeforeAlreadyDeleted);
      expect(SyncRepository.getByOperationId(alreadyDeletedId)?.status).toBe("synced");

      const unknownStateId = `op-grp-delete-${Date.now()}-group-3`;
      SyncRepository.enqueueOperation({
        operationId: unknownStateId,
        centerId,
        userId: "retry-user",
        deviceId: "retry-device",
        operationType: "DELETE",
        entityType: "group",
        entityId: "group-3",
        payload: { id: "group-3" },
      });
      database.runSync(
        `UPDATE sync_operations
         SET status = 'conflict', last_error = 'column "status" does not exist'
         WHERE operation_id = ?`,
        [unknownStateId],
      );
      adapter.bootstrapGroups = [];
      await expect(
        SyncEngine.retryFailedGroupDelete(centerId, unknownStateId),
      ).rejects.toThrow("تعذر التحقق من وجود المجموعة على الخادم");
      expect(adapter.calls).toHaveLength(pushesBeforeAlreadyDeleted);
      expect(SyncRepository.getByOperationId(unknownStateId)?.status).toBe("conflict");
    } finally {
      SyncEngine.setAdapter(originalAdapter);
    }
  });
});
