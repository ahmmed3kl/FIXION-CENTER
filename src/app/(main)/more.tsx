import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";

const items = [
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
  const logout = useAuthStore((state) => state.logout);
  const confirmLogout = () => Alert.alert("تسجيل الخروج", "هل تريد تسجيل الخروج من هذا الجهاز؟", [
    { text: "إلغاء", style: "cancel" },
    { text: "تسجيل الخروج", style: "destructive", onPress: () => logout() },
  ]);
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}><Text style={styles.title}>المزيد</Text>{items.map((item) => <TouchableOpacity key={item.route} style={styles.item} onPress={() => router.push(item.route as any)}><Ionicons name={item.icon} size={23} color={Colors.primary} /><Text style={styles.label}>{item.label}</Text><Ionicons name="chevron-back" size={19} color={Colors.slate400} /></TouchableOpacity>)}<TouchableOpacity style={styles.logoutItem} onPress={confirmLogout}><Ionicons name="log-out-outline" size={23} color={Colors.danger} /><Text style={styles.logoutLabel}>تسجيل الخروج</Text><Ionicons name="chevron-back" size={19} color={Colors.danger} /></TouchableOpacity></ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.lg, gap: Spacing.sm }, title: { ...Typography.h2, color: Colors.slate900, marginBottom: Spacing.md, textAlign: "right" }, item: { flexDirection: "row", alignItems: "center", gap: Spacing.md, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: Spacing.md }, label: { flex: 1, color: Colors.slate800, fontSize: 16, fontWeight: "700", textAlign: "right" }, logoutItem: { flexDirection: "row", alignItems: "center", gap: Spacing.md, backgroundColor: "#FFF1F2", borderWidth: 1, borderColor: "#FECDD3", borderRadius: 14, padding: Spacing.md, marginTop: Spacing.md }, logoutLabel: { flex: 1, color: Colors.danger, fontSize: 16, fontWeight: "800", textAlign: "right" } });
