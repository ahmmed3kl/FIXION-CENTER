import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { canAccessRoute } from "../../core/permissions/routeAccess";
import { resolveUserPermissions } from "../../core/permissions";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";

const items = [
  { label: "مركز المزامنة", caption: "تابع العمليات والأخطاء", route: "/(main)/sync-debug", icon: "bug-outline" as const, tint: "#EEF2FF" },
  { label: "الإدارة الأكاديمية", caption: "المراحل والمدرسون والمجموعات", route: "/(main)/academic", icon: "school-outline" as const, tint: "#ECFDF5" },
  { label: "رصد الدرجات", caption: "الامتحانات ودرجات الطلاب", route: "/(main)/grade-groups", icon: "reader-outline" as const, tint: "#EFF6FF" },
  { label: "المجموعات", caption: "المجموعات والطلاب والجداول", route: "/(main)/groups", icon: "people-outline" as const, tint: "#ECFDF5" },
  { label: "حسابات السنتر", caption: "إدارة المديرين والمساعدين", route: "/(main)/center-accounts", icon: "shield-checkmark-outline" as const, tint: "#EEF2FF" },
  { label: "الطلاب المحذوفون", caption: "عرض الطلاب المحذوفين واسترجاعهم", route: "/(main)/deleted-students", icon: "archive-outline" as const, tint: "#FFF7ED" },
  { label: "الباقات", caption: "الاشتراكات والمواد", route: "/(main)/packages", icon: "pricetags-outline" as const, tint: "#FFF7ED" },
  { label: "الإشعارات", caption: "القوالب ورسائل SMS", route: "/(main)/notifications", icon: "notifications-outline" as const, tint: "#FFF1F2" },
  { label: "تقارير الغياب", caption: "تحليل حضور المجموعات", route: "/(main)/absence-reports", icon: "document-text-outline" as const, tint: "#ECFEFF" },
  { label: "التقارير", caption: "ملخصات الأداء والماليات", route: "/(main)/reports", icon: "bar-chart-outline" as const, tint: "#F0FDFA" },
  { label: "التقارير المالية", caption: "مديونية الطلاب حسب المدرس والمجموعة", route: "/(main)/financial-reports", icon: "wallet-outline" as const, tint: "#EFF6FF" },
  { label: "ترحيل الرصيد الافتتاحي", caption: "بدء النظام ببيانات سنتر قائمة", route: "/(main)/opening-balance", icon: "swap-horizontal-outline" as const, tint: "#F5F3FF" },
];

