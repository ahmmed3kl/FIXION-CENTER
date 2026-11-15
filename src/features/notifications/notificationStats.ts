import {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationEvent,
} from "../../shared/types";
import { toArabicDigits } from "../../shared/utils/arabicNumerals";
import {
  addDateOnlyDays,
  formatLocalDate,
  getDateOnlyInTimeZone,
} from "../../shared/utils/date";

export const CAIRO_TIME_ZONE = "Africa/Cairo";

export type DateRangePreset = "today" | "last7" | "thisMonth" | "all" | "custom";

export interface ChannelDeliveryStats {
  sentOrAccepted: number;
  accepted: number;
  confirmedSent: number;
  delivered: number;
  inProgress: number;
  failedOrAmbiguous: number;
  failed: number;
  ambiguous: number;
  byEventType: {
    absence: number;
    grades: number;
    custom: number;
  };
}

export interface NotificationCenterStats {
  startDate: string;
  endDate: string;
  overall: {
    sentOrAccepted: number;
    inProgress: number;
    failedOrAmbiguous: number;
  };
  sms: ChannelDeliveryStats;
  push: ChannelDeliveryStats;
}

export function getCairoTodayDateOnly(now: Date = new Date()): string {
  return getDateOnlyInTimeZone(now, CAIRO_TIME_ZONE);
}

/**
 * Resolves a date-only string (YYYY-MM-DD) without timezone shifting, or
 * converts an ISO instant into its Africa/Cairo calendar date.
 */
export function getCairoDateOnlyFromTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const instant = new Date(trimmed);
  if (!Number.isFinite(instant.getTime())) {
    const fallbackMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
    return fallbackMatch ? fallbackMatch[1] : null;
  }
  return getDateOnlyInTimeZone(instant, CAIRO_TIME_ZONE);
}

export function formatCairoDateTimeArabic(
  value?: string | null,
  fallback = "تاريخ غير متاح",
): string {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return formatLocalDate(trimmed, fallback);
  }
  const instant = new Date(trimmed);
  if (!Number.isFinite(instant.getTime())) return fallback;
  const cairoDate = getDateOnlyInTimeZone(instant, CAIRO_TIME_ZONE);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAIRO_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const hour24 = Number(timeParts.find((p) => p.type === "hour")?.value || 0) % 24;
  const minute = timeParts.find((p) => p.type === "minute")?.value || "00";
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? "م" : "ص";
  const timeStr = `${toArabicDigits(String(hour12).padStart(2, "0"))}:${toArabicDigits(minute)} ${period}`;
  return `${formatLocalDate(cairoDate, fallback)} — ${timeStr}`;
}

export function isValidDateRange(startDate: string, endDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return false;
  }
  return startDate <= endDate;
}

export function getDateRangeForPreset(
  preset: Exclude<DateRangePreset, "custom">,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const today = getCairoTodayDateOnly(now);
  if (preset === "today") {
    return { startDate: today, endDate: today };
  }
  if (preset === "last7") {
    return { startDate: addDateOnlyDays(today, -6), endDate: today };
  }
  if (preset === "all") {
    return { startDate: "2000-01-01", endDate: addDateOnlyDays(today, 1) };
  }
  return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
}

function emptyChannelStats(): ChannelDeliveryStats {
  return {
    sentOrAccepted: 0,
    accepted: 0,
    confirmedSent: 0,
    delivered: 0,
    inProgress: 0,
    failedOrAmbiguous: 0,
    failed: 0,
    ambiguous: 0,
    byEventType: { absence: 0, grades: 0, custom: 0 },
  };
}

/**
 * Computes notification statistics for a date range in Africa/Cairo.
 * - Separates SMS and instant (push) channels.
 * - Counts each delivery row once (retries increment retryCount on the same delivery row).
 * - Never counts pending/queued/sending/failed/ambiguous rows as delivered.
 */
export function computeNotificationCenterStats(
  events: NotificationEvent[],
  deliveriesByEventId: Record<string, NotificationDelivery[]>,
  startDate: string,
  endDate: string,
): NotificationCenterStats {
  const sms = emptyChannelStats();
  const push = emptyChannelStats();

  for (const ev of events) {
    const evDate = getCairoDateOnlyFromTimestamp(ev.createdAt);
    if (!evDate || evDate < startDate || evDate > endDate) continue;

    const list = deliveriesByEventId[ev.id] || [];
    for (const del of list) {
      const target = del.channel === "sms" ? sms : push;
      if (del.status === "accepted") {
        target.accepted += 1;
        target.sentOrAccepted += 1;
      } else if (del.status === "sent") {
        target.confirmedSent += 1;
        target.sentOrAccepted += 1;
      } else if (del.status === "delivered") {
        target.delivered += 1;
        target.sentOrAccepted += 1;
      } else if (
        del.status === "pending" ||
        del.status === "queued" ||
        del.status === "sending"
      ) {
        target.inProgress += 1;
      } else if (del.status === "ambiguous_outcome") {
        target.ambiguous += 1;
        target.failedOrAmbiguous += 1;
      } else if (del.status === "failed") {
        target.failed += 1;
        target.failedOrAmbiguous += 1;
      }

      if (del.status === "accepted" || del.status === "sent" || del.status === "delivered") {
        if (ev.eventType === "absence") target.byEventType.absence += 1;
        else if (ev.eventType === "grades") target.byEventType.grades += 1;
        else if (ev.eventType !== "attendance") target.byEventType.custom += 1;
      }
    }
  }

  return {
    startDate,
    endDate,
    overall: {
      sentOrAccepted: sms.sentOrAccepted + push.sentOrAccepted,
      inProgress: sms.inProgress + push.inProgress,
      failedOrAmbiguous: sms.failedOrAmbiguous + push.failedOrAmbiguous,
    },
    sms,
    push,
  };
}

