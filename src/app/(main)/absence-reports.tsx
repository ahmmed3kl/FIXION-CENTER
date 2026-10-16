import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatTimeArabic } from "../../core/localization";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, useTheme } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { AbsenceReportsService, AbsenceSessionReport, AbsenceSessionSummary, CompensationReportRow, MonthlyCrossGroupMakeupRow, MonthlyNeverAttendedRow } from "../../features/attendance/AbsenceReportsService";
import { SessionDateService } from "../../features/sessions/SessionDateService";
import { NotificationService } from "../../features/notifications/NotificationService";
import { AbsenceNoteRepository } from "../../features/attendance/AbsenceNoteRepository";
import { getStudentColorPresentation } from "../../features/students/studentColor";
import {
  absenceNotificationOperationPrefix,
  beginAbsenceRecipientSelection,
  getSelectedAbsenceRecipientIds,
  hasValidNotificationContact,
  toggleAllAbsenceRecipientSelection,
  toggleAbsenceRecipientSelection,
} from "../../features/notifications/absenceNotificationSelection";
import { smartSearch } from "../../shared/utils/smartSearch";
import { Attendance, Student } from "../../shared/types";
import { formatLocalDate } from "../../shared/utils/date";

type SessionGroup = { id?: string; name: string; items: AbsenceSessionSummary[] };
type AbsenceSendStatus = "sent" | "failed" | "partial" | "queued" | "no_contact" | "not_absent";
type AbsenceRecipientScope = "session-absent" | "never-attended" | "cross-group-makeups";
type AbsenceSubsection = AbsenceRecipientScope;

function SessionGroupList({
  groups,
  onPress,
  onGroupPress,
}: {
  groups: SessionGroup[];
  onPress: (sessionId: string) => void;
  onGroupPress?: (group: SessionGroup) => void;
}) {
  return <CollapsibleSessionGroupList groups={groups} onPress={onPress} onGroupPress={onGroupPress} />;
  /* legacy renderer retained below for compatibility with older bundles
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // Create one native subtree explicitly. This avoids any whitespace text
  // nodes being emitted by JSX between View children on older RN runtimes.
  return React.createElement(
    View,
    null,
    ...groups.map((group, groupIndex) =>
      React.createElement(
        View,
        {
          // Group names are not unique; keep sibling keys unique even when
          // server-reset data briefly contains duplicate ids.
          key: `${group.id || group.name || "group"}-${groupIndex}`,
          style: styles.groupReport,
        },
        React.createElement(
          Text,
          { style: styles.groupReportTitle },
          `${String(group.name)} · ${String(group.items.length)} حصة`,
        ),
        ...group.items.map((item, itemIndex) =>
          React.createElement(
            View,
            { key: `${item.session.id || "session"}-${itemIndex}` },
            React.createElement(
              Text,
              { style: styles.sessionNumber },
              `الحصة رقم ${String(item.sessionNumber ?? "—")}`,
            ),
            React.createElement(NativeSessionCard, {
              item,
              onPress: () => onPress(item.session.id),
            }),
          ),
        ),
      ),
    ),
  );
*/
}
function CollapsibleSessionGroupList({
  groups,
  onPress,
  onGroupPress,
}: {
  groups: SessionGroup[];
  onPress: (sessionId: string) => void;
  onGroupPress?: (group: SessionGroup) => void;
}) {
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const router = useRouter();
  const ordered = groups.map((group) => ({
    ...group,
    items: [...group.items].sort((a, b) => `${b.session.sessionDate}T${b.session.startTime || ""}`.localeCompare(`${a.session.sessionDate}T${a.session.startTime || ""}`)),
  }));
  return (
    <View>
      {ordered.map((group, index) => {
        const key = `${group.id || group.name}-${index}`;
        const isOpen = expandedGroupId === (group.id || group.name);
        return (
          <View key={key} style={styles.groupReport}>
            <TouchableOpacity style={styles.groupReportHeader} activeOpacity={0.8} onPress={() => {
              if (onGroupPress) onGroupPress(group);
              else setExpandedGroupId(isOpen ? null : (group.id || group.name));
            }}>
              <Ionicons name={isOpen ? "chevron-down" : "chevron-back"} size={19} color={Colors.primary} />
              <View style={styles.groupReportHeaderCopy}>
                <Text style={styles.groupReportTitle}>{group.name}</Text>
                <Text style={styles.groupReportHint}>{group.items.length} حصة · اضغط لعرض التفاصيل</Text>
              </View>
            </TouchableOpacity>
            {isOpen ? group.items.map((item, itemIndex) => (
              <View key={`${item.session.id}-${itemIndex}`}>
                <Text style={styles.sessionNumber}>الحصة رقم {item.sessionNumber ?? "—"}</Text>
                <NativeSessionCard item={item} onPress={() => onPress(item.session.id)} />
              </View>
            )) : null}
          </View>
        );
      })}
    </View>
  );
}

function NativeCounter({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "red" | "purple" }) {
  const valueStyle = tone === "green" ? styles.green : tone === "red" ? styles.red : tone === "purple" ? styles.purple : undefined;
  return React.createElement(
    View,
    { style: styles.counter },
    React.createElement(Text, { style: [styles.counterValue, valueStyle] }, String(value)),
    React.createElement(Text, { style: styles.counterLabel }, String(label)),
  );
}

function NativeSessionCard({ item, onPress }: { item: AbsenceSessionSummary; onPress: () => void }) {
  const session = item.session;
  return React.createElement(
    TouchableOpacity,
    { activeOpacity: 0.8, onPress, style: styles.sessionCard },
    React.createElement(
      View,
      { style: styles.sessionCardTop },
      React.createElement(
        View,
        { style: styles.chevron },
        React.createElement(Ionicons, { name: "chevron-back", size: 19, color: Colors.slate400 }),
      ),
      React.createElement(
        View,
        { style: styles.sessionCopy },
        React.createElement(Text, { numberOfLines: 1, style: styles.sessionName }, String(session.groupName || "مجموعة")),
        React.createElement(Text, { numberOfLines: 1, style: styles.sessionMeta }, `${String(session.subjectName || "")} · ${String(session.teacherName || "مدرس غير محدد")}`),
        React.createElement(Text, { style: styles.sessionDate }, `${String(formatDate(session.sessionDate))} · ${String(formatTimeArabic(session.startTime))}`),
      ),
    ),
    React.createElement(
      View,
      { style: styles.cardCounters },
      React.createElement(NativeCounter, { label: "الكل", value: item.total, tone: "blue" }),
      React.createElement(NativeCounter, { label: "حاضر", value: item.present, tone: "green" }),
      React.createElement(NativeCounter, { label: "غائب", value: item.absent, tone: "red" }),
      React.createElement(NativeCounter, { label: "تعويض", value: item.compensated, tone: "purple" }),
    ),
  );
}

const MONTH_NAMES = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return "جارٍ تحديد الشهر...";
  const [year, month] = key.split("-").map(Number);
  return `${MONTH_NAMES[(month || 1) - 1]} ${year}`;
}