export default function MoreScreen() {
  const router = useRouter();
  const { colors, isDarkMode, toggleDarkMode } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const { width } = useWindowDimensions();
  const gridItemWidth = Math.max(0, Math.floor((width - Spacing.lg * 2 - 10) / 2));
  const logout = useAuthStore((state) => state.logout);
  const currentUser = useAuthStore((state) => state.currentUser);
  const userPermissions = resolveUserPermissions(currentUser);
  const canManageHomework = canAccessRoute("homework-evaluations", userPermissions);
  const canAdjustDebt = canAccessRoute("debt-adjustments", userPermissions);
  const confirmLogout = () => Alert.alert("تسجيل الخروج", "هل تريد تسجيل الخروج من هذا الجهاز؟", [
    { text: "إلغاء", style: "cancel" },
    { text: "تسجيل الخروج", style: "destructive", onPress: () => logout() },
  ]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View><Text style={[styles.eyebrow, { color: colors.primary }]}>إعدادات وإدارة</Text><Text style={[styles.title, { color: colors.textPrimary }]}>المزيد</Text><Text style={[styles.subtitle, { color: colors.textSecondary }]}>كل أدوات المركز في مكان واحد</Text></View>
          <View style={[styles.headerIcon, { backgroundColor: colors.primaryLight }]}><Ionicons name="grid-outline" size={25} color={colors.primary} /></View>
        </View>
        <View style={[styles.themeRow, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
          <View style={styles.themeCopy}><View style={[styles.themeIcon, { backgroundColor: isDarkMode ? colors.slate100 : colors.accentLight }]}><Ionicons name={isDarkMode ? "moon" : "sunny-outline"} size={18} color={isDarkMode ? colors.primary : colors.warningText} /></View><View><Text style={[styles.themeTitle, { color: colors.textPrimary }]}>الوضع الداكن</Text><Text style={[styles.themeHint, { color: colors.textSecondary }]}>{isDarkMode ? "مفعّل الآن" : "مفعّل عند الحاجة"}</Text></View></View>
          <Switch value={isDarkMode} onValueChange={toggleDarkMode} trackColor={{ false: colors.slate300, true: colors.primary }} thumbColor={colors.white}/>
        </View>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>أدوات المركز</Text>
        <View style={styles.grid}>{items.map((item) => {
          const routeName = item.route.split("/").pop() || "";
          const allowed = canAccessRoute(routeName, userPermissions);
          return <TouchableOpacity key={item.route} style={[styles.item, { width: gridItemWidth, backgroundColor: colors.cardBackground, borderColor: colors.border }]} onPress={() => allowed ? router.push(item.route as any) : Alert.alert("القسم مقفول", "لا تملك صلاحية الوصول إلى هذا القسم.")} activeOpacity={0.78} accessibilityState={{ disabled: !allowed }}><View style={[styles.itemIcon, { backgroundColor: isDarkMode ? colors.slate100 : item.tint }]}><Ionicons name={item.icon} size={22} color={allowed ? colors.primary : colors.slate400} /></View><View style={styles.itemCopy}><Text style={[styles.label, { color: allowed ? colors.textPrimary : colors.textSecondary }]}>{item.label}</Text><Text style={[styles.itemCaption, { color: colors.textSecondary }]} numberOfLines={1}>{allowed ? item.caption : "الصلاحية غير متاحة"}</Text></View><Ionicons name={allowed ? "chevron-back" : "lock-closed"} size={18} color={colors.slate400} /></TouchableOpacity>;
        })}</View>
        <TouchableOpacity style={[styles.item, { width: "100%", minHeight: 82, flexDirection: "row-reverse", alignItems: "center", gap: 12, backgroundColor: colors.cardBackground, borderColor: colors.border }]} onPress={() => canManageHomework ? router.push("/(main)/homework-evaluations" as any) : Alert.alert("القسم مقفول", "لا تملك صلاحية الوصول إلى هذا القسم.")} activeOpacity={0.78} accessibilityState={{ disabled: !canManageHomework }}><View style={[styles.itemIcon, { backgroundColor: isDarkMode ? colors.slate100 : "#ECFDF5" }]}><Ionicons name={canManageHomework ? "checkmark-circle-outline" : "lock-closed"} size={22} color={canManageHomework ? colors.primary : colors.slate400} /></View><View style={styles.itemCopy}><Text style={[styles.label, { color: canManageHomework ? colors.textPrimary : colors.textSecondary }]}>تقييم الواجب</Text><Text style={[styles.itemCaption, { color: colors.textSecondary }]} numberOfLines={1}>{canManageHomework ? "إدارة الحالات المتاحة لتقييم الواجب" : "الصلاحية غير متاحة"}</Text></View><Ionicons name={canManageHomework ? "chevron-back" : "lock-closed"} size={18} color={colors.slate400} /></TouchableOpacity>
        <TouchableOpacity style={[styles.item, { width: "100%", minHeight: 82, flexDirection: "row-reverse", alignItems: "center", gap: 12, backgroundColor: colors.cardBackground, borderColor: colors.border }]} onPress={() => canAdjustDebt ? router.push("/(main)/debt-adjustments" as any) : Alert.alert("القسم مقفول", "لا تملك صلاحية الوصول إلى هذا القسم.")} activeOpacity={0.78} accessibilityState={{ disabled: !canAdjustDebt }}><View style={[styles.itemIcon, { backgroundColor: isDarkMode ? colors.slate100 : "#FFF7ED" }]}><Ionicons name={canAdjustDebt ? "shield-checkmark-outline" : "lock-closed"} size={22} color={canAdjustDebt ? colors.primary : colors.slate400} /></View><View style={styles.itemCopy}><Text style={[styles.label, { color: canAdjustDebt ? colors.textPrimary : colors.textSecondary }]}>تعديل المديونية</Text><Text style={[styles.itemCaption, { color: colors.textSecondary }]} numberOfLines={1}>{canAdjustDebt ? "تصفير المستحق مع تسجيل السبب" : "الصلاحية غير متاحة"}</Text></View><Ionicons name={canAdjustDebt ? "chevron-back" : "lock-closed"} size={18} color={colors.slate400} /></TouchableOpacity>
        <TouchableOpacity style={[styles.logoutItem, { backgroundColor: isDarkMode ? colors.dangerLight : "#FFF1F2", borderColor: isDarkMode ? colors.danger : "#FECDD3" }]} onPress={confirmLogout} activeOpacity={0.8}><View style={styles.logoutIcon}><Ionicons name="log-out-outline" size={21} color={colors.danger} /></View><Text style={[styles.logoutLabel, { color: colors.danger }]}>تسجيل الخروج</Text><Ionicons name="chevron-back" size={19} color={colors.danger} /></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = () => StyleSheet.create({
  safe: { flex: 1 }, content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }, headerIcon: { width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center" }, eyebrow: { fontSize: 12, fontWeight: "800", textAlign: "right" }, title: { ...Typography.h1, textAlign: "right", marginTop: 2 }, subtitle: { fontSize: 12, textAlign: "right", marginTop: 3 }, themeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderRadius: 18, padding: 13 }, themeCopy: { flexDirection: "row", alignItems: "center", gap: 10 }, themeIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" }, themeTitle: { fontSize: 15, fontWeight: "900", textAlign: "right" }, themeHint: { fontSize: 11, textAlign: "right", marginTop: 2 }, sectionTitle: { fontSize: 15, fontWeight: "900", textAlign: "right", marginTop: 5 }, grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 }, item: { minHeight: 118, borderWidth: 1, borderRadius: 17, padding: 12, justifyContent: "space-between" }, itemIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" }, itemCopy: { marginTop: 8 }, label: { fontSize: 14, fontWeight: "900", textAlign: "right" }, itemCaption: { fontSize: 10, textAlign: "right", marginTop: 3 }, logoutItem: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 16, padding: 13, marginTop: 4 }, logoutIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(239,68,68,0.12)" }, logoutLabel: { flex: 1, fontSize: 15, fontWeight: "900", textAlign: "right" },
});
