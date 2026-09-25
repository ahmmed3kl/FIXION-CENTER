import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { Colors, Spacing } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { AbsenceReportsService, AbsenceSessionReport, AbsenceSessionSummary, CompensationReportRow } from "../../features/attendance/AbsenceReportsService";
import { NotificationService } from "../../features/notifications/NotificationService";
import { smartSearch } from "../../shared/utils/smartSearch";
import { Attendance, Student } from "../../shared/types";
import { formatLocalDate } from "../../shared/utils/date";

const MONTH_NAMES = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
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
  const services = useServiceVisibility();
  const currentUser = useAuthStore((state) => state.currentUser);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [sessions, setSessions] = useState<AbsenceSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [report, setReport] = useState<AbsenceSessionReport | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"absent" | "present" | "compensation">("absent");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, { name: string; items: AbsenceSessionSummary[] }>();
    sessions.forEach((item) => {
      const key = item.session.groupId;
      const current = groups.get(key) || { name: item.session.groupName || "مجموعة", items: [] };
      current.items.push(item);
      groups.set(key, current);
    });
    return Array.from(groups.values());
  }, [sessions]);

  const canView = PermissionService.hasAnyPermission(currentUser?.permissions || [], ["attendance.view", "reports.attendance.view", "reports.view"]);
  const loadSessions = useCallback(() => {
    setLoading(true);
    setError("");
    try {
      setSessions(AbsenceReportsService.getSessionsForMonth(month));
    } catch (err: any) {
      setSessions([]);
      setError(err?.message || "تعذر تحميل جلسات الشهر.");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { if (services.loaded && canView) loadSessions(); }, [canView, loadSessions, services.loaded]);

  const openSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setReport(null);
    setSearch("");
    setTab("absent");
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

  const sendAll = async () => {
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
      const events = NotificationService.notifyAbsentees({ sessionId: selectedSessionId, selectedStudentIds: report.absent.map((student) => student.id) });
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

  if (!services.loaded || services.loading) return <View style={styles.centered}><ActivityIndicator color={Colors.primary} /><Text style={styles.muted}>جارٍ تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("reports")) return <View style={styles.centered}><Ionicons name="lock-closed-outline" size={34} color={Colors.slate400} /><Text style={styles.emptyTitle}>تقارير الغياب غير مفعلة</Text><Text style={styles.muted}>فعّل خدمة التقارير لهذا المركز من إدارة المنصة.</Text></View>;
  if (!canView) return <View style={styles.centered}><Ionicons name="shield-outline" size={34} color={Colors.slate400} /><Text style={styles.emptyTitle}>ليس لديك صلاحية عرض الحضور والغياب</Text></View>;

  if (selectedSessionId && report) {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.detailHeader}><TouchableOpacity onPress={() => { setSelectedSessionId(null); setReport(null); }} style={styles.backButton}><Ionicons name="chevron-forward" size={23} color={Colors.slate800} /></TouchableOpacity><View style={styles.headerCopy}><Text style={styles.eyebrow}>تفاصيل الحصة</Text><Text style={styles.title}>{report.session.groupName || "مجموعة"}</Text><Text style={styles.subtitle}>{report.session.subjectName || ""}  •  {report.session.teacherName || "مدرس غير محدد"}</Text></View><View style={styles.headerIcon}><Ionicons name="calendar-outline" size={22} color={Colors.primary} /></View></View>
      <View style={styles.sessionInfo}><Text style={styles.sessionInfoLine}>{formatDate(report.session.sessionDate)}  •  {formatTimeArabic(report.session.startTime)} - {formatTimeArabic(report.session.endTime)}</Text><View style={styles.counterRow}><Counter label="الكل" value={report.expected.length} tone="blue" /><Counter label="حاضر" value={report.present.length} tone="green" /><Counter label="غائب" value={report.absent.length} tone="red" /><Counter label="تعويض" value={report.compensated} tone="purple" /></View></View>
      <View style={styles.tabRow}>{[["absent", "الغائبين", report.absent.length], ["present", "الحاضرين", report.present.length], ["compensation", "تعويض", report.compensation.length]].map(([key, label, count]) => <TouchableOpacity key={String(key)} onPress={() => setTab(key as typeof tab)} style={[styles.tab, tab === key && styles.tabActive]}><Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label} ({count})</Text></TouchableOpacity>)}</View>
      <View style={styles.searchWrap}><Ionicons name="search-outline" size={18} color={Colors.slate400} /><TextInputLike value={search} onChangeText={setSearch} placeholder="ابحث باسم الطالب أو الكود" /></View>
      {tab === "absent" ? <><View style={styles.actionRow}><Text style={styles.sectionTitle}>الطلاب الغائبون</Text><TouchableOpacity style={styles.sendButton} onPress={sendAll}><Ionicons name="send-outline" size={15} color="#FFF" /><Text style={styles.sendButtonText}>إرسال للكل</Text></TouchableOpacity></View>{filteredAbsent.map((student) => <StudentRow key={student.id} student={student} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: student.id } } as any)} />)}{!filteredAbsent.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : "لا يوجد غياب مسجل لهذه الحصة."} /> : null}</> : null}
      {tab === "present" ? <>{filteredPresent.map(({ student, attendance }) => <StudentRow key={student.id} student={student} status={attendanceLabel(attendance)} statusTone={attendance.status === "late" ? "orange" : "green"} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: student.id } } as any)} />)}{!filteredPresent.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : "لا يوجد حضور مسجل لهذه الحصة."} /> : null}</> : null}
      {tab === "compensation" ? <>{filteredCompensation.map((row) => <CompensationRow key={`${row.student.id}-${row.kind}-${row.attendance?.id || row.opportunity?.nextEligibleSessionId || "advance"}`} row={row} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: row.student.id } } as any)} />)}{!filteredCompensation.length ? <EmptyMessage text={search ? "لا توجد نتائج مطابقة." : "لا توجد بيانات تعويض لهذه الحصة."} /> : null}</> : null}
    </ScrollView></SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}><View style={styles.pageHeader}><View><Text style={styles.eyebrow}>الحضور والغياب</Text><Text style={styles.title}>تقارير الغياب</Text><Text style={styles.subtitle}>راجع جلسات المجموعات وحالات الطلاب الفعلية.</Text></View><View style={styles.headerIcon}><Ionicons name="bar-chart-outline" size={23} color={Colors.primary} /></View></View><View style={styles.monthPicker}><TouchableOpacity onPress={() => setMonth((value) => shiftMonth(value, -1))}><Ionicons name="chevron-forward" size={20} color={Colors.slate600} /></TouchableOpacity><View style={styles.monthCenter}><Text style={styles.monthLabel}>{monthLabel(month)}</Text><Text style={styles.monthHint}>الشهر المحدد</Text></View><TouchableOpacity onPress={() => setMonth((value) => shiftMonth(value, 1))}><Ionicons name="chevron-back" size={20} color={Colors.slate600} /></TouchableOpacity></View>{loading ? <View style={styles.loadingBox}><ActivityIndicator color={Colors.primary} /><Text style={styles.muted}>جارٍ تحميل الجلسات...</Text></View> : error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><TouchableOpacity onPress={loadSessions}><Text style={styles.retryText}>إعادة المحاولة</Text></TouchableOpacity></View> : groupedSessions.map((group) => <View key={group.name} style={styles.groupReport}><Text style={styles.groupReportTitle}>{group.name} · {group.items.length} حصة</Text>{group.items.map((item) => <View key={item.session.id}><Text style={styles.sessionNumber}>الحصة رقم {item.sessionNumber}</Text><SessionCard item={item} onPress={() => openSession(item.session.id)} /></View>)}</View>)}{!loading && !error && !sessions.length ? <EmptyMessage text="لا توجد جلسات في هذا الشهر." /> : null}</ScrollView></SafeAreaView>;
}

