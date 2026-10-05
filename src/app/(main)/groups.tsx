import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { SubjectRepository } from "../../features/subjects/SubjectRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { Group } from "../../shared/types";
import { AppButton, AppInput, EmptyState } from "../../shared/components";
import { smartSearch } from "../../shared/utils/smartSearch";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export default function GroupsScreen() {
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);
  const router = useRouter();
  const { colors } = useTheme();
  const [groups, setGroups] = useState<Group[]>([]);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [actionGroup, setActionGroup] = useState<Group | null>(null);
  const [name, setName] = useState(""); const [grade, setGrade] = useState(""); const [teacherId, setTeacherId] = useState(""); const [subjectId, setSubjectId] = useState("");
  const teachers = useMemo(() => { try { return TeacherRepository.getAll().filter((item) => item.status === "active"); } catch { return []; } }, [showCreate]);
  const subjects = useMemo(() => { try { return SubjectRepository.getAll().filter((item) => item.status === "active"); } catch { return []; } }, [showCreate]);

  const load = useCallback(() => {
    try { setGroups(GroupRepository.getAll(true)); } catch { setGroups([]); }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!hasInitialLoadedRef.current || lastLoadedRevisionRef.current !== localDataRevision) {
        hasInitialLoadedRef.current = true;
        lastLoadedRevisionRef.current = localDataRevision;
        load();
      }
    }, [load, localDataRevision]),
  );

  useEffect(() => {
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      load();
    }
  }, [localDataRevision, load]);

  const visibleGroups = useMemo(() => smartSearch(groups, query, [
    { get: (group) => group.name, weight: 1.2 },
    { get: (group) => group.subjectName },
    { get: (group) => group.grade },
    { get: (group) => group.teacherName },
  ]), [groups, query]);
  const createGroup = () => {
    try {
      GroupRepository.createGroup({ name, grade, teacherId, subjectId, defaultFee: 0, sessionPrice: 0, monthlyPrice: 0 });
      setName(""); setGrade(""); setTeacherId(""); setSubjectId(""); setShowCreate(false); load();
    } catch (error: any) { Alert.alert("تعذر إضافة المجموعة", error?.message || "راجع البيانات والمدرس والمادة."); }
  };

  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={[styles.back, { backgroundColor: colors.cardBackground, borderColor: colors.border }]} accessibilityLabel="رجوع"><Ionicons name="chevron-forward" size={22} color={colors.textPrimary} /></TouchableOpacity>
      <View style={styles.headerCopy}><Text style={[styles.eyebrow, { color: colors.primary }]}>الإدارة الأكاديمية</Text><Text style={[styles.title, { color: colors.textPrimary }]}>المجموعات</Text><Text style={[styles.subtitle, { color: colors.textSecondary }]}>كل المجموعات المسجلة في المركز</Text></View>
      <TouchableOpacity onPress={() => router.push({ pathname: "/(main)/academic", params: { addGroup: "1" } } as any)} style={[styles.addButton, { backgroundColor: colors.primary }]}><Ionicons name="add" size={19} color={colors.white} /><Text style={styles.addButtonText}>إضافة مجموعة</Text></TouchableOpacity>
      <View style={[styles.count, { backgroundColor: colors.primaryLight }]}><Text style={[styles.countText, { color: colors.primary }]}>{groups.length}</Text></View>
    </View>
    <FlatList
      data={visibleGroups}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<AppInput value={query} onChangeText={setQuery} placeholder="ابحث باسم المجموعة أو المادة أو المدرس..." containerStyle={styles.search} />}
      ListEmptyComponent={<EmptyState message={query ? "لا توجد نتائج مطابقة." : "لا توجد مجموعات مسجلة."} />}
      renderItem={({ item }) => {
        const schedules = GroupScheduleRepository.getSchedulesForGroup(item.id).filter((schedule) => schedule.status !== "inactive");
        return <TouchableOpacity activeOpacity={0.8} onPress={() => router.push({ pathname: "/(main)/group-details", params: { groupId: item.id } } as any)} onLongPress={() => setActionGroup(item)} delayLongPress={450} style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
          <View style={[styles.icon, { backgroundColor: colors.primaryLight }]}><Ionicons name="people-outline" size={21} color={colors.primary} /></View>
          <View style={styles.copy}><Text style={[styles.name, { color: colors.textPrimary }]}>{item.name}</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>{[item.subjectName, item.grade, item.teacherName].filter(Boolean).join(" · ") || "بيانات المجموعة"}</Text><Text style={[styles.schedule, { color: colors.textSecondary }]}>{schedules.length ? schedules.map((schedule) => `${DAYS[schedule.dayOfWeek]} ${schedule.startTime} - ${schedule.endTime}`).join("  ·  ") : "لا يوجد جدول محدد"}</Text></View>
          <Ionicons name="chevron-back" size={19} color={colors.slate400} />
        </TouchableOpacity>;
      }}
    />
    <Modal visible={Boolean(actionGroup)} transparent animationType="fade" onRequestClose={() => setActionGroup(null)}>
      <View style={styles.actionBackdrop}><View style={styles.actionSheet}><Text style={styles.actionTitle}>{actionGroup?.name}</Text><Text style={styles.actionHint}>اختر الإجراء المطلوب</Text><View style={styles.actionButtons}><TouchableOpacity style={styles.editAction} onPress={() => { if (!actionGroup) return; const id = actionGroup.id; setActionGroup(null); router.push({ pathname: "/(main)/academic", params: { editGroupId: id } } as any); }}><Ionicons name="create-outline" size={20} color={Colors.primary} /><Text style={styles.editActionText}>تعديل المجموعة</Text></TouchableOpacity><TouchableOpacity style={styles.deleteAction} onPress={() => { const group = actionGroup; setActionGroup(null); if (!group) return; Alert.alert("حذف المجموعة", "سيتم الحذف فقط إذا لم توجد سجلات مرتبطة بها.", [{ text: "إلغاء", style: "cancel" }, { text: "حذف", style: "destructive", onPress: () => { try { GroupRepository.deleteGroup(group.id); load(); Alert.alert("تم بنجاح", "تم حذف المجموعة."); } catch (error: any) { Alert.alert("لا يمكن الحذف", error?.message || "استخدم التعطيل للحفاظ على السجل."); } } }]); }}><Ionicons name="trash-outline" size={20} color={Colors.dangerText} /><Text style={styles.deleteActionText}>حذف المجموعة</Text></TouchableOpacity></View><AppButton title="إلغاء" variant="outline" onPress={() => setActionGroup(null)} /></View></View>
    </Modal>
    <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
      <View style={styles.backdrop}><View style={styles.sheet}><Text style={styles.sheetTitle}>إضافة مجموعة</Text><ScrollView keyboardShouldPersistTaps="handled">
        <AppInput label="اسم المجموعة *" value={name} onChangeText={setName} placeholder="مثال: مجموعة الفيزياء" />
        <AppInput label="الصف الدراسي *" value={grade} onChangeText={setGrade} placeholder="مثال: الثالث الثانوي" />
        <Text style={styles.selectorLabel}>المادة *</Text><View style={styles.chips}>{subjects.map((subject) => <TouchableOpacity key={subject.id} onPress={() => setSubjectId(subject.id)} style={[styles.chip, subjectId === subject.id && styles.chipActive]}><Text style={[styles.chipText, subjectId === subject.id && styles.chipTextActive]}>{subject.name}</Text></TouchableOpacity>)}</View>
        <Text style={styles.selectorLabel}>المدرس *</Text><View style={styles.chips}>{teachers.map((teacher) => <TouchableOpacity key={teacher.id} onPress={() => setTeacherId(teacher.id)} style={[styles.chip, teacherId === teacher.id && styles.chipActive]}><Text style={[styles.chipText, teacherId === teacher.id && styles.chipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</View>
        <View style={styles.modalActions}><AppButton title="حفظ المجموعة" onPress={createGroup} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setShowCreate(false)} style={{ flex: 1 }} /></View>
      </ScrollView></View></View>
    </Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, actionBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.35)" }, actionSheet: { backgroundColor: Colors.white, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 8 }, actionTitle: { ...Typography.h2, color: Colors.slate900, textAlign: "right" }, actionHint: { color: Colors.slate500, textAlign: "right", marginBottom: 6 }, actionButtons: { flexDirection: "row-reverse", gap: 8 }, editAction: { flex: 1, minHeight: 52, borderRadius: 12, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center", gap: 4 }, editActionText: { color: Colors.primary, fontWeight: "900", fontSize: 12 }, deleteAction: { flex: 1, minHeight: 52, borderRadius: 12, backgroundColor: Colors.dangerLight, alignItems: "center", justifyContent: "center", gap: 4 }, deleteActionText: { color: Colors.dangerText, fontWeight: "900", fontSize: 12 },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: Spacing.lg, borderBottomWidth: 1, borderBottomColor: Colors.border },
  back: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" }, eyebrow: { fontSize: 11, fontWeight: "800" }, title: { ...Typography.h1, marginTop: 2 }, subtitle: { fontSize: 12, marginTop: 3 },
  count: { minWidth: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" }, countText: { fontWeight: "900" },
  content: { padding: Spacing.lg, paddingBottom: 32, flexGrow: 1 }, search: { marginBottom: Spacing.md },
  card: { flexDirection: "row-reverse", alignItems: "center", gap: 11, padding: 14, borderWidth: 1, borderRadius: 16, marginBottom: 9 }, icon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" }, copy: { flex: 1, alignItems: "flex-end" }, name: { fontSize: 15, fontWeight: "900", textAlign: "right" }, meta: { fontSize: 11, textAlign: "right", marginTop: 4 }, schedule: { fontSize: 10, textAlign: "right", marginTop: 4 }, addButton: { flexDirection: "row-reverse", alignItems: "center", gap: 4, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 9 }, addButtonText: { color: Colors.white, fontWeight: "800", fontSize: 12 }, backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.35)" }, sheet: { backgroundColor: Colors.white, maxHeight: "88%", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18 }, sheetTitle: { ...Typography.h2, color: Colors.slate900, textAlign: "right", marginBottom: 10 }, selectorLabel: { color: Colors.slate700, fontWeight: "800", textAlign: "right", marginTop: 8, marginBottom: 7 }, chips: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 7 }, chip: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }, chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary }, chipText: { color: Colors.slate700, fontSize: 12 }, chipTextActive: { color: Colors.white, fontWeight: "800" }, modalActions: { flexDirection: "row-reverse", gap: 8, marginTop: 16 },
});
