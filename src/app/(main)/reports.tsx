import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Colors } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { OperationalReportsService } from "../../features/reports/OperationalReportsService";
import { StudentRepository } from "../../features/students/StudentRepository";
import {
  DailyAttendanceReport,
  DetailedStudentFinancialStatus,
  Student,
  StudentAttendanceReport,
} from "../../shared/types";

export default function ReportsScreen() {
  const services = useServiceVisibility();
  if (!services.loaded) return <View style={styles.centered}><ActivityIndicator size="large" color={Colors.primary} /><Text style={styles.loadingText}>جار تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("reports")) return <View style={styles.centered}><Text style={styles.loadingText}>خدمة التقارير غير مفعلة لهذا المركز.</Text></View>;
  return <ReportsContent />;
}

function ReportsContent() {
  const services = useServiceVisibility();
  const { activeCenterId } = useAuthStore();
  const [activeReport, setActiveReport] = useState<"dailyAtt" | "studentAtt" | "dailyCash" | "studentFin">("dailyAtt");

  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split("T")[0]);

  // Report A: Daily Attendance
  const [dailyAttReport, setDailyAttReport] = useState<DailyAttendanceReport | null>(null);

  // Report B & D: Student selection
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");
  const [studentAttReport, setStudentAttReport] = useState<StudentAttendanceReport | null>(null);
  const [studentFinReport, setStudentFinReport] = useState<DetailedStudentFinancialStatus | null>(null);

  // Report C: Daily Cash
  const [dailyCashReport, setDailyCashReport] = useState<any>(null);

  useEffect(() => {
    if (!activeCenterId) return;
    try {
      const stdList = StudentRepository.getAll();
      setStudents(stdList);
      if (stdList.length > 0 && !selectedStudentId) {
        setSelectedStudentId(stdList[0].id);
      }
    } catch (e) {}
  }, [activeCenterId]);

  const loadReport = () => {
    if (!activeCenterId) return;
    setLoading(true);
    try {
      if (activeReport === "dailyAtt") {
        const rep = OperationalReportsService.getDailyAttendanceReport(selectedDate);
        setDailyAttReport(rep);
      } else if (activeReport === "studentAtt" && selectedStudentId) {
        const fromDate = "2026-09-01";
        const toDate = selectedDate;
        const rep = OperationalReportsService.getStudentAttendanceReport(selectedStudentId, fromDate, toDate);
        setStudentAttReport(rep);
      } else if (activeReport === "dailyCash") {
        const rep = OperationalReportsService.getDailyCashReport(selectedDate);
        setDailyCashReport(rep);
      } else if (activeReport === "studentFin" && selectedStudentId) {
        const rep = OperationalReportsService.getStudentFinancialSummary(selectedStudentId);
        setStudentFinReport(rep);
      }
    } catch (err: any) {
      console.warn("Report load error:", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [activeReport, selectedDate, selectedStudentId, activeCenterId]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>التقارير التشغيلية</Text>
        <Text style={styles.headerSubtitle}>تقارير الحضور والغياب اليومية والتحصيلات النقدية</Text>
      </View>

      {/* Report Selector Pills */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillsContainer}>
        <TouchableOpacity
          style={[styles.pill, activeReport === "dailyAtt" && styles.pillActive]}
          onPress={() => setActiveReport("dailyAtt")}
        >
          <Text style={[styles.pillText, activeReport === "dailyAtt" && styles.pillTextActive]}>
            حضور اليوم
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pill, activeReport === "studentAtt" && styles.pillActive]}
          onPress={() => setActiveReport("studentAtt")}
        >
          <Text style={[styles.pillText, activeReport === "studentAtt" && styles.pillTextActive]}>
            حضور طالب
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pill, activeReport === "dailyCash" && styles.pillActive]}
          onPress={() => setActiveReport("dailyCash")}
        >
          <Text style={[styles.pillText, activeReport === "dailyCash" && styles.pillTextActive]}>
            نقدية اليوم
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pill, activeReport === "studentFin" && styles.pillActive]}
          onPress={() => setActiveReport("studentFin")}
        >
          <Text style={[styles.pillText, activeReport === "studentFin" && styles.pillTextActive]}>
            الموقف المالي لطالب
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Date / Student Filter Bar */}
      <View style={styles.filterBar}>
        <View style={styles.filterItem}>
          <Text style={styles.filterLabel}>التاريخ:</Text>
          <TextInput
            style={styles.dateInput}
            value={selectedDate}
            onChangeText={setSelectedDate}
            placeholder="YYYY-MM-DD"
          />
        </View>

        {(activeReport === "studentAtt" || activeReport === "studentFin") && (
          <View style={[styles.filterItem, { flex: 1.5 }]}>
            <Text style={styles.filterLabel}>الطالب:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {students.map((st) => (
                <TouchableOpacity
                  key={st.id}
                  style={[
                    styles.studentMiniPill,
                    selectedStudentId === st.id && styles.studentMiniPillActive,
                  ]}
                  onPress={() => setSelectedStudentId(st.id)}
                >
                  <Text
                    style={[
                      styles.studentMiniPillText,
                      selectedStudentId === st.id && styles.studentMiniPillTextActive,
                    ]}
                  >
                    {st.fullName}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>جارٍ إعداد التقرير...</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Report A: Daily Attendance */}
          {activeReport === "dailyAtt" && dailyAttReport && (
            <View>
              {/* Summary Cards */}
              <View style={styles.kpiRow}>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>إجمالي الحصص</Text>
                  <Text style={styles.kpiValue}>{dailyAttReport.totals.totalSessions}</Text>
                </View>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>المتوقع</Text>
                  <Text style={styles.kpiValue}>{dailyAttReport.totals.totalExpected}</Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.successLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.successText }]}>حضور</Text>
                  <Text style={[styles.kpiValue, { color: Colors.successText }]}>
                    {dailyAttReport.totals.totalPresent}
                  </Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.dangerLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.dangerText }]}>غياب</Text>
                  <Text style={[styles.kpiValue, { color: Colors.dangerText }]}>
                    {dailyAttReport.totals.totalAbsent}
                  </Text>
                </View>
              </View>

              <Text style={styles.sectionHeader}>تفاصيل حصص يوم {selectedDate}</Text>
              {dailyAttReport.sessions.map((sess) => (
                <View key={sess.sessionId} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.sessGroup}>{sess.groupName}</Text>
                    <Text style={styles.sessRate}>نسبة الحضور: {sess.attendanceRate}%</Text>
                  </View>
                  <Text style={styles.sessMeta}>
                    {sess.subjectName} • {sess.teacherName} ({sess.startTime} - {sess.endTime})
                  </Text>
                  <View style={styles.statGrid}>
                    <Text style={styles.statText}>المتوقع: {sess.expectedCount}</Text>
                    <Text style={[styles.statText, { color: Colors.successText }]}>حاضر: {sess.presentCount}</Text>
                    <Text style={[styles.statText, { color: Colors.warningText }]}>متأخر: {sess.lateCount}</Text>
                    <Text style={[styles.statText, { color: Colors.primary }]}>تعويض: {sess.makeupCount}</Text>
                    <Text style={[styles.statText, { color: Colors.dangerText }]}>غياب: {sess.absentCount}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Report B: Student Attendance */}
          {activeReport === "studentAtt" && studentAttReport && (
            <View>
              <View style={styles.kpiRow}>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>الحصص المجدولة</Text>
                  <Text style={styles.kpiValue}>{studentAttReport.totals.totalSessions}</Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.successLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.successText }]}>حاضر</Text>
                  <Text style={[styles.kpiValue, { color: Colors.successText }]}>
                    {studentAttReport.totals.presentCount}
                  </Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.dangerLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.dangerText }]}>غائب</Text>
                  <Text style={[styles.kpiValue, { color: Colors.dangerText }]}>
                    {studentAttReport.totals.absentCount}
                  </Text>
                </View>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>نسبة الحضور</Text>
                  <Text style={styles.kpiValue}>{studentAttReport.totals.attendanceRate}%</Text>
                </View>
              </View>

              <Text style={styles.sectionHeader}>سجل حضور الطالب: {studentAttReport.studentName}</Text>
              {studentAttReport.sessions.map((sess, idx) => (
                <View key={idx} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.sessGroup}>{sess.groupName}</Text>
                    <Text style={styles.sessDate}>{sess.sessionDate}</Text>
                  </View>
                  <View style={styles.attBadgeRow}>
                    <Text style={styles.sessMeta}>{sess.subjectName}</Text>
                    <View
                      style={[
                        styles.statusBadge,
                        {
                          backgroundColor:
                            sess.status === "present"
                              ? Colors.successLight
                              : sess.status === "late"
                              ? Colors.warningLight
                              : sess.status === "makeup"
                              ? Colors.primaryLight || "#EBF5FF"
                              : Colors.dangerLight,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusBadgeText,
                          {
                            color:
                              sess.status === "present"
                                ? Colors.successText
                                : sess.status === "late"
                                ? Colors.warningText
                                : sess.status === "makeup"
                                ? Colors.primary
                                : Colors.dangerText,
                          },
                        ]}
                      >
                        {sess.status === "present"
                          ? "حاضر"
                          : sess.status === "late"
                          ? "متأخر"
                          : sess.status === "makeup"
                          ? "حضور تعويضي"
                          : "غائب"}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Report C: Daily Cash Report */}
          {activeReport === "dailyCash" && dailyCashReport && (
            <View>
              <View style={styles.totalBox}>
                <Text style={styles.totalLabel}>إجمالي إيراد يوم {selectedDate}</Text>
                <Text style={styles.totalValue}>{dailyCashReport.totalCash} ج.م</Text>
                <Text style={styles.totalSub}>عدد المعاملات: {dailyCashReport.paymentCount}</Text>
              </View>

              <View style={styles.grid}>
                <View style={styles.gridItem}>
                  <Text style={styles.gridLabel}>اشتراكات مجموعات</Text>
                  <Text style={styles.gridVal}>{dailyCashReport.monthlyTotal} ج.م</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={styles.gridLabel}>دفعات جزئية</Text>
                  <Text style={styles.gridVal}>{dailyCashReport.partialTotal} ج.م</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={styles.gridLabel}>حصص فردية</Text>
                  <Text style={styles.gridVal}>{dailyCashReport.sessionTotal} ج.م</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={styles.gridLabel}>حضور خارجي</Text>
                  <Text style={styles.gridVal}>{dailyCashReport.externalMakeupTotal} ج.م</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={styles.gridLabel}>باقات تعليمية</Text>
                  <Text style={styles.gridVal}>{dailyCashReport.packageTotal} ج.م</Text>
                </View>
              </View>
            </View>
          )}

          {/* Report D: Student Financial Summary */}
          {activeReport === "studentFin" && studentFinReport && (
            <View>
              <View style={styles.kpiRow}>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>إجمالي المستحق</Text>
                  <Text style={styles.kpiValue}>{studentFinReport.monthlyTotalDue} ج.م</Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.successLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.successText }]}>المدفوع</Text>
                  <Text style={[styles.kpiValue, { color: Colors.successText }]}>
                    {studentFinReport.monthlyTotalPaid} ج.م
                  </Text>
                </View>
                <View style={[styles.kpiBox, { backgroundColor: Colors.dangerLight }]}>
                  <Text style={[styles.kpiLabel, { color: Colors.dangerText }]}>المتبقي</Text>
                  <Text style={[styles.kpiValue, { color: Colors.dangerText }]}>
                    {studentFinReport.totalRemainingDebt} ج.م
                  </Text>
                </View>
                <View style={styles.kpiBox}>
                  <Text style={styles.kpiLabel}>دفعات الحصص</Text>
                  <Text style={styles.kpiValue}>{studentFinReport.sessionPaymentsTotal} ج.م</Text>
                </View>
              </View>

              <Text style={styles.sectionHeader}>دورات المديونية (مجموعات وباقات)</Text>
              {studentFinReport.cycles.map((c) => (
                <View key={c.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.sessGroup}>{c.groupName || c.packageName || "اشتراك"}</Text>
                    <Text style={styles.sessDate}>{c.startDate} إلى {c.endDate}</Text>
                  </View>
                  <View style={styles.statGrid}>
                    <Text style={styles.statText}>المبلغ: {c.cyclePrice} ج.م</Text>
                    <Text style={[styles.statText, { color: Colors.successText }]}>المدفوع: {c.paidAmount || 0} ج.م</Text>
                    <Text style={[styles.statText, { color: Colors.dangerText }]}>المتبقي: {c.remainingDebt || 0} ج.م</Text>
                    <Text style={styles.statText}>الحالة: {c.status}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
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
  pillsContainer: { padding: 12, backgroundColor: Colors.white, gap: 8 },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.slate100,
  },
  pillActive: { backgroundColor: Colors.primary },
  pillText: { fontSize: 13, fontWeight: "600", color: Colors.slate700 },
  pillTextActive: { color: Colors.white },
  filterBar: {
    flexDirection: "row",
    backgroundColor: Colors.white,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    alignItems: "center",
  },
  filterItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  filterLabel: { fontSize: 12, fontWeight: "600", color: Colors.slate600 },
  dateInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
    width: 100,
    textAlign: "center",
  },
  studentMiniPill: {
    backgroundColor: Colors.slate100,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 6,
  },
  studentMiniPillActive: { backgroundColor: Colors.primaryLight || "#EBF5FF" },
  studentMiniPillText: { fontSize: 11, color: Colors.slate600 },
  studentMiniPillTextActive: { color: Colors.primary, fontWeight: "700" },
  content: { padding: 16 },
  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  kpiBox: {
    flex: 1,
    backgroundColor: Colors.white,
    padding: 10,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  kpiLabel: { fontSize: 10, color: Colors.slate500, textAlign: "center" },
  kpiValue: { fontSize: 16, fontWeight: "800", color: Colors.slate900, marginTop: 4 },
  sectionHeader: { fontSize: 14, fontWeight: "700", color: Colors.slate700, marginVertical: 10, textAlign: "right" },
  card: {
    backgroundColor: Colors.white,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sessGroup: { fontSize: 14, fontWeight: "700", color: Colors.slate800 },
  sessRate: { fontSize: 12, fontWeight: "600", color: Colors.primary },
  sessDate: { fontSize: 12, color: Colors.slate400 },
  sessMeta: { fontSize: 12, color: Colors.slate500, marginTop: 4, textAlign: "right" },
  statGrid: { flexDirection: "row", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.slate100 },
  statText: { fontSize: 11, fontWeight: "600", color: Colors.slate600 },
  attBadgeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },
  totalBox: {
    backgroundColor: Colors.successLight,
    borderWidth: 1,
    borderColor: Colors.success,
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  totalLabel: { fontSize: 13, color: Colors.successText },
  totalValue: { fontSize: 26, fontWeight: "800", color: Colors.successText, marginVertical: 4 },
  totalSub: { fontSize: 12, color: Colors.successText },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  gridItem: {
    width: "48%",
    backgroundColor: Colors.white,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  gridLabel: { fontSize: 11, color: Colors.slate500, textAlign: "right" },
  gridVal: { fontSize: 14, fontWeight: "700", color: Colors.slate800, textAlign: "right", marginTop: 2 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 10, fontSize: 14, color: Colors.slate500 },
});
