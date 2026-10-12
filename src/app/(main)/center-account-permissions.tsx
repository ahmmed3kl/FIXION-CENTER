import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
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
  permissionGroups,
  sensitivePermissions,
  updateGroupPermissions,
  updateIndividualPermission,
} from "../../features/accounts/permissionCatalog";
import { AppButton } from "../../shared/components";

type CenterAccount = {
  id: string;
  fullName: string;
  email: string;
  role: "manager" | "assistant";
  status: string;
  permissions?: Permission[] | Record<string, boolean>;
};

export default function CenterAccountPermissionsScreen() {
  const router = useRouter();
  const { userId: routeUserId } = useLocalSearchParams<{ userId?: string | string[] }>();
  const userId = Array.isArray(routeUserId) ? routeUserId[0] : routeUserId;
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

  const [account, setAccount] = useState<CenterAccount | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);

  const loadAccount = useCallback(async (showLoading = true): Promise<boolean> => {
    if (!canManage || !centerContext || !userId) {
      setAccount(null);
      setLoadError(!canManage
        ? "لا تملك صلاحية إدارة حسابات السنتر."
        : "تعذر تحديد الحساب المطلوب.");
      setLoading(false);
      setRefreshing(false);
      return false;
    }
    if (showLoading) {
      setLoading(true);
      setAccount(null);
      setSelectedPermissions([]);
    }
    try {
      // The center-scoped collection endpoint is the available read API; the
      // target must be present in that response before it can be edited.
      const response = await ApiClient.getInstance().get<{ items: CenterAccount[] }>(
        "/center/users",
        requestConfig,
      );
      const found = (response.data.items || []).find((item) => item.id === userId) || null;
      setAccount(found);
      setSelectedPermissions(found
        ? resolveUserPermissions({ role: found.role, permissions: found.permissions })
        : []);
      setLoadError(found ? "" : "الحساب غير موجود ضمن حسابات السنتر الحالي.");
      return Boolean(found);
    } catch (error: any) {
      setLoadError(error?.userMessage || error?.message || "تعذر تحميل صلاحيات الحساب.");
      return false;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canManage, centerContext, requestConfig, userId]);

  useFocusEffect(useCallback(() => {
    void loadAccount();
  }, [loadAccount]));

  const originalPermissions = useMemo(
    () => account
      ? resolveUserPermissions({ role: account.role, permissions: account.permissions })
      : [],
    [account],
  );
  const addedPermissions = selectedPermissions.filter((permission) => !originalPermissions.includes(permission));
  const removedPermissions = originalPermissions.filter((permission) => !selectedPermissions.includes(permission));
  const hasChanges = addedPermissions.length > 0 || removedPermissions.length > 0;

  const refresh = async () => {
    setRefreshing(true);
    await loadAccount(false);
  };

  const savePermissions = async () => {
    if (!account || saving || !hasChanges) return;
    setSaving(true);
    try {
      await ApiClient.getInstance().patch(
        `/center/users/${account.id}`,
        { permissions: selectedPermissions },
        requestConfig,
      );
      setReviewOpen(false);
      setSuccessMessage("تم حفظ الصلاحيات. تم تحديث بيانات الحساب من السنتر.");
      const refreshed = await loadAccount(false);
      if (!refreshed) {
        setSuccessMessage("تم حفظ الصلاحيات، لكن تعذر تحديث البيانات المعروضة. أعد المحاولة للتأكد من أحدث حالة.");
      }
    } catch (error: any) {
      Alert.alert(
        "تعذر حفظ الصلاحيات",
        error?.userMessage || error?.message || "حاول مرة أخرى.",
      );
    } finally {
      setSaving(false);
    }
  };

  const permissionName = (key: Permission) =>
    permissionGroups.flatMap((group) => group.permissions).find((item) => item.key === key)?.name || key;

  if (!canManage) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <PageHeader onBack={() => router.back()} colors={colors} />
        <View style={styles.centerState}>
          <Ionicons name="lock-closed-outline" size={30} color={colors.textSecondary} />
          <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>هذه الخاصية غير متاحة لحسابك</Text>
          <Text style={[styles.stateText, { color: colors.textSecondary }]}>تواصل مع مسؤول السنتر لتفعيل صلاحية إدارة الحسابات.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <PageHeader onBack={() => router.back()} colors={colors} />
      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.stateText, { color: colors.textSecondary }]}>جارٍ تحميل صلاحيات الحساب...</Text>
        </View>
      ) : loadError && !account ? (
        <View style={styles.centerState}>
          <Ionicons name="alert-circle-outline" size={30} color={Colors.danger} />
          <Text style={[styles.stateText, { color: colors.dangerText }]}>{loadError}</Text>
          <AppButton title="إعادة المحاولة" variant="outline" onPress={() => void loadAccount()} />
        </View>
      ) : account ? (
        <>
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />
            }
          >
            <View style={[styles.accountCard, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
              <View style={[styles.accountIcon, { backgroundColor: colors.primaryLight }]}>
                <Ionicons name="person-outline" size={22} color={colors.primary} />
              </View>
              <View style={styles.accountCopy}>
                <Text style={[styles.accountName, { color: colors.textPrimary }]}>{account.fullName}</Text>
                <Text style={[styles.accountMeta, { color: colors.textSecondary }]}>
                  {account.email} · {account.role === "manager" ? "مدير" : "مساعد"}
                </Text>
                <Text style={[styles.accountMeta, { color: colors.textSecondary }]}>
                  {account.status === "active" ? "الحساب نشط" : "الحساب معطل"}
                </Text>
              </View>
            </View>

            <View style={[styles.notice, { backgroundColor: colors.primaryLight }]}>
              <Ionicons name="information-circle-outline" size={19} color={colors.primary} />
              <Text style={[styles.noticeText, { color: colors.textPrimary }]}>
                يمكنك منح الحساب الصلاحيات المتاحة لك فقط. الصلاحيات الحساسة تُضبط كل واحدة على حدة.
              </Text>
            </View>

            {loadError ? <Text style={styles.inlineError}>{loadError}</Text> : null}
            {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}

            {permissionGroups.map((group) => {
              const manageableKeys = group.permissions
                .map((item) => item.key)
                .filter((key) => managerPermissions.includes(key) && !sensitivePermissions.has(key));
              const selectedManageableCount = manageableKeys
                .filter((key) => selectedPermissions.includes(key)).length;
              const allManageableSelected = manageableKeys.length > 0 &&
                selectedManageableCount === manageableKeys.length;

              return (
                <View key={group.id} style={[styles.groupCard, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
                  <View style={styles.groupHeader}>
                    <View style={styles.groupHeaderCopy}>
                      <Text style={[styles.groupTitle, { color: colors.textPrimary }]}>{group.title}</Text>
                      <Text style={[styles.groupCount, { color: colors.textSecondary }]}>
                        {selectedManageableCount} من {manageableKeys.length} صلاحية متاحة لك
                      </Text>
                    </View>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={allManageableSelected ? `إلغاء صلاحيات مجموعة ${group.title}` : `تفعيل الصلاحيات المتاحة في ${group.title}`}
                      disabled={manageableKeys.length === 0}
                      onPress={() => {
                        setSelectedPermissions((current) =>
                          updateGroupPermissions(current, group.permissions.map((item) => item.key), !allManageableSelected, managerPermissions),
                        );
                        setSuccessMessage("");
                      }}
                      style={[
                        styles.groupAction,
                        { borderColor: colors.border },
                        manageableKeys.length === 0 && styles.disabledAction,
                      ]}
                    >
                      <Text style={[styles.groupActionText, { color: manageableKeys.length ? colors.primary : colors.textMuted }]}>
                        {allManageableSelected ? "إلغاء المتاح" : "تفعيل المتاح"}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {group.permissions.map((permission) => {
                    const enabled = selectedPermissions.includes(permission.key);
                    const canGrant = managerPermissions.includes(permission.key);
                    const sensitive = sensitivePermissions.has(permission.key);
                    return (
                      <View key={permission.key} style={[styles.permissionRow, { borderTopColor: colors.border }]}>
                        <View style={styles.permissionCopy}>
                          <View style={styles.permissionNameRow}>
                            <Text style={[styles.permissionName, { color: colors.textPrimary }]}>{permission.name}</Text>
                            {sensitive ? (
                              <View style={styles.sensitiveBadge}>
                                <Ionicons name="alert-circle-outline" size={12} color={Colors.warningText} />
                                <Text style={styles.sensitiveText}>حساسة</Text>
                              </View>
                            ) : null}
                          </View>
                          <Text style={[styles.permissionEffect, { color: colors.textSecondary }]}>{permission.effect}</Text>
                          {!canGrant && !enabled ? (
                            <Text style={styles.unavailableText}>غير متاحة ضمن صلاحياتك</Text>
                          ) : null}
                        </View>
                        <Switch
                          value={enabled}
                          disabled={!enabled && !canGrant}
                          onValueChange={(nextValue) => {
                            setSelectedPermissions((current) =>
                              updateIndividualPermission(current, permission.key, nextValue, managerPermissions),
                            );
                            setSuccessMessage("");
                          }}
                          trackColor={{ false: colors.slate300, true: colors.primary }}
                          thumbColor={colors.white}
                          accessibilityLabel={permission.name}
                          accessibilityHint={permission.effect}
                        />
                      </View>
                    );
                  })}
                </View>
              );
            })}

            <View style={styles.footer}>
              <Text style={[styles.pendingCount, { color: colors.textSecondary }]}>
                {hasChanges
                  ? `تغييرات غير محفوظة: إضافة ${addedPermissions.length} · إلغاء ${removedPermissions.length}`
                  : "لا توجد تغييرات غير محفوظة"}
              </Text>
              <AppButton
                title="مراجعة التغييرات"
                onPress={() => setReviewOpen(true)}
                disabled={!hasChanges || saving}
              />
            </View>
          </ScrollView>

          <Modal visible={reviewOpen} transparent animationType="fade" onRequestClose={() => setReviewOpen(false)}>
            <View style={styles.modalBackdrop}>
              <View style={[styles.reviewCard, { backgroundColor: colors.cardBackground }]}>
                <Text style={[styles.reviewTitle, { color: colors.textPrimary }]}>مراجعة تغييرات الصلاحيات</Text>
                <Text style={[styles.reviewSubtitle, { color: colors.textSecondary }]}>
                  راجع الإضافات والإلغاءات قبل حفظها لحساب {account.fullName}.
                </Text>
                <ScrollView style={styles.reviewList}>
                  {addedPermissions.length ? (
                    <>
                      <Text style={styles.addedHeading}>سيتم منحها ({addedPermissions.length})</Text>
                      {addedPermissions.map((key) => <ReviewItem key={key} label={permissionName(key)} added />)}
                    </>
                  ) : null}
                  {removedPermissions.length ? (
                    <>
                      <Text style={styles.removedHeading}>سيتم إلغاؤها ({removedPermissions.length})</Text>
                      {removedPermissions.map((key) => <ReviewItem key={key} label={permissionName(key)} />)}
                    </>
                  ) : null}
                </ScrollView>
                <View style={styles.reviewActions}>
                  <AppButton title={saving ? "جارٍ الحفظ..." : "تأكيد وحفظ"} onPress={() => void savePermissions()} disabled={saving} style={{ flex: 1 }} />
                  <AppButton title="رجوع للمراجعة" variant="outline" onPress={() => setReviewOpen(false)} disabled={saving} style={{ flex: 1 }} />
                </View>
              </View>
            </View>
          </Modal>
        </>
      ) : null}
    </SafeAreaView>
  );
}

