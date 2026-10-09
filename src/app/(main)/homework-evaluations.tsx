import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { HomeworkEvaluationRepository } from "../../features/homework/HomeworkEvaluationRepository";
import { HomeworkEvaluationStatus } from "../../shared/types";

export default function HomeworkEvaluationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const revision = useLocalDataRevision();
  const currentUser = useAuthStore((state) => state.currentUser);
  const canManage = PermissionService.hasPermission(currentUser?.permissions || [], "homework.manage");
  const [statuses, setStatuses] = useState<HomeworkEvaluationStatus[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<HomeworkEvaluationStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!canManage) return;
    try {
      setStatuses(HomeworkEvaluationRepository.listStatuses(true));
      setError("");
    } catch (cause: any) {
      setError(cause?.message || "تعذر تحميل حالات تقييم الواجب.");
    }
  }, [canManage]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load, revision]);

  const save = () => {
    try {
      if (editing) HomeworkEvaluationRepository.updateStatus(editing.id, { name });
      else HomeworkEvaluationRepository.createStatus(name);
      setName("");
      setEditing(null);
      load();
    } catch (cause: any) {
      Alert.alert("تعذر الحفظ", cause?.message || "حاول مرة أخرى.");
    }
  };

  const confirmDelete = (status: HomeworkEvaluationStatus) => Alert.alert(
    "حذف الحالة",
    `هل تريد حذف حالة «${status.name}»؟ لا يمكن حذف حالة استُخدمت في سجل واجب.`,
    [
      { text: "إلغاء", style: "cancel" },
      {
        text: "حذف",
        style: "destructive",
        onPress: () => {
          try {
            HomeworkEvaluationRepository.removeStatus(status.id);
            load();
          } catch (cause: any) {
            Alert.alert("تعذر الحذف", cause?.message || "تعذر حذف الحالة.");
          }
        },
      },
    ],
  );

  if (!canManage) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityLabel="رجوع" onPress={() => router.back()} style={styles.back}>
            <Ionicons name="chevron-forward" size={23} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>تقييم الواجب</Text>
        </View>
        <Text style={styles.error}>ليس لديك صلاحية إدارة حالات تقييم الواجب.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityLabel="رجوع" onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-forward" size={23} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>تقييم الواجب</Text>
          <Text style={styles.subtitle}>أضف الحالات التي يمكن للمعلمين اختيارها لكل حصة</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.form}>
          <Text style={styles.label}>{editing ? "تعديل الحالة" : "إضافة حالة جديدة"}</Text>
          <View style={styles.formRow}>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              maxLength={120}
              placeholder="مثال: مكتمل"
              placeholderTextColor={colors.textSecondary}
              textAlign="right"
              returnKeyType="done"
              onSubmitEditing={save}
            />
            <TouchableOpacity style={styles.saveButton} onPress={save} disabled={!name.trim()}>
              <Ionicons name={editing ? "checkmark" : "add"} size={20} color={Colors.white} />
              <Text style={styles.saveText}>{editing ? "حفظ" : "إضافة"}</Text>
            </TouchableOpacity>
          </View>
          {editing ? <TouchableOpacity onPress={() => { setEditing(null); setName(""); }}><Text style={styles.cancel}>إلغاء التعديل</Text></TouchableOpacity> : null}
          <Text style={styles.hint}>يمكن تعطيل الحالة عند عدم استخدامها بدل حذف سجلها التاريخي.</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.error}>{error}</Text>
            <TouchableOpacity onPress={load} style={styles.retry}><Text style={styles.retryText}>إعادة المحاولة</Text></TouchableOpacity>
          </View>
        ) : statuses.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={30} color={colors.primary} />
            <Text style={styles.emptyTitle}>لا توجد حالات بعد</Text>
            <Text style={styles.hint}>أضف حالات مثل «مكتمل» أو «لم يحل» لتظهر عند تسجيل تقييم الواجب.</Text>
          </View>
        ) : statuses.map((status) => (
          <View key={status.id} style={styles.statusCard}>
            <View style={styles.statusCopy}>
              <Text style={styles.statusName}>{status.name}</Text>
              <Text style={styles.statusState}>{status.status === "active" ? "مفعّلة" : status.status === "inactive" ? "معطّلة" : "محذوفة"}</Text>
            </View>
            {status.status !== "deleted" ? (
              <>
                <TouchableOpacity
                  accessibilityLabel={status.status === "active" ? "تعطيل الحالة" : "تفعيل الحالة"}
                  onPress={() => {
                    try {
                      HomeworkEvaluationRepository.updateStatus(status.id, { status: status.status === "active" ? "inactive" : "active" });
                      load();
                    } catch (cause: any) { Alert.alert("تعذر التحديث", cause?.message || "تعذر تحديث الحالة."); }
                  }}
                  style={styles.action}
                >
                  <Ionicons name={status.status === "active" ? "pause-circle-outline" : "play-circle-outline"} size={21} color={colors.primary} />
                </TouchableOpacity>
                <TouchableOpacity accessibilityLabel="تعديل الحالة" onPress={() => { setEditing(status); setName(status.name); }} style={styles.action}>
                  <Ionicons name="create-outline" size={20} color={colors.primary} />
                </TouchableOpacity>
                <TouchableOpacity accessibilityLabel="حذف الحالة" onPress={() => confirmDelete(status)} style={styles.action}>
                  <Ionicons name="trash-outline" size={19} color={colors.danger} />
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: Spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.cardBackground },
  back: { minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" },
  title: { ...Typography.h2, color: colors.textPrimary, textAlign: "right" },
  subtitle: { color: colors.textSecondary, fontSize: 12, textAlign: "right", marginTop: 3 },
  content: { padding: Spacing.lg, gap: 12, paddingBottom: 36 },
  form: { backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 14, gap: 9 },
  label: { color: colors.textPrimary, fontWeight: "800", textAlign: "right" },
  formRow: { flexDirection: "row-reverse", gap: 8 },
  input: { flex: 1, minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, color: colors.textPrimary, backgroundColor: colors.background },
  saveButton: { minWidth: 82, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: 12, backgroundColor: Colors.primary, paddingHorizontal: 11 },
  saveText: { color: Colors.white, fontWeight: "800" },
  hint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, textAlign: "right" },
  cancel: { color: colors.primary, fontWeight: "700", textAlign: "right" },
  statusCard: { flexDirection: "row-reverse", alignItems: "center", gap: 8, minHeight: 66, padding: 12, borderRadius: 15, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBackground },
  statusCopy: { flex: 1, alignItems: "flex-end" },
  statusName: { color: colors.textPrimary, fontWeight: "800", fontSize: 15 },
  statusState: { color: colors.textSecondary, fontSize: 11, marginTop: 3 },
  action: { minWidth: 38, minHeight: 42, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 9, padding: 24, borderWidth: 1, borderColor: colors.border, borderRadius: 18, backgroundColor: colors.cardBackground },
  emptyTitle: { color: colors.textPrimary, fontWeight: "900", fontSize: 15 },
  errorBox: { gap: 8, padding: 14, borderWidth: 1, borderColor: colors.danger, borderRadius: 14 },
  error: { color: colors.danger, textAlign: "right", padding: 16 },
  retry: { alignSelf: "flex-end", padding: 8 },
  retryText: { color: colors.primary, fontWeight: "800" },
});
