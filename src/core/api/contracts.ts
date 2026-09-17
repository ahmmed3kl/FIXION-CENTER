/**
 * FIXION Client-Backend Sync & API Contracts
 * Defines the standardized payload and response structures for HTTP communication
 * between the mobile client and the central management backend.
 */

export interface SyncOperationPayload {
  operationId: string;
  centerId: string;
  userId: string;
  deviceId: string;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: any;
  createdAt: string;
  retryCount?: number;
}

export interface PushSyncRequest {
  centerId: string;
  deviceId: string;
  clientVersion: string;
  operations: SyncOperationPayload[];
}

export interface SyncConflictItem {
  operationId: string;
  entityType: string;
  entityId: string;
  reason: string;
  resolution: "server_wins" | "client_wins" | "manual_review";
  serverState?: any;
}

export interface PushSyncResponse {
  success: boolean;
  syncedOperationIds: string[];
  conflicts: SyncConflictItem[];
  serverCursor: string;
  processedAt: string;
}

export interface PullSyncRequest {
  centerId: string;
  cursor: string; // Monotonic server sequence token (e.g. "srv_seq_1001" or "0")
  limit?: number;
}

export interface ServerChangeRecord {
  sequenceNumber: number;
  /** The same immutable operation id used by the originating audit/outbox row. */
  operationId?: string;
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete";
  data: any;
  serverTimestamp: string;
}

export interface PullSyncResponse {
  changes: ServerChangeRecord[];
  nextCursor: string;
  hasMore: boolean;
  cursorReset?: boolean;
  latestServerSeq?: number;
  resetGeneration?: number;
  serverTimestamp: string;
}

export interface LoginRequest {
  phone: string;
  password?: string;
  deviceId: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    fullName: string;
    phone: string;
    role: string;
    centerIds: string[];
    permissions: string[];
  };
  expiresAt?: string;
}

export interface DeviceRegistrationRequest {
  centerId: string;
  userId: string;
  deviceName: string;
  deviceIdentifier: string;
  platform: string;
  appVersion: string;
}

export interface DeviceRegistrationResponse {
  deviceId: string;
  status: "active" | "inactive";
  registeredAt: string;
}
