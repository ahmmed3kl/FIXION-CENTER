import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { formatCurrency, formatTimeArabic } from "../../core/localization";
import { PermissionService } from "../../core/permissions";
import { Spacing, Typography, useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import {
  getCairoTodayDateOnly,
  GroupPaymentStatistics,
  MonthlyPaymentStatRow,
  PartialPaymentStatRow,
  PaymentCategoryKey,
  PaymentStatisticsService,
  SessionPaymentStatRow,
  UnpaidStatRow,
} from "../../features/payments/PaymentStatisticsService";
import { Group, GroupSchedule } from "../../shared/types";
import { toArabicDigits } from "../../shared/utils/arabicNumerals";
import { formatLocalDate, parseLocalDateOnly } from "../../shared/utils/date";
import { captureLoad } from "../../shared/utils/loadResult";

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const CALENDAR_WEEKDAYS = ["ح", "ن", "ث", "ر", "خ", "ج", "س"];

const CATEGORIES: { key: PaymentCategoryKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "monthly", label: "دفع شهري", icon: "calendar-outline" },
  { key: "session", label: "دفع بالحصة", icon: "ticket-outline" },
  { key: "partial", label: "دفع جزئي", icon: "pie-chart-outline" },
  { key: "unpaid", label: "لم يدفع", icon: "alert-circle-outline" },
];

type GroupWithSchedules = Group & { schedules: GroupSchedule[] };

function formatScheduleSummary(schedules: GroupSchedule[]): { daysText: string; timeText: string } {
  if (!schedules.length) {
    return { daysText: "لا توجد مواعيد مسجلة", timeText: "" };
  }
  const days = schedules.map((s) => DAYS[s.dayOfWeek] || "اليوم");
  const uniqueDays = Array.from(new Set(days)).join("، ");
  const times = Array.from(
    new Set(
      schedules.map(
        (s) => `${formatTimeArabic(s.startTime)} - ${formatTimeArabic(s.endTime)}`,
      ),
    ),
  ).join(" | ");
  return { daysText: uniqueDays, timeText: times };
}

