import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { canSwitchCenters } from "../../features/auth/centerAccess";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { AppCard } from "../../shared/components";

export default function CenterSwitchScreen() {
  const router = useRouter();
  const { activeCenterId, availableCenters, currentUser, selectCenter } = useAuthStore();
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const [switchingCenterId, setSwitchingCenterId] = useState<string | null>(null);
  const canSwitch = canSwitchCenters(currentUser);

  useEffect(() => {
    if (!canSwitch) router.replace("/(main)/more" as any);
  }, [canSwitch, router]);

  const handleSelect = async (centerId: string) => {
    if (!canSwitch || centerId === activeCenterId || switchingCenterId) return;
    setSwitchingCenterId(centerId);
    try {
      await selectCenter(centerId);
      Alert.alert("تم بنجاح", "تم تبديل السنتر الحالي.", [{ text: "حسنًا", onPress: () => router.replace("/(main)/index" as any) }]);
    } catch (error: any) {
      Alert.alert("تعذر التبديل", error?.message || "لا يمكن تبديل السنتر حاليًا.");
    } finally {
      setSwitchingCenterId(null);
    }
  };

  if (!canSwitch) return null;

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></TouchableOpacity><Text style={styles.title}>تبديل السنتر</Text></View>
    {availableCenters.length < 2 ? <Text style={styles.empty}>لا يوجد سنتر آخر متاح لهذا الحساب.</Text> : availableCenters.map((center) => <TouchableOpacity key={center.id} onPress={() => handleSelect(center.id)} disabled={Boolean(switchingCenterId)}><AppCard style={[styles.card, center.id === activeCenterId && styles.selected]}><View><Text style={styles.name}>{center.name}</Text><Text style={styles.code}>{center.code}</Text></View><Text style={center.id === activeCenterId ? styles.active : styles.choose}>{center.id === activeCenterId ? "السنتر الحالي" : switchingCenterId === center.id ? "جارٍ التبديل..." : "اختيار"}</Text></AppCard></TouchableOpacity>)}
  </ScrollView></SafeAreaView>;
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: Spacing.lg, gap: Spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { ...Typography.h2, color: colors.textPrimary },
  back: { color: colors.primary, fontWeight: "700" },
  card: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: Spacing.lg },
  selected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primaryLight },
  name: { ...Typography.bodyBold, color: colors.textPrimary },
  code: { ...Typography.caption, color: colors.textSecondary, marginTop: 4 },
  active: { color: colors.primary, fontWeight: "700" },
  choose: { color: colors.textSecondary, fontWeight: "700" },
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: Spacing.xl },
});
