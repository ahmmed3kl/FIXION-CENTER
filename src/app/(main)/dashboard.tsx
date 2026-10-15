import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Image,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectivityService } from "../../core/connectivity";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { Strings, formatCurrency, formatNumber } from "../../core/localization";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import {
    BorderRadius,
    Colors,
    Shadows,
    Spacing,
    Typography,
    useTheme,
} from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import {
    DashboardService,
    DashboardSummary,
} from "../../features/dashboard/DashboardService";
import { CenterTimeZoneConfigurationError } from "../../features/sessions/SessionDateService";
import { AppCard } from "../../shared/components";
import { ConnectivityState } from "../../shared/types";

const DASHBOARD_NAVY = "#0F172A";

export default function DashboardScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const { currentUser, activeCenter, activeCenterId } =
    useAuthStore();
  const accountName = currentUser?.fullName?.trim();
  const activeCenterName = activeCenter?.name?.trim() || "المركز التعليمي";
  const today = new Date();
  const formatArabicDatePart = (value: number) =>
    new Intl.NumberFormat("ar-EG", { minimumIntegerDigits: 2, useGrouping: false }).format(value);
  const todayLabel = `${today.toLocaleDateString("ar-EG", { weekday: "long" })} ${formatArabicDatePart(today.getDate())}/${formatArabicDatePart(today.getMonth() + 1)}/${formatArabicDatePart(today.getFullYear())}`;
  const userPermissions = resolveUserPermissions(currentUser);
  const canCreateAttendance = PermissionService.hasPermission(userPermissions, "attendance.create");
  const canViewAttendance = PermissionService.hasAnyPermission(userPermissions, ["attendance.view", "attendance.create"]);
  const canViewFinance = PermissionService.hasAnyPermission(userPermissions, ["payments.view", "reports.financial.view"]);
  const canViewSessions = PermissionService.hasAnyPermission(userPermissions, ["sessions.view", "attendance.view"]);
  const canManageSync = PermissionService.hasPermission(userPermissions, "sync.manage");
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [syncStats, setSyncStats] = useState({ pending: 0, syncing: 0, synced: 0, failed: 0, conflict: 0, total: 0 });
  const [connectivity, setConnectivity] =
    useState<ConnectivityState>("offline");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingWarningDismissed, setPendingWarningDismissed] = useState(false);

  const loadData = useCallback(() => {
    // The persisted center id is restored before the display object is
    // hydrated. Use the id as the readiness signal so the dashboard does not
    // render a false all-zero snapshot during app startup.
    if (!activeCenterId) return;
    if (canViewAttendance || canViewFinance || canViewSessions) {
      try {
        setSummary(DashboardService.getTodaySummary());
        setSummaryError(null);
      } catch (error) {
        setSummary(null);
        if (error instanceof CenterTimeZoneConfigurationError) {
          setSummaryError(
            error.issue === "missing"
              ? "المنطقة الزمنية للمركز غير مضبوطة. اطلب من مسؤول المنصة تحديد منطقة IANA الصحيحة من صفحة تفاصيل المركز، مثل Africa/Cairo. لن يستخدم التطبيق توقيت الجهاز بدلًا منها."
              : "المنطقة الزمنية المسجلة للمركز غير صالحة. اطلب من مسؤول المنصة تصحيحها من صفحة تفاصيل المركز.",
          );
        } else {
          console.error("Error loading dashboard summary:", error);
          setSummaryError("تعذر تحميل ملخص اليوم. اسحب للتحديث أو تحقق من قاعدة البيانات المحلية.");
        }
      }
    } else {
      setSummary(null);
      setSummaryError(null);
    }

    try {
      const stats = SyncRepository.getStats(activeCenterId);
      setSyncStats(stats);
      setConnectivity(ConnectivityService.getState());
    } catch (error) {
      console.error("Error loading dashboard sync data:", error);
    }
  }, [activeCenterId, canViewAttendance, canViewFinance, canViewSessions]);

  useFocusEffect(
    useCallback(() => {
      if (!hasInitialLoadedRef.current || lastLoadedRevisionRef.current !== localDataRevision) {
        hasInitialLoadedRef.current = true;
        lastLoadedRevisionRef.current = localDataRevision;
        loadData();
      }
    }, [loadData, localDataRevision]),
  );

  useEffect(() => {
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      loadData();
    }
  }, [localDataRevision, loadData]);

  useEffect(() => {
    const unsubscribe = ConnectivityService.subscribe(setConnectivity);
    return () => {
      unsubscribe();
    };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    if (activeCenterId && canManageSync) {
      await SyncEngine.syncCenterNow(activeCenterId).catch(console.error);
    }
    loadData();
    setRefreshing(false);
  };

  const handleSyncNow = async () => {
    if (!activeCenterId || !canManageSync) return;
    ConnectivityService.setState("syncing");
    setConnectivity("syncing");
    const result = await SyncEngine.syncCenterNow(activeCenterId);
    const nextState = result.state === "error" ? "degraded" : result.state;
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
    <SafeAreaView edges={["top"]} style={[styles.safeArea, { backgroundColor: DASHBOARD_NAVY }]}>
      <View style={[styles.headerBar, { backgroundColor: DASHBOARD_NAVY }]}>
        <View style={styles.brandLockup}>
          <Image
            source={require("../../../assets/images/fixion-dashboard-logo.png")}
            resizeMode="contain"
            accessibilityLabel="FIXION"
            style={styles.brandLogo}
          />
        </View>
        <TouchableOpacity
          style={[
            styles.syncStatusButton,
            syncState === "online" ? styles.syncStatusOnline : null,
            syncState === "error" ? styles.syncStatusError : null,
          ]}
          onPress={handleSyncNow}
          disabled={!canManageSync}
          accessibilityState={{ disabled: !canManageSync }}
        >
          <Ionicons
            name={syncIcon as any}
            size={16}
            color={syncState === "online" ? "#A7F3D0" : syncState === "error" ? "#FCA5A5" : "#FFE08A"}
          />
          <Text style={styles.syncStatusText}>{syncLabel}</Text>
          {syncStats.pending > 0 ? <Text style={styles.syncPendingText}>({syncStats.pending})</Text> : null}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.dashboardScroll}
        contentContainerStyle={[
          styles.scrollContent,
          { maxWidth: windowWidth >= 720 ? 680 : undefined },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.greetingRow}>
          <View style={styles.greetingCopy}>
            <Text style={styles.greetingTitle}>
              {accountName
                ? <>أهلًا، <Text style={styles.greetingName}>{accountName}</Text></>
                : "أهلًا بك"}
            </Text>
            <Text style={styles.greetingSubtitle} numberOfLines={1}>
              يوم موفق • <Text>{`\u2068${activeCenterName}\u2069`}</Text>
            </Text>
          </View>
        </View>

        {summaryError ? (
          <View style={styles.warningBanner}>
            <View style={styles.warningContent}>
              <Ionicons name="warning-outline" size={24} color="#F59E0B" />
              <View style={styles.warningTextWrapper}>
                <Text style={styles.warningTitle}>ملخص اليوم غير متاح</Text>
                <Text style={styles.warningText}>{summaryError}</Text>
              </View>
            </View>
          </View>
        ) : null}

        {canCreateAttendance ? <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push("/(main)/scanner")}
          style={styles.heroBanner}
        >
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
        </TouchableOpacity> : null}

        {/* PENDING SYNC WARNING */}
        {syncStats.pending > 0 && connectivity === "offline" && !pendingWarningDismissed && (
          <View style={styles.warningBanner}>
            <View style={styles.warningContent}>
              <Ionicons name="warning" size={24} color="#F59E0B" />
              <View style={styles.warningTextWrapper}>
                <Text style={styles.warningTitle}>تحذير: بيانات غير متزامنة</Text>
                <Text style={styles.warningText}>
                  لديك {syncStats.pending} عملية معلقة لم تُرفع للخادم بعد.{"\n"}
                  تأكد من الاتصال بالإنترنت قبل إلغاء تثبيت التطبيق أو عمل build جديد، وإلا ستفقد البيانات المحلية.
                </Text>
                <TouchableOpacity
                  style={styles.warningSyncButton}
                  onPress={handleSyncNow}
                >
                  <Ionicons name="sync" size={16} color={Colors.white} />
                  <Text style={styles.warningSyncButtonText}>محاولة المزامنة الآن</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.warningDismiss}
                onPress={() => setPendingWarningDismissed(true)}
              >
                <Ionicons name="close" size={20} color="#9CA3AF" />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* TODAY SUMMARY CARD */}
        {canViewAttendance && summary ? <>
        <AppCard style={styles.summaryCard}>
          <View style={styles.sectionHeadingRow}>
            <View style={styles.sectionTitleGroup}>
              <Ionicons name="stats-chart" size={17} color={Colors.primary} />
              <Text style={styles.sectionHeader}>{Strings.todaySummaryTitle}</Text>
            </View>
            <View style={styles.todayBadge}><Ionicons name="calendar-outline" size={14} color={Colors.primary} /><Text style={styles.todayBadgeText} numberOfLines={1}>{todayLabel}</Text></View>
          </View>
          <View style={styles.metricGrid}>
            <MetricTile
              styles={styles}
              icon="calendar"
              label={Strings.expectedAttendance}
              value={formatNumber(summary.expectedCount)}
              color={Colors.primary}
              textColor={Colors.primaryDark}
              backgroundColor={Colors.primaryMuted}
            />
            <MetricTile
              styles={styles}
              icon="people"
              label={Strings.presentAttendance}
              value={formatNumber(summary.presentCount)}
              color={Colors.success}
              textColor={Colors.successText}
              backgroundColor={Colors.successLight}
            />
            <MetricTile
              styles={styles}
              icon="time"
              label={Strings.lateAttendance}
              value={formatNumber(summary.lateCount)}
              color={Colors.warning}
              textColor={Colors.warningText}
              backgroundColor={Colors.warningLight}
            />
            <MetricTile
              styles={styles}
              icon="close-circle"
              label={Strings.absentAttendance}
              value={formatNumber(summary.absentCount)}
              color={Colors.danger}
              textColor={Colors.dangerText}
              backgroundColor={Colors.dangerLight}
            />
            <MetricTile
              styles={styles}
              icon="repeat"
              label="لم تُحسم"
              value={formatNumber(summary.unresolvedCount)}
              color={Colors.primary}
              textColor={Colors.primaryDark}
              backgroundColor={Colors.primaryMuted}
            />
            <MetricTile
              styles={styles}
              icon="repeat"
              label="تعويض"
              value={formatNumber(summary.makeupCount)}
              color={Colors.warning}
              textColor={Colors.warningText}
              backgroundColor={Colors.warningLight}
              wide
            />
          </View>
        </AppCard>
        </> : null}

        {/* FINANCIAL & SESSIONS ROW */}
        {canViewFinance || canViewSessions ? <View style={[styles.twoColumnRow, { direction: "rtl" }]}>
          {/* Today Collections */}
          {canViewFinance ? <AppCard style={[styles.halfCard, !canViewSessions ? { width: "100%" } : null]}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>
                {Strings.todayCollectionsTitle}
              </Text>
              <View style={[styles.detailIcon, { backgroundColor: Colors.successLight }]}>
                <Ionicons name="cash-outline" size={19} color={Colors.success} />
              </View>
            </View>
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.financialAmount}>
              {summary ? formatCurrency(summary.todayCollections) : "—"}
            </Text>
          </AppCard> : null}

          {/* Today Sessions */}
          {canViewSessions ? <AppCard style={[styles.halfCard, !canViewFinance ? { width: "100%" } : null]}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>{Strings.todaySessionsTitle}</Text>
              <View style={[styles.detailIcon, { backgroundColor: Colors.primaryLight }]}>
                <Ionicons name="calendar-outline" size={19} color={Colors.primary} />
              </View>
            </View>
            <View style={styles.sessionStatusRow}>
              <View style={styles.sessionCountBlock}>
                <Text style={styles.sessionCount}>{summary ? formatNumber(summary.openSessions) : "—"}</Text>
                <Text style={styles.sessionCountLabel}>{Strings.openSessions}</Text>
              </View>
              <View style={styles.sessionCountDivider} />
              <View style={styles.sessionCountBlock}>
                <Text style={styles.sessionCountMuted}>{summary ? formatNumber(summary.closedSessions) : "—"}</Text>
                <Text style={styles.sessionCountLabel}>{Strings.closedSessions}</Text>
              </View>
            </View>
          </AppCard> : null}
        </View> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function MetricTile({
  icon,
  label,
  value,
  color,
  textColor,
  backgroundColor,
  styles,
  wide = false,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string;
  color: string;
  textColor: string;
  backgroundColor: string;
  styles: ReturnType<typeof createStyles>;
  wide?: boolean;
}) {
  return (
    <View style={[styles.metricBox, { backgroundColor }, wide ? styles.metricBoxWide : null]}>
      <View style={[styles.metricIcon, { backgroundColor: Colors.white }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <View style={styles.metricCopy}>
        <Text style={[styles.metricNumber, { color: textColor }]}>{value}</Text>
        <Text style={[styles.metricLabel, { color: textColor }]}>{label}</Text>
      </View>
    </View>
  );
}

const createStyles = () => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: DASHBOARD_NAVY,
  },
  dashboardScroll: {
    backgroundColor: Colors.background,
    flex: 1,
  },
  headerBar: {
    paddingHorizontal: Spacing.lg,
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    direction: "ltr",
  },
  syncStatusButton: {
    minWidth: 104,
    height: 36,
    borderRadius: BorderRadius.full,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: "rgba(245, 158, 11, 0.2)",
    direction: "rtl",
  },
  syncStatusOnline: { backgroundColor: "rgba(16, 185, 129, 0.2)" },
  syncStatusError: { backgroundColor: "rgba(239, 68, 68, 0.2)" },
  syncStatusText: { color: Colors.white, fontSize: 12, fontWeight: "700" },
  syncPendingText: { color: "#FFE08A", fontSize: 10, fontWeight: "800" },
  brandLockup: {
    width: 108,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  brandLogo: {
    width: "100%",
    height: "100%",
  },
  greetingRow: {
    minHeight: 66,
    justifyContent: "center",
    marginBottom: Spacing.md,
    direction: "rtl",
  },
  greetingCopy: {
    flex: 1,
    alignItems: "flex-start",
    direction: "rtl",
  },
  greetingTitle: {
    color: Colors.slate900,
    fontSize: 25,
    fontWeight: "800",
    textAlign: "right",
    writingDirection: "rtl",
  },
  greetingName: {
    color: Colors.primary,
  },
  greetingSubtitle: {
    color: Colors.slate500,
    fontSize: 13,
    fontWeight: "500",
    marginTop: 5,
    textAlign: "right",
    writingDirection: "rtl",
  },
  scrollContent: {
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xxxl,
  },
  heroBanner: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.xl,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
    minHeight: 108,
    overflow: "hidden",
    ...Shadows.subtle,
  },
  heroContent: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 88,
    direction: "rtl",
  },
  heroIconWrapper: {
    width: 54,
    height: 54,
    borderRadius: BorderRadius.lg,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: Spacing.md,
  },
  heroTextWrapper: {
    flex: 1,
    alignItems: "flex-end",
    paddingHorizontal: Spacing.sm,
  },
  heroTitle: {
    ...Typography.h3,
    color: Colors.white,
    textAlign: "right",
  },
  heroEyebrow: { color: "#DBEAFE", fontSize: 10, fontWeight: "700", marginBottom: 2, textAlign: "right" },
  heroSubtitle: {
    ...Typography.caption,
    color: "#DBEAFE",
    marginTop: 1,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "right",
  },
  sectionHeader: {
    ...Typography.h3,
    color: Colors.slate900,
    fontSize: 16,
    lineHeight: 22,
  },
  sectionHeadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: Spacing.md, direction: "rtl" },
  sectionTitleGroup: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  todayBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: Colors.primaryMuted, borderRadius: BorderRadius.full, paddingHorizontal: 10, paddingVertical: 5 },
  todayBadgeText: { fontSize: 11, fontWeight: "700", color: Colors.primaryDark },
  summaryCard: {
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    columnGap: Spacing.sm,
    rowGap: Spacing.sm,
    direction: "rtl",
  },
  metricBox: {
    width: "48%",
    minHeight: 80,
    padding: Spacing.sm,
    borderRadius: BorderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    direction: "ltr",
  },
  metricBoxWide: {
    width: "100%",
    minHeight: 68,
    justifyContent: "space-between",
    paddingHorizontal: Spacing.md,
  },
  metricIcon: {
    width: 42,
    height: 42,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.88,
  },
  metricCopy: {
    flex: 1,
    minWidth: 54,
    alignItems: "flex-end",
    paddingRight: Spacing.xs,
  },
  metricNumber: {
    fontSize: 25,
    lineHeight: 29,
    fontWeight: "800",
    textAlign: "right",
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
    textAlign: "right",
    writingDirection: "rtl",
  },
  twoColumnRow: {
    flexDirection: "row",
    gap: Spacing.md,
  },
  halfCard: {
    flex: 1,
    padding: Spacing.md,
    minHeight: 144,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.sm,
    direction: "rtl",
  },
  detailIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    ...Typography.bodyBold,
    color: Colors.slate800,
    textAlign: "right",
    fontSize: 14,
  },
  financialAmount: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.successText,
    marginTop: Spacing.md,
    textAlign: "right",
  },
  sessionStatusRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    marginTop: Spacing.xs,
  },
  sessionCountBlock: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  sessionCount: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: "800",
    color: Colors.primaryDark,
  },
  sessionCountMuted: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: "800",
    color: Colors.slate500,
  },
  sessionCountLabel: {
    ...Typography.caption,
    color: Colors.slate500,
    fontSize: 11,
    lineHeight: 16,
  },
  sessionCountDivider: {
    width: 1,
    height: 38,
    backgroundColor: Colors.border,
  },
  warningBanner: {
    backgroundColor: "#FEF3C7",
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  warningContent: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.sm,
  },
  warningTextWrapper: {
    flex: 1,
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#92400E",
    marginBottom: 4,
    textAlign: "right",
  },
  warningText: {
    fontSize: 12,
    color: "#78350F",
    lineHeight: 18,
    textAlign: "right",
  },
  warningSyncButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F59E0B",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: BorderRadius.md,
    marginTop: Spacing.sm,
    alignSelf: "flex-start",
  },
  warningSyncButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.white,
  },
  warningDismiss: {
    padding: 4,
  },
});
