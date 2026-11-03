import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import {
  CreatePaymentRequestResult,
  GroupWithPaymentRequestSummary,
  PaymentRequestRepository,
} from "../../features/payments/PaymentRequestRepository";
import {
  AppButton,
  AppCard,
  AppInput,
  EmptyState,
  StatusBadge,
} from "../../shared/components";
import {
  GroupPaymentRequest,
  StudentPaymentRequestObligation,
} from "../../shared/types";
import { smartSearch } from "../../shared/utils/smartSearch";

const formatMoney = (value: number) => `${Number(value || 0).toFixed(2)} ج.م`;

const formatDateArabic = (iso?: string | null) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString("ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(iso).slice(0, 10);
  }
};

const REFERENCE_MONTH_SUGGESTIONS = [
  "يناير 2026",
  "فبراير 2026",
  "مارس 2026",
  "أبريل 2026",
  "مايو 2026",
  "يونيو 2026",
  "يوليو 2026",
  "أغسطس 2026",
  "سبتمبر 2026",
  "أكتوبر 2026",
  "نوفمبر 2026",
  "ديسمبر 2026",
];

type StudentStatusFilter = "all" | "unpaid" | "paid";

interface FeedbackBannerState {
  type: "success" | "error" | "info";
  title: string;
  message: string;
}

