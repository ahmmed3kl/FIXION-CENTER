import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
    RefreshControl,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
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
import {
    AppCard,
    SyncIndicator
} from "../../shared/components";
import { ConnectivityState } from "../../shared/types";

export default function DashboardScreen() {
  const router = useRouter();
  const { currentUser, activeCenter, availableCenters, logout } =
    useAuthStore();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [syncStats, setSyncStats] = useState({ pending: 0 });
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
    await SyncEngine.syncCenterNow(activeCenter.id);
    ConnectivityService.setState("online");
    setConnectivity("online");
    loadData();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top App Header */}
      <View style={styles.headerBar}>
        <View style={styles.headerUser}>
          <Text style={styles.centerTitle}>
            {activeCenter?.name || "المركز التعليمي"}
          </Text>
          <View style={styles.userRoleRow}>
            <Text style={styles.userName}>{currentUser?.fullName}</Text>
            {availableCenters.length > 1 ? (
              <TouchableOpacity
                onPress={() => router.push("/(auth)/select-center")}
                style={styles.switchCenterBadge}
              >
                <Text style={styles.switchCenterText}>تبديل المركز</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <View style={styles.headerActions}>
          <SyncIndicator
            connectivity={connectivity}
            pendingCount={syncStats.pending}
            onPress={handleSyncNow}
          />
          <TouchableOpacity onPress={logout} style={styles.logoutIcon}>
            <Ionicons
              name="log-out-outline"
              size={22}
              color={Colors.slate600}
            />
          </TouchableOpacity>
        </View>
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
          <View style={styles.heroContent}>
            <View style={styles.heroIconWrapper}>
              <Ionicons name="scan" size={32} color={Colors.white} />
            </View>
            <View style={styles.heroTextWrapper}>
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
        <Text style={styles.sectionHeader}>{Strings.todaySummaryTitle}</Text>
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerUser: {
    flex: 1,
  },
  centerTitle: {
    ...Typography.h3,
    color: Colors.slate900,
  },
  userRoleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: 2,
  },
  userName: {
    ...Typography.caption,
    color: Colors.slate500,
  },
  switchCenterBadge: {
    backgroundColor: Colors.slate100,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  switchCenterText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.primary,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
  },
  logoutIcon: {
    padding: Spacing.xs,
  },
  scrollContent: {
    padding: Spacing.lg,
  },
  heroBanner: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
    ...Shadows.card,
  },
  heroContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  heroIconWrapper: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
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
  heroSubtitle: {
    ...Typography.caption,
    color: Colors.primaryLight,
    marginTop: 2,
  },
  sectionHeader: {
    ...Typography.bodyBold,
    color: Colors.slate800,
    marginBottom: Spacing.sm,
  },
  summaryCard: {
    padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  metricGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },
  metricBox: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
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
    padding: Spacing.md,
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
