import { useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { AppCard } from "../../shared/components";

export default function CenterSwitchScreen() {
  const router = useRouter();
  const { activeCenterId, availableCenters, selectCenter } = useAuthStore();

  const handleSelect = async (centerId: string) => {
    if (centerId === activeCenterId) return;
    try {
      await selectCenter(centerId);
      Alert.alert("تم بنجاح", "تم تبديل السنتر الحالي.", [{ text: "حسنًا", onPress: () => router.replace("/(main)") }]);
    } catch (error: any) {
      Alert.alert("تعذر التبديل", error?.message || "لا يمكن تبديل السنتر حاليًا.");
    }
  };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></TouchableOpacity><Text style={styles.title}>تبديل السنتر</Text></View>
    {availableCenters.length < 2 ? <Text style={styles.empty}>لا يوجد سنتر آخر متاح لهذا الحساب.</Text> : availableCenters.map((center) => <TouchableOpacity key={center.id} onPress={() => handleSelect(center.id)}><AppCard style={[styles.card, center.id === activeCenterId && styles.selected]}><View><Text style={styles.name}>{center.name}</Text><Text style={styles.code}>{center.code}</Text></View><Text style={center.id === activeCenterId ? styles.active : styles.choose}>{center.id === activeCenterId ? "السنتر الحالي" : "اختيار"}</Text></AppCard></TouchableOpacity>)}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.lg, gap: Spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { ...Typography.h2, color: Colors.slate900 },
  back: { color: Colors.primary, fontWeight: "700" },
  card: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: Spacing.lg },
  selected: { borderColor: Colors.primary, borderWidth: 2, backgroundColor: Colors.primaryMuted },
  name: { ...Typography.bodyBold, color: Colors.slate900 },
  code: { ...Typography.caption, color: Colors.slate500, marginTop: 4 },
  active: { color: Colors.primary, fontWeight: "700" },
  choose: { color: Colors.slate600, fontWeight: "700" },
  empty: { color: Colors.slate600, textAlign: "center", marginTop: Spacing.xl },
});
