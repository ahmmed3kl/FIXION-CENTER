import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatTimeArabic } from "../../core/localization";
import { Colors, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { AbsenceReportsService, AbsenceSessionSummary } from "../../features/attendance/AbsenceReportsService";
import { SessionDateService } from "../../features/sessions/SessionDateService";
import { formatLocalDate } from "../../shared/utils/date";

export default function AbsenceGroupScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; groupName?: string; month?: string }>();
  const { activeCenterId } = useAuthStore();
  const [sessions, setSessions] = useState<AbsenceSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultMonth, setDefaultMonth] = useState("");
  const [monthWarning, setMonthWarning] = useState("");
  const routeMonth = String(params.month || "");
  const month = routeMonth || defaultMonth;
  const groupId = String(params.groupId || "");
  const groupName = String(params.groupName || "المجموعة");

  const resolveDefaultMonth = useCallback(() => {
    if (routeMonth) return;
    try {
      if (!activeCenterId) throw new Error("A center must be selected before resolving its report month.");
      setDefaultMonth(SessionDateService.getCurrentSessionMonth(activeCenterId));
      setMonthWarning("");
    } catch (error) {
      console.warn("Failed to resolve center month for absence group:", error);
      const now = new Date();
      setDefaultMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
      setMonthWarning(
        "تعذر تحديد الشهر الحالي وفق المنطقة الزمنية للمركز؛ يعرض شهر الجهاز كبداية.",
      );
    }
  }, [activeCenterId, routeMonth]);

  useFocusEffect(useCallback(() => {
    resolveDefaultMonth();
  }, [resolveDefaultMonth]));

  useEffect(() => {
    if (!month) return;
    try {
      setSessions(AbsenceReportsService.getSessionsForMonth(month).filter((item) => item.session.groupId === groupId).sort((a, b) => `${b.session.sessionDate}T${b.session.startTime}`.localeCompare(`${a.session.sessionDate}T${a.session.startTime}`)));
    } finally {
      setLoading(false);
    }
  }, [groupId, month]);

  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => router.back()}><Ionicons name="arrow-forward" size={22} color={colors.textPrimary} /></TouchableOpacity>
          <View style={styles.headerCopy}><Text style={styles.eyebrow}>تقارير الغياب</Text><Text style={styles.title}>{groupName}</Text><Text style={styles.subtitle}>كل حصص المجموعة، والأحدث أولاً</Text></View>
        </View>
        {monthWarning ? <Text style={{ color: colors.dangerText, textAlign: "right" }}>{monthWarning}</Text> : null}
        {loading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View> : sessions.length ? sessions.map((item) => <SessionCard key={item.session.id} item={item} styles={styles} />) : <View style={styles.empty}><Ionicons name="calendar-outline" size={30} color={colors.slate400} /><Text style={styles.emptyText}>لا توجد حصص مسجلة لهذه المجموعة في هذا الشهر.</Text></View>}
      </ScrollView>
    </SafeAreaView>
  );
}

function SessionCard({ item, styles }: { item: AbsenceSessionSummary; styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.card}><Text style={styles.sessionNumber}>الحصة رقم {item.sessionNumber ?? "—"}</Text><Text style={styles.date}>{formatLocalDate(item.session.sessionDate)} · {formatTimeArabic(item.session.startTime)} - {formatTimeArabic(item.session.endTime)}</Text><Text style={styles.meta}>{item.session.subjectName || ""} · {item.session.teacherName || "مدرس غير محدد"}</Text><View style={styles.counts}><Count label="الكل" value={item.total} color={styles.blue} /><Count label="حاضر" value={item.present} color={styles.green} /><Count label="غائب" value={item.absent} color={styles.red} /><Count label="تعويض" value={item.compensated} color={styles.purple} /></View></View>;
}

function Count({ label, value, color }: { label: string; value: number; color: object }) { return <View style={{ alignItems: "center", minWidth: 48 }}><Text style={[{ fontSize: 18, fontWeight: "900" }, color]}>{value}</Text><Text style={{ color: Colors.slate500, fontSize: 10 }}>{label}</Text></View>; }

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.background }, content: { padding: 16, gap: 10, paddingBottom: 30 }, header: { flexDirection: "row-reverse", alignItems: "center", gap: 12, marginBottom: 8 }, back: { width: 42, height: 42, borderRadius: 13, backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }, headerCopy: { flex: 1, alignItems: "flex-end" }, eyebrow: { color: colors.primary, fontSize: 11, fontWeight: "800" }, title: { color: colors.textPrimary, fontSize: 24, fontWeight: "900", marginTop: 2 }, subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 3 }, card: { backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 14, gap: 5 }, sessionNumber: { color: colors.primary, fontSize: 12, fontWeight: "900", textAlign: "right" }, date: { color: colors.textPrimary, fontSize: 14, fontWeight: "800", textAlign: "right" }, meta: { color: colors.textSecondary, fontSize: 11, textAlign: "right" }, counts: { flexDirection: "row-reverse", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9, marginTop: 5 }, blue: { color: colors.primary }, green: { color: colors.successText }, red: { color: colors.dangerText }, purple: { color: "#7C3AED" }, center: { padding: 45, alignItems: "center" }, empty: { alignItems: "center", gap: 8, paddingVertical: 50 }, emptyText: { color: colors.textSecondary, textAlign: "center", fontSize: 13 } });
