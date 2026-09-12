import { env } from "../../config/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogPayload {
  category: string;
  action: string;
  operationId?: string;
  entityType?: string;
  centerId?: string;
  retryCount?: number;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, any>;
}

const REDACTED_KEYS = new Set([
  "password",
  "token",
  "session_token",
  "authorization",
  "secret",
  "access_token",
  "refresh_token",
  "pin",
  "credit_card",
]);

export class Logger {
  private static sanitize(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") {
      // Basic token pattern redaction
      if (obj.startsWith("Bearer ") || obj.startsWith("tok-")) {
        return "[REDACTED_TOKEN]";
      }
      return obj;
    }
    if (typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.sanitize(item));

    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = this.sanitize(value);
      }
    }
    return sanitized;
  }

  static log(level: LogLevel, payload: LogPayload): void {
    const timestamp = new Date().toISOString();
    const cleanPayload = this.sanitize(payload);

    // In production, suppress verbose debug logs
    if (env.appEnv === "production" && level === "debug") {
      return;
    }

    const logEntry = {
      timestamp,
      level,
      env: env.appEnv,
      ...cleanPayload,
    };

    switch (level) {
      case "error":
        console.error(JSON.stringify(logEntry));
        break;
      case "warn":
        console.warn(JSON.stringify(logEntry));
        break;
      case "info":
        console.info(JSON.stringify(logEntry));
        break;
      case "debug":
        console.log(JSON.stringify(logEntry));
        break;
    }
  }

  static info(
    category: string,
    action: string,
    data?: Partial<LogPayload>,
  ): void {
    this.log("info", { category, action, ...data });
  }

  static warn(
    category: string,
    action: string,
    data?: Partial<LogPayload>,
  ): void {
    this.log("warn", { category, action, ...data });
  }

  static error(
    category: string,
    action: string,
    error: unknown,
    data?: Partial<LogPayload>,
  ): void {
    let errorMsg: string;
    if (error instanceof Error) {
      // AppError subclasses expose a userMessage; prefer that for clarity
      const anyErr = error as any;
      errorMsg = anyErr.userMessage
        ? `[${anyErr.code || error.name}] ${anyErr.userMessage} | ${error.message}`
        : error.message;
    } else if (error !== null && typeof error === "object") {
      try {
        errorMsg = JSON.stringify(error);
      } catch {
        errorMsg = String(error);
      }
    } else {
      errorMsg = String(error);
    }
    this.log("error", { category, action, error: errorMsg, ...data });
  }

  static debug(
    category: string,
    action: string,
    data?: Partial<LogPayload>,
  ): void {
    this.log("debug", { category, action, ...data });
  }
}
