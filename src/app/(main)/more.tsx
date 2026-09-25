import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";

const items = [
  { label: "Sync Debug", route: "/(main)/sync-debug", icon: "bug-outline" as const },
  { label: "تبديل المركز", route: "/(main)/center-switch", icon: "business-outline" as const },
  { label: "الإدارة الأكاديمية", route: "/(main)/academic", icon: "school-outline" as const },
  { label: "رصد الدرجات", route: "/(main)/grades", icon: "reader-outline" as const },
  { label: "الباقات", route: "/(main)/packages", icon: "pricetags-outline" as const },
  { label: "الإغلاق اليومي", route: "/(main)/closing", icon: "lock-closed-outline" as const },
  { label: "الإشعارات", route: "/(main)/notifications", icon: "notifications-outline" as const },
  { label: "تقارير الغياب", route: "/(main)/absence-reports", icon: "document-text-outline" as const },
  { label: "التقارير", route: "/(main)/reports", icon: "bar-chart-outline" as const },
];

export default function MoreScreen() {
  const router = useRouter();
  const { colors, isDarkMode, toggleDarkMode } = useTheme();
  const logout = useAuthStore((state) => state.logout);
  const confirmLogout = () => Alert.alert("تسجيل الخروج", "هل تريد تسجيل الخروج من هذا الجهاز؟", [
    { text: "إلغاء", style: "cancel" },
    { text: "تسجيل الخروج", style: "destructive", onPress: () => logout() },
  ]);
  const surfaceText = isDarkMode ? "#0F172A" : colors.textPrimary;
  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}><ScrollView contentContainerStyle={styles.content}><Text style={[styles.title, { color: colors.textPrimary }]}>المزيد</Text><View style={[styles.themeRow, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}><View style={styles.themeCopy}><Ionicons name={isDarkMode ? "moon" : "sunny-outline"} size={22} color={colors.primary} /><Text style={[styles.themeTitle, { color: surfaceText }]}>الوضع الداكن</Text></View><Switch value={isDarkMode} onValueChange={toggleDarkMode} trackColor={{ false: colors.slate300, true: colors.primary }} thumbColor={colors.white} /></View>{items.map((item) => <TouchableOpacity key={item.route} style={[styles.item, { backgroundColor: colors.cardBackground, borderColor: colors.border }]} onPress={() => router.push(item.route as any)}><Ionicons name={item.icon} size={23} color={colors.primary} /><Text style={[styles.label, { color: surfaceText }]}>{item.label}</Text><Ionicons name="chevron-back" size={19} color={colors.slate400} /></TouchableOpacity>)}<TouchableOpacity style={[styles.logoutItem, { backgroundColor: isDarkMode ? colors.dangerLight : "#FFF1F2", borderColor: isDarkMode ? colors.danger : "#FECDD3" }]} onPress={confirmLogout}><Ionicons name="log-out-outline" size={23} color={colors.danger} /><Text style={[styles.logoutLabel, { color: colors.danger }]}>تسجيل الخروج</Text><Ionicons name="chevron-back" size={19} color={colors.danger} /></TouchableOpacity></ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1 }, content: { padding: Spacing.lg, gap: Spacing.sm }, title: { ...Typography.h2, marginBottom: Spacing.md, textAlign: "right" }, themeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderRadius: 14, padding: Spacing.md, marginBottom: Spacing.xs }, themeCopy: { flexDirection: "row", alignItems: "center", gap: Spacing.sm }, themeTitle: { fontSize: 16, fontWeight: "900", textAlign: "right" }, item: { flexDirection: "row", alignItems: "center", gap: Spacing.md, borderWidth: 1, borderRadius: 14, padding: Spacing.md }, label: { flex: 1, fontSize: 16, fontWeight: "800", textAlign: "right" }, logoutItem: { flexDirection: "row", alignItems: "center", gap: Spacing.md, borderWidth: 1, borderRadius: 14, padding: Spacing.md, marginTop: Spacing.md }, logoutLabel: { flex: 1, fontSize: 16, fontWeight: "900", textAlign: "right" } });
