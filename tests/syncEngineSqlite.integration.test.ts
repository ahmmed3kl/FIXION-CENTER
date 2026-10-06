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
});
