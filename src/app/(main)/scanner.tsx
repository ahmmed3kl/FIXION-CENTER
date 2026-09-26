import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
    Alert,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getUserErrorMessage } from "../../core/errors";
import {
    Strings,
    formatCurrency,
    formatTimeArabic,
} from "../../core/localization";
import {
    BorderRadius,
    Colors,
    Shadows,
    Spacing,
    Typography,
    useTheme,
} from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { AttendanceRepository } from "../../features/attendance/AttendanceRepository";
import { AttendanceSessionService, AttendanceSummary } from "../../features/attendance/AttendanceSessionService";
import { MakeupService } from "../../features/attendance/MakeupService";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import { SessionRepository } from "../../features/sessions/SessionRepository";
import { ScannerService } from "../../features/scanner/ScannerService";
import { StudentRepository } from "../../features/students/StudentRepository";
import { getLocalDateOnly } from "../../shared/utils/date";
import {
    AppButton,
    AppCard,
    AppInput,
    StatusBadge,
} from "../../shared/components";
import {
    Attendance,
    DetailedStudentFinancialStatus,
    Group,
    Session,
    Student,
    StudentGroupAttendanceSummary,
} from "../../shared/types";

const DAYS_OF_WEEK = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

export default function ScannerScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const services = useServiceVisibility();
  if (!services.loaded) return <View style={styles.centered}><Text style={styles.loadingText}>جار تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("attendance")) return <View style={styles.centered}><Text style={styles.loadingText}>خدمة الحضور غير مفعلة لهذا المركز.</Text></View>;
  return <ScannerContent />;
}

