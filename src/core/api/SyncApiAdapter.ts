import { Platform } from "react-native";
import { env } from "../../config/env";
import { DeviceService } from "../device";
import {
    PullSyncResponse,
    PushSyncRequest,
    PushSyncResponse,
    SyncOperationPayload,
} from "./contracts";
import { ApiClient } from "./index";

export interface BootstrapResponse {
  centerId: string;
  students: any[];
  cards: any[];
  groups: any[];
  teachers: any[];
  subjects: any[];
  teacherSubjects?: any[];
  schedules?: any[];
  sessions: any[];
  enrollments: any[];
  packages?: any[];
  packageSubjects?: any[];
  packageSubscriptions?: any[];
  packageTeacherOverrides?: any[];
  debtCycles?: any[];
  notificationEvents?: any[];
  notificationDeliveries?: any[];
  sessionClosings?: any[];
  dailyClosings?: any[];
  latestServerSeq: number;
  timestamp: string;
}

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

  bootstrapCenter(centerId: string): Promise<BootstrapResponse>;
}

/**
 * Real HTTP Axios adapter connecting to FIXION backend contracts:
 * POST /sync/push
 * GET  /sync/pull?cursor=...&limit=...
 * GET  /sync/bootstrap?centerId=...
 */
export class HttpSyncApiAdapter implements ISyncApiAdapter {
  private async ensureDeviceRegistered(
    centerId: string,
    deviceId: string,
  ): Promise<void> {
    try {
      const client = ApiClient.getInstance();
      await client.post(
        "/devices/register",
        {
          deviceId,
          deviceName: `${Platform.OS.toUpperCase()}-Device-${deviceId.slice(-4)}`,
          platform: Platform.OS,
          appVersion: env.appVersion,
        },
        {
          headers: {
            "X-Center-Id": centerId,
            "X-Device-Id": deviceId,
          },
        },
      );
    } catch (e) {
      console.warn("Auto-register device notice:", e);
    }
  }

  async pushOperations(
    centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    const client = ApiClient.getInstance();
    const deviceId = await DeviceService.getDeviceId();

    const requestBody: PushSyncRequest = {
      centerId,
      deviceId,
      clientVersion: env.appVersion,
      operations,
    };

    try {
      const response = await client.post<PushSyncResponse>(
        "/sync/push",
        requestBody,
        {
          headers: {
            "X-Center-Id": centerId,
            "X-Device-Id": deviceId,
          },
        },
      );
      return response.data;
    } catch (err: any) {
      const isDeviceErr =
        err?.code === "FORBIDDEN" ||
        err?.statusCode === 403 ||
        err?.message?.includes("Device") ||
        err?.message?.includes("device") ||
        err?.userMessage?.includes("الجهاز");

      throw err;
    }
  }

  async pullChanges(
    centerId: string,
    cursor: string,
    limit: number = 50,
  ): Promise<PullSyncResponse> {
    const client = ApiClient.getInstance();
    const deviceId = await DeviceService.getDeviceId();

    const fetchPull = () =>
      client.get<PullSyncResponse>("/sync/pull", {
        params: {
          centerId,
          cursor,
          limit,
        },
        headers: {
          "X-Center-Id": centerId,
          "X-Device-Id": deviceId,
        },
      });

    try {
      const response = await fetchPull();
      return response.data;
    } catch (err: any) {
      const isDeviceErr =
        err?.code === "FORBIDDEN" ||
        err?.statusCode === 403 ||
        err?.message?.includes("Device") ||
        err?.message?.includes("device") ||
        err?.userMessage?.includes("الجهاز");

      if (isDeviceErr) {
        await this.ensureDeviceRegistered(centerId, deviceId);
        const retryResponse = await fetchPull();
        return retryResponse.data;
      }
      throw err;
    }
  }

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    const client = ApiClient.getInstance();
    const deviceId = await DeviceService.getDeviceId();

    const fetchBootstrap = () =>
      client.get<BootstrapResponse>("/sync/bootstrap", {
        params: { centerId },
        headers: {
          "X-Center-Id": centerId,
          "X-Device-Id": deviceId,
        },
      });

    try {
      const response = await fetchBootstrap();
      return response.data;
    } catch (err: any) {
      // If endpoint not found on server (404), return empty snapshot gracefully
      if (err?.statusCode === 404 || err?.code === "NOT_FOUND") {
        return {
          centerId,
          students: [],
          cards: [],
          groups: [],
          teachers: [],
          subjects: [],
          sessions: [],
          enrollments: [],
          latestServerSeq: 0,
          timestamp: new Date().toISOString(),
        };
      }

      const isDeviceErr =
        err?.code === "FORBIDDEN" ||
        err?.statusCode === 403 ||
        err?.message?.includes("Device") ||
        err?.message?.includes("device") ||
        err?.userMessage?.includes("الجهاز");

      if (isDeviceErr) {
        await this.ensureDeviceRegistered(centerId, deviceId);
        try {
          const retryResponse = await fetchBootstrap();
          return retryResponse.data;
        } catch {
          return {
            centerId,
            students: [],
            cards: [],
            groups: [],
            teachers: [],
            subjects: [],
            sessions: [],
            enrollments: [],
            latestServerSeq: 0,
            timestamp: new Date().toISOString(),
          };
        }
      }
      throw err;
    }
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

  async bootstrapCenter(centerId: string): Promise<BootstrapResponse> {
    return {
      centerId,
      students: [],
      cards: [],
      groups: [],
      teachers: [],
      subjects: [],
      sessions: [],
      enrollments: [],
      latestServerSeq: 1000,
      timestamp: new Date().toISOString(),
    };
  }
}
