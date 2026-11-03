import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectivityService } from "../../core/connectivity";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import {
  SafeConflictRetryService,
  RetryEligibilityResult,
  SyncEngine,
  SyncRepository,
} from "../../core/sync";
import { useAuthStore } from "../../features/auth/useAuthStore";
import type { SyncConflict, SyncOperation } from "../../shared/types";
import { formatLocalDateTime } from "../../shared/utils/date";

const STATUS_LABELS: Record<string, string> = {
  pending: "في الانتظار",
  syncing: "جارٍ الإرسال",
  synced: "تمت المزامنة",
  failed: "فشل الإرسال",
  conflict: "تعارض يحتاج مراجعة",
};

const STATUS_COLORS: Record<string, string> = {
  pending: Colors.warningText,
  syncing: Colors.primary,
  synced: Colors.successText,
  failed: Colors.dangerText,
  conflict: Colors.dangerText,
};

function formatDate(value?: string | null) {
  if (!value) return "-";
  try {
    return formatLocalDateTime(value);
  } catch {
    return value;
  }
}

function getEntityLabel(entityType: string): string {
  switch (entityType) {
    case "group_schedule":
      return "جدول مجموعة";
    case "group":
      return "مجموعة";
    case "student":
      return "طالب";
    case "teacher":
      return "مدرس";
    case "session":
      return "حصة";
    case "attendance":
      return "حضور";
    case "payment":
      return "عملية دفع مالية";
    case "payment_reversal":
      return "إلغاء عملية دفع";
    case "debt_cycle":
      return "دورة مديونية مالية";
    case "debt_adjustment":
      return "تسوية مديونية مالية";
    case "daily_closing":
      return "إغلاق يومي";
    case "advance_coverage":
      return "تغطية سلفة";
    case "payment_collected":
      return "تحصيل دفعة";
    case "student_package_subscription":
      return "اشتراك باقة";
    default:
      return entityType;
  }
}

