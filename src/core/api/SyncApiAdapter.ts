import { env } from "../../config/env";
import { DeviceService } from "../device";
import {
    PullSyncResponse,
    PushSyncRequest,
    PushSyncResponse,
    SyncOperationPayload
} from "./contracts";
import { ApiClient } from "./index";

export interface ISyncApiAdapter {
  pushOperations(
    centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse>;

  pullChanges(
    centerId: string,
    cursor: string,
    limit?: number,
  ): Promise<PullSyncResponse>;
}

/**
 * Real HTTP Axios adapter connecting to FIXION backend contracts:
 * POST /sync/push
 * GET  /sync/pull?cursor=...&limit=...
 */
export class HttpSyncApiAdapter implements ISyncApiAdapter {
  async pushOperations(
    centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    const client = ApiClient.getInstance();
    const deviceId = DeviceService.getDeviceIdSync();

    const requestBody: PushSyncRequest = {
      centerId,
      deviceId,
      clientVersion: env.appVersion,
      operations,
    };

    const response = await client.post<PushSyncResponse>(
      "/sync/push",
      requestBody,
    );
    return response.data;
  }

  async pullChanges(
    centerId: string,
    cursor: string,
    limit: number = 50,
  ): Promise<PullSyncResponse> {
    const client = ApiClient.getInstance();
    const response = await client.get<PullSyncResponse>("/sync/pull", {
      params: {
        centerId,
        cursor,
        limit,
      },
    });
    return response.data;
  }
}

/**
 * Deterministic Mock Adapter for testing and offline-first simulation without a real server.
 */
export class MockSyncApiAdapter implements ISyncApiAdapter {
  private currentCursorSeq = 1000;
  private failNextPush = false;
  private conflictOperationIds = new Set<string>();

  setFailNextPush(fail: boolean) {
    this.failNextPush = fail;
  }

  addConflict(operationId: string) {
    this.conflictOperationIds.add(operationId);
  }

  clearConflicts() {
    this.conflictOperationIds.clear();
  }

  async pushOperations(
    centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("Mock network connection timeout on push");
    }

    const syncedOperationIds: string[] = [];
    const conflicts: any[] = [];

    for (const op of operations) {
      if (this.conflictOperationIds.has(op.operationId)) {
        conflicts.push({
          operationId: op.operationId,
          entityType: op.entityType,
          entityId: op.entityId,
          reason: "Server conflict detected",
          resolution: "server_wins",
        });
      } else {
        syncedOperationIds.push(op.operationId);
      }
    }

    this.currentCursorSeq += operations.length;

    return {
      success: conflicts.length === 0,
      syncedOperationIds,
      conflicts,
      serverCursor: `srv_seq_${this.currentCursorSeq}`,
      processedAt: new Date().toISOString(),
    };
  }

  async pullChanges(
    centerId: string,
    cursor: string,
    limit: number = 50,
  ): Promise<PullSyncResponse> {
    return {
      changes: [],
      nextCursor: cursor || `srv_seq_${this.currentCursorSeq}`,
      hasMore: false,
      serverTimestamp: new Date().toISOString(),
    };
  }
}
