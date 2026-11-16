import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { DatabaseService } from "../../core/database";
import { formatTimeArabic } from "../../core/localization";
import { PermissionGate, PermissionService } from "../../core/permissions";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { Colors, Spacing, useTheme } from "../../core/theme";
import { AttendanceSessionService } from "../../features/attendance/AttendanceSessionService";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { NotificationService } from "../../features/notifications/NotificationService";
import { NotificationTemplateRepository } from "../../features/notifications/NotificationTemplateRepository";
import {
  computeNotificationCenterStats,
  DateRangePreset,
  formatCairoDateTimeArabic,
  formatUserFailureReason,
  getCairoDateOnlyFromTimestamp,
  getCairoTodayDateOnly,
  getDateRangeForPreset,
  getDeliveryStatusPresentation,
  getDisplayMessageBody,
  isValidDateRange,
} from "../../features/notifications/notificationStats";
import { SessionDateService } from "../../features/sessions/SessionDateService";
import { StudentRepository } from "../../features/students/StudentRepository";
import {
  Group,
  NotificationDelivery,
  NotificationEvent,
  NotificationTemplate,
  Student,
} from "../../shared/types";
import { toArabicDigits } from "../../shared/utils/arabicNumerals";
import { formatLocalDate, parseLocalDateOnly } from "../../shared/utils/date";

const DAYS_OF_WEEK = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const CALENDAR_WEEKDAYS = ["ح", "ن", "ث", "ر", "خ", "ج", "س"];

function groupScheduleLabel(groupId: string): string {
  try {
    const schedules = GroupScheduleRepository.getSchedulesForGroup(groupId);
    return (
      schedules
        .slice(0, 2)
        .map(
          (schedule) =>
            `${DAYS_OF_WEEK[schedule.dayOfWeek] || "اليوم"} ${formatTimeArabic(schedule.startTime)} - ${formatTimeArabic(schedule.endTime)}`,
        )
        .join(" · ") || "لم يتم تحديد الموعد"
    );
  } catch {
    return "لم يتم تحديد الموعد";
  }
}

function eventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "attendance":
      return "إشعار حضور";
    case "absence":
      return "إشعار غياب";
    case "grades":
      return "إرسال درجات";
    case "homework":
      return "تقييم الواجب";
    default:
      return "إشعار مباشر";
  }
}

