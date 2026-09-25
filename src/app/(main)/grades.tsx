import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { GradeBookRepository, GradeExam, GradeScore } from "../../features/grades/GradeBookRepository";
import { NotificationService } from "../../features/notifications/NotificationService";
import { Group, Student } from "../../shared/types";

export default function GradesScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const selectedGroupRef = useRef<Group | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [exams, setExams] = useState<GradeExam[]>([]);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [examName, setExamName] = useState("");
  const [maxScore, setMaxScore] = useState("100");
  const [showExamForm, setShowExamForm] = useState(false);
  const [scoreMin, setScoreMin] = useState("");
  const [scoreMax, setScoreMax] = useState("");

  const loadGroup = useCallback((group: Group) => {
    const nextStudents = GradeBookRepository.getStudentsForGroup(group.id);
    const nextExams = GradeBookRepository.getExams(group.grade);
    const nextScores = GradeBookRepository.getScores(nextExams.map((e) => e.id), nextStudents.map((s) => s.id));
    const values: Record<string, string> = {};
    nextScores.forEach((row: GradeScore) => { values[`${row.examId}:${row.studentId}`] = row.score === null ? "" : String(row.score); });
    setStudents(nextStudents); setExams(nextExams); setScores(values);
  }, []);

  const load = useCallback(() => {
    try {
      const nextGroups = GradeBookRepository.getGroups();
      setGroups(nextGroups);
      const current = selectedGroupRef.current;
      if (current) {
        const fresh = nextGroups.find((group) => group.id === current.id) || nextGroups[0] || null;
        selectedGroupRef.current = fresh; setSelectedGroup(fresh);
        if (fresh) loadGroup(fresh);
      }
    } catch (error: any) { Alert.alert("خطأ", error?.message || "تعذر تحميل رصد الدرجات."); }
  }, [loadGroup]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const selectGroup = (group: Group) => { selectedGroupRef.current = group; setSelectedGroup(group); loadGroup(group); };
  const createExam = () => {
    if (!selectedGroup) return;
    try { GradeBookRepository.createExam(examName, selectedGroup.grade, Number(maxScore)); setExamName(""); setMaxScore("100"); setShowExamForm(false); loadGroup(selectedGroup); }
    catch (error: any) { Alert.alert("بيانات غير صحيحة", error?.message || "تعذر إضافة الامتحان."); }
  };
  const saveScore = (exam: GradeExam, student: Student, value: string) => {
    setScores((current) => ({ ...current, [`${exam.id}:${student.id}`]: value }));
    try { GradeBookRepository.setScore(exam, student.id, value); }
    catch (error: any) { Alert.alert("درجة غير صحيحة", error?.message || "تعذر حفظ الدرجة."); }
  };
  const visibleStudents = useMemo(() => students.filter((student) => {
    const min = scoreMin.trim() === "" ? null : Number(scoreMin); const max = scoreMax.trim() === "" ? null : Number(scoreMax);
    if (min === null && max === null) return true;
    const values = exams.map((exam) => Number(scores[`${exam.id}:${student.id}`])).filter((value) => Number.isFinite(value));
    return values.some((value) => (min === null || value >= min) && (max === null || value <= max));
  }), [students, exams, scores, scoreMin, scoreMax]);
  const gradeStats = useMemo(() => {
    const values = students.flatMap((student) => exams.map((exam) => Number(scores[`${exam.id}:${student.id}`])).filter((value) => Number.isFinite(value)));
    return { count: values.length, average: values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1) : "0" };
  }, [students, exams, scores]);
  const completion = students.length && exams.length ? Math.round((gradeStats.count / (students.length * exams.length)) * 100) : 0;
  const sendGrades = async (student: Student) => {
    const rows = exams.map((exam) => ({ exam, value: scores[`${exam.id}:${student.id}`] })).filter((row) => row.value !== undefined && row.value !== "");
    if (!rows.length) return Alert.alert("لا توجد درجات", "سجل درجة واحدة على الأقل قبل الإرسال.");
    try { const summary = rows.map(({ exam, value }) => `${exam.name}: ${value}/${exam.maxScore}`).join("، "); const event = NotificationService.notifyGrades({ studentId: student.id, summary }); await NotificationService.sendPendingDeliveries(event.id); Alert.alert("تم تجهيز الرسالة", "ستتم مزامنة رسالة الدرجات للإرسال."); }
    catch (error: any) { Alert.alert("تعذر إرسال الدرجات", error?.message || "راجع صلاحية الإشعارات."); }
  };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.hero}><View style={styles.heroIcon}><Ionicons name="school-outline" size={30} color={Colors.primary} /></View><View style={styles.heroCopy}><Text style={styles.kicker}>الأداء الأكاديمي</Text><Text style={styles.title}>رصد الدرجات</Text><Text style={styles.subtitle}>سجّل الدرجات وتابع تقدم المجموعة بسهولة</Text></View></View>
    <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>اختر المجموعة</Text><Text style={styles.sectionHint}>{groups.length} مجموعة نشطة</Text></View><Ionicons name="layers-outline" size={20} color={Colors.primary} /></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupRow}>{groups.map((group) => <TouchableOpacity key={group.id} onPress={() => selectGroup(group)} style={[styles.groupCard, selectedGroup?.id === group.id && styles.groupCardActive]}><View style={[styles.groupBadge, selectedGroup?.id === group.id && styles.groupBadgeActive]}><Ionicons name="people-outline" size={16} color={selectedGroup?.id === group.id ? Colors.primary : Colors.slate500} /></View><Text style={[styles.groupChipText, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>{group.name}</Text><Text style={[styles.groupGrade, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>{group.grade}</Text><Text style={[styles.groupMeta, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>{group.teacherName || "—"}</Text><Text style={[styles.groupMeta, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>{group.subjectName || "—"}</Text></TouchableOpacity>)}</ScrollView>
    {!groups.length ? <Text style={styles.empty}>لا توجد مجموعات نشطة.</Text> : null}
    {selectedGroup ? <>
      <View style={styles.selectedHeader}><View style={styles.selectedIdentity}><View style={styles.selectedIcon}><Ionicons name="ribbon-outline" size={22} color={Colors.primary} /></View><View style={{ flex: 1 }}><Text style={styles.selectedTitle}>{selectedGroup.name}</Text><Text style={styles.selectedMeta}>{selectedGroup.teacherName || "—"} · {selectedGroup.subjectName || "—"} · {selectedGroup.grade}</Text></View></View><TouchableOpacity style={styles.addExamButton} onPress={() => setShowExamForm((value) => !value)}><Ionicons name={showExamForm ? "close" : "add"} size={18} color={Colors.white} /><Text style={styles.addExamText}>{showExamForm ? "إلغاء" : "امتحان جديد"}</Text></TouchableOpacity></View>
      {showExamForm ? <View style={styles.examForm}><Text style={styles.formLabel}>إضافة امتحان</Text><View style={styles.formFields}><TextInput style={styles.input} value={examName} onChangeText={setExamName} placeholder="اسم الامتحان" placeholderTextColor={Colors.slate400} textAlign="right" /><TextInput style={styles.scoreInput} value={maxScore} onChangeText={setMaxScore} keyboardType="decimal-pad" placeholder="النهائية" placeholderTextColor={Colors.slate400} textAlign="center" /><TouchableOpacity style={styles.saveExam} onPress={createExam}><Ionicons name="checkmark" size={17} color={Colors.white} /><Text style={styles.saveExamText}>حفظ</Text></TouchableOpacity></View></View> : null}
      <View style={styles.statsGrid}><View style={styles.statCard}><Text style={styles.statValue}>{students.length}</Text><Text style={styles.statLabel}>طلاب المجموعة</Text></View><View style={styles.statCard}><Text style={[styles.statValue, { color: Colors.successText }]}>{completion}%</Text><Text style={styles.statLabel}>نسبة الرصد</Text></View><View style={styles.statCard}><Text style={styles.statValue}>{gradeStats.average}</Text><Text style={styles.statLabel}>المتوسط</Text></View><View style={styles.statCard}><Text style={[styles.statValue, { color: Colors.accent }]}>{exams.length}</Text><Text style={styles.statLabel}>امتحانات</Text></View></View>
      <View style={styles.filterCard}><View style={styles.filterTitleRow}><View><Text style={styles.filterTitle}>تصفية الطلاب</Text><Text style={styles.filterHint}>اعرض الطلاب داخل نطاق درجات محدد</Text></View><TouchableOpacity onPress={() => { setScoreMin(""); setScoreMax(""); }} hitSlop={10}><Text style={styles.clearFilter}>مسح</Text></TouchableOpacity></View><View style={styles.filterInputs}><TextInput style={styles.filterInput} value={scoreMin} onChangeText={setScoreMin} keyboardType="decimal-pad" placeholder="من" placeholderTextColor={Colors.slate400} /><Text style={styles.filterDash}>إلى</Text><TextInput style={styles.filterInput} value={scoreMax} onChangeText={setScoreMax} keyboardType="decimal-pad" placeholder="إلى" placeholderTextColor={Colors.slate400} /><Text style={styles.filterCount}>{visibleStudents.length} طالب</Text></View></View>
      {exams.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableWrap}><View><View style={styles.tableHeader}><Text style={[styles.studentCell, styles.headerCell]}>الطالب</Text>{exams.map((exam) => <View key={exam.id} style={styles.examCell}><Text style={styles.headerCell} numberOfLines={1}>{exam.name}</Text><Text style={styles.maxText}>من {exam.maxScore}</Text></View>)}<View style={styles.actionCell}><Text style={styles.headerCell}>إجراء</Text></View></View>{visibleStudents.map((student, index) => <View key={student.id} style={[styles.tableRow, index % 2 === 1 && styles.tableRowAlt]}><View style={styles.studentCell}><View style={styles.avatar}><Text style={styles.avatarText}>{student.fullName?.trim()?.charAt(0) || "ط"}</Text></View><Text style={styles.studentName} numberOfLines={1}>{student.fullName}</Text></View>{exams.map((exam) => <TextInput key={exam.id} style={styles.markInput} value={scores[`${exam.id}:${student.id}`] || ""} onChangeText={(value) => setScores((current) => ({ ...current, [`${exam.id}:${student.id}`]: value }))} onBlur={() => saveScore(exam, student, scores[`${exam.id}:${student.id}`] || "")} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={Colors.slate400} textAlign="center" />)}<TouchableOpacity style={styles.sendGradeButton} onPress={() => sendGrades(student)} accessibilityLabel={`إرسال درجات ${student.fullName}`}><Ionicons name="send-outline" size={15} color={Colors.white} /><Text style={styles.sendGradeText}>إرسال</Text></TouchableOpacity></View>)}</View></ScrollView> : <View style={styles.emptyCard}><Ionicons name="document-text-outline" size={30} color={Colors.primary} /><Text style={styles.emptyTitle}>لا توجد امتحانات بعد</Text><Text style={styles.empty}>أضف أول امتحان لهذه المجموعة لتبدأ الرصد.</Text></View>}
    </> : <View style={styles.emptyCard}><Ionicons name="people-outline" size={30} color={Colors.primary} /><Text style={styles.emptyTitle}>ابدأ باختيار مجموعة</Text><Text style={styles.empty}>ستظهر هنا قائمة الطلاب والامتحانات الخاصة بها.</Text></View>}
  </ScrollView></SafeAreaView>;
}

const createStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 48 },
  hero: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: Colors.primaryMuted, borderRadius: 22, padding: 18, borderWidth: 1, borderColor: Colors.primaryLight }, heroCopy: { flex: 1 }, heroIcon: { width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: Colors.white }, kicker: { color: Colors.primary, fontSize: 12, fontWeight: "800", textAlign: "right" }, title: { ...Typography.h1, color: Colors.slate900, textAlign: "right", marginTop: 2 }, subtitle: { color: Colors.slate600, fontSize: 12, textAlign: "right", marginTop: 4 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }, sectionTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" }, sectionHint: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 2 }, groupRow: { gap: 10, paddingVertical: 2 }, groupCard: { width: 156, minHeight: 132, padding: 12, borderRadius: 16, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border }, groupCardActive: { backgroundColor: Colors.primary, borderColor: Colors.primary }, groupBadge: { width: 30, height: 30, borderRadius: 10, backgroundColor: Colors.slate100, alignItems: "center", justifyContent: "center", marginBottom: 9 }, groupBadgeActive: { backgroundColor: Colors.white }, groupChipText: { color: Colors.slate800, fontWeight: "800", textAlign: "right" }, groupGrade: { color: Colors.primary, fontSize: 11, fontWeight: "700", marginTop: 5, textAlign: "right" }, groupMeta: { color: Colors.slate500, fontSize: 10, marginTop: 3, textAlign: "right" }, groupChipTextActive: { color: Colors.white },
  selectedHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, backgroundColor: Colors.white, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: Colors.border }, selectedIdentity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, selectedIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" }, selectedTitle: { color: Colors.slate900, fontSize: 17, fontWeight: "800", textAlign: "right" }, selectedMeta: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 4 }, addExamButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: Colors.primary, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10 }, addExamText: { color: Colors.white, fontWeight: "800", fontSize: 12 },
  examForm: { backgroundColor: Colors.white, borderRadius: 16, padding: 13, borderWidth: 1, borderColor: Colors.primaryLight }, formLabel: { color: Colors.slate800, fontWeight: "800", textAlign: "right", marginBottom: 9 }, formFields: { flexDirection: "row", alignItems: "center", gap: 8 }, input: { flex: 1, height: 43, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 10, color: Colors.slate900 }, scoreInput: { width: 76, height: 43, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, color: Colors.slate900 }, saveExam: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Colors.success, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12 }, saveExamText: { color: Colors.white, fontWeight: "800" },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, statCard: { flex: 1, minWidth: "23%", backgroundColor: Colors.white, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, paddingVertical: 12, alignItems: "center" }, statValue: { color: Colors.primary, fontSize: 20, fontWeight: "900" }, statLabel: { color: Colors.slate500, fontSize: 10, fontWeight: "700", marginTop: 4 }, filterCard: { backgroundColor: Colors.white, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 13 }, filterTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, filterTitle: { color: Colors.slate800, fontWeight: "800", textAlign: "right" }, filterHint: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 3 }, clearFilter: { color: Colors.primary, fontWeight: "800", fontSize: 12 }, filterInputs: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }, filterInput: { width: 64, height: 38, borderWidth: 1, borderColor: Colors.border, borderRadius: 9, color: Colors.slate900, textAlign: "center" }, filterDash: { color: Colors.slate500, fontSize: 12 }, filterCount: { flex: 1, color: Colors.primary, fontWeight: "800", textAlign: "right", fontSize: 12 },
  tableWrap: { backgroundColor: Colors.white, borderRadius: 18, borderWidth: 1, borderColor: Colors.border, overflow: "hidden", minWidth: "100%" }, tableHeader: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.primaryLight, borderBottomWidth: 1, borderBottomColor: Colors.border, minHeight: 58 }, tableRow: { flexDirection: "row", alignItems: "center", minHeight: 64, borderBottomWidth: 1, borderBottomColor: Colors.border }, tableRowAlt: { backgroundColor: Colors.slate50 }, studentCell: { width: 190, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8 }, studentName: { flex: 1, color: Colors.slate900, fontWeight: "700", textAlign: "right" }, avatar: { width: 30, height: 30, borderRadius: 10, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" }, avatarText: { color: Colors.primary, fontWeight: "900" }, examCell: { width: 108, padding: 9, alignItems: "center" }, actionCell: { width: 90, alignItems: "center" }, headerCell: { color: Colors.slate900, fontWeight: "900", textAlign: "center", fontSize: 12 }, maxText: { color: Colors.slate600, fontSize: 10, marginTop: 3 }, markInput: { width: 70, height: 40, marginHorizontal: 19, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, color: Colors.slate900, backgroundColor: Colors.white, fontWeight: "800" }, sendGradeButton: { width: 78, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: Colors.primary, borderRadius: 9, paddingVertical: 9 }, sendGradeText: { color: Colors.white, fontSize: 11, fontWeight: "800" },
  emptyCard: { alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: Colors.white, borderRadius: 18, borderWidth: 1, borderColor: Colors.border, padding: 30 }, emptyTitle: { color: Colors.slate800, fontSize: 16, fontWeight: "800", textAlign: "center" }, empty: { color: Colors.slate500, textAlign: "center", padding: 8, lineHeight: 21 },
});
