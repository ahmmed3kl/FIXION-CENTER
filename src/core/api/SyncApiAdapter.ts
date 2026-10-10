import { Platform } from "react-native";
import { env } from "../../config/env";
import { DeviceService } from "../device";
import { Logger } from "../logger";
import {
    PullSyncResponse,
    PushSyncRequest,
    PushSyncResponse,
    SyncOperationPayload,
} from "./contracts";
import { ApiClient } from "./index";
import type { CardRangeRecord } from "../../features/students/CardRangeRepository";

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
  expectedStudents?: any[];
  enrollments: any[];
  attendance?: any[];
  payments?: any[];
  paymentReversals?: any[];
  debtAdjustments?: any[];
  packages?: any[];
  packageSubjects?: any[];
  packageSubscriptions?: any[];
  packageTeacherOverrides?: any[];
  advanceCoverages?: any[];
  notificationTemplates?: any[];
  debtCycles?: any[];
  notificationEvents?: any[];
  notificationDeliveries?: any[];
  sessionClosings?: any[];
  dailyClosings?: any[];
  gradeExams?: any[];
  gradeScores?: any[];
  homeworkEvaluationStatuses?: any[];
  sessionHomeworkEvaluations?: any[];
  academicStages?: any;
  cardRanges?: CardRangeRecord[];
  resetGeneration?: number;
  /** Time at which the server reset generation was advanced. */
  resetAt?: string;
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

// Different timeouts for different sync operations
const PUSH_TIMEOUT_MS = 15_000;        // Push operations should be fast
const PULL_TIMEOUT_MS = 20_000;        // Pull is medium priority
const BOOTSTRAP_TIMEOUT_MS = 45_000;   // Bootstrap can take longer

/**
 * Real HTTP Axios adapter connecting to FIXION backend contracts:
 * POST /sync/push
 * GET  /sync/pull?cursor=...&limit=...
 * GET  /sync/bootstrap?centerId=...
 */
export class HttpSyncApiAdapter implements ISyncApiAdapter {
  private readonly registeredDevices = new Map<string, number>();

  private async ensureDeviceRegistered(
    centerId: string,
    deviceId: string,
  ): Promise<void> {
    const deviceName = DeviceService.getDeviceModelName();
    const registrationKey = `${centerId}:${deviceId}:${deviceName}`;
    const lastRegisteredAt = this.registeredDevices.get(registrationKey);
    if (lastRegisteredAt && Date.now() - lastRegisteredAt < 5 * 60_000) {
      return;
    }

    try {
      const client = ApiClient.getInstance();
      await client.post(
        "/devices/register",
        {
          deviceId,
          deviceName,
          platform: Platform.OS,
          appVersion: env.appVersion,
        },
        {
          timeout: PUSH_TIMEOUT_MS,
          headers: {
            "X-Center-Id": centerId,
            "X-Device-Id": deviceId,
            "X-Device-Name": deviceName,
          },
        },
      );
      this.registeredDevices.set(registrationKey, Date.now());
    } catch (e: any) {
      Logger.info("sync", "device_auto_register_attempt", {
        centerId,
        metadata: { deviceSuffix: deviceId.slice(-4), error: e?.message },
      });
    }
  }

  async pushOperations(
    centerId: string,
    operations: SyncOperationPayload[],
  ): Promise<PushSyncResponse> {
    const client = ApiClient.getInstance();
    const deviceId = await DeviceService.getDeviceId();
    await this.ensureDeviceRegistered(centerId, deviceId);

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
          timeout: PUSH_TIMEOUT_MS,
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
    await this.ensureDeviceRegistered(centerId, deviceId);

    const fetchPull = () =>
      client.get<PullSyncResponse>("/sync/pull", {
        timeout: PULL_TIMEOUT_MS,
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
    await this.ensureDeviceRegistered(centerId, deviceId);

    const fetchBootstrap = () =>
      client.get<BootstrapResponse>("/sync/bootstrap", {
        timeout: BOOTSTRAP_TIMEOUT_MS,
        headers: {
          "X-Center-Id": centerId,
          "X-Device-Id": deviceId,
        },
      });

    try {
      const response = await fetchBootstrap();
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
        const retryResponse = await fetchBootstrap();
        return retryResponse.data;
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
      cardRanges: [],
      latestServerSeq: 1000,
      timestamp: new Date().toISOString(),
    };
  }
}