export default function SyncDebugScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const activeCenter = useAuthStore((state) => state.activeCenter);
  const currentUser = useAuthStore((state) => state.currentUser);

  const canManageSync = useMemo(() => {
    return PermissionService.hasPermission(currentUser?.permissions || [], "sync.manage");
  }, [currentUser]);

  const [activeTab, setActiveTab] = useState<"active_conflicts" | "historical_conflicts" | "unsynced" | "recent">("active_conflicts");
  const [stats, setStats] = useState({ pending: 0, syncing: 0, synced: 0, failed: 0, conflict: 0, total: 0 });
  const [openConflicts, setOpenConflicts] = useState<SyncConflict[]>([]);
  const [historicalConflicts, setHistoricalConflicts] = useState<SyncConflict[]>([]);
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [unsynced, setUnsynced] = useState<SyncOperation[]>([]);

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastResult, setLastResult] = useState("");
  const [loadError, setLoadError] = useState("");
  const [bannerSuccess, setBannerSuccess] = useState("");
  const [diagnostics, setDiagnostics] = useState(ConnectivityService.getDiagnostics());

  // Expandable cards set
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Dismiss Modal state
  const [selectedConflict, setSelectedConflict] = useState<SyncConflict | null>(null);
  const [dismissModalVisible, setDismissModalVisible] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [dismissError, setDismissError] = useState("");
  const [isDismissing, setIsDismissing] = useState(false);

  // Safe Retry Modal state
  const [selectedRetryConflict, setSelectedRetryConflict] = useState<SyncConflict | null>(null);
  const [retryModalVisible, setRetryModalVisible] = useState(false);
  const [retryEligibility, setRetryEligibility] = useState<RetryEligibilityResult | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = useCallback(() => {
    if (!activeCenter) return;
    try {
      setLoadError("");
      setStats(SyncRepository.getStats(activeCenter.id));
      setOpenConflicts(SyncRepository.getOpenConflicts(activeCenter.id));
      setHistoricalConflicts(SyncRepository.getHistoricalConflicts(activeCenter.id, 50));
      setOperations(SyncRepository.getRecentOperations(activeCenter.id, 50));
      setUnsynced(SyncRepository.getUnsyncedOperations(activeCenter.id, 100));
    } catch (error: any) {
      setLoadError(error?.message || "تعذر قراءة بيانات المزامنة المحلية.");
    } finally {
      setLoading(false);
    }
  }, [activeCenter]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = ConnectivityService.subscribeDiagnostics(setDiagnostics);
      return unsubscribe;
    }, []),
  );

  const syncNow = async () => {
    if (!activeCenter || refreshing) return;
    setRefreshing(true);
    setBannerSuccess("");
    try {
      const result = await SyncEngine.syncCenterNow(activeCenter.id);
      setLastResult(`تمت المزامنة: ${result.syncedCount} | أخطاء: ${result.errors} | تعارضات: ${result.conflicts}`);
    } catch (error: any) {
      setLastResult(`فشلت المزامنة: ${error?.message || "خطأ غير معروف"}`);
    } finally {
      load();
      setRefreshing(false);
    }
  };

  const handleOpenDismissModal = (conflict: SyncConflict) => {
    setSelectedConflict(conflict);
    setDismissReason("");
    setDismissError("");
    setDismissModalVisible(true);
  };

  const handleConfirmDismiss = () => {
    if (!activeCenter || !selectedConflict) return;
    const userId = String(currentUser?.id ?? "").trim();
    if (!userId || userId.toLowerCase() === "unknown") {
      setDismissError("تعذر التحقق من هوية المستخدم الحالي لإغلاق التعارض.");
      return;
    }
    const trimmed = dismissReason.trim();
    if (!trimmed || trimmed.length < 5) {
      setDismissError("يرجى كتابة سبب واضح ومفصل لإغلاق التعارض (5 أحرف على الأقل).");
      return;
    }
    setIsDismissing(true);
    setDismissError("");

    try {
      SyncRepository.dismissConflict({
        centerId: activeCenter.id,
        operationId: selectedConflict.operationId,
        reason: trimmed,
        user: {
          id: userId,
          permissions: (currentUser?.permissions || []) as any,
        },
      });

      setDismissModalVisible(false);
      setSelectedConflict(null);
      setDismissReason("");
      setBannerSuccess(`تم إغلاق التعارض بنجاح وتوثيقه في السجل.`);
      load();
    } catch (err: any) {
      setDismissError(err?.userMessage || err?.message || "تعذر إغلاق التعارض.");
    } finally {
      setIsDismissing(false);
    }
  };

  const handleOpenRetryModal = (conflict: SyncConflict, eligibility: RetryEligibilityResult) => {
    setSelectedRetryConflict(conflict);
    setRetryEligibility(eligibility);
    setRetryError("");
    setRetryModalVisible(true);
  };

  const handleConfirmRetry = async () => {
    if (!activeCenter || !selectedRetryConflict) return;
    const userId = String(currentUser?.id ?? "").trim();
    if (!userId || userId.toLowerCase() === "unknown") {
      setRetryError("تعذر التحقق من هوية المستخدم لإعادة المحاولة.");
      return;
    }
    setIsRetrying(true);
    setRetryError("");

    try {
      const result = await SafeConflictRetryService.retryConflict({
        centerId: activeCenter.id,
        operationId: selectedRetryConflict.operationId,
        user: {
          id: userId,
          permissions: (currentUser?.permissions || []) as any,
        },
      });

      if (result.success) {
        setRetryModalVisible(false);
        setSelectedRetryConflict(null);
        setBannerSuccess(result.message);
        load();
      } else {
        setRetryError(result.message);
        load();
      }
    } catch (err: any) {
      setRetryError(err?.message || "حدث خطأ غير متوقع أثناء إعادة المحاولة.");
    } finally {
      setIsRetrying(false);
    }
  };

  if (!activeCenter) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.empty}>لا يوجد مركز نشط حاليًا.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={syncNow} />}
      >
        {/* Title Header */}
        <View style={styles.titleRow}>
          <View style={styles.titleTextContainer}>
            <Text style={styles.title}>إدارة تعارضات ومشاكل المزامنة</Text>
            <Text style={styles.subtitle}>{activeCenter.name}</Text>
          </View>
          <View style={styles.iconCircle}>
            <Ionicons name="shield-checkmark-outline" size={26} color={Colors.primary} />
          </View>
        </View>

        {/* Success Banner */}
        {bannerSuccess ? (
          <View style={styles.bannerSuccess}>
            <Ionicons name="checkmark-circle-outline" size={20} color={Colors.successText} />
            <Text style={styles.bannerSuccessText}>{bannerSuccess}</Text>
          </View>
        ) : null}

        {/* Connection Diagnostics Card */}
        <View style={styles.connectionCard}>
          <Text style={styles.cardHeaderTitle}>حالة الاتصال والشبكة</Text>
          <View style={styles.connectionRow}>
            <Text style={styles.connectionLabel}>شبكة الهاتف</Text>
            <Text style={styles.connectionValue}>
              {diagnostics.deviceNetwork === "connected"
                ? "متصل بالشبكة"
                : diagnostics.deviceNetwork === "disconnected"
                  ? "غير متصل بالشبكة"
                  : "حالة الشبكة غير محددة"}
            </Text>
          </View>
          <View style={styles.connectionRow}>
            <Text style={styles.connectionLabel}>خادم FIXION</Text>
            <Text
              style={[
                styles.connectionValue,
                diagnostics.backend !== "available" && styles.connectionWarning,
              ]}
            >
              {diagnostics.backend === "available"
                ? "استجاب فحص الخادم بنجاح"
                : diagnostics.backend === "degraded"
                  ? "الخادم استجاب ببطء أو خطأ"
                  : diagnostics.backend === "unavailable"
                    ? "تعذر الوصول في آخر فحص"
                    : "لم يتم التحقق بعد"}
            </Text>
          </View>
          <View style={styles.connectionRow}>
            <Text style={styles.connectionLabel}>آخر طلب API ناجح</Text>
            <Text style={styles.connectionValue}>
              {diagnostics.lastApiSuccessAt
                ? formatDate(diagnostics.lastApiSuccessAt)
                : "لا يوجد طلب ناجح مسجل"}
            </Text>
          </View>
          <Text style={styles.connectionHint}>
            {diagnostics.backendCheckedAt
              ? `آخر فحص للخادم: ${formatDate(diagnostics.backendCheckedAt)}`
              : "لم يتم فحص الخادم بعد"}
          </Text>
        </View>

        {/* Sync Now Action */}
        <TouchableOpacity
          style={styles.syncButton}
          onPress={syncNow}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel="مزامنة الآن"
        >
          {refreshing ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <Ionicons name="sync-outline" size={20} color={Colors.white} />
          )}
          <Text style={styles.syncButtonText}>مزامنة الآن مع الخادم</Text>
        </TouchableOpacity>

        {lastResult ? <Text style={styles.result}>{lastResult}</Text> : null}
        {loadError ? <Text style={styles.errorBanner}>{loadError}</Text> : null}

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          {[
            ["المتزامنة", stats.synced, Colors.successText],
            ["في الانتظار", stats.pending, Colors.warningText],
            ["جارٍ الإرسال", stats.syncing, Colors.primary],
            ["فشل الإرسال", stats.failed, Colors.dangerText],
            ["تعارضات نشطة", stats.conflict, Colors.dangerText],
          ].map(([label, value, color]) => (
            <View key={String(label)} style={styles.statCard}>
              <Text style={[styles.statValue, { color: String(color) }]}>{String(value)}</Text>
              <Text style={styles.statLabel}>{String(label)}</Text>
            </View>
          ))}
        </View>

        {/* Tabs Bar */}
        <View style={styles.tabsContainer}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === "active_conflicts" && styles.tabButtonActive]}
            onPress={() => setActiveTab("active_conflicts")}
          >
            <Text style={[styles.tabText, activeTab === "active_conflicts" && styles.tabTextActive]}>
              تعارضات تحتاج إلى تدخل ({openConflicts.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === "historical_conflicts" && styles.tabButtonActive]}
            onPress={() => setActiveTab("historical_conflicts")}
          >
            <Text style={[styles.tabText, activeTab === "historical_conflicts" && styles.tabTextActive]}>
              سجل التعارضات المحسومة ({historicalConflicts.length})
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tabsContainerSub}>
          <TouchableOpacity
            style={[styles.tabButtonSub, activeTab === "unsynced" && styles.tabButtonActive]}
            onPress={() => setActiveTab("unsynced")}
          >
            <Text style={[styles.tabTextSub, activeTab === "unsynced" && styles.tabTextActive]}>
              غير المرفوعة ({unsynced.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButtonSub, activeTab === "recent" && styles.tabButtonActive]}
            onPress={() => setActiveTab("recent")}
          >
            <Text style={[styles.tabTextSub, activeTab === "recent" && styles.tabTextActive]}>
              سجل العمليات الأخير ({operations.length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* TAB 1: ACTIVE CONFLICTS */}
        {activeTab === "active_conflicts" ? (
          <View style={styles.sectionContainer}>
            {loading ? (
              <ActivityIndicator color={Colors.primary} style={styles.loader} />
            ) : openConflicts.length === 0 ? (
              <View style={styles.allClearCard}>
                <Ionicons name="checkmark-circle-outline" size={32} color={Colors.successText} />
                <View style={styles.allClearTextContainer}>
                  <Text style={styles.allClearTitle}>لا توجد تعارضات نشطة تحتاج إلى تدخل حاليًا</Text>
                  <Text style={styles.allClearSubtitle}>كافة العمليات المحلية متوافقة مع الخادم أو تم حسمها بأمان.</Text>
                </View>
              </View>
            ) : (
              openConflicts.map((conflict) => {
                const isExpanded = expandedIds.has(conflict.operationId);
                return (
                  <View key={`open-${conflict.operationId}`} style={styles.conflictCard}>
                    {/* Header badge & time */}
                    <View style={styles.conflictCardHeader}>
                      <View style={styles.entityBadge}>
                        <Text style={styles.entityBadgeText}>{getEntityLabel(conflict.entityType)}</Text>
                      </View>
                      <Text style={styles.conflictDate}>{formatDate(conflict.createdAt)}</Text>
                    </View>

                    {/* Entity title / name */}
                    <Text style={styles.conflictEntityTitle}>
                      {conflict.entityName || conflict.entityId}
                    </Text>

                    {conflict.teacherName && conflict.entityType === "group_schedule" ? (
                      <Text style={styles.conflictSubText}>المدرس: {conflict.teacherName}</Text>
                    ) : null}

                    {/* Friendly Arabic explanation */}
                    <View style={styles.friendlyReasonBox}>
                      <Ionicons name="alert-circle-outline" size={18} color={Colors.dangerText} />
                      <Text style={styles.friendlyReasonText}>{conflict.friendlyReason}</Text>
                    </View>

                    {/* Financial Protection Notice or Actions */}
                    {conflict.isFinancial ? (
                      <View style={styles.financialProtectedBox}>
                        <Ionicons name="lock-closed-outline" size={18} color="#B45309" />
                        <View style={styles.financialProtectedTextWrap}>
                          <Text style={styles.financialProtectedTitle}>
                            عملية مالية - للعرض فقط (لا يمكن الإغلاق أو إعادة المحاولة)
                          </Text>
                          <Text style={styles.financialProtectedDesc}>
                            التعارضات المالية لا يمكن إغلاقها أو إعادة محاولتها لحماية سلامة الحسابات والأرصدة.
                          </Text>
                        </View>
                      </View>
                    ) : (conflict.reason || "").includes("STALE_UPDATE") ? (
                      <View style={styles.staleUpdateBox}>
                        <View style={styles.staleUpdateHeader}>
                          <Ionicons name="information-circle-outline" size={18} color={Colors.slate600} />
                          <Text style={styles.staleUpdateTitle}>
                            تعديل ملغى بنسخة أحدث على الخادم
                          </Text>
                        </View>
                        <Text style={styles.staleUpdateDesc}>
                          الخادم يحتوي بالفعل على نسخة أحدث. التعديل المحلي لم يُطبق ولا توجد إعادة محاولة.
                        </Text>
                        <TouchableOpacity
                          style={[styles.dismissActionButton, !canManageSync && styles.buttonDisabled]}
                          onPress={() => handleOpenDismissModal(conflict)}
                          disabled={!canManageSync}
                          accessibilityRole="button"
                          accessibilityLabel="إغلاق التعارض يدويًا"
                        >
                          <Ionicons name="checkmark-done-outline" size={18} color={Colors.white} />
                          <Text style={styles.dismissActionText}>إغلاق التعارض يدويًا</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <>
                        {(() => {
                          const eligibility = SafeConflictRetryService.evaluateEligibility(
                            activeCenter.id,
                            conflict.operationId,
                            currentUser
                              ? { id: currentUser.id, permissions: (currentUser.permissions || []) as any }
                              : undefined,
                          );

                          return (
                            <View style={styles.conflictActionsWrap}>
                              {eligibility.eligible ? (
                                <>
                                  <View style={styles.retryEligibleBox}>
                                    <Ionicons name="shield-checkmark-outline" size={16} color={Colors.successText} />
                                    <Text style={styles.retryEligibleText}>{eligibility.userMessage}</Text>
                                  </View>
                                  <TouchableOpacity
                                    style={[styles.retryActionButton, (!canManageSync || isRetrying) && styles.buttonDisabled]}
                                    onPress={() => handleOpenRetryModal(conflict, eligibility)}
                                    disabled={!canManageSync || isRetrying}
                                    accessibilityRole="button"
                                    accessibilityLabel="إعادة الفحص والمحاولة"
                                  >
                                    <Ionicons name="refresh-outline" size={18} color={Colors.white} />
                                    <Text style={styles.retryActionText}>إعادة الفحص والمحاولة</Text>
                                  </TouchableOpacity>
                                </>
                              ) : (
                                <View style={styles.retryIneligibleBox}>
                                  <Ionicons name="alert-circle-outline" size={16} color="#92400E" />
                                  <Text style={styles.retryIneligibleText}>{eligibility.userMessage}</Text>
                                </View>
                              )}

                              <TouchableOpacity
                                style={[styles.dismissActionButton, !canManageSync && styles.buttonDisabled]}
                                onPress={() => handleOpenDismissModal(conflict)}
                                disabled={!canManageSync}
                                accessibilityRole="button"
                                accessibilityLabel="إغلاق التعارض يدويًا"
                              >
                                <Ionicons name="checkmark-done-outline" size={18} color={Colors.white} />
                                <Text style={styles.dismissActionText}>إغلاق التعارض يدويًا</Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })()}
                      </>
                    )}

                    {/* Toggle Technical Details */}
                    <TouchableOpacity
                      style={styles.detailsToggle}
                      onPress={() => toggleExpand(conflict.operationId)}
                    >
                      <Text style={styles.detailsToggleText}>
                        {isExpanded ? "إخفاء التفاصيل الفنية" : "عرض التفاصيل الفنية"}
                      </Text>
                      <Ionicons
                        name={isExpanded ? "chevron-up-outline" : "chevron-down-outline"}
                        size={16}
                        color={Colors.slate600}
                      />
                    </TouchableOpacity>

                    {/* Technical details view */}
                    {isExpanded ? (
                      <View style={styles.technicalBox}>
                        <Text style={styles.technicalFieldLabel}>معرف العملية (Operation ID):</Text>
                        <Text style={styles.technicalCode} selectable>{conflict.operationId}</Text>

                        <Text style={styles.technicalFieldLabel}>معرف الكيان (Entity ID):</Text>
                        <Text style={styles.technicalCode} selectable>{conflict.entityId}</Text>

                        <Text style={styles.technicalFieldLabel}>رسالة الخطأ الأصلية من الخادم:</Text>
                        <Text style={styles.technicalCode} selectable>{conflict.reason}</Text>

                        {conflict.localPayload ? (
                          <>
                            <Text style={styles.technicalFieldLabel}>البيانات المحلية (Local Payload):</Text>
                            <Text style={styles.technicalCode} selectable>
                              {conflict.localPayload}
                            </Text>
                          </>
                        ) : null}

                        {conflict.serverPayload ? (
                          <>
                            <Text style={styles.technicalFieldLabel}>بيانات الخادم (Server State):</Text>
                            <Text style={styles.technicalCode} selectable>
                              {conflict.serverPayload}
                            </Text>
                          </>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {/* TAB 2: HISTORICAL CONFLICTS */}
        {activeTab === "historical_conflicts" ? (
          <View style={styles.sectionContainer}>
            {loading ? (
              <ActivityIndicator color={Colors.primary} style={styles.loader} />
            ) : historicalConflicts.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="time-outline" size={32} color={Colors.slate400} />
                <Text style={styles.emptyCardText}>لا توجد تعارضات محسومة في السجل التاريخي.</Text>
              </View>
            ) : (
              historicalConflicts.map((conflict) => {
                const isExpanded = expandedIds.has(`hist-${conflict.operationId}`);
                return (
                  <View key={`hist-${conflict.operationId}`} style={styles.historyCard}>
                    <View style={styles.conflictCardHeader}>
                      <View style={styles.historyBadge}>
                        <Ionicons name="checkmark-outline" size={14} color={Colors.successText} />
                        <Text style={styles.historyBadgeText}>تم الحسم / الإغلاق</Text>
                      </View>
                      <Text style={styles.conflictDate}>{formatDate(conflict.resolvedAt)}</Text>
                    </View>

                    <Text style={styles.conflictEntityTitle}>
                      {conflict.entityName || conflict.entityId} ({getEntityLabel(conflict.entityType)})
                    </Text>

                    <Text style={styles.conflictSubText}>سبب التعارض الأصلي: {conflict.friendlyReason}</Text>

                    {/* Resolution details card */}
                    <View style={styles.resolutionAuditBox}>
                      <View style={styles.resolutionRow}>
                        <Text style={styles.resolutionLabel}>سبب الإغلاق:</Text>
                        <Text style={styles.resolutionValue}>{conflict.resolutionNote || "تم الحسم دون ملاحظة"}</Text>
                      </View>
                      <View style={styles.resolutionRow}>
                        <Text style={styles.resolutionLabel}>بواسطة:</Text>
                        <Text style={styles.resolutionValue}>{conflict.resolvedBy || "النظام"}</Text>
                      </View>
                      <View style={styles.resolutionRow}>
                        <Text style={styles.resolutionLabel}>تاريخ الحسم:</Text>
                        <Text style={styles.resolutionValue}>{formatDate(conflict.resolvedAt)}</Text>
                      </View>
                    </View>

                    {/* Toggle Details */}
                    <TouchableOpacity
                      style={styles.detailsToggle}
                      onPress={() => toggleExpand(`hist-${conflict.operationId}`)}
                    >
                      <Text style={styles.detailsToggleText}>
                        {isExpanded ? "إخفاء التفاصيل الفنية" : "عرض التفاصيل الفنية"}
                      </Text>
                      <Ionicons
                        name={isExpanded ? "chevron-up-outline" : "chevron-down-outline"}
                        size={16}
                        color={Colors.slate600}
                      />
                    </TouchableOpacity>

                    {isExpanded ? (
                      <View style={styles.technicalBox}>
                        <Text style={styles.technicalFieldLabel}>معرف العملية (Operation ID):</Text>
                        <Text style={styles.technicalCode} selectable>{conflict.operationId}</Text>
                        <Text style={styles.technicalFieldLabel}>الخطأ الأصلي:</Text>
                        <Text style={styles.technicalCode} selectable>{conflict.reason}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {/* TAB 3: UNSYNCED OPERATIONS */}
        {activeTab === "unsynced" ? (
          <View style={styles.sectionContainer}>
            {unsynced.length === 0 ? (
              <View style={styles.allClearCard}>
                <Ionicons name="checkmark-circle-outline" size={26} color={Colors.successText} />
                <Text style={styles.allClearTitle}>كافة العمليات المحلية تم تأكيدها من الخادم.</Text>
              </View>
            ) : (
              unsynced.map((operation) => (
                <View key={`unsynced-${operation.operationId}`} style={styles.unsyncedCard}>
                  <View style={styles.conflictCardHeader}>
                    <Text style={[styles.status, { color: STATUS_COLORS[operation.status] || Colors.dangerText }]}>
                      {STATUS_LABELS[operation.status] || operation.status}
                    </Text>
                    <Text style={styles.entity}>{getEntityLabel(operation.entityType)} · {operation.operationType}</Text>
                  </View>
                  <Text style={styles.operationId} numberOfLines={1}>{operation.operationId}</Text>
                  <Text style={styles.meta}>معرف الكيان: {operation.entityId}</Text>
                  <Text style={styles.meta}>المحاولات: {operation.retryCount || 0} · {formatDate(operation.createdAt)}</Text>
                  {operation.lastError ? (
                    <Text style={styles.errorBanner} selectable>{operation.lastError}</Text>
                  ) : (
                    <Text style={styles.pendingReason}>بانتظار محاولة المزامنة القادمة.</Text>
                  )}
                </View>
              ))
            )}
          </View>
        ) : null}

        {/* TAB 4: RECENT OPERATIONS */}
        {activeTab === "recent" ? (
          <View style={styles.sectionContainer}>
            {loading ? (
              <ActivityIndicator color={Colors.primary} style={styles.loader} />
            ) : operations.length === 0 ? (
              <Text style={styles.empty}>لا توجد عمليات مسجلة.</Text>
            ) : (
              operations.map((operation) => (
                <View key={operation.operationId} style={styles.operationCard}>
                  <View style={styles.conflictCardHeader}>
                    <Text style={[styles.status, { color: STATUS_COLORS[operation.status] || Colors.slate600 }]}>
                      {STATUS_LABELS[operation.status] || operation.status}
                    </Text>
                    <Text style={styles.entity}>{getEntityLabel(operation.entityType)} · {operation.operationType}</Text>
                  </View>
                  <Text style={styles.operationId} numberOfLines={1}>{operation.operationId}</Text>
                  <Text style={styles.meta}>معرف الكيان: {operation.entityId}</Text>
                  <Text style={styles.meta}>{formatDate(operation.createdAt)} · المحاولات: {operation.retryCount || 0}</Text>
                  {operation.lastError ? (
                    <Text style={styles.errorBanner} selectable>{operation.lastError}</Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        ) : null}
      </ScrollView>

      {/* IN-APP DISMISS CONFLICT MODAL */}
      <Modal
        visible={dismissModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isDismissing) setDismissModalVisible(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>إغلاق تعارض المزامنة</Text>
              <TouchableOpacity
                onPress={() => setDismissModalVisible(false)}
                disabled={isDismissing}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={Colors.slate500} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalWarningNote}>
              سيتم استبعاد هذا التعارض من المشاكل النشطة مع حفظ العملية وسجل التدقيق. يرجى توثيق سبب الإغلاق:
            </Text>

            {selectedConflict ? (
              <View style={styles.modalSummaryBox}>
                <Text style={styles.modalSummaryEntity}>
                  الكيان: {selectedConflict.entityName || selectedConflict.entityId} ({getEntityLabel(selectedConflict.entityType)})
                </Text>
                <Text style={styles.modalSummaryReason}>
                  التعارض: {selectedConflict.friendlyReason}
                </Text>
              </View>
            ) : null}

            <Text style={styles.modalInputLabel}>سبب إغلاق التعارض بالتفصيل (مطلوب - 5 أحرف على الأقل):</Text>
            <TextInput
              style={styles.modalTextInput}
              multiline
              numberOfLines={3}
              placeholder="اكتب سبب إغلاق التعارض (مثال: تم التنسيق مع المدرس فيصل وتعديل الموعد يدويًا في المركز)..."
              placeholderTextColor={Colors.slate400}
              value={dismissReason}
              onChangeText={setDismissReason}
              textAlign="right"
              editable={!isDismissing}
            />

            {dismissError ? (
              <Text style={styles.modalErrorText}>{dismissError}</Text>
            ) : null}

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={styles.modalConfirmButton}
                onPress={handleConfirmDismiss}
                disabled={isDismissing}
                accessibilityRole="button"
                accessibilityLabel="تأكيد إغلاق التعارض"
              >
                {isDismissing ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.modalConfirmButtonText}>تأكيد الإغلاق</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setDismissModalVisible(false)}
                disabled={isDismissing}
                accessibilityRole="button"
                accessibilityLabel="إلغاء"
              >
                <Text style={styles.modalCancelButtonText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* IN-APP SAFE RETRY CONFIRMATION MODAL */}
      <Modal
        visible={retryModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isRetrying) setRetryModalVisible(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>إعادة الفحص والمحاولة الآمنة</Text>
              <TouchableOpacity
                onPress={() => setRetryModalVisible(false)}
                disabled={isRetrying}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={Colors.slate500} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalWarningNote}>
              سيتم إعادة إرسال العملية إلى الخادم باستخدام نفس معرف العملية الأصلي بعد التحقق من زوال سبب التعارض.
            </Text>

            {selectedRetryConflict ? (
              <View style={styles.modalSummaryBox}>
                <Text style={styles.modalSummaryEntity}>
                  الكيان: {selectedRetryConflict.entityName || selectedRetryConflict.entityId} ({getEntityLabel(selectedRetryConflict.entityType)})
                </Text>
                <Text style={styles.modalSummaryReason}>
                  التعارض: {selectedRetryConflict.friendlyReason}
                </Text>
                {retryEligibility ? (
                  <Text style={styles.modalEligibilityNote}>
                    {retryEligibility.userMessage}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {retryError ? (
              <Text style={styles.modalErrorText}>{retryError}</Text>
            ) : null}

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={styles.modalConfirmRetryButton}
                onPress={handleConfirmRetry}
                disabled={isRetrying}
                accessibilityRole="button"
                accessibilityLabel="تأكيد إعادة المحاولة"
              >
                {isRetrying ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.modalConfirmButtonText}>تأكيد إعادة المحاولة</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setRetryModalVisible(false)}
                disabled={isRetrying}
                accessibilityRole="button"
                accessibilityLabel="إلغاء"
              >
                <Text style={styles.modalCancelButtonText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: Colors.background },
    content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },

    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    titleTextContainer: { flex: 1, alignItems: "flex-end" },
    title: { ...Typography.h2, color: Colors.slate900, textAlign: "right" },
    subtitle: { color: Colors.slate500, marginTop: 2, textAlign: "right", fontWeight: "600" },
    iconCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: Colors.white,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
      marginLeft: Spacing.md,
    },

    bannerSuccess: {
      backgroundColor: Colors.successLight,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#A7F3D0",
      padding: Spacing.md,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 10,
    },
    bannerSuccessText: { color: Colors.successText, fontWeight: "700", flex: 1, textAlign: "right" },

    connectionCard: {
      backgroundColor: Colors.white,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.lg,
      gap: 10,
    },
    cardHeaderTitle: { color: Colors.slate900, fontWeight: "800", fontSize: 15, textAlign: "right" },
    connectionRow: { flexDirection: "row-reverse", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
    connectionLabel: { color: Colors.slate600, fontWeight: "700" },
    connectionValue: { color: Colors.successText, fontWeight: "800", flexShrink: 1, textAlign: "left" },
    connectionWarning: { color: Colors.warningText },
    connectionHint: { color: Colors.slate500, fontSize: 12, textAlign: "right" },

    syncButton: {
      backgroundColor: Colors.primary,
      borderRadius: 14,
      minHeight: 50,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row-reverse",
      gap: 8,
      elevation: 2,
    },
    syncButtonText: { color: Colors.white, fontWeight: "800", fontSize: 15 },
    result: { color: Colors.slate600, textAlign: "center", fontSize: 12 },
    errorBanner: {
      color: Colors.dangerText,
      backgroundColor: Colors.dangerLight,
      borderRadius: 8,
      padding: 8,
      fontSize: 12,
      textAlign: "right",
    },

    statsGrid: { flexDirection: "row-reverse", flexWrap: "wrap", gap: Spacing.sm },
    statCard: {
      width: "48%",
      backgroundColor: Colors.white,
      borderRadius: 16,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
    },
    statValue: { fontSize: 22, fontWeight: "900" },
    statLabel: { color: Colors.slate600, fontWeight: "700", marginTop: 2 },

    tabsContainer: { flexDirection: "row-reverse", gap: Spacing.xs, marginTop: Spacing.sm },
    tabButton: {
      flex: 1,
      backgroundColor: Colors.white,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    tabButtonActive: {
      backgroundColor: Colors.primary,
      borderColor: Colors.primary,
    },
    tabText: {
      color: Colors.slate700,
      fontWeight: "800",
      fontSize: 12,
      textAlign: "center",
    },
    tabTextActive: {
      color: Colors.white,
    },

    tabsContainerSub: { flexDirection: "row-reverse", gap: Spacing.xs },
    tabButtonSub: {
      flex: 1,
      backgroundColor: "#F8FAFC",
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    tabTextSub: {
      color: Colors.slate600,
      fontWeight: "700",
      fontSize: 11,
      textAlign: "center",
    },

    sectionContainer: { gap: Spacing.md, marginTop: Spacing.xs },
    loader: { marginVertical: Spacing.xl },

    allClearCard: {
      backgroundColor: Colors.successLight,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: "#A7F3D0",
      padding: Spacing.lg,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 14,
    },
    allClearTextContainer: { flex: 1, alignItems: "flex-end" },
    allClearTitle: { color: Colors.successText, fontWeight: "800", fontSize: 15, textAlign: "right" },
    allClearSubtitle: { color: Colors.slate600, fontSize: 13, marginTop: 4, textAlign: "right" },

    emptyCard: {
      backgroundColor: Colors.white,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.xxl,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    emptyCardText: { color: Colors.slate500, fontSize: 14, fontWeight: "600", textAlign: "center" },

    conflictCard: {
      backgroundColor: Colors.white,
      borderRadius: 18,
      borderWidth: 1.5,
      borderColor: "#FECACA",
      padding: Spacing.lg,
      gap: 8,
    },
    conflictCardHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
    entityBadge: {
      backgroundColor: "#FEE2E2",
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    entityBadgeText: { color: Colors.dangerText, fontWeight: "800", fontSize: 12 },
    conflictDate: { color: Colors.slate400, fontSize: 11 },

    conflictEntityTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" },
    conflictSubText: { color: Colors.slate600, fontSize: 13, fontWeight: "600", textAlign: "right" },

    friendlyReasonBox: {
      backgroundColor: "#FFF1F2",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: "#FFE4E6",
      padding: Spacing.md,
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      gap: 8,
    },
    friendlyReasonText: { color: Colors.dangerText, fontWeight: "700", fontSize: 13, flex: 1, textAlign: "right" },

    financialProtectedBox: {
      backgroundColor: "#FEF3C7",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#FDE68A",
      padding: Spacing.md,
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      gap: 10,
      marginTop: 4,
    },
    financialProtectedTextWrap: { flex: 1, alignItems: "flex-end" },
    financialProtectedTitle: { color: "#92400E", fontWeight: "800", fontSize: 13, textAlign: "right" },
    financialProtectedDesc: { color: "#B45309", fontSize: 12, marginTop: 2, textAlign: "right" },

    staleUpdateBox: {
      backgroundColor: "#F1F5F9",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#CBD5E1",
      padding: Spacing.md,
      gap: 6,
      marginTop: 4,
    },
    staleUpdateHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
    staleUpdateTitle: { color: Colors.slate800, fontWeight: "800", fontSize: 13, textAlign: "right" },
    staleUpdateDesc: { color: Colors.slate600, fontSize: 12, lineHeight: 18, textAlign: "right" },

    conflictActionsWrap: { gap: 6, marginTop: 4 },

    retryEligibleBox: {
      backgroundColor: "#ECFDF5",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: "#A7F3D0",
      padding: Spacing.sm,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    retryEligibleText: { color: Colors.successText, fontSize: 12, fontWeight: "700", flex: 1, textAlign: "right" },

    retryIneligibleBox: {
      backgroundColor: "#FFFBEB",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: "#FDE68A",
      padding: Spacing.sm,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    retryIneligibleText: { color: "#92400E", fontSize: 12, fontWeight: "700", flex: 1, textAlign: "right" },

    retryActionButton: {
      backgroundColor: Colors.primary,
      borderRadius: 12,
      minHeight: 44,
      paddingHorizontal: Spacing.lg,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    retryActionText: { color: Colors.white, fontWeight: "800", fontSize: 14 },

    dismissActionButton: {
      backgroundColor: Colors.slate800,
      borderRadius: 12,
      minHeight: 44,
      paddingHorizontal: Spacing.lg,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      marginTop: 2,
    },
    dismissActionText: { color: Colors.white, fontWeight: "800", fontSize: 14 },
    buttonDisabled: { opacity: 0.5 },

    detailsToggle: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingVertical: 6,
      marginTop: 4,
    },
    detailsToggleText: { color: Colors.slate600, fontSize: 12, fontWeight: "700" },

    technicalBox: {
      backgroundColor: "#F8FAFC",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      gap: 6,
    },
    technicalFieldLabel: { color: Colors.slate500, fontSize: 11, fontWeight: "700", textAlign: "right" },
    technicalCode: {
      fontFamily: "monospace",
      fontSize: 11,
      color: Colors.slate800,
      backgroundColor: Colors.white,
      padding: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: "#E2E8F0",
      textAlign: "left",
    },

    historyCard: {
      backgroundColor: Colors.white,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: "#E2E8F0",
      padding: Spacing.lg,
      gap: 8,
    },
    historyBadge: {
      backgroundColor: Colors.successLight,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
    },
    historyBadgeText: { color: Colors.successText, fontWeight: "800", fontSize: 12 },

    resolutionAuditBox: {
      backgroundColor: "#F0FDF4",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: "#DCFCE7",
      padding: Spacing.md,
      gap: 6,
    },
    resolutionRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
    resolutionLabel: { color: "#166534", fontWeight: "700", fontSize: 12 },
    resolutionValue: { color: "#15803D", fontWeight: "600", fontSize: 12, flex: 1, textAlign: "right" },

    unsyncedCard: {
      backgroundColor: "#FFF7ED",
      borderRadius: 14,
      borderWidth: 1,
      borderColor: "#FED7AA",
      padding: Spacing.md,
      gap: 4,
    },
    operationCard: {
      backgroundColor: Colors.white,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      gap: 4,
    },
    status: { fontWeight: "900", fontSize: 13 },
    entity: { color: Colors.slate800, fontWeight: "800", fontSize: 13 },
    operationId: { color: Colors.slate500, fontSize: 11, textAlign: "left" },
    meta: { color: Colors.slate600, fontSize: 12, textAlign: "right" },
    pendingReason: { color: Colors.warningText, fontSize: 12, textAlign: "right" },
    empty: { color: Colors.slate500, textAlign: "center", padding: Spacing.xl },

    // Modal Styles
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.65)",
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    modalCard: {
      backgroundColor: Colors.white,
      borderRadius: 20,
      padding: Spacing.xl,
      width: "100%",
      maxWidth: 480,
      gap: Spacing.md,
      elevation: 6,
    },
    modalHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
    modalTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" },
    modalWarningNote: { color: Colors.slate600, fontSize: 13, lineHeight: 20, textAlign: "right" },
    modalSummaryBox: {
      backgroundColor: "#F8FAFC",
      borderRadius: 10,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: Colors.border,
      gap: 4,
    },
    modalSummaryEntity: { color: Colors.slate800, fontWeight: "700", fontSize: 13, textAlign: "right" },
    modalSummaryReason: { color: Colors.dangerText, fontSize: 12, fontWeight: "600", textAlign: "right" },
    modalInputLabel: { color: Colors.slate800, fontWeight: "700", fontSize: 13, textAlign: "right" },
    modalTextInput: {
      backgroundColor: "#F8FAFC",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      minHeight: 88,
      textAlignVertical: "top",
      color: Colors.slate900,
      fontSize: 13,
      textAlign: "right",
    },
    modalErrorText: { color: Colors.dangerText, fontSize: 12, fontWeight: "700", textAlign: "right" },
    modalActionsRow: { flexDirection: "row-reverse", gap: Spacing.sm, marginTop: Spacing.xs },
    modalConfirmButton: {
      flex: 1,
      backgroundColor: Colors.primary,
      borderRadius: 12,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    modalConfirmButtonText: { color: Colors.white, fontWeight: "800", fontSize: 14 },
    modalConfirmRetryButton: {
      flex: 1,
      backgroundColor: Colors.primary,
      borderRadius: 12,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    modalEligibilityNote: { color: Colors.slate600, fontSize: 12, marginTop: 4, textAlign: "right", fontWeight: "600" },
    modalCancelButton: {
      flex: 1,
      backgroundColor: Colors.white,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: Colors.border,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    modalCancelButtonText: { color: Colors.slate700, fontWeight: "700", fontSize: 14 },
  });
