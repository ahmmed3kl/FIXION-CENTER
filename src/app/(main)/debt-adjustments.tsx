import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { DebtAdjustmentRepository } from "../../features/payments/DebtAdjustmentRepository";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { StudentRepository } from "../../features/students/StudentRepository";
import { AppButton, AppCard, AppInput, EmptyState, StatusBadge } from "../../shared/components";
import { smartSearch } from "../../shared/utils/smartSearch";

const money = (value: number) => `${Number(value || 0).toFixed(2)} ج.م`;

export default function DebtAdjustmentsScreen() {
  const localDataRevision = useLocalDataRevision(["student"]);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const currentUser = useAuthStore((state) => state.currentUser);
  const canAdjust = PermissionService.hasPermission(resolveUserPermissions(currentUser), "payments.adjust");
  const [students, setStudents] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const loadStudents = useCallback(() => {
    try { setStudents(StudentRepository.getAll(false)); } catch { setStudents([]); }
  }, []);
  useEffect(() => { loadStudents(); }, [loadStudents]);
  useEffect(() => { if (localDataRevision > 0) loadStudents(); }, [localDataRevision]);

  const visible = useMemo(() => smartSearch(students, query, [
    { get: (item: any) => item.fullName, weight: 1.2 },
    { get: (item: any) => item.studentCode, weight: 1.1 },
    { get: (item: any) => item.cardCode, weight: 1.1 },
    { get: (item: any) => item.phone },
  ]).slice(0, 40), [students, query]);

  const selectStudent = (student: any) => {
    setSelected(student);
    try { setStatus(FinancialCalculationService.getStudentFinancialStatus(student.id)); }
    catch { setStatus(null); }
  };

  const reloadStatus = () => {
    if (!selected) return;
    try { setStatus(FinancialCalculationService.getStudentFinancialStatus(selected.id)); } catch { setStatus(null); }
  };

  const zeroCycle = (cycle: any) => {
    const remaining = Number(cycle.remainingDebt || 0);
    const effectivePrice = Number(cycle.effectivePrice ?? cycle.cyclePrice ?? 0);
    if (remaining <= 0 || effectivePrice <= 0) return Alert.alert("لا يوجد مستحق", "هذه الدورة لا تحتوي على مديونية مفتوحة.");
    Alert.alert("تصفير المديونية", `سيتم تصفير مستحق الدورة بقيمة ${money(remaining)} مع الاحتفاظ بسجل المديونية والمدفوعات.`, [
      { text: "إلغاء", style: "cancel" },
      { text: "تصفير", style: "destructive", onPress: async () => {
        setSaving(cycle.id);
        try {
          await DebtAdjustmentRepository.createAdjustment({ debtCycleId: cycle.id, adjustmentAmount: -effectivePrice, reason: "تصفير المديونية بواسطة الإدارة" });
          reloadStatus();
          Alert.alert("تم التصفير", "تم تسجيل التعديل في السجل والمزامنة.");
        } catch (error: any) { Alert.alert("تعذر التصفير", error?.message || "حدث خطأ أثناء تعديل المديونية."); }
        finally { setSaving(null); }
      } },
    ]);
  };

  if (!canAdjust) return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}><View style={styles.locked}><Ionicons name="lock-closed-outline" size={32} color={colors.slate500} /><Text style={styles.lockedTitle}>هذه الصفحة للإدارة فقط</Text><Text style={styles.lockedText}>تحتاج إلى صلاحية تعديل المديونية.</Text></View></SafeAreaView>;

  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}><View><Text style={styles.eyebrow}>إدارة مالية</Text><Text style={styles.title}>تعديل مديونية الطلاب</Text><Text style={styles.subtitle}>تصفير المستحق مع الاحتفاظ بالسجل الكامل للمديونية والمدفوعات.</Text></View><View style={styles.headerIcon}><Ionicons name="shield-checkmark-outline" size={25} color={colors.primary} /></View></View>
      {!selected ? <><AppInput label="بحث ذكي عن الطالب" value={query} onChangeText={setQuery} placeholder="الاسم أو الكود أو الكرت أو الهاتف" />{visible.map((student) => <TouchableOpacity key={student.id} style={styles.studentRow} onPress={() => selectStudent(student)}><View style={styles.studentCopy}><Text style={styles.studentName}>{student.fullName}</Text><Text style={styles.meta}>{[student.grade, student.studentCode || student.cardCode].filter(Boolean).join(" · ")}</Text></View><Ionicons name="chevron-back" size={19} color={colors.slate400} /></TouchableOpacity>)}{!visible.length && <EmptyState message="لا توجد نتائج مطابقة." />}</> : <>
        <TouchableOpacity style={styles.back} onPress={() => { setSelected(null); setStatus(null); }}><Ionicons name="arrow-forward" size={18} color={colors.primary} /><Text style={styles.backText}>اختيار طالب آخر</Text></TouchableOpacity>
        <AppCard style={styles.selectedCard}><Text style={styles.selectedName}>{selected.fullName}</Text><Text style={styles.meta}>{selected.grade} · {selected.studentCode || selected.cardCode || "بدون كود"}</Text></AppCard>
        {!status ? <EmptyState message="تعذر تحميل الموقف المالي." /> : status.cycles?.map((cycle: any) => <AppCard key={cycle.id} style={styles.cycle}><View style={styles.cycleTop}><View style={styles.studentCopy}><Text style={styles.cycleTitle}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.meta}>{cycle.startDate} إلى {cycle.endDate}</Text></View><StatusBadge text={Number(cycle.remainingDebt || 0) > 0 ? "مفتوحة" : "مسددة"} type={Number(cycle.remainingDebt || 0) > 0 ? "warning" : "success"} /></View><View style={styles.amountRow}><Text style={styles.amountLabel}>المستحق</Text><Text style={styles.amount}>{money(cycle.effectivePrice ?? cycle.cyclePrice)}</Text><Text style={styles.amountLabel}>المدفوع</Text><Text style={styles.amount}>{money(cycle.paidAmount)}</Text><Text style={styles.amountLabel}>المتبقي</Text><Text style={[styles.amount, { color: Number(cycle.remainingDebt || 0) > 0 ? colors.dangerText : colors.successText }]}>{money(cycle.remainingDebt)}</Text></View>{Number(cycle.remainingDebt || 0) > 0 && <AppButton title="تصفير هذه الدورة" onPress={() => zeroCycle(cycle)} loading={saving === cycle.id} variant="outline" />}</AppCard> )}
      </>}
    </ScrollView>
  </SafeAreaView>;
}