function ScannerContent() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const services = useServiceVisibility();
  const paymentsEnabled = services.isEnabled("payments");
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraInstanceKey, setCameraInstanceKey] = useState(0);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [manualCode, setManualCode] = useState("00125");
  const [isProcessing, setIsProcessing] = useState(false);

  // Flow State
  const [student, setStudent] = useState<Student | null>(null);
  const [eligibleSessions, setEligibleSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [isAlreadyAttended, setIsAlreadyAttended] = useState(false);
  const [attendanceResult, setAttendanceResult] = useState<Attendance | null>(
    null,
  );
  const [financialStatus, setFinancialStatus] =
    useState<DetailedStudentFinancialStatus | null>(null);
  const [groupAttendanceSummary, setGroupAttendanceSummary] =
    useState<StudentGroupAttendanceSummary | null>(null);
  const [currentGroupLabel, setCurrentGroupLabel] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [todayGroups, setTodayGroups] = useState<Group[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [activeSessionsByGroup, setActiveSessionsByGroup] = useState<Record<string, Session>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [attendanceStarted, setAttendanceStarted] = useState(false);
  const [attendanceSummary, setAttendanceSummary] = useState<AttendanceSummary | null>(null);
  const [makeupNotice, setMakeupNotice] = useState<{ sourceGroupName?: string; teacherName?: string; originalAbsenceId?: string } | null>(null);

  // Quick Payment Modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);

  const isScanningBlockedRef = useRef(false);
  const lastScannedRef = useRef<{ code: string; at: number } | null>(null);

  const refreshTodayData = useCallback(() => {
    try {
      setTodayGroups(AttendanceSessionService.getTodayGroups());
      const sessions = AttendanceSessionService.getTodaySessions();
      setActiveSessionsByGroup(Object.fromEntries(sessions.filter((session) => session.status === "open" || session.status === "scheduled").map((session) => [`${session.groupId}:${session.scheduleId}`, session])));
      setAllGroups(GroupRepository.getAll());
    } catch (error) { setSearchError(getUserErrorMessage(error)); }
  }, []);

  // Refresh when the screen becomes active. The old one-time mount load kept
  // Friday's groups visible after midnight, while Saturday's schedules were
  // never loaded until the app was fully restarted.
  useFocusEffect(useCallback(() => {
    refreshTodayData();
    const timer = setInterval(refreshTodayData, 60_000);
    return () => clearInterval(timer);
  }, [refreshTodayData]));

  const startAttendance = () => {
    const selectedGroup = (showAllGroups ? allGroups : todayGroups).find((group) => group.id === selectedGroupId);
    if (!selectedGroup) return;
    try {
      const sessionKey = `${selectedGroup.id}:${selectedScheduleId || ""}`;
      const session = activeSessionsByGroup[sessionKey] || AttendanceSessionService.ensureSessionForGroup(selectedGroup.id, undefined, selectedScheduleId || undefined);
      setActiveSessionsByGroup((current) => ({ ...current, [sessionKey]: session }));
      setActiveSessionId(session.id);
      AttendanceSessionService.activate(session.id);
      setAttendanceStarted(true);
      setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
    } catch (error) { setSearchError(getUserErrorMessage(error)); }
  };

  // Reset student search
  const handleReset = () => {
    setStudent(null);
    setEligibleSessions([]);
    setSelectedSessionId(null);
    setIsAlreadyAttended(false);
    setAttendanceResult(null);
    setFinancialStatus(null);
    setGroupAttendanceSummary(null);
    setCurrentGroupLabel("");
    setMakeupNotice(null);
    setSearchError(null);
    isScanningBlockedRef.current = false;
    lastScannedRef.current = null;
  };

  const handleBackToGroups = () => {
    setAttendanceStarted(false);
    setActiveSessionId(null);
    setSelectedGroupId(null);
    setSelectedScheduleId(null);
    setAttendanceSummary(null);
    handleReset();
  };

  const lookupCard = (rawCode: string) => {
    if (!attendanceStarted || !activeSessionId) { setSearchError("اختر المجموعة وابدأ جلسة الحضور أولاً."); return; }
    const normalized = ScannerService.normalizeCardCode(rawCode);
    if (!normalized) {
      setSearchError("يرجى إدخال كود الكارت");
      return;
    }

    setSearchError(null);
    setIsProcessing(true);

    try {
      const foundStudent = StudentRepository.findByCardCode(normalized);

      if (!foundStudent) {
        setStudent(null);
        setSearchError(`${Strings.unregisteredCardError} (${normalized})`);
        setIsProcessing(false);
        return;
      }

      setStudent(foundStudent);
      const currentSession = SessionRepository.findById(activeSessionId);
      const currentGroupId = currentSession?.groupId;
      setCurrentGroupLabel(
        [currentSession?.groupName, currentSession?.subjectName, currentSession?.teacherName]
          .filter(Boolean)
          .join(" • "),
      );
      if (currentGroupId) {
        setGroupAttendanceSummary(
          AttendanceRepository.getStudentGroupAttendanceSummaries(foundStudent.id)
            .find((summary) => summary.groupId === currentGroupId) || null,
        );
      } else {
        setGroupAttendanceSummary(null);
      }

      const expected = AttendanceSessionService.isExpected(activeSessionId, foundStudent.id);
      const makeupEligibility = expected ? { eligible: false } : AttendanceSessionService.getMakeupEligibility(activeSessionId, foundStudent.id);
      if (!expected && !makeupEligibility.eligible) {
        setStudent(null);
        setSearchError("الطالب غير متوقع في مجموعة الحضور الحالية.");
        setIsProcessing(false);
        return;
      }

      if (makeupEligibility.eligible) {
        setMakeupNotice({ sourceGroupName: makeupEligibility.sourceGroupName, teacherName: makeupEligibility.teacherName, originalAbsenceId: makeupEligibility.originalAbsenceId });
        Alert.alert("حضور تعويضي", `الطالب مسجل مع نفس المدرس في مجموعة ${makeupEligibility.sourceGroupName || "أخرى"}. سيتم تسجيل حضوره تعويضياً في المجموعة الحالية.`);
      } else {
        setMakeupNotice(null);
      }

      // Load eligible sessions; a same-teacher makeup uses the current session.
      const sessions = (expected ? ScannerService.getEligibleSessionsForStudent(foundStudent.id) : [SessionRepository.findById(activeSessionId)].filter(Boolean) as Session[]).filter((session) => session.id === activeSessionId);
      setEligibleSessions(sessions);

      if (sessions.length === 1) {
        setSelectedSessionId(sessions[0].id);
        const attended = AttendanceRepository.isAlreadyAttended(
          sessions[0].id,
          foundStudent.id,
        );
        setIsAlreadyAttended(attended);
      } else if (sessions.length > 1) {
        setSelectedSessionId(null);
        setIsAlreadyAttended(false);
      }

      // Load financial status calculated dynamically
      if (paymentsEnabled && currentGroupId) {
        const fin = PaymentRepository.getStudentFinancialStatusForGroup(foundStudent.id, currentGroupId);
        setFinancialStatus(fin);
      } else {
        setFinancialStatus(null);
      }
    } catch (err) {
      setSearchError(getUserErrorMessage(err));
    } finally {
      setIsProcessing(false);
      isScanningBlockedRef.current = false;
    }
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (isScanningBlockedRef.current || isProcessing) return;
    const normalized = ScannerService.normalizeCardCode(data);
    const now = Date.now();
    if (lastScannedRef.current && lastScannedRef.current.code === normalized && now - lastScannedRef.current.at < 1200) return;
    lastScannedRef.current = { code: normalized, at: now };
    isScanningBlockedRef.current = true;
    setIsTorchOn(false);
    setIsCameraActive(false);
    setManualCode(data);
    lookupCard(data);
  };

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    if (student) {
      const attended = AttendanceRepository.isAlreadyAttended(
        sessionId,
        student.id,
      );
      setIsAlreadyAttended(attended);
    }
  };

  const handleRecordAttendance = async () => {
    if (!student || !selectedSessionId) return;

    const session = eligibleSessions.find((s) => s.id === selectedSessionId);
    if (!session) return;

    setIsProcessing(true);

    try {
      // Late status is anchored to the scheduled session start, never to the
      // moment the operator opened/activated the session.  The grace period
      // is a snapshot on the session so changing a group's settings later
      // cannot rewrite historical attendance.
      const lateCalc = ScannerService.calculateLateStatus(
        session.startTime,
        undefined,
        session.lateAfterMinutes ?? 15,
      );

      const result = makeupNotice
        ? await MakeupService.recordMakeupAttendance({
            studentId: student.id,
            sessionId: session.id,
            originalAbsenceId: makeupNotice.originalAbsenceId!,
            isLate: lateCalc.isLate,
          })
        : await AttendanceRepository.recordAttendance({
            studentId: student.id,
            sessionId: session.id,
            status: lateCalc.status,
            isLate: lateCalc.isLate,
            attendanceType: "present",
          });

      setAttendanceResult(result);
      setIsAlreadyAttended(true);
      setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
      setGroupAttendanceSummary(
        AttendanceRepository.getStudentGroupAttendanceSummaries(student.id)
          .find((summary) => summary.groupId === session.groupId) || null,
      );
    } catch (err: any) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmQuickPayment = async () => {
    if (!student) return;
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert(Strings.errorTitle, "يرجى إدخال مبلغ صحيح.");
      return;
    }

    setIsRecordingPayment(true);
    try {
      await PaymentRepository.recordPayment({
        studentId: student.id,
        // Keep quick payments tied to the attendance session. Without this
        // link they appear in daily cash but cannot be attributed to a
        // teacher/group settlement.
        sessionId: activeSessionId || selectedSessionId || undefined,
        amount,
        paymentType: "partial",
        debtCycleId: financialStatus?.cycles.find((cycle) => (cycle.remainingDebt ?? 0) > 0)?.id,
      });

      // Recalculate financial status dynamically
      const currentGroupId = activeSessionId
        ? SessionRepository.findById(activeSessionId)?.groupId
        : undefined;
      const updated = currentGroupId
        ? PaymentRepository.getStudentFinancialStatusForGroup(student.id, currentGroupId)
        : PaymentRepository.getStudentFinancialStatus(student.id);
      setFinancialStatus(updated);
      setShowPaymentModal(false);
      setPaymentAmount("");
      Alert.alert("نجاح", Strings.paymentRecordedSuccess);
    } catch (err) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(err));
    } finally {
      setIsRecordingPayment(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top Header */}
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>{Strings.scanCardTitle}</Text>
        {attendanceStarted ? (
          <TouchableOpacity onPress={handleBackToGroups} style={styles.resetButton}>
            <Ionicons name="arrow-forward" size={20} color={Colors.primary} />
            <Text style={styles.resetButtonText}>الرجوع للمجموعات</Text>
          </TouchableOpacity>
        ) : student ? (
          <TouchableOpacity onPress={handleReset} style={styles.resetButton}>
            <Ionicons name="refresh" size={20} color={Colors.primary} />
            <Text style={styles.resetButtonText}>مسح جديد</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {!attendanceStarted ? (
          <View style={styles.startAttendancePanel}>
            <Text style={styles.startTitle}>مجموعات اليوم</Text>
            <View style={styles.attendanceFilterRow}>
              <TouchableOpacity style={[styles.attendanceFilter, !showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(false)}><Text style={[styles.attendanceFilterText, !showAllGroups && styles.attendanceFilterTextActive]}>مجموعات اليوم</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.attendanceFilter, showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(true)}><Text style={[styles.attendanceFilterText, showAllGroups && styles.attendanceFilterTextActive]}>كل المجموعات</Text></TouchableOpacity>
            </View>
            <Text style={styles.startSubtitle}>اضغط على المجموعة لبدء أو فتح جلسة الحضور.</Text>
            {(showAllGroups ? allGroups : todayGroups).length === 0 ? (
              <Text style={styles.emptySessionText}>لا توجد جلسات مجدولة اليوم.</Text>
            ) : (showAllGroups ? allGroups : todayGroups).flatMap((group) => {
              const today = getLocalDateOnly();
              const todayDayOfWeek = new Date(`${today}T12:00:00`).getDay();
              const schedules = GroupScheduleRepository.getSchedulesForGroup(group.id).filter((item) => item.dayOfWeek === todayDayOfWeek);
              return schedules.map((schedule) => {
              const key = `${group.id}:${schedule.id}`;
              const activeSession = activeSessionsByGroup[key];
              const isSelected = selectedGroupId === group.id && selectedScheduleId === schedule.id;
              return <TouchableOpacity key={key} onPress={() => { setSelectedGroupId(group.id); setSelectedScheduleId(schedule.id); setActiveSessionId(null); }}>
                <AppCard style={[styles.sessionCard, isSelected ? styles.sessionCardSelected : null]}>
                  <Text style={styles.sessionSubject}>{group.name}</Text>
                  <Text style={styles.sessionTime}>{group.subjectName || ""} • {group.teacherName || ""}</Text>
                  <Text style={styles.sessionSchedule}>
                    {DAYS_OF_WEEK[schedule.dayOfWeek] || "اليوم"} • {formatTimeArabic(schedule.startTime)} - {formatTimeArabic(schedule.endTime)}
                  </Text>
                  <Text style={[styles.groupAttendanceState, activeSession && styles.groupAttendanceStateActive]}>{activeSession ? "● نشطة" : "● غير نشطة"}</Text>
                </AppCard>
              </TouchableOpacity>;
              });
            })}
            <AppButton title="بدء جلسة الحضور" onPress={startAttendance} disabled={!selectedGroupId} size="lg" />
            {searchError ? <Text style={styles.errorAlertText}>{searchError}</Text> : null}
          </View>
        ) : null}
        {attendanceStarted && attendanceSummary ? (
          <View style={styles.attendanceCounterBar}>
            <Text style={styles.counterTitle}>حضور الجلسة</Text>
            <Text style={styles.counterItem}>الكل: {attendanceSummary.total}</Text>
            <Text style={[styles.counterItem, { color: Colors.successText }]}>حاضر: {attendanceSummary.present}</Text>
            <Text style={[styles.counterItem, { color: Colors.dangerText }]}>غائب: {attendanceSummary.absent}</Text>
          </View>
        ) : null}
        {/* CAMERA OR MANUAL SCANNER CARD */}
        {attendanceStarted && !student ? (
          <AppCard style={styles.scannerCard}>
            {isCameraActive ? (
              <View style={styles.cameraContainer}>
                {permission?.granted ? (
                  <View style={styles.cameraFrameWrap}>
                  <CameraView
                    key={`attendance-camera-${cameraInstanceKey}`}
                    style={styles.camera}
                    autofocus="on"
                    zoom={0.2}
                    enableTorch={isTorchOn}
                    barcodeScannerSettings={{
                      barcodeTypes: ["qr", "code128", "ean13", "upc_a"],
                    }}
                    onBarcodeScanned={handleBarcodeScanned}
                  />
                  <View pointerEvents="none" style={styles.scanGuide}><View style={styles.scanGuideCorner} /><Text style={styles.scanGuideText}>قرّب الكارت داخل الإطار</Text></View>
                  </View>
                ) : (
                  <View style={styles.permissionBox}>
                    <Text style={styles.permissionText}>
                      {Strings.cameraPermissionRequired}
                    </Text>
                    <AppButton
                      title={Strings.grantPermissionButton}
                      onPress={requestPermission}
                      size="sm"
                    />
                  </View>
                )}
                <View style={styles.cameraControls}>
                  <AppButton
                    title={isTorchOn ? "Ø¥ØºÙ„Ø§Ù‚ Ø§Ù„ÙÙ„Ø§Ø´" : "ØªØ´ØºÙŠÙ„ Ø§Ù„ÙÙ„Ø§Ø´"}
                    variant="outline"
                    size="sm"
                    onPress={() => setIsTorchOn((current) => !current)}
                    style={{ flex: 1 }}
                  />
                <AppButton
                  title="إغلاق الكاميرا"
                  variant="outline"
                  size="sm"
                  onPress={() => { setIsTorchOn(false); setIsCameraActive(false); }}
                  style={{ flex: 1 }}
                />
                </View>
              </View>
            ) : (
              <View style={styles.cameraPlaceholder}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => { isScanningBlockedRef.current = false; lastScannedRef.current = null; setCameraInstanceKey((value) => value + 1); setIsCameraActive(true); }}
                  style={styles.cameraLaunchButton}
                >
                  <Ionicons
                    name="camera-outline"
                    size={40}
                    color={Colors.primary}
                  />
                  <Text style={styles.cameraLaunchText}>
                    {Strings.scanCameraHint}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* MANUAL ENTRY FALLBACK */}
            <View style={styles.manualEntryDivider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{Strings.manualEntryTitle}</Text>
              <View style={styles.dividerLine} />
            </View>

            <View style={styles.manualInputRow}>
              <View style={{ flex: 1 }}>
                <AppInput
                  placeholder={Strings.cardCodePlaceholder}
                  value={manualCode}
                  onChangeText={setManualCode}
                  containerStyle={{ marginBottom: 0 }}
                />
              </View>
              <AppButton
                title={Strings.searchCardButton}
                onPress={() => lookupCard(manualCode)}
                loading={isProcessing}
                style={styles.manualSearchButton}
              />
            </View>

            {searchError ? (
              <View style={styles.errorAlert}>
                <Ionicons
                  name="alert-circle"
                  size={20}
                  color={Colors.dangerText}
                />
                <Text style={styles.errorAlertText}>{searchError}</Text>
              </View>
            ) : null}
          </AppCard>
        ) : null}

        {/* STEP 1: STUDENT PROFILE RESULT */}
        {student ? (
          <AppCard style={styles.resultCard}>
            {makeupNotice && (
              <View style={styles.makeupNotice}>
                <Ionicons name="swap-horizontal" size={20} color={Colors.warningText} />
                <Text style={styles.makeupNoticeText}>هذا الطالب مسجل مع نفس المدرس في مجموعة {makeupNotice.sourceGroupName || "أخرى"}، وسيتم تسجيل حضوره تعويضياً في المجموعة الحالية.</Text>
              </View>
            )}
            <View style={styles.studentHeader}>
              <View style={styles.studentAvatar}>
                <Ionicons name="person" size={28} color={Colors.primary} />
              </View>
              <View style={styles.studentDetails}>
                <Text style={styles.studentName}>{student.fullName}</Text>
                <Text style={styles.studentSub}>
                  {Strings.cardCodePrefix} {student.cardCode} • {student.grade}
                </Text>
              </View>
              <StatusBadge
                text={
                  student.status === "active"
                    ? Strings.studentStatusActive
                    : Strings.studentStatusInactive
                }
                type={student.status === "active" ? "success" : "neutral"}
              />
            </View>
            <View style={styles.groupProfileCard}>
              <View style={styles.groupProfileHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.groupProfileTitle}>ملف الطالب في المجموعة الحالية</Text>
                  <Text style={styles.groupProfileMeta}>{currentGroupLabel || "المجموعة الحالية"}</Text>
                </View>
                <Ionicons name="people-outline" size={20} color={Colors.primary} />
              </View>
              <View style={styles.groupProfileMetrics}>
                <View style={styles.groupProfileMetric}><Text style={styles.groupProfileMetricValue}>{groupAttendanceSummary?.expectedSessions ?? 0}</Text><Text style={styles.groupProfileMetricLabel}>حصص</Text></View>
                <View style={styles.groupProfileMetric}><Text style={[styles.groupProfileMetricValue, { color: Colors.successText }]}>{groupAttendanceSummary?.presentCount ?? 0}</Text><Text style={styles.groupProfileMetricLabel}>حضور</Text></View>
                <View style={styles.groupProfileMetric}><Text style={[styles.groupProfileMetricValue, { color: Colors.dangerText }]}>{groupAttendanceSummary?.absentCount ?? 0}</Text><Text style={styles.groupProfileMetricLabel}>غياب</Text></View>
                <View style={styles.groupProfileMetric}><Text style={[styles.groupProfileMetricValue, { color: Colors.warningText }]}>{groupAttendanceSummary?.makeupCount ?? 0}</Text><Text style={styles.groupProfileMetricLabel}>تعويض</Text></View>
              </View>
            </View>
          </AppCard>
        ) : null}

        {/* STEP 2: ELIGIBLE SESSIONS */}
        {student ? (
          <View style={styles.sectionContainer}>
            <Text style={styles.sectionTitle}>
              {Strings.eligibleSessionsTitle}
            </Text>

            {eligibleSessions.length === 0 ? (
              <AppCard style={styles.emptySessionCard}>
                <Ionicons
                  name="calendar-outline"
                  size={24}
                  color={Colors.slate400}
                />
                <Text style={styles.emptySessionText}>
                  {Strings.noSessionsToday}
                </Text>
              </AppCard>
            ) : (
              eligibleSessions.map((session) => {
                const isSelected = session.id === selectedSessionId;
                return (
                  <TouchableOpacity
                    key={session.id}
                    activeOpacity={0.8}
                    onPress={() => handleSelectSession(session.id)}
                  >
                    <AppCard
                      style={[
                        styles.sessionCard,
                        isSelected ? styles.sessionCardSelected : null,
                      ]}
                    >
                      <View style={styles.sessionHeaderRow}>
                        <Text style={styles.sessionSubject}>
                          {session.subjectName || session.groupName}
                        </Text>
                        <Text style={styles.sessionTime}>
                          {formatTimeArabic(session.startTime)} -{" "}
                          {formatTimeArabic(session.endTime)}
                        </Text>
                      </View>
                      <Text style={styles.sessionTeacher}>
                        {session.teacherName}
                      </Text>

                      {isSelected ? (
                        <View style={styles.selectedBadge}>
                          <Ionicons
                            name="checkmark-circle"
                            size={16}
                            color={Colors.primary}
                          />
                          <Text style={styles.selectedBadgeText}>
                            {eligibleSessions.length === 1
                              ? Strings.singleSessionAutoSelected
                              : "تم اختيار هذه الحصة"}
                          </Text>
                        </View>
                      ) : null}
                    </AppCard>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        ) : null}

        {/* STEP 3: ATTENDANCE ACTION & RESULT */}
        {student && selectedSessionId ? (
          <View style={styles.attendanceActionBox}>
            {isAlreadyAttended ? (
              <View style={styles.duplicateWarning}>
                <Ionicons
                  name="alert-circle"
                  size={22}
                  color={Colors.warningText}
                />
                <Text style={styles.duplicateWarningText}>
                  {Strings.duplicateScanWarning}
                </Text>
              </View>
            ) : (
              <AppButton
                title={
                  isProcessing
                    ? Strings.recordingAttendance
                    : Strings.recordAttendanceButton
                }
                onPress={handleRecordAttendance}
                loading={isProcessing}
                size="lg"
                variant="success"
              />
            )}

            {attendanceResult ? (
              <View style={styles.attendanceSuccessCard}>
                <Ionicons
                  name="checkmark-circle"
                  size={26}
                  color={Colors.success}
                />
                <View style={{ flex: 1, marginRight: Spacing.sm }}>
                  <Text style={styles.attendanceSuccessTitle}>
                    {Strings.attendanceRecordedSuccess}
                  </Text>
                  <Text style={styles.attendanceSuccessSub}>
                    {Strings.attendanceTimePrefix}{" "}
                    {attendanceResult.checkInTime}
                  </Text>
                </View>
                <StatusBadge
                  text={
                    attendanceResult.isLate
                      ? Strings.attendanceStatusLate
                      : Strings.attendanceStatusPresent
                  }
                  type={attendanceResult.isLate ? "warning" : "success"}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {/* STEP 4: FINANCIAL STATUS & QUICK PAYMENT */}
        {paymentsEnabled && student && financialStatus ? (
          <View style={styles.sectionContainer}>
            <Text style={styles.sectionTitle}>
              مديونية المجموعة الحالية
            </Text>
            <AppCard style={styles.financialCard}>
              {financialStatus.subscriptions.length > 0 ? (
                <Text style={styles.packageNameText}>
                  {financialStatus.subscriptions[0].packageName}
                </Text>
              ) : null}

              <View style={styles.financialBreakdown}>
                <View style={styles.financialItem}>
                  <Text style={styles.financialItemLabel}>
                    {Strings.totalDueLabel}
                  </Text>
                  <Text style={styles.financialItemVal}>
                    {formatCurrency(financialStatus.totalDue)}
                  </Text>
                </View>

                <View style={styles.financialItem}>
                  <Text style={styles.financialItemLabel}>
                    {Strings.totalPaidLabel}
                  </Text>
                  <Text
                    style={[
                      styles.financialItemVal,
                      { color: Colors.successText },
                    ]}
                  >
                    {formatCurrency(financialStatus.totalPaid)}
                  </Text>
                </View>

                <View style={styles.financialItem}>
                  <Text style={styles.financialItemLabel}>
                    {Strings.remainingBalanceLabel}
                  </Text>
                  <Text
                    style={[
                      styles.financialItemVal,
                      {
                        color:
                          financialStatus.remainingBalance > 0
                            ? Colors.dangerText
                            : Colors.successText,
                      },
                    ]}
                  >
                    {formatCurrency(financialStatus.remainingBalance)}
                  </Text>
                </View>
              </View>

              {financialStatus.remainingBalance > 0 ? (
                <AppButton
                  title={Strings.quickPaymentTitle}
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    setPaymentAmount(String(financialStatus.remainingBalance));
                    setShowPaymentModal(true);
                  }}
                  style={{ marginTop: Spacing.md }}
                />
              ) : (
                <View style={styles.clearedDebtBox}>
                  <Ionicons
                    name="checkmark-done-circle"
                    size={18}
                    color={Colors.success}
                  />
                  <Text style={styles.clearedDebtText}>
                    {Strings.noPendingDebt}
                  </Text>
                </View>
              )}
            </AppCard>
          </View>
        ) : null}
      </ScrollView>

      {/* QUICK PAYMENT MODAL */}
      <Modal visible={showPaymentModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{Strings.quickPaymentTitle}</Text>
            <Text style={styles.modalSub}>{student?.fullName}</Text>

            <AppInput
              label={Strings.paymentAmountLabel}
              keyboardType="numeric"
              value={paymentAmount}
              onChangeText={setPaymentAmount}
            />

            <View style={styles.modalButtonRow}>
              <AppButton
                title={Strings.confirmPaymentButton}
                onPress={handleConfirmQuickPayment}
                loading={isRecordingPayment}
                variant="success"
                style={{ flex: 1 }}
              />
              <AppButton
                title={Strings.cancelButton}
                variant="outline"
                onPress={() => setShowPaymentModal(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = () => StyleSheet.create({
  startAttendancePanel: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.lg, marginBottom: Spacing.lg, ...Shadows.card },
  startTitle: { ...Typography.h2, color: Colors.slate900, marginBottom: 4 },
  startSubtitle: { ...Typography.caption, color: Colors.slate500, textAlign: "right", marginBottom: Spacing.md },
  attendanceFilterRow: { flexDirection: "row", gap: Spacing.sm, marginBottom: Spacing.md },
  attendanceFilter: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.slate200, backgroundColor: Colors.white },
  attendanceFilterActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  attendanceFilterText: { fontSize: 12, fontWeight: "700", color: Colors.slate600 },
  attendanceFilterTextActive: { color: Colors.white },
  attendanceCounterBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: Colors.white, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.md, ...Shadows.card },
  counterTitle: { fontSize: 13, fontWeight: "800", color: Colors.slate800 },
  counterItem: { fontSize: 12, fontWeight: "700", color: Colors.primaryDark },
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  headerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    backgroundColor: Colors.cardBackground,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    shadowColor: Colors.slate900,
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  headerTitle: {
    ...Typography.h3,
    color: Colors.slate900,
  },
  resetButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  resetButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.primary,
  },
  scrollContent: {
    padding: Spacing.lg,
  },
  scannerCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  cameraContainer: {
    alignItems: "center",
  },
  cameraFrameWrap: {
    width: "100%",
    height: 240,
    borderRadius: BorderRadius.md,
    overflow: "hidden",
    position: "relative",
    backgroundColor: Colors.slate900,
  },
  camera: {
    width: "100%",
    height: 240,
  },
  cameraControls: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  scanGuide: {
    position: "absolute",
    left: "10%",
    right: "10%",
    top: "28%",
    height: "44%",
    borderWidth: 2,
    borderColor: Colors.white,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 8,
  },
  scanGuideCorner: {
    ...StyleSheet.absoluteFill,
    borderWidth: 3,
    borderColor: Colors.primary,
    borderRadius: 12,
    opacity: 0.85,
  },
  scanGuideText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  permissionBox: {
    height: 180,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionText: {
    ...Typography.body,
    color: Colors.slate600,
    marginBottom: Spacing.md,
  },
  cameraPlaceholder: {
    alignItems: "center",
    paddingVertical: Spacing.xl,
    backgroundColor: Colors.slate50,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    borderColor: Colors.slate200,
    borderStyle: "dashed",
  },
  cameraLaunchButton: {
    alignItems: "center",
  },
  cameraLaunchText: {
    ...Typography.bodyBold,
    color: Colors.primary,
    marginTop: Spacing.sm,
  },
  manualEntryDivider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: Spacing.lg,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
  },
  dividerText: {
    ...Typography.caption,
    color: Colors.slate500,
    paddingHorizontal: Spacing.sm,
  },
  manualInputRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    alignItems: "center",
  },
  manualSearchButton: {
    height: 48,
  },
  errorAlert: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.dangerLight,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    marginTop: Spacing.md,
    gap: Spacing.xs,
  },
  errorAlertText: {
    ...Typography.captionBold,
    color: Colors.dangerText,
    flex: 1,
    textAlign: "right",
  },
  resultCard: {
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  groupProfileCard: {
    backgroundColor: Colors.slate50,
    borderRadius: BorderRadius.xl,
    padding: Spacing.sm,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  groupProfileHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  groupProfileTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.slate900,
    textAlign: "right",
  },
  groupProfileMeta: {
    fontSize: 11,
    color: Colors.slate500,
    marginTop: 2,
    textAlign: "right",
  },
  groupProfileMetrics: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing.sm,
  },
  groupProfileMetric: {
    alignItems: "center",
    minWidth: 52,
  },
  groupProfileMetricValue: {
    fontSize: 17,
    fontWeight: "800",
    color: Colors.slate800,
  },
  groupProfileMetricLabel: {
    fontSize: 10,
    color: Colors.slate500,
    marginTop: 2,
  },
  makeupNotice: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  makeupNoticeText: {
    flex: 1,
    color: Colors.warningText,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right",
  },
  studentHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  studentAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: Spacing.md,
  },
  studentDetails: {
    flex: 1,
  },
  studentName: {
    ...Typography.bodyBold,
    color: Colors.slate900,
  },
  studentSub: {
    ...Typography.caption,
    color: Colors.slate500,
    marginTop: 2,
  },
  sectionContainer: {
    marginTop: Spacing.md,
  },
  sectionTitle: {
    ...Typography.bodyBold,
    color: Colors.slate800,
    marginBottom: Spacing.sm,
  },
  emptySessionCard: {
    alignItems: "center",
    padding: Spacing.lg,
  },
  emptySessionText: {
    ...Typography.body,
    color: Colors.slate500,
    marginTop: Spacing.xs,
  },
  sessionCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.sm,
    borderRadius: BorderRadius.xl,
  },
  sessionCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: Colors.primaryMuted,
  },
  sessionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sessionSubject: {
    ...Typography.bodyBold,
    color: Colors.slate900,
  },
  sessionTime: {
    ...Typography.captionBold,
    color: Colors.primary,
  },
  sessionSchedule: {
    ...Typography.caption,
    color: Colors.slate600,
    marginTop: 3,
  },
  groupAttendanceState: { fontSize: 12, fontWeight: "800", color: Colors.slate500, marginTop: Spacing.sm },
  groupAttendanceStateActive: { color: Colors.successText },
  sessionTeacher: {
    ...Typography.caption,
    color: Colors.slate600,
    marginTop: 4,
  },
  selectedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing.sm,
  },
  selectedBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.primaryDark,
  },
  attendanceActionBox: {
    marginTop: Spacing.lg,
  },
  duplicateWarning: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.warningLight,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    gap: Spacing.xs,
  },
  duplicateWarningText: {
    ...Typography.bodyBold,
    color: Colors.warningText,
    flex: 1,
    textAlign: "right",
  },
  attendanceSuccessCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.successLight,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    marginTop: Spacing.md,
  },
  attendanceSuccessTitle: {
    ...Typography.bodyBold,
    color: Colors.successText,
  },
  attendanceSuccessSub: {
    ...Typography.caption,
    color: Colors.successText,
    marginTop: 2,
  },
  financialCard: {
    padding: Spacing.md,
    marginBottom: Spacing.xxl,
  },
  packageNameText: {
    ...Typography.captionBold,
    color: Colors.slate700,
    marginBottom: Spacing.sm,
  },
  financialBreakdown: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: Spacing.xs,
  },
  financialItem: {
    alignItems: "center",
  },
  financialItemLabel: {
    ...Typography.caption,
    color: Colors.slate500,
  },
  financialItemVal: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.slate800,
    marginTop: 4,
  },
  clearedDebtBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    marginTop: Spacing.sm,
  },
  clearedDebtText: {
    ...Typography.captionBold,
    color: Colors.successText,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.lg,
  },
  modalContent: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    padding: Spacing.xl,
    width: "100%",
    maxWidth: 400,
    ...Shadows.elevated,
  },
  modalTitle: {
    ...Typography.h2,
    color: Colors.slate900,
    textAlign: "right",
  },
  modalSub: {
    ...Typography.body,
    color: Colors.slate500,
    marginBottom: Spacing.md,
    textAlign: "right",
  },
  modalButtonRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 10, fontSize: 14, color: Colors.slate500 },
});
