import * as fs from "fs";
import * as path from "path";
import { DatabaseService } from "../src/core/database";
import { SyncEngine } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { NotificationService } from "../src/features/notifications/NotificationService";
import {
  computeNotificationCenterStats,
  formatUserFailureReason,
  getCairoDateOnlyFromTimestamp,
  getCairoTodayDateOnly,
  getDateRangeForPreset,
  getDeliveryStatusPresentation,
  getDisplayMessageBody,
  isValidDateRange,
  MISSING_MESSAGE_FALLBACK,
} from "../src/features/notifications/notificationStats";
import { NotificationDelivery, NotificationEvent } from "../src/shared/types";

describe("Notification Center Redesign & Delivery Reliability", () => {
  beforeEach(async () => {
    jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "idle",
    } as any);
    DatabaseService.init();
    await useAuthStore.getState().logout();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("1, 2, 3 & 4. Cairo date-range defaults, preset ranges, invalid range rejection, and date-only preservation", () => {
    const notificationsSource = fs.readFileSync(
      path.join(__dirname, "../src/app/(main)/notifications.tsx"),
      "utf8",
    );
    expect(notificationsSource).toContain("سجل الإشعارات");
    expect(notificationsSource).toContain("قوالب الإشعارات");
    expect(notificationsSource).toContain("إرسال مباشر");
    expect(notificationsSource).toContain("الكل");
    expect(notificationsSource).not.toContain('placeholder="YYYY-MM"');
    expect(notificationsSource).toContain("sendingRef");
    expect(notificationsSource).toContain("تأكيد إرسال SMS");

    // 22:30 UTC on 2026-09-25 is 2026-09-26 01:30 in Africa/Cairo (UTC+3 DST)
    const cairoToday = getCairoTodayDateOnly(new Date("2026-09-25T22:30:00.000Z"));
    expect(cairoToday).toBe("2026-09-26");

    // Date-only values must never shift
    expect(getCairoDateOnlyFromTimestamp("2026-09-25")).toBe("2026-09-25");

    // Presets
    const last7 = getDateRangeForPreset("last7", new Date("2026-09-25T12:00:00.000Z"));
    expect(last7).toEqual({ startDate: "2026-09-19", endDate: "2026-09-25" });
    const allRange = getDateRangeForPreset("all", new Date("2026-09-25T12:00:00.000Z"));
    expect(allRange).toEqual({ startDate: "2000-01-01", endDate: "2026-09-26" });

    // Invalid date ranges rejected
    expect(isValidDateRange("2026-09-25", "2026-09-20")).toBe(false);
    expect(isValidDateRange("2026-09", "2026-09-25")).toBe(false);
    expect(isValidDateRange("2026-09-20", "2026-09-25")).toBe(true);
  });

  it("5, 6 & 7. Separates SMS vs Push stats, uses selected period, and distinguishes accepted/sent/delivered/ambiguous_outcome", () => {
    const events: NotificationEvent[] = [
      {
        id: "ev-1",
        operationId: "op-1",
        centerId: "center-1",
        studentId: "stu-1",
        sessionId: "ses-1",
        eventType: "absence",
        createdBy: "usr-1",
        createdAt: "2026-09-25T10:00:00.000Z",
      },
      {
        id: "ev-2",
        operationId: "op-2",
        centerId: "center-1",
        studentId: "stu-2",
        sessionId: "ses-1",
        eventType: "grades",
        createdBy: "usr-1",
        createdAt: "2026-09-25T11:00:00.000Z",
      },
      {
        id: "ev-3",
        operationId: "op-3",
        centerId: "center-1",
        studentId: "stu-3",
        sessionId: "ses-1",
        eventType: "custom",
        createdBy: "usr-1",
        createdAt: "2026-09-20T10:00:00.000Z",
      },
    ];

    const deliveries: Record<string, NotificationDelivery[]> = {
      "ev-1": [
        {
          id: "del-1",
          centerId: "center-1",
          notificationEventId: "ev-1",
          channel: "sms",
          status: "accepted",
          recipient: "01000000001",
          renderedMessage: "msg",
          retryCount: 1,
          providerMessageId: "zadx-1",
          createdAt: "2026-09-25T10:00:00.000Z",
        },
        {
          id: "del-2",
          centerId: "center-1",
          notificationEventId: "ev-1",
          channel: "push",
          status: "sent",
          recipient: "stu-1",
          renderedMessage: "msg",
          retryCount: 0,
          createdAt: "2026-09-25T10:00:00.000Z",
        },
      ],
      "ev-2": [
        {
          id: "del-3",
          centerId: "center-1",
          notificationEventId: "ev-2",
          channel: "sms",
          status: "ambiguous_outcome",
          recipient: "01000000002",
          renderedMessage: "msg",
          failureReason: "انتهت مهلة الاتصال بالمزود",
          retryCount: 1,
          createdAt: "2026-09-25T11:00:00.000Z",
        },
      ],
      "ev-3": [
        {
          id: "del-4",
          centerId: "center-1",
          notificationEventId: "ev-3",
          channel: "sms",
          status: "pending",
          recipient: "01000000003",
          renderedMessage: "msg",
          retryCount: 0,
          createdAt: "2026-09-20T10:00:00.000Z",
        },
      ],
    };

    const stats = computeNotificationCenterStats(
      events,
      deliveries,
      "2026-09-25",
      "2026-09-25",
    );

    // Only 2026-09-25 events included (ev-3 on 2026-09-20 excluded)
    expect(stats.sms.accepted).toBe(1);
    expect(stats.sms.delivered).toBe(0);
    expect(stats.sms.ambiguous).toBe(1);
    expect(stats.sms.inProgress).toBe(0);
    expect(stats.push.confirmedSent).toBe(1);
    expect(stats.overall.sentOrAccepted).toBe(2);
    expect(stats.overall.failedOrAmbiguous).toBe(1);

    // Distinct status labels
    expect(getDeliveryStatusPresentation("accepted").label).toBe("مقبول من المزود");
    expect(getDeliveryStatusPresentation("delivered").label).toBe("تم التسليم");
    expect(getDeliveryStatusPresentation("ambiguous_outcome").label).toBe("نتيجة غير مؤكدة");
  });

  it("Preserves providerMessageId and ambiguous_outcome in NotificationService.getDeliveriesForEvent", () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT OR IGNORE INTO notification_events
         (id, operation_id, center_id, student_id, session_id, event_type, created_by, created_at)
       VALUES ('ev-rel-1', 'op-rel-1', 'center-1', 'stu-1', 'ses-1', 'custom', 'usr-1', '2026-09-25T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO notification_deliveries
         (id, center_id, notification_event_id, channel, status, recipient, rendered_message, failure_reason, retry_count, provider_message_id, created_at)
       VALUES ('del-rel-1', 'center-1', 'ev-rel-1', 'sms', 'accepted', '01012345678', 'hello', NULL, 0, 'zadx-msg-999', '2026-09-25T10:00:00.000Z')`,
    );

    const rows = NotificationService.getDeliveriesForEvent("ev-rel-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].providerMessageId).toBe("zadx-msg-999");

    const counts = NotificationService.getDeliveryStatusCounts("ev-rel-1");
    expect(counts.accepted).toBe(1);
    expect(counts.sent).toBe(0);
  });

  it("Message preview, missing-body fallback, raw JSON hiding, and center isolation", async () => {
    const notificationsSource = fs.readFileSync(
      path.join(__dirname, "../src/app/(main)/notifications.tsx"),
      "utf8",
    );
    const syncSource = fs.readFileSync(
      path.join(__dirname, "../src/core/sync/index.ts"),
      "utf8",
    );

    // 1. Tapping a card opens in-app details modal with SMS bubble and ScrollView
    expect(notificationsSource).toContain("setSelectedDetail");
    expect(notificationsSource).toContain("styles.smsMessageBubble");
    expect(notificationsSource).toContain("styles.detailScroll");
    expect(notificationsSource).toContain("formatUserFailureReason");
    expect(notificationsSource).toContain("getDisplayMessageBody");
    // 5 & 6. Sync never dumps raw JSON.stringify(d.response_payload) into failure_reason
    expect(syncSource).not.toContain("JSON.stringify(d.response_payload)");

    // 2 & 3. Exact final SMS body stored for delivery is preserved verbatim
    const db = DatabaseService.getDb();
    const finalRendered = "تم رصد غياب الطالب احمد محمد في حصة الفيزياء بتاريخ 2026-11-14";
    db.runSync(
      `INSERT OR IGNORE INTO notification_events
         (id, operation_id, center_id, student_id, session_id, event_type, created_by, created_at)
       VALUES ('ev-preview-1', 'op-preview-1', 'center-1', 'stu-1', 'ses-1', 'absence', 'usr-1', '2026-11-14T10:00:00.000Z')`,
    );
    db.runSync(
      `INSERT OR REPLACE INTO notification_deliveries
         (id, center_id, notification_event_id, channel, status, recipient, rendered_message, failure_reason, retry_count, created_at)
       VALUES ('del-preview-1', 'center-1', 'ev-preview-1', 'sms', 'accepted', '01012345678', ?, ?, 0, '2026-11-14T10:00:00.000Z')`,
      [
        finalRendered,
        JSON.stringify({
          claimAtMs: 1700000000000,
          claimToken: "secret-claim-token",
          httpStatus: 202,
          operationId: "op-internal-1",
          recipient: "01012345678",
        }),
      ],
    );

    const rows = NotificationService.getDeliveriesForEvent("ev-preview-1");
    expect(rows).toHaveLength(1);
    expect(getDisplayMessageBody(rows[0].renderedMessage)).toEqual({
      text: finalRendered,
      isMissing: false,
    });
    // Raw JSON on accepted delivery is suppressed completely
    expect(formatUserFailureReason(rows[0].failureReason, rows[0].status)).toBeNull();

    // Failed technical JSON is translated to clean Arabic without exposing claimToken/operationId
    const failedSanitized = formatUserFailureReason(
      JSON.stringify({
        category: "provider_unavailable",
        claimToken: "secret-claim-token",
        httpStatus: 503,
        operationId: "op-internal-2",
      }),
      "failed",
    );
    expect(failedSanitized).toBe("مزود خدمة SMS غير متاح مؤقتاً.");
    expect(failedSanitized).not.toContain("claimToken");
    expect(failedSanitized).not.toContain("operationId");

    // 4. Historical records without message bodies show the Arabic fallback
    expect(getDisplayMessageBody("")).toEqual({
      text: MISSING_MESSAGE_FALLBACK,
      isMissing: true,
    });
    expect(getDisplayMessageBody(null)).toEqual({
      text: MISSING_MESSAGE_FALLBACK,
      isMissing: true,
    });

    // 9. Different centers cannot access each other's notification details
    await useAuthStore.getState().selectCenter("center-2");
    const otherCenterRows = NotificationService.getDeliveriesForEvent("ev-preview-1");
    expect(otherCenterRows).toHaveLength(0);
  });
});
