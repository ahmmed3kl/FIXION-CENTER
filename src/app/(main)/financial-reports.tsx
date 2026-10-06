import { Ionicons } from "@expo/vector-icons";
import { useMemo, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { formatCurrency, formatTimeArabic } from "../../core/localization";
import { DatabaseService } from "../../core/database";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { EnrollmentRepository } from "../../features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { StudentRepository } from "../../features/students/StudentRepository";
import { getLocalDateOnly } from "../../shared/utils/date";
import { captureLoad } from "../../shared/utils/loadResult";

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
type Teacher = { id: string; name: string };
type Group = { id: string; name: string; teacherId: string; teacherName?: string; subjectName?: string; grade?: string };
type Row = { id: string; name: string; debt: number; paid: number; due: number; package: boolean; packageAmount: number; packageName?: string };

export default function FinancialReportsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { activeCenterId } = useAuthStore();
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [teacherId, setTeacherId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [schedules, setSchedules] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  const loadRows = () => {
    if (!activeCenterId || !groupId) { setRows([]); setLoadError(""); return; }
    setLoading(true);
    setLoadError("");
    setRows([]);
    const result = captureLoad(() => {
      const today = getLocalDateOnly();
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(groupId, today);
      const db = DatabaseService.getDb();
      const result: Row[] = [];
      // A package student may not have a regular group enrollment row. Add
      // package-selected students to the same report candidate set.
      const packageCandidates = db.getAllSync<any>(
        `SELECT DISTINCT sps.student_id as studentId
         FROM student_package_subscriptions sps
         JOIN package_subjects ps ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
         LEFT JOIN package_subject_teacher_overrides selected
           ON selected.center_id = sps.center_id AND selected.subscription_id = sps.id AND selected.subject_id = ps.subject_id
         WHERE sps.center_id = ? AND sps.status = 'active'
           AND ps.subject_id = (SELECT subject_id FROM groups WHERE center_id = ? AND id = ?)
           AND (ps.group_id IS NULL OR ps.group_id = ?)
           AND COALESCE(selected.teacher_id, ps.default_teacher_id) = (SELECT teacher_id FROM groups WHERE center_id = ? AND id = ?)
           AND (selected.id IS NULL OR selected.group_id IS NULL OR selected.group_id = ?)
           AND (selected.id IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM package_subject_teacher_overrides any_selection
             WHERE any_selection.center_id = sps.center_id AND any_selection.subscription_id = sps.id
           ))`,
        [activeCenterId, activeCenterId, groupId, groupId, activeCenterId, groupId, groupId],
      );
      const studentIds = new Set<string>([
        ...enrollments.map((enrollment) => String(enrollment.studentId)),
        ...packageCandidates.map((item) => String(item.studentId)),
      ]);
      for (const studentId of studentIds) {
        const student = StudentRepository.findById(studentId);
        if (!student) continue;
        const status = FinancialCalculationService.getStudentFinancialStatus(student.id, today);
        const regular = status.cycles.filter((cycle) => cycle.cycleType !== "package" && cycle.groupId === groupId);
        const packageSubscriptions = db.getAllSync<any>(
          `SELECT DISTINCT sps.id as id, p.name as packageName
           FROM student_package_subscriptions sps
           JOIN packages p ON p.center_id = sps.center_id AND p.id = sps.package_id
           JOIN package_subjects ps ON ps.center_id = sps.center_id AND ps.package_id = sps.package_id
           LEFT JOIN package_subject_teacher_overrides selected
             ON selected.center_id = sps.center_id AND selected.subscription_id = sps.id AND selected.subject_id = ps.subject_id
           WHERE sps.center_id = ? AND sps.student_id = ? AND sps.status = 'active'
             AND ps.subject_id = (SELECT subject_id FROM groups WHERE center_id = ? AND id = ?)
             AND (ps.group_id IS NULL OR ps.group_id = ?)
             AND COALESCE(selected.teacher_id, ps.default_teacher_id) = (SELECT teacher_id FROM groups WHERE center_id = ? AND id = ?)
             AND (selected.id IS NULL OR selected.group_id IS NULL OR selected.group_id = ?)
             AND (selected.id IS NOT NULL OR NOT EXISTS (
               SELECT 1 FROM package_subject_teacher_overrides any_selection
               WHERE any_selection.center_id = sps.center_id AND any_selection.subscription_id = sps.id
             ))`,
          [activeCenterId, student.id, activeCenterId, groupId, groupId, activeCenterId, groupId, groupId],
        );
        const packageIds = new Set(packageSubscriptions.map((item) => String(item.id)));
        const packages = status.cycles.filter((cycle) => cycle.cycleType === "package" && cycle.packageSubscriptionId && packageIds.has(String(cycle.packageSubscriptionId)));
        const due = regular.reduce((sum, cycle) => sum + Number(cycle.effectivePrice ?? cycle.cyclePrice ?? 0), 0);
        const paid = regular.reduce((sum, cycle) => sum + Number(cycle.paidAmount ?? cycle.totalPaid ?? 0), 0);
        const packageDue = packages.reduce((sum, cycle) => sum + Number(cycle.effectivePrice ?? cycle.cyclePrice ?? 0), 0);
        const packagePaid = packages.reduce((sum, cycle) => sum + Number(cycle.paidAmount ?? cycle.totalPaid ?? 0), 0);
        result.push({
          id: student.id,
          name: student.fullName,
          due: due + packageDue,
          paid: paid + packagePaid,
          debt: Math.max(0, due - paid + packageDue - packagePaid),
          package: packages.length > 0,
          packageAmount: packageDue,
          packageName: packageSubscriptions[0]?.packageName,
        });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name, "ar"));
    }, "تعذر تحميل التقرير المالي.");
    if (result.status === "success") {
      setRows(result.value);
      setLoadError("");
    } else {
      console.warn("Financial report load error:", result.message);
      setRows([]);
      setLoadError(result.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!activeCenterId) return;
    try {
      const list = TeacherRepository.getAll().map((teacher) => ({ id: teacher.id, name: teacher.name }));
      setTeachers(list);
      if (!teacherId && list[0]) setTeacherId(list[0].id);
    } catch { setTeachers([]); }
  }, [activeCenterId]);

  useEffect(() => {
    try {
      const list = GroupRepository.getAll().filter((group) => !teacherId || group.teacherId === teacherId) as Group[];
      setGroups(list);
      const next = list.some((group) => group.id === groupId) ? groupId : (list[0]?.id || "");
      setGroupId(next);
    } catch { setGroups([]); setGroupId(""); }
  }, [teacherId, activeCenterId]);

  useEffect(() => {
    if (!groupId) { setSchedules([]); setRows([]); return; }
    try { setSchedules(GroupScheduleRepository.getSchedulesForGroup(groupId)); } catch { setSchedules([]); }
    loadRows();
  }, [groupId, activeCenterId, retryCount]);

  const group = groups.find((item) => item.id === groupId);
  const normalizedSearch = search.trim().toLocaleLowerCase("ar-EG");
  const visibleRows = normalizedSearch
    ? rows.filter((row) => [row.name, row.packageName || "", row.package ? "باقة" : "", String(row.debt), String(row.due)].join(" ").toLocaleLowerCase("ar-EG").includes(normalizedSearch))
    : rows;
  const totals = visibleRows.reduce((acc, row) => ({ due: acc.due + row.due, paid: acc.paid + row.paid, debt: acc.debt + row.debt }), { due: 0, paid: 0, debt: 0 });

  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>التقارير المالية</Text><Text style={styles.title}>مديونية المجموعات</Text><Text style={styles.subtitle}>الرصيد الفعلي لكل طالب حسب المدرس والمجموعة</Text></View><View style={styles.headerIcon}><Ionicons name="wallet-outline" size={26} color={colors.primary} /></View></View>
      <Text style={styles.label}>المدرس</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>{teachers.map((teacher) => <TouchableOpacity key={teacher.id} onPress={() => setTeacherId(teacher.id)} style={[styles.choice, teacherId === teacher.id && styles.choiceActive]}><Text style={[styles.choiceText, teacherId === teacher.id && styles.choiceTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView>
      <Text style={styles.label}>المجموعة</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>{groups.map((item) => <TouchableOpacity key={item.id} onPress={() => setGroupId(item.id)} style={[styles.choice, groupId === item.id && styles.choiceActive]}><Text style={[styles.choiceText, groupId === item.id && styles.choiceTextActive]}>{item.name}</Text><Text style={styles.choiceMeta}>{item.subjectName || ""}</Text></TouchableOpacity>)}</ScrollView>
      {group && <View style={styles.scheduleCard}><Text style={styles.groupTitle}>{group.name}</Text><Text style={styles.groupMeta}>{group.subjectName || ""} {group.grade ? `· ${group.grade}` : ""}</Text><View style={styles.scheduleWrap}>{schedules.length ? schedules.map((schedule) => <View key={schedule.id} style={styles.schedulePill}><Ionicons name="calendar-outline" size={15} color={colors.primary} /><Text style={styles.scheduleText}>{DAYS[schedule.dayOfWeek] || "اليوم"} · {formatTimeArabic(schedule.startTime)} - {formatTimeArabic(schedule.endTime)}</Text></View>) : <Text style={styles.emptyText}>لا توجد مواعيد مسجلة</Text>}</View></View>}
      {groupId ? <View style={styles.searchBox}><Ionicons name="search-outline" size={19} color={colors.slate400} /><TextInput value={search} onChangeText={setSearch} placeholder="ابحث باسم الطالب أو الباقة أو المديونية" placeholderTextColor={colors.textSecondary} style={styles.searchInput} textAlign="right" returnKeyType="search" /></View> : null}
      {!loading && !loadError && <View style={styles.summaryRow}><Metric label="المستحق" value={totals.due} color={colors.primary} labelColor={colors.textSecondary} /><Metric label="المدفوع" value={totals.paid} color={colors.successText} labelColor={colors.textSecondary} /><Metric label="المديونية" value={totals.debt} color={colors.dangerText} labelColor={colors.textSecondary} /></View>}
      {loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.emptyText}>جاري حساب المديونية...</Text></View> : loadError ? <View style={styles.emptyCard}><Ionicons name="alert-circle-outline" size={32} color={colors.dangerText} /><Text accessibilityRole="alert" style={styles.emptyTitle}>تعذر تحميل التقرير</Text><Text style={styles.emptyText}>{loadError}</Text><TouchableOpacity onPress={() => setRetryCount((count) => count + 1)}><Text style={{ color: colors.primary, fontWeight: "800" }}>إعادة المحاولة</Text></TouchableOpacity></View> : visibleRows.length ? visibleRows.map((row) => <View key={row.id} style={styles.studentCard}><View style={styles.studentTop}><View style={styles.avatar}><Text style={styles.avatarText}>{row.name.trim().charAt(0) || "ط"}</Text></View><View style={styles.studentCopy}><Text style={styles.studentName}>{row.name}</Text>{row.package && <View style={styles.packageBadge}><Ionicons name="pricetag-outline" size={13} color={colors.primary} /><Text style={styles.packageText}>طالب باقة{row.packageName ? ` · ${row.packageName}` : ""}</Text></View>}</View><Text style={[styles.debtValue, { color: row.debt > 0 ? colors.dangerText : colors.successText }]}>{formatCurrency(row.debt)}</Text></View><View style={styles.studentMeta}><Text>المستحق: {formatCurrency(row.due)}</Text><Text>المدفوع: {formatCurrency(row.paid)}</Text>{row.package && <Text>من سعر الباقة: {formatCurrency(row.packageAmount)}</Text>}</View></View>) : <View style={styles.emptyCard}><Ionicons name={search ? "search-outline" : "people-outline"} size={32} color={colors.slate400} /><Text style={styles.emptyTitle}>{search ? "لا توجد نتائج" : "اختر مدرسًا ومجموعة"}</Text><Text style={styles.emptyText}>{search ? "جرّب اسمًا أو كلمة بحث مختلفة." : "ستظهر هنا مديونية الطلاب الفعلية ومواعيد المجموعة."}</Text></View>}
    </ScrollView>
  </SafeAreaView>;
}

function Metric({ label, value, color, labelColor }: { label: string; value: number; color: string; labelColor: string }) { return <View style={stylesMetric.box}><Text style={[stylesMetric.value, { color }]}>{formatCurrency(value)}</Text><Text style={[stylesMetric.label, { color: labelColor }]}>{label}</Text></View>; }
const stylesMetric = StyleSheet.create({ box: { flex: 1, alignItems: "center", paddingVertical: 12 }, value: { fontSize: 15, fontWeight: "900" }, label: { marginTop: 3, fontSize: 11, fontWeight: "700" } });
const createStyles = (colors: any) => StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.background }, content: { padding: Spacing.lg, paddingBottom: 40, gap: 10 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }, eyebrow: { color: colors.primary, fontSize: 13, fontWeight: "900", textAlign: "right" }, title: { ...Typography.h1, color: colors.textPrimary, textAlign: "right", marginTop: 3 }, subtitle: { color: colors.textSecondary, fontSize: 12, textAlign: "right", marginTop: 4 }, headerIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center" }, label: { color: colors.textPrimary, fontSize: 14, fontWeight: "900", textAlign: "right", marginTop: 4 }, choiceRow: { gap: 8, paddingVertical: 2 }, choice: { minWidth: 92, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border }, choiceActive: { backgroundColor: colors.primary, borderColor: colors.primary }, choiceText: { color: colors.textPrimary, fontSize: 13, fontWeight: "800", textAlign: "center" }, choiceTextActive: { color: colors.white }, choiceMeta: { color: colors.textSecondary, fontSize: 10, textAlign: "center", marginTop: 2 }, scheduleCard: { backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 14, marginTop: 5 }, groupTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: "900", textAlign: "right" }, groupMeta: { color: colors.textSecondary, fontSize: 12, textAlign: "right", marginTop: 3 }, scheduleWrap: { gap: 7, marginTop: 10 }, schedulePill: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: colors.primaryLight, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 }, scheduleText: { color: colors.primary, fontSize: 12, fontWeight: "800" }, searchBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 15, minHeight: 48, paddingHorizontal: 12, marginTop: 2 }, searchInput: { flex: 1, color: colors.textPrimary, fontSize: 14, paddingVertical: 8 }, summaryRow: { flexDirection: "row", backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 17, marginTop: 2 }, studentCard: { backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 17, padding: 14, marginTop: 1 }, studentTop: { flexDirection: "row", alignItems: "center", gap: 10 }, avatar: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center" }, avatarText: { color: colors.primary, fontSize: 18, fontWeight: "900" }, studentCopy: { flex: 1 }, studentName: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" }, packageBadge: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end", marginTop: 5 }, packageText: { color: colors.primary, fontSize: 11, fontWeight: "800" }, debtValue: { fontSize: 15, fontWeight: "900" }, studentMeta: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border, color: colors.textSecondary }, emptyCard: { alignItems: "center", backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 28, marginTop: 4 }, emptyTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "900", marginTop: 8 }, emptyText: { color: colors.textSecondary, fontSize: 12, textAlign: "center", marginTop: 5 }, loading: { alignItems: "center", padding: 24, gap: 8 } });