function buildCalendarMonthGrid(year: number, monthIndex: number): (string | null)[] {
  const firstDay = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const daysInMonth = new Date(year, monthIndex + 1, 0, 12, 0, 0, 0).getDate();
  const leadingEmpty = firstDay.getDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < leadingEmpty; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(
      `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatArabicMonthYear(year: number, monthIndex: number): string {
  return new Intl.DateTimeFormat("ar-EG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthIndex, 15, 12, 0, 0)));
}

export default function FinancialReportsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const localDataRevision = useLocalDataRevision();
  const { activeCenterId, currentUser } = useAuthStore();
  const canView = PermissionService.hasAnyPermission(currentUser?.permissions || [], [
    "reports.financial.view",
    "payments.debt.view",
  ]);
  const canCollectPayment = PermissionService.hasPermission(
    currentUser?.permissions || [],
    "payments.create",
  );

  const cairoToday = useMemo(() => getCairoTodayDateOnly(), []);
  const [groups, setGroups] = useState<GroupWithSchedules[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [reportDate, setReportDate] = useState<string>(() => getCairoTodayDateOnly());
  const [selectedCategory, setSelectedCategory] = useState<PaymentCategoryKey>("monthly");

  const [stats, setStats] = useState<GroupPaymentStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  const [calendarVisible, setCalendarVisible] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState<{ year: number; month: number }>(() => {
    const parsed = parseLocalDateOnly(cairoToday);
    return parsed
      ? { year: parsed.getFullYear(), month: parsed.getMonth() }
      : { year: new Date().getFullYear(), month: new Date().getMonth() };
  });

  const [payTarget, setPayTarget] = useState<{ studentId: string; studentName: string; remainingBalance: number } | null>(null);
  const [payCycles, setPayCycles] = useState<Array<{ id: string; label: string; remainingDebt: number }>>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [payAmount, setPayAmount] = useState<string>("");
  const [payMethod, setPayMethod] = useState<string>("cash");
  const [payNotes, setPayNotes] = useState<string>("");
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState<string>("");

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (!trimmed) {
      setDebouncedSearch("");
      return;
    }
    const timer = setTimeout(() => setDebouncedSearch(trimmed), 180);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!activeCenterId || !canView) {
      setGroups([]);
      return;
    }
    try {
      const activeGroups = GroupRepository.getAll(false);
      const enriched: GroupWithSchedules[] = activeGroups.map((group) => {
        let schedules: GroupSchedule[] = [];
        try {
          schedules = GroupScheduleRepository.getSchedulesForGroup(group.id);
        } catch {
          schedules = [];
        }
        return { ...group, schedules };
      });
      setGroups(enriched);
      if (selectedGroupId && !enriched.some((g) => g.id === selectedGroupId)) {
        setSelectedGroupId("");
      }
    } catch {
      setGroups([]);
    }
  }, [activeCenterId, canView]);

  useEffect(() => {
    if (!activeCenterId || !selectedGroupId || !canView) {
      setStats(null);
      setLoadError("");
      return;
    }
    setLoading(true);
    setLoadError("");
    const result = captureLoad(
      () => PaymentStatisticsService.getGroupPaymentStatistics(selectedGroupId, reportDate),
      "تعذر تحميل إحصائيات الدفع.",
    );
    if (result.status === "success") {
      setStats(result.value);
      setLoadError("");
    } else {
      setStats(null);
      setLoadError(result.message);
    }
    setLoading(false);
  }, [activeCenterId, selectedGroupId, reportDate, retryCount, localDataRevision, canView]);

  const openPayModal = (row: PartialPaymentStatRow | UnpaidStatRow) => {
    if (!canCollectPayment || !selectedGroupId) return;
    try {
      const fin = FinancialCalculationService.getStudentFinancialStatusForGroup(
        row.studentId,
        selectedGroupId,
        reportDate,
      );
      const openCycles = fin.cycles
        .filter((c) => Number(c.remainingDebt || 0) > 0 && c.status !== "cancelled")
        .map((c) => ({
          id: c.id,
          label: `${c.startDate} - ${c.endDate}`,
          remainingDebt: Number(c.remainingDebt || 0),
        }));
      setPayCycles(openCycles);
      const firstCycle = openCycles[0] || null;
      setSelectedCycleId(firstCycle?.id || "");
      const initialAmount = firstCycle ? firstCycle.remainingDebt : row.remainingBalance;
      setPayAmount(initialAmount > 0 ? String(initialAmount) : "");
      setPayMethod("cash");
      setPayNotes("");
      setPayError("");
      setPayTarget({
        studentId: row.studentId,
        studentName: row.studentName,
        remainingBalance: row.remainingBalance,
      });
    } catch (err: any) {
      Alert.alert("تعذر فتح الدفع", err?.userMessage || err?.message || "حدث خطأ أثناء تحميل المديونية.");
    }
  };

  const submitPayment = async () => {
    if (!payTarget || paySaving) return;
    const numericAmount = Number(payAmount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setPayError("أدخل مبلغاً صحيحاً أكبر من صفر.");
      return;
    }
    const targetCycle = payCycles.find((c) => c.id === selectedCycleId);
    const maxAllowed = targetCycle ? targetCycle.remainingDebt : payTarget.remainingBalance;
    const isPartial = maxAllowed > 0 && numericAmount < maxAllowed;

    setPaySaving(true);
    setPayError("");
    try {
      await PaymentRepository.recordPayment({
        studentId: payTarget.studentId,
        amount: numericAmount,
        paymentType: isPartial ? "partial" : "monthly",
        paymentMethod: payMethod,
        debtCycleId: selectedCycleId || undefined,
        paymentDate: reportDate,
        notes: payNotes.trim() || undefined,
      });
      setPayTarget(null);
      setRetryCount((c) => c + 1);
      Alert.alert("تم الدفع", `تم تسجيل دفعة بقيمة ${formatCurrency(numericAmount)} بنجاح.`);
    } catch (err: any) {
      setPayError(err?.userMessage || err?.message || "تعذر تسجيل الدفع.");
    } finally {
      setPaySaving(false);
    }
  };

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) || null;

  const filteredCategoryRows = useMemo(() => {
    if (!stats) return [];
    const rawRows = stats.categories[selectedCategory];
    return PaymentStatisticsService.filterRows(
      rawRows as (
        | MonthlyPaymentStatRow
        | SessionPaymentStatRow
        | PartialPaymentStatRow
        | UnpaidStatRow
      )[],
      selectedCategory,
      debouncedSearch,
      minAmount,
      maxAmount,
    );
  }, [stats, selectedCategory, debouncedSearch, minAmount, maxAmount]);

  const openCalendar = () => {
    const parsed = parseLocalDateOnly(reportDate) || parseLocalDateOnly(cairoToday);
    if (parsed) {
      setCalendarCursor({ year: parsed.getFullYear(), month: parsed.getMonth() });
    }
    setCalendarVisible(true);
  };

  const shiftCalendarMonth = (delta: number) => {
    setCalendarCursor((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1, 12, 0, 0, 0);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const calendarCells = useMemo(
    () => buildCalendarMonthGrid(calendarCursor.year, calendarCursor.month),
    [calendarCursor],
  );

  const selectGroup = (group: GroupWithSchedules) => {
    setSelectedGroupId(group.id);
    setSelectedCategory("monthly");
    setSearchInput("");
    setDebouncedSearch("");
    setMinAmount("");
    setMaxAmount("");
  };

  const renderCategoryRow = (
    item: MonthlyPaymentStatRow | SessionPaymentStatRow | PartialPaymentStatRow | UnpaidStatRow,
  ) => {
    if (selectedCategory === "monthly") {
      const row = item as MonthlyPaymentStatRow;
      return (
        <View key={row.studentId} style={styles.studentCard}>
          <View style={styles.studentTop}>
            <Text style={styles.studentName} numberOfLines={1}>
              {row.studentName}
            </Text>
            <Text style={[styles.amountBadge, { color: colors.successText }]}>
              {formatCurrency(row.amountPaid)}
            </Text>
          </View>
          <View style={styles.studentMetaRow}>
            <Text style={styles.metaText}>{row.subscriptionLabel}</Text>
            <Text style={styles.metaText}>تاريخ الدفع: {formatLocalDate(row.paymentDate)}</Text>
          </View>
        </View>
      );
    }

    if (selectedCategory === "session") {
      const row = item as SessionPaymentStatRow;
      return (
        <View key={row.studentId} style={styles.studentCard}>
          <View style={styles.studentTop}>
            <Text style={styles.studentName} numberOfLines={1}>
              {row.studentName}
            </Text>
            <Text style={[styles.amountBadge, { color: colors.primary }]}>
              {formatCurrency(row.amountPaid)}
            </Text>
          </View>
          <View style={styles.studentMetaRow}>
            {row.sessionsCount !== null ? (
              <Text style={styles.metaText}>
                عدد الحصص: {toArabicDigits(String(row.sessionsCount))}
              </Text>
            ) : null}
            <Text style={styles.metaText}>تاريخ الدفع: {formatLocalDate(row.paymentDate)}</Text>
          </View>
        </View>
      );
    }

    if (selectedCategory === "partial") {
      const row = item as PartialPaymentStatRow;
      return (
        <View key={row.studentId} style={styles.studentCard}>
          <View style={styles.studentTop}>
            <Text style={styles.studentName} numberOfLines={1}>
              {row.studentName}
            </Text>
            <Text style={[styles.amountBadge, { color: colors.warningText }]}>
              المتبقي: {formatCurrency(row.remainingBalance)}
            </Text>
          </View>
          <View style={styles.studentMetaRow}>
            <Text style={styles.metaText}>المستحق: {formatCurrency(row.originalDue)}</Text>
            <Text style={styles.metaText}>المدفوع: {formatCurrency(row.amountPaid)}</Text>
            {canCollectPayment ? (
              <TouchableOpacity
                style={styles.payRowBtn}
                onPress={() => openPayModal(row)}
              >
                <Ionicons name="wallet-outline" size={14} color={colors.white} />
                <Text style={styles.payRowBtnText}>دفع</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      );
    }

    const row = item as UnpaidStatRow;
    return (
      <View key={row.studentId} style={styles.studentCard}>
        <View style={styles.studentTop}>
          <Text style={styles.studentName} numberOfLines={1}>
            {row.studentName}
          </Text>
          <Text style={[styles.amountBadge, { color: colors.dangerText }]}>
            {formatCurrency(row.remainingBalance)}
          </Text>
        </View>
        <View style={styles.studentMetaRow}>
          <Text style={styles.metaText}>المستحق: {formatCurrency(row.originalDue)}</Text>
          <Text style={styles.metaText}>الحالة: لم يتم السداد</Text>
          {canCollectPayment ? (
            <TouchableOpacity
              style={styles.payRowBtn}
              onPress={() => openPayModal(row)}
            >
              <Ionicons name="wallet-outline" size={14} color={colors.white} />
              <Text style={styles.payRowBtnText}>دفع</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };

  if (!canView) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.emptyCard, { margin: Spacing.lg }]}>
          <Ionicons name="lock-closed-outline" size={28} color={colors.textSecondary} />
          <Text style={styles.emptyTitle}>القسم مقفول</Text>
          <Text style={styles.emptyText}>ليس لديك صلاحية عرض إحصائيات الدفع.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>التقارير المالية</Text>
            <Text style={styles.title}>إحصائيات الدفع</Text>
          </View>
          {selectedGroup ? (
            <TouchableOpacity
              style={styles.switchGroupBtn}
              onPress={() => setSelectedGroupId("")}
            >
              <Ionicons name="swap-horizontal-outline" size={15} color={colors.primary} />
              <Text style={styles.switchGroupText}>تغيير المجموعة</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.headerIcon}>
              <Ionicons name="wallet-outline" size={22} color={colors.primary} />
            </View>
          )}
        </View>

        {!selectedGroup ? (
          <>
            <Text style={styles.sectionTitle}>اختر المجموعة ({groups.length})</Text>
            {groups.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="people-outline" size={28} color={colors.slate400} />
                <Text style={styles.emptyTitle}>لا توجد مجموعات نشطة</Text>
                <Text style={styles.emptyText}>أضف مجموعة نشطة لعرض إحصائيات الدفع.</Text>
              </View>
            ) : (
              <View style={styles.groupsList}>
                {groups.map((group) => {
                  const schedule = formatScheduleSummary(group.schedules);
                  return (
                    <TouchableOpacity
                      key={group.id}
                      style={styles.groupCard}
                      onPress={() => selectGroup(group)}
                    >
                      <View style={styles.groupCardTop}>
                        <Text style={styles.groupName} numberOfLines={1}>
                          {group.name}
                        </Text>
                        {group.subjectName ? (
                          <Text style={styles.subjectPill}>{group.subjectName}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.groupTeacher} numberOfLines={1}>
                        المدرس: {group.teacherName || "—"}
                      </Text>
                      <View style={styles.groupScheduleRow}>
                        <Ionicons name="calendar-outline" size={13} color={colors.primary} />
                        <Text style={styles.groupScheduleText} numberOfLines={1}>
                          {schedule.daysText}
                          {schedule.timeText ? ` · ${schedule.timeText}` : ""}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </>
        ) : (
          <>
            {/* Selected Group + Date Header */}
            {(() => {
              const schedule = formatScheduleSummary(selectedGroup.schedules);
              return (
                <View style={styles.selectedGroupCard}>
                  <View style={styles.selectedGroupTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.selectedGroupName} numberOfLines={1}>
                        {selectedGroup.name}
                        {selectedGroup.subjectName ? ` · ${selectedGroup.subjectName}` : ""}
                      </Text>
                      <Text style={styles.selectedGroupMeta} numberOfLines={1}>
                        {selectedGroup.teacherName || "—"} · {schedule.daysText}
                        {schedule.timeText ? ` (${schedule.timeText})` : ""}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.dateBar}>
                    <View style={styles.dateInfo}>
                      <Ionicons name="calendar-outline" size={16} color={colors.primary} />
                      <Text style={styles.dateLabel}>تاريخ التقرير:</Text>
                      <Text style={styles.dateValue}>{formatLocalDate(reportDate)}</Text>
                    </View>
                    <TouchableOpacity style={styles.calendarButton} onPress={openCalendar}>
                      <Text style={styles.calendarButtonText}>تغيير التاريخ</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })()}

            {/* Horizontal Payment Category Tabs */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryTabsRow}
            >
              {CATEGORIES.map((category) => {
                const isActive = selectedCategory === category.key;
                const count = stats ? stats.counts[category.key] : 0;
                return (
                  <TouchableOpacity
                    key={category.key}
                    style={[styles.categoryTab, isActive && styles.categoryTabActive]}
                    onPress={() => setSelectedCategory(category.key)}
                  >
                    <Ionicons
                      name={category.icon}
                      size={15}
                      color={isActive ? colors.white : colors.primary}
                    />
                    <Text style={[styles.categoryTabLabel, isActive && styles.categoryTabTextActive]}>
                      {category.label}
                    </Text>
                    <View style={[styles.countBadge, isActive && styles.countBadgeActive]}>
                      <Text style={[styles.countText, isActive && styles.countTextActive]}>
                        {toArabicDigits(String(count))}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Search and Amount Range Filters Immediately Above Student List */}
            <View style={styles.filtersContainer}>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={16} color={colors.slate400} />
                <TextInput
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder="ابحث باسم الطالب أو الكود أو الهاتف..."
                  placeholderTextColor={colors.textSecondary}
                  style={styles.searchInput}
                  textAlign="right"
                />
                {searchInput ? (
                  <TouchableOpacity
                    onPress={() => {
                      setSearchInput("");
                      setDebouncedSearch("");
                    }}
                  >
                    <Ionicons name="close-circle" size={16} color={colors.slate400} />
                  </TouchableOpacity>
                ) : null}
              </View>

              <View style={styles.amountFilterRow}>
                <Text style={styles.amountFilterLabel}>المبلغ:</Text>
                <TextInput
                  value={minAmount}
                  onChangeText={setMinAmount}
                  placeholder="من مبلغ"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="decimal-pad"
                  style={styles.amountInput}
                  textAlign="center"
                />
                <Text style={styles.amountDash}>—</Text>
                <TextInput
                  value={maxAmount}
                  onChangeText={setMaxAmount}
                  placeholder="إلى مبلغ"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="decimal-pad"
                  style={styles.amountInput}
                  textAlign="center"
                />
                {minAmount || maxAmount ? (
                  <TouchableOpacity
                    onPress={() => {
                      setMinAmount("");
                      setMaxAmount("");
                    }}
                  >
                    <Text style={styles.clearFilterText}>مسح</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            {/* Selected Category Student List */}
            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.emptyText}>جاري حساب إحصائيات الدفع...</Text>
              </View>
            ) : loadError ? (
              <View style={styles.emptyCard}>
                <Ionicons name="alert-circle-outline" size={28} color={colors.dangerText} />
                <Text accessibilityRole="alert" style={styles.emptyTitle}>
                  تعذر تحميل التقرير
                </Text>
                <Text style={styles.emptyText}>{loadError}</Text>
                <TouchableOpacity onPress={() => setRetryCount((c) => c + 1)}>
                  <Text style={{ color: colors.primary, fontWeight: "800" }}>إعادة المحاولة</Text>
                </TouchableOpacity>
              </View>
            ) : filteredCategoryRows.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="people-outline" size={26} color={colors.slate400} />
                <Text style={styles.emptyTitle}>لا يوجد طلاب في هذه الفئة</Text>
                <Text style={styles.emptyText}>
                  {searchInput || minAmount || maxAmount
                    ? "جرّب تعديل البحث أو نطاق المبلغ."
                    : "لا توجد سجلات مطابقة لهذا التاريخ."}
                </Text>
              </View>
            ) : (
              <View style={styles.studentList}>
                {filteredCategoryRows.map((row) => renderCategoryRow(row))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Arabic Calendar Date Picker Modal */}
      <Modal
        visible={calendarVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCalendarVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.calendarCard}>
            <View style={styles.calendarHeader}>
              <TouchableOpacity
                onPress={() => shiftCalendarMonth(-1)}
                style={styles.calendarNavBtn}
              >
                <Ionicons name="chevron-forward" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
              <Text style={styles.calendarMonthTitle}>
                {formatArabicMonthYear(calendarCursor.year, calendarCursor.month)}
              </Text>
              <TouchableOpacity
                onPress={() => shiftCalendarMonth(1)}
                style={styles.calendarNavBtn}
              >
                <Ionicons name="chevron-back" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.calendarWeekRow}>
              {CALENDAR_WEEKDAYS.map((dayLabel) => (
                <Text key={dayLabel} style={styles.calendarWeekdayText}>
                  {dayLabel}
                </Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {calendarCells.map((dateStr, idx) => {
                if (!dateStr) {
                  return <View key={`empty-${idx}`} style={styles.calendarCell} />;
                }
                const dayNum = Number(dateStr.slice(8, 10));
                const isSelected = dateStr === reportDate;
                const isToday = dateStr === cairoToday;
                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.calendarCell,
                      isToday && styles.calendarCellToday,
                      isSelected && styles.calendarCellSelected,
                    ]}
                    onPress={() => {
                      setReportDate(dateStr);
                      setCalendarVisible(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        isSelected && styles.calendarDayTextSelected,
                      ]}
                    >
                      {toArabicDigits(String(dayNum))}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.calendarActions}>
              <TouchableOpacity
                style={styles.todayShortcutBtn}
                onPress={() => {
                  setReportDate(cairoToday);
                  setCalendarVisible(false);
                }}
              >
                <Text style={styles.todayShortcutText}>اليوم</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.closeModalBtn}
                onPress={() => setCalendarVisible(false)}
              >
                <Text style={styles.closeModalText}>إغلاق</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={Boolean(payTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!paySaving) setPayTarget(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.calendarCard}>
            <Text style={styles.sectionTitle}>تحصيل دفعة: {payTarget?.studentName}</Text>
            <Text style={styles.metaText}>
              المتبقي: {formatCurrency(payTarget?.remainingBalance || 0)}
            </Text>

            {payCycles.length > 1 ? (
              <View style={{ gap: 6 }}>
                <Text style={styles.payFieldLabel}>الدورة المالية</Text>
                <View style={styles.payOptionsRow}>
                  {payCycles.map((cycle) => {
                    const selected = cycle.id === selectedCycleId;
                    return (
                      <TouchableOpacity
                        key={cycle.id}
                        style={[
                          styles.payChip,
                          selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                        ]}
                        onPress={() => {
                          setSelectedCycleId(cycle.id);
                          setPayAmount(String(cycle.remainingDebt));
                        }}
                      >
                        <Text style={[styles.payChipText, selected && { color: colors.white }]}>
                          {cycle.label} ({formatCurrency(cycle.remainingDebt)})
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={{ gap: 4 }}>
              <Text style={styles.payFieldLabel}>المبلغ المدفوع</Text>
              <TextInput
                style={styles.payInput}
                value={payAmount}
                onChangeText={setPayAmount}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.textSecondary}
                textAlign="right"
              />
            </View>

            <View style={{ gap: 6 }}>
              <Text style={styles.payFieldLabel}>طريقة الدفع</Text>
              <View style={styles.payOptionsRow}>
                {[
                  { key: "cash", label: "كاش" },
                  { key: "vodafone_cash", label: "فودافون كاش" },
                  { key: "instapay", label: "إنستاباي" },
                  { key: "card", label: "بطاقة" },
                ].map((method) => {
                  const selected = payMethod === method.key;
                  return (
                    <TouchableOpacity
                      key={method.key}
                      style={[
                        styles.payChip,
                        selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                      ]}
                      onPress={() => setPayMethod(method.key)}
                    >
                      <Text style={[styles.payChipText, selected && { color: colors.white }]}>
                        {method.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={{ gap: 4 }}>
              <Text style={styles.payFieldLabel}>ملاحظات (اختياري)</Text>
              <TextInput
                style={styles.payInput}
                value={payNotes}
                onChangeText={setPayNotes}
                placeholder="ملاحظة اختيارية"
                placeholderTextColor={colors.textSecondary}
                textAlign="right"
              />
            </View>

            {payError ? <Text style={styles.payErrorText}>{payError}</Text> : null}

            <View style={styles.calendarActions}>
              <TouchableOpacity
                style={[styles.todayShortcutBtn, paySaving && { opacity: 0.6 }]}
                onPress={() => void submitPayment()}
                disabled={paySaving}
              >
                <Text style={styles.todayShortcutText}>
                  {paySaving ? "جارٍ الحفظ..." : "تأكيد الدفع"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.closeModalBtn}
                onPress={() => setPayTarget(null)}
                disabled={paySaving}
              >
                <Text style={styles.closeModalText}>إلغاء</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { padding: Spacing.md, paddingBottom: 36, gap: 10 },
    payRowBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.primary,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
    },
    payRowBtnText: { color: colors.white, fontSize: 11, fontWeight: "800" },
    payFieldLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: "800", textAlign: "right" },
    payInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      fontSize: 14,
      fontWeight: "700",
    },
    payOptionsRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
    payChip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.background,
    },
    payChipText: { color: colors.textPrimary, fontSize: 11, fontWeight: "700" },
    payErrorText: { color: colors.dangerText, fontSize: 12, fontWeight: "700", textAlign: "right" },
    header: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
    },
    eyebrow: { color: colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right" },
    title: { ...Typography.h2, color: colors.textPrimary, textAlign: "right", fontSize: 20 },
    headerIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    switchGroupBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.primaryLight,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    switchGroupText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
    sectionTitle: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: "800",
      textAlign: "right",
    },
    groupsList: { gap: 8 },
    groupCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 12,
      gap: 5,
    },
    groupCardTop: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    groupName: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: "800",
      textAlign: "right",
    },
    subjectPill: {
      color: colors.primary,
      backgroundColor: colors.primaryLight,
      fontSize: 11,
      fontWeight: "800",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 7,
    },
    groupTeacher: { color: colors.textSecondary, fontSize: 12, textAlign: "right" },
    groupScheduleRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      marginTop: 2,
    },
    groupScheduleText: { color: colors.primary, fontSize: 12, fontWeight: "700", flex: 1, textAlign: "right" },
    selectedGroupCard: {
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 11,
      gap: 8,
    },
    selectedGroupTop: { flexDirection: "row-reverse", alignItems: "center" },
    selectedGroupName: { color: colors.textPrimary, fontSize: 15, fontWeight: "900", textAlign: "right" },
    selectedGroupMeta: { color: colors.textSecondary, fontSize: 11, textAlign: "right", marginTop: 2 },
    dateBar: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
      gap: 8,
    },
    dateInfo: { flexDirection: "row-reverse", alignItems: "center", gap: 5, flex: 1 },
    dateLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
    dateValue: { color: colors.textPrimary, fontSize: 12, fontWeight: "800" },
    calendarButton: {
      backgroundColor: colors.primaryLight,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    calendarButtonText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
    categoryTabsRow: { flexDirection: "row-reverse", gap: 8, paddingVertical: 2 },
    categoryTab: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.cardBackground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    categoryTabActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    categoryTabLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: "800" },
    categoryTabTextActive: { color: colors.white },
    countBadge: {
      backgroundColor: colors.primaryLight,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      minWidth: 22,
      alignItems: "center",
    },
    countBadgeActive: { backgroundColor: colors.white },
    countText: { color: colors.primary, fontSize: 11, fontWeight: "900" },
    countTextActive: { color: colors.primary },
    filtersContainer: { gap: 6 },
    searchBox: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.cardBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 11,
      minHeight: 40,
      paddingHorizontal: 10,
    },
    searchInput: { flex: 1, color: colors.textPrimary, fontSize: 13, paddingVertical: 6 },
    amountFilterRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.cardBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 11,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    amountFilterLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
    amountInput: {
      flex: 1,
      height: 32,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      color: colors.textPrimary,
      fontSize: 12,
      paddingVertical: 2,
    },
    amountDash: { color: colors.textSecondary, fontSize: 12 },
    clearFilterText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
    studentList: { gap: 8 },
    studentCard: {
      backgroundColor: colors.cardBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 11,
      gap: 6,
    },
    studentTop: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    studentName: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: "800",
      textAlign: "right",
    },
    amountBadge: { fontSize: 13, fontWeight: "900" },
    studentMetaRow: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 6,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 6,
    },
    metaText: { color: colors.textSecondary, fontSize: 11, fontWeight: "600" },
    emptyCard: {
      alignItems: "center",
      backgroundColor: colors.cardBackground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 22,
      gap: 6,
    },
    emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "800", textAlign: "center" },
    emptyText: { color: colors.textSecondary, fontSize: 12, textAlign: "center" },
    loading: { alignItems: "center", padding: 20, gap: 8 },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.45)",
      justifyContent: "center",
      padding: 20,
    },
    calendarCard: {
      backgroundColor: colors.cardBackground,
      borderRadius: 16,
      padding: 14,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    calendarHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    calendarNavBtn: {
      width: 34,
      height: 34,
      borderRadius: 9,
      backgroundColor: colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    calendarMonthTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "900" },
    calendarWeekRow: { flexDirection: "row-reverse" },
    calendarWeekdayText: {
      flex: 1,
      textAlign: "center",
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "800",
    },
    calendarGrid: { flexDirection: "row-reverse", flexWrap: "wrap" },
    calendarCell: {
      width: "14.2857%",
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 9,
    },
    calendarCellToday: {
      borderWidth: 1,
      borderColor: colors.primary,
    },
    calendarCellSelected: {
      backgroundColor: colors.primary,
    },
    calendarDayText: { color: colors.textPrimary, fontSize: 13, fontWeight: "700" },
    calendarDayTextSelected: { color: colors.white, fontWeight: "900" },
    calendarActions: {
      flexDirection: "row-reverse",
      justifyContent: "space-between",
      gap: 8,
      marginTop: 4,
    },
    todayShortcutBtn: {
      backgroundColor: colors.primaryLight,
      borderRadius: 9,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    todayShortcutText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
    closeModalBtn: {
      backgroundColor: colors.background,
      borderRadius: 9,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    closeModalText: { color: colors.textPrimary, fontSize: 12, fontWeight: "800" },
  });