function buildCalendarMonthGrid(year: number, monthIndex: number): (string | null)[] {
  const firstDay = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const daysInMonth = new Date(year, monthIndex + 1, 0, 12, 0, 0, 0).getDate();
  const leadingEmpty = firstDay.getDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < leadingEmpty; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(
      `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatArabicMonthYear(year: number, monthIndex: number): string {
  return new Intl.DateTimeFormat("ar-EG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthIndex, 15, 12, 0, 0)));
}

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const services = useServiceVisibility();
  const { currentUser, activeCenterId } = useAuthStore();
  const userPermissions = currentUser?.permissions || [];
  const canViewHistory = PermissionService.hasAnyPermission(userPermissions, [
    "notifications.view",
    "notifications.send",
  ]);
  const canViewTemplates = PermissionService.hasAnyPermission(userPermissions, [
    "notifications.templates.view",
    "notifications.templates.update",
    "notifications.templates.manage",
    "notifications.view",
  ]);
  const canSendNotifications = PermissionService.hasPermission(
    userPermissions,
    "notifications.send",
  );
  const notificationsEnabled = services.isEnabled("notifications");
  const [activeTab, setActiveTab] = useState<"history" | "templates" | "compose">(() =>
    canViewHistory ? "history" : canViewTemplates ? "templates" : "compose",
  );

  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, NotificationDelivery[]>>({});
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Cairo-local date range filter (default: today)
  const cairoToday = useMemo(() => getCairoTodayDateOnly(), []);
  const [datePreset, setDatePreset] = useState<DateRangePreset>("today");
  const [startDate, setStartDate] = useState<string>(() => getCairoTodayDateOnly());
  const [endDate, setEndDate] = useState<string>(() => getCairoTodayDateOnly());

  // Calendar range modal state
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [selectingField, setSelectingField] = useState<"start" | "end">("start");
  const [draftStartDate, setDraftStartDate] = useState<string>(cairoToday);
  const [draftEndDate, setDraftEndDate] = useState<string>(cairoToday);
  const [calendarError, setCalendarError] = useState("");
  const [calendarCursor, setCalendarCursor] = useState<{ year: number; month: number }>(() => {
    const parsed = parseLocalDateOnly(cairoToday);
    return parsed
      ? { year: parsed.getFullYear(), month: parsed.getMonth() }
      : { year: new Date().getFullYear(), month: new Date().getMonth() };
  });

  // Delivery detail modal
  const [selectedDetail, setSelectedDetail] = useState<{
    event: NotificationEvent;
    delivery: NotificationDelivery;
    studentName?: string;
  } | null>(null);

  // Direct SMS compose state
  const [smsGroupId, setSmsGroupId] = useState("");
  const [smsGroupSearch, setSmsGroupSearch] = useState("");
  const [smsRecipient, setSmsRecipient] = useState<"parent" | "student">("parent");
  const [smsMessage, setSmsMessage] = useState("");
  const [sendingSms, setSendingSms] = useState(false);
  const sendingRef = useRef(false);
  const [confirmSendVisible, setConfirmSendVisible] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [currentSessionDate, setCurrentSessionDate] = useState<string | null>(null);
  const [sessionDateError, setSessionDateError] = useState("");

  // Editing template modal state
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [templateBodyInput, setTemplateBodyInput] = useState("");

  const refreshCenterSessionDate = useCallback((): string | null => {
    if (!activeCenterId) {
      setCurrentSessionDate(null);
      setSessionDateError("يجب تحديد المركز لحساب قائمة الطلاب.");
      return null;
    }
    try {
      const sessionDate = SessionDateService.getCurrentSessionDate(activeCenterId);
      setCurrentSessionDate(sessionDate);
      setSessionDateError("");
      return sessionDate;
    } catch (error) {
      console.warn("Failed to resolve center session date for SMS recipients:", error);
      setCurrentSessionDate(null);
      setSessionDateError("تعذر تحديد تاريخ المركز؛ تحقق من إعداد المنطقة الزمنية.");
      return null;
    }
  }, [activeCenterId]);

  useFocusEffect(
    useCallback(() => {
      if (!services.loaded || !notificationsEnabled) return;
      refreshCenterSessionDate();
    }, [notificationsEnabled, refreshCenterSessionDate, services.loaded]),
  );

  const loadData = useCallback(() => {
    if (!activeCenterId) return;
    setLoading(true);
    try {
      NotificationTemplateRepository.ensureDefaultTemplates();
      setTemplates(NotificationTemplateRepository.getTemplates());
      setStudents(StudentRepository.getAll(false));
      setGroups(GroupRepository.getAll().filter((group) => group.status === "active"));

      const db = DatabaseService.getDb();
      const recentEvents = db.getAllSync<NotificationEvent>(
        `SELECT id, operation_id as operationId, center_id as centerId,
                student_id as studentId, session_id as sessionId, attendance_id as attendanceId,
                event_type as eventType, created_by as createdBy, created_at as createdAt
         FROM notification_events
         WHERE center_id = ?
         ORDER BY created_at DESC
         LIMIT 1000`,
        [activeCenterId],
      );
      setEvents(recentEvents);

      const dMap: Record<string, NotificationDelivery[]> = {};
      for (const ev of recentEvents) {
        dMap[ev.id] = NotificationService.getDeliveriesForEvent(ev.id);
      }
      setDeliveries(dMap);
    } catch (err: any) {
      console.warn("Failed to load notifications data:", err?.message || err);
    } finally {
      setLoading(false);
    }
  }, [activeCenterId]);

  useFocusEffect(
    useCallback(() => {
      if (!services.loaded || !notificationsEnabled) return;
      loadData();
    }, [activeCenterId, notificationsEnabled, services.loaded, loadData]),
  );

  const studentById = useMemo(() => {
    const map = new Map<string, Student>();
    for (const s of students) map.set(s.id, s);
    return map;
  }, [students]);

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      const evDate = getCairoDateOnlyFromTimestamp(ev.createdAt);
      if (!evDate) return false;
      return evDate >= startDate && evDate <= endDate;
    });
  }, [events, startDate, endDate]);

  const stats = useMemo(
    () => computeNotificationCenterStats(events, deliveries, startDate, endDate),
    [events, deliveries, startDate, endDate],
  );

  const applyPreset = (preset: Exclude<DateRangePreset, "custom">) => {
    const range = getDateRangeForPreset(preset);
    setDatePreset(preset);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  };

  const openCustomCalendar = () => {
    setDraftStartDate(startDate);
    setDraftEndDate(endDate);
    setSelectingField("start");
    setCalendarError("");
    const parsed = parseLocalDateOnly(startDate) || parseLocalDateOnly(cairoToday);
    if (parsed) {
      setCalendarCursor({ year: parsed.getFullYear(), month: parsed.getMonth() });
    }
    setCalendarVisible(true);
  };

  const handleSelectCalendarDay = (dateStr: string) => {
    setCalendarError("");
    if (selectingField === "start") {
      setDraftStartDate(dateStr);
      if (dateStr > draftEndDate) {
        setDraftEndDate(dateStr);
      }
      setSelectingField("end");
    } else {
      if (dateStr < draftStartDate) {
        setCalendarError("تاريخ النهاية يجب أن يكون مساوياً أو بعد تاريخ البداية.");
        return;
      }
      setDraftEndDate(dateStr);
    }
  };

  const applyCustomDateRange = () => {
    if (!isValidDateRange(draftStartDate, draftEndDate)) {
      setCalendarError("نطاق التاريخ غير صالح؛ تأكد من أن البداية قبل أو تساوي النهاية.");
      return;
    }
    setDatePreset("custom");
    setStartDate(draftStartDate);
    setEndDate(draftEndDate);
    setCalendarVisible(false);
  };

  const shiftCalendarMonth = (delta: number) => {
    setCalendarCursor((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1, 12, 0, 0, 0);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const calendarCells = useMemo(
    () => buildCalendarMonthGrid(calendarCursor.year, calendarCursor.month),
    [calendarCursor],
  );

  const handleSaveTemplate = () => {
    if (!editingTemplate) return;
    try {
      NotificationTemplateRepository.updateTemplate(editingTemplate.id, templateBodyInput);
      setEditingTemplate(null);
      loadData();
    } catch (err: any) {
      Alert.alert("خطأ", err.message || "فشل حفظ القالب");
    }
  };

  const filteredSmsGroups = groups
    .filter((group) => {
      const query = smsGroupSearch.trim().toLocaleLowerCase();
      if (!query) return true;
      return [group.name, group.subjectName, group.teacherName, group.grade]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    })
    .slice(0, 30);

  const selectedSmsGroup = groups.find((group) => group.id === smsGroupId);
  const smsGroupTargets = useMemo(() => {
    if (!selectedSmsGroup || !currentSessionDate) return null;
    const expectedIds = AttendanceSessionService.getExpectedStudentIdsForGroup(
      selectedSmsGroup,
      selectedSmsGroup.id,
      currentSessionDate,
    );
    const targets = Array.from(new Set(expectedIds))
      .map((studentId) => studentById.get(studentId))
      .filter(Boolean) as Student[];
    const sendable = targets.filter((target) =>
      (smsRecipient === "student" ? target.phone : target.parentPhone)?.trim(),
    );
    return { total: targets.length, sendable };
  }, [currentSessionDate, selectedSmsGroup, smsRecipient, studentById]);

  const requestSendDirectSms = () => {
    setSendFeedback(null);
    if (!smsGroupId) {
      setSendFeedback({ type: "error", message: "اختر المجموعة أولاً." });
      return;
    }
    if (!smsMessage.trim()) {
      setSendFeedback({ type: "error", message: "اكتب نص الرسالة أولاً." });
      return;
    }
    const sessionDate = refreshCenterSessionDate();
    if (!sessionDate || !smsGroupTargets) {
      setSendFeedback({
        type: "error",
        message: "تعذر تجهيز الرسائل؛ تحقق من تاريخ المركز.",
      });
      return;
    }
    if (!smsGroupTargets.total) {
      setSendFeedback({ type: "error", message: "لا يوجد طلاب نشطون في هذه المجموعة." });
      return;
    }
    if (!smsGroupTargets.sendable.length) {
      setSendFeedback({
        type: "error",
        message: "لا يوجد أي رقم صالح للمستلمين في هذه المجموعة.",
      });
      return;
    }
    setConfirmSendVisible(true);
  };

  const executeDirectSms = async () => {
    if (sendingRef.current) return;
    if (!smsGroupTargets?.sendable.length) {
      setConfirmSendVisible(false);
      return;
    }
    sendingRef.current = true;
    setSendingSms(true);
    setConfirmSendVisible(false);
    let queuedCount = 0;
    try {
      for (const target of smsGroupTargets.sendable) {
        const event = NotificationService.notifyCustomSms({
          studentId: target.id,
          message: smsMessage,
          recipientType: smsRecipient,
        });
        await NotificationService.sendPendingDeliveries(event.id);
        queuedCount += 1;
      }
      const missingCount = smsGroupTargets.total - smsGroupTargets.sendable.length;
      setSmsMessage("");
      setSmsGroupId("");
      setSmsGroupSearch("");
      setSendFeedback({
        type: "success",
        message: `تم تجهيز ${queuedCount} رسالة في طابور الإرسال.${missingCount ? ` (تخطي ${missingCount} لعدم وجود رقم)` : ""}`,
      });
      setActiveTab("history");
      loadData();
    } catch (error: any) {
      setSendFeedback({
        type: "error",
        message: `${queuedCount ? `تم تجهيز ${queuedCount} رسالة. ` : ""}${error?.message || "تعذر إكمال تجهيز الرسائل."}`,
      });
    } finally {
      sendingRef.current = false;
      setSendingSms(false);
    }
  };

  const renderToneColors = (tone: "success" | "info" | "warning" | "danger" | "neutral") => {
    switch (tone) {
      case "success":
        return { bg: Colors.successLight, text: Colors.successText };
      case "info":
        return { bg: Colors.primaryLight, text: Colors.primary };
      case "warning":
        return { bg: Colors.warningLight, text: Colors.warningText };
      case "danger":
        return { bg: Colors.dangerLight, text: Colors.dangerText };
      default:
        return { bg: Colors.slate100, text: Colors.slate700 };
    }
  };

  if (!services.loaded) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>جارٍ تحميل حالة الخدمات...</Text>
      </View>
    );
  }
  if (!notificationsEnabled) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>خدمة الإشعارات غير مفعلة لهذا المركز.</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Compact Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>مركز الإشعارات</Text>
          <Text style={styles.headerSubtitle}>متابعة التسليم الفعلي والقوالب والإرسال المباشر</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={loadData}>
          <Ionicons name="refresh-outline" size={18} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Date Range Quick Filters + Calendar Trigger */}
      <View style={styles.dateFilterBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.presetRow}
        >
          {(
            [
              { key: "today", label: "اليوم" },
              { key: "last7", label: "آخر 7 أيام" },
              { key: "thisMonth", label: "هذا الشهر" },
              { key: "all", label: "الكل" },
            ] as const
          ).map((preset) => (
            <TouchableOpacity
              key={preset.key}
              style={[styles.presetChip, datePreset === preset.key && styles.presetChipActive]}
              onPress={() => applyPreset(preset.key)}
            >
              <Text
                style={[
                  styles.presetChipText,
                  datePreset === preset.key && styles.presetChipTextActive,
                ]}
              >
                {preset.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.presetChip, datePreset === "custom" && styles.presetChipActive]}
            onPress={openCustomCalendar}
          >
            <Ionicons
              name="calendar-outline"
              size={13}
              color={datePreset === "custom" ? Colors.white : colors.primary}
            />
            <Text
              style={[
                styles.presetChipText,
                datePreset === "custom" && styles.presetChipTextActive,
              ]}
            >
              نطاق مخصص
            </Text>
          </TouchableOpacity>
        </ScrollView>
        <Text style={styles.activeRangeText}>
          {datePreset === "all"
            ? "جميع الإشعارات"
            : startDate === endDate
              ? formatLocalDate(startDate)
              : `${formatLocalDate(startDate)} — ${formatLocalDate(endDate)}`}
        </Text>
      </View>

      {/* Compact Delivery Statistics (Separated SMS vs Instant) */}
      <View style={styles.statsCard}>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={[styles.statVal, { color: Colors.successText }]}>
              {toArabicDigits(String(stats.overall.sentOrAccepted))}
            </Text>
            <Text style={styles.statLbl}>تم الإرسال / مقبول</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statVal, { color: Colors.warningText }]}>
              {toArabicDigits(String(stats.overall.inProgress))}
            </Text>
            <Text style={styles.statLbl}>قيد الإرسال</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statVal, { color: Colors.dangerText }]}>
              {toArabicDigits(String(stats.overall.failedOrAmbiguous))}
            </Text>
            <Text style={styles.statLbl}>فشل / غير مؤكد</Text>
          </View>
        </View>
        <View style={styles.channelBreakdownRow}>
          <Text style={styles.channelBreakdownText}>
            SMS: {toArabicDigits(String(stats.sms.sentOrAccepted))} (مقبول:{" "}
            {toArabicDigits(String(stats.sms.accepted))} · مؤكد:{" "}
            {toArabicDigits(String(stats.sms.confirmedSent + stats.sms.delivered))})
          </Text>
          <Text style={styles.channelBreakdownText}>
            فوري: {toArabicDigits(String(stats.push.sentOrAccepted))}
          </Text>
        </View>
      </View>

      {/* Preserved 3-Tab Navigation */}
      <View style={styles.tabBar}>
        {(
          [
            ...(canViewHistory ? [{ key: "history", label: "سجل الإشعارات" } as const] : []),
            ...(canViewTemplates ? [{ key: "templates", label: "قوالب الإشعارات" } as const] : []),
            ...(canSendNotifications ? [{ key: "compose", label: "إرسال مباشر" } as const] : []),
          ]
        ).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tabButton, activeTab === tab.key && styles.tabButtonActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {sendFeedback ? (
        <View
          style={[
            styles.feedbackBanner,
            sendFeedback.type === "error" ? styles.feedbackError : styles.feedbackSuccess,
          ]}
        >
          <Text
            style={[
              styles.feedbackText,
              { color: sendFeedback.type === "error" ? Colors.dangerText : Colors.successText },
            ]}
          >
            {sendFeedback.message}
          </Text>
          <TouchableOpacity onPress={() => setSendFeedback(null)}>
            <Ionicons name="close" size={16} color={Colors.slate600} />
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={styles.loadingText}>جارٍ تحميل البيانات...</Text>
        </View>
      ) : activeTab === "compose" ? (
        <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>المجموعة المستهدفة</Text>
            <TextInput
              style={styles.composeInput}
              value={smsGroupSearch}
              onChangeText={setSmsGroupSearch}
              placeholder="ابحث باسم المجموعة أو المادة أو المدرس"
              placeholderTextColor={Colors.slate400}
              textAlign="right"
            />
            <ScrollView style={styles.studentPicker} nestedScrollEnabled>
              {filteredSmsGroups.map((group) => (
                <TouchableOpacity
                  key={group.id}
                  style={[styles.studentChoice, smsGroupId === group.id && styles.studentChoiceActive]}
                  onPress={() => {
                    setSmsGroupId(group.id);
                    setSmsGroupSearch(group.name);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.studentChoiceName}>{group.name}</Text>
                    <Text style={styles.studentChoiceMeta}>
                      {[group.subjectName, group.teacherName, group.grade].filter(Boolean).join(" · ")}
                    </Text>
                    <Text style={styles.studentChoiceSchedule}>{groupScheduleLabel(group.id)}</Text>
                  </View>
                  <Ionicons
                    name={smsGroupId === group.id ? "checkmark-circle" : "ellipse-outline"}
                    size={18}
                    color={smsGroupId === group.id ? Colors.primary : Colors.slate400}
                  />
                </TouchableOpacity>
              ))}
            </ScrollView>
            {selectedSmsGroup && smsGroupTargets ? (
              <Text style={styles.selectedGroupHint}>
                المختار: {selectedSmsGroup.name} · صالح للإرسال:{" "}
                {toArabicDigits(String(smsGroupTargets.sendable.length))} من{" "}
                {toArabicDigits(String(smsGroupTargets.total))} طالب
              </Text>
            ) : null}
            {sessionDateError ? (
              <Text style={{ color: Colors.dangerText, fontSize: 11, textAlign: "right" }}>
                {sessionDateError}
              </Text>
            ) : null}

            <Text style={styles.fieldLabel}>المستلم</Text>
            <View style={styles.recipientRow}>
              {(["parent", "student"] as const).map((recipient) => (
                <TouchableOpacity
                  key={recipient}
                  style={[
                    styles.recipientButton,
                    smsRecipient === recipient && styles.recipientButtonActive,
                  ]}
                  onPress={() => setSmsRecipient(recipient)}
                >
                  <Ionicons
                    name={recipient === "parent" ? "people-outline" : "person-outline"}
                    size={16}
                    color={smsRecipient === recipient ? Colors.primary : Colors.slate500}
                  />
                  <Text
                    style={[
                      styles.recipientTextButton,
                      smsRecipient === recipient && styles.recipientTextButtonActive,
                    ]}
                  >
                    {recipient === "parent" ? "ولي الأمر" : "الطالب"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>نص الرسالة</Text>
            <TextInput
              style={styles.composeTextArea}
              value={smsMessage}
              onChangeText={setSmsMessage}
              placeholder="اكتب رسالة SMS هنا..."
              placeholderTextColor={Colors.slate400}
              multiline
              numberOfLines={4}
              textAlign="right"
              textAlignVertical="top"
              maxLength={480}
            />
            <View style={styles.composeMetaRow}>
              <Text style={styles.composeCounter}>
                {toArabicDigits(String(smsMessage.length))}/480 حرف ·{" "}
                {toArabicDigits(String(Math.max(1, Math.ceil(smsMessage.length / 70))))} شريحة SMS
              </Text>
            </View>
            {smsMessage.trim() ? (
              <View style={styles.previewBox}>
                <Text style={styles.previewLabel}>معاينة الرسالة:</Text>
                <Text style={styles.previewText}>{smsMessage.trim()}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.sendSmsButton, sendingSms && { opacity: 0.6 }]}
              onPress={requestSendDirectSms}
              disabled={sendingSms}
              activeOpacity={0.8}
            >
              <Ionicons name="send-outline" size={16} color={Colors.white} />
              <Text style={styles.sendSmsText}>
                {sendingSms ? "جارٍ التجهيز..." : "مراجعة وإرسال SMS"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : activeTab === "history" ? (
        <FlatList
          data={filteredEvents}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="notifications-off-outline" size={34} color={Colors.slate400} />
              <Text style={styles.emptyText}>لا توجد إشعارات في الفترة المختارة.</Text>
              {events.length > 0 && datePreset !== "all" ? (
                <TouchableOpacity
                  style={[styles.presetChip, styles.presetChipActive, { marginTop: 6 }]}
                  onPress={() => applyPreset("all")}
                >
                  <Text style={[styles.presetChipText, styles.presetChipTextActive]}>
                    عرض كل الإشعارات ({toArabicDigits(String(events.length))})
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const itemDeliveries = deliveries[item.id] || [];
            const student = studentById.get(item.studentId);
            const primaryDelivery = itemDeliveries[0];
            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={primaryDelivery ? 0.75 : 1}
                onPress={() => {
                  if (primaryDelivery) {
                    setSelectedDetail({
                      event: item,
                      delivery: primaryDelivery,
                      studentName: student?.fullName,
                    });
                  }
                }}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.eventTypeTag}>
                    <Text style={styles.eventTypeText}>{eventTypeLabel(item.eventType)}</Text>
                  </View>
                  <Text style={styles.timestampText}>
                    {formatCairoDateTimeArabic(item.createdAt)}
                  </Text>
                </View>

                {student ? (
                  <Text style={styles.recipientNameText} numberOfLines={1}>
                    الطالب: {student.fullName}
                  </Text>
                ) : null}

                {itemDeliveries.map((del) => {
                  const presentation = getDeliveryStatusPresentation(del.status);
                  const tone = renderToneColors(presentation.tone);
                  const safeFailure = formatUserFailureReason(del.failureReason, del.status);
                  return (
                    <TouchableOpacity
                      key={del.id}
                      style={styles.deliveryRow}
                      onPress={() =>
                        setSelectedDetail({
                          event: item,
                          delivery: del,
                          studentName: student?.fullName,
                        })
                      }
                    >
                      <View style={styles.deliveryMeta}>
                        <Ionicons
                          name={
                            del.channel === "push"
                              ? "phone-portrait-outline"
                              : "chatbubble-ellipses-outline"
                          }
                          size={15}
                          color={Colors.primary}
                        />
                        <Text style={styles.channelText}>
                          {del.channel === "push" ? "إشعار فوري" : "SMS"}
                        </Text>
                        <Text style={styles.recipientText} numberOfLines={1}>
                          {del.recipient || "بدون رقم"}
                        </Text>
                      </View>
                      <View style={[styles.statusBadge, { backgroundColor: tone.bg }]}>
                        <Text style={[styles.statusBadgeText, { color: tone.text }]}>
                          {presentation.label}
                        </Text>
                      </View>
                      {safeFailure ? (
                        <Text style={styles.failureReasonText} numberOfLines={2}>
                          {safeFailure}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </TouchableOpacity>
            );
          }}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          {templates.map((tmpl) => (
            <View key={tmpl.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.tmplTitle}>
                  {eventTypeLabel(tmpl.eventType)} ·{" "}
                  {tmpl.channel === "push" ? "إشعار فوري" : "SMS"}
                </Text>
                <PermissionGate
                  permission="notifications.templates.update"
                  userPermissions={currentUser?.permissions || []}
                >
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => {
                      setEditingTemplate(tmpl);
                      setTemplateBodyInput(tmpl.templateBody);
                    }}
                  >
                    <Ionicons name="create-outline" size={14} color={Colors.white} />
                    <Text style={styles.editBtnText}>تعديل</Text>
                  </TouchableOpacity>
                </PermissionGate>
              </View>
              <Text style={styles.tmplBody}>{tmpl.templateBody}</Text>
            </View>
          ))}

          <View style={styles.variablesInfo}>
            <Text style={styles.varTitle}>المتغيرات الديناميكية المدعومة:</Text>
            <Text style={styles.varItem}>
              {"{{student_name}}"} · {"{{student_first_name}}"} · {"{{parent_name}}"} ·{" "}
              {"{{center_name}}"} · {"{{group_name}}"} · {"{{subject_name}}"} ·{" "}
              {"{{teacher_name}}"} · {"{{session_date}}"} · {"{{session_time}}"} ·{" "}
              {"{{attendance_status}}"} · {"{{exam_name}}"} · {"{{score}}"} ·{" "}
              {"{{max_score}}"} · {"{{grades_summary}}"} · {"{{homework_status}}"} ·{" "}
              {"{{homework_evaluation}}"}
            </Text>
          </View>
        </ScrollView>
      )}

      {/* Delivery Details Modal */}
      <Modal
        visible={!!selectedDetail}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedDetail(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>تفاصيل الإشعار</Text>
            {selectedDetail ? (
              (() => {
                const { event, delivery, studentName } = selectedDetail;
                const pres = getDeliveryStatusPresentation(delivery.status);
                const tone = renderToneColors(pres.tone);
                const safeFailure = formatUserFailureReason(
                  delivery.failureReason,
                  delivery.status,
                );
                const body = getDisplayMessageBody(delivery.renderedMessage);
                return (
                  <ScrollView
                    style={styles.detailScroll}
                    contentContainerStyle={styles.detailList}
                    showsVerticalScrollIndicator
                  >
                    <View style={styles.detailMetaRow}>
                      <View style={[styles.statusBadge, { backgroundColor: tone.bg }]}>
                        <Text style={[styles.statusBadgeText, { color: tone.text }]}>
                          {pres.label}
                        </Text>
                      </View>
                      <View style={styles.eventTypeTag}>
                        <Text style={styles.eventTypeText}>
                          {eventTypeLabel(event.eventType)}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.detailRow}>
                      الطالب / المستلم: {studentName || delivery.recipient || "غير متوفر"}
                    </Text>
                    <Text style={styles.detailRow}>
                      قناة الإرسال: {delivery.channel === "sms" ? "SMS" : "إشعار فوري"}
                    </Text>
                    {delivery.channel === "sms" && delivery.recipient ? (
                      <Text style={styles.detailRow}>
                        رقم الهاتف: {delivery.recipient}
                      </Text>
                    ) : null}
                    <Text style={styles.detailRow}>
                      تاريخ ووقت الإرسال:{" "}
                      {formatCairoDateTimeArabic(delivery.sentAt || event.createdAt)}
                    </Text>
                    {safeFailure ? (
                      <Text style={[styles.detailRow, { color: Colors.dangerText }]}>
                        سبب الفشل: {safeFailure}
                      </Text>
                    ) : null}

                    <View
                      style={
                        delivery.channel === "sms" && !body.isMissing
                          ? styles.smsMessageBubble
                          : styles.previewBox
                      }
                    >
                      <Text style={styles.previewLabel}>نص الرسالة الفعلي:</Text>
                      <Text
                        style={[
                          styles.smsMessageText,
                          body.isMissing && styles.missingMessageText,
                        ]}
                      >
                        {body.text}
                      </Text>
                    </View>
                  </ScrollView>
                );
              })()
            ) : null}
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setSelectedDetail(null)}
            >
              <Text style={styles.cancelBtnText}>إغلاق</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Confirm Direct Send Modal */}
      <Modal
        visible={confirmSendVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmSendVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>تأكيد إرسال SMS</Text>
            <Text style={styles.detailRow}>
              المجموعة: {selectedSmsGroup?.name || "—"}
            </Text>
            <Text style={styles.detailRow}>
              عدد المستلمين الصالحين:{" "}
              {toArabicDigits(String(smsGroupTargets?.sendable.length || 0))}
            </Text>
            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>النص:</Text>
              <Text style={styles.previewText}>{smsMessage.trim()}</Text>
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setConfirmSendVisible(false)}
              >
                <Text style={styles.cancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={executeDirectSms}
                disabled={sendingSms}
              >
                <Text style={styles.saveBtnText}>تأكيد الإرسال</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Arabic Calendar Date Range Modal */}
      <Modal
        visible={calendarVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCalendarVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>اختيار نطاق التاريخ</Text>
            <View style={styles.rangeToggleRow}>
              <TouchableOpacity
                style={[
                  styles.rangeToggleBtn,
                  selectingField === "start" && styles.rangeToggleBtnActive,
                ]}
                onPress={() => setSelectingField("start")}
              >
                <Text style={styles.rangeToggleLabel}>من: {formatLocalDate(draftStartDate)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.rangeToggleBtn,
                  selectingField === "end" && styles.rangeToggleBtnActive,
                ]}
                onPress={() => setSelectingField("end")}
              >
                <Text style={styles.rangeToggleLabel}>إلى: {formatLocalDate(draftEndDate)}</Text>
              </TouchableOpacity>
            </View>

            {calendarError ? (
              <Text style={{ color: Colors.dangerText, fontSize: 11, textAlign: "right" }}>
                {calendarError}
              </Text>
            ) : null}

            <View style={styles.calendarHeader}>
              <TouchableOpacity
                onPress={() => shiftCalendarMonth(-1)}
                style={styles.calendarNavBtn}
              >
                <Ionicons name="chevron-forward" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
              <Text style={styles.calendarMonthTitle}>
                {formatArabicMonthYear(calendarCursor.year, calendarCursor.month)}
              </Text>
              <TouchableOpacity
                onPress={() => shiftCalendarMonth(1)}
                style={styles.calendarNavBtn}
              >
                <Ionicons name="chevron-back" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.calendarWeekRow}>
              {CALENDAR_WEEKDAYS.map((d) => (
                <Text key={d} style={styles.calendarWeekdayText}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {calendarCells.map((dateStr, idx) => {
                if (!dateStr) return <View key={`e-${idx}`} style={styles.calendarCell} />;
                const dayNum = Number(dateStr.slice(8, 10));
                const inRange = dateStr >= draftStartDate && dateStr <= draftEndDate;
                const isEdge = dateStr === draftStartDate || dateStr === draftEndDate;
                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.calendarCell,
                      inRange && styles.calendarCellInRange,
                      isEdge && styles.calendarCellSelected,
                    ]}
                    onPress={() => handleSelectCalendarDay(dateStr)}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        isEdge && styles.calendarDayTextSelected,
                      ]}
                    >
                      {toArabicDigits(String(dayNum))}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setCalendarVisible(false)}
              >
                <Text style={styles.cancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={applyCustomDateRange}>
                <Text style={styles.saveBtnText}>تطبيق</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Edit Template Modal */}
      <Modal visible={!!editingTemplate} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>تعديل قالب الإشعار</Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={4}
              value={templateBodyInput}
              onChangeText={setTemplateBodyInput}
              textAlignVertical="top"
              textAlign="right"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setEditingTemplate(null)}
              >
                <Text style={styles.cancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSaveTemplate}>
                <Text style={styles.saveBtnText}>حفظ</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    centered: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
    loadingText: { fontSize: 13, color: colors.textSecondary },
    header: {
      flexDirection: "row-reverse",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: 10,
      paddingBottom: 8,
      backgroundColor: colors.cardBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 10,
    },
    headerTitle: { fontSize: 18, fontWeight: "900", color: colors.textPrimary, textAlign: "right" },
    headerSubtitle: { fontSize: 11, color: colors.textSecondary, textAlign: "right", marginTop: 1 },
    refreshBtn: {
      width: 34,
      height: 34,
      borderRadius: 9,
      backgroundColor: colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    dateFilterBar: {
      paddingHorizontal: Spacing.md,
      paddingTop: 8,
      paddingBottom: 4,
      gap: 4,
    },
    presetRow: { flexDirection: "row-reverse", gap: 6 },
    presetChip: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 9,
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
    },
    presetChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    presetChipText: { fontSize: 11, fontWeight: "800", color: colors.textPrimary },
    presetChipTextActive: { color: Colors.white },
    activeRangeText: { fontSize: 11, fontWeight: "700", color: colors.primary, textAlign: "right" },
    statsCard: {
      marginHorizontal: Spacing.md,
      marginVertical: 4,
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 8,
      gap: 6,
    },
    statsRow: { flexDirection: "row-reverse" },
    statBox: { flex: 1, alignItems: "center" },
    statVal: { fontSize: 16, fontWeight: "900" },
    statLbl: { fontSize: 10, fontWeight: "700", color: colors.textSecondary, marginTop: 1 },
    channelBreakdownRow: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 5,
    },
    channelBreakdownText: { fontSize: 10, fontWeight: "700", color: colors.textSecondary },
    tabBar: {
      flexDirection: "row-reverse",
      marginHorizontal: Spacing.md,
      marginTop: 4,
      backgroundColor: colors.cardBackground,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 3,
      gap: 4,
    },
    tabButton: { flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8 },
    tabButtonActive: { backgroundColor: colors.primary },
    tabText: { fontSize: 12, fontWeight: "800", color: colors.textSecondary },
    tabTextActive: { color: Colors.white },
    feedbackBanner: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      marginHorizontal: Spacing.md,
      marginTop: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 9,
      borderWidth: 1,
    },
    feedbackSuccess: { backgroundColor: Colors.successLight, borderColor: Colors.success },
    feedbackError: { backgroundColor: Colors.dangerLight, borderColor: Colors.danger },
    feedbackText: { flex: 1, fontSize: 12, fontWeight: "700", textAlign: "right" },
    listContent: { padding: Spacing.md, gap: 8, paddingBottom: 32 },
    card: {
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      padding: 11,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6,
    },
    cardHeader: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    },
    eventTypeTag: {
      backgroundColor: colors.primaryLight,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    eventTypeText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
    timestampText: { fontSize: 10, color: colors.textSecondary },
    recipientNameText: { fontSize: 13, fontWeight: "800", color: colors.textPrimary, textAlign: "right" },
    deliveryRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 6,
    },
    deliveryMeta: { flexDirection: "row-reverse", alignItems: "center", gap: 5, flex: 1 },
    channelText: { fontSize: 12, fontWeight: "800", color: colors.textPrimary },
    recipientText: { fontSize: 11, color: colors.textSecondary },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    statusBadgeText: { fontSize: 10, fontWeight: "800" },
    failureReasonText: { width: "100%", fontSize: 11, color: Colors.dangerText, textAlign: "right" },
    tmplTitle: { flex: 1, fontSize: 13, fontWeight: "800", color: colors.textPrimary, textAlign: "right" },
    editBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      backgroundColor: colors.primary,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 7,
      gap: 4,
    },
    editBtnText: { color: Colors.white, fontSize: 11, fontWeight: "800" },
    tmplBody: {
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 19,
      textAlign: "right",
      backgroundColor: colors.background,
      padding: 8,
      borderRadius: 8,
    },
    variablesInfo: {
      backgroundColor: colors.cardBackground,
      padding: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 4,
    },
    varTitle: { fontSize: 12, fontWeight: "800", color: colors.primary, textAlign: "right" },
    varItem: { fontSize: 11, color: colors.textSecondary, textAlign: "right", lineHeight: 18 },
    emptyContainer: { alignItems: "center", justifyContent: "center", paddingVertical: 36, gap: 6 },
    emptyText: { fontSize: 13, color: colors.textSecondary },
    fieldLabel: { fontSize: 12, fontWeight: "800", color: colors.textPrimary, textAlign: "right" },
    composeInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      paddingHorizontal: 10,
      height: 38,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      fontSize: 12,
    },
    studentPicker: {
      maxHeight: 130,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      padding: 5,
    },
    studentChoice: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      alignItems: "center",
      padding: 8,
      borderRadius: 8,
      marginBottom: 4,
      backgroundColor: colors.background,
    },
    studentChoiceActive: { backgroundColor: colors.primaryLight },
    studentChoiceName: { fontSize: 12, fontWeight: "800", color: colors.textPrimary, textAlign: "right" },
    studentChoiceMeta: { fontSize: 10, color: colors.textSecondary, textAlign: "right" },
    studentChoiceSchedule: { fontSize: 10, color: colors.primary, textAlign: "right" },
    selectedGroupHint: { fontSize: 11, fontWeight: "800", color: colors.primary, textAlign: "right" },
    recipientRow: { flexDirection: "row-reverse", gap: 8 },
    recipientButton: {
      flex: 1,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      paddingVertical: 8,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.border,
    },
    recipientButtonActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
    recipientTextButton: { fontSize: 12, fontWeight: "700", color: colors.textSecondary },
    recipientTextButtonActive: { color: colors.primary, fontWeight: "800" },
    composeTextArea: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      padding: 9,
      minHeight: 84,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      fontSize: 13,
    },
    composeMetaRow: { flexDirection: "row-reverse", justifyContent: "space-between" },
    composeCounter: { fontSize: 11, color: colors.textSecondary },
    previewBox: {
      backgroundColor: colors.background,
      borderRadius: 8,
      padding: 8,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 3,
    },
    previewLabel: { fontSize: 10, fontWeight: "800", color: colors.primary, textAlign: "right" },
    previewText: { fontSize: 12, color: colors.textPrimary, textAlign: "right", lineHeight: 18 },
    sendSmsButton: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      backgroundColor: colors.primary,
      borderRadius: 10,
      minHeight: 40,
    },
    sendSmsText: { color: Colors.white, fontSize: 13, fontWeight: "800" },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.45)",
      justifyContent: "center",
      padding: 18,
    },
    modalContent: {
      backgroundColor: colors.cardBackground,
      borderRadius: 14,
      padding: 14,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    modalTitle: { fontSize: 15, fontWeight: "900", color: colors.textPrimary, textAlign: "right" },
    detailScroll: { maxHeight: 420 },
    detailList: { gap: 6 },
    detailMetaRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 2,
    },
    detailRow: { fontSize: 12, color: colors.textPrimary, textAlign: "right", lineHeight: 18 },
    smsMessageBubble: {
      backgroundColor: colors.primaryLight,
      borderRadius: 12,
      borderTopRightRadius: 4,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.primary,
      marginTop: 4,
      gap: 4,
    },
    smsMessageText: {
      fontSize: 13,
      color: colors.textPrimary,
      textAlign: "right",
      lineHeight: 20,
    },
    missingMessageText: {
      color: colors.textSecondary,
      fontStyle: "italic",
    },
    textArea: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      padding: 10,
      minHeight: 96,
      fontSize: 13,
      color: colors.textPrimary,
      backgroundColor: colors.background,
    },
    modalActions: { flexDirection: "row-reverse", gap: 8, justifyContent: "flex-end" },
    cancelBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.background,
      alignItems: "center",
    },
    cancelBtnText: { color: colors.textPrimary, fontSize: 12, fontWeight: "800" },
    saveBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.primary,
      alignItems: "center",
    },
    saveBtnText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
    rangeToggleRow: { flexDirection: "row-reverse", gap: 6 },
    rangeToggleBtn: {
      flex: 1,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
    },
    rangeToggleBtnActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
    rangeToggleLabel: { fontSize: 11, fontWeight: "800", color: colors.textPrimary },
    calendarHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    calendarNavBtn: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    calendarMonthTitle: { fontSize: 14, fontWeight: "900", color: colors.textPrimary },
    calendarWeekRow: { flexDirection: "row-reverse" },
    calendarWeekdayText: {
      flex: 1,
      textAlign: "center",
      fontSize: 11,
      fontWeight: "800",
      color: colors.textSecondary,
    },
    calendarGrid: { flexDirection: "row-reverse", flexWrap: "wrap" },
    calendarCell: {
      width: "14.2857%",
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
    },
    calendarCellInRange: { backgroundColor: colors.primaryLight },
    calendarCellSelected: { backgroundColor: colors.primary },
    calendarDayText: { fontSize: 12, fontWeight: "700", color: colors.textPrimary },
    calendarDayTextSelected: { color: Colors.white, fontWeight: "900" },
  });