function PageHeader({ onBack, colors }: { onBack: () => void; colors: ReturnType<typeof useTheme>["colors"] }) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="رجوع إلى حسابات السنتر"
        onPress={onBack}
        style={[styles.back, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}
      >
        <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
      </TouchableOpacity>
      <View style={styles.headerCopy}>
        <Text style={[styles.eyebrow, { color: colors.primary }]}>إدارة المركز</Text>
        <Text style={[styles.title, { color: colors.textPrimary }]}>صلاحيات الحساب</Text>
      </View>
    </View>
  );
}

function ReviewItem({ label, added }: { label: string; added?: boolean }) {
  return (
    <View style={styles.reviewItem}>
      <Ionicons name={added ? "add-circle-outline" : "remove-circle-outline"} size={17} color={added ? Colors.success : Colors.danger} />
      <Text style={styles.reviewItemText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: Spacing.lg, borderBottomWidth: 1 },
  back: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" },
  eyebrow: { fontSize: 11, fontWeight: "800" },
  title: { ...Typography.h1, marginTop: 2 },
  content: { padding: Spacing.lg, paddingBottom: 36, gap: Spacing.md },
  centerState: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.md, padding: Spacing.xl },
  stateTitle: { fontSize: 17, fontWeight: "900", textAlign: "center" },
  stateText: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  accountCard: { flexDirection: "row-reverse", alignItems: "center", gap: Spacing.md, borderWidth: 1, borderRadius: 16, padding: Spacing.md },
  accountIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  accountCopy: { flex: 1, alignItems: "flex-end", gap: 3 },
  accountName: { fontSize: 16, fontWeight: "900", textAlign: "right" },
  accountMeta: { fontSize: 12, textAlign: "right" },
  notice: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 8, padding: Spacing.md, borderRadius: 12 },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 19, textAlign: "right" },
  inlineError: { color: Colors.dangerText, textAlign: "right", fontSize: 13 },
  success: { color: Colors.successText, textAlign: "right", fontSize: 13, fontWeight: "700" },
  groupCard: { borderWidth: 1, borderRadius: 16, paddingHorizontal: Spacing.md },
  groupHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: Spacing.md },
  groupHeaderCopy: { flex: 1, alignItems: "flex-end", gap: 3 },
  groupTitle: { fontSize: 16, fontWeight: "900", textAlign: "right" },
  groupCount: { fontSize: 11, textAlign: "right" },
  groupAction: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7 },
  groupActionText: { fontSize: 11, fontWeight: "800" },
  disabledAction: { opacity: 0.5 },
  permissionRow: { flexDirection: "row-reverse", alignItems: "center", gap: 12, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 11 },
  permissionCopy: { flex: 1, alignItems: "flex-end", gap: 4 },
  permissionNameRow: { flexDirection: "row-reverse", alignItems: "center", flexWrap: "wrap", gap: 6 },
  permissionName: { fontSize: 13, fontWeight: "800", textAlign: "right" },
  permissionEffect: { fontSize: 11, lineHeight: 17, textAlign: "right" },
  unavailableText: { color: Colors.warningText, fontSize: 10, textAlign: "right" },
  sensitiveBadge: { flexDirection: "row-reverse", alignItems: "center", gap: 2, backgroundColor: Colors.warningLight, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 2 },
  sensitiveText: { color: Colors.warningText, fontSize: 9, fontWeight: "800" },
  footer: { gap: 10, marginTop: 4 },
  pendingCount: { fontSize: 12, textAlign: "center" },
  modalBackdrop: { flex: 1, justifyContent: "center", padding: Spacing.lg, backgroundColor: "rgba(15,23,42,0.55)" },
  reviewCard: { borderRadius: 20, padding: Spacing.lg, maxHeight: "80%" },
  reviewTitle: { fontSize: 18, fontWeight: "900", textAlign: "right" },
  reviewSubtitle: { fontSize: 13, lineHeight: 19, textAlign: "right", marginTop: 6 },
  reviewList: { marginTop: 12, marginBottom: 14 },
  addedHeading: { color: Colors.successText, textAlign: "right", fontWeight: "900", marginTop: 8, marginBottom: 4 },
  removedHeading: { color: Colors.dangerText, textAlign: "right", fontWeight: "900", marginTop: 12, marginBottom: 4 },
  reviewItem: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingVertical: 5 },
  reviewItemText: { color: Colors.slate800, fontSize: 13, textAlign: "right" },
  reviewActions: { flexDirection: "row-reverse", gap: 8 },
});
