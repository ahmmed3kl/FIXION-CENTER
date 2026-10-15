import { DatabaseService } from "../../core/database";
import { UnauthorizedError, ValidationError } from "../../core/errors";
import { useAuthStore } from "../auth/useAuthStore";
import { getDateOnlyInTimeZone } from "../../shared/utils/date";

export type CenterTimeZoneIssue = "missing" | "invalid";

export class CenterTimeZoneConfigurationError extends ValidationError {
  constructor(
    centerId: string,
    readonly issue: CenterTimeZoneIssue,
  ) {
    const isMissing = issue === "missing";
    super(
      `Center ${centerId} has ${isMissing ? "no configured" : "an invalid"} IANA time zone.`,
      isMissing
        ? "يجب ضبط المنطقة الزمنية للمركز قبل حساب بيانات اليوم أو إنشاء جلسات جديدة."
        : "المنطقة الزمنية المضبوطة للمركز غير صحيحة.",
    );
    this.name = "CenterTimeZoneConfigurationError";
  }
}

export class SessionDateService {
  static getCenterTimeZone(centerId = useAuthStore.getState().activeCenterId): string {
    if (!centerId) {
      throw new UnauthorizedError("A center must be selected before resolving its session date.");
    }

    const center = DatabaseService.getDb().getFirstSync<{ timeZone?: unknown }>(
      "SELECT time_zone as timeZone FROM centers WHERE id = ?",
      [centerId],
    );
    const timeZone = typeof center?.timeZone === "string" ? center.timeZone.trim() : "";
    if (!timeZone) {
      throw new CenterTimeZoneConfigurationError(centerId, "missing");
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    } catch (error) {
      if (error instanceof RangeError) {
        throw new CenterTimeZoneConfigurationError(centerId, "invalid");
      }
      throw error;
    }

    return timeZone;
  }

  static getCurrentSessionDate(
    centerId = useAuthStore.getState().activeCenterId,
    now = new Date(),
  ): string {
    return getDateOnlyInTimeZone(now, this.getCenterTimeZone(centerId));
  }

  static getCurrentSessionMonth(
    centerId = useAuthStore.getState().activeCenterId,
    now = new Date(),
  ): string {
    return this.getCurrentSessionDate(centerId, now).slice(0, 7);
  }
}
