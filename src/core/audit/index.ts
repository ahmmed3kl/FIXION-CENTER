import { AuditLog } from "../../shared/types";
import { DatabaseService } from "../database";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class AuditService {
  static recordEvent(params: {
    operationId: string;
    centerId: string;
    userId: string;
    deviceId: string;
    entityType: string;
    entityId: string;
    action: string;
    payload?: any;
  }): AuditLog {
    const db = DatabaseService.getDb();
    const id = `audit-${generateUUID()}`;
    const timestamp = new Date().toISOString();
    const payloadStr = params.payload
      ? typeof params.payload === "string"
        ? params.payload
        : JSON.stringify(params.payload)
      : null;

    db.runSync(
      `INSERT INTO audit_logs (id, operation_id, center_id, user_id, device_id, entity_type, entity_id, action, timestamp, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.operationId,
        params.centerId,
        params.userId,
        params.deviceId,
        params.entityType,
        params.entityId,
        params.action,
        timestamp,
        payloadStr,
      ],
    );

    return {
      id,
      operationId: params.operationId,
      centerId: params.centerId,
      userId: params.userId,
      deviceId: params.deviceId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      timestamp,
      payload: payloadStr || undefined,
    };
  }

  static getLogs(centerId: string, limit = 50): AuditLog[] {
    const db = DatabaseService.getDb();
    return db.getAllSync<AuditLog>(
      `SELECT id, operation_id as operationId, center_id as centerId, user_id as userId,
              device_id as deviceId, entity_type as entityType, entity_id as entityId,
              action, timestamp, payload
       FROM audit_logs
       WHERE center_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [centerId, limit],
    );
  }
}