const createStyles = (colors: any) => StyleSheet.create({
  safe: { flex: 1 }, content: { padding: Spacing.lg, paddingBottom: 40, gap: 10 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: "900", textAlign: "right" }, title: { ...Typography.h1, color: colors.textPrimary, textAlign: "right", marginTop: 3 }, subtitle: { color: colors.textSecondary, fontSize: 12, textAlign: "right", marginTop: 4, maxWidth: 280 }, headerIcon: { width: 52, height: 52, borderRadius: 17, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center" }, studentRow: { flexDirection: "row-reverse", alignItems: "center", backgroundColor: colors.cardBackground, borderColor: colors.border, borderWidth: 1, borderRadius: 15, padding: 13, gap: 10 }, studentCopy: { flex: 1 }, studentName: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" }, meta: { color: colors.textSecondary, fontSize: 11, textAlign: "right", marginTop: 3 }, back: { flexDirection: "row-reverse", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 5 }, backText: { color: colors.primary, fontWeight: "900" }, selectedCard: { borderColor: colors.primary }, selectedName: { color: colors.textPrimary, fontSize: 18, fontWeight: "900", textAlign: "right" }, cycle: { gap: 12 }, cycleTop: { flexDirection: "row-reverse", alignItems: "center", gap: 10 }, cycleTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" }, amountRow: { flexDirection: "row-reverse", flexWrap: "wrap", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }, amountLabel: { color: colors.textSecondary, fontSize: 11 }, amount: { color: colors.textPrimary, fontSize: 13, fontWeight: "900" }, locked: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }, lockedTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: "900", marginTop: 10 }, lockedText: { color: colors.textSecondary, marginTop: 6, textAlign: "center" },
});
