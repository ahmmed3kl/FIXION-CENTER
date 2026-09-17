import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectivityService } from "../../core/connectivity";
import { Strings, formatCurrency, formatNumber } from "../../core/localization";
import { SyncEngine, SyncRepository } from "../../core/sync";
import {
    BorderRadius,
    Colors,
    Shadows,
    Spacing,
    Typography,
} from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import {
    DashboardService,
    DashboardSummary,
} from "../../features/dashboard/DashboardService";
import { AppCard } from "../../shared/components";
import { ConnectivityState } from "../../shared/types";

export default function DashboardScreen() {
  const router = useRouter();
  const { currentUser, activeCenter, availableCenters } =
    useAuthStore();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [syncStats, setSyncStats] = useState({ pending: 0, syncing: 0, synced: 0, failed: 0, conflict: 0, total: 0 });
  const [connectivity, setConnectivity] =
    useState<ConnectivityState>("offline");
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(() => {
    if (!activeCenter) return;
    try {
      const s = DashboardService.getTodaySummary();
      setSummary(s);

      const stats = SyncRepository.getStats(activeCenter.id);
      setSyncStats(stats);
      setConnectivity(ConnectivityService.getState());
    } catch (e) {
      console.error("Error loading dashboard data:", e);
    }
  }, [activeCenter]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  useEffect(() => {
    const unsubscribe = ConnectivityService.subscribe(setConnectivity);
    const refreshTimer = setInterval(loadData, 2000);
    return () => {
      unsubscribe();
      clearInterval(refreshTimer);
    };
  }, [loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    if (activeCenter) {
      await SyncEngine.syncCenterNow(activeCenter.id).catch(console.error);
    }
    loadData();
    setRefreshing(false);
  };

  const handleSyncNow = async () => {
    if (!activeCenter) return;
    ConnectivityService.setState("syncing");
    setConnectivity("syncing");
    const result = await SyncEngine.syncCenterNow(activeCenter.id);
    const nextState = result.state === "error" ? "offline" : result.state;
    ConnectivityService.setState(nextState);
    setConnectivity(nextState);
    loadData();
  };

  const syncState = connectivity === "syncing"
    ? "syncing"
    : syncStats.failed > 0 || syncStats.conflict > 0
      ? "error"
      : connectivity === "online" && syncStats.pending === 0
        ? "online"
        : connectivity === "offline"
          ? "offline"
          : "syncing";
  const syncLabel = syncState === "online"
    ? "متزامن"
    : syncState === "offline"
      ? "غير متصل"
      : syncState === "error"
        ? "مشكلة مزامنة"
        : "جاري المزامنة";
  const syncIcon = syncState === "online"
    ? "cloud-done-outline"
    : syncState === "offline"
      ? "cloud-offline-outline"
      : syncState === "error"
        ? "warning-outline"
        : "sync-outline";

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top App Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity style={styles.syncStatusButton} onPress={handleSyncNow}>
          <Ionicons name={syncIcon as any} size={17} color={syncState === "online" ? "#A7F3D0" : "#FFE08A"} />
          <Text style={styles.syncStatusText}>{syncLabel}</Text>
          {syncStats.pending > 0 ? <Text style={styles.syncPendingText}>({syncStats.pending})</Text> : null}
        </TouchableOpacity>
        <View style={styles.brandLockup}>
          <Text style={styles.brandWord}>FIXION</Text>
          <Text style={styles.brandTagline}>For a smarter education</Text>
        </View>
        <TouchableOpacity
          style={styles.centerSelector}
          onPress={() => availableCenters.length > 1 && router.push("/(main)/center-switch")}
        >
          <Ionicons name="business-outline" size={15} color="#D9F5FF" />
          <Text style={styles.centerSelectorText} numberOfLines={1}>{activeCenter?.name || "المركز التعليمي"}</Text>
          <Ionicons name="chevron-down" size={13} color="#A9D8EA" />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* HERO ACTION: SCAN CARD */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push("/(main)/scanner")}
          style={styles.heroBanner}
        >
          <View style={styles.heroGlow} />
          <View style={styles.heroContent}>
            <View style={styles.heroIconWrapper}>
              <Ionicons name="scan" size={32} color={Colors.white} />
            </View>
            <View style={styles.heroTextWrapper}>
              <Text style={styles.heroEyebrow}>الوصول السريع</Text>
              <Text style={styles.heroTitle}>
                {Strings.quickScanHeroButton}
              </Text>
              <Text style={styles.heroSubtitle}>
                تسجيل حضور فوري بالباركود أو الكود اليدوي
              </Text>
            </View>
            <Ionicons name="chevron-back" size={24} color={Colors.white} />
          </View>
        </TouchableOpacity>

        {/* TODAY SUMMARY CARD */}
        <View style={styles.sectionHeadingRow}>
          <Text style={styles.sectionHeader}>{Strings.todaySummaryTitle}</Text>
          <View style={styles.todayBadge}><Ionicons name="calendar-outline" size={14} color={Colors.primary} /><Text style={styles.todayBadgeText}>اليوم</Text></View>
        </View>
        <AppCard style={styles.summaryCard}>
          <View style={styles.metricGrid}>
            <View
              style={[
                styles.metricBox,
                { backgroundColor: Colors.primaryLight },
              ]}
            >
              <Text
                style={[styles.metricNumber, { color: Colors.primaryDark }]}
              >
                {formatNumber(summary?.expectedCount || 0)}
              </Text>
              <Text style={[styles.metricLabel, { color: Colors.primaryDark }]}>
                {Strings.expectedAttendance}
              </Text>
            </View>

            <View
              style={[
                styles.metricBox,
                { backgroundColor: Colors.successLight },
              ]}
            >
              <Text
                style={[styles.metricNumber, { color: Colors.successText }]}
              >
                {formatNumber(summary?.presentCount || 0)}
              </Text>
              <Text style={[styles.metricLabel, { color: Colors.successText }]}>
                {Strings.presentAttendance}
              </Text>
            </View>

            <View
              style={[
                styles.metricBox,
                { backgroundColor: Colors.warningLight },
              ]}
            >
              <Text
                style={[styles.metricNumber, { color: Colors.warningText }]}
              >
                {formatNumber(summary?.lateCount || 0)}
              </Text>
              <Text style={[styles.metricLabel, { color: Colors.warningText }]}>
                {Strings.lateAttendance}
              </Text>
            </View>

            <View
              style={[
                styles.metricBox,
                { backgroundColor: Colors.dangerLight },
              ]}
            >
              <Text style={[styles.metricNumber, { color: Colors.dangerText }]}>
                {formatNumber(summary?.absentCount || 0)}
              </Text>
              <Text style={[styles.metricLabel, { color: Colors.dangerText }]}>
                {Strings.absentAttendance}
              </Text>
            </View>
          </View>
        </AppCard>

        {/* FINANCIAL & SESSIONS ROW */}
        <View style={styles.twoColumnRow}>
          {/* Today Collections */}
          <AppCard style={styles.halfCard}>
            <View style={styles.cardHeaderRow}>
              <Ionicons name="cash-outline" size={20} color={Colors.success} />
              <Text style={styles.cardTitle}>
                {Strings.todayCollectionsTitle}
              </Text>
            </View>
            <Text style={styles.financialAmount}>
              {formatCurrency(summary?.todayCollections || 0)}
            </Text>
          </AppCard>

          {/* Today Sessions */}
          <AppCard style={styles.halfCard}>
            <View style={styles.cardHeaderRow}>
              <Ionicons
                name="calendar-outline"
                size={20}
                color={Colors.primary}
              />
              <Text style={styles.cardTitle}>{Strings.todaySessionsTitle}</Text>
            </View>
            <View style={styles.sessionStatusRow}>
              <Text style={styles.sessionStatusText}>
                {Strings.openSessions}:{" "}
                {formatNumber(summary?.openSessions || 0)}
              </Text>
              <Text style={styles.sessionStatusTextMuted}>
                {Strings.closedSessions}:{" "}
                {formatNumber(summary?.closedSessions || 0)}
              </Text>
            </View>
          </AppCard>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  headerBar: {
    paddingHorizontal: Spacing.lg,
    height: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: "#062D49",
    borderBottomWidth: 1,
    borderBottomColor: "#0D5478",
    direction: "ltr",
  },
  syncStatusButton: {
    minWidth: 102,
    height: 34,
    borderRadius: 17,
    paddingHorizontal: 10,
    backgroundColor: "#0B4568",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  syncStatusText: { color: Colors.white, fontSize: 11, fontWeight: "700" },
  syncPendingText: { color: "#FFE08A", fontSize: 10, fontWeight: "800" },
  brandLockup: { width: 82, alignItems: "flex-start", direction: "ltr" },
  brandWord: { color: Colors.white, fontSize: 19, fontWeight: "900", letterSpacing: 1.2 },
  brandTagline: { color: "#89B6C9", fontSize: 5.5, letterSpacing: 0.3, marginTop: -1 },
  centerSelector: {
    flex: 1,
    maxWidth: 175,
    minWidth: 120,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: "#0B4568",
    borderWidth: 1,
    borderColor: "#17658D",
  },
  centerSelectorText: { color: Colors.white, fontSize: 11, fontWeight: "700", flexShrink: 1, textAlign: "center", writingDirection: "rtl" },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  logoutButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#B4233D",
    alignItems: "center",
    justifyContent: "center",
  },
  headerIconButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "#0B4568",
    alignItems: "center",
    justifyContent: "center",
  },
  notificationBadge: { position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, backgroundColor: "#F0445E", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#062D49" },
  notificationBadgeText: { color: Colors.white, fontSize: 9, fontWeight: "800" },
  avatarButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#D8F2FF", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#0B4568", fontSize: 11, fontWeight: "900" },
  scrollContent: {
    padding: Spacing.lg,
    paddingBottom: Spacing.xxxl,
  },
  heroBanner: {
    backgroundColor: Colors.primaryDark,
    borderRadius: 24,
    padding: Spacing.xl,
    marginBottom: Spacing.xl,
    minHeight: 142,
    overflow: "hidden",
    ...Shadows.elevated,
  },
  heroGlow: { position: "absolute", width: 180, height: 180, borderRadius: 90, backgroundColor: "rgba(96,165,250,0.22)", left: -55, top: -75 },
  heroContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  heroIconWrapper: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: Spacing.md,
  },
  heroTextWrapper: {
    flex: 1,
  },
  heroTitle: {
    ...Typography.h2,
    color: Colors.white,
  },
  heroEyebrow: { color: "#BFDBFE", fontSize: 11, fontWeight: "700", marginBottom: 3, textAlign: "right" },
  heroSubtitle: {
    ...Typography.caption,
    color: Colors.primaryLight,
    marginTop: 2,
  },
  sectionHeader: {
    ...Typography.bodyBold,
    color: Colors.slate800,
    marginBottom: 0,
  },
  sectionHeadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: Spacing.sm },
  todayBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: Colors.primaryLight, borderRadius: BorderRadius.full, paddingHorizontal: 10, paddingVertical: 5 },
  todayBadgeText: { fontSize: 11, fontWeight: "700", color: Colors.primaryDark },
  summaryCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    borderRadius: BorderRadius.xl,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },
  metricBox: {
    width: "48%",
    minHeight: 86,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  metricNumber: {
    fontSize: 22,
    fontWeight: "800",
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  twoColumnRow: {
    flexDirection: "row",
    gap: Spacing.md,
  },
  halfCard: {
    flex: 1,
    padding: Spacing.lg,
    minHeight: 118,
    borderRadius: BorderRadius.xl,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  cardTitle: {
    ...Typography.captionBold,
    color: Colors.slate700,
  },
  financialAmount: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.successText,
    marginTop: Spacing.xs,
  },
  sessionStatusRow: {
    marginTop: Spacing.xs,
  },
  sessionStatusText: {
    ...Typography.captionBold,
    color: Colors.primaryDark,
  },
  sessionStatusTextMuted: {
    ...Typography.caption,
    color: Colors.slate500,
    marginTop: 2,
  },
});
