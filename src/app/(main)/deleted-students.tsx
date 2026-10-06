import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { StudentRepository } from "../../features/students/StudentRepository";
import { Student } from "../../shared/types";
import { formatDisplayIdentifier } from "../../shared/utils/formatters";
import { smartSearch } from "../../shared/utils/smartSearch";
import { AppInput, EmptyState } from "../../shared/components";

export default function DeletedStudentsScreen() {
  const { colors } = useTheme();
  const currentUser = useAuthStore((state) => state.currentUser);
  const permissions = currentUser?.permissions || [];
  const canView = PermissionService.hasPermission(permissions, "students.view");
  const canRestore = PermissionService.hasPermission(permissions, "students.restore");
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState("");

  const loadDeletedStudents = useCallback(() => {
    if (!canView) return;
    try {
      setStudents(StudentRepository.getDeletedStudents());
      setLoadError("");
    } catch (error: any) {
      setLoadError(error?.message || "تعذر تحميل الطلاب المحذوفين.");
    }
  }, [canView]);

  useFocusEffect(useCallback(() => {
    if (!hasInitialLoadedRef.current || lastLoadedRevisionRef.current !== localDataRevision) {
      hasInitialLoadedRef.current = true;
      lastLoadedRevisionRef.current = localDataRevision;
      loadDeletedStudents();
    }
  }, [loadDeletedStudents, localDataRevision]));

  useEffect(() => {
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      loadDeletedStudents();
    }
  }, [localDataRevision, loadDeletedStudents]);

  const visibleStudents = search.trim()
    ? smartSearch(students, search, [
        { get: (student) => student.fullName, weight: 1.2 },
        { get: (student) => student.studentCode, weight: 1.1 },
        { get: (student) => student.cardCode, weight: 1.1 },
        { get: (student) => student.phone },
        { get: (student) => student.parentPhone },
      ])
    : students;

  const confirmRestore = (student: Student) => {
    Alert.alert(
      "استرجاع الطالب؟",
      "سيتم استرجاع الطالب بجميع بياناته ومجموعاته وباقاته وسجل الحضور والمدفوعات والملاحظات المرتبطة به.",
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "استرجاع الطالب",
          onPress: () => {
            try {
              StudentRepository.restoreDeletedStudent(student.id);
              loadDeletedStudents();
              Alert.alert("تم الاسترجاع", "عاد الطالب إلى قائمة الطلاب الحالية بنفس سجلاته وكوده.");
            } catch (error: any) {
              Alert.alert("تعذر الاسترجاع", error?.message || "حاول مرة أخرى.");
            }
          },
        },
      ],
    );
  };

  const renderStudent = ({ item }: { item: Student }) => (
    <View style={[styles.studentRow, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
      <View style={styles.studentCopy}>
        <Text style={[styles.studentName, { color: colors.textPrimary }]}>{item.fullName}</Text>
        <Text style={[styles.studentMeta, { color: colors.textSecondary }]}>
          كود الطالب: {formatDisplayIdentifier(item.studentCode)}{item.grade ? ` · ${item.grade}` : ""}
        </Text>
        <Text style={[styles.studentMeta, { color: colors.textSecondary }]}>
          حُذف في {item.deletedAt ? item.deletedAt.slice(0, 10) : "تاريخ غير متاح"}
          {item.deletedBy ? ` · المستخدم ${item.deletedBy}` : ""}
        </Text>
      </View>
      {canRestore && (
        <TouchableOpacity style={styles.restoreButton} onPress={() => confirmRestore(item)} accessibilityRole="button">
          <Ionicons name="refresh-outline" size={17} color={Colors.white} />
          <Text style={styles.restoreButtonText}>استرجاع</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.cardBackground, borderColor: colors.border }]} onPress={() => router.back()} accessibilityLabel="رجوع">
          <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>الطلاب المحذوفون</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>يمكن استرجاع الطالب مع الاحتفاظ بسجله كاملًا</Text>
        </View>
        <View style={[styles.countPill, { backgroundColor: colors.primaryLight }]}>
          <Text style={[styles.countText, { color: colors.primary }]}>{students.length}</Text>
        </View>
      </View>

      {!canView ? (
        <View style={styles.centered}><Text style={[styles.message, { color: colors.textSecondary }]}>ليس لديك صلاحية عرض بيانات الطلاب.</Text></View>
      ) : (
        <FlatList
          data={visibleStudents}
          keyExtractor={(student) => student.id}
          renderItem={renderStudent}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={<AppInput value={search} onChangeText={setSearch} placeholder="ابحث بالاسم أو الكود أو الهاتف" containerStyle={styles.search} />}
          ListEmptyComponent={<EmptyState message={loadError || (search ? "لا توجد نتائج مطابقة." : "لا يوجد طلاب محذوفون.")} />}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.md },
  backButton: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" },
  title: { ...Typography.h2, textAlign: "right" },
  subtitle: { fontSize: 11, textAlign: "right", marginTop: 2 },
  countPill: { minWidth: 32, height: 32, paddingHorizontal: 8, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 13, fontWeight: "900" },
  listContent: { paddingHorizontal: Spacing.md, paddingBottom: 32, flexGrow: 1 },
  search: { marginBottom: Spacing.md },
  studentRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: 13, borderWidth: 1, borderRadius: 14 },
  studentCopy: { flex: 1, alignItems: "flex-end" },
  studentName: { fontSize: 15, fontWeight: "800", textAlign: "right" },
  studentMeta: { fontSize: 11, textAlign: "right", marginTop: 3 },
  restoreButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, minHeight: 36, paddingHorizontal: 10, borderRadius: 10, backgroundColor: Colors.primary },
  restoreButtonText: { color: Colors.white, fontSize: 11, fontWeight: "800" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  message: { fontSize: 14, textAlign: "center" },
});