function Counter({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "red" | "purple" }) { return <View style={styles.counter}><Text style={[styles.counterValue, tone === "green" && styles.green, tone === "red" && styles.red, tone === "purple" && styles.purple]}>{value}</Text><Text style={styles.counterLabel}>{label}</Text></View>; }

function SessionCard({ item, onPress }: { item: AbsenceSessionSummary; onPress: () => void }) { return <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.sessionCard}><View style={styles.sessionCardTop}><View style={styles.chevron}><Ionicons name="chevron-back" size={19} color={Colors.slate400} /></View><View style={styles.sessionCopy}><Text numberOfLines={1} style={styles.sessionName}>{item.session.groupName || "مجموعة"}</Text><Text numberOfLines={1} style={styles.sessionMeta}>{item.session.subjectName || ""}  •  {item.session.teacherName || "مدرس غير محدد"}</Text><Text style={styles.sessionDate}>{formatDate(item.session.sessionDate)}  •  {formatTimeArabic(item.session.startTime)}</Text></View></View><View style={styles.cardCounters}><Counter label="الكل" value={item.total} tone="blue" /><Counter label="حاضر" value={item.present} tone="green" /><Counter label="غائب" value={item.absent} tone="red" /><Counter label="تعويض" value={item.compensated} tone="purple" /></View></TouchableOpacity>; }

