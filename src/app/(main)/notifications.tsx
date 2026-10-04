import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
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
import { formatTimeArabic } from "../../core/localization";
import { PermissionGate } from "../../core/permissions";
import { Colors, useTheme } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { NotificationService } from "../../features/notifications/NotificationService";
import { NotificationTemplateRepository } from "../../features/notifications/NotificationTemplateRepository";
import { StudentRepository } from "../../features/students/StudentRepository";
import { Student, Group } from "../../shared/types";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { AttendanceSessionService } from "../../features/attendance/AttendanceSessionService";
import {
  NotificationDelivery,
  NotificationEvent,
  NotificationTemplate,
} from "../../shared/types";
import { formatLocalDateTime, getLocalDateOnly } from "../../shared/utils/date";

const DAYS_OF_WEEK = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function groupScheduleLabel(groupId: string): string {
  try {
    const schedules = GroupScheduleRepository.getSchedulesForGroup(groupId);
    return schedules.slice(0, 2).map((schedule) => `${DAYS_OF_WEEK[schedule.dayOfWeek] || "اليوم"} ${formatTimeArabic(schedule.startTime)} - ${formatTimeArabic(schedule.endTime)}`).join(" · ") || "لم يتم تحديد الموعد";
  } catch {
    return "لم يتم تحديد الموعد";
  }
}

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const services = useServiceVisibility();
  const { currentUser, activeCenterId } = useAuthStore();
  const [activeTab, setActiveTab] = useState<"history" | "templates" | "compose">("history");

  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, NotificationDelivery[]>>({});
  const currentMonth = getLocalDateOnly().slice(0, 7);
  const previousMonth = (() => { const [year, month] = currentMonth.split("-").map(Number); const date = new Date(year, month - 2, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; })();
  const [statsMonthA, setStatsMonthA] = useState(currentMonth);
  const [statsMonthB, setStatsMonthB] = useState(previousMonth);
  const [messageStats, setMessageStats] = useState<Record<string, { absence: number; grades: number; custom: number; total: number }>>({});
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [smsGroupId, setSmsGroupId] = useState("");
  const [smsGroupSearch, setSmsGroupSearch] = useState("");
  const [smsRecipient, setSmsRecipient] = useState<"parent" | "student">("parent");
  const [smsMessage, setSmsMessage] = useState("");
  const [sendingSms, setSendingSms] = useState(false);

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
      setStudents(StudentRepository.getAll(false));
      setGroups(GroupRepository.getAll().filter((group) => group.status === "active"));

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
      const stats: Record<string, { absence: number; grades: number; custom: number; total: number }> = {};
      for (const month of [statsMonthA, statsMonthB]) {
        const row = db.getFirstSync<any>(`SELECT
          SUM(CASE WHEN e.event_type = 'absence' THEN 1 ELSE 0 END) as absence,
          SUM(CASE WHEN e.event_type = 'grades' THEN 1 ELSE 0 END) as grades,
          SUM(CASE WHEN e.event_type NOT IN ('absence', 'grades', 'attendance') THEN 1 ELSE 0 END) as custom,
          COUNT(*) as total
          FROM notification_events e JOIN notification_deliveries d ON d.notification_event_id = e.id
          WHERE e.center_id = ? AND d.channel = 'sms' AND substr(e.created_at, 1, 7) = ?`, [activeCenterId, month]);
        stats[month] = { absence: Number(row?.absence || 0), grades: Number(row?.grades || 0), custom: Number(row?.custom || 0), total: Number(row?.total || 0) };
      }
      setMessageStats(stats);
    } catch (err: any) {
      console.warn("Failed to load notifications data:", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeCenterId, statsMonthA, statsMonthB]);

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

  const sendDirectSms = async () => {
    if (!smsGroupId) return Alert.alert("تنبيه", "اختر المجموعة أولًا.");
    if (!smsMessage.trim()) return Alert.alert("تنبيه", "اكتب نص الرسالة أولًا.");
    const selectedGroup = groups.find((group) => group.id === smsGroupId);
    if (!selectedGroup) return Alert.alert("تنبيه", "المجموعة المختارة لم تعد متاحة.");
    // Use the same roster calculation as attendance: package subscribers are
    // expected in their selected group even when they have no ordinary
    // student_group_enrollments row.
    const expectedStudentIds = AttendanceSessionService.getExpectedStudentIdsForGroup(
      selectedGroup,
      selectedGroup.id,
      getLocalDateOnly(),
    );
    const targets = Array.from(new Set(expectedStudentIds))
      .map((studentId) => students.find((student) => student.id === studentId))
      .filter(Boolean) as Student[];
    if (!targets.length) return Alert.alert("لا يوجد طلاب", "لا يوجد طلاب نشطون في هذه المجموعة.");
    // Respect the selected recipient. Do not silently send a parent-directed
    // message to the student when the guardian number is missing.
    const sendableTargets = targets.filter((target) =>
      (smsRecipient === "student" ? target.phone : target.parentPhone)?.trim(),
    );
    if (!sendableTargets.length) return Alert.alert("لا توجد أرقام", "لا يوجد أي رقم صالح للمستلمين في هذه المجموعة.");
    setSendingSms(true);
    let queuedCount = 0;
    try {
      for (const target of sendableTargets) {
        const event = NotificationService.notifyCustomSms({ studentId: target.id, message: smsMessage, recipientType: smsRecipient });
        await NotificationService.sendPendingDeliveries(event.id);
        queuedCount += 1;
      }
      setSmsMessage("");
      setSmsGroupId("");
      setSmsGroupSearch("");
      setActiveTab("history");
      loadData();
      const missingRecipientCount = targets.length - sendableTargets.length;
      Alert.alert(
        "تم تجهيز الرسائل",
        `تم تجهيز ${queuedCount} رسالة وإضافتها إلى طابور SMS للمزامنة.${missingRecipientCount ? `\nتم تخطي ${missingRecipientCount} طالبًا لعدم وجود رقم ${smsRecipient === "parent" ? "ولي أمر" : "طالب"}.` : ""}`,
      );
    } catch (error: any) {
      Alert.alert(
        "تعذر إكمال تجهيز الرسائل",
        `${queuedCount ? `تم تجهيز ${queuedCount} رسالة بالفعل. ` : ""}${error?.message || "حاول مرة أخرى."}`,
      );
    } finally {
      setSendingSms(false);
    }
  };

  const filteredSmsGroups = groups.filter((group) => {
    const query = smsGroupSearch.trim().toLocaleLowerCase();
    if (!query) return true;
    return [group.name, group.subjectName, group.teacherName, group.grade]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  }).slice(0, 30);
  const selectedSmsGroup = groups.find((group) => group.id === smsGroupId);
  const smsGroupMemberCount = useMemo(
    () => selectedSmsGroup
      ? AttendanceSessionService.getExpectedStudentIdsForGroup(selectedSmsGroup, selectedSmsGroup.id, getLocalDateOnly()).length
      : 0,
    [selectedSmsGroup, activeCenterId],
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>مركز الإشعارات</Text>
        <Text style={styles.headerSubtitle}>إدارة القوالب وسجل الإشعارات الفورية و SMS</Text>
      </View>

      <View style={styles.counterPanel}><Text style={styles.counterPanelTitle}>عداد رسائل SMS</Text><View style={styles.counterMonthRow}><TextInput style={styles.counterMonthInput} value={statsMonthA} onChangeText={setStatsMonthA} placeholder="YYYY-MM" /><Text style={styles.counterMonthLabel}>الشهر الأول</Text><TextInput style={styles.counterMonthInput} value={statsMonthB} onChangeText={setStatsMonthB} placeholder="YYYY-MM" /><Text style={styles.counterMonthLabel}>الشهر الثاني</Text></View><View style={styles.counterGrid}>{[statsMonthA, statsMonthB].map((month) => <View key={month} style={styles.counterMonthCard}><Text style={styles.counterMonthTitle}>{month}</Text><Text style={styles.counterValue}>الإجمالي: {messageStats[month]?.total || 0}</Text><Text style={styles.counterDetail}>غياب: {messageStats[month]?.absence || 0} · درجات: {messageStats[month]?.grades || 0} · أخرى: {messageStats[month]?.custom || 0}</Text></View>)}</View></View>

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
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "compose" && styles.tabButtonActive]}
          onPress={() => setActiveTab("compose")}
        >
          <Text style={[styles.tabText, activeTab === "compose" && styles.tabTextActive]}>SMS مباشر</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>جارٍ تحميل البيانات...</Text>
        </View>
      ) : activeTab === "compose" ? (
        <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          <View style={styles.composeHero}>
            <View style={styles.composeIcon}><Ionicons name="chatbubble-ellipses-outline" size={26} color={Colors.primary} /></View>
            <Text style={styles.composeTitle}>رسالة SMS مخصصة</Text>
            <Text style={styles.composeHint}>اكتب رسالتك بحرية واختر إرسالها للطالب أو لولي الأمر.</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>المجموعة</Text>
            <TextInput style={styles.composeInput} value={smsGroupSearch} onChangeText={setSmsGroupSearch} placeholder="ابحث باسم المجموعة أو المادة أو المدرس" placeholderTextColor={Colors.slate400} textAlign="right" />
            <ScrollView style={styles.studentPicker} nestedScrollEnabled>
              {filteredSmsGroups.map((group) => <TouchableOpacity key={group.id} style={[styles.studentChoice, smsGroupId === group.id && styles.studentChoiceActive]} onPress={() => { setSmsGroupId(group.id); setSmsGroupSearch(group.name); }}><View style={{ flex: 1 }}><Text style={styles.studentChoiceName}>{group.name}</Text><Text style={styles.studentChoiceMeta}>{[group.subjectName, group.teacherName, group.grade].filter(Boolean).join(" · ")}</Text><Text style={styles.studentChoiceSchedule}>{groupScheduleLabel(group.id)}</Text><Text style={styles.studentChoiceMeta}>{smsGroupId === group.id ? `${smsGroupMemberCount} طالب` : "اضغط للاختيار"}</Text></View><Ionicons name={smsGroupId === group.id ? "checkmark-circle" : "ellipse-outline"} size={20} color={smsGroupId === group.id ? Colors.primary : Colors.slate400} /></TouchableOpacity>)}
            </ScrollView>
            {selectedSmsGroup ? <Text style={styles.selectedGroupHint}>تم اختيار {selectedSmsGroup.name} · سيتم الإرسال إلى {smsGroupMemberCount} طالب</Text> : null}
            <Text style={styles.fieldLabel}>إرسال إلى</Text>
            <View style={styles.recipientRow}>
              {(["parent", "student"] as const).map((recipient) => <TouchableOpacity key={recipient} style={[styles.recipientButton, smsRecipient === recipient && styles.recipientButtonActive]} onPress={() => setSmsRecipient(recipient)}><Ionicons name={recipient === "parent" ? "people-outline" : "person-outline"} size={18} color={smsRecipient === recipient ? Colors.primary : Colors.slate500} /><Text style={[styles.recipientTextButton, smsRecipient === recipient && styles.recipientTextButtonActive]}>{recipient === "parent" ? "ولي الأمر" : "الطالب"}</Text></TouchableOpacity>)}
            </View>
            <Text style={styles.fieldLabel}>نص الرسالة</Text>
            <TextInput style={styles.composeTextArea} value={smsMessage} onChangeText={setSmsMessage} placeholder="اكتب رسالة SMS هنا..." placeholderTextColor={Colors.slate400} multiline numberOfLines={6} textAlign="right" textAlignVertical="top" maxLength={480} />
            <Text style={styles.composeCounter}>{smsMessage.length}/480</Text>
            <Text style={styles.variablesHint}>يمكنك استخدام: {"{{student_name}}"} · {"{{student_first_name}}"} · {"{{parent_name}}"} · {"{{center_name}}"}</Text>
            <TouchableOpacity style={styles.sendSmsButton} onPress={sendDirectSms} disabled={sendingSms} activeOpacity={0.8}><Ionicons name="send-outline" size={19} color={Colors.white} /><Text style={styles.sendSmsText}>{sendingSms ? "جاري التجهيز..." : "تجهيز وإرسال SMS"}</Text></TouchableOpacity>
          </View>
        </ScrollView>
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
                      {item.eventType === "attendance" ? "إشعار حضور" : item.eventType === "absence" ? "إشعار غياب" : item.eventType === "grades" ? "إرسال درجات" : "SMS مخصصة"}
                    </Text>
                  </View>
                  <Text style={styles.timestampText}>
                    {formatLocalDateTime(item.createdAt)}
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
                  {tmpl.eventType === "attendance" ? "قالب حضور" : tmpl.eventType === "absence" ? "قالب غياب" : tmpl.eventType === "grades" ? "قالب درجات" : "قالب مخصص"} (
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
            <Text style={styles.varItem}>{"{{student_first_name}}"} : الاسم الأول للطالب</Text>
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

const createStyles = () => StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.slate50 },
  header: {
    padding: 22,
    backgroundColor: Colors.cardBackground,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    shadowColor: Colors.slate900,
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
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
  composeHero: { backgroundColor: Colors.primaryLight, borderRadius: 18, padding: 18, marginBottom: 12, alignItems: "flex-end", borderWidth: 1, borderColor: Colors.primaryMuted },
  composeIcon: { width: 48, height: 48, borderRadius: 15, backgroundColor: Colors.white, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  composeTitle: { color: Colors.slate900, fontSize: 18, fontWeight: "900", textAlign: "right" },
  composeHint: { color: Colors.slate600, fontSize: 12, textAlign: "right", marginTop: 5, lineHeight: 19 },
  fieldLabel: { color: Colors.slate800, fontSize: 13, fontWeight: "800", textAlign: "right", marginTop: 4, marginBottom: 7 },
  composeInput: { height: 46, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, paddingHorizontal: 12, color: Colors.slate900, backgroundColor: Colors.slate50, fontSize: 13 },
  studentPicker: { maxHeight: 190, marginTop: 7, marginBottom: 10 },
  studentChoice: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white, marginBottom: 6 },
  studentChoiceActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  studentChoiceName: { color: Colors.slate900, fontSize: 13, fontWeight: "800", textAlign: "right" },
  studentChoiceMeta: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 2 },
  studentChoiceSchedule: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right", marginTop: 3 },
  selectedGroupHint: { color: Colors.primary, backgroundColor: Colors.primaryLight, borderRadius: 10, padding: 9, fontSize: 11, fontWeight: "800", textAlign: "right", marginBottom: 10 },
  recipientRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  recipientButton: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, backgroundColor: Colors.white },
  recipientButtonActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  recipientTextButton: { color: Colors.slate600, fontSize: 13, fontWeight: "800" },
  recipientTextButtonActive: { color: Colors.primary },
  composeTextArea: { minHeight: 132, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 12, color: Colors.slate900, backgroundColor: Colors.slate50, fontSize: 14, lineHeight: 21 },
  composeCounter: { color: Colors.slate400, fontSize: 10, textAlign: "left", marginTop: 4 },
  variablesHint: { color: Colors.slate500, fontSize: 11, textAlign: "right", lineHeight: 18, marginTop: 10 },
  sendSmsButton: { minHeight: 50, borderRadius: 13, backgroundColor: Colors.primary, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 16 },
  sendSmsText: { color: Colors.white, fontSize: 14, fontWeight: "900" },
  card: {
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: 17,
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
  counterPanel: { marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 14, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border },
  counterPanelTitle: { color: Colors.slate900, fontSize: 15, fontWeight: "800", textAlign: "right", marginBottom: 8 },
  counterMonthRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }, counterMonthInput: { width: 76, height: 34, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, textAlign: "center", color: Colors.slate900, fontSize: 11 }, counterMonthLabel: { color: Colors.slate500, fontSize: 10 },
  counterGrid: { flexDirection: "row", gap: 8 }, counterMonthCard: { flex: 1, padding: 9, borderRadius: 10, backgroundColor: Colors.slate50 }, counterMonthTitle: { color: Colors.primary, fontWeight: "800", textAlign: "right" }, counterValue: { color: Colors.slate800, fontSize: 12, fontWeight: "700", textAlign: "right", marginTop: 4 }, counterDetail: { color: Colors.slate600, fontSize: 10, textAlign: "right", marginTop: 3 },
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
