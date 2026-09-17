import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography } from "../../core/theme";
import { GradeBookRepository, GradeExam, GradeScore } from "../../features/grades/GradeBookRepository";
import { Group, Student } from "../../shared/types";

export default function GradesScreen() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const selectedGroupRef = useRef<Group | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [exams, setExams] = useState<GradeExam[]>([]);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [examName, setExamName] = useState("");
  const [maxScore, setMaxScore] = useState("100");
  const [showExamForm, setShowExamForm] = useState(false);

  const load = useCallback(() => {
    try {
      const nextGroups = GradeBookRepository.getGroups();
      setGroups(nextGroups);
      const currentGroup = selectedGroupRef.current;
      if (currentGroup) {
        const fresh = nextGroups.find((g) => g.id === currentGroup.id) || nextGroups[0] || null;
        selectedGroupRef.current = fresh;
        setSelectedGroup(fresh);
        if (fresh) loadGroup(fresh);
      }
    } catch (error: any) { Alert.alert("خطأ", error?.message || "تعذر تحميل رصد الدرجات."); }
  }, []);

  const loadGroup = (group: Group) => {
    const nextStudents = GradeBookRepository.getStudentsForGroup(group.id);
    const nextExams = GradeBookRepository.getExams(group.grade);
    const nextScores = GradeBookRepository.getScores(nextExams.map((e) => e.id), nextStudents.map((s) => s.id));
    const values: Record<string, string> = {};
    nextScores.forEach((row: GradeScore) => { values[`${row.examId}:${row.studentId}`] = row.score === null ? "" : String(row.score); });
    setStudents(nextStudents); setExams(nextExams); setScores(values);
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const selectGroup = (group: Group) => { selectedGroupRef.current = group; setSelectedGroup(group); loadGroup(group); };
  const createExam = () => {
    if (!selectedGroup) return;
    try {
      GradeBookRepository.createExam(examName, selectedGroup.grade, Number(maxScore));
      setExamName(""); setMaxScore("100"); setShowExamForm(false); loadGroup(selectedGroup);
    } catch (error: any) { Alert.alert("بيانات غير صحيحة", error?.message || "تعذر إضافة الامتحان."); }
  };
  const saveScore = (exam: GradeExam, student: Student, value: string) => {
    setScores((current) => ({ ...current, [`${exam.id}:${student.id}`]: value }));
    try { GradeBookRepository.setScore(exam, student.id, value); }
    catch (error: any) { Alert.alert("درجة غير صحيحة", error?.message || "تعذر حفظ الدرجة."); }
  };

  const gradeLabel = useMemo(() => selectedGroup?.grade || "اختر مجموعة", [selectedGroup]);
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}><View><Text style={styles.kicker}>الأداء الأكاديمي</Text><Text style={styles.title}>رصد الدرجات</Text><Text style={styles.subtitle}>أنشئ الامتحانات وسجّل درجات الطلاب بدون اتصال</Text></View><Ionicons name="school-outline" size={28} color={Colors.primary} /></View>
        <Text style={styles.sectionTitle}>المجموعات</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupRow}>
          {groups.map((group) => <TouchableOpacity key={group.id} onPress={() => selectGroup(group)} style={[styles.groupChip, selectedGroup?.id === group.id && styles.groupChipActive]}><Text style={[styles.groupChipText, selectedGroup?.id === group.id && styles.groupChipTextActive]}>{group.name}</Text><Text style={[styles.groupGrade, selectedGroup?.id === group.id && styles.groupChipTextActive]}>{group.grade}</Text></TouchableOpacity>)}
        </ScrollView>
        {!groups.length ? <Text style={styles.empty}>لا توجد مجموعات نشطة.</Text> : null}
        {selectedGroup ? <>
          <View style={styles.selectedHeader}><View><Text style={styles.selectedTitle}>{selectedGroup.name}</Text><Text style={styles.selectedMeta}>{gradeLabel} · {students.length} طالب</Text></View><TouchableOpacity style={styles.addExamButton} onPress={() => setShowExamForm((value) => !value)}><Ionicons name="add" size={18} color={Colors.white} /><Text style={styles.addExamText}>امتحان جديد</Text></TouchableOpacity></View>
          {showExamForm ? <View style={styles.examForm}><TextInput style={styles.input} value={examName} onChangeText={setExamName} placeholder="اسم الامتحان" placeholderTextColor={Colors.slate400} textAlign="right" /><TextInput style={styles.scoreInput} value={maxScore} onChangeText={setMaxScore} keyboardType="decimal-pad" placeholder="النهائية" placeholderTextColor={Colors.slate400} textAlign="center" /><TouchableOpacity style={styles.saveExam} onPress={createExam}><Text style={styles.saveExamText}>إضافة</Text></TouchableOpacity></View> : null}
          {exams.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableWrap}>
            <View><View style={styles.tableHeader}><Text style={[styles.studentCell, styles.headerCell]}>الطالب</Text>{exams.map((exam) => <View key={exam.id} style={styles.examCell}><Text style={styles.headerCell}>{exam.name}</Text><Text style={styles.maxText}>من {exam.maxScore}</Text></View>)}</View>
              {students.map((student) => <View key={student.id} style={styles.tableRow}><Text style={styles.studentCell} numberOfLines={1}>{student.fullName}</Text>{exams.map((exam) => <TextInput key={exam.id} style={styles.markInput} value={scores[`${exam.id}:${student.id}`] || ""} onChangeText={(value) => setScores((current) => ({ ...current, [`${exam.id}:${student.id}`]: value }))} onBlur={() => saveScore(exam, student, scores[`${exam.id}:${student.id}`] || "")} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={Colors.slate400} textAlign="center" />)}</View>)}
            </View>
          </ScrollView> : <View style={styles.emptyCard}><Ionicons name="document-text-outline" size={28} color={Colors.slate400} /><Text style={styles.empty}>أضف أول امتحان لهذا الصف لتبدأ الرصد.</Text></View>}
        </> : <View style={styles.emptyCard}><Ionicons name="people-outline" size={28} color={Colors.slate400} /><Text style={styles.empty}>اختر مجموعة لعرض الطلاب والامتحانات.</Text></View>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: Colors.white, borderRadius: 18, padding: Spacing.lg, borderWidth: 1, borderColor: Colors.border }, kicker: { color: Colors.primary, fontSize: 12, fontWeight: "700", textAlign: "right" }, title: { ...Typography.h2, color: Colors.slate900, textAlign: "right", marginTop: 2 }, subtitle: { color: Colors.slate500, fontSize: 12, textAlign: "right", marginTop: 3 }, sectionTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" }, groupRow: { gap: 10, paddingVertical: 2 }, groupChip: { minWidth: 145, padding: 12, borderRadius: 14, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border }, groupChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary }, groupChipText: { color: Colors.slate800, fontWeight: "800", textAlign: "right" }, groupGrade: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" }, groupChipTextActive: { color: Colors.white }, selectedHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: Colors.white, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: Colors.border }, selectedTitle: { color: Colors.slate900, fontSize: 17, fontWeight: "800", textAlign: "right" }, selectedMeta: { color: Colors.slate500, fontSize: 12, textAlign: "right", marginTop: 3 }, addExamButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 }, addExamText: { color: Colors.white, fontWeight: "800", fontSize: 12 }, examForm: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Colors.white, borderRadius: 14, padding: 10, borderWidth: 1, borderColor: Colors.primaryLight }, input: { flex: 1, height: 42, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 10, color: Colors.slate900 }, scoreInput: { width: 76, height: 42, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, color: Colors.slate900 }, saveExam: { backgroundColor: Colors.success, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11 }, saveExamText: { color: Colors.white, fontWeight: "800" }, tableWrap: { backgroundColor: Colors.white, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, overflow: "hidden", minWidth: "100%" }, tableHeader: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.primaryLight, borderBottomWidth: 1, borderBottomColor: Colors.border }, tableRow: { flexDirection: "row", alignItems: "center", minHeight: 58, borderBottomWidth: 1, borderBottomColor: Colors.border }, studentCell: { width: 170, paddingHorizontal: 12, color: Colors.slate900, fontWeight: "700", textAlign: "right" }, examCell: { width: 105, padding: 9, alignItems: "center" }, headerCell: { color: Colors.slate900, fontWeight: "800", textAlign: "center", fontSize: 12 }, maxText: { color: Colors.slate500, fontSize: 10, marginTop: 2 }, markInput: { width: 72, height: 38, marginHorizontal: 16, borderWidth: 1, borderColor: Colors.border, borderRadius: 9, color: Colors.slate900, backgroundColor: Colors.background }, emptyCard: { alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Colors.white, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 28 }, empty: { color: Colors.slate500, textAlign: "center", padding: 8 } });
