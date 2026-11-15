import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import {
  formatCairoDateTime,
  formatSessionDateArabic,
  HomeworkEvaluationGroupCard,
  HomeworkEvaluationRepository,
  HomeworkEvaluationSessionCard,
  HomeworkSessionEvaluationRoster,
  HomeworkSessionStudentItem,
} from "../../features/homework/HomeworkEvaluationRepository";
import {
  HomeworkNotificationPreviewItem,
  NotificationService,
} from "../../features/notifications/NotificationService";
import { HomeworkEvaluationStatus } from "../../shared/types";

type EvaluationStep = "groups" | "sessions" | "students";
type StudentsSubTab = "evaluated" | "unevaluated";

const PRESET_STATUS_SUGGESTIONS = [
  "مكتمل",
  "غير مكتمل",
  "واجب ناقص",
  "لم يحل الواجب",
];

export default function HomeworkEvaluationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams<{
    groupId?: string;
    sessionId?: string;
  }>();
  const revision = useLocalDataRevision();
  const currentUser = useAuthStore((state) => state.currentUser);
  const activeCenterId = useAuthStore((state) => state.activeCenterId);

  const userPermissions = currentUser?.permissions || [];
  const canManageStatuses = PermissionService.hasPermission(
    userPermissions,
    "homework.manage",
  );
  const canViewHomework = PermissionService.hasAnyPermission(userPermissions, [
    "homework.manage",
    "grades.view",
    "grades.manage",
    "attendance.view",
    "attendance.create",
    "attendance.edit",
  ]);
  const canAssignHomework = PermissionService.hasAnyPermission(
    userPermissions,
    [
      "homework.manage",
      "grades.manage",
      "attendance.create",
      "attendance.edit",
    ],
  );
  const canSendNotifications = PermissionService.hasPermission(
    userPermissions,
    "notifications.send",
  );

  // Settings panel toggle (accessible from header without duplicate top tabs)
  const [showSettingsView, setShowSettingsView] = useState(false);

  // Database load error (never hidden as an empty group list)
  const [loadError, setLoadError] = useState<string | null>(null);

  // Internal feedback banner (replaces Alert.alert)
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const showFeedback = useCallback(
    (type: "success" | "error" | "info", message: string) => {
      setFeedback({ type, message });
    },
    [],
  );

  // =========================================================
  // PART 1 STATE — إعدادات حالات تقييم الواجب (Homework Criteria Config)
  // =========================================================
  const [allStatuses, setAllStatuses] = useState<HomeworkEvaluationStatus[]>(
    [],
  );
  const [activeStatuses, setActiveStatuses] = useState<
    HomeworkEvaluationStatus[]
  >([]);
  const [statusNameInput, setStatusNameInput] = useState("");
  const [editingStatus, setEditingStatus] =
    useState<HomeworkEvaluationStatus | null>(null);
  const [statusToDelete, setStatusToDelete] =
    useState<HomeworkEvaluationStatus | null>(null);

  // =========================================================
  // PART 2 & 3 STATE — تقييم الواجب (Groups -> Sessions -> Students)
  // =========================================================
  const [evalStep, setEvalStep] = useState<EvaluationStep>("groups");
  const [groups, setGroups] = useState<HomeworkEvaluationGroupCard[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");

  const [groupSessions, setGroupSessions] = useState<
    HomeworkEvaluationSessionCard[]
  >([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  const [sessionRoster, setSessionRoster] =
    useState<HomeworkSessionEvaluationRoster | null>(null);
  const [studentSubTab, setStudentSubTab] =
    useState<StudentsSubTab>("unevaluated");
  const [studentSearch, setStudentSearch] = useState("");
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);

  // =========================================================
  // PART 4 STATE — إرسال حالة الواجب (Notifications & Preview Modal)
  // =========================================================
  const [selectedEvaluatedStudentIds, setSelectedEvaluatedStudentIds] =
    useState<string[]>([]);
  const [previewModalVisible, setPreviewModalVisible] = useState(false);
  const [previewItems, setPreviewItems] = useState<
    HomeworkNotificationPreviewItem[]
  >([]);
  const [notificationRecipientType, setNotificationRecipientType] = useState<
    "parent" | "student"
  >("parent");
  const [customTemplateOverride, setCustomTemplateOverride] = useState("");
  const [sendingNotifications, setSendingNotifications] = useState(false);

  // =========================================================
  // DATA LOADING
  // =========================================================
  const loadData = useCallback(() => {
    if (!canViewHomework || !activeCenterId) return;
    try {
      setLoadError(null);
      const loadedAllStatuses = HomeworkEvaluationRepository.listStatuses(true);
      setAllStatuses(loadedAllStatuses);
      setActiveStatuses(
        loadedAllStatuses.filter((st) => st.status === "active"),
      );

      const loadedGroups =
        HomeworkEvaluationRepository.getGroupsForEvaluation();
      setGroups(loadedGroups);

      if (selectedGroupId) {
        const loadedSessions =
          HomeworkEvaluationRepository.getSessionsForGroup(selectedGroupId);
        setGroupSessions(loadedSessions);
      }

      if (selectedSessionId) {
        const loadedRoster =
          HomeworkEvaluationRepository.getSessionEvaluationRoster(
            selectedSessionId,
          );
        setSessionRoster(loadedRoster);
        // Clean up selected student IDs so only currently evaluated students remain selected
        const validEvalIds = new Set(
          loadedRoster.evaluatedStudents.map((s) => s.studentId),
        );
        setSelectedEvaluatedStudentIds((prev) =>
          prev.filter((id) => validEvalIds.has(id)),
        );
      }
    } catch (cause: any) {
      const errorMessage =
        cause?.message || String(cause) || "تعذر تحميل بيانات تقييم الواجب.";
      console.error(
        "[HomeworkEvaluationsScreen] Database query error:",
        cause,
      );
      setLoadError(errorMessage);
      showFeedback("error", errorMessage);
    }
  }, [
    activeCenterId,
    canViewHomework,
    selectedGroupId,
    selectedSessionId,
    showFeedback,
  ]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  useEffect(() => {
    loadData();
  }, [loadData, revision]);

  // Deep link params support
  useEffect(() => {
    if (params.groupId && params.groupId !== selectedGroupId) {
      setSelectedGroupId(params.groupId);
      setEvalStep("sessions");
    }
    if (params.sessionId && params.sessionId !== selectedSessionId) {
      setSelectedSessionId(params.sessionId);
      setEvalStep("students");
    }
  }, [params.groupId, params.sessionId, selectedGroupId, selectedSessionId]);

  // =========================================================
  // PART 1 HANDLERS — تقسيم الواجب (Homework Distribution)
  // =========================================================
  const handleSaveStatus = (overrideName?: string) => {
    const targetName = (
      overrideName !== undefined ? overrideName : statusNameInput
    ).trim();
    if (!targetName) {
      showFeedback("error", "يرجى إدخال اسم حالة تقييم الواجب.");
      return;
    }
    try {
      if (editingStatus && overrideName === undefined) {
        HomeworkEvaluationRepository.updateStatus(editingStatus.id, {
          name: targetName,
        });
        showFeedback("success", `تم تحديث الحالة «${targetName}» بنجاح.`);
      } else {
        HomeworkEvaluationRepository.createStatus(targetName);
        showFeedback("success", `تمت إضافة حالة «${targetName}» بنجاح.`);
      }
      if (overrideName === undefined) {
        setStatusNameInput("");
        setEditingStatus(null);
      }
      loadData();
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر حفظ حالة التقييم.");
    }
  };

  const handleToggleStatusActive = (status: HomeworkEvaluationStatus) => {
    try {
      const nextStatus = status.status === "active" ? "inactive" : "active";
      HomeworkEvaluationRepository.updateStatus(status.id, {
        status: nextStatus,
      });
      showFeedback(
        "success",
        nextStatus === "active"
          ? `تم تفعيل حالة «${status.name}».`
          : `تم تعطيل حالة «${status.name}».`,
      );
      loadData();
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر تحديث حالة التقييم.");
    }
  };

  const handleConfirmDeleteStatus = () => {
    if (!statusToDelete) return;
    try {
      const deletedName = statusToDelete.name;
      HomeworkEvaluationRepository.removeStatus(statusToDelete.id);
      setStatusToDelete(null);
      if (editingStatus?.id === statusToDelete.id) {
        setEditingStatus(null);
        setStatusNameInput("");
      }
      showFeedback("success", `تم حذف حالة «${deletedName}» بنجاح.`);
      loadData();
    } catch (cause: any) {
      setStatusToDelete(null);
      showFeedback("error", cause?.message || "تعذر حذف الحالة.");
    }
  };

  // =========================================================
  // PART 2 & 3 HANDLERS — تقييم الواجب (Evaluation Flow)
  // =========================================================
  const handleSelectGroup = (group: HomeworkEvaluationGroupCard) => {
    setFeedback(null);
    setSelectedGroupId(group.id);
    setSelectedSessionId("");
    setSessionRoster(null);
    setSelectedEvaluatedStudentIds([]);
    try {
      const sessions = HomeworkEvaluationRepository.getSessionsForGroup(
        group.id,
      );
      setGroupSessions(sessions);
      setEvalStep("sessions");
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر تحميل حصص المجموعة.");
    }
  };

  const handleSelectSession = (session: HomeworkEvaluationSessionCard) => {
    setFeedback(null);
    setSelectedSessionId(session.id);
    setSelectedEvaluatedStudentIds([]);
    setStudentSearch("");
    setEditingStudentId(null);
    try {
      const roster = HomeworkEvaluationRepository.getSessionEvaluationRoster(
        session.id,
      );
      setSessionRoster(roster);
      setStudentSubTab(
        roster.unevaluatedStudents.length > 0 ? "unevaluated" : "evaluated",
      );
      setEvalStep("students");
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر تحميل قائمة طلاب الحصة.");
    }
  };

  const handleEvaluateStudent = (
    student: HomeworkSessionStudentItem,
    statusId: string | null,
  ) => {
    if (!selectedSessionId) return;
    if (!canAssignHomework) {
      showFeedback("error", "ليس لديك صلاحية تسجيل تقييم الواجب.");
      return;
    }
    try {
      HomeworkEvaluationRepository.evaluateSessionStudent(
        selectedSessionId,
        student.studentId,
        statusId,
      );
      setEditingStudentId(null);
      const updatedRoster =
        HomeworkEvaluationRepository.getSessionEvaluationRoster(
          selectedSessionId,
        );
      setSessionRoster(updatedRoster);
      if (selectedGroupId) {
        setGroupSessions(
          HomeworkEvaluationRepository.getSessionsForGroup(selectedGroupId),
        );
      }
      if (statusId) {
        const chosenStatus = activeStatuses.find((s) => s.id === statusId);
        showFeedback(
          "success",
          `تم حفظ تقييم الطالب «${student.studentName}» (${chosenStatus?.name || "تم التقييم"}) ونقله إلى قائمة الطلاب الذين تم تقييمهم.`,
        );
      } else {
        setSelectedEvaluatedStudentIds((prev) =>
          prev.filter((id) => id !== student.studentId),
        );
        showFeedback(
          "info",
          `تم إلغاء تقييم الطالب «${student.studentName}» وإعادته إلى قائمة الطلاب غير المقيمين.`,
        );
      }
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر حفظ تقييم الطالب.");
    }
  };

  // =========================================================
  // PART 4 HANDLERS — إرسال حالة الواجب (Notifications)
  // =========================================================
  const toggleSelectStudentForNotification = (studentId: string) => {
    setSelectedEvaluatedStudentIds((prev) =>
      prev.includes(studentId)
        ? prev.filter((id) => id !== studentId)
        : [...prev, studentId],
    );
  };

  const handleToggleSelectAllEvaluated = (
    visibleEvaluated: HomeworkSessionStudentItem[],
  ) => {
    const visibleIds = visibleEvaluated.map((s) => s.studentId);
    const allSelected =
      visibleIds.length > 0 &&
      visibleIds.every((id) => selectedEvaluatedStudentIds.includes(id));
    if (allSelected) {
      setSelectedEvaluatedStudentIds((prev) =>
        prev.filter((id) => !visibleIds.includes(id)),
      );
    } else {
      setSelectedEvaluatedStudentIds((prev) =>
        Array.from(new Set([...prev, ...visibleIds])),
      );
    }
  };

  const openNotificationPreview = (
    targetStudentIds: string[],
    recipient: "parent" | "student" = notificationRecipientType,
    customBody: string = customTemplateOverride,
  ) => {
    if (!selectedSessionId) return;
    if (!canSendNotifications) {
      showFeedback("error", "ليس لديك صلاحية إرسال الإشعارات.");
      return;
    }
    if (targetStudentIds.length === 0) {
      showFeedback(
        "error",
        "يرجى تحديد طالب واحد على الأقل من قائمة «تم تقييمهم» لإرسال حالة الواجب.",
      );
      return;
    }
    try {
      const items = NotificationService.previewHomeworkNotifications({
        sessionId: selectedSessionId,
        studentIds: targetStudentIds,
        channel: "sms",
        recipientType: recipient,
        customTemplateBody: customBody.trim() || undefined,
      });
      setSelectedEvaluatedStudentIds(targetStudentIds);
      setPreviewItems(items);
      setPreviewModalVisible(true);
    } catch (cause: any) {
      showFeedback(
        "error",
        cause?.message || "تعذر تجهيز معاينة رسائل حالة الواجب.",
      );
    }
  };

  const handleRecipientOrTemplateChangeInModal = (
    nextRecipient: "parent" | "student",
    nextCustomBody: string,
  ) => {
    setNotificationRecipientType(nextRecipient);
    setCustomTemplateOverride(nextCustomBody);
    if (!selectedSessionId || selectedEvaluatedStudentIds.length === 0) return;
    try {
      const items = NotificationService.previewHomeworkNotifications({
        sessionId: selectedSessionId,
        studentIds: selectedEvaluatedStudentIds,
        channel: "sms",
        recipientType: nextRecipient,
        customTemplateBody: nextCustomBody.trim() || undefined,
      });
      setPreviewItems(items);
    } catch {
      // Keep existing preview if live re-render fails
    }
  };

  const handleConfirmSendNotifications = async () => {
    if (
      !selectedSessionId ||
      selectedEvaluatedStudentIds.length === 0 ||
      sendingNotifications
    ) {
      return;
    }
    setSendingNotifications(true);
    try {
      const events = NotificationService.notifyHomeworkEvaluations({
        sessionId: selectedSessionId,
        studentIds: selectedEvaluatedStudentIds,
        recipientType: notificationRecipientType,
        channels: ["push", "sms"],
        customTemplateBody: customTemplateOverride.trim() || undefined,
      });
      for (const ev of events) {
        await NotificationService.sendPendingDeliveries(ev.id);
      }
      setPreviewModalVisible(false);
      setCustomTemplateOverride("");
      const sentCount = events.length;
      setSelectedEvaluatedStudentIds([]);
      loadData();
      showFeedback(
        "success",
        `تم إرسال حالة الواجب بنجاح إلى ${sentCount} طالب عبر قوالب الإشعارات المعتمدة.`,
      );
    } catch (cause: any) {
      showFeedback("error", cause?.message || "تعذر إرسال إشعارات حالة الواجب.");
    } finally {
      setSendingNotifications(false);
    }
  };

  // =========================================================
  // FILTERED VIEWS
  // =========================================================
  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      [g.name, g.subjectName, g.teacherName, g.grade, g.scheduledDaysLabel]
        .filter(Boolean)
        .some((val) => String(val).toLowerCase().includes(q)),
    );
  }, [groups, groupSearch]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );

  const filteredEvaluatedStudents = useMemo(() => {
    const list = sessionRoster?.evaluatedStudents || [];
    const q = studentSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.studentName.toLowerCase().includes(q) ||
        s.studentCode.toLowerCase().includes(q) ||
        (s.statusName || "").toLowerCase().includes(q),
    );
  }, [sessionRoster, studentSearch]);

  const filteredUnevaluatedStudents = useMemo(() => {
    const list = sessionRoster?.unevaluatedStudents || [];
    const q = studentSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.studentName.toLowerCase().includes(q) ||
        s.studentCode.toLowerCase().includes(q),
    );
  }, [sessionRoster, studentSearch]);

  const activeConfigStatuses = useMemo(
    () => allStatuses.filter((s) => s.status === "active"),
    [allStatuses],
  );
  const inactiveConfigStatuses = useMemo(
    () => allStatuses.filter((s) => s.status === "inactive"),
    [allStatuses],
  );

  const handleHeaderBack = () => {
    if (showSettingsView) {
      setShowSettingsView(false);
      return;
    }
    if (evalStep === "students") {
      setEvalStep("sessions");
      setSelectedSessionId("");
      setSessionRoster(null);
      setSelectedEvaluatedStudentIds([]);
      return;
    }
    if (evalStep === "sessions") {
      setEvalStep("groups");
      setSelectedGroupId("");
      setGroupSessions([]);
      return;
    }
    router.back();
  };

  if (!canViewHomework) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="رجوع"
            onPress={() => router.back()}
            style={styles.backBtn}
          >
            <Ionicons
              name="chevron-forward"
              size={22}
              color={colors.textPrimary}
            />
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>تقييم الواجب</Text>
          </View>
        </View>
        <View style={styles.emptyCard}>
          <Ionicons
            name="lock-closed-outline"
            size={36}
            color={colors.danger}
          />
          <Text style={styles.emptyTitle}>ليس لديك صلاحية الوصول</Text>
          <Text style={styles.emptySubtitle}>
            لا تملك الصلاحية اللازمة لعرض أو إدارة تقييمات الواجب في هذا المركز.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Top Header */}
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="رجوع"
          onPress={handleHeaderBack}
          style={styles.backBtn}
        >
          <Ionicons
            name="chevron-forward"
            size={22}
            color={colors.textPrimary}
          />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>تقييم الواجب</Text>
          <Text style={styles.headerSubtitle}>
            {showSettingsView
              ? "إعداد وتنظيم معايير وحالات تقييم الواجب المعتمدة في المركز"
              : evalStep === "groups"
                ? "اختر المجموعة لعرض حصصها وتقييم واجبات الطلاب الحاضرين"
                : evalStep === "sessions"
                  ? `حصص ${selectedGroup?.name || "المجموعة"} مرتبة زمنياً من الأقدم إلى الأحدث`
                  : `${sessionRoster?.session.groupName || ""} — ${sessionRoster?.session.sessionOrdinalTitle || ""} (${sessionRoster?.session.sessionDateFormatted || ""})`}
          </Text>
        </View>

        {canManageStatuses ? (
          <TouchableOpacity
            style={styles.changeGroupBtn}
            onPress={() => {
              setFeedback(null);
              setShowSettingsView((prev) => !prev);
            }}
          >
            <Ionicons
              name={showSettingsView ? "checkbox-outline" : "options-outline"}
              size={16}
              color={Colors.primary}
            />
            <Text style={styles.changeGroupBtnText}>
              {showSettingsView ? "العودة للتقييم" : "إعدادات الحالات"}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Internal Feedback Banner */}
      {feedback ? (
        <View
          style={[
            styles.feedbackBanner,
            feedback.type === "error"
              ? styles.feedbackBannerError
              : feedback.type === "success"
                ? styles.feedbackBannerSuccess
                : styles.feedbackBannerInfo,
          ]}
        >
          <View style={styles.feedbackContent}>
            <Ionicons
              name={
                feedback.type === "error"
                  ? "alert-circle-outline"
                  : feedback.type === "success"
                    ? "checkmark-circle-outline"
                    : "information-circle-outline"
              }
              size={20}
              color={
                feedback.type === "error"
                  ? Colors.dangerText
                  : feedback.type === "success"
                    ? Colors.successText
                    : Colors.primary
              }
            />
            <Text
              style={[
                styles.feedbackText,
                feedback.type === "error"
                  ? { color: Colors.dangerText }
                  : feedback.type === "success"
                    ? { color: Colors.successText }
                    : { color: Colors.primary },
              ]}
            >
              {feedback.message}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setFeedback(null)}
            style={styles.feedbackCloseBtn}
          >
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ========================================================= */}
      {/* SETTINGS VIEW: إعدادات حالات الواجب (Homework Criteria Config) */}
      {/* ========================================================= */}
      {showSettingsView ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {!canManageStatuses ? (
            <View style={styles.emptyCard}>
              <Ionicons
                name="shield-outline"
                size={34}
                color={colors.textSecondary}
              />
              <Text style={styles.emptyTitle}>عرض إعدادات حالات الواجب</Text>
              <Text style={styles.emptySubtitle}>
                تحتاج إلى صلاحية إدارة حالات الواجب لتعديل أو إضافة معايير
                التقييم.
              </Text>
            </View>
          ) : (
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionIconBadge}>
                  <Ionicons
                    name="settings-outline"
                    size={20}
                    color={Colors.primary}
                  />
                </View>
                <View style={{ flex: 1, alignItems: "flex-end" }}>
                  <Text style={styles.sectionTitle}>
                    {editingStatus
                      ? "تعديل معيار تقييم الواجب"
                      : "إضافة معيار أو حالة واجب جديدة"}
                  </Text>
                  <Text style={styles.sectionSubtitle}>
                    حدد خيارات التقييم المتاحة للمعلمين عند تقييم الواجب داخل كل
                    حصة
                  </Text>
                </View>
              </View>

              <View style={styles.inputRow}>
                <TextInput
                  style={styles.textInput}
                  value={statusNameInput}
                  onChangeText={setStatusNameInput}
                  maxLength={120}
                  placeholder="مثال: مكتمل، غير مكتمل، واجب ناقص..."
                  placeholderTextColor={colors.textSecondary}
                  textAlign="right"
                  returnKeyType="done"
                  onSubmitEditing={() => handleSaveStatus()}
                />
                <TouchableOpacity
                  style={[
                    styles.primaryActionBtn,
                    !statusNameInput.trim() && styles.primaryActionBtnDisabled,
                  ]}
                  onPress={() => handleSaveStatus()}
                  disabled={!statusNameInput.trim()}
                >
                  <Ionicons
                    name={editingStatus ? "checkmark" : "add"}
                    size={19}
                    color={Colors.white}
                  />
                  <Text style={styles.primaryActionBtnText}>
                    {editingStatus ? "حفظ التعديل" : "إضافة"}
                  </Text>
                </TouchableOpacity>
              </View>

              {editingStatus ? (
                <View style={styles.editingBannerRow}>
                  <Text style={styles.editingBannerText}>
                    جاري تعديل الحالة: «{editingStatus.name}»
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      setEditingStatus(null);
                      setStatusNameInput("");
                    }}
                  >
                    <Text style={styles.cancelEditLink}>إلغاء التعديل</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {/* Quick Preset Options for Complete / Incomplete Homework */}
              <View style={styles.presetBlock}>
                <Text style={styles.presetLabel}>
                  خيارات سريعة شائعة (اضغط للإضافة المباشرة):
                </Text>
                <View style={styles.presetChipsRow}>
                  {PRESET_STATUS_SUGGESTIONS.map((preset) => {
                    const alreadyExists = allStatuses.some(
                      (s) =>
                        s.status !== "deleted" &&
                        s.name.trim().toLowerCase() === preset.toLowerCase(),
                    );
                    return (
                      <TouchableOpacity
                        key={preset}
                        style={[
                          styles.presetChip,
                          alreadyExists && styles.presetChipDone,
                        ]}
                        disabled={alreadyExists}
                        onPress={() => handleSaveStatus(preset)}
                      >
                        <Ionicons
                          name={
                            alreadyExists
                              ? "checkmark-circle"
                              : "add-circle-outline"
                          }
                          size={15}
                          color={
                            alreadyExists ? Colors.successText : Colors.primary
                          }
                        />
                        <Text
                          style={[
                            styles.presetChipText,
                            alreadyExists && styles.presetChipTextDone,
                          ]}
                        >
                          {preset}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.infoNoteRow}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.infoNoteText}>
                  يمكنك تعطيل أي حالة عند عدم الحاجة إليها حالياً مع الاحتفاظ
                  بكامل السجل التاريخي لتقييمات الطلاب السابقة.
                </Text>
              </View>
            </View>
          )}

          {/* Active Evaluation Criteria List */}
          <View style={styles.sectionCard}>
            <View style={styles.sectionTitleBetween}>
              <Text style={styles.sectionTitle}>
                معايير التقييم المفعّلة ({activeConfigStatuses.length})
              </Text>
              <View style={styles.badgeActive}>
                <Text style={styles.badgeActiveText}>جاهزة للاستخدام</Text>
              </View>
            </View>

            {activeConfigStatuses.length === 0 ? (
              <View style={styles.inlineEmptyBox}>
                <Ionicons
                  name="list-outline"
                  size={26}
                  color={colors.textSecondary}
                />
                <Text style={styles.inlineEmptyText}>
                  لا توجد حالات مفعّلة حالياً. أضف حالات مثل «مكتمل» أو «غير
                  مكتمل» لتظهر في شاشة تقييم الواجب.
                </Text>
              </View>
            ) : (
              activeConfigStatuses.map((status) => (
                <View key={status.id} style={styles.configStatusRow}>
                  <View style={styles.configStatusInfo}>
                    <View style={styles.configStatusTitleRow}>
                      <Text style={styles.configStatusName}>{status.name}</Text>
                      <View style={styles.statusPillActive}>
                        <Text style={styles.statusPillActiveText}>مفعّلة</Text>
                      </View>
                    </View>
                    <Text style={styles.configStatusMeta}>
                      تظهر للمعلمين عند تقييم الطلاب الحاضرين في الحصص
                    </Text>
                  </View>

                  {canManageStatuses ? (
                    <View style={styles.configStatusActions}>
                      <TouchableOpacity
                        accessibilityLabel="تعطيل الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => handleToggleStatusActive(status)}
                      >
                        <Ionicons
                          name="pause-circle-outline"
                          size={20}
                          color={colors.textSecondary}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="تعديل الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => {
                          setEditingStatus(status);
                          setStatusNameInput(status.name);
                        }}
                      >
                        <Ionicons
                          name="create-outline"
                          size={19}
                          color={Colors.primary}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="حذف الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => setStatusToDelete(status)}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={19}
                          color={colors.danger}
                        />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </View>

          {/* Inactive Evaluation Criteria List */}
          {inactiveConfigStatuses.length > 0 ? (
            <View style={styles.sectionCard}>
              <View style={styles.sectionTitleBetween}>
                <Text style={styles.sectionTitle}>
                  معايير التقييم المعطّلة ({inactiveConfigStatuses.length})
                </Text>
                <View style={styles.badgeInactive}>
                  <Text style={styles.badgeInactiveText}>مؤرشفة مؤقتاً</Text>
                </View>
              </View>

              {inactiveConfigStatuses.map((status) => (
                <View key={status.id} style={styles.configStatusRow}>
                  <View style={styles.configStatusInfo}>
                    <View style={styles.configStatusTitleRow}>
                      <Text
                        style={[
                          styles.configStatusName,
                          { color: colors.textSecondary },
                        ]}
                      >
                        {status.name}
                      </Text>
                      <View style={styles.statusPillInactive}>
                        <Text style={styles.statusPillInactiveText}>
                          معطّلة
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.configStatusMeta}>
                      محفوظة في السجلات السابقة ولا تظهر في خيارات التقييم
                      الجديدة
                    </Text>
                  </View>

                  {canManageStatuses ? (
                    <View style={styles.configStatusActions}>
                      <TouchableOpacity
                        accessibilityLabel="تفعيل الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => handleToggleStatusActive(status)}
                      >
                        <Ionicons
                          name="play-circle-outline"
                          size={20}
                          color={Colors.primary}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="تعديل الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => {
                          setEditingStatus(status);
                          setStatusNameInput(status.name);
                        }}
                      >
                        <Ionicons
                          name="create-outline"
                          size={19}
                          color={Colors.primary}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="حذف الحالة"
                        style={styles.iconActionBtn}
                        onPress={() => setStatusToDelete(status)}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={19}
                          color={colors.danger}
                        />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : (
        /* ========================================================= */
        /* SCREEN MODE 2: تقييم الواجب (المجموعات -> الحصص -> الطلاب) */
        /* ========================================================= */
        <View style={{ flex: 1 }}>
          {/* Step Breadcrumb Bar */}
          <View style={styles.breadcrumbBar}>
            <TouchableOpacity
              style={[
                styles.breadcrumbStep,
                evalStep === "groups" && styles.breadcrumbStepActive,
              ]}
              onPress={() => {
                setEvalStep("groups");
                setSelectedGroupId("");
                setSelectedSessionId("");
                setSessionRoster(null);
              }}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  evalStep === "groups" && styles.breadcrumbTextActive,
                ]}
              >
                1. المجموعات
              </Text>
            </TouchableOpacity>

            <Ionicons
              name="chevron-back"
              size={14}
              color={colors.textSecondary}
            />

            <TouchableOpacity
              style={[
                styles.breadcrumbStep,
                evalStep === "sessions" && styles.breadcrumbStepActive,
              ]}
              disabled={!selectedGroupId}
              onPress={() => {
                if (!selectedGroupId) return;
                setEvalStep("sessions");
                setSelectedSessionId("");
                setSessionRoster(null);
              }}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  evalStep === "sessions" && styles.breadcrumbTextActive,
                  !selectedGroupId && { opacity: 0.45 },
                ]}
                numberOfLines={1}
              >
                2. الحصص{" "}
                {selectedGroup ? `(${selectedGroup.name})` : ""}
              </Text>
            </TouchableOpacity>

            <Ionicons
              name="chevron-back"
              size={14}
              color={colors.textSecondary}
            />

            <View
              style={[
                styles.breadcrumbStep,
                evalStep === "students" && styles.breadcrumbStepActive,
              ]}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  evalStep === "students" && styles.breadcrumbTextActive,
                  !selectedSessionId && { opacity: 0.45 },
                ]}
                numberOfLines={1}
              >
                3. الطلاب{" "}
                {sessionRoster
                  ? `(${sessionRoster.session.sessionOrdinalTitle})`
                  : ""}
              </Text>
            </View>
          </View>

          {/* --------------------------------------------------------- */}
          {/* STEP 1: المجموعات (Groups Screen)                          */}
          {/* --------------------------------------------------------- */}
          {evalStep === "groups" ? (
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.searchBarWrapper}>
                <Ionicons
                  name="search-outline"
                  size={18}
                  color={colors.textSecondary}
                />
                <TextInput
                  style={styles.searchInput}
                  value={groupSearch}
                  onChangeText={setGroupSearch}
                  placeholder="ابحث باسم المجموعة أو المادة أو المدرس..."
                  placeholderTextColor={colors.textSecondary}
                  textAlign="right"
                />
                {groupSearch ? (
                  <TouchableOpacity onPress={() => setGroupSearch("")}>
                    <Ionicons
                      name="close-circle"
                      size={18}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                ) : null}
              </View>

              {loadError ? (
                <View style={styles.emptyCard}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={36}
                    color={colors.danger}
                  />
                  <Text style={styles.emptyTitle}>
                    تعذر تحميل المجموعات من قاعدة البيانات
                  </Text>
                  <Text style={styles.emptySubtitle}>{loadError}</Text>
                  <TouchableOpacity
                    style={[styles.primaryActionBtn, { marginTop: 10 }]}
                    onPress={loadData}
                  >
                    <Ionicons
                      name="refresh-outline"
                      size={18}
                      color={Colors.white}
                    />
                    <Text style={styles.primaryActionBtnText}>
                      إعادة المحاولة
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : filteredGroups.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons
                    name="people-outline"
                    size={36}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.emptyTitle}>لا توجد مجموعات نشطة</Text>
                  <Text style={styles.emptySubtitle}>
                    لم يتم العثور على مجموعات مطابقة في هذا المركز حالياً.
                  </Text>
                </View>
              ) : (
                filteredGroups.map((group) => (
                  <TouchableOpacity
                    key={group.id}
                    style={styles.groupCard}
                    activeOpacity={0.82}
                    onPress={() => handleSelectGroup(group)}
                  >
                    <View style={styles.groupCardTop}>
                      <View style={styles.groupCardTitleBlock}>
                        <Text style={styles.groupCardName}>{group.name}</Text>
                        <View style={styles.groupMetaRow}>
                          {group.subjectName ? (
                            <View style={styles.metaTagPrimary}>
                              <Ionicons
                                name="book-outline"
                                size={13}
                                color={Colors.primary}
                              />
                              <Text style={styles.metaTagPrimaryText}>
                                {group.subjectName}
                              </Text>
                            </View>
                          ) : null}
                          {group.teacherName ? (
                            <View style={styles.metaTagNeutral}>
                              <Ionicons
                                name="person-outline"
                                size={13}
                                color={colors.textSecondary}
                              />
                              <Text style={styles.metaTagNeutralText}>
                                {group.teacherName}
                              </Text>
                            </View>
                          ) : null}
                          {group.grade ? (
                            <View style={styles.metaTagNeutral}>
                              <Text style={styles.metaTagNeutralText}>
                                {group.grade}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>

                      <View style={styles.groupSessionsBadge}>
                        <Text style={styles.groupSessionsBadgeNum}>
                          {group.sessionsCount}
                        </Text>
                        <Text style={styles.groupSessionsBadgeLabel}>حصة</Text>
                      </View>
                    </View>

                    <View style={styles.groupScheduleBox}>
                      <View style={styles.groupScheduleLine}>
                        <Ionicons
                          name="calendar-outline"
                          size={15}
                          color={Colors.primary}
                        />
                        <Text style={styles.groupScheduleDaysText}>
                          {group.scheduledDaysLabel}
                        </Text>
                      </View>
                      <View style={styles.groupScheduleLine}>
                        <Ionicons
                          name="time-outline"
                          size={15}
                          color={colors.textSecondary}
                        />
                        <Text style={styles.groupScheduleTimeText}>
                          {group.timeRangeLabel}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.groupCardFooter}>
                      <Text style={styles.groupCardActionHint}>
                        فتح حصص المجموعة لتقييم الواجب
                      </Text>
                      <Ionicons
                        name="chevron-back"
                        size={17}
                        color={Colors.primary}
                      />
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          ) : evalStep === "sessions" ? (
            /* --------------------------------------------------------- */
            /* STEP 2: الحصص (Group Sessions Screen - Chronological)      */
            /* --------------------------------------------------------- */
            <ScrollView contentContainerStyle={styles.scrollContent}>
              {selectedGroup ? (
                <View style={styles.selectedGroupBanner}>
                  <View style={styles.selectedGroupHeaderTop}>
                    <View style={styles.selectedGroupTitleBlock}>
                      <Text style={styles.selectedGroupBannerName}>
                        {selectedGroup.name}
                      </Text>
                      {selectedGroup.subjectName ||
                      selectedGroup.teacherName ? (
                        <Text style={styles.selectedGroupBannerMeta}>
                          {[
                            selectedGroup.subjectName,
                            selectedGroup.teacherName,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      style={styles.changeGroupBtn}
                      onPress={() => {
                        setEvalStep("groups");
                        setSelectedGroupId("");
                        setGroupSessions([]);
                      }}
                    >
                      <Ionicons
                        name="swap-horizontal-outline"
                        size={15}
                        color={Colors.primary}
                      />
                      <Text style={styles.changeGroupBtnText}>
                        تغيير المجموعة
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.selectedGroupScheduleRow}>
                    <View style={styles.selectedGroupScheduleChip}>
                      <Ionicons
                        name="calendar-outline"
                        size={13}
                        color={Colors.primary}
                      />
                      <Text style={styles.selectedGroupBannerSchedule}>
                        {selectedGroup.scheduledDaysLabel}
                      </Text>
                    </View>
                    {selectedGroup.sessionTimeRangeLabel ||
                    selectedGroup.timeRangeLabel ? (
                      <View style={styles.selectedGroupScheduleChip}>
                        <Ionicons
                          name="time-outline"
                          size={13}
                          color={colors.textSecondary}
                        />
                        <Text style={styles.selectedGroupBannerTime}>
                          {selectedGroup.sessionTimeRangeLabel ||
                            selectedGroup.timeRangeLabel}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {groupSessions.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons
                    name="calendar-clear-outline"
                    size={36}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.emptyTitle}>
                    لا توجد حصص مسجلة لهذه المجموعة
                  </Text>
                  <Text style={styles.emptySubtitle}>
                    تظهر هنا جميع حصص المجموعة مرتبة زمنياً فور إنشائها أو بدء
                    تسجيل الحضور بها.
                  </Text>
                </View>
              ) : (
                groupSessions.map((session) => {
                  const isComplete =
                    session.attendedCount > 0 &&
                    session.evaluatedCount === session.attendedCount;
                  return (
                    <TouchableOpacity
                      key={session.id}
                      style={styles.sessionCard}
                      activeOpacity={0.82}
                      onPress={() => handleSelectSession(session)}
                    >
                      {/* Row 1: Single Session Number + Session Title + Status Badge */}
                      <View style={styles.sessionCardHeader}>
                        <View style={styles.sessionIdentityGroup}>
                          <View style={styles.sessionOrderBadge}>
                            <Text style={styles.sessionOrderBadgeText}>
                              {session.sessionNumber}
                            </Text>
                          </View>
                          <Text
                            style={styles.sessionOrdinalText}
                            numberOfLines={1}
                          >
                            {session.sessionOrdinalTitle}
                          </Text>
                        </View>

                        <View
                          style={[
                            styles.sessionStateBadge,
                            session.status === "open"
                              ? styles.sessionStateBadgeOpen
                              : styles.sessionStateBadgeClosed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.sessionStateBadgeText,
                              session.status === "open"
                                ? { color: Colors.primary }
                                : { color: colors.textSecondary },
                            ]}
                          >
                            {session.sessionStatusLabel}
                          </Text>
                        </View>
                      </View>

                      {/* Row 2: Visually Separate Arabic Date and Session Time Range */}
                      <View style={styles.sessionDateTimeBar}>
                        <View style={styles.sessionDatePill}>
                          <Ionicons
                            name="calendar-outline"
                            size={14}
                            color={Colors.primary}
                          />
                          <Text style={styles.sessionDateText}>
                            {session.sessionDateFormatted}
                          </Text>
                        </View>

                        {session.sessionTimeLabel ? (
                          <View style={styles.sessionTimePill}>
                            <Ionicons
                              name="time-outline"
                              size={14}
                              color={colors.textSecondary}
                            />
                            <Text style={styles.sessionTimeText}>
                              {session.sessionTimeLabel}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      {/* Row 3: Attendance & Evaluation Counters + Progress Indicator */}
                      <View style={styles.sessionProgressSection}>
                        <View style={styles.sessionCountsRow}>
                          <View style={styles.sessionCountItem}>
                            <Text style={styles.sessionCountLabel}>
                              الحاضرون:
                            </Text>
                            <Text style={styles.sessionCountValue}>
                              {session.attendedCount}
                            </Text>
                          </View>

                          <View style={styles.sessionCountDivider} />

                          <View style={styles.sessionCountItem}>
                            <Text style={styles.sessionCountLabel}>
                              تم تقييمهم:
                            </Text>
                            <Text
                              style={[
                                styles.sessionCountValue,
                                { color: Colors.successText },
                              ]}
                            >
                              {session.evaluatedCount}
                            </Text>
                          </View>

                          <View style={styles.sessionCountDivider} />

                          <View style={styles.sessionCountItem}>
                            <Text style={styles.sessionCountLabel}>
                              لم يتم تقييمهم:
                            </Text>
                            <Text
                              style={[
                                styles.sessionCountValue,
                                {
                                  color:
                                    session.unevaluatedCount > 0
                                      ? Colors.warningText
                                      : colors.textSecondary,
                                },
                              ]}
                            >
                              {session.unevaluatedCount}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.sessionProgressBarRow}>
                          <View style={styles.progressBarTrack}>
                            <View
                              style={[
                                styles.progressBarFill,
                                {
                                  width: `${session.completionPercentage}%`,
                                  backgroundColor: isComplete
                                    ? Colors.success
                                    : Colors.primary,
                                },
                              ]}
                            />
                          </View>
                          <Text
                            style={[
                              styles.sessionProgressPercentText,
                              isComplete && { color: Colors.successText },
                            ]}
                          >
                            {session.completionPercentage}%
                          </Text>
                        </View>
                      </View>

                      {/* Row 4: Clear Action to Open Homework Evaluation */}
                      <View style={styles.sessionCardActionRow}>
                        <Text style={styles.groupCardActionHint}>
                          فتح تقييم الواجب
                        </Text>
                        <Ionicons
                          name="chevron-back"
                          size={16}
                          color={Colors.primary}
                        />
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          ) : (
            /* --------------------------------------------------------- */
            /* STEP 3: الطلاب (Session Homework Evaluation Screen)        */
            /* --------------------------------------------------------- */
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
              {sessionRoster ? (
                <>
                  {/* Session Summary Context */}
                  <View style={styles.sessionContextBanner}>
                    <View style={{ flex: 1, alignItems: "flex-end" }}>
                      <Text style={styles.sessionContextTitle}>
                        {sessionRoster.session.groupName} —{" "}
                        {sessionRoster.session.sessionOrdinalTitle}
                      </Text>
                      <Text style={styles.sessionContextMeta}>
                        {sessionRoster.session.sessionDateFormatted}
                        {sessionRoster.session.sessionTimeLabel
                          ? ` · ${sessionRoster.session.sessionTimeLabel}`
                          : ""}{" "}
                        · الحالة: {sessionRoster.session.sessionStatusLabel}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.changeGroupBtn}
                      onPress={() => {
                        setEvalStep("sessions");
                        setSelectedSessionId("");
                        setSessionRoster(null);
                      }}
                    >
                      <Ionicons
                        name="list-outline"
                        size={16}
                        color={Colors.primary}
                      />
                      <Text style={styles.changeGroupBtnText}>كل الحصص</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Minimal Session-Specific Statistics */}
                  <View style={styles.statsRow}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>
                        {sessionRoster.stats.totalAttended}
                      </Text>
                      <Text style={styles.statLabel}>
                        إجمالي الطلاب الحاضرين
                      </Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text
                        style={[styles.statValue, { color: Colors.successText }]}
                      >
                        {sessionRoster.stats.evaluatedCount}
                      </Text>
                      <Text style={styles.statLabel}>تم تقييمهم</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text
                        style={[styles.statValue, { color: Colors.warningText }]}
                      >
                        {sessionRoster.stats.unevaluatedCount}
                      </Text>
                      <Text style={styles.statLabel}>لم يتم تقييمهم</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text
                        style={[styles.statValue, { color: Colors.primary }]}
                      >
                        {sessionRoster.stats.completionPercentage}%
                      </Text>
                      <Text style={styles.statLabel}>نسبة الإنجاز</Text>
                    </View>
                  </View>

                  {/* Notice if no active evaluation statuses configured yet */}
                  {activeStatuses.length === 0 ? (
                    <View style={styles.noStatusesWarningCard}>
                      <View style={{ flex: 1, alignItems: "flex-end" }}>
                        <Text style={styles.noStatusesWarningTitle}>
                          لم يتم إعداد حالات تقييم الواجب بعد
                        </Text>
                        <Text style={styles.noStatusesWarningSub}>
                          افتح «إعدادات الحالات» لإضافة حالات مثل «مكتمل» أو
                          «غير مكتمل» قبل تقييم الطلاب.
                        </Text>
                      </View>
                      {canManageStatuses ? (
                        <TouchableOpacity
                          style={styles.goToDistributionBtn}
                          onPress={() => setShowSettingsView(true)}
                        >
                          <Text style={styles.goToDistributionBtnText}>
                            إعدادات الحالات
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null}

                  {/* Separate Student Tabs: تم تقييمهم vs لم يتم تقييمهم */}
                  <View style={styles.studentTabsBar}>
                    <TouchableOpacity
                      style={[
                        styles.studentTabBtn,
                        studentSubTab === "unevaluated" &&
                          styles.studentTabBtnActive,
                      ]}
                      onPress={() => setStudentSubTab("unevaluated")}
                    >
                      <Text
                        style={[
                          styles.studentTabText,
                          studentSubTab === "unevaluated" &&
                            styles.studentTabTextActive,
                        ]}
                      >
                        لم يتم تقييمهم ({sessionRoster.stats.unevaluatedCount})
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.studentTabBtn,
                        studentSubTab === "evaluated" &&
                          styles.studentTabBtnActive,
                      ]}
                      onPress={() => setStudentSubTab("evaluated")}
                    >
                      <Text
                        style={[
                          styles.studentTabText,
                          studentSubTab === "evaluated" &&
                            styles.studentTabTextActive,
                        ]}
                      >
                        تم تقييمهم ({sessionRoster.stats.evaluatedCount})
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Student Search Input */}
                  <View style={styles.searchBarWrapper}>
                    <Ionicons
                      name="search-outline"
                      size={18}
                      color={colors.textSecondary}
                    />
                    <TextInput
                      style={styles.searchInput}
                      value={studentSearch}
                      onChangeText={setStudentSearch}
                      placeholder="ابحث باسم الطالب أو كود الطالب..."
                      placeholderTextColor={colors.textSecondary}
                      textAlign="right"
                    />
                    {studentSearch ? (
                      <TouchableOpacity onPress={() => setStudentSearch("")}>
                        <Ionicons
                          name="close-circle"
                          size={18}
                          color={colors.textSecondary}
                        />
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  {/* --------------------------------------------------- */}
                  {/* TAB B: لم يتم تقييمهم (Unevaluated Attended Students) */}
                  {/* --------------------------------------------------- */}
                  {studentSubTab === "unevaluated" ? (
                    filteredUnevaluatedStudents.length === 0 ? (
                      <View style={styles.emptyCard}>
                        <Ionicons
                          name="checkmark-done-circle-outline"
                          size={38}
                          color={Colors.success}
                        />
                        <Text style={styles.emptyTitle}>
                          {sessionRoster.stats.totalAttended === 0
                            ? "لا يوجد طلاب حاضرون في هذه الحصة"
                            : "تم تقييم جميع الطلاب الحاضرين في هذه الحصة"}
                        </Text>
                        <Text style={styles.emptySubtitle}>
                          {sessionRoster.stats.totalAttended === 0
                            ? "تقييم الواجب متاح فقط للطلاب الذين سُجّل حضورهم فعلياً في الحصة. الطلاب الغائبون لا يظهرون في قائمة التقييم."
                            : "انتقل إلى تبويب «تم تقييمهم» لمراجعة التقييمات المحفوظة أو إرسال حالة الواجب لأولياء الأمور."}
                        </Text>
                      </View>
                    ) : (
                      filteredUnevaluatedStudents.map((student) => (
                        <View
                          key={student.studentId}
                          style={styles.studentEvalCard}
                        >
                          <View style={styles.studentEvalHeader}>
                            <View style={styles.studentIdentityBlock}>
                              <Text style={styles.studentNameText}>
                                {student.studentName}
                              </Text>
                              <View style={styles.studentBadgesRow}>
                                <View style={styles.codeBadge}>
                                  <Text style={styles.codeBadgeText}>
                                    كود: {student.studentCode}
                                  </Text>
                                </View>
                                <View style={styles.attendedBadge}>
                                  <Text style={styles.attendedBadgeText}>
                                    {student.attendanceStatus === "late"
                                      ? "حاضر (متأخر)"
                                      : "حاضر"}
                                  </Text>
                                </View>
                                <View style={styles.unevaluatedBadge}>
                                  <Text style={styles.unevaluatedBadgeText}>
                                    {student.evaluationStateLabel}
                                  </Text>
                                </View>
                              </View>
                            </View>
                          </View>

                          {activeStatuses.length > 0 && canAssignHomework ? (
                            <View style={styles.evaluationButtonsContainer}>
                              <Text style={styles.chooseEvalPrompt}>
                                اختر حالة الواجب لنقل الطالب إلى قائمة «تم
                                تقييمهم»:
                              </Text>
                              <View style={styles.evaluationButtonsGrid}>
                                {activeStatuses.map((status) => (
                                  <TouchableOpacity
                                    key={status.id}
                                    style={styles.evalChoiceButton}
                                    onPress={() =>
                                      handleEvaluateStudent(student, status.id)
                                    }
                                  >
                                    <Ionicons
                                      name="checkmark-circle-outline"
                                      size={16}
                                      color={Colors.primary}
                                    />
                                    <Text style={styles.evalChoiceButtonText}>
                                      {status.name}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            </View>
                          ) : null}
                        </View>
                      ))
                    )
                  ) : (
                    /* --------------------------------------------------- */
                    /* TAB A: تم تقييمهم (Evaluated Students + Notifications) */
                    /* --------------------------------------------------- */
                    <>
                      {filteredEvaluatedStudents.length > 0 &&
                      canSendNotifications ? (
                        <View style={styles.notificationActionBar}>
                          <View style={styles.selectionSummaryRow}>
                            <TouchableOpacity
                              style={styles.selectAllBtn}
                              onPress={() =>
                                handleToggleSelectAllEvaluated(
                                  filteredEvaluatedStudents,
                                )
                              }
                            >
                              <Ionicons
                                name={
                                  filteredEvaluatedStudents.every((s) =>
                                    selectedEvaluatedStudentIds.includes(
                                      s.studentId,
                                    ),
                                  )
                                    ? "checkbox"
                                    : "square-outline"
                                }
                                size={20}
                                color={Colors.primary}
                              />
                              <Text style={styles.selectAllBtnText}>
                                {filteredEvaluatedStudents.every((s) =>
                                  selectedEvaluatedStudentIds.includes(
                                    s.studentId,
                                  ),
                                )
                                  ? "إلغاء تحديد الكل"
                                  : "تحديد الكل"}
                              </Text>
                            </TouchableOpacity>

                            <Text style={styles.selectedCountText}>
                              تم تحديد {selectedEvaluatedStudentIds.length} من{" "}
                              {sessionRoster.stats.evaluatedCount} طالب
                            </Text>
                          </View>

                          <TouchableOpacity
                            style={[
                              styles.sendHomeworkStatusBtn,
                              selectedEvaluatedStudentIds.length === 0 &&
                                styles.sendHomeworkStatusBtnDisabled,
                            ]}
                            disabled={selectedEvaluatedStudentIds.length === 0}
                            onPress={() =>
                              openNotificationPreview(
                                selectedEvaluatedStudentIds,
                              )
                            }
                          >
                            <Ionicons
                              name="send-outline"
                              size={17}
                              color={Colors.white}
                            />
                            <Text style={styles.sendHomeworkStatusBtnText}>
                              إرسال حالة الواجب (
                              {selectedEvaluatedStudentIds.length})
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}

                      {filteredEvaluatedStudents.length === 0 ? (
                        <View style={styles.emptyCard}>
                          <Ionicons
                            name="document-text-outline"
                            size={36}
                            color={colors.textSecondary}
                          />
                          <Text style={styles.emptyTitle}>
                            لا يوجد طلاب تم تقييمهم بعد في هذه الحصة
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            افتح تبويب «لم يتم تقييمهم» لتقييم الطلاب الحاضرين،
                            وسيظهرون هنا فوراً مع إمكانية إرسال حالة الواجب.
                          </Text>
                        </View>
                      ) : (
                        filteredEvaluatedStudents.map((student) => {
                          const isSelected =
                            selectedEvaluatedStudentIds.includes(
                              student.studentId,
                            );
                          const isEditingThis =
                            editingStudentId === student.studentId;

                          return (
                            <View
                              key={student.studentId}
                              style={[
                                styles.studentEvalCard,
                                isSelected && styles.studentEvalCardSelected,
                              ]}
                            >
                              <View style={styles.studentEvalHeader}>
                                <TouchableOpacity
                                  style={styles.studentSelectRow}
                                  activeOpacity={0.75}
                                  onPress={() =>
                                    toggleSelectStudentForNotification(
                                      student.studentId,
                                    )
                                  }
                                >
                                  <Ionicons
                                    name={
                                      isSelected
                                        ? "checkbox"
                                        : "square-outline"
                                    }
                                    size={22}
                                    color={
                                      isSelected
                                        ? Colors.primary
                                        : colors.textSecondary
                                    }
                                  />
                                  <View style={styles.studentIdentityBlock}>
                                    <Text style={styles.studentNameText}>
                                      {student.studentName}
                                    </Text>
                                    <View style={styles.studentBadgesRow}>
                                      <View style={styles.codeBadge}>
                                        <Text style={styles.codeBadgeText}>
                                          كود: {student.studentCode}
                                        </Text>
                                      </View>
                                      <View style={styles.savedStatusBadge}>
                                        <Ionicons
                                          name="checkmark-circle"
                                          size={13}
                                          color={Colors.successText}
                                        />
                                        <Text
                                          style={styles.savedStatusBadgeText}
                                        >
                                          {student.statusName}
                                        </Text>
                                      </View>
                                      {student.notificationSent ? (
                                        <View style={styles.notifiedBadge}>
                                          <Ionicons
                                            name="checkmark-done-outline"
                                            size={12}
                                            color={Colors.primary}
                                          />
                                          <Text
                                            style={styles.notifiedBadgeText}
                                          >
                                            تم الإرسال
                                          </Text>
                                        </View>
                                      ) : null}
                                    </View>
                                    {student.evaluatedAt ? (
                                      <Text style={styles.evaluatedTimeText}>
                                        وقت التقييم:{" "}
                                        {formatCairoDateTime(
                                          student.evaluatedAt,
                                        )}
                                      </Text>
                                    ) : null}
                                  </View>
                                </TouchableOpacity>

                                <View style={styles.evaluatedRowQuickActions}>
                                  {canSendNotifications ? (
                                    <TouchableOpacity
                                      style={styles.singleSendBtn}
                                      onPress={() =>
                                        openNotificationPreview([
                                          student.studentId,
                                        ])
                                      }
                                    >
                                      <Ionicons
                                        name="paper-plane-outline"
                                        size={14}
                                        color={Colors.primary}
                                      />
                                      <Text style={styles.singleSendBtnText}>
                                        إرسال حالة الواجب
                                      </Text>
                                    </TouchableOpacity>
                                  ) : null}

                                  {canAssignHomework ? (
                                    <TouchableOpacity
                                      style={styles.changeEvalToggleBtn}
                                      onPress={() =>
                                        setEditingStudentId(
                                          isEditingThis
                                            ? null
                                            : student.studentId,
                                        )
                                      }
                                    >
                                      <Ionicons
                                        name="create-outline"
                                        size={15}
                                        color={colors.textSecondary}
                                      />
                                      <Text
                                        style={styles.changeEvalToggleBtnText}
                                      >
                                        {isEditingThis ? "إغلاق" : "تعديل"}
                                      </Text>
                                    </TouchableOpacity>
                                  ) : null}
                                </View>
                              </View>

                              {isEditingThis && canAssignHomework ? (
                                <View style={styles.evaluationButtonsContainer}>
                                  <Text style={styles.chooseEvalPrompt}>
                                    تحديث حالة الواجب للطالب:
                                  </Text>
                                  <View style={styles.evaluationButtonsGrid}>
                                    {activeStatuses.map((status) => {
                                      const isCurrent =
                                        status.id === student.statusId;
                                      return (
                                        <TouchableOpacity
                                          key={status.id}
                                          style={[
                                            styles.evalChoiceButton,
                                            isCurrent &&
                                              styles.evalChoiceButtonActive,
                                          ]}
                                          onPress={() =>
                                            handleEvaluateStudent(
                                              student,
                                              status.id,
                                            )
                                          }
                                        >
                                          <Text
                                            style={[
                                              styles.evalChoiceButtonText,
                                              isCurrent &&
                                                styles.evalChoiceButtonTextActive,
                                            ]}
                                          >
                                            {status.name}
                                          </Text>
                                        </TouchableOpacity>
                                      );
                                    })}
                                    <TouchableOpacity
                                      style={styles.clearEvalButton}
                                      onPress={() =>
                                        handleEvaluateStudent(student, null)
                                      }
                                    >
                                      <Ionicons
                                        name="refresh-outline"
                                        size={15}
                                        color={colors.danger}
                                      />
                                      <Text style={styles.clearEvalButtonText}>
                                        إعادة لغير المقيمين
                                      </Text>
                                    </TouchableOpacity>
                                  </View>
                                </View>
                              ) : null}
                            </View>
                          );
                        })
                      )}
                    </>
                  )}
                </>
              ) : null}
            </ScrollView>
          )}
        </View>
      )}

      {/* ========================================================= */}
      {/* INTERNAL MODAL 1: Delete Status Confirmation              */}
      {/* ========================================================= */}
      <Modal
        visible={!!statusToDelete}
        transparent
        animationType="fade"
        onRequestClose={() => setStatusToDelete(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>تأكيد حذف حالة التقييم</Text>
              <TouchableOpacity onPress={() => setStatusToDelete(null)}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalBodyText}>
              هل تريد حذف حالة «{statusToDelete?.name}»؟ لا يمكن حذف حالة تم
              استخدامها مسبقاً في سجل تقييم واجب، ويمكنك تعطيلها بدلاً من ذلك.
            </Text>
            <View style={styles.modalFooterActions}>
              <TouchableOpacity
                style={styles.modalDangerBtn}
                onPress={handleConfirmDeleteStatus}
              >
                <Text style={styles.modalDangerBtnText}>تأكيد الحذف</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setStatusToDelete(null)}
              >
                <Text style={styles.modalCancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ========================================================= */}
      {/* INTERNAL MODAL 2: Message Preview before Sending          */}
      {/* ========================================================= */}
      <Modal
        visible={previewModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPreviewModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { maxHeight: "88%" }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>
                معاينة رسائل حالة الواجب ({previewItems.length})
              </Text>
              <TouchableOpacity
                onPress={() => setPreviewModalVisible(false)}
                disabled={sendingNotifications}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubHint}>
              راجع نص الرسالة المخصصة لكل طالب قبل الإرسال الفعلي عبر قوالب
              الإشعارات.
            </Text>

            {/* Recipient selector */}
            <View style={styles.recipientSwitchRow}>
              <TouchableOpacity
                style={[
                  styles.recipientOptionBtn,
                  notificationRecipientType === "parent" &&
                    styles.recipientOptionBtnActive,
                ]}
                onPress={() =>
                  handleRecipientOrTemplateChangeInModal(
                    "parent",
                    customTemplateOverride,
                  )
                }
              >
                <Ionicons
                  name="people-outline"
                  size={16}
                  color={
                    notificationRecipientType === "parent"
                      ? Colors.primary
                      : colors.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.recipientOptionText,
                    notificationRecipientType === "parent" &&
                      styles.recipientOptionTextActive,
                  ]}
                >
                  إرسال إلى ولي الأمر
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.recipientOptionBtn,
                  notificationRecipientType === "student" &&
                    styles.recipientOptionBtnActive,
                ]}
                onPress={() =>
                  handleRecipientOrTemplateChangeInModal(
                    "student",
                    customTemplateOverride,
                  )
                }
              >
                <Ionicons
                  name="person-outline"
                  size={16}
                  color={
                    notificationRecipientType === "student"
                      ? Colors.primary
                      : colors.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.recipientOptionText,
                    notificationRecipientType === "student" &&
                      styles.recipientOptionTextActive,
                  ]}
                >
                  إرسال إلى الطالب
                </Text>
              </TouchableOpacity>
            </View>

            {/* Preview List for Each Selected Student */}
            <ScrollView
              style={styles.previewScrollArea}
              contentContainerStyle={{ gap: 10, paddingVertical: 6 }}
            >
              {previewItems.map((item) => (
                <View key={item.studentId} style={styles.previewItemCard}>
                  <View style={styles.previewItemHeader}>
                    <Text style={styles.previewStudentName}>
                      {item.studentName}
                    </Text>
                    <View style={styles.savedStatusBadge}>
                      <Text style={styles.savedStatusBadgeText}>
                        {item.homeworkStatus}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.previewRecipientMeta}>
                    المستلم: {item.recipientPhone || "بدون رقم مسجل"} ·{" "}
                    {item.groupName} ({formatSessionDateArabic(item.sessionDate)})
                  </Text>
                  <View style={styles.previewMessageBox}>
                    <Text style={styles.previewMessageText}>
                      {item.renderedMessage}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>

            <View style={styles.modalFooterActions}>
              <TouchableOpacity
                style={[
                  styles.modalPrimaryBtn,
                  sendingNotifications && { opacity: 0.65 },
                ]}
                onPress={handleConfirmSendNotifications}
                disabled={sendingNotifications}
              >
                {sendingNotifications ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Ionicons
                    name="send-outline"
                    size={17}
                    color={Colors.white}
                  />
                )}
                <Text style={styles.modalPrimaryBtnText}>
                  {sendingNotifications
                    ? "جاري الإرسال..."
                    : `تأكيد وإرسال الإشعارات (${previewItems.length})`}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setPreviewModalVisible(false)}
                disabled={sendingNotifications}
              >
                <Text style={styles.modalCancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: Spacing.lg,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.cardBackground,
    },
    backBtn: {
      minWidth: 40,
      minHeight: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    headerCopy: {
      flex: 1,
      alignItems: "flex-end",
    },
    headerTitle: {
      ...Typography.h2,
      color: colors.textPrimary,
      textAlign: "right",
    },
    headerSubtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: "right",
      marginTop: 3,
      lineHeight: 18,
    },
    feedbackBanner: {
      marginHorizontal: Spacing.lg,
      marginTop: 10,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    feedbackBannerSuccess: {
      backgroundColor: Colors.successLight,
      borderColor: Colors.success,
    },
    feedbackBannerError: {
      backgroundColor: Colors.dangerLight,
      borderColor: Colors.danger,
    },
    feedbackBannerInfo: {
      backgroundColor: Colors.primaryLight,
      borderColor: Colors.primaryMuted,
    },
    feedbackContent: {
      flex: 1,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    feedbackText: {
      flex: 1,
      fontSize: 12,
      fontWeight: "700",
      textAlign: "right",
      lineHeight: 18,
    },
    feedbackCloseBtn: {
      padding: 4,
    },
    scrollContent: {
      padding: Spacing.lg,
      gap: 14,
      paddingBottom: 40,
    },
    sectionCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 16,
      gap: 12,
    },
    sectionHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 12,
    },
    sectionIconBadge: {
      width: 42,
      height: 42,
      borderRadius: 13,
      backgroundColor: Colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    sectionSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: "right",
      marginTop: 2,
      lineHeight: 18,
    },
    inputRow: {
      flexDirection: "row-reverse",
      gap: 8,
      marginTop: 4,
    },
    textInput: {
      flex: 1,
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 13,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      fontSize: 14,
    },
    primaryActionBtn: {
      minWidth: 96,
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: Colors.primary,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      paddingHorizontal: 14,
    },
    primaryActionBtnDisabled: {
      opacity: 0.5,
    },
    primaryActionBtnText: {
      color: Colors.white,
      fontWeight: "800",
      fontSize: 13,
    },
    editingBannerRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: Colors.primaryLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    editingBannerText: {
      fontSize: 12,
      fontWeight: "700",
      color: Colors.primary,
    },
    cancelEditLink: {
      fontSize: 12,
      fontWeight: "800",
      color: colors.danger,
    },
    presetBlock: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
      gap: 8,
    },
    presetLabel: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    presetChipsRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      gap: 8,
    },
    presetChip: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: Colors.primaryMuted,
      backgroundColor: Colors.primaryLight,
    },
    presetChipDone: {
      borderColor: Colors.success,
      backgroundColor: Colors.successLight,
      opacity: 0.75,
    },
    presetChipText: {
      fontSize: 12,
      fontWeight: "800",
      color: Colors.primary,
    },
    presetChipTextDone: {
      color: Colors.successText,
    },
    infoNoteRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      marginTop: 2,
    },
    infoNoteText: {
      flex: 1,
      fontSize: 11,
      color: colors.textSecondary,
      textAlign: "right",
      lineHeight: 17,
    },
    sectionTitleBetween: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    badgeActive: {
      backgroundColor: Colors.successLight,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
    },
    badgeActiveText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.successText,
    },
    badgeInactive: {
      backgroundColor: colors.background,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    badgeInactiveText: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    inlineEmptyBox: {
      alignItems: "center",
      paddingVertical: 20,
      gap: 8,
    },
    inlineEmptyText: {
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 18,
    },
    configStatusRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      gap: 10,
    },
    configStatusInfo: {
      flex: 1,
      alignItems: "flex-end",
      gap: 3,
    },
    configStatusTitleRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    configStatusName: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.textPrimary,
      textAlign: "right",
    },
    configStatusMeta: {
      fontSize: 11,
      color: colors.textSecondary,
      textAlign: "right",
    },
    statusPillActive: {
      backgroundColor: Colors.successLight,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    statusPillActiveText: {
      fontSize: 10,
      fontWeight: "800",
      color: Colors.successText,
    },
    statusPillInactive: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    statusPillInactiveText: {
      fontSize: 10,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    configStatusActions: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
    },
    iconActionBtn: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
    },
    breadcrumbBar: {
      flexDirection: "row-reverse",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: 10,
      backgroundColor: colors.cardBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 6,
    },
    breadcrumbStep: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      maxWidth: "36%",
    },
    breadcrumbStepActive: {
      backgroundColor: Colors.primaryLight,
    },
    breadcrumbText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    breadcrumbTextActive: {
      color: Colors.primary,
      fontWeight: "900",
    },
    searchBarWrapper: {
      flexDirection: "row-reverse",
      alignItems: "center",
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 12,
      minHeight: 46,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 13,
      paddingVertical: 8,
    },
    emptyCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 28,
      alignItems: "center",
      gap: 10,
      marginTop: 8,
    },
    emptyTitle: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "center",
    },
    emptySubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 19,
    },
    groupCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 16,
      gap: 12,
    },
    groupCardTop: {
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    groupCardTitleBlock: {
      flex: 1,
      alignItems: "flex-end",
      gap: 6,
    },
    groupCardName: {
      fontSize: 17,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    groupMetaRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      gap: 6,
    },
    metaTagPrimary: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      backgroundColor: Colors.primaryLight,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 8,
    },
    metaTagPrimaryText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.primary,
    },
    metaTagNeutral: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 8,
    },
    metaTagNeutralText: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    groupSessionsBadge: {
      minWidth: 54,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 12,
      backgroundColor: Colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    groupSessionsBadgeNum: {
      fontSize: 15,
      fontWeight: "900",
      color: Colors.primary,
    },
    groupSessionsBadgeLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: Colors.primary,
    },
    groupScheduleBox: {
      backgroundColor: colors.background,
      borderRadius: 12,
      padding: 11,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6,
    },
    groupScheduleLine: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 7,
    },
    groupScheduleDaysText: {
      fontSize: 13,
      fontWeight: "800",
      color: colors.textPrimary,
      textAlign: "right",
    },
    groupScheduleTimeText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    groupCardFooter: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    groupCardActionHint: {
      fontSize: 12,
      fontWeight: "800",
      color: Colors.primary,
    },
    selectedGroupBanner: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: Colors.primaryMuted,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 10,
    },
    selectedGroupHeaderTop: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    selectedGroupTitleBlock: {
      flex: 1,
      alignItems: "flex-end",
      gap: 2,
    },
    selectedGroupBannerName: {
      fontSize: 16,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    selectedGroupBannerMeta: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    selectedGroupScheduleRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
    },
    selectedGroupScheduleChip: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    selectedGroupBannerSchedule: {
      fontSize: 12,
      fontWeight: "800",
      color: Colors.primary,
      textAlign: "right",
    },
    selectedGroupBannerTime: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    changeGroupBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderRadius: 10,
      backgroundColor: Colors.primaryLight,
    },
    changeGroupBtnText: {
      fontSize: 12,
      fontWeight: "800",
      color: Colors.primary,
    },
    sessionCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 13,
      gap: 10,
    },
    sessionCardHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    sessionIdentityGroup: {
      flex: 1,
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 10,
    },
    sessionOrderBadge: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: Colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    sessionOrderBadgeText: {
      color: Colors.white,
      fontSize: 14,
      fontWeight: "900",
    },
    sessionOrdinalText: {
      flex: 1,
      fontSize: 15,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    sessionDateTimeBar: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    sessionDatePill: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      backgroundColor: Colors.primaryLight,
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    sessionDateText: {
      fontSize: 12,
      fontWeight: "800",
      color: Colors.primary,
      textAlign: "right",
    },
    sessionTimePill: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    sessionTimeText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    sessionStateBadge: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: 1,
      flexShrink: 0,
    },
    sessionStateBadgeOpen: {
      backgroundColor: Colors.primaryLight,
      borderColor: Colors.primaryMuted,
    },
    sessionStateBadgeClosed: {
      backgroundColor: colors.background,
      borderColor: colors.border,
    },
    sessionStateBadgeText: {
      fontSize: 11,
      fontWeight: "800",
    },
    sessionProgressSection: {
      backgroundColor: colors.background,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 9,
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sessionCountsRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 6,
    },
    sessionCountItem: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
    },
    sessionCountLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    sessionCountValue: {
      fontSize: 12,
      fontWeight: "900",
      color: colors.textPrimary,
    },
    sessionCountDivider: {
      width: 1,
      height: 12,
      backgroundColor: colors.border,
    },
    sessionProgressBarRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    progressBarTrack: {
      flex: 1,
      height: 6,
      borderRadius: 4,
      backgroundColor: colors.border,
      overflow: "hidden",
      flexDirection: "row-reverse",
    },
    progressBarFill: {
      height: "100%",
      borderRadius: 4,
    },
    sessionProgressPercentText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.primary,
      minWidth: 34,
      textAlign: "left",
    },
    sessionCardActionRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
    },
    sessionContextBanner: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 14,
      gap: 10,
    },
    sessionContextTitle: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    sessionContextMeta: {
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: "right",
      marginTop: 3,
    },
    statsRow: {
      flexDirection: "row-reverse",
      gap: 8,
    },
    statCard: {
      flex: 1,
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 11,
      paddingHorizontal: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    statValue: {
      fontSize: 17,
      fontWeight: "900",
      color: colors.textPrimary,
    },
    statLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "center",
      marginTop: 3,
    },
    noStatusesWarningCard: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: Colors.warningLight,
      borderWidth: 1,
      borderColor: Colors.accent,
      borderRadius: 14,
      padding: 12,
      gap: 10,
    },
    noStatusesWarningTitle: {
      fontSize: 13,
      fontWeight: "800",
      color: Colors.warningText,
      textAlign: "right",
    },
    noStatusesWarningSub: {
      fontSize: 11,
      color: Colors.warningText,
      textAlign: "right",
      marginTop: 2,
    },
    goToDistributionBtn: {
      backgroundColor: Colors.primary,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
    },
    goToDistributionBtnText: {
      color: Colors.white,
      fontSize: 12,
      fontWeight: "800",
    },
    studentTabsBar: {
      flexDirection: "row-reverse",
      backgroundColor: colors.cardBackground,
      borderRadius: 14,
      padding: 4,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6,
    },
    studentTabBtn: {
      flex: 1,
      minHeight: 42,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    studentTabBtnActive: {
      backgroundColor: Colors.primary,
    },
    studentTabText: {
      fontSize: 13,
      fontWeight: "800",
      color: colors.textSecondary,
    },
    studentTabTextActive: {
      color: Colors.white,
    },
    studentEvalCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 14,
      gap: 12,
    },
    studentEvalCardSelected: {
      borderColor: Colors.primary,
      backgroundColor: Colors.primaryLight,
    },
    studentEvalHeader: {
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    studentSelectRow: {
      flex: 1,
      flexDirection: "row-reverse",
      alignItems: "flex-start",
      gap: 10,
    },
    studentIdentityBlock: {
      flex: 1,
      alignItems: "flex-end",
      gap: 5,
    },
    studentNameText: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    studentBadgesRow: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      gap: 6,
    },
    codeBadge: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    codeBadgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    attendedBadge: {
      backgroundColor: Colors.successLight,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    attendedBadgeText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.successText,
    },
    unevaluatedBadge: {
      backgroundColor: Colors.warningLight,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    unevaluatedBadgeText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.warningText,
    },
    savedStatusBadge: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      backgroundColor: Colors.successLight,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: 6,
    },
    savedStatusBadgeText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.successText,
    },
    notifiedBadge: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      backgroundColor: Colors.primaryLight,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    notifiedBadgeText: {
      fontSize: 10,
      fontWeight: "800",
      color: Colors.primary,
    },
    evaluatedTimeText: {
      fontSize: 11,
      color: colors.textSecondary,
      textAlign: "right",
    },
    evaluationButtonsContainer: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
      gap: 8,
    },
    chooseEvalPrompt: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
      textAlign: "right",
    },
    evaluationButtonsGrid: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      gap: 8,
    },
    evalChoiceButton: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 13,
      paddingVertical: 9,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: Colors.primaryMuted,
      backgroundColor: Colors.primaryLight,
    },
    evalChoiceButtonActive: {
      backgroundColor: Colors.primary,
      borderColor: Colors.primary,
    },
    evalChoiceButtonText: {
      fontSize: 13,
      fontWeight: "800",
      color: Colors.primary,
    },
    evalChoiceButtonTextActive: {
      color: Colors.white,
    },
    clearEvalButton: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 9,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: Colors.dangerLight,
    },
    clearEvalButtonText: {
      fontSize: 12,
      fontWeight: "800",
      color: colors.danger,
    },
    notificationActionBar: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 12,
      gap: 10,
    },
    selectionSummaryRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    selectAllBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
    },
    selectAllBtnText: {
      fontSize: 13,
      fontWeight: "800",
      color: Colors.primary,
    },
    selectedCountText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    sendHomeworkStatusBtn: {
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: Colors.primary,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    sendHomeworkStatusBtnDisabled: {
      opacity: 0.45,
    },
    sendHomeworkStatusBtnText: {
      color: Colors.white,
      fontSize: 14,
      fontWeight: "900",
    },
    evaluatedRowQuickActions: {
      alignItems: "flex-start",
      gap: 6,
    },
    singleSendBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: Colors.primaryLight,
      borderWidth: 1,
      borderColor: Colors.primaryMuted,
    },
    singleSendBtnText: {
      fontSize: 11,
      fontWeight: "800",
      color: Colors.primary,
    },
    changeEvalToggleBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    changeEvalToggleBtnText: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.55)",
      justifyContent: "center",
      alignItems: "center",
      padding: 18,
    },
    modalCard: {
      width: "100%",
      backgroundColor: colors.cardBackground,
      borderRadius: 20,
      padding: 18,
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    modalHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    modalTitle: {
      fontSize: 16,
      fontWeight: "900",
      color: colors.textPrimary,
      textAlign: "right",
    },
    modalSubHint: {
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: "right",
      lineHeight: 18,
    },
    modalBodyText: {
      fontSize: 13,
      color: colors.textPrimary,
      textAlign: "right",
      lineHeight: 20,
    },
    recipientSwitchRow: {
      flexDirection: "row-reverse",
      gap: 8,
    },
    recipientOptionBtn: {
      flex: 1,
      minHeight: 42,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    recipientOptionBtnActive: {
      borderColor: Colors.primary,
      backgroundColor: Colors.primaryLight,
    },
    recipientOptionText: {
      fontSize: 12,
      fontWeight: "800",
      color: colors.textSecondary,
    },
    recipientOptionTextActive: {
      color: Colors.primary,
    },
    previewScrollArea: {
      maxHeight: 320,
    },
    previewItemCard: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 12,
      gap: 6,
    },
    previewItemHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    previewStudentName: {
      fontSize: 14,
      fontWeight: "800",
      color: colors.textPrimary,
      textAlign: "right",
    },
    previewRecipientMeta: {
      fontSize: 11,
      color: colors.textSecondary,
      textAlign: "right",
    },
    previewMessageBox: {
      backgroundColor: colors.cardBackground,
      borderRadius: 9,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    previewMessageText: {
      fontSize: 12,
      color: colors.textPrimary,
      textAlign: "right",
      lineHeight: 19,
    },
    modalFooterActions: {
      flexDirection: "row-reverse",
      gap: 8,
      marginTop: 4,
    },
    modalPrimaryBtn: {
      flex: 1,
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: Colors.primary,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      paddingHorizontal: 14,
    },
    modalPrimaryBtnText: {
      color: Colors.white,
      fontSize: 13,
      fontWeight: "900",
    },
    modalDangerBtn: {
      flex: 1,
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.danger,
      alignItems: "center",
      justifyContent: "center",
    },
    modalDangerBtnText: {
      color: Colors.white,
      fontSize: 13,
      fontWeight: "800",
    },
    modalCancelBtn: {
      minWidth: 90,
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    modalCancelBtnText: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: "700",
    },
  });
