import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography } from "../../core/theme";
import { EnrollmentRepository } from "../../features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { StudentRepository } from "../../features/students/StudentRepository";
import { AppInput, EmptyState } from "../../shared/components";
import { Group, Student } from "../../shared/types";
import { smartSearch } from "../../shared/utils/smartSearch";

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export default function GroupDetailsScreen() {
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [query, setQuery] = useState("");
  const [schedules, setSchedules] = useState<any[]>([]);

  useEffect(() => {
    if (!groupId) return;
    const loaded = GroupRepository.findById(String(groupId));
    setGroup(loaded);
    if (!loaded) return;
    const enrollments = EnrollmentRepository.getActiveEnrollmentsForGroup(loaded.id);
    const enrolledIds = new Set(enrollments.map((item) => item.studentId));
    setStudents(StudentRepository.getAll().filter((student) => enrolledIds.has(student.id)));
    setSchedules(GroupScheduleRepository.getSchedulesForGroup(loaded.id));
  }, [groupId]);

  const filteredStudents = useMemo(() => smartSearch(students, query, [
    { get: (student) => student.fullName, weight: 1.2 },
    { get: (student) => student.studentCode, weight: 1.1 },
    { get: (student) => student.cardCode, weight: 1.1 },
    { get: (student) => student.phone },
    { get: (student) => student.parentPhone },
  ]), [students, query]);

  if (!group) return <SafeAreaView style={styles.safe}><EmptyState message="المجموعة غير موجودة" /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-forward" size={22} color={Colors.slate800} /></TouchableOpacity>
        <Text style={styles.headerTitle}>تفاصيل المجموعة</Text>
      </View>
      <FlatList
        data={filteredStudents}
        keyExtractor={(student) => student.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={<>
          <View style={styles.summary}>
            <Text style={styles.groupName}>{group.name}</Text>
            <Text style={styles.meta}>{group.subjectName || ""} • {group.teacherName || ""}</Text>
            <Text style={styles.meta}>{group.grade}</Text>
            <Text style={styles.count}>{students.length} طالب</Text>
          </View>
          <Text style={styles.sectionTitle}>جدول المجموعة</Text>
          <View style={styles.scheduleRow}>{schedules.length ? schedules.map((schedule) => <View key={schedule.id} style={styles.scheduleItem}><Text style={styles.scheduleDay}>{DAYS[schedule.dayOfWeek]}</Text><Text style={styles.scheduleTime}>{schedule.startTime} - {schedule.endTime}</Text></View>) : <Text style={styles.muted}>لا يوجد جدول محدد</Text>}</View>
          <Text style={styles.sectionTitle}>الطلاب ({students.length})</Text>
          <AppInput label="بحث داخل طلاب المجموعة" value={query} onChangeText={setQuery} containerStyle={styles.search} />
        </>}
        ListEmptyComponent={<EmptyState message={query ? "مفيش طالب مطابق للبحث" : "مفيش طلبة في المجموعة دي"} />}
        renderItem={({ item }) => <TouchableOpacity style={styles.studentRow} onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: item.id } })}>
          <View style={styles.studentIcon}><Ionicons name="person-outline" size={18} color={Colors.primary} /></View>
          <View style={styles.studentInfo}><Text style={styles.studentName}>{item.fullName}</Text><Text style={styles.studentMeta}>{item.studentCode} • ولي الأمر: {item.parentPhone || "-"}</Text></View>
          <Ionicons name="chevron-back" size={18} color={Colors.slate400} />
        </TouchableOpacity>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", padding: Spacing.lg, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  back: { padding: 6, marginRight: Spacing.sm },
  headerTitle: { ...Typography.h2, color: Colors.slate900 },
  content: { padding: Spacing.lg, paddingBottom: Spacing.xxl },
  summary: { backgroundColor: Colors.white, padding: Spacing.lg, borderRadius: 16, marginBottom: Spacing.lg },
  groupName: { ...Typography.h2, color: Colors.slate900, textAlign: "right" },
  meta: { ...Typography.body, color: Colors.slate600, textAlign: "right", marginTop: 5 },
  count: { ...Typography.bodyBold, color: Colors.primary, textAlign: "right", marginTop: Spacing.md },
  sectionTitle: { ...Typography.h3, color: Colors.slate800, textAlign: "right", marginBottom: Spacing.sm },
  scheduleRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: Spacing.lg },
  scheduleItem: { backgroundColor: Colors.white, borderRadius: 10, padding: 10, minWidth: "45%" },
  scheduleDay: { fontWeight: "700", color: Colors.slate800, textAlign: "right" },
  scheduleTime: { color: Colors.primary, marginTop: 4, textAlign: "right" },
  muted: { color: Colors.slate500 },
  search: { marginBottom: Spacing.md },
  studentRow: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.white, padding: Spacing.md, borderRadius: 12, marginBottom: 8 },
  studentIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center", marginRight: Spacing.sm },
  studentInfo: { flex: 1 },
  studentName: { ...Typography.bodyBold, color: Colors.slate900, textAlign: "right" },
  studentMeta: { ...Typography.caption, color: Colors.slate600, textAlign: "right", marginTop: 3 },
});
