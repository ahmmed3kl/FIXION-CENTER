import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiClient } from "../../core/api";
import { Permission, PermissionService, resolveUserPermissions } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import {
  keepManagerGrantablePermissions,
  permissionGroups,
  updateIndividualPermission,
} from "../../features/accounts/permissionCatalog";
import { AppButton, AppInput, EmptyState, StatusBadge } from "../../shared/components";

type Account = {
  id: string;
  fullName: string;
  email: string;
  phone?: string | null;
  role: "manager" | "assistant";
  status: string;
  permissions?: Permission[] | Record<string, boolean>;
};

export default function CenterAccountsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const user = useAuthStore((state) => state.currentUser);
  const activeCenterId = useAuthStore((state) => state.activeCenterId);
  const centerContext = activeCenterId || user?.centerId || null;
  const managerPermissions = useMemo(() => resolveUserPermissions(user), [user]);
  const canManage = PermissionService.hasPermission(managerPermissions, "users.manage");
  const requestConfig = useMemo(
    () => centerContext ? { headers: { "X-Center-Id": centerContext } } : undefined,
    [centerContext],
  );

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"manager" | "assistant">("manager");
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>([]);

  const load = useCallback(async () => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    if (!centerContext) {
      setAccounts([]);
      setError("تعذر تحديد السنتر الحالي.");
      setRefreshing(false);
      setLoading(false);
      return;
    }
    try {
      const response = await ApiClient.getInstance().get<{ items: Account[] }>(
        "/center/users",
        requestConfig,
      );
      setAccounts(response.data.items || []);
      setError("");
    } catch (loadError: any) {
      setAccounts([]);
      setError(loadError?.userMessage || loadError?.message || "تعذر تحميل حسابات السنتر الحالي.");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [canManage, centerContext, requestConfig]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const openCreateForm = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole(user?.role === "manager" ? "assistant" : "manager");
    setSelectedPermissions([]);
    setOpen(true);
  };

  const createAccount = async () => {
    setSaving(true);
    try {
      await ApiClient.getInstance().post(
        "/center/users",
        {
          fullName: name,
          email,
          role,
          password,
          permissions: keepManagerGrantablePermissions(selectedPermissions, managerPermissions),
        },
        requestConfig,
      );
      setOpen(false);
      setName("");
      setEmail("");
      setPassword("");
      setSelectedPermissions([]);
      await load();
      Alert.alert("تمت الإضافة", "تم إنشاء حساب السنتر.");
    } catch (saveError: any) {
      Alert.alert(
        "تعذر إضافة الحساب",
        saveError?.userMessage || saveError?.message || "راجع البيانات وحاول مرة أخرى.",
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (account: Account) => {
    try {
      await ApiClient.getInstance().post(
        `/center/users/${account.id}/${account.status === "active" ? "deactivate" : "activate"}`,
        {},
        requestConfig,
      );
      await load();
    } catch (statusError: any) {
      Alert.alert(
        "تعذر تحديث الحساب",
        statusError?.userMessage || statusError?.message || "حاول مرة أخرى.",
      );
    }
  };

  const changePermission = (permission: Permission, enabled: boolean) => {
    setSelectedPermissions((current) =>
      updateIndividualPermission(current, permission, enabled, managerPermissions),
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="رجوع"
          onPress={() => router.back()}
          style={[styles.back, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}
        >
          <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>إدارة المركز</Text>
          <Text style={[styles.title, { color: colors.textPrimary }]}>حسابات السنتر</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            المديرون والمساعدون في السنتر الحالي فقط
          </Text>
        </View>
      </View>

      {!canManage ? (
        <View style={styles.locked}>
          <Ionicons name="lock-closed-outline" size={28} color={Colors.slate500} />
          <Text style={[styles.lockedTitle, { color: colors.textPrimary }]}>هذه الخاصية غير متاحة لحسابك</Text>
          <Text style={[styles.lockedText, { color: colors.textSecondary }]}>
            تواصل مع مسؤول السنتر لتفعيل صلاحية إدارة الحسابات.
          </Text>
        </View>
      ) : (
        <FlatList
          data={accounts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <>
              <View style={styles.actionRow}>
                <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
                  الحسابات ({accounts.length})
                </Text>
                <AppButton title="إضافة حساب" size="sm" onPress={openCreateForm} />
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </>
          }
          ListEmptyComponent={
            loading
              ? <View style={styles.loadingState}><ActivityIndicator size="large" color={colors.primary} /><Text style={[styles.loadingText, { color: colors.textSecondary }]}>جارٍ تحميل حسابات السنتر...</Text></View>
              : error
              ? <View style={styles.emptyError}><Text style={styles.error}>{error}</Text><AppButton title="إعادة المحاولة" variant="outline" onPress={() => void load()} /></View>
              : <EmptyState message="لا توجد حسابات مدير أو مساعد." />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`تعديل صلاحيات ${item.fullName}`}
              onPress={() => router.push({
                pathname: "/(main)/center-account-permissions",
                params: { userId: item.id },
              } as any)}
              style={[styles.row, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}
            >
              <View style={[styles.icon, { backgroundColor: colors.primaryLight }]}>
                <Ionicons
                  name={item.role === "manager" ? "person-circle-outline" : "person-outline"}
                  size={22}
                  color={colors.primary}
                />
              </View>
              <View style={styles.rowCopy}>
                <Text style={[styles.nameText, { color: colors.textPrimary }]}>{item.fullName}</Text>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>
                  {item.email} · {item.role === "manager" ? "مدير" : "مساعد"}
                </Text>
              </View>
              <Ionicons name="chevron-back" size={19} color={colors.slate400} />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={item.status === "active" ? "تعطيل الحساب" : "تفعيل الحساب"}
                onPress={(event) => {
                  event.stopPropagation();
                  void toggleStatus(item);
                }}
              >
                <StatusBadge
                  text={item.status === "active" ? "نشط" : "معطل"}
                  type={item.status === "active" ? "success" : "neutral"}
                />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.cardBackground }]}>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>إضافة حساب سنتر</Text>
              <AppInput label="الاسم" value={name} onChangeText={setName} />
              <AppInput
                label="البريد الإلكتروني"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <AppInput label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry />

              <View style={styles.roleRow}>
                {(["manager", "assistant"] as const)
                  .filter((accountRole) => user?.role !== "manager" || accountRole === "assistant")
                  .map((accountRole) => {
                  const active = role === accountRole;
                  return (
                    <TouchableOpacity
                      key={accountRole}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => setRole(accountRole)}
                      style={[
                        styles.role,
                        { borderColor: colors.border },
                        active && { backgroundColor: colors.primary, borderColor: colors.primary },
                      ]}
                    >
                      <Text style={[styles.roleText, { color: active ? colors.white : colors.textPrimary }]}>
                        {accountRole === "manager" ? "مدير" : "مساعد"}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[styles.permissionTitle, { color: colors.textPrimary }]}>الصلاحيات المتاحة لك</Text>
              <Text style={[styles.permissionHint, { color: colors.textSecondary }]}>
                لا يمكن منح الحساب صلاحيات لا يملكها مدير السنتر الحالي.
              </Text>
              {permissionGroups.map((group) => {
                const available = group.permissions.filter((permission) =>
                  managerPermissions.includes(permission.key),
                );
                if (!available.length) return null;
                return (
                  <View key={group.id} style={[styles.permissionGroup, { borderColor: colors.border }]}>
                    <Text style={[styles.permissionGroupTitle, { color: colors.textPrimary }]}>{group.title}</Text>
                    {available.map((permission) => {
                      const enabled = selectedPermissions.includes(permission.key);
                      return (
                        <TouchableOpacity
                          key={permission.key}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: enabled }}
                          onPress={() => changePermission(permission.key, !enabled)}
                          style={[styles.permissionOption, { borderTopColor: colors.border }]}
                        >
                          <View style={styles.permissionCopy}>
                            <View style={styles.permissionNameRow}>
                              <Text style={[styles.permissionName, { color: colors.textPrimary }]}>{permission.name}</Text>
                            </View>
                            <Text style={[styles.permissionEffect, { color: colors.textSecondary }]}>{permission.effect}</Text>
                          </View>
                          <Ionicons
                            name={enabled ? "checkmark-circle" : "ellipse-outline"}
                            size={19}
                            color={enabled ? colors.primary : colors.slate400}
                          />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })}

              <View style={styles.buttons}>
                <AppButton
                  title={saving ? "جارٍ الإضافة..." : "إضافة الحساب"}
                  onPress={() => void createAccount()}
                  disabled={saving || !canManage}
                  style={{ flex: 1 }}
                />
                <AppButton
                  title="إلغاء"
                  variant="outline"
                  onPress={() => setOpen(false)}
                  disabled={saving}
                  style={{ flex: 1 }}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: Spacing.lg, borderBottomWidth: 1 },
  back: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" },
  eyebrow: { fontSize: 11, fontWeight: "800" },
  title: { ...Typography.h1, marginTop: 2 },
  subtitle: { fontSize: 12, marginTop: 3, textAlign: "right" },
  content: { padding: Spacing.lg, paddingBottom: 32, flexGrow: 1 },
  loadingState: { alignItems: "center", justifyContent: "center", gap: 10, padding: Spacing.xl },
  loadingText: { fontSize: 13, textAlign: "center" },
  actionRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginBottom: Spacing.md },
  sectionTitle: { ...Typography.h3 },
  row: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: 14, borderWidth: 1, borderRadius: 16, marginBottom: 9 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowCopy: { flex: 1, alignItems: "flex-end" },
  nameText: { fontSize: 15, fontWeight: "900" },
  meta: { fontSize: 11, marginTop: 4, textAlign: "right" },
  error: { color: Colors.dangerText, textAlign: "right", marginBottom: 10 },
  emptyError: { alignItems: "center", gap: 8, padding: Spacing.lg },
  locked: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  lockedTitle: { fontSize: 16, fontWeight: "900", marginTop: 10, textAlign: "center" },
  lockedText: { textAlign: "center", marginTop: 6, lineHeight: 20 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.45)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 10, maxHeight: "92%" },
  sheetScroll: { flexGrow: 0 },
  sheetScrollContent: { gap: 10, paddingBottom: 8 },
  sheetTitle: { ...Typography.h2, textAlign: "right" },
  roleRow: { flexDirection: "row-reverse", gap: 8 },
  role: { flex: 1, alignItems: "center", padding: 11, borderWidth: 1, borderRadius: 10 },
  roleText: { fontWeight: "800" },
  permissionTitle: { fontWeight: "900", textAlign: "right", marginTop: 4 },
  permissionHint: { fontSize: 11, lineHeight: 17, textAlign: "right" },
  permissionGroup: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10 },
  permissionGroupTitle: { fontSize: 13, fontWeight: "900", textAlign: "right", paddingVertical: 8 },
  permissionOption: { flexDirection: "row-reverse", alignItems: "center", gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 9 },
  permissionCopy: { flex: 1, alignItems: "flex-end", gap: 3 },
  permissionNameRow: { flexDirection: "row-reverse", alignItems: "center", gap: 5 },
  permissionName: { fontSize: 12, fontWeight: "800", textAlign: "right" },
  permissionEffect: { fontSize: 10, lineHeight: 15, textAlign: "right" },
  buttons: { flexDirection: "row-reverse", gap: 8, marginTop: 8 },
});
