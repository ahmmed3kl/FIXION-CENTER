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
import { DatabaseService } from "../../core/database";
import { PermissionGate } from "../../core/permissions";
import { Colors } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { NotificationService } from "../../features/notifications/NotificationService";
import { NotificationTemplateRepository } from "../../features/notifications/NotificationTemplateRepository";
import {
  NotificationDelivery,
  NotificationEvent,
  NotificationTemplate,
} from "../../shared/types";

export default function NotificationsScreen() {
  const services = useServiceVisibility();
  const { currentUser, activeCenterId } = useAuthStore();
  const [activeTab, setActiveTab] = useState<"history" | "templates">("history");

  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, NotificationDelivery[]>>({});

  // Editing template modal state
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [templateBodyInput, setTemplateBodyInput] = useState("");

  if (!services.loaded) return <View style={styles.centered}><Text style={styles.loadingText}>جار تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("notifications")) return <View style={styles.centered}><Text style={styles.loadingText}>خدمة الإشعارات غير مفعلة لهذا المركز.</Text></View>;

  const loadData = () => {
    if (!activeCenterId) return;
    setLoading(true);
    try {
      NotificationTemplateRepository.ensureDefaultTemplates();
      const tmpls = NotificationTemplateRepository.getTemplates();
      setTemplates(tmpls);

      // Fetch recent notification events
      const db = DatabaseService.getDb();
      const recentEvents = db.getAllSync(
        `SELECT id, operation_id as operationId, center_id as centerId,
                student_id as studentId, session_id as sessionId, attendance_id as attendanceId,
                event_type as eventType, created_by as createdBy, created_at as createdAt
         FROM notification_events
         WHERE center_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
        [activeCenterId],
      );
      setEvents(recentEvents);

      const dMap: Record<string, NotificationDelivery[]> = {};
      for (const ev of recentEvents) {
        dMap[ev.id] = NotificationService.getDeliveriesForEvent(ev.id);
      }
      setDeliveries(dMap);
    } catch (err: any) {
      console.warn("Failed to load notifications data:", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeCenterId]);

  const handleSaveTemplate = () => {
    if (!editingTemplate) return;
    try {
      NotificationTemplateRepository.updateTemplate(editingTemplate.id, templateBodyInput);
      Alert.alert("تم الحفظ", "تم تحديث قالب الإشعار بنجاح.");
      setEditingTemplate(null);
      loadData();
    } catch (err: any) {
      Alert.alert("خطأ", err.message || "فشل حفظ القالب");
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "sent":
        return { text: "تم الإرسال", bg: Colors.successLight, color: Colors.successText };
      case "failed":
        return { text: "فشل الإرسال", bg: Colors.dangerLight, color: Colors.dangerText };
      case "sending":
        return { text: "جارٍ الإرسال", bg: Colors.warningLight, color: Colors.warningText };
      default:
        return { text: "قيد الانتظار", bg: Colors.slate100, color: Colors.slate700 };
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>مركز الإشعارات</Text>
        <Text style={styles.headerSubtitle}>إدارة القوالب وسجل الإشعارات الفورية و SMS</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "history" && styles.tabButtonActive]}
          onPress={() => setActiveTab("history")}
        >
          <Text style={[styles.tabText, activeTab === "history" && styles.tabTextActive]}>
            سجل الإشعارات
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "templates" && styles.tabButtonActive]}
          onPress={() => setActiveTab("templates")}
        >
          <Text style={[styles.tabText, activeTab === "templates" && styles.tabTextActive]}>
            قوالب الإشعارات
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>جارٍ تحميل البيانات...</Text>
        </View>
      ) : activeTab === "history" ? (
        <FlatList
          data={events}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="notifications-off-outline" size={48} color={Colors.slate400} />
              <Text style={styles.emptyText}>لا توجد إشعارات مسجلة حتى الآن.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const itemDeliveries = deliveries[item.id] || [];
            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.eventTypeTag}>
                    <Text style={styles.eventTypeText}>
                      {item.eventType === "attendance" ? "إشعار حضور" : item.eventType === "absence" ? "إشعار غياب" : "إرسال درجات"}
                    </Text>
                  </View>
                  <Text style={styles.timestampText}>
                    {new Date(item.createdAt).toLocaleString("ar-EG")}
                  </Text>
                </View>

                {itemDeliveries.map((del) => {
                  const badge = getStatusBadge(del.status);
                  return (
                    <View key={del.id} style={styles.deliveryRow}>
                      <View style={styles.deliveryMeta}>
                        <Ionicons
                          name={del.channel === "push" ? "phone-portrait-outline" : "chatbubble-ellipses-outline"}
                          size={18}
                          color={Colors.primary}
                        />
                        <Text style={styles.channelText}>
                          {del.channel === "push" ? "إشعار فوري" : "رسالة نصية SMS"}
                        </Text>
                        <Text style={styles.recipientText}>({del.recipient || "بدون رقم"})</Text>
                      </View>
                      <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
                        <Text style={[styles.statusBadgeText, { color: badge.color }]}>
                          {badge.text}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            );
          }}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          <Text style={styles.sectionHeader}>القوالب المعتمدة للإرسال التلقائي واليدوي</Text>
          {templates.map((tmpl) => (
            <View key={tmpl.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.tmplTitle}>
                  {tmpl.eventType === "attendance" ? "قالب حضور" : tmpl.eventType === "absence" ? "قالب غياب" : "قالب درجات"} (
                  {tmpl.channel === "push" ? "تطبيق / Push" : "رسالة نصية / SMS"})
                </Text>
                <PermissionGate
                  permission="notifications.templates.update"
                  userPermissions={currentUser?.permissions || []}
                >
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => {
                      setEditingTemplate(tmpl);
                      setTemplateBodyInput(tmpl.templateBody);
                    }}
                  >
                    <Ionicons name="create-outline" size={16} color={Colors.white} />
                    <Text style={styles.editBtnText}>تعديل</Text>
                  </TouchableOpacity>
                </PermissionGate>
              </View>
              <Text style={styles.tmplBody}>{tmpl.templateBody}</Text>
            </View>
          ))}

          <View style={styles.variablesInfo}>
            <Text style={styles.varTitle}>المتغيرات المتاحة في القوالب:</Text>
            <Text style={styles.varItem}>• {"{{student_name}}"} : اسم الطالب</Text>
            <Text style={styles.varItem}>• {"{{parent_name}}"} : اسم ولي الأمر</Text>
            <Text style={styles.varItem}>• {"{{center_name}}"} : اسم السنتر</Text>
            <Text style={styles.varItem}>• {"{{subject_name}}"} : اسم المادة</Text>
            <Text style={styles.varItem}>• {"{{teacher_name}}"} : اسم المدرس</Text>
            <Text style={styles.varItem}>• {"{{session_date}}"} : تاريخ الحصة</Text>
            <Text style={styles.varItem}>• {"{{session_time}}"} : وقت الحصة</Text>
            <Text style={styles.varItem}>• {"{{attendance_status}}"} : حالة الحضور</Text>
          </View>
        </ScrollView>
      )}

      {/* Edit Template Modal */}
      <Modal visible={!!editingTemplate} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>تعديل قالب الإشعار</Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={4}
              value={templateBodyInput}
              onChangeText={setTemplateBodyInput}
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.saveBtn]}
                onPress={handleSaveTemplate}
              >
                <Text style={styles.saveBtnText}>حفظ التعديلات</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.cancelBtn]}
                onPress={() => setEditingTemplate(null)}
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
  tabText: { fontSize: 14, fontWeight: "600", color: Colors.slate500 },
  tabTextActive: { color: Colors.primary },
  listContent: { padding: 16 },
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
  eventTypeTag: {
    backgroundColor: Colors.primaryLight || "#EBF5FF",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  eventTypeText: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  timestampText: { fontSize: 12, color: Colors.slate400 },
  deliveryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.slate100,
  },
  deliveryMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  channelText: { fontSize: 13, fontWeight: "600", color: Colors.slate700 },
  recipientText: { fontSize: 12, color: Colors.slate400 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusBadgeText: { fontSize: 11, fontWeight: "600" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 10, fontSize: 14, color: Colors.slate500 },
  emptyContainer: { alignItems: "center", justifyContent: "center", paddingVertical: 48 },
  emptyText: { marginTop: 12, fontSize: 14, color: Colors.slate500 },
  sectionHeader: { fontSize: 14, fontWeight: "700", color: Colors.slate700, marginBottom: 12, textAlign: "right" },
  tmplTitle: { fontSize: 14, fontWeight: "700", color: Colors.slate800 },
  tmplBody: { fontSize: 13, color: Colors.slate600, lineHeight: 20, textAlign: "right", marginTop: 6 },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  editBtnText: { color: Colors.white, fontSize: 12, fontWeight: "600" },
  variablesInfo: {
    backgroundColor: Colors.accentLight,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
  },
  varTitle: { fontSize: 13, fontWeight: "700", color: Colors.warningText, textAlign: "right", marginBottom: 6 },
  varItem: { fontSize: 12, color: Colors.warningText, textAlign: "right", marginVertical: 2 },
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
  textArea: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 100,
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
