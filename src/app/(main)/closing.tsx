import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { PermissionGate } from "../../core/permissions";
import { Colors } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { DailyClosingService } from "../../features/reports/DailyClosingService";
import { SessionClosingService } from "../../features/sessions/SessionClosingService";
import { SessionRepository } from "../../features/sessions/SessionRepository";
import { DailyClosingSummary, Session } from "../../shared/types";
import { getLocalDateOnly } from "../../shared/utils/date";

export default function ClosingScreen() {
  const { currentUser, activeCenterId } = useAuthStore();
  const [activeTab, setActiveTab] = useState<"daily" | "sessions">("daily");

  const [loading, setLoading] = useState(false);
  const [todayDate] = useState(() => getLocalDateOnly());

  // Daily Closing State
  const [todayDailyClosing, setTodayDailyClosing] = useState<DailyClosingSummary | null>(null);
  const [closingsHistory, setClosingsHistory] = useState<DailyClosingSummary[]>([]);
  const [reopenModalVisible, setReopenModalVisible] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [targetBusinessDate, setTargetBusinessDate] = useState("");

  // Session Closing State
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [sessionReopenModal, setSessionReopenModal] = useState<string | null>(null);
  const [sessionReopenReason, setSessionReopenReason] = useState("");

  const loadData = () => {
    if (!activeCenterId) return;
    setLoading(true);
    try {
      // Daily closings
      try {
        const todayClosing = DailyClosingService.getClosingForDate(todayDate);
        setTodayDailyClosing(todayClosing);
        const history = DailyClosingService.getAllClosings();
        setClosingsHistory(history);
      } catch (e) {
        // Permission might be restricted
      }

      // Today sessions
      try {
        const sessions = SessionRepository.getSessionsForDate(todayDate);
        setTodaySessions(sessions);
      } catch (e) {
        // Permission might be restricted
      }
    } catch (err: any) {
      console.warn("Failed to load closing data:", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeCenterId]);

  const handleCloseDaily = () => {
    Alert.alert(
      "تأكيد الإغلاق اليومي",
      `هل أنت متأكد من رغبتك في إغلاق الصندوق ليوم ${todayDate}؟ لن تتمكن من إجراء تعديلات بعد الإغلاق إلا بصلاحية المدير.`,
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "إغلاق الصندوق",
          style: "destructive",
          onPress: () => {
            try {
              DailyClosingService.closeDailyForDate(todayDate);
              Alert.alert("تم الإغلاق", "تم إغلاق الصندوق وتجميع الإيرادات بنجاح.");
              loadData();
            } catch (err: any) {
              Alert.alert("خطأ", err.message || "فشل إغلاق الصندوق");
            }
          },
        },
      ],
    );
  };

  const handleReopenDaily = () => {
    if (!reopenReason.trim()) {
      Alert.alert("خطأ", "يجب إدخال سبب إعادة فتح الصندوق.");
      return;
    }
    try {
      DailyClosingService.reopenDailyClosing(targetBusinessDate, reopenReason);
      Alert.alert("تم إعادة الفتح", `تم إعادة فتح الصندوق ليوم ${targetBusinessDate} بنجاح.`);
      setReopenModalVisible(false);
      setReopenReason("");
      loadData();
    } catch (err: any) {
      Alert.alert("خطأ", err.message || "فشل إعادة فتح الصندوق");
    }
  };

  const handleCloseSession = (session: Session) => {
    Alert.alert(
      "إغلاق الحصة",
      `هل أنت متأكد من إغلاق حصة ${session.groupName}؟ سيتم منع تسجيل الحضور بعد الإغلاق.`,
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "إغلاق الحصة",
          style: "destructive",
          onPress: () => {
            try {
              SessionClosingService.closeSession(session.id);
              Alert.alert("تم الإغلاق", "تم إغلاق الحصة بنجاح وحساب إجماليات الحضور.");
              loadData();
            } catch (err: any) {
              Alert.alert("خطأ", err.message || "فشل إغلاق الحصة");
            }
          },
        },
      ],
    );
  };

  const handleReopenSession = (sessionId: string) => {
    if (!sessionReopenReason.trim()) {
      Alert.alert("خطأ", "يجب إدخال سبب إعادة فتح الحصة.");
      return;
    }
    try {
      SessionClosingService.reopenSession(sessionId, sessionReopenReason);
      Alert.alert("تمت إعادة الفتح", "تمت إعادة فتح الحصة بنجاح.");
      setSessionReopenModal(null);
      setSessionReopenReason("");
      loadData();
    } catch (err: any) {
      Alert.alert("خطأ", err.message || "فشل إعادة فتح الحصة");
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>الإغلاق والتقفيل</Text>
        <Text style={styles.headerSubtitle}>إغلاق الصندوق النقدي اليومي وإقفال الحصص والمحاضرات</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "daily" && styles.tabButtonActive]}
          onPress={() => setActiveTab("daily")}
        >
          <Text style={[styles.tabText, activeTab === "daily" && styles.tabTextActive]}>
            الإغلاق اليومي للصندوق
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "sessions" && styles.tabButtonActive]}
          onPress={() => setActiveTab("sessions")}
        >
          <Text style={[styles.tabText, activeTab === "sessions" && styles.tabTextActive]}>
            إقفال الحصص
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>جارٍ التحميل...</Text>
        </View>
      ) : activeTab === "daily" ? (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Today Status Card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>صندوق اليوم ({todayDate})</Text>
              <View
                style={[
                  styles.statusBadge,
                  {
                    backgroundColor:
                      todayDailyClosing?.status === "closed" ? Colors.successLight : Colors.warningLight,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusBadgeText,
                    {
                      color:
                        todayDailyClosing?.status === "closed" ? Colors.successText : Colors.warningText,
                    },
                  ]}
                >
                  {todayDailyClosing?.status === "closed" ? "مغلق" : "مفتوح"}
                </Text>
              </View>
            </View>

            {todayDailyClosing ? (
              <View style={styles.breakdownContainer}>
                <View style={styles.totalBox}>
                  <Text style={styles.totalLabel}>إجمالي النقدية المقفلة</Text>
                  <Text style={styles.totalValue}>{todayDailyClosing.totalCash} ج.م</Text>
                </View>

                <View style={styles.grid}>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>اشتراكات شهرية</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.monthlyTotal} ج.م</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>دفعات جزئية</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.partialTotal} ج.م</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>حصص فردية</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.sessionTotal} ج.م</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>حضور خارجي</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.externalMakeupTotal} ج.م</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>باقات تعليمية</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.packageTotal} ج.م</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={styles.gridLabel}>عدد الإيصالات</Text>
                    <Text style={styles.gridVal}>{todayDailyClosing.paymentCount}</Text>
                  </View>
                </View>

                {todayDailyClosing.status === "closed" && (
                  <PermissionGate
                    permission="daily_closing.reopen"
                    userPermissions={currentUser?.permissions || []}
                  >
                    <TouchableOpacity
                      style={styles.reopenBtn}
                      onPress={() => {
                        setTargetBusinessDate(todayDate);
                        setReopenModalVisible(true);
                      }}
                    >
                      <Ionicons name="refresh-outline" size={18} color={Colors.white} />
                      <Text style={styles.reopenBtnText}>إعادة فتح الصندوق (مدير)</Text>
                    </TouchableOpacity>
                  </PermissionGate>
                )}
              </View>
            ) : (
              <View style={styles.unclosedBox}>
                <Text style={styles.unclosedText}>
                  الصندوق مفتوح حالياً لاستقبال وتجميع المدفوعات. يمكنك إقفاله في نهاية اليوم.
                </Text>
                <PermissionGate
                  permission="daily_closing.close"
                  userPermissions={currentUser?.permissions || []}
                >
                  <TouchableOpacity style={styles.closeBtn} onPress={handleCloseDaily}>
                    <Ionicons name="lock-closed-outline" size={18} color={Colors.white} />
                    <Text style={styles.closeBtnText}>إقفال الصندوق اليومي الآن</Text>
                  </TouchableOpacity>
                </PermissionGate>
              </View>
            )}
          </View>

          {/* Closings History */}
          <Text style={styles.sectionHeader}>سجل الإقفال اليومي السابق</Text>
          {closingsHistory.map((cl) => (
            <View key={cl.id} style={styles.historyCard}>
              <View style={styles.cardHeader}>
                <Text style={styles.historyDate}>{cl.businessDate}</Text>
                <Text style={styles.historyCash}>{cl.totalCash} ج.م</Text>
              </View>
              <Text style={styles.historyMeta}>
                {cl.paymentCount} عمليات دفع • تم الإقفال بواسطة {cl.closedBy || "المدير"}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : (
        <FlatList
          data={todaySessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.content}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="calendar-outline" size={48} color={Colors.slate400} />
              <Text style={styles.emptyText}>لا توجد حصص مجدولة لليوم.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sessionGroupName}>{item.groupName}</Text>
                  <Text style={styles.sessionTeacher}>
                    {item.subjectName} • {item.teacherName}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor:
                        item.status === "closed" ? Colors.slate200 : Colors.successLight,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusBadgeText,
                      { color: item.status === "closed" ? Colors.slate700 : Colors.successText },
                    ]}
                  >
                    {item.status === "closed" ? "مغلقة" : "مفتوحة"}
                  </Text>
                </View>
              </View>

              <View style={styles.sessionTimeRow}>
                <Ionicons name="time-outline" size={16} color={Colors.slate500} />
                <Text style={styles.sessionTimeText}>
                  {item.startTime} - {item.endTime}
                </Text>
              </View>

              <View style={styles.sessionActionRow}>
                {item.status === "closed" ? (
                  <PermissionGate
                    permission="sessions.reopen"
                    userPermissions={currentUser?.permissions || []}
                  >
                    <TouchableOpacity
                      style={styles.sessionReopenBtn}
                      onPress={() => setSessionReopenModal(item.id)}
                    >
                      <Ionicons name="lock-open-outline" size={16} color={Colors.warningText} />
                      <Text style={styles.sessionReopenText}>إعادة فتح الحصة (مدير)</Text>
                    </TouchableOpacity>
                  </PermissionGate>
                ) : (
                  <PermissionGate
                    permission="sessions.close"
                    userPermissions={currentUser?.permissions || []}
                  >
                    <TouchableOpacity
                      style={styles.sessionCloseBtn}
                      onPress={() => handleCloseSession(item)}
                    >
                      <Ionicons name="lock-closed-outline" size={16} color={Colors.white} />
                      <Text style={styles.sessionCloseText}>إقفال الحصة</Text>
                    </TouchableOpacity>
                  </PermissionGate>
                )}
              </View>
            </View>
          )}
        />
      )}

      {/* Daily Reopen Modal */}
      <Modal visible={reopenModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>إعادة فتح الصندوق اليومي</Text>
            <Text style={styles.modalSubtitle}>
              يرجى توضيح سبب إعادة فتح صندوق يوم {targetBusinessDate}:
            </Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={3}
              placeholder="سبب إعادة الفتح (مطلوب)..."
              value={reopenReason}
              onChangeText={setReopenReason}
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.saveBtn]} onPress={handleReopenDaily}>
                <Text style={styles.saveBtnText}>تأكيد إعادة الفتح</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => setReopenModalVisible(false)}
              >
                <Text style={styles.cancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Session Reopen Modal */}
      <Modal visible={!!sessionReopenModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>إعادة فتح الحصة</Text>
            <Text style={styles.modalSubtitle}>يرجى توضيح سبب إعادة فتح الحصة:</Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={3}
              placeholder="سبب إعادة فتح الحصة (مطلوب)..."
              value={sessionReopenReason}
              onChangeText={setSessionReopenReason}
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.saveBtn]}
                onPress={() => sessionReopenModal && handleReopenSession(sessionReopenModal)}
              >
                <Text style={styles.saveBtnText}>تأكيد إعادة الفتح</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => setSessionReopenModal(null)}
              >
                <Text style={styles.cancelBtnText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.slate50 },
  header: {
    padding: 20,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: Colors.slate900, textAlign: "right" },
  headerSubtitle: { fontSize: 13, color: Colors.slate500, textAlign: "right", marginTop: 4 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: Colors.white,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabButtonActive: { borderBottomColor: Colors.primary },
  tabText: { fontSize: 13, fontWeight: "600", color: Colors.slate500 },
  tabTextActive: { color: Colors.primary },
  content: { padding: 16 },
  card: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.slate800 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  statusBadgeText: { fontSize: 12, fontWeight: "700" },
  breakdownContainer: { marginTop: 8 },
  totalBox: {
    backgroundColor: Colors.successLight,
    borderWidth: 1,
    borderColor: Colors.success,
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
    marginBottom: 12,
  },
  totalLabel: { fontSize: 12, color: Colors.successText },
  totalValue: { fontSize: 22, fontWeight: "800", color: Colors.successText, marginTop: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  gridItem: {
    width: "48%",
    backgroundColor: Colors.slate50,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.slate200,
  },
  gridLabel: { fontSize: 11, color: Colors.slate500, textAlign: "right" },
  gridVal: { fontSize: 14, fontWeight: "700", color: Colors.slate800, textAlign: "right", marginTop: 2 },
  unclosedBox: { paddingVertical: 8 },
  unclosedText: { fontSize: 13, color: Colors.slate600, lineHeight: 20, textAlign: "right", marginBottom: 12 },
  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6,
  },
  closeBtnText: { color: Colors.white, fontSize: 14, fontWeight: "700" },
  reopenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.warning,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  reopenBtnText: { color: Colors.white, fontSize: 13, fontWeight: "700" },
  sectionHeader: { fontSize: 14, fontWeight: "700", color: Colors.slate700, marginVertical: 12, textAlign: "right" },
  historyCard: {
    backgroundColor: Colors.white,
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  historyDate: { fontSize: 14, fontWeight: "700", color: Colors.slate800 },
  historyCash: { fontSize: 14, fontWeight: "700", color: Colors.successText },
  historyMeta: { fontSize: 12, color: Colors.slate400, marginTop: 4, textAlign: "right" },
  sessionGroupName: { fontSize: 15, fontWeight: "700", color: Colors.slate800, textAlign: "right" },
  sessionTeacher: { fontSize: 12, color: Colors.slate500, textAlign: "right", marginTop: 2 },
  sessionTimeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  sessionTimeText: { fontSize: 12, color: Colors.slate600 },
  sessionActionRow: { marginTop: 12, borderTopWidth: 1, borderTopColor: Colors.slate100, paddingTop: 8 },
  sessionCloseBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
  },
  sessionCloseText: { color: Colors.white, fontSize: 13, fontWeight: "600" },
  sessionReopenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.warningLight,
    borderWidth: 1,
    borderColor: Colors.warning,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
  },
  sessionReopenText: { color: Colors.warningText, fontSize: 13, fontWeight: "600" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 10, fontSize: 14, color: Colors.slate500 },
  emptyContainer: { alignItems: "center", justifyContent: "center", paddingVertical: 48 },
  emptyText: { marginTop: 12, fontSize: 14, color: Colors.slate500 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: { fontSize: 16, fontWeight: "700", color: Colors.slate900, textAlign: "right" },
  modalSubtitle: { fontSize: 13, color: Colors.slate600, textAlign: "right", marginTop: 4, marginBottom: 12 },
  textArea: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlign: "right",
    color: Colors.slate800,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  saveBtn: { backgroundColor: Colors.primary },
  saveBtnText: { color: Colors.white, fontWeight: "700" },
  cancelBtn: { backgroundColor: Colors.slate200 },
  cancelBtnText: { color: Colors.slate700, fontWeight: "600" },
});