function shiftMonth(key: string, offset: number): string {
  const [year, month] = key.split("-").map(Number);
  return monthKey(new Date(year, month - 1 + offset, 1));
}

function formatDate(date: string): string {
  return formatLocalDate(date);
}

function attendanceLabel(attendance: Attendance): string {
  if (attendance.attendanceType === "makeup") return "تعويض";
  return attendance.status === "late" ? "متأخر" : "حاضر";
}

export default function AbsenceReportsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  // Styles are static for this screen; keep them module-scoped so render is
  // free of global mutations.
  const services = useServiceVisibility();
  const currentUser = useAuthStore((state) => state.currentUser);
  const activeCenterId = useAuthStore((state) => state.activeCenterId);
  const localDataRevision = useLocalDataRevision();
  const monthManuallySelectedRef = useRef(false);
  const [month, setMonth] = useState("");
  const [businessMonthWarning, setBusinessMonthWarning] = useState("");
  const [sessions, setSessions] = useState<AbsenceSessionSummary[]>([]);
  const [monthlyNeverAttended, setMonthlyNeverAttended] = useState<MonthlyNeverAttendedRow[]>([]);
  const [monthlyCrossGroupMakeups, setMonthlyCrossGroupMakeups] = useState<MonthlyCrossGroupMakeupRow[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [absenceSentBefore, setAbsenceSentBefore] = useState(false);
  const [selectionModes, setSelectionModes] = useState<Record<AbsenceRecipientScope, boolean>>({
    "session-absent": false,
    "never-attended": false,
    "cross-group-makeups": false,
  });
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<Record<AbsenceRecipientScope, Set<string>>>({
    "session-absent": new Set(),
    "never-attended": new Set(),
    "cross-group-makeups": new Set(),
  });
  const [absenceSendStatuses, setAbsenceSendStatuses] = useState<Record<string, AbsenceSendStatus>>({});
  const [sendingSelectedAbsences, setSendingSelectedAbsences] = useState(false);
  const sendingSelectedAbsencesRef = useRef(false);
  const [report, setReport] = useState<AbsenceSessionReport | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"absent" | "present" | "compensation">("absent");
  const [absenceSubsection, setAbsenceSubsection] = useState<AbsenceSubsection>("session-absent");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [noteTarget, setNoteTarget] = useState<Student | null>(null);
  const [absenceNoteText, setAbsenceNoteText] = useState("");
  const [savingAbsenceNote, setSavingAbsenceNote] = useState(false);
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionGroup>();
    sessions.forEach((item) => {
      const session = item?.session;
      if (!session?.id) return;
      const key = session.groupId || session.groupName || session.id;
      const safeItem = {
        ...item,
        session: {
          ...session,
          id: String(session.id),
          groupId: String(session.groupId || key),
          groupName: typeof session.groupName === "string" ? session.groupName : "مجموعة",
          subjectName: typeof session.subjectName === "string" ? session.subjectName : "",
          teacherName: typeof session.teacherName === "string" ? session.teacherName : "مدرس غير محدد",
        },
        sessionNumber: Number.isFinite(item.sessionNumber) ? item.sessionNumber : 0,
      };
      const current = groups.get(key) || { id: String(key), name: item.session.groupName || "مجموعة", items: [] };
      if (typeof current.name !== "string") current.name = "مجموعة";
      current.items.push(safeItem);
      groups.set(key, current);
    });
    return Array.from(groups.values());
  }, [sessions]);

  const canView = PermissionService.hasAnyPermission(currentUser?.permissions || [], ["attendance.view", "reports.attendance.view", "reports.view"]);
  const canEditAbsenceNotes = PermissionService.hasPermission(currentUser?.permissions || [], "attendance.edit");
  const canSendAbsenceNotifications = PermissionService.hasPermission(currentUser?.permissions || [], "notifications.send");
  const resolveDefaultMonth = useCallback((currentMonth: string): string => {
    if (monthManuallySelectedRef.current) return currentMonth;
    try {
      if (!activeCenterId) throw new Error("A center must be selected before resolving its report month.");
      const centerMonth = SessionDateService.getCurrentSessionMonth(activeCenterId);
      setBusinessMonthWarning("");
      if (centerMonth !== currentMonth) setMonth(centerMonth);
      return centerMonth;
    } catch (error) {
      console.warn("Failed to resolve center month for absence reports:", error);
      const fallbackMonth = monthKey(new Date());
      setBusinessMonthWarning(
        "تعذر تحديد الشهر الحالي وفق المنطقة الزمنية للمركز؛ يعرض شهر الجهاز كبداية ويمكنك تغييره يدويًا.",
      );
      if (fallbackMonth !== currentMonth) setMonth(fallbackMonth);
      return fallbackMonth;
    }
  }, [activeCenterId]);

  useEffect(() => {
    monthManuallySelectedRef.current = false;
    resolveDefaultMonth("");
  }, [activeCenterId, resolveDefaultMonth]);

  const loadSessions = useCallback(() => {
    if (!month) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const monthSessions = AbsenceReportsService.getSessionsForMonth(month);
      setSessions(monthSessions);
      setMonthlyNeverAttended(AbsenceReportsService.getMonthlyNeverAttended(month, monthSessions));
      setMonthlyCrossGroupMakeups(AbsenceReportsService.getMonthlyCrossGroupMakeups(month, monthSessions));
    } catch (err: any) {
      setSessions([]);
      setMonthlyNeverAttended([]);
      setMonthlyCrossGroupMakeups([]);
      setError(err?.message || "تعذر تحميل جلسات الشهر.");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useFocusEffect(useCallback(() => {
    if (!services.loaded || !canView) return;
    const resolvedMonth = resolveDefaultMonth(month);
    if (resolvedMonth !== month) return;
    loadSessions();
    if (selectedSessionId) {
      try {
        setReport(AbsenceReportsService.getSessionReport(selectedSessionId));
      } catch (err: any) {
        setError(err?.message || "تعذر تحديث ملاحظات الحصة.");
      }
    }
  }, [canView, loadSessions, localDataRevision, month, resolveDefaultMonth, selectedSessionId, services.loaded]));

  useFocusEffect(useCallback(() => () => {
    setSelectionModes({
      "session-absent": false,
      "never-attended": false,
      "cross-group-makeups": false,
    });
    setSelectedRecipientIds({
      "session-absent": new Set(),
      "never-attended": new Set(),
      "cross-group-makeups": new Set(),
    });
  }, []));

  const openSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSelectionModes({
      "session-absent": false,
      "never-attended": false,
      "cross-group-makeups": false,
    });
    setSelectedRecipientIds({
      "session-absent": new Set(),
      "never-attended": new Set(),
      "cross-group-makeups": new Set(),
    });
    setAbsenceSendStatuses({});
    try { setAbsenceSentBefore(NotificationService.hasAbsenceNotification(sessionId)); } catch { setAbsenceSentBefore(false); }
    setReport(null);
    setSearch("");
    setTab("absent");
    setAbsenceSubsection("session-absent");
    setDetailLoading(true);
    try {
      setReport(AbsenceReportsService.getSessionReport(sessionId));
    } catch (err: any) {
      Alert.alert("تعذر فتح التفاصيل", err?.message || "حدث خطأ أثناء تحميل بيانات الحصة.");
      setSelectedSessionId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const filteredAbsent = useMemo(() => report ? smartSearch(report.absent, search, [{ get: (student) => student.fullName }, { get: (student) => student.studentCode }]) : [], [report, search]);
  const filteredPresent = useMemo(() => report ? report.present.filter(({ student }) => smartSearch([student], search, [{ get: (item) => item.fullName }, { get: (item) => item.studentCode }]).length) : [], [report, search]);
  const filteredCompensation = useMemo(() => report ? report.compensation.filter(({ student }) => smartSearch([student], search, [{ get: (item) => item.fullName }, { get: (item) => item.studentCode }]).length) : [], [report, search]);
  const crossGroupMakeupsForSession = useMemo(() => monthlyCrossGroupMakeups
    .filter((row) => row.originalSession.id === report?.session.id)
    .filter((row) => report?.absent.some((student) => student.id === row.student.id)),
  [monthlyCrossGroupMakeups, report]);
  const neverAttendedForSession = useMemo(() => {
    if (!report) return [];
    const absentIds = new Set(report.absent.map((student) => student.id));
    const successfullyCompensatedIds = new Set(crossGroupMakeupsForSession.map((row) => row.student.id));
    return AbsenceReportsService.getNeverAttendedForSession(
      report.session,
      monthlyNeverAttended,
      successfullyCompensatedIds,
      absentIds,
    );
  }, [crossGroupMakeupsForSession, monthlyNeverAttended, report]);
  const filteredNeverAttended = useMemo(() => neverAttendedForSession
    .filter(({ student }) => smartSearch([student], search, [{ get: (item) => item.fullName }, { get: (item) => item.studentCode }]).length),
  [neverAttendedForSession, search]);
  const filteredCrossGroupMakeups = useMemo(() => crossGroupMakeupsForSession
    .filter(({ student }) => smartSearch([student], search, [{ get: (item) => item.fullName }, { get: (item) => item.studentCode }]).length),
  [crossGroupMakeupsForSession, search]);

  const sessionCompensatedMap = useMemo(() => {
    const map = new Map<string, { groupName?: string; sessionDate?: string }>();
    if (!report) return map;
    for (const row of crossGroupMakeupsForSession) {
      map.set(row.student.id, {
        groupName: row.targetSession.groupName,
        sessionDate: row.targetSession.sessionDate,
      });
    }
    for (const row of report.compensation || []) {
      if (row.kind === "completed" && row.targetSession) {
        map.set(row.student.id, {
          groupName: row.targetSession.groupName,
          sessionDate: row.targetSession.sessionDate,
        });
      }
    }
    return map;
  }, [crossGroupMakeupsForSession, report]);

  const getAbsenceScopeStudentIds = (scope: AbsenceRecipientScope, sourceReport = report): string[] => {
    if (!sourceReport) return [];
    if (scope === "session-absent") {
      const compensatedIds = new Set<string>();
      for (const row of crossGroupMakeupsForSession) {
        compensatedIds.add(row.student.id);
      }
      for (const row of sourceReport.compensation || []) {
        if (row.kind === "completed") {
          compensatedIds.add(row.student.id);
        }
      }
      return sourceReport.absent
        .filter((student) => !compensatedIds.has(student.id))
        .map((student) => student.id);
    }
    if (scope === "never-attended") return [];
    const absentIds = new Set(sourceReport.absent.map((student) => student.id));
    if (scope === "cross-group-makeups") {
      return monthlyCrossGroupMakeups
        .filter((row) => row.originalSession.id === sourceReport.session.id && absentIds.has(row.student.id))
        .map((row) => row.student.id);
    }
    const crossMakeupIds = new Set(
      monthlyCrossGroupMakeups
        .filter((row) => row.originalSession.id === sourceReport.session.id && absentIds.has(row.student.id))
        .map((row) => row.student.id),
    );
    return AbsenceReportsService.getNeverAttendedForSession(
      sourceReport.session,
      monthlyNeverAttended,
      crossMakeupIds,
      absentIds,
    ).map((row) => row.student.id);
  };

  const openAbsenceNote = (student: Student) => {
    setAbsenceNoteText(report?.absenceNotes[student.id] || "");
    setNoteTarget(student);
  };

  const saveAbsenceNote = () => {
    if (!selectedSessionId || !noteTarget || savingAbsenceNote) return;
    setSavingAbsenceNote(true);
    try {
      AbsenceNoteRepository.save(selectedSessionId, noteTarget.id, absenceNoteText);
      setReport(AbsenceReportsService.getSessionReport(selectedSessionId));
      setNoteTarget(null);
    } catch (err: any) {
      Alert.alert("تعذر حفظ الملاحظة", err?.message || "حاول مرة أخرى.");
    } finally {
      setSavingAbsenceNote(false);
    }
  };

  const updateScopeSelection = (scope: AbsenceRecipientScope, updater: (selected: Set<string>) => Set<string>) => {
    setSelectedRecipientIds((previous) => ({ ...previous, [scope]: updater(previous[scope]) }));
  };

  const toggleRecipientSelection = (scope: AbsenceRecipientScope, studentId: string) => {
    updateScopeSelection(scope, (selected) => toggleAbsenceRecipientSelection(selected, studentId));
  };

  const enterRecipientSelection = (scope: AbsenceRecipientScope, studentId?: string) => {
    setSelectionModes((previous) => ({ ...previous, [scope]: true }));
    if (studentId) updateScopeSelection(scope, () => beginAbsenceRecipientSelection(studentId));
  };

  const toggleAllRecipients = (scope: AbsenceRecipientScope) => {
    if (!report || sendingSelectedAbsences) return;
    setSelectionModes((previous) => ({ ...previous, [scope]: true }));
    const scopedIds = getAbsenceScopeStudentIds(scope);
    updateScopeSelection(scope, (selected) =>
      toggleAllAbsenceRecipientSelection(selected, scopedIds),
    );
  };

  const cancelAbsenceSelection = (scope: AbsenceRecipientScope) => {
    setSelectionModes((previous) => ({ ...previous, [scope]: false }));
    updateScopeSelection(scope, () => new Set());
  };

  const sendSelectedAbsences = (scope: AbsenceRecipientScope) => {
    const selectedIds = getSelectedAbsenceRecipientIds(
      selectedRecipientIds[scope],
      getAbsenceScopeStudentIds(scope),
    );
    if (!report || !selectedSessionId || !selectedIds.length || sendingSelectedAbsencesRef.current) return;
    if (!services.isEnabled("notifications")) {
      Alert.alert("الإشعارات غير مفعلة", "فعّل خدمة الإشعارات لهذا المركز من إدارة المنصة.");
      return;
    }
    if (!canSendAbsenceNotifications) {
      Alert.alert("غير مسموح", "ليس لديك صلاحية إرسال الإشعارات.");
      return;
    }
    const count = selectedIds.length;
    Alert.alert(
      "تأكيد إرسال إشعار الغياب",
      `سيتم تجهيز إشعارات الغياب لـ ${count} طالب${count === 1 ? "" : "اً"} محدد${count === 1 ? "" : "ين"} فقط. هل تريد المتابعة؟`,
      [
        { text: "إلغاء", style: "cancel" },
        { text: "تأكيد الإرسال", onPress: () => { void executeSelectedAbsenceSend(scope, selectedIds); } },
      ],
    );
  };

  const executeSelectedAbsenceSend = async (scope: AbsenceRecipientScope, requestedStudentIds: string[]) => {
    if (!report || !selectedSessionId || sendingSelectedAbsencesRef.current) return;
    sendingSelectedAbsencesRef.current = true;
    setSendingSelectedAbsences(true);
    let studentIds: string[] = [];
    const statusUpdates: Record<string, AbsenceSendStatus> = {};
    const details: string[] = [];

    try {
      const refreshedReport = AbsenceReportsService.getSessionReport(selectedSessionId);
      studentIds = getSelectedAbsenceRecipientIds(
        requestedStudentIds,
        getAbsenceScopeStudentIds(scope, refreshedReport),
      );
      if (!studentIds.length) {
        Alert.alert("تغيّرت قائمة الغياب", "لم يعد أي من الطلاب المحددين ضمن هذه القائمة.");
        cancelAbsenceSelection(scope);
        return;
      }
      const currentStudents = new Map(refreshedReport.absent.map((student) => [student.id, student]));
      for (const studentId of studentIds) {
        const student = currentStudents.get(studentId);
        if (!student) {
          statusUpdates[`${scope}:${studentId}`] = "not_absent";
          details.push("طالب محدد: لم يعد غائبًا عن هذه الحصة.");
          continue;
        }
        if (!hasValidNotificationContact(student.parentPhone, student.phone)) {
          statusUpdates[`${scope}:${studentId}`] = "no_contact";
          details.push(`${student.fullName}: لا توجد وسيلة تواصل صالحة.`);
          continue;
        }
        try {
          const events = NotificationService.notifyAbsentees({
            sessionId: selectedSessionId,
            selectedStudentIds: [studentId],
            operationPrefix: absenceNotificationOperationPrefix(selectedSessionId, studentId),
          });
          const event = events[0];
          const dispatch = await NotificationService.sendPendingDeliveries(event.id);
          const deliveryStatus = NotificationService.getDeliveryStatusCounts(event.id);
          const status: AbsenceSendStatus = deliveryStatus.failed > 0
            ? deliveryStatus.sent > 0 || deliveryStatus.pending > 0 || deliveryStatus.sending > 0
              ? "partial"
              : "failed"
            : deliveryStatus.pending > 0 || deliveryStatus.sending > 0
              ? "queued"
              : dispatch.sent > 0 || deliveryStatus.sent > 0
                ? "sent"
                : "failed";
          statusUpdates[`${scope}:${studentId}`] = status;
          const statusLabel = status === "sent"
            ? "تم الإرسال"
            : status === "partial"
              ? "إرسال جزئي"
            : status === "queued"
              ? "قيد الإرسال"
              : "فشل الإرسال";
          details.push(`${student.fullName}: ${statusLabel}${deliveryStatus.failed ? ` (${deliveryStatus.failed} وسيلة فاشلة)` : ""}.`);
        } catch (sendError: any) {
          statusUpdates[`${scope}:${studentId}`] = "failed";
          details.push(`${student.fullName}: تعذر الإرسال${sendError?.message ? ` (${sendError.message})` : ""}.`);
        }
      }
      setAbsenceSendStatuses((previous) => ({ ...previous, ...statusUpdates }));
      cancelAbsenceSelection(scope);
      Alert.alert(
        "نتيجة إرسال إشعارات الغياب",
        `المحددون: ${studentIds.length}\n${details.join("\n")}`,
      );
    } catch (error: any) {
      Alert.alert("تعذر إرسال الإشعارات", error?.message || "حدث خطأ أثناء تحديث بيانات الغياب.");
    } finally {
      sendingSelectedAbsencesRef.current = false;
      setSendingSelectedAbsences(false);
    }
  };

  const sendAll = async () => {
    if (absenceSentBefore) {
      const confirmed = await new Promise<boolean>((resolve) => Alert.alert("تم إرسال الغياب مسبقًا", "هل تريد إعادة الإرسال؟", [{ text: "إلغاء", style: "cancel", onPress: () => resolve(false) }, { text: "إرسال مرة أخرى", onPress: () => resolve(true) }]));
      if (!confirmed) return;
    }
    if (!report || !selectedSessionId) return;
    if (!services.isEnabled("notifications")) {
      Alert.alert("الإشعارات غير مفعلة", "فعّل خدمة الإشعارات لهذا المركز من إدارة المنصة.");
      return;
    }
    if (!PermissionService.hasPermission(currentUser?.permissions || [], "notifications.send")) {
      Alert.alert("غير مسموح", "ليس لديك صلاحية إرسال الإشعارات.");
      return;
    }
    try {
      const refreshedReport = AbsenceReportsService.getSessionReport(selectedSessionId);
      setReport(refreshedReport);
      const recipientIds = getAbsenceScopeStudentIds("session-absent", refreshedReport);
      if (!recipientIds.length) {
        Alert.alert("تغيّرت حالة الغياب", "لم يعد هناك غياب صريح صالح لإرسال إشعارات عنه.");
        return;
      }
      const events = NotificationService.notifyAbsentees({
        sessionId: selectedSessionId,
        selectedStudentIds: recipientIds,
        operationPrefix: `op-a-${selectedSessionId.slice(-8)}-${Date.now().toString(36).slice(-5)}`,
      });
      setAbsenceSentBefore(true);
      let sent = 0;
      for (const event of events) {
        const result = await NotificationService.sendPendingDeliveries(event.id);
        sent += result.sent;
      }
      Alert.alert("تم الإرسال", `تم تجهيز إشعار الغياب لـ ${events.length} طالباً (${sent} وسيلة إرسال).`);
    } catch (err: any) {
      Alert.alert("تعذر الإرسال", err?.message || "حدث خطأ أثناء إرسال الإشعارات.");
    }
  };

  const renderAbsenceList = (
    scope: AbsenceRecipientScope,
    title: string,
    students: Student[],
    emptyText: string,
    getDetailNote?: (studentId: string) => string | undefined,
  ) => {
    const selectedIds = selectedRecipientIds[scope];
    const selectionMode = selectionModes[scope];
    const notificationEligible = scope !== "never-attended";
    const scopedIds = getAbsenceScopeStudentIds(scope);
    const scopedSelectedIds = getSelectedAbsenceRecipientIds(selectedIds, scopedIds);
    const allSelected = scopedIds.length > 0 && scopedSelectedIds.length === scopedIds.length;
    return <>
      {selectionMode ? (
        <View style={styles.selectionToolbar}>
          <View style={styles.selectionToolbarCopy}>
            <Text style={styles.selectionCount}>تم تحديد {scopedSelectedIds.length} من {scopedIds.length} طالب</Text>
            <Text style={styles.selectionHint}>الإرسال لهذه القائمة فقط</Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={!scopedIds.length || sendingSelectedAbsences}
            style={styles.selectAllButton}
            onPress={() => toggleAllRecipients(scope)}
          >
            <Text style={styles.selectAllText}>{allSelected ? "إلغاء تحديد الكل" : "تحديد الكل"}</Text>
          </TouchableOpacity>
          {canSendAbsenceNotifications && notificationEligible ? (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={!scopedSelectedIds.length || sendingSelectedAbsences}
              style={[styles.sendSelectedButton, (!scopedSelectedIds.length || sendingSelectedAbsences) && styles.disabledButton]}
              onPress={() => sendSelectedAbsences(scope)}
            >
              {sendingSelectedAbsences ? <ActivityIndicator size="small" color={Colors.white} /> : <Ionicons name="send-outline" size={15} color={Colors.white} />}
              <Text style={styles.sendButtonText}>إرسال المحددين</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            disabled={sendingSelectedAbsences}
            style={styles.cancelSelectionButton}
            onPress={() => cancelAbsenceSelection(scope)}
          >
            <Text style={styles.cancelSelectionText}>إلغاء</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.actionRow}>
          <View style={styles.headerCopy}>
            <Text style={styles.sectionTitle}>{title} ({students.length})</Text>
            <Text style={styles.selectionHint}>
              {notificationEligible ? "اختر القائمة وحدد المستلمين قبل الإرسال" : "قائمة استرشادية؛ لا تمثل غياباً مؤكداً ولا ترسل إشعار غياب."}
            </Text>
          </View>
          {canSendAbsenceNotifications && notificationEligible ? (
            <View style={styles.absentActions}>
              <TouchableOpacity style={styles.selectAllButton} onPress={() => enterRecipientSelection(scope)}>
                <Text style={styles.selectAllText}>تحديد أفراد</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.selectAllButton} onPress={() => toggleAllRecipients(scope)}>
                <Text style={styles.selectAllText}>تحديد الكل</Text>
              </TouchableOpacity>
              {scope !== "session-absent" ? (
                <TouchableOpacity
                  style={[styles.selectAllButton, !scopedSelectedIds.length && styles.disabledButton]}
                  disabled={!scopedSelectedIds.length}
                  onPress={() => sendSelectedAbsences(scope)}
                >
                  <Text style={styles.selectAllText}>إرسال المحددين</Text>
                </TouchableOpacity>
              ) : null}
              {scope === "session-absent" ? (
                <TouchableOpacity style={styles.sendButton} onPress={sendAll}>
                  <Ionicons name="send-outline" size={15} color={Colors.white} />
                  <Text style={styles.sendButtonText}>إرسال للكل</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
      {students.map((student) => {
        const comp = scope === "session-absent" ? sessionCompensatedMap.get(student.id) : undefined;
        const status = comp
          ? "تم التعويض"
          : scope === "never-attended"
            ? "لم يحضر"
            : scope === "cross-group-makeups"
              ? "تم التعويض"
              : undefined;
        const statusTone = comp || scope === "cross-group-makeups" ? "green" : "orange";
        const detailNote = comp
          ? `الأصل: ${report?.session.groupName || "مجموعة"} (${formatDate(report?.session.sessionDate || "")}) · التعويض: ${comp.groupName || "مجموعة"} (${formatDate(comp.sessionDate || "")})`
          : getDetailNote?.(student.id);
        const canSelectStudent = notificationEligible && !comp;
        return (
          <StudentRow
            key={`${scope}:${student.id}`}
            student={student}
            status={status}
            statusTone={statusTone}
            detailNote={detailNote}
            note={report?.absenceNotes[student.id]}
            selected={selectedIds.has(student.id)}
            selectionMode={selectionMode}
            sendStatus={absenceSendStatuses[`${scope}:${student.id}`]}
            onToggleSelection={canSelectStudent ? () => toggleRecipientSelection(scope, student.id) : undefined}
            onLongPress={canSendAbsenceNotifications && canSelectStudent ? () => enterRecipientSelection(scope, student.id) : undefined}
            onNotePress={!selectionMode && canEditAbsenceNotes ? () => openAbsenceNote(student) : undefined}
            onPress={() => {
              if (selectionMode && canSelectStudent) toggleRecipientSelection(scope, student.id);
              else router.push({ pathname: "/(main)/students", params: { studentId: student.id } } as any);
            }}
          />
        );
      })}
      {!students.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : emptyText} /> : null}
    </>;
  };

  if (!services.loaded) return <View style={styles.centered}><ActivityIndicator color={Colors.primary} /><Text style={styles.muted}>جارٍ تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("reports")) return <View style={styles.centered}><Ionicons name="lock-closed-outline" size={34} color={Colors.slate400} /><Text style={styles.emptyTitle}>تقارير الغياب غير مفعلة</Text><Text style={styles.muted}>فعّل خدمة التقارير لهذا المركز من إدارة المنصة.</Text></View>;
  if (!canView) return <View style={styles.centered}><Ionicons name="shield-outline" size={34} color={Colors.slate400} /><Text style={styles.emptyTitle}>ليس لديك صلاحية عرض الحضور والغياب</Text></View>;

  if (selectedSessionId && report) {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.detailHeader}><TouchableOpacity onPress={() => { setSelectedSessionId(null); setReport(null); }} style={styles.backButton}><Ionicons name="chevron-forward" size={23} color={Colors.slate800} /></TouchableOpacity><View style={styles.headerCopy}><Text style={styles.eyebrow}>تفاصيل الحصة</Text><Text style={styles.title}>{report.session.groupName || "مجموعة"}</Text><Text style={styles.subtitle}>{report.session.subjectName || ""}  •  {report.session.teacherName || "مدرس غير محدد"}</Text></View><View style={styles.headerIcon}><Ionicons name="calendar-outline" size={22} color={Colors.primary} /></View></View>
      <View style={styles.sessionInfo}><Text style={styles.sessionInfoLine}>{formatDate(report.session.sessionDate)}  •  {formatTimeArabic(report.session.startTime)} - {formatTimeArabic(report.session.endTime)}</Text><View style={styles.counterRow}><Counter label="الكل" value={report.expected.length} tone="blue" /><Counter label="حاضر" value={report.present.length} tone="green" /><Counter label="غائب" value={report.absent.length} tone="red" /><Counter label="تعويض" value={report.compensated} tone="purple" /></View></View>
      <View style={styles.tabRow}>{[["present", "الحاضرين", report.present.length], ["absent", "الغائبين", report.absent.length], ["compensation", "التعويض", report.compensation.length]].map(([key, label, count]) => <TouchableOpacity key={String(key)} onPress={() => setTab(key as typeof tab)} style={[styles.tab, tab === key && styles.tabActive]}><Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label} ({count})</Text></TouchableOpacity>)}</View>
      <View style={styles.searchWrap}><Ionicons name="search-outline" size={18} color={Colors.slate400} /><TextInputLike value={search} onChangeText={setSearch} placeholder="ابحث باسم الطالب أو الكود" /></View>
      {tab === "absent" ? <>
        <View style={styles.reportExtraTabs}>
          {([
            ["session-absent", `غياب الجلسة (${filteredAbsent.length})`],
            ["never-attended", `لم يحضروا مطلقًا (${filteredNeverAttended.length})`],
            ["cross-group-makeups", `عوّضوا في مجموعة أخرى (${filteredCrossGroupMakeups.length})`],
          ] as const).map(([key, label]) => (
            <TouchableOpacity
              key={key}
              accessibilityRole="button"
              accessibilityState={{ selected: absenceSubsection === key }}
              onPress={() => setAbsenceSubsection(key)}
              style={[styles.reportExtraTab, absenceSubsection === key && styles.tabActive]}
            >
              <Text style={[styles.tabText, absenceSubsection === key && styles.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {absenceSubsection === "session-absent"
          ? renderAbsenceList("session-absent", "الطلاب الغائبون", filteredAbsent, "لا يوجد غياب مسجل لهذه الحصة.")
          : null}
        {absenceSubsection === "never-attended"
          ? renderAbsenceList(
            "never-attended",
            "لم يحضروا مطلقًا ضمن دورة الشرح",
            filteredNeverAttended.map((row) => row.student),
            "لا يوجد طالب غائب متوقع لم يحضر خلال دورة الشرح.",
            (studentId) => {
              const row = neverAttendedForSession.find((item) => item.student.id === studentId);
              return row
                ? `دورة الشرح: ${formatDate(row.cycleStartDate)} – ${formatDate(row.cycleEndDate)} · المجموعات: ${row.groupNames.join("، ") || "—"}`
                : undefined;
            },
          )
          : null}
        {absenceSubsection === "cross-group-makeups"
          ? renderAbsenceList(
            "cross-group-makeups",
            "عوّضوا في مجموعة أخرى",
            filteredCrossGroupMakeups.map((row) => row.student),
            "لا توجد تعويضات ناجحة مرتبطة بهذه الجلسة في مجموعة أخرى.",
            (studentId) => {
              const row = crossGroupMakeupsForSession.find((item) => item.student.id === studentId);
              return row
                ? `الأصل: ${row.originalSession.groupName || "مجموعة"} (${formatDate(row.originalSession.sessionDate)}) · التعويض: ${row.targetSession.groupName || "مجموعة"} (${formatDate(row.targetSession.sessionDate)})`
                : undefined;
            },
          )
          : null}
      </> : null}
      {tab === "present" ? <>{filteredPresent.map(({ student, attendance }) => <StudentRow key={student.id} student={student} status={attendanceLabel(attendance)} statusTone={attendance.status === "late" ? "orange" : "green"} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: student.id } } as any)} />)}{!filteredPresent.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : "لا يوجد حضور مسجل لهذه الحصة."} /> : null}</> : null}
      {tab === "compensation" ? <>{filteredCompensation.map((row) => <CompensationRow key={`${row.student.id}-${row.kind}-${row.attendance?.id || row.opportunity?.nextEligibleSessionId || "advance"}`} row={row} targetSession={report.session} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: row.student.id } } as any)} />)}{!filteredCompensation.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : "لا توجد بيانات تعويض لهذه الحصة."} /> : null}</> : null}
    </ScrollView>
    <Modal visible={Boolean(noteTarget)} transparent animationType="fade" onRequestClose={() => { if (!savingAbsenceNote) setNoteTarget(null); }}>
      <View style={styles.modalOverlay}>
        <View style={styles.noteModal}>
          <Text style={styles.noteModalTitle}>ملاحظة الغياب</Text>
          <Text style={styles.noteModalHint}>{noteTarget?.fullName || ""} · {report.session.groupName || "الجلسة المحددة"}</Text>
          <TextInput
            value={absenceNoteText}
            onChangeText={setAbsenceNoteText}
            placeholder="اكتب سبب الغياب"
            placeholderTextColor={Colors.slate400}
            multiline
            textAlignVertical="top"
            style={styles.noteInput}
          />
          <View style={styles.noteActions}>
            <TouchableOpacity
              disabled={savingAbsenceNote || !absenceNoteText.trim()}
              onPress={saveAbsenceNote}
              style={[styles.noteSave, (savingAbsenceNote || !absenceNoteText.trim()) && styles.noteSaveDisabled]}
            >
              <Text style={styles.noteSaveText}>{savingAbsenceNote ? "جارٍ الحفظ..." : "حفظ الملاحظة"}</Text>
            </TouchableOpacity>
            <TouchableOpacity disabled={savingAbsenceNote} onPress={() => setNoteTarget(null)} style={styles.noteCancel}>
              <Text style={styles.noteCancelText}>إلغاء</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.pageHeader}>
          <View>
            <Text style={styles.eyebrow}>الحضور والغياب</Text>
            <Text style={styles.title}>تقارير الغياب</Text>
            <Text style={styles.subtitle}>راجع جلسات المجموعات وحالات الطلاب الفعلية.</Text>
          </View>
          <View style={styles.headerIcon}><Ionicons name="bar-chart-outline" size={23} color={Colors.primary} /></View>
        </View>
        <View style={styles.monthPicker}>
          <TouchableOpacity onPress={() => {
            if (!month) return;
            monthManuallySelectedRef.current = true;
            setMonth((value) => shiftMonth(value, -1));
          }}><Ionicons name="chevron-forward" size={20} color={Colors.slate600} /></TouchableOpacity>
          <View style={styles.monthCenter}>
            <Text style={styles.monthLabel}>{monthLabel(month)}</Text>
            <Text style={styles.monthHint}>الشهر المحدد</Text>
          </View>
          <TouchableOpacity onPress={() => {
            if (!month) return;
            monthManuallySelectedRef.current = true;
            setMonth((value) => shiftMonth(value, 1));
          }}><Ionicons name="chevron-back" size={20} color={Colors.slate600} /></TouchableOpacity>
        </View>
        {businessMonthWarning ? <Text style={[styles.muted, { color: Colors.dangerText }]}>{businessMonthWarning}</Text> : null}
        {loading ? (
          <View style={styles.loadingBox}><ActivityIndicator color={Colors.primary} /><Text style={styles.muted}>جارٍ تحميل التقارير...</Text></View>
        ) : error ? (
          <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><TouchableOpacity onPress={loadSessions}><Text style={styles.retryText}>إعادة المحاولة</Text></TouchableOpacity></View>
        ) : (
          <>
            <SessionGroupList groups={groupedSessions} onPress={openSession} />
            {!sessions.length ? <EmptyMessage text="لا توجد جلسات في هذا الشهر." /> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "red" | "purple" }) { return <View style={styles.counter}><Text style={[styles.counterValue, tone === "green" && styles.green, tone === "red" && styles.red, tone === "purple" && styles.purple]}>{value}</Text><Text style={styles.counterLabel}>{label}</Text></View>; }

function SessionCard({ item, onPress }: { item: AbsenceSessionSummary; onPress: () => void }) { return <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.sessionCard}><View style={styles.sessionCardTop}><View style={styles.chevron}><Ionicons name="chevron-back" size={19} color={Colors.slate400} /></View><View style={styles.sessionCopy}><Text numberOfLines={1} style={styles.sessionName}>{item.session.groupName || "مجموعة"}</Text><Text numberOfLines={1} style={styles.sessionMeta}>{item.session.subjectName || ""}  •  {item.session.teacherName || "مدرس غير محدد"}</Text><Text style={styles.sessionDate}>{formatDate(item.session.sessionDate)}  •  {formatTimeArabic(item.session.startTime)}</Text></View></View><View style={styles.cardCounters}><Counter label="الكل" value={item.total} tone="blue" /><Counter label="حاضر" value={item.present} tone="green" /><Counter label="غائب" value={item.absent} tone="red" /><Counter label="تعويض" value={item.compensated} tone="purple" /></View></TouchableOpacity>; }

