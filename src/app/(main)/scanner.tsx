import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import {
    Alert,
    Modal,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
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
} from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { AttendanceRepository } from "../../features/attendance/AttendanceRepository";
import { AttendanceSessionService, AttendanceSummary } from "../../features/attendance/AttendanceSessionService";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import { ScannerService } from "../../features/scanner/ScannerService";
import { StudentRepository } from "../../features/students/StudentRepository";
import {
    AppButton,
    AppCard,
    AppInput,
    StatusBadge,
} from "../../shared/components";
import {
    Attendance,
    Group,
    Session,
    Student,
    StudentFinancialStatus,
} from "../../shared/types";

export default function ScannerScreen() {
  const services = useServiceVisibility();
  if (!services.loaded) return <View style={styles.centered}><Text style={styles.loadingText}>جار تحميل حالة الخدمات...</Text></View>;
  if (!services.isEnabled("attendance")) return <View style={styles.centered}><Text style={styles.loadingText}>خدمة الحضور غير مفعلة لهذا المركز.</Text></View>;
  return <ScannerContent />;
}

function ScannerContent() {
  const services = useServiceVisibility();
  const paymentsEnabled = services.isEnabled("payments");
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraActive, setIsCameraActive] = useState(false);
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
    useState<StudentFinancialStatus | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [todayGroups, setTodayGroups] = useState<Group[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [attendanceStarted, setAttendanceStarted] = useState(false);
  const [attendanceSummary, setAttendanceSummary] = useState<AttendanceSummary | null>(null);

  // Quick Payment Modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);

  const isScanningBlockedRef = useRef(false);

  useEffect(() => {
    try { setTodayGroups(AttendanceSessionService.getTodayGroups()); } catch (error) { setSearchError(getUserErrorMessage(error)); }
  }, []);

  const startAttendance = () => {
    const selectedGroup = todayGroups.find((group) => group.id === activeSessionId);
    if (!selectedGroup) return;
    try {
      const session = AttendanceSessionService.ensureSessionForGroup(selectedGroup.id);
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
    setSearchError(null);
    isScanningBlockedRef.current = false;
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

      if (!AttendanceSessionService.isExpected(activeSessionId, foundStudent.id)) {
        setStudent(null);
        setSearchError("الطالب غير متوقع في مجموعة الحضور الحالية.");
        setIsProcessing(false);
        return;
      }

      // Load eligible sessions
      const sessions = ScannerService.getEligibleSessionsForStudent(foundStudent.id).filter((session) => session.id === activeSessionId);
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
      if (paymentsEnabled) {
        const fin = PaymentRepository.getStudentFinancialStatus(foundStudent.id);
        setFinancialStatus(fin);
      } else {
        setFinancialStatus(null);
      }
    } catch (err) {
      setSearchError(getUserErrorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (isScanningBlockedRef.current || isProcessing) return;
    isScanningBlockedRef.current = true;
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
      const lateCalc = ScannerService.calculateLateStatus(session.startTime);

      const result = await AttendanceRepository.recordAttendance({
        studentId: student.id,
        sessionId: session.id,
        status: lateCalc.status,
        isLate: lateCalc.isLate,
        attendanceType: "present",
      });

      setAttendanceResult(result);
      setIsAlreadyAttended(true);
      setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
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
        amount,
        paymentType: "partial",
      });

      // Recalculate financial status dynamically
      const updated = PaymentRepository.getStudentFinancialStatus(student.id);
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
        {student ? (
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
            <Text style={styles.startTitle}>اختيار المجموعة للحضور</Text>
            <Text style={styles.startSubtitle}>اختر مجموعة اليوم ثم ابدأ الجلسة لتفعيل المسح.</Text>
            {todayGroups.length === 0 ? (
              <Text style={styles.emptySessionText}>لا توجد جلسات مجدولة اليوم.</Text>
            ) : todayGroups.map((group) => (
              <TouchableOpacity key={group.id} onPress={() => setActiveSessionId(group.id)}>
                <AppCard style={[styles.sessionCard, activeSessionId === group.id ? styles.sessionCardSelected : null]}>
                  <Text style={styles.sessionSubject}>{group.name}</Text>
                  <Text style={styles.sessionTime}>مجموعة اليوم • {group.subjectName || ""}</Text>
                  {activeSessionId === group.id ? <Ionicons name="checkmark-circle" size={20} color={Colors.primary} /> : null}
                </AppCard>
              </TouchableOpacity>
            ))}
            <AppButton title="بدء جلسة الحضور" onPress={startAttendance} disabled={!activeSessionId} size="lg" />
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
                  <CameraView
                    style={styles.camera}
                    barcodeScannerSettings={{
                      barcodeTypes: ["qr", "code128", "ean13", "upc_a"],
                    }}
                    onBarcodeScanned={handleBarcodeScanned}
                  />
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
                <AppButton
                  title="إغلاق الكاميرا"
                  variant="outline"
                  size="sm"
                  onPress={() => setIsCameraActive(false)}
                  style={{ marginTop: Spacing.sm }}
                />
              </View>
            ) : (
              <View style={styles.cameraPlaceholder}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => setIsCameraActive(true)}
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
              {Strings.financialStatusTitle}
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

const styles = StyleSheet.create({
  startAttendancePanel: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.lg, marginBottom: Spacing.lg, ...Shadows.card },
  startTitle: { ...Typography.h2, color: Colors.slate900, marginBottom: 4 },
  startSubtitle: { ...Typography.caption, color: Colors.slate500, textAlign: "right", marginBottom: Spacing.md },
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
    paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
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
  camera: {
    width: "100%",
    height: 240,
    borderRadius: BorderRadius.md,
    overflow: "hidden",
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
    padding: Spacing.md,
    marginBottom: Spacing.sm,
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