function StudentRow({ student, status, statusTone, onPress }: { student: Student; status?: string; statusTone?: "green" | "orange"; onPress: () => void }) { return <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.studentRow}><View style={styles.studentAvatar}><Ionicons name="person-outline" size={18} color={Colors.primary} /></View><View style={styles.studentCopy}><Text style={styles.studentName}>{student.fullName}</Text><Text style={styles.studentCode}>كود الطالب: {student.studentCode || "—"}</Text></View>{status ? <View style={[styles.statusPill, statusTone === "green" ? styles.statusGreen : styles.statusOrange]}><Text style={styles.statusPillText}>{status}</Text></View> : null}<Ionicons name="chevron-back" size={17} color={Colors.slate400} /></TouchableOpacity>; }

function CompensationRow({ row, onPress }: { row: CompensationReportRow; onPress: () => void }) { const label = row.kind === "completed" ? "تم التعويض" : row.kind === "advanced" ? "تغطية مسبقة" : "مؤهل للتعويض"; return <StudentRow student={row.student} status={label} statusTone={row.kind === "eligible" ? "orange" : "green"} onPress={onPress} />; }

function EmptyMessage({ text }: { text: string }) { return <View style={styles.emptyBox}><Ionicons name="file-tray-outline" size={28} color={Colors.slate400} /><Text style={styles.emptyText}>{text}</Text></View>; }

