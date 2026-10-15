import { DatabaseService } from "../../core/database";
import { UnauthorizedError, ValidationError } from "../../core/errors";
import { useAuthStore } from "../auth/useAuthStore";
import { getDateOnlyInTimeZone } from "../../shared/utils/date";

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
      throw new ValidationError(
        `Center ${centerId} has no configured IANA time zone.`,
        "يجب ضبط المنطقة الزمنية للمركز قبل إنشاء جلسات جديدة.",
      );
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ValidationError(
          `Center ${centerId} has an invalid IANA time zone.`,
          "المنطقة الزمنية المضبوطة للمركز غير صحيحة.",
        );
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
