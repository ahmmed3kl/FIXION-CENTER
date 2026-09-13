import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Colors, Spacing, Typography } from "../../core/theme";

const items = [
  { label: "تبديل السنتر", route: "/(main)/center-switch", icon: "business-outline" as const },
  { label: "الإدارة الأكاديمية", route: "/(main)/academic", icon: "school-outline" as const },
  { label: "الباقات", route: "/(main)/packages", icon: "pricetags-outline" as const },
  { label: "الإغلاق اليومي", route: "/(main)/closing", icon: "lock-closed-outline" as const },
  { label: "الإشعارات", route: "/(main)/notifications", icon: "notifications-outline" as const },
  { label: "التقارير", route: "/(main)/reports", icon: "bar-chart-outline" as const },
];

export default function MoreScreen() {
  const router = useRouter();
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}><Text style={styles.title}>المزيد</Text>{items.map((item) => <TouchableOpacity key={item.route} style={styles.item} onPress={() => router.push(item.route as any)}><Ionicons name={item.icon} size={24} color={Colors.primary} /><Text style={styles.label}>{item.label}</Text><Ionicons name="chevron-back" size={20} color={Colors.slate400} /></TouchableOpacity>)}</ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.lg, gap: Spacing.sm }, title: { ...Typography.h2, color: Colors.slate900, marginBottom: Spacing.md, textAlign: "right" }, item: { flexDirection: "row", alignItems: "center", gap: Spacing.md, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: Spacing.md }, label: { flex: 1, color: Colors.slate800, fontSize: 16, fontWeight: "700", textAlign: "right" } });