function StudentRow({ student, status, statusTone, note, detailNote, selected = false, selectionMode = false, sendStatus, onToggleSelection, onLongPress, onNotePress, onPress }: { student: Student; status?: string; statusTone?: "green" | "orange"; note?: string; detailNote?: string; selected?: boolean; selectionMode?: boolean; sendStatus?: AbsenceSendStatus; onToggleSelection?: () => void; onLongPress?: () => void; onNotePress?: () => void; onPress: () => void }) {
  const studentColor = getStudentColorPresentation(student.studentColor);
  const sendStatusLabel = sendStatus === "sent"
    ? "تم الإرسال"
    : sendStatus === "partial"
      ? "إرسال جزئي"
    : sendStatus === "failed"
      ? "فشل الإرسال"
      : sendStatus === "queued"
        ? "قيد الإرسال"
        : sendStatus === "no_contact"
          ? "لا توجد وسيلة تواصل صالحة"
          : sendStatus === "not_absent"
            ? "لم يعد غائبًا"
            : null;
  return (
    <View style={[
      styles.studentRow,
      selected && styles.studentRowSelected,
      studentColor.backgroundColor ? { backgroundColor: studentColor.backgroundColor } : null,
    ]}>
      <TouchableOpacity
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={selectionMode ? { selected } : undefined}
        onPress={onPress}
        onLongPress={onLongPress}
        style={styles.studentMain}
      >
        <View style={styles.studentAvatar}><Ionicons name="person-outline" size={18} color={Colors.primary} /></View>
        <View style={styles.studentCopy}>
          <Text style={styles.studentName}>{student.fullName}</Text>
          <Text style={styles.studentCode}>كود الطالب: {student.studentCode || "—"}</Text>
          {detailNote ? <Text style={styles.absenceNotePreview}>{detailNote}</Text> : null}
          {note ? <Text style={styles.absenceNotePreview}>ملاحظة: {note}</Text> : null}
          {sendStatusLabel ? <Text style={[styles.absenceSendStatus, sendStatus === "failed" || sendStatus === "partial" || sendStatus === "no_contact" ? styles.absenceSendStatusError : null]}>{sendStatusLabel}</Text> : null}
        </View>
        {selectionMode ? (
          <View style={[styles.selectionCheck, selected && styles.selectionCheckSelected]}>
            {selected ? <Ionicons name="checkmark" size={17} color={Colors.white} /> : null}
          </View>
        ) : null}
        {status ? <View style={[styles.statusPill, statusTone === "green" ? styles.statusGreen : styles.statusOrange]}><Text style={styles.statusPillText}>{status}</Text></View> : null}
        {!selectionMode ? <Ionicons name="chevron-back" size={17} color={Colors.slate400} /> : null}
      </TouchableOpacity>
      {onNotePress ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={note ? "تعديل ملاحظة الغياب" : "إضافة ملاحظة غياب"}
          onPress={onNotePress}
          style={styles.absenceNoteButton}
        >
          <Ionicons name={note ? "create-outline" : "chatbox-ellipses-outline"} size={17} color={Colors.primary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function CompensationRow({ row, targetSession, onPress }: { row: CompensationReportRow; targetSession: AbsenceSessionReport["session"]; onPress: () => void }) {
  const label = row.kind === "completed" ? "تم التعويض" : row.kind === "advanced" ? "تغطية مسبقة" : "مؤهل للتعويض";
  const source = row.originalSession;
  const note = source
    ? `الأصل: ${source.groupName || "مجموعة"} (${formatDate(source.sessionDate)}) · التعويض: ${targetSession.groupName || "مجموعة"} (${formatDate(targetSession.sessionDate)})`
    : undefined;
  return <StudentRow student={row.student} status={label} statusTone={row.kind === "eligible" ? "orange" : "green"} note={note} onPress={onPress} />;
}

function EmptyMessage({ text }: { text: string }) { return <View style={styles.emptyBox}><Ionicons name="file-tray-outline" size={28} color={Colors.slate400} /><Text style={styles.emptyText}>{text}</Text></View>; }

function TextInputLike({ value, onChangeText, placeholder }: { value: string; onChangeText: (value: string) => void; placeholder: string }) { return <View style={styles.inputHost}><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={Colors.slate400} style={styles.searchInput} /></View>; }

const createStyles = () => StyleSheet.create({
  groupReportHeader: { minHeight: 62, backgroundColor: Colors.white, borderRadius: 15, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  groupReportHeaderCopy: { flex: 1, alignItems: "flex-end" },
  groupReportHint: { color: Colors.slate500, fontSize: 10, marginTop: 3 },
  safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: 16, paddingBottom: 34, gap: 10 }, centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 9, padding: 24, backgroundColor: Colors.background }, pageHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 5 }, detailHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 5 }, headerCopy: { flex: 1, alignItems: "flex-end" }, headerIcon: { width: 45, height: 45, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight }, backButton: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border }, eyebrow: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right" }, title: { color: Colors.slate900, fontSize: 25, fontWeight: "900", marginTop: 2, textAlign: "right" }, subtitle: { color: Colors.slate500, fontSize: 12, marginTop: 3, textAlign: "right" }, monthPicker: { minHeight: 58, borderRadius: 15, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14 }, monthCenter: { alignItems: "center" }, monthLabel: { color: Colors.slate900, fontSize: 16, fontWeight: "800" }, monthHint: { color: Colors.slate500, fontSize: 10, marginTop: 2 }, sessionCard: { backgroundColor: Colors.white, borderRadius: 15, borderWidth: 1, borderColor: Colors.border, padding: 12 }, sessionCardTop: { flexDirection: "row-reverse", gap: 7, alignItems: "flex-start" }, chevron: { width: 25, height: 25, alignItems: "center", justifyContent: "center" }, sessionCopy: { flex: 1, alignItems: "flex-end" }, sessionName: { color: Colors.slate900, fontSize: 15, fontWeight: "800" }, sessionMeta: { color: Colors.slate600, fontSize: 11, marginTop: 2 }, sessionDate: { color: Colors.slate500, fontSize: 10, marginTop: 4 }, cardCounters: { flexDirection: "row-reverse", borderTopWidth: 1, borderTopColor: Colors.slate100, marginTop: 10, paddingTop: 9, justifyContent: "space-between" }, counter: { alignItems: "center", minWidth: 45 }, counterValue: { color: Colors.primary, fontSize: 17, fontWeight: "900" }, counterLabel: { color: Colors.slate500, fontSize: 10, marginTop: 1 }, green: { color: Colors.successText }, red: { color: Colors.dangerText }, purple: { color: "#7C3AED" }, sessionInfo: { backgroundColor: Colors.white, borderRadius: 15, borderWidth: 1, borderColor: Colors.border, padding: 12 }, sessionInfoLine: { color: Colors.slate600, fontSize: 12, textAlign: "right" }, counterRow: { flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 10 }, tabRow: { flexDirection: "row-reverse", backgroundColor: Colors.white, borderRadius: 13, padding: 4, borderWidth: 1, borderColor: Colors.border }, tab: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 10 }, tabActive: { backgroundColor: Colors.primary }, tabText: { color: Colors.slate600, fontSize: 11, fontWeight: "800" }, tabTextActive: { color: Colors.white }, searchWrap: { minHeight: 44, borderRadius: 11, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingHorizontal: 11 }, inputHost: { flex: 1 }, searchInput: { color: Colors.slate800, fontSize: 13, textAlign: "right", minHeight: 40 }, actionRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginTop: 2 }, sectionTitle: { color: Colors.slate900, fontSize: 16, fontWeight: "800", textAlign: "right" }, sendButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, paddingHorizontal: 11, minHeight: 34, borderRadius: 9, backgroundColor: Colors.primary }, sendButtonText: { color: Colors.white, fontSize: 11, fontWeight: "800" },
  reportExtraTabs: { flexDirection: "row-reverse", gap: 6 },
  reportExtraTab: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", paddingHorizontal: 7, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white },
  absentActions: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 },
  selectAllButton: { minHeight: 34, justifyContent: "center", paddingHorizontal: 9, borderRadius: 9, borderWidth: 1, borderColor: Colors.primaryLight, backgroundColor: Colors.white },
  selectAllText: { color: Colors.primary, fontSize: 10, fontWeight: "800" },
  studentRow: { backgroundColor: Colors.white, borderRadius: 13, borderWidth: 1, borderColor: Colors.border, padding: 8, flexDirection: "row-reverse", alignItems: "center", gap: 7 },
  studentRowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  studentMain: { flex: 1, minWidth: 0, flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  studentAvatar: { width: 34, height: 34, borderRadius: 11, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" }, studentCopy: { flex: 1, minWidth: 0, alignItems: "flex-end" }, studentName: { color: Colors.slate900, fontSize: 13, fontWeight: "800", textAlign: "right" }, studentCode: { color: Colors.slate500, fontSize: 10, marginTop: 3, textAlign: "right" }, absenceNotePreview: { color: Colors.primaryDark, fontSize: 10, marginTop: 4, textAlign: "right" }, absenceNoteButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.primaryMuted, alignItems: "center", justifyContent: "center" }, statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 }, statusGreen: { backgroundColor: Colors.successLight }, statusOrange: { backgroundColor: Colors.warningLight }, statusPillText: { color: Colors.slate700, fontSize: 10, fontWeight: "800" },
  selectionToolbar: { flexDirection: "row-reverse", alignItems: "center", flexWrap: "wrap", gap: 7, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: Colors.primaryLight, backgroundColor: Colors.white },
  selectionToolbarCopy: { flex: 1, minWidth: 100, alignItems: "flex-end" },
  selectionCount: { color: Colors.slate900, fontSize: 12, fontWeight: "900", textAlign: "right" },
  selectionHint: { color: Colors.slate500, fontSize: 10, marginTop: 3, textAlign: "right" },
  sendSelectedButton: { minHeight: 36, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 10, borderRadius: 9, backgroundColor: Colors.primary },
  disabledButton: { opacity: 0.5 },
  cancelSelectionButton: { minHeight: 36, justifyContent: "center", paddingHorizontal: 9, borderRadius: 9, borderWidth: 1, borderColor: Colors.border },
  cancelSelectionText: { color: Colors.slate600, fontSize: 11, fontWeight: "700" },
  selectionCheck: { width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: Colors.slate400, alignItems: "center", justifyContent: "center" },
  selectionCheckSelected: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  absenceSendStatus: { color: Colors.successText, fontSize: 10, marginTop: 4, textAlign: "right" },
  absenceSendStatusError: { color: Colors.dangerText },
  modalOverlay: { flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(15, 23, 42, 0.45)" },
  noteModal: { padding: 18, borderRadius: 16, backgroundColor: Colors.white },
  noteModalTitle: { color: Colors.slate900, fontSize: 17, fontWeight: "900", textAlign: "right" },
  noteModalHint: { color: Colors.slate500, fontSize: 11, marginTop: 5, textAlign: "right" },
  noteInput: { minHeight: 112, marginTop: 14, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, color: Colors.slate800, fontSize: 13, textAlign: "right" },
  noteActions: { flexDirection: "row-reverse", gap: 8, marginTop: 13 },
  noteSave: { flex: 1, minHeight: 42, borderRadius: 10, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  noteSaveDisabled: { opacity: 0.55 },
  noteSaveText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
  noteCancel: { minWidth: 75, minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  noteCancelText: { color: Colors.slate600, fontSize: 12, fontWeight: "700" },
  loadingBox: { alignItems: "center", gap: 8, paddingVertical: 45 }, errorBox: { backgroundColor: Colors.dangerLight, borderColor: Colors.danger, borderWidth: 1, borderRadius: 12, padding: 14, gap: 8, alignItems: "center" }, errorText: { color: Colors.dangerText, fontSize: 12, textAlign: "center" }, retryText: { color: Colors.primary, fontWeight: "800" }, emptyBox: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 42 }, emptyTitle: { color: Colors.slate800, fontSize: 16, fontWeight: "800", textAlign: "center" }, emptyText: { color: Colors.slate500, fontSize: 12, textAlign: "center" }, muted: { color: Colors.slate500, fontSize: 12, textAlign: "center" }, groupReport: { gap: 7, marginBottom: 8 }, groupReportTitle: { color: Colors.slate900, fontSize: 15, fontWeight: "900", textAlign: "right", paddingHorizontal: 4 }, sessionNumber: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right", marginTop: 2 },
});
let styles = createStyles();