export default function PaymentRequestsScreen() {
  const localDataRevision = useLocalDataRevision();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const currentUser = useAuthStore((state) => state.currentUser);
  const activeCenterId = useAuthStore((state) => state.activeCenterId);
  const userPermissions = useMemo(
    () => resolveUserPermissions(currentUser),
    [currentUser],
  );

  const canView = useMemo(
    () =>
      PermissionService.hasAnyPermission(userPermissions, [
        "payments.view",
        "payments.create",
        "payments.edit",
        "payments.adjust",
      ]),
    [userPermissions],
  );

  const canManageRequests = useMemo(
    () =>
      PermissionService.hasAnyPermission(userPermissions, [
        "payments.create",
        "payments.edit",
        "payments.adjust",
      ]),
    [userPermissions],
  );

  const canCollectPayments = useMemo(
    () =>
      PermissionService.hasAnyPermission(userPermissions, [
        "payments.create",
        "payments.adjust",
        "payments.edit",
      ]),
    [userPermissions],
  );

  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<GroupWithPaymentRequestSummary[]>([]);
  const [groupQuery, setGroupQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const [requests, setRequests] = useState<GroupPaymentRequest[]>([]);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    null,
  );

  const [obligations, setObligations] = useState<
    StudentPaymentRequestObligation[]
  >([]);
  const [statusFilter, setStatusFilter] = useState<StudentStatusFilter>("all");
  const [studentQuery, setStudentQuery] = useState("");

  const [banner, setBanner] = useState<FeedbackBannerState | null>(null);

  // Create / Edit Request Modal State
  const [formModalVisible, setFormModalVisible] = useState(false);
  const [editingRequest, setEditingRequest] =
    useState<GroupPaymentRequest | null>(null);
  const [formName, setFormName] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formReferenceMonth, setFormReferenceMonth] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Creation Summary Confirmation Modal State
  const [creationConfirmation, setCreationConfirmation] =
    useState<CreatePaymentRequestResult | null>(null);

  // Archive Confirmation Modal State
  const [archiveTarget, setArchiveTarget] =
    useState<GroupPaymentRequest | null>(null);
  const [archiving, setArchiving] = useState(false);

  // Record Payment Modal State
  const [paymentTarget, setPaymentTarget] =
    useState<StudentPaymentRequestObligation | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "wallet">("cash");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [recordingPayment, setRecordingPayment] = useState(false);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );

  const selectedRequest = useMemo(
    () => requests.find((r) => r.id === selectedRequestId) || null,
    [requests, selectedRequestId],
  );

  const loadData = useCallback(() => {
    if (!canView || !activeCenterId) {
      setGroups([]);
      setRequests([]);
      setObligations([]);
      return;
    }
    setLoading(true);
    try {
      const loadedGroups = PaymentRequestRepository.getGroupsWithStudentCounts();
      setGroups(loadedGroups);

      if (selectedGroupId) {
        const groupExists = loadedGroups.some((g) => g.id === selectedGroupId);
        if (!groupExists) {
          setSelectedGroupId(null);
          setSelectedRequestId(null);
          setRequests([]);
          setObligations([]);
        } else {
          const loadedRequests = PaymentRequestRepository.getRequestsForGroup(
            selectedGroupId,
            includeArchived,
          );
          setRequests(loadedRequests);

          if (selectedRequestId) {
            const reqExists = loadedRequests.some(
              (r) => r.id === selectedRequestId,
            );
            if (!reqExists) {
              setSelectedRequestId(null);
              setObligations([]);
            } else {
              const loadedObligations =
                PaymentRequestRepository.getRequestObligations(
                  selectedRequestId,
                );
              setObligations(loadedObligations);
            }
          }
        }
      }
    } catch (error: any) {
      setBanner({
        type: "error",
        title: "تعذر تحميل البيانات",
        message: error?.message || "حدث خطأ أثناء تحميل متطالبات الدفع.",
      });
    } finally {
      setLoading(false);
    }
  }, [
    canView,
    activeCenterId,
    selectedGroupId,
    selectedRequestId,
    includeArchived,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (localDataRevision > 0) {
      loadData();
    }
  }, [localDataRevision, loadData]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  const filteredGroups = useMemo(() => {
    if (!groupQuery.trim()) return groups;
    return smartSearch(groups, groupQuery, [
      { get: (g) => g.name, weight: 1.4 },
      { get: (g) => g.grade, weight: 1.1 },
      { get: (g) => g.teacherName, weight: 1.1 },
      { get: (g) => g.subjectName, weight: 1.0 },
    ]);
  }, [groups, groupQuery]);

  const requestDetails = useMemo(() => {
    if (!selectedRequestId || !canView || !activeCenterId) return null;
    try {
      return PaymentRequestRepository.getRequestDetails(selectedRequestId, {
        filter: statusFilter,
        searchQuery: studentQuery,
      });
    } catch {
      return null;
    }
  }, [
    selectedRequestId,
    canView,
    activeCenterId,
    statusFilter,
    studentQuery,
    obligations,
    requests,
    localDataRevision,
  ]);

  const filteredObligations = useMemo(
    () => requestDetails?.students || [],
    [requestDetails],
  );

  const openCreateModal = () => {
    setEditingRequest(null);
    setFormName("");
    setFormAmount("");
    setFormReferenceMonth("");
    setFormError(null);
    setFormModalVisible(true);
  };

  const openEditModal = (request: GroupPaymentRequest) => {
    setEditingRequest(request);
    setFormName(request.name);
    setFormAmount(String(request.amount));
    setFormReferenceMonth(request.referenceMonth || "");
    setFormError(null);
    setFormModalVisible(true);
  };

  const handleSaveRequest = async () => {
    if (!selectedGroupId) return;
    setFormError(null);

    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError("اسم المتطلب مطلوب ولا يمكن أن يكون فارغًا.");
      return;
    }

    const normalizedAmountText = formAmount.replace(/,/g, ".").trim();
    const parsedAmount = Number(normalizedAmountText);
    if (!normalizedAmountText || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setFormError("السعر يجب أن يكون رقمًا أكبر من صفر.");
      return;
    }
    const roundedAmount = Math.round(parsedAmount * 100) / 100;
    if (Math.abs(parsedAmount - roundedAmount) > 0.000001) {
      setFormError("السعر يجب ألا يتجاوز منزلتين عشريتين.");
      return;
    }

    setFormSubmitting(true);
    try {
      if (editingRequest) {
        await PaymentRequestRepository.updateRequest({
          requestId: editingRequest.id,
          name: trimmedName,
          amount: roundedAmount,
          referenceMonth: formReferenceMonth.trim() || null,
        });
        setFormModalVisible(false);
        setEditingRequest(null);
        setBanner({
          type: "success",
          title: "تم تحديث المتطلب",
          message:
            "تم حفظ التعديلات وتحديث المطالبات غير المدفوعة فقط مع الحفاظ على المدفوعات السابقة.",
        });
        loadData();
      } else {
        const result = await PaymentRequestRepository.createRequest({
          groupId: selectedGroupId,
          name: trimmedName,
          amount: roundedAmount,
          referenceMonth: formReferenceMonth.trim() || null,
        });
        setFormModalVisible(false);
        setCreationConfirmation(result);
        setBanner({
          type: "success",
          title: "تم إنشاء المتطلب",
          message: `تم تسجيل متطلب "${result.request.name}" لعدد ${result.affectedStudentsCount} طالب في مجموعة ${result.groupName}.`,
        });
        loadData();
      }
    } catch (error: any) {
      setFormError(error?.message || "تعذر حفظ متطلب الدفع.");
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await PaymentRequestRepository.archiveRequest({
        requestId: archiveTarget.id,
      });
      const archivedName = archiveTarget.name;
      setArchiveTarget(null);
      setBanner({
        type: "success",
        title: "تمت أرشفة المتطلب",
        message: `تمت أرشفة "${archivedName}" وإلغاء المطالبات غير المسددة مع الاحتفاظ بسجل المدفوعات المحصلة.`,
      });
      loadData();
    } catch (error: any) {
      setArchiveTarget(null);
      setBanner({
        type: "error",
        title: "تعذر أرشفة المتطلب",
        message: error?.message || "حدث خطأ أثناء أرشفة متطلب الدفع.",
      });
    } finally {
      setArchiving(false);
    }
  };

  const openPaymentModal = (obligation: StudentPaymentRequestObligation) => {
    setPaymentTarget(obligation);
    setPaymentMethod("cash");
    setPaymentNotes("");
    setPaymentError(null);
  };

  const handleConfirmPayment = async () => {
    if (!paymentTarget) return;
    setPaymentError(null);
    setRecordingPayment(true);
    try {
      await PaymentRequestRepository.recordObligationPayment({
        obligationId: paymentTarget.id,
        paymentMethod,
        notes: paymentNotes.trim() || undefined,
      });
      const studentLabel = paymentTarget.studentName || "الطالب";
      const paidAmount = paymentTarget.amountDue;
      setPaymentTarget(null);
      setBanner({
        type: "success",
        title: "تم تسجيل الدفع",
        message: `تم تحصيل ${formatMoney(paidAmount)} للطالب ${studentLabel} بنجاح.`,
      });
      loadData();
    } catch (error: any) {
      setPaymentError(error?.message || "تعذر تسجيل عملية الدفع.");
    } finally {
      setRecordingPayment(false);
    }
  };

  if (!canView) {
    return (
      <SafeAreaView
        style={[styles.safe, { backgroundColor: colors.background }]}
      >
        <View style={styles.locked}>
          <Ionicons
            name="lock-closed-outline"
            size={34}
            color={colors.slate500}
          />
          <Text style={styles.lockedTitle}>القسم غير متاح</Text>
          <Text style={styles.lockedText}>
            ليس لديك صلاحية الوصول إلى متطالبات الدفع.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Screen Header */}
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>إدارة مالية</Text>
            <Text style={styles.title}>متطالبات الدفع</Text>
            <Text style={styles.subtitle}>
              إدارة المذكرات والملازم والمستلزمات الإضافية لطلاب المجموعات بشكل
              مستقل عن الاشتراكات الشهرية.
            </Text>
          </View>
          <View style={styles.headerIcon}>
            <Ionicons
              name="document-text-outline"
              size={25}
              color={colors.primary}
            />
          </View>
        </View>

        {/* Internal Status Banner */}
        {banner ? (
          <View
            style={[
              styles.banner,
              banner.type === "error"
                ? styles.bannerError
                : banner.type === "success"
                  ? styles.bannerSuccess
                  : styles.bannerInfo,
            ]}
          >
            <View style={styles.bannerCopy}>
              <Text
                style={[
                  styles.bannerTitle,
                  banner.type === "error"
                    ? { color: colors.dangerText }
                    : banner.type === "success"
                      ? { color: colors.successText }
                      : { color: colors.primary },
                ]}
              >
                {banner.title}
              </Text>
              <Text style={styles.bannerMessage}>{banner.message}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setBanner(null)}
              style={styles.bannerClose}
              accessibilityLabel="إغلاق التنبيه"
            >
              <Ionicons name="close" size={18} color={colors.slate500} />
            </TouchableOpacity>
          </View>
        ) : null}

        {loading && groups.length === 0 ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.loadingText}>جاري تحميل البيانات...</Text>
          </View>
        ) : null}

        {/* VIEW 1: Groups Selection Screen */}
        {!selectedGroup ? (
          <View style={styles.sectionBlock}>
            <AppInput
              label="بحث عن المجموعة"
              value={groupQuery}
              onChangeText={setGroupQuery}
              placeholder="اسم المجموعة أو المرحلة أو المدرس أو المادة"
            />

            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>مجموعات المركز</Text>
              <Text style={styles.sectionCount}>
                {filteredGroups.length} مجموعة
              </Text>
            </View>

            {filteredGroups.map((group) => (
              <TouchableOpacity
                key={group.id}
                style={styles.groupCard}
                activeOpacity={0.82}
                onPress={() => {
                  setBanner(null);
                  setSelectedGroupId(group.id);
                  setSelectedRequestId(null);
                }}
              >
                <View style={styles.groupCardTop}>
                  <View style={styles.groupCopy}>
                    <Text style={styles.groupName}>{group.name}</Text>
                    <Text style={styles.groupMeta}>
                      {[group.grade, group.subjectName, group.teacherName]
                        .filter(Boolean)
                        .join(" · ") || "مجموعة دراسية"}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-back"
                    size={19}
                    color={colors.slate400}
                  />
                </View>

                <View style={styles.groupStatsRow}>
                  <View style={styles.statPill}>
                    <Ionicons
                      name="people-outline"
                      size={15}
                      color={colors.primary}
                    />
                    <Text style={styles.statPillText}>
                      الطلاب المسجلون النشطون: {group.activeStudentsCount}
                    </Text>
                  </View>

                  <View style={styles.statPillSecondary}>
                    <Ionicons
                      name="document-text-outline"
                      size={15}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.statPillSecondaryText}>
                      المتطالبات النشطة: {group.activeRequestsCount}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}

            {!loading && filteredGroups.length === 0 ? (
              <EmptyState message="لا توجد مجموعات نشطة مطابقة للبحث في هذا المركز." />
            ) : null}
          </View>
        ) : null}

        {/* VIEW 2: Group Payment Requests Management Screen */}
        {selectedGroup && !selectedRequest ? (
          <View style={styles.sectionBlock}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => {
                setSelectedGroupId(null);
                setSelectedRequestId(null);
                setBanner(null);
              }}
            >
              <Ionicons name="arrow-forward" size={18} color={colors.primary} />
              <Text style={styles.backBtnText}>العودة إلى قائمة المجموعات</Text>
            </TouchableOpacity>

            <AppCard style={styles.selectedGroupSummary}>
              <View style={styles.selectedGroupTop}>
                <View style={styles.groupCopy}>
                  <Text style={styles.selectedGroupTitle}>
                    {selectedGroup.name}
                  </Text>
                  <Text style={styles.groupMeta}>
                    {[
                      selectedGroup.grade,
                      selectedGroup.subjectName,
                      selectedGroup.teacherName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <StatusBadge
                  text={`${selectedGroup.activeStudentsCount} طالب نشط`}
                  type="info"
                />
              </View>

              {canManageRequests ? (
                <View style={styles.createActionWrap}>
                  <AppButton
                    title="إضافة متطلب دفع جديد"
                    onPress={openCreateModal}
                  />
                </View>
              ) : null}
            </AppCard>

            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>متطالبات المجموعة</Text>
              <TouchableOpacity
                onPress={() => setIncludeArchived((prev) => !prev)}
                style={styles.toggleArchiveBtn}
              >
                <Text style={styles.toggleArchiveText}>
                  {includeArchived ? "إخفاء المؤرشف" : "إظهار المؤرشف"}
                </Text>
              </TouchableOpacity>
            </View>

            {requests.map((req) => {
              const isArchived = req.status === "archived";
              return (
                <AppCard key={req.id} style={styles.requestCard}>
                  <View style={styles.requestHeaderRow}>
                    <View style={styles.groupCopy}>
                      <Text style={styles.requestTitle}>{req.name}</Text>
                      <Text style={styles.requestMeta}>
                        {req.referenceMonth
                          ? `الشهر المرجعي: ${req.referenceMonth}`
                          : "بدون شهر مرجعي"}
                      </Text>
                    </View>
                    <StatusBadge
                      text={isArchived ? "مؤرشف" : "نشط"}
                      type={isArchived ? "neutral" : "success"}
                    />
                  </View>

                  <View style={styles.metricsGrid}>
                    <View style={styles.metricCell}>
                      <Text style={styles.metricLabel}>السعر</Text>
                      <Text style={styles.metricValuePrimary}>
                        {formatMoney(req.amount)}
                      </Text>
                    </View>
                    <View style={styles.metricCell}>
                      <Text style={styles.metricLabel}>سددوا</Text>
                      <Text
                        style={[
                          styles.metricValue,
                          { color: colors.successText },
                        ]}
                      >
                        {req.paidCount ?? 0} طالب
                      </Text>
                    </View>
                    <View style={styles.metricCell}>
                      <Text style={styles.metricLabel}>متبقي عليهم</Text>
                      <Text
                        style={[
                          styles.metricValue,
                          {
                            color:
                              (req.unpaidCount ?? 0) > 0
                                ? colors.dangerText
                                : colors.textPrimary,
                          },
                        ]}
                      >
                        {req.unpaidCount ?? 0} طالب
                      </Text>
                    </View>
                  </View>

                  <View style={styles.requestActionsRow}>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        styles.actionBtnPrimary,
                      ]}
                      onPress={() => {
                        setBanner(null);
                        setStatusFilter("all");
                        setStudentQuery("");
                        setSelectedRequestId(req.id);
                      }}
                    >
                      <Ionicons
                        name="list-outline"
                        size={16}
                        color={colors.primary}
                      />
                      <Text style={styles.actionBtnPrimaryText}>
                        التفاصيل وحالة الدفع
                      </Text>
                    </TouchableOpacity>

                    {!isArchived && canManageRequests ? (
                      <>
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={() => openEditModal(req)}
                        >
                          <Ionicons
                            name="create-outline"
                            size={16}
                            color={colors.textPrimary}
                          />
                          <Text style={styles.actionBtnText}>تعديل</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[styles.actionBtn, styles.actionBtnDanger]}
                          onPress={() => setArchiveTarget(req)}
                        >
                          <Ionicons
                            name="archive-outline"
                            size={16}
                            color={colors.dangerText}
                          />
                          <Text style={styles.actionBtnDangerText}>أرشفة</Text>
                        </TouchableOpacity>
                      </>
                    ) : null}
                  </View>
                </AppCard>
              );
            })}

            {requests.length === 0 ? (
              <EmptyState message="لا توجد متطالبات دفع مسجلة لهذه المجموعة حتى الآن." />
            ) : null}
          </View>
        ) : null}

        {/* VIEW 3: Request Details & Collection Statistics Screen */}
        {selectedGroup && selectedRequest && requestDetails ? (
          <View style={styles.sectionBlock}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => {
                setSelectedRequestId(null);
                setObligations([]);
                setStatusFilter("all");
                setStudentQuery("");
                setBanner(null);
              }}
            >
              <Ionicons name="arrow-forward" size={18} color={colors.primary} />
              <Text style={styles.backBtnText}>
                العودة إلى متطالبات {selectedGroup.name}
              </Text>
            </TouchableOpacity>

            {/* 1. Payment Request Top Details Card */}
            <AppCard style={styles.selectedGroupSummary}>
              <View style={styles.requestHeaderRow}>
                <View style={styles.groupCopy}>
                  <Text style={styles.detailsEyebrow}>تفاصيل متطلب الدفع</Text>
                  <Text style={styles.selectedGroupTitle}>
                    {selectedRequest.name}
                  </Text>
                </View>
                <StatusBadge
                  text={selectedRequest.status === "archived" ? "مؤرشف" : "نشط"}
                  type={
                    selectedRequest.status === "archived"
                      ? "neutral"
                      : "success"
                  }
                />
              </View>

              <View style={styles.topInfoGrid}>
                <View style={styles.topInfoItem}>
                  <Text style={styles.topInfoLabel}>قيمة المتطلب</Text>
                  <Text style={styles.topInfoValuePrimary}>
                    {formatMoney(selectedRequest.amount)}
                  </Text>
                </View>

                <View style={styles.topInfoItem}>
                  <Text style={styles.topInfoLabel}>المجموعة</Text>
                  <Text style={styles.topInfoValue}>{selectedGroup.name}</Text>
                </View>

                {selectedRequest.referenceMonth ? (
                  <View style={styles.topInfoItem}>
                    <Text style={styles.topInfoLabel}>الشهر المرجعي</Text>
                    <Text style={styles.topInfoValue}>
                      {selectedRequest.referenceMonth}
                    </Text>
                  </View>
                ) : null}
              </View>
            </AppCard>

            {/* 2. Collection Statistics Dashboard */}
            <AppCard style={styles.statsDashboardCard}>
              <View style={styles.statsHeaderRow}>
                <Text style={styles.statsSectionTitle}>إحصائيات التحصيل</Text>
                <View style={styles.percentageBadge}>
                  <Text style={styles.percentageBadgeText}>
                    نسبة التحصيل:{" "}
                    {requestDetails.statistics.collectionPercentage
                      .toFixed(2)
                      .replace(/\.00$/, "")}
                    %
                  </Text>
                </View>
              </View>

              {/* Collection Progress Indicator */}
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          requestDetails.statistics.collectionPercentage,
                        ),
                      )}%`,
                    },
                  ]}
                />
              </View>

              <View style={styles.statsCardsGrid}>
                <View style={styles.statBox}>
                  <Text style={styles.statBoxLabel}>إجمالي الطلاب</Text>
                  <Text style={styles.statBoxValue}>
                    {requestDetails.statistics.totalStudents} طالب
                  </Text>
                </View>

                <View style={[styles.statBox, styles.statBoxPaid]}>
                  <Text style={styles.statBoxLabel}>دفعوا</Text>
                  <Text
                    style={[
                      styles.statBoxValue,
                      { color: colors.successText },
                    ]}
                  >
                    {requestDetails.statistics.paidStudentsCount} طالب
                  </Text>
                </View>

                <View style={[styles.statBox, styles.statBoxUnpaid]}>
                  <Text style={styles.statBoxLabel}>لم يدفعوا</Text>
                  <Text
                    style={[
                      styles.statBoxValue,
                      {
                        color:
                          requestDetails.statistics.unpaidStudentsCount > 0
                            ? colors.dangerText
                            : colors.textPrimary,
                      },
                    ]}
                  >
                    {requestDetails.statistics.unpaidStudentsCount} طالب
                  </Text>
                </View>

                <View style={styles.statBoxWide}>
                  <Text style={styles.statBoxLabel}>إجمالي المبلغ المحصل</Text>
                  <Text
                    style={[
                      styles.statBoxAmountValue,
                      { color: colors.successText },
                    ]}
                  >
                    {formatMoney(
                      requestDetails.statistics.totalCollectedAmount,
                    )}
                  </Text>
                </View>

                <View style={styles.statBoxWide}>
                  <Text style={styles.statBoxLabel}>إجمالي المبلغ المتبقي</Text>
                  <Text
                    style={[
                      styles.statBoxAmountValue,
                      {
                        color:
                          requestDetails.statistics.totalOutstandingAmount > 0
                            ? colors.dangerText
                            : colors.textPrimary,
                      },
                    ]}
                  >
                    {formatMoney(
                      requestDetails.statistics.totalOutstandingAmount,
                    )}
                  </Text>
                </View>

                <View style={styles.statBoxWide}>
                  <Text style={styles.statBoxLabel}>نسبة التحصيل</Text>
                  <Text
                    style={[
                      styles.statBoxAmountValue,
                      { color: colors.primary },
                    ]}
                  >
                    {requestDetails.statistics.collectionPercentage
                      .toFixed(2)
                      .replace(/\.00$/, "")}
                    %
                  </Text>
                </View>
              </View>
            </AppCard>

            {/* 4. Filters (الكل / دفعوا / لم يدفعوا) */}
            <View style={styles.filterTabsRow}>
              {(
                [
                  {
                    key: "all",
                    title: "الكل",
                    count: requestDetails.statistics.totalStudents,
                  },
                  {
                    key: "paid",
                    title: "دفعوا",
                    count: requestDetails.statistics.paidStudentsCount,
                  },
                  {
                    key: "unpaid",
                    title: "لم يدفعوا",
                    count: requestDetails.statistics.unpaidStudentsCount,
                  },
                ] as const
              ).map((tab) => {
                const active = statusFilter === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    style={[
                      styles.filterTab,
                      active ? styles.filterTabActive : null,
                    ]}
                    onPress={() => setStatusFilter(tab.key)}
                  >
                    <Text
                      style={[
                        styles.filterTabText,
                        active ? styles.filterTabTextActive : null,
                      ]}
                    >
                      {tab.title} ({tab.count})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 5. Search Input within Current Payment Request */}
            <AppInput
              label="بحث عن طالب داخل المتطلب"
              value={studentQuery}
              onChangeText={setStudentQuery}
              placeholder="ابحث باسم الطالب أو كود الطالب"
            />

            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>قائمة الطلاب المسجلين بالمتطلب</Text>
              <Text style={styles.sectionCount}>
                العدد المعروض: {requestDetails.displayedCount} من{" "}
                {requestDetails.statistics.totalStudents}
              </Text>
            </View>

            {/* 3. Student List */}
            {filteredObligations.map((ob) => {
              const isPaid = Boolean(ob.isPaid);
              const isPartiallyPaid = Boolean(ob.isPartiallyPaid);
              const isCancelled = ob.status === "cancelled";
              const remainingOwed =
                ob.amountOwed !== undefined
                  ? ob.amountOwed
                  : isPaid || isCancelled
                    ? 0
                    : Math.max(0, ob.amountDue - (ob.amountPaid || 0));

              return (
                <AppCard
                  key={ob.id}
                  style={[
                    styles.obligationCard,
                    isPaid
                      ? styles.obligationCardPaid
                      : isCancelled
                        ? styles.obligationCardCancelled
                        : styles.obligationCardUnpaid,
                  ]}
                >
                  <View style={styles.requestHeaderRow}>
                    <View style={styles.groupCopy}>
                      <Text style={styles.studentName}>
                        {ob.studentName || "طالب"}
                      </Text>
                      <Text style={styles.studentCodeText}>
                        كود الطالب: {ob.studentCode || "غير متوفر"}
                      </Text>
                    </View>
                    <StatusBadge
                      text={
                        isPaid
                          ? "دفع"
                          : isPartiallyPaid
                            ? "سداد جزئي"
                            : isCancelled
                              ? "ملغى / مؤرشف"
                              : "لم يدفع"
                      }
                      type={
                        isPaid
                          ? "success"
                          : isPartiallyPaid
                            ? "info"
                            : isCancelled
                              ? "neutral"
                              : "warning"
                      }
                    />
                  </View>

                  <View style={styles.obligationDetailsRow}>
                    <View style={styles.obligationDetailItem}>
                      <Text style={styles.metricLabel}>المبلغ المطلوب</Text>
                      <Text style={styles.metricValuePrimary}>
                        {formatMoney(remainingOwed)}
                      </Text>
                    </View>

                    <View style={styles.obligationDetailItem}>
                      <Text style={styles.metricLabel}>قيمة المتطلب</Text>
                      <Text style={styles.metricValue}>
                        {formatMoney(ob.amountDue)}
                      </Text>
                    </View>

                    {isPaid || isPartiallyPaid ? (
                      <View style={styles.obligationDetailItem}>
                        <Text style={styles.metricLabel}>المبلغ المدفوع</Text>
                        <Text
                          style={[
                            styles.metricValue,
                            { color: colors.successText },
                          ]}
                        >
                          {formatMoney(ob.confirmedAmountPaid ?? ob.amountPaid)}
                        </Text>
                      </View>
                    ) : null}

                    {isPaid && ob.paidAt ? (
                      <View style={styles.obligationDetailItem}>
                        <Text style={styles.metricLabel}>تاريخ الدفع</Text>
                        <Text style={styles.metricValue}>
                          {formatDateArabic(ob.paidAt)}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  {!isPaid &&
                  !isCancelled &&
                  selectedRequest.status === "active" &&
                  canCollectPayments ? (
                    <View style={styles.obligationActionWrap}>
                      <AppButton
                        title={`تسجيل الدفع (${formatMoney(remainingOwed)})`}
                        onPress={() => openPaymentModal(ob)}
                      />
                    </View>
                  ) : null}
                </AppCard>
              );
            })}

            {filteredObligations.length === 0 ? (
              <EmptyState message="لا يوجد طلاب مطابقون للفلتر أو البحث الحالي داخل هذا المتطلب." />
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/* MODAL 1: Create / Edit Payment Request */}
      <Modal
        visible={formModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!formSubmitting) setFormModalVisible(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingRequest ? "تعديل متطلب الدفع" : "إضافة متطلب دفع جديد"}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  if (!formSubmitting) setFormModalVisible(false);
                }}
              >
                <Ionicons name="close" size={22} color={colors.slate500} />
              </TouchableOpacity>
            </View>

            {selectedGroup ? (
              <Text style={styles.modalSubheader}>
                المجموعة: {selectedGroup.name} (
                {selectedGroup.activeStudentsCount} طالب مسجل حاليًا)
              </Text>
            ) : null}

            <AppInput
              label="اسم المتطلب *"
              value={formName}
              onChangeText={setFormName}
              placeholder="مثال: مذكرة 1"
            />

            <AppInput
              label="السعر (ج.م) *"
              value={formAmount}
              onChangeText={setFormAmount}
              placeholder="مثال: 75"
              keyboardType="decimal-pad"
            />

            <AppInput
              label="الشهر (اختياري)"
              value={formReferenceMonth}
              onChangeText={setFormReferenceMonth}
              placeholder="مثال: نوفمبر 2026 (شهر مرجعي فقط)"
            />

            <View style={styles.monthSuggestionsWrap}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.monthSuggestionsScroll}
              >
                {REFERENCE_MONTH_SUGGESTIONS.map((monthLabel) => {
                  const selected = formReferenceMonth.trim() === monthLabel;
                  return (
                    <TouchableOpacity
                      key={monthLabel}
                      style={[
                        styles.monthChip,
                        selected ? styles.monthChipActive : null,
                      ]}
                      onPress={() =>
                        setFormReferenceMonth(selected ? "" : monthLabel)
                      }
                    >
                      <Text
                        style={[
                          styles.monthChipText,
                          selected ? styles.monthChipTextActive : null,
                        ]}
                      >
                        {monthLabel}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <Text style={styles.helperNote}>
              {editingRequest
                ? "ملاحظة: تعديل السعر يُطبّق فقط على الطلاب الذين لم يسددوا بعد، ولا يغيّر المدفوعات المسجلة مسبقًا."
                : "ملاحظة: الشهر اختياري ويُستخدم كمرجع فقط وليس تاريخ انتهاء، ويبقى المتطلب نشطًا حتى سداده أو أرشفته."}
            </Text>

            {formError ? (
              <Text style={styles.modalErrorText}>{formError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <View style={styles.modalActionItem}>
                <AppButton
                  title={editingRequest ? "حفظ التعديلات" : "إنشاء المتطلب"}
                  onPress={handleSaveRequest}
                  loading={formSubmitting}
                />
              </View>
              <View style={styles.modalActionItem}>
                <AppButton
                  title="إلغاء"
                  variant="outline"
                  onPress={() => setFormModalVisible(false)}
                  disabled={formSubmitting}
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* MODAL 2: Post-Creation Confirmation Summary */}
      <Modal
        visible={Boolean(creationConfirmation)}
        transparent
        animationType="fade"
        onRequestClose={() => setCreationConfirmation(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>تأكيد إنشاء متطلب الدفع</Text>
              <TouchableOpacity onPress={() => setCreationConfirmation(null)}>
                <Ionicons name="close" size={22} color={colors.slate500} />
              </TouchableOpacity>
            </View>

            {creationConfirmation ? (
              <View style={styles.confirmationBox}>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>المجموعة</Text>
                  <Text style={styles.confirmationValue}>
                    {creationConfirmation.groupName}
                  </Text>
                </View>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>اسم المتطلب</Text>
                  <Text style={styles.confirmationValue}>
                    {creationConfirmation.request.name}
                  </Text>
                </View>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>السعر</Text>
                  <Text style={styles.confirmationValue}>
                    {formatMoney(creationConfirmation.request.amount)}
                  </Text>
                </View>
                {creationConfirmation.request.referenceMonth ? (
                  <View style={styles.confirmationRow}>
                    <Text style={styles.confirmationLabel}>الشهر المرجعي</Text>
                    <Text style={styles.confirmationValue}>
                      {creationConfirmation.request.referenceMonth}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>
                    عدد الطلاب المطبق عليهم
                  </Text>
                  <Text style={styles.confirmationValue}>
                    {creationConfirmation.affectedStudentsCount} طالب
                  </Text>
                </View>
              </View>
            ) : null}

            <AppButton
              title="تم"
              onPress={() => setCreationConfirmation(null)}
            />
          </View>
        </View>
      </Modal>

      {/* MODAL 3: Archive Confirmation */}
      <Modal
        visible={Boolean(archiveTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!archiving) setArchiveTarget(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>أرشفة متطلب الدفع</Text>
              <TouchableOpacity
                onPress={() => {
                  if (!archiving) setArchiveTarget(null);
                }}
              >
                <Ionicons name="close" size={22} color={colors.slate500} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalBodyText}>
              هل أنت متأكد من أرشفة المتطلب "{archiveTarget?.name}"؟ سيتم إلغاء
              المطالبات غير المدفوعة حتى لا تُحتسب ضمن مديونية الطلاب، مع
              الاحتفاظ الكامل بجميع المدفوعات المسجلة مسبقًا في السجل المالي.
            </Text>

            <View style={styles.modalActions}>
              <View style={styles.modalActionItem}>
                <AppButton
                  title="تأكيد الأرشفة"
                  onPress={handleConfirmArchive}
                  loading={archiving}
                />
              </View>
              <View style={styles.modalActionItem}>
                <AppButton
                  title="تراجع"
                  variant="outline"
                  onPress={() => setArchiveTarget(null)}
                  disabled={archiving}
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* MODAL 4: Record Student Obligation Payment */}
      <Modal
        visible={Boolean(paymentTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!recordingPayment) setPaymentTarget(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>تسجيل سداد متطلب دفع</Text>
              <TouchableOpacity
                onPress={() => {
                  if (!recordingPayment) setPaymentTarget(null);
                }}
              >
                <Ionicons name="close" size={22} color={colors.slate500} />
              </TouchableOpacity>
            </View>

            {paymentTarget ? (
              <View style={styles.confirmationBox}>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>الطالب</Text>
                  <Text style={styles.confirmationValue}>
                    {paymentTarget.studentName || "طالب"}
                  </Text>
                </View>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>كود الطالب</Text>
                  <Text style={styles.confirmationValue}>
                    {paymentTarget.studentCode || "غير متوفر"}
                  </Text>
                </View>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>المتطلب</Text>
                  <Text style={styles.confirmationValue}>
                    {selectedRequest?.name || paymentTarget.requestName || ""}
                  </Text>
                </View>
                <View style={styles.confirmationRow}>
                  <Text style={styles.confirmationLabel}>المبلغ المستحق</Text>
                  <Text style={styles.confirmationValue}>
                    {formatMoney(paymentTarget.amountDue)}
                  </Text>
                </View>
              </View>
            ) : null}

            <Text style={styles.methodSectionLabel}>طريقة الدفع</Text>
            <View style={styles.methodRow}>
              <TouchableOpacity
                style={[
                  styles.methodChip,
                  paymentMethod === "cash" ? styles.methodChipActive : null,
                ]}
                onPress={() => setPaymentMethod("cash")}
              >
                <Text
                  style={[
                    styles.methodChipText,
                    paymentMethod === "cash"
                      ? styles.methodChipTextActive
                      : null,
                  ]}
                >
                  نقدي (كاش)
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.methodChip,
                  paymentMethod === "wallet" ? styles.methodChipActive : null,
                ]}
                onPress={() => setPaymentMethod("wallet")}
              >
                <Text
                  style={[
                    styles.methodChipText,
                    paymentMethod === "wallet"
                      ? styles.methodChipTextActive
                      : null,
                  ]}
                >
                  محفظة إلكترونية
                </Text>
              </TouchableOpacity>
            </View>

            <AppInput
              label="ملاحظات (اختياري)"
              value={paymentNotes}
              onChangeText={setPaymentNotes}
              placeholder="ملاحظات إضافية على عملية التحصيل"
            />

            {paymentError ? (
              <Text style={styles.modalErrorText}>{paymentError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <View style={styles.modalActionItem}>
                <AppButton
                  title="تأكيد التحصيل"
                  onPress={handleConfirmPayment}
                  loading={recordingPayment}
                />
              </View>
              <View style={styles.modalActionItem}>
                <AppButton
                  title="إلغاء"
                  variant="outline"
                  onPress={() => setPaymentTarget(null)}
                  disabled={recordingPayment}
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) =>
  StyleSheet.create({
    safe: { flex: 1 },
    content: { padding: Spacing.lg, paddingBottom: 44, gap: 12 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 4,
    },
    headerCopy: { flex: 1, paddingLeft: 10 },
    eyebrow: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
      textAlign: "right",
    },
    title: {
      ...Typography.h1,
      color: colors.textPrimary,
      textAlign: "right",
      marginTop: 2,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 4,
      lineHeight: 18,
    },
    headerIcon: {
      width: 52,
      height: 52,
      borderRadius: 17,
      backgroundColor: colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    banner: {
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      justifyContent: "space-between",
      borderRadius: 14,
      borderWidth: 1,
      padding: 12,
      gap: 10,
    },
    bannerSuccess: {
      backgroundColor: colors.successLight || "#ECFDF5",
      borderColor: colors.success || "#10B981",
    },
    bannerError: {
      backgroundColor: colors.dangerLight || "#FEF2F2",
      borderColor: colors.danger || "#EF4444",
    },
    bannerInfo: {
      backgroundColor: colors.primaryLight,
      borderColor: colors.primary,
    },
    bannerCopy: { flex: 1 },
    bannerTitle: {
      fontSize: 13,
      fontWeight: "900",
      textAlign: "right",
    },
    bannerMessage: {
      color: colors.textPrimary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 3,
      lineHeight: 18,
    },
    bannerClose: { padding: 2 },
    loadingWrap: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 16,
    },
    loadingText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: "700",
    },
    sectionBlock: { gap: 12 },
    sectionHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 4,
    },
    sectionTitle: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: "900",
      textAlign: "right",
    },
    sectionCount: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "700",
    },
    groupCard: {
      backgroundColor: colors.cardBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 14,
      gap: 10,
    },
    groupCardTop: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    groupCopy: { flex: 1 },
    groupName: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: "900",
      textAlign: "right",
    },
    groupMeta: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 3,
    },
    groupStatsRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    statPill: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.primaryLight,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 10,
    },
    statPillText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "800",
    },
    statPillSecondary: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.slate100,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 10,
    },
    statPillSecondaryText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "700",
    },
    backBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-end",
      paddingVertical: 4,
    },
    backBtnText: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: "900",
    },
    selectedGroupSummary: {
      borderColor: colors.primary,
      gap: 12,
    },
    selectedGroupTop: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    selectedGroupTitle: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: "900",
      textAlign: "right",
    },
    createActionWrap: {
      marginTop: 2,
    },
    toggleArchiveBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 9,
      backgroundColor: colors.slate100,
    },
    toggleArchiveText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "800",
    },
    requestCard: {
      gap: 12,
    },
    requestHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    requestTitle: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: "900",
      textAlign: "right",
    },
    requestMeta: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 3,
    },
    metricsGrid: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.border,
      paddingVertical: 10,
      gap: 8,
    },
    metricCell: {
      flex: 1,
      alignItems: "flex-end",
    },
    metricLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      textAlign: "right",
    },
    metricValuePrimary: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: "900",
      marginTop: 2,
      textAlign: "right",
    },
    metricValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: "900",
      marginTop: 2,
      textAlign: "right",
    },
    requestActionsRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    actionBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardBackground,
    },
    actionBtnPrimary: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryLight,
    },
    actionBtnPrimaryText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
    },
    actionBtnText: {
      color: colors.textPrimary,
      fontSize: 12,
      fontWeight: "800",
    },
    actionBtnDanger: {
      borderColor: colors.danger || "#EF4444",
      backgroundColor: colors.dangerLight || "#FEF2F2",
    },
    actionBtnDangerText: {
      color: colors.dangerText,
      fontSize: 12,
      fontWeight: "800",
    },
    filterTabsRow: {
      flexDirection: "row-reverse",
      gap: 8,
    },
    filterTab: {
      flex: 1,
      paddingVertical: 9,
      paddingHorizontal: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardBackground,
      alignItems: "center",
      justifyContent: "center",
    },
    filterTabActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryLight,
    },
    filterTabText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "800",
      textAlign: "center",
    },
    filterTabTextActive: {
      color: colors.primary,
      fontWeight: "900",
    },
    obligationCard: {
      gap: 10,
      borderRightWidth: 4,
    },
    obligationCardPaid: {
      borderColor: colors.success || "#10B981",
      borderRightColor: colors.success || "#10B981",
    },
    obligationCardUnpaid: {
      borderColor: colors.warning || "#F59E0B",
      borderRightColor: colors.danger || "#EF4444",
    },
    obligationCardCancelled: {
      borderColor: colors.border,
      borderRightColor: colors.slate400,
    },
    detailsEyebrow: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: "800",
      textAlign: "right",
      marginBottom: 2,
    },
    topInfoGrid: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderColor: colors.border,
      paddingTop: 10,
      gap: 10,
    },
    topInfoItem: {
      minWidth: "28%",
      alignItems: "flex-end",
    },
    topInfoLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      textAlign: "right",
    },
    topInfoValuePrimary: {
      color: colors.primary,
      fontSize: 15,
      fontWeight: "900",
      marginTop: 2,
      textAlign: "right",
    },
    topInfoValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: "900",
      marginTop: 2,
      textAlign: "right",
    },
    statsDashboardCard: {
      gap: 12,
    },
    statsHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    statsSectionTitle: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: "900",
      textAlign: "right",
    },
    percentageBadge: {
      backgroundColor: colors.primaryLight,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 10,
    },
    percentageBadgeText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
    },
    progressTrack: {
      width: "100%",
      height: 10,
      borderRadius: 6,
      backgroundColor: colors.slate100,
      overflow: "hidden",
      flexDirection: "row-reverse",
    },
    progressFill: {
      height: "100%",
      borderRadius: 6,
      backgroundColor: colors.success || "#10B981",
    },
    statsCardsGrid: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      gap: 8,
    },
    statBox: {
      flexGrow: 1,
      minWidth: "30%",
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 10,
      alignItems: "flex-end",
    },
    statBoxPaid: {
      borderColor: colors.success || "#10B981",
    },
    statBoxUnpaid: {
      borderColor: colors.warning || "#F59E0B",
    },
    statBoxWide: {
      flexGrow: 1,
      minWidth: "30%",
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 10,
      alignItems: "flex-end",
    },
    statBoxLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "700",
      textAlign: "right",
    },
    statBoxValue: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: "900",
      marginTop: 4,
      textAlign: "right",
    },
    statBoxAmountValue: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: "900",
      marginTop: 4,
      textAlign: "right",
    },
    studentName: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: "900",
      textAlign: "right",
    },
    studentCodeText: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 2,
    },
    obligationDetailsRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    obligationDetailItem: {
      alignItems: "flex-end",
    },
    obligationActionWrap: {
      marginTop: 4,
    },
    locked: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    lockedTitle: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: "900",
      marginTop: 10,
    },
    lockedText: {
      color: colors.textSecondary,
      marginTop: 6,
      textAlign: "center",
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.55)",
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    modalCard: {
      width: "100%",
      maxWidth: 440,
      backgroundColor: colors.cardBackground,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 18,
      gap: 12,
    },
    modalHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    modalTitle: {
      color: colors.textPrimary,
      fontSize: 17,
      fontWeight: "900",
      textAlign: "right",
    },
    modalSubheader: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "800",
      textAlign: "right",
    },
    modalBodyText: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      textAlign: "right",
    },
    monthSuggestionsWrap: {
      marginTop: -4,
    },
    monthSuggestionsScroll: {
      flexDirection: "row-reverse",
      gap: 6,
      paddingVertical: 2,
    },
    monthChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    monthChipActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryLight,
    },
    monthChipText: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "700",
    },
    monthChipTextActive: {
      color: colors.primary,
      fontWeight: "900",
    },
    helperNote: {
      color: colors.textSecondary,
      fontSize: 11,
      lineHeight: 17,
      textAlign: "right",
    },
    modalErrorText: {
      color: colors.dangerText,
      fontSize: 12,
      fontWeight: "800",
      textAlign: "right",
    },
    modalActions: {
      flexDirection: "row-reverse",
      gap: 10,
      marginTop: 4,
    },
    modalActionItem: {
      flex: 1,
    },
    confirmationBox: {
      backgroundColor: colors.background,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      gap: 8,
    },
    confirmationRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    confirmationLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "700",
      textAlign: "right",
    },
    confirmationValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: "900",
      textAlign: "left",
    },
    methodSectionLabel: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: "800",
      textAlign: "right",
    },
    methodRow: {
      flexDirection: "row-reverse",
      gap: 8,
    },
    methodChip: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      alignItems: "center",
    },
    methodChipActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryLight,
    },
    methodChipText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: "800",
    },
    methodChipTextActive: {
      color: colors.primary,
      fontWeight: "900",
    },
  });