export function getDeliveryStatusPresentation(status: NotificationDeliveryStatus | string): {
  label: string;
  detail: string;
  tone: "success" | "info" | "warning" | "danger" | "neutral";
} {
  switch (status) {
    case "delivered":
      return {
        label: "تم التسليم",
        detail: "تم تأكيد وصول الرسالة إلى المستلم.",
        tone: "success",
      };
    case "sent":
      return {
        label: "تم الإرسال",
        detail: "تم الإرسال المؤكد عبر القناة.",
        tone: "success",
      };
    case "accepted":
      return {
        label: "مقبول من المزود",
        detail: "قبل مزود SMS الطلب (بانتظار التسليم الفعلي عبر الشبكة).",
        tone: "info",
      };
    case "sending":
      return {
        label: "جارٍ الإرسال",
        detail: "يتم تنفيذ الإرسال حالياً.",
        tone: "warning",
      };
    case "queued":
      return {
        label: "في الطابور",
        detail: "تمت الجدولة لإعادة المحاولة أو المعالجة.",
        tone: "neutral",
      };
    case "ambiguous_outcome":
      return {
        label: "نتيجة غير مؤكدة",
        detail: "انقطع الاتصال أثناء الإرسال — يحتاج مراجعة ولا يُعاد إرساله تلقائياً.",
        tone: "warning",
      };
    case "failed":
      return {
        label: "فشل الإرسال",
        detail: "تأكد فشل الإرسال من المزود أو التحقق.",
        tone: "danger",
      };
    default:
      return {
        label: "قيد الانتظار",
        detail: "بانتظار المزامنة والمعالجة.",
        tone: "neutral",
      };
  }
}

export const MISSING_MESSAGE_FALLBACK = "نص الرسالة غير متاح لهذا الإشعار.";

const TECHNICAL_PAYLOAD_PATTERN =
  /"(?:claimAtMs|claimToken|operationId|httpStatus|dispatchState|nextRetryAtMs|providerRespondedAtMs|providerRequestStartAtMs)"/;

function mapCategoryToArabicError(category?: unknown): string | null {
  switch (String(category || "").trim()) {
    case "sms_disabled":
      return "خدمة SMS غير مفعلة لهذا المركز.";
    case "provider_rate_limited":
      return "تم تجاوز حد الإرسال المؤقت لدى مزود الخدمة.";
    case "provider_unavailable":
      return "مزود خدمة SMS غير متاح مؤقتاً.";
    case "provider_timeout_or_network_ambiguous":
      return "تعذر تأكيد الإرسال من مزود الخدمة؛ يرجى المراجعة قبل إعادة المحاولة.";
    case "provider_rejected_4xx":
    case "provider_rejected":
      return "رفض مزود الخدمة إرسال الرسالة؛ تحقق من الرقم أو المحتوى.";
    case "interrupted_during_send":
      return "انقطع الإرسال قبل تأكيد الاستلام؛ يرجى المراجعة.";
    case "missing_recipient":
      return "رقم الهاتف غير متوفر.";
    default:
      return null;
  }
}

/**
 * Sanitizes delivery failure reasons for end-user UI display.
 * Never exposes raw JSON payloads, claim tokens, or internal operation metadata.
 */
export function formatUserFailureReason(
  rawReason?: string | null,
  status?: NotificationDeliveryStatus | string,
): string | null {
  if (status === "accepted" || status === "sent" || status === "delivered") {
    return null;
  }
  if (!rawReason) return null;
  const trimmed = String(rawReason).trim();
  if (!trimmed) return null;

  const looksLikeJson =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    TECHNICAL_PAYLOAD_PATTERN.test(trimmed);

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const mapped = mapCategoryToArabicError((parsed as any).category);
        if (mapped) return mapped;
        if ((parsed as any).dispatchState === "ambiguous_outcome") {
          return "تعذر تأكيد الإرسال من مزود الخدمة؛ يرجى المراجعة قبل إعادة المحاولة.";
        }
      }
    } catch {
      // Fall through to status-based Arabic summary without exposing raw JSON
    }
    if (status === "ambiguous_outcome") {
      return "حالة الإرسال غير مؤكدة لدى مزود الخدمة.";
    }
    if (status === "failed") {
      return "تعذر إرسال الرسالة عبر مزود الخدمة.";
    }
    return null;
  }

  return trimmed;
}

/**
 * Returns the exact stored message body without reconstructing from templates,
 * or the standard Arabic fallback when historical body is unavailable.
 */
export function getDisplayMessageBody(renderedMessage?: string | null): {
  text: string;
  isMissing: boolean;
} {
  if (typeof renderedMessage === "string" && renderedMessage.trim().length > 0) {
    return { text: renderedMessage, isMissing: false };
  }
  return { text: MISSING_MESSAGE_FALLBACK, isMissing: true };
}

