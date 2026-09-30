import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { DatabaseService } from "../../core/database";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { AppButton, AppCard, AppInput, EmptyState } from "../../shared/components";
import { OpeningBalanceService } from "../../features/payments/OpeningBalanceService";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { smartSearch } from "../../shared/utils/smartSearch";

type Target = { id: string; label: string; kind: "group" | "package"; cycleType: "monthly" | "package"; enrollmentId?: string; packageSubscriptionId?: string; packageId?: string; groupId?: string; startDate?: string; endDate?: string };

const addMonth = (value: string) => {
  const date = new Date(`${value}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  date.setDate(date.getDate() - 1);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value;
};

export default function OpeningBalanceScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { activeCenterId, currentUser } = useAuthStore();
  const [students, setStudents] = useState<any[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<any | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<Target | null>(null);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => addMonth(new Date().toISOString().slice(0, 10)));
  const [amountDue, setAmountDue] = useState("");
  const [amountPaid, setAmountPaid] = useState("0");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStudents = useCallback(() => {
    if (!activeCenterId) return;
    const db = DatabaseService.getDb();
    setStudents(db.getAllSync<any>(`SELECT id, full_name as fullName, student_code as studentCode, card_code as cardCode, grade FROM students WHERE center_id = ? AND status = 'active' ORDER BY full_name`, [activeCenterId]));
  }, [activeCenterId]);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  const selectStudent = (student: any) => {
    const db = DatabaseService.getDb();
    const groupRows = db.getAllSync<any>(`SELECT e.id, e.group_id as groupId, g.name as groupName, e.start_date as startDate, e.end_date as endDate FROM student_group_enrollments e JOIN groups g ON g.id = e.group_id AND g.center_id = e.center_id WHERE e.center_id = ? AND e.student_id = ? AND e.status = 'active' ORDER BY g.name`, [activeCenterId, student.id]);
    const packageRows = db.getAllSync<any>(`SELECT s.id, s.package_id as packageId, p.name as packageName, s.start_date as startDate, s.end_date as endDate FROM student_package_subscriptions s JOIN packages p ON p.id = s.package_id AND p.center_id = s.center_id WHERE s.center_id = ? AND s.student_id = ? AND s.status = 'active' ORDER BY p.name`, [activeCenterId, student.id]);
    setSelectedStudent(student);
    setTargets([
      ...groupRows.map((row) => ({ id: row.id, label: `مجموعة: ${row.groupName}`, kind: "group" as const, cycleType: "monthly" as const, enrollmentId: row.id, groupId: row.groupId, startDate: row.startDate?.slice(0, 10), endDate: row.endDate?.slice(0, 10) })),
      ...packageRows.map((row) => ({ id: row.id, label: `باقة: ${row.packageName}`, kind: "package" as const, cycleType: "package" as const, packageSubscriptionId: row.id, packageId: row.packageId, startDate: row.startDate?.slice(0, 10), endDate: row.endDate?.slice(0, 10) })),
    ]);
    setSelectedTarget(null);
  };

  const chooseTarget = (target: Target) => {
    setSelectedTarget(target);
    if (target.startDate) setStartDate(target.startDate);
    if (target.endDate) setEndDate(target.endDate);
    else if (target.startDate) setEndDate(addMonth(target.startDate));
  };

  const save = async () => {
    if (!selectedStudent || !selectedTarget) return Alert.alert("بيانات ناقصة", "اختر الطالب والاشتراك أولًا.");
    if (!PermissionService.hasPermission(resolveUserPermissions(currentUser), "payments.adjust")) return Alert.alert("غير مسموح", "لا تملك صلاحية ترحيل الرصيد الافتتاحي.");
    setSaving(true);
    try {
      await OpeningBalanceService.importCurrentPeriod({ studentId: selectedStudent.id, ...selectedTarget, periodStart: startDate, periodEnd: endDate, amountDue: Number(amountDue), amountPaid: Number(amountPaid || 0), notes: notes.trim() || undefined });
      Alert.alert("تم الترحيل", "تم حفظ الدورة الحالية والمدفوع السابق، وسيستمر التجديد من تاريخ الاشتراك الأصلي.");
      setAmountDue(""); setAmountPaid("0"); setNotes("");
    } catch (error: any) {
      Alert.alert("تعذر الترحيل", error?.message || "حدث خطأ أثناء حفظ الرصيد الافتتاحي.");
    } finally { setSaving(false); }
  };

  const filteredStudents = useMemo(() => smartSearch(students, studentSearch, [
    { get: (student) => student.fullName, weight: 1.2 },
    { get: (student) => student.studentCode, weight: 1.1 },
    { get: (student) => student.cardCode, weight: 1.1 },
    { get: (student) => student.grade },
  ]), [students, studentSearch]);
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}><View><Text style={styles.eyebrow}>تشغيل السنتر</Text><Text style={styles.title}>ترحيل الرصيد الافتتاحي</Text><Text style={styles.subtitle}>للسناتر التي تبدأ استخدام النظام في منتصف الشهر أو الترم</Text></View><View style={styles.headerIcon}><Ionicons name="swap-horizontal-outline" size={25} color={colors.primary} /></View></View>
        <AppCard style={styles.info}><Text style={styles.infoTitle}>كيف يعمل؟</Text><Text style={styles.infoText}>نحتفظ بتاريخ اشتراك الطالب كما هو، ونسجل المتبقي والمدفوع حتى يوم تشغيل النظام. لا يتم إنشاء دورة جديدة أو مديونية عن الشهور السابقة.</Text></AppCard>
        <AppInput label="بحث ذكي عن الطالب" value={studentSearch} onChangeText={setStudentSearch} placeholder="الاسم أو كود الطالب أو كود الكارت" />
        {!selectedStudent ? <View style={styles.list}>{filteredStudents.slice(0, 30).map((student) => <TouchableOpacity key={student.id} style={styles.studentRow} onPress={() => selectStudent(student)}><View><Text style={styles.studentName}>{student.fullName}</Text><Text style={styles.studentMeta}>{student.grade} · الكود {student.studentCode || student.cardCode || "—"}</Text></View><Ionicons name="chevron-back" size={18} color={colors.slate400} /></TouchableOpacity>)}{filteredStudents.length > 30 ? <Text style={styles.searchHint}>أظهر أول 30 نتيجة، اكتب تفاصيل أكثر لتضييق البحث.</Text> : null}{!filteredStudents.length ? <EmptyState message="لا يوجد طلاب مطابقون للبحث" /> : null}</View> : <>
          <TouchableOpacity style={styles.backLink} onPress={() => { setSelectedStudent(null); setTargets([]); }}><Ionicons name="arrow-forward" size={17} color={colors.primary} /><Text style={styles.backText}>اختيار طالب آخر</Text></TouchableOpacity>
          <AppCard style={styles.selectedCard}><Text style={styles.selectedName}>{selectedStudent.fullName}</Text><Text style={styles.studentMeta}>{selectedStudent.grade}</Text></AppCard>
          <Text style={styles.sectionTitle}>الاشتراك الحالي</Text>
          {targets.map((target) => <TouchableOpacity key={target.id} style={[styles.targetRow, selectedTarget?.id === target.id && styles.targetRowActive]} onPress={() => chooseTarget(target)}><View style={{ flex: 1 }}><Text style={styles.targetLabel}>{target.label}</Text><Text style={styles.targetMeta}>{target.startDate || "بدون تاريخ بداية"}{target.endDate ? ` · ينتهي ${target.endDate}` : ""}</Text></View><Ionicons name={selectedTarget?.id === target.id ? "checkmark-circle" : "ellipse-outline"} size={22} color={selectedTarget?.id === target.id ? colors.primary : colors.slate400} /></TouchableOpacity>)}
          {!targets.length ? <EmptyState message="لا يوجد اشتراك نشط لهذا الطالب" /> : null}
          {selectedTarget ? <AppCard style={styles.form}><Text style={styles.sectionTitle}>بيانات الدورة الحالية</Text><AppInput label="بداية الدورة الأصلية" value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" /><AppInput label="نهاية الدورة" value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" /><AppInput label="إجمالي الدورة المستحق" value={amountDue} onChangeText={setAmountDue} keyboardType="decimal-pad" placeholder="مثال: 400" /><AppInput label="المدفوع قبل تشغيل النظام" value={amountPaid} onChangeText={setAmountPaid} keyboardType="decimal-pad" placeholder="0" /><AppInput label="ملاحظة (اختياري)" value={notes} onChangeText={setNotes} placeholder="مثال: دفع أول حصتين" multiline /><AppButton title="حفظ الرصيد الافتتاحي" onPress={save} loading={saving} /></AppCard> : null}
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  safe: { flex: 1 }, content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 50 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: "800", textAlign: "right" }, title: { ...Typography.h1, color: colors.textPrimary, textAlign: "right", marginTop: 3 }, subtitle: { color: colors.textSecondary, fontSize: 12, textAlign: "right", marginTop: 4 }, headerIcon: { width: 52, height: 52, borderRadius: 17, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center" }, info: { backgroundColor: colors.primaryLight, borderColor: colors.primary, borderWidth: 1 }, infoTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" }, infoText: { color: colors.textSecondary, fontSize: 12, lineHeight: 20, textAlign: "right", marginTop: 6 }, list: { gap: 8 }, studentRow: { backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 15, padding: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, studentName: { color: colors.textPrimary, fontSize: 15, fontWeight: "800", textAlign: "right" }, studentMeta: { color: colors.textSecondary, fontSize: 11, textAlign: "right", marginTop: 3 }, searchHint: { color: colors.textSecondary, fontSize: 11, textAlign: "right", marginTop: 2 }, backLink: { flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "flex-end" }, backText: { color: colors.primary, fontWeight: "800" }, selectedCard: { alignItems: "flex-end" }, selectedName: { color: colors.textPrimary, fontSize: 17, fontWeight: "900" }, sectionTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" }, targetRow: { backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 15, padding: 13, flexDirection: "row", alignItems: "center", gap: 10 }, targetRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight }, targetLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: "800", textAlign: "right" }, targetMeta: { color: colors.textSecondary, fontSize: 11, textAlign: "right", marginTop: 4 }, form: { gap: 8 },
});