function TextInputLike({ value, onChangeText, placeholder }: { value: string; onChangeText: (value: string) => void; placeholder: string }) { return <View style={styles.inputHost}><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={Colors.slate400} style={styles.searchInput} /></View>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: 16, paddingBottom: 34, gap: 10 }, centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 9, padding: 24, backgroundColor: Colors.background }, pageHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 5 }, detailHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 5 }, headerCopy: { flex: 1, alignItems: "flex-end" }, headerIcon: { width: 45, height: 45, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight }, backButton: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border }, eyebrow: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right" }, title: { color: Colors.slate900, fontSize: 25, fontWeight: "900", marginTop: 2, textAlign: "right" }, subtitle: { color: Colors.slate500, fontSize: 12, marginTop: 3, textAlign: "right" }, monthPicker: { minHeight: 58, borderRadius: 15, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14 }, monthCenter: { alignItems: "center" }, monthLabel: { color: Colors.slate900, fontSize: 16, fontWeight: "800" }, monthHint: { color: Colors.slate500, fontSize: 10, marginTop: 2 }, sessionCard: { backgroundColor: Colors.white, borderRadius: 15, borderWidth: 1, borderColor: Colors.border, padding: 12 }, sessionCardTop: { flexDirection: "row-reverse", gap: 7, alignItems: "flex-start" }, chevron: { width: 25, height: 25, alignItems: "center", justifyContent: "center" }, sessionCopy: { flex: 1, alignItems: "flex-end" }, sessionName: { color: Colors.slate900, fontSize: 15, fontWeight: "800" }, sessionMeta: { color: Colors.slate600, fontSize: 11, marginTop: 2 }, sessionDate: { color: Colors.slate500, fontSize: 10, marginTop: 4 }, cardCounters: { flexDirection: "row-reverse", borderTopWidth: 1, borderTopColor: Colors.slate100, marginTop: 10, paddingTop: 9, justifyContent: "space-between" }, counter: { alignItems: "center", minWidth: 45 }, counterValue: { color: Colors.primary, fontSize: 17, fontWeight: "900" }, counterLabel: { color: Colors.slate500, fontSize: 10, marginTop: 1 }, green: { color: Colors.successText }, red: { color: Colors.dangerText }, purple: { color: "#7C3AED" }, sessionInfo: { backgroundColor: Colors.white, borderRadius: 15, borderWidth: 1, borderColor: Colors.border, padding: 12 }, sessionInfoLine: { color: Colors.slate600, fontSize: 12, textAlign: "right" }, counterRow: { flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 10 }, tabRow: { flexDirection: "row-reverse", backgroundColor: Colors.white, borderRadius: 13, padding: 4, borderWidth: 1, borderColor: Colors.border }, tab: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 10 }, tabActive: { backgroundColor: Colors.primary }, tabText: { color: Colors.slate600, fontSize: 11, fontWeight: "800" }, tabTextActive: { color: Colors.white }, searchWrap: { minHeight: 44, borderRadius: 11, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingHorizontal: 11 }, inputHost: { flex: 1 }, searchInput: { color: Colors.slate800, fontSize: 13, textAlign: "right", minHeight: 40 }, actionRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginTop: 2 }, sectionTitle: { color: Colors.slate900, fontSize: 16, fontWeight: "800", textAlign: "right" }, sendButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, paddingHorizontal: 11, minHeight: 34, borderRadius: 9, backgroundColor: Colors.primary }, sendButtonText: { color: Colors.white, fontSize: 11, fontWeight: "800" }, studentRow: { backgroundColor: Colors.white, borderRadius: 13, borderWidth: 1, borderColor: Colors.border, padding: 11, flexDirection: "row-reverse", alignItems: "center", gap: 9 }, studentAvatar: { width: 34, height: 34, borderRadius: 11, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" }, studentCopy: { flex: 1, alignItems: "flex-end" }, studentName: { color: Colors.slate900, fontSize: 13, fontWeight: "800" }, studentCode: { color: Colors.slate500, fontSize: 10, marginTop: 3 }, statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 }, statusGreen: { backgroundColor: Colors.successLight }, statusOrange: { backgroundColor: Colors.warningLight }, statusPillText: { color: Colors.slate700, fontSize: 10, fontWeight: "800" }, loadingBox: { alignItems: "center", gap: 8, paddingVertical: 45 }, errorBox: { backgroundColor: Colors.dangerLight, borderColor: Colors.danger, borderWidth: 1, borderRadius: 12, padding: 14, gap: 8, alignItems: "center" }, errorText: { color: Colors.dangerText, fontSize: 12, textAlign: "center" }, retryText: { color: Colors.primary, fontWeight: "800" }, emptyBox: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 42 }, emptyTitle: { color: Colors.slate800, fontSize: 16, fontWeight: "800", textAlign: "center" }, emptyText: { color: Colors.slate500, fontSize: 12, textAlign: "center" }, muted: { color: Colors.slate500, fontSize: 12, textAlign: "center" }, groupReport: { gap: 7, marginBottom: 8 }, groupReportTitle: { color: Colors.slate900, fontSize: 15, fontWeight: "900", textAlign: "right", paddingHorizontal: 4 }, sessionNumber: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right", marginTop: 2 },
});
