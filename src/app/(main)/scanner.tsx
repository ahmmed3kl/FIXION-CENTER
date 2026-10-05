import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { PermissionService } from "../../core/permissions";
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
import { SessionClosingService } from "../../features/sessions/SessionClosingService";
import { ScannerService } from "../../features/scanner/ScannerService";
import { StudentRepository } from "../../features/students/StudentRepository";
import { StudentNoteRepository } from "../../features/students/StudentNoteRepository";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { getLocalDateOnly } from "../../shared/utils/date";
import { smartSearch } from "../../shared/utils/smartSearch";
import {
    AppButton,
    AppCard,
    AppInput,
    StatusBadge,
} from "../../shared/components";
import { BarcodeScannerView } from "../../shared/components/BarcodeScannerView";
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
  const currentUser = useAuthStore((state) => state.currentUser);
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);
  const { attendanceSessionId, addedStudentId } = useLocalSearchParams<{ attendanceSessionId?: string; addedStudentId?: string }>();
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
  const [isExternalAttendance, setIsExternalAttendance] = useState(false);
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
  const [isClosingSession, setIsClosingSession] = useState(false);
  const [isSessionClosed, setIsSessionClosed] = useState(false);
  const [pendingAttendance, setPendingAttendance] = useState<{
    student: Student;
    session: Session;
    makeup?: NonNullable<typeof makeupNotice>;
    isExternal?: boolean;
  } | null>(null);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [allStudentSearch, setAllStudentSearch] = useState("");
  const [showAllStudentPicker, setShowAllStudentPicker] = useState(false);
  const [showAttendanceNoteModal, setShowAttendanceNoteModal] = useState(false);
  const [attendanceNoteText, setAttendanceNoteText] = useState("");
  const [attendanceNotes, setAttendanceNotes] = useState<import("../../shared/types").StudentNote[]>([]);

  // Quick Payment Modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentPurpose, setPaymentPurpose] = useState<"session" | "cycle">("session");
  const [selectedPaymentCycleId, setSelectedPaymentCycleId] = useState<string | null>(null);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [financialExpanded, setFinancialExpanded] = useState(true);

  const isScanningBlockedRef = useRef(false);
  const lastScannedRef = useRef<{ code: string; at: number } | null>(null);
  const returnedStudentHandledRef = useRef<string | null>(null);

  const refreshTodayData = useCallback(() => {
    try {
      setTodayGroups(AttendanceSessionService.getTodayGroups());
      const sessions = AttendanceSessionService.getTodaySessions();
      setActiveSessionsByGroup(Object.fromEntries(sessions.map((session) => [`${session.groupId}:${session.scheduleId}`, session])));
      setAllGroups(GroupRepository.getAll());
      setAllStudents(StudentRepository.getAllForAttendance());
    } catch (error) { setSearchError(getUserErrorMessage(error)); }
  }, []);

  // Refresh when the screen becomes active. Deduplication ensures we don't
  // double-load when focus and revision fire at the same time.
  useFocusEffect(useCallback(() => {
    if (!hasInitialLoadedRef.current || lastLoadedRevisionRef.current !== localDataRevision) {
      hasInitialLoadedRef.current = true;
      lastLoadedRevisionRef.current = localDataRevision;
      refreshTodayData();
    }
  }, [refreshTodayData, localDataRevision]));

  // React to local data changes (attendance recorded on another screen, sync, etc.)
  useEffect(() => {
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      refreshTodayData();
    }
  }, [localDataRevision, refreshTodayData]);

  // Restore the exact session when returning from the existing Add Student flow
  // without creating a new session or changing the selected roster.
  useEffect(() => {
    if (!attendanceSessionId || addedStudentId) return;
    const session = SessionRepository.findById(String(attendanceSessionId));
    if (!session) return;
    setAttendanceStarted(true);
    setActiveSessionId(session.id);
    setSelectedGroupId(session.groupId);
    setSelectedScheduleId(session.scheduleId || null);
    setIsSessionClosed(session.status === "closed");
    setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
    setCurrentGroupLabel([session.groupName, session.subjectName, session.teacherName].filter(Boolean).join(" • "));
  }, [addedStudentId, attendanceSessionId]);

  const startAttendance = () => {
    const selectedGroup = (showAllGroups ? allGroups : todayGroups).find((group) => group.id === selectedGroupId);
    if (!selectedGroup) return;
    try {
      const sessionKey = `${selectedGroup.id}:${selectedScheduleId || ""}`;
      const session = activeSessionsByGroup[sessionKey] || AttendanceSessionService.ensureSessionForGroup(selectedGroup.id, undefined, selectedScheduleId || undefined);
      setActiveSessionsByGroup((current) => ({ ...current, [sessionKey]: session }));
      setActiveSessionId(session.id);
      if (session.status === "closed") {
        if (!PermissionService.hasPermission(currentUser?.permissions, "sessions.reopen")) {
          throw new Error("ليس لديك صلاحية إعادة فتح الجلسة.");
        }
        SessionClosingService.reopenSession(session.id, "استكمال تسجيل حضور نفس الجلسة");
      }
      AttendanceSessionService.activate(session.id);
      setIsSessionClosed(false);
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
    setIsExternalAttendance(false);
    setAttendanceResult(null);
    setFinancialStatus(null);
    setGroupAttendanceSummary(null);
    setCurrentGroupLabel("");
    setMakeupNotice(null);
    setFinancialExpanded(false);
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
    setIsSessionClosed(false);
    handleReset();
  };

  const closeCurrentSession = () => {
    if (!activeSessionId || isClosingSession) return;
    Alert.alert("إغلاق الجلسة", "هل تريد إغلاق جلسة هذه المجموعة؟ لن يتم تسجيل حضور جديد حتى تعيد فتحها.", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "إغلاق الجلسة",
        style: "destructive",
        onPress: () => {
          try {
            setIsClosingSession(true);
            SessionClosingService.closeSession(activeSessionId);
            refreshTodayData();
            handleReset();
            setIsSessionClosed(true);
            setAttendanceSummary(AttendanceSessionService.getSummary(activeSessionId));
          } catch (error) {
            Alert.alert(Strings.errorTitle, getUserErrorMessage(error));
          } finally {
            setIsClosingSession(false);
          }
        },
      },
    ]);
  };

  const reopenCurrentSession = () => {
    if (!activeSessionId || isClosingSession) return;
    Alert.alert("إعادة فتح الجلسة", "سيتم استكمال نفس الجلسة بدون إنشاء جلسة جديدة أو إعادة غياب الطلاب.", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "إعادة فتح",
        onPress: () => {
          try {
            setIsClosingSession(true);
            SessionClosingService.reopenSession(activeSessionId, "استكمال تسجيل الحضور");
            // Reconcile the same session's expected roster after reopening.
            // This never creates a new session or clears previous attendance,
            // but it includes a student added while the session was closed.
            AttendanceSessionService.activate(activeSessionId);
            setIsSessionClosed(false);
            setAttendanceSummary(AttendanceSessionService.getSummary(activeSessionId));
            refreshTodayData();
          } catch (error) {
            Alert.alert(Strings.errorTitle, getUserErrorMessage(error));
          } finally {
            setIsClosingSession(false);
          }
        },
      },
    ]);
  };

  const lookupCard = async (rawCode: string, forcedStudent?: Student, allowExternal = false) => {
    if (!attendanceStarted || !activeSessionId || isSessionClosed) { setSearchError(isSessionClosed ? "الجلسة مغلقة. أعد فتحها أولاً لاستكمال الحضور." : "اختر المجموعة وابدأ جلسة الحضور أولاً."); return; }
    const normalized = ScannerService.normalizeCardCode(rawCode);
    if (!normalized) {
      setSearchError("يرجى إدخال كود الكارت");
      return;
    }

    setSearchError(null);
    setIsProcessing(true);

    try {
      const foundStudent = forcedStudent || StudentRepository.findByCardCode(normalized);

      if (!foundStudent) {
        setStudent(null);
        setSearchError(`${Strings.unregisteredCardError} (${normalized})`);
        setIsProcessing(false);
        return;
      }

      setStudent(foundStudent);
      // A lookup selects a new student. Never carry the previous student's
      // recorded status into the new card; the attendance row is checked
      // below for this exact session and student.
      setAttendanceResult(null);
      setIsAlreadyAttended(false);
      setIsExternalAttendance(false);
      const currentSession = SessionRepository.findById(activeSessionId);
      const currentGroupId = currentSession?.groupId;
      
      console.log("[Scanner] Found student:", foundStudent.fullName, "ID:", foundStudent.id);
      console.log("[Scanner] Active session:", activeSessionId);
      console.log("[Scanner] Current session details:", {
        groupId: currentSession?.groupId,
        teacherId: currentSession?.teacherId,
        subjectId: currentSession?.subjectId,
        sessionDate: currentSession?.sessionDate,
      });
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
      console.log("[Scanner] Student expected in session?", expected);
      
      const makeupEligibility = expected
        ? { eligible: false }
        : (() => {
            const strict = MakeupService.getEligibilityForSession(activeSessionId, foundStudent.id);
            return strict.eligible
              ? strict
              : AttendanceSessionService.getMakeupEligibility(activeSessionId, foundStudent.id);
          })();
      
      console.log("[Scanner] Makeup eligibility:", makeupEligibility.eligible);
      
      // A student outside the current group is only allowed when the same
      // subject/teacher makeup rule returns a real source absence. The old
      // allowExternal flag made a normal visitor recordable as "external".
      let compensationNotice: typeof makeupNotice = null;
      if (!expected && !makeupEligibility.eligible) {
        console.log("[Scanner] Checking compensation eligibility...");
        const sameTeacher = AttendanceSessionService.isEnrolledWithSameTeacher(activeSessionId, foundStudent.id);
        console.log("[Scanner] Compensation check result:", sameTeacher);
        
        if (sameTeacher.enrolled) {
          compensationNotice = { sourceGroupName: sameTeacher.sourceGroupName, teacherName: sameTeacher.teacherName };
        } else {
          setStudent(null);
          setSearchError("الطالب غير مشترك مع مدرس هذه المجموعة، ولا توجد له حصة تعويضية مؤهلة.");
          setIsProcessing(false);
          return;
        }
      }

      setIsExternalAttendance(false);

      if (makeupEligibility.eligible) {
        setMakeupNotice({ sourceGroupName: makeupEligibility.sourceGroupName, teacherName: makeupEligibility.teacherName, originalAbsenceId: makeupEligibility.originalAbsenceId });
      } else if (compensationNotice) {
        setMakeupNotice(compensationNotice);
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
        // Looking up/scanning a card only selects the student. Attendance is
        // recorded after the operator explicitly presses the attendance button
        // and confirms, so a scan can never silently create attendance or a
        // payment (including for makeup/external students).
      } else if (sessions.length > 1) {
        setSelectedSessionId(null);
        setIsAlreadyAttended(false);
      }

      // Load financial status calculated dynamically
      if (paymentsEnabled && currentGroupId) {
        // Attendance is group-scoped, but the payment wallet is student-wide:
        // a package must be payable in full from any teacher's session.
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
    // Cards can belong to another group; allow lookup to resolve a valid
    // same-teacher makeup instead of hiding the student behind the roster.
    lookupCard(data, undefined, true);
  };

  const attendancePickerStudents = useMemo(() => smartSearch(
    allStudents,
    allStudentSearch,
    [
      { get: (item) => item.fullName, weight: 3 },
      { get: (item) => item.phone },
      { get: (item) => item.parentPhone },
      { get: (item) => item.studentCode },
      { get: (item) => item.cardCode },
    ],
  ), [allStudentSearch, allStudents]);

  const openAttendanceNotes = async () => {
    if (!student) return;
    try {
      setAttendanceNotes(await StudentNoteRepository.listForStudent(student.id));
      setAttendanceNoteText("");
      setShowAttendanceNoteModal(true);
    } catch (error) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(error));
    }
  };

  const saveAttendanceNote = async () => {
    if (!student || !attendanceNoteText.trim()) return;
    try {
      await StudentNoteRepository.create(student.id, attendanceNoteText);
      setAttendanceNotes(await StudentNoteRepository.listForStudent(student.id));
      setAttendanceNoteText("");
      Alert.alert("تم الحفظ", "تم إضافة الملاحظة لملف الطالب.");
    } catch (error) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(error));
    }
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

  const requestAttendanceConfirmation = () => {
    if (!student || isAlreadyAttended || attendanceResult) return;
    const session = eligibleSessions.find((item) => item.id === selectedSessionId)
      || (activeSessionId ? SessionRepository.findById(activeSessionId) : null);
    if (!session) {
      Alert.alert(Strings.errorTitle, "لا توجد جلسة حضور محددة لهذا الطالب.");
      return;
    }
    setPendingAttendance({
      student,
      session,
      makeup: makeupNotice || undefined,
      isExternal: isExternalAttendance,
    });
  };

  const recordAttendanceFor = async (targetStudent: Student, session: Session, makeup?: typeof makeupNotice, isExternal = false) => {
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

      // Compensation students (same teacher, different group, no specific
      // absence) are added to the session roster before recording so the
      // repository-level expected-student validation passes.
      if (makeup && !makeup.originalAbsenceId) {
        AttendanceSessionService.addCompensationStudent(session.id, targetStudent.id);
      }

      const result = (makeup && makeup.originalAbsenceId)
        ? await MakeupService.recordMakeupAttendance({
            studentId: targetStudent.id,
            sessionId: session.id,
            originalAbsenceId: makeup.originalAbsenceId!,
            isLate: lateCalc.isLate,
          })
        : await AttendanceRepository.recordAttendance({
            studentId: targetStudent.id,
            sessionId: session.id,
            status: lateCalc.status,
            isLate: lateCalc.isLate,
            attendanceType: makeup ? "makeup" : "present",
            isExternal,
            suppressExternalPayment: isExternal,
          });

      setAttendanceResult(result);
      setIsAlreadyAttended(true);
      setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
      
      console.log("[Scanner] Attendance recorded. Session details:", {
        sessionId: session.id,
        groupId: session.groupId,
        sessionDate: session.sessionDate,
        status: session.status,
      });
      
      setGroupAttendanceSummary(
        AttendanceRepository.getStudentGroupAttendanceSummaries(targetStudent.id)
          .find((summary) => summary.groupId === session.groupId) || null,
      );
    } catch (err: any) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  // Returning from the existing Add Student flow can continue the same
  // attendance session without creating a second student workflow. The
  // operator explicitly confirms whether the newly-created student should
  // be recorded as regular attendance or makeup.
  useEffect(() => {
    if (!attendanceSessionId || !addedStudentId || returnedStudentHandledRef.current === String(addedStudentId)) return;
    returnedStudentHandledRef.current = String(addedStudentId);
    const session = SessionRepository.findById(String(attendanceSessionId));
    const createdStudent = StudentRepository.findById(String(addedStudentId));
    if (!session || !createdStudent) return;
    setPendingAttendance(null);
    setAttendanceStarted(true);
    setActiveSessionId(session.id);
    setIsSessionClosed(session.status === "closed");
    setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
    setStudent(createdStudent);
    setCurrentGroupLabel([session.groupName, session.subjectName, session.teacherName].filter(Boolean).join(" • "));
    const expected = AttendanceSessionService.isExpected(session.id, createdStudent.id);
    const makeupEligibility = expected ? { eligible: false } : MakeupService.getEligibilityForSession(session.id, createdStudent.id);
    const makeup = makeupEligibility.eligible ? {
      sourceGroupName: makeupEligibility.sourceGroupName,
      teacherName: makeupEligibility.teacherName,
      originalAbsenceId: makeupEligibility.originalAbsenceId,
    } : undefined;
    setMakeupNotice(makeup || null);
    setEligibleSessions([session]);
    setSelectedSessionId(session.id);
    const alreadyAttended = AttendanceRepository.isAlreadyAttended(session.id, createdStudent.id);
    setIsAlreadyAttended(alreadyAttended);
    if (!expected && !makeupEligibility.eligible) {
      Alert.alert("تعذر تسجيل الحضور", "الطالب أُضيف بنجاح لكنه ليس ضمن الجلسة الحالية ولا تنطبق عليه قاعدة الحضور التعويضي.");
      return;
    }
    if (!alreadyAttended && session.status !== "closed") {
      setPendingAttendance({ student: createdStudent, session, makeup });
    }
  }, [addedStudentId, attendanceSessionId]);

  const confirmPendingAttendance = async () => {
    if (!pendingAttendance) return;
    const { student: added, session, makeup, isExternal } = pendingAttendance;
    setPendingAttendance(null);
    if (!AttendanceRepository.isAlreadyAttended(session.id, added.id) && session.status !== "closed") {
      await recordAttendanceFor(added, session, makeup, isExternal === true);
    }
  };

  const cancelPendingAttendance = () => {
    setPendingAttendance(null);
    setMakeupNotice(null);
    setAttendanceResult(null);
    setIsAlreadyAttended(false);
    setFinancialStatus(null);
  };

  const handleRecordAttendance = async () => {
    if (!student || !selectedSessionId || isSessionClosed) return;
    const session = eligibleSessions.find((s) => s.id === selectedSessionId);
    if (session) await recordAttendanceFor(student, session, makeupNotice || undefined);
  };

  const openQuickPaymentModal = () => {
    if (!student || !financialStatus) return;
    const session = activeSessionId ? SessionRepository.findById(activeSessionId) : null;
    setPaymentPurpose("session");
    setSelectedPaymentCycleId(null);
    setPaymentNotes("");
    setPaymentAmount(String(Number(session?.sessionPrice || financialStatus.currentPeriodDebt || 0)));
    setShowPaymentModal(true);
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
      const payableCycles = financialStatus?.cycles.filter((item) => (item.remainingDebt ?? 0) > 0) || [];
      const isCyclePayment = paymentPurpose === "cycle";
      // A class payment must never be attached to a monthly/package cycle.
      // Only a pending/per-session cycle belongs to the per-session ledger;
      // otherwise the payment remains session-scoped and the monthly debt is
      // untouched.
      const sessionCycles = payableCycles.filter((item) =>
        item.billingMode === "pending" ||
        item.billingMode === "per_session" ||
        item.cycleType === "per_session",
      );
      const cycle = (isCyclePayment ? payableCycles : sessionCycles).find((item) => item.id === selectedPaymentCycleId)
        || ((isCyclePayment ? payableCycles : sessionCycles).length === 1 ? (isCyclePayment ? payableCycles : sessionCycles)[0] : undefined);
      if (isCyclePayment && !cycle) {
        Alert.alert("اختيار الدورة", "اختر المجموعة أو دورة المديونية التي ستُنسب إليها الدفعة.");
        return;
      }
      if (!isCyclePayment && sessionCycles.length > 1 && !cycle) {
        Alert.alert("اختيار دورة الحصة", "اختر دورة الحصة التي ستُسجّل عليها الدفعة.");
        return;
      }
      const cyclePaymentType = isCyclePayment && cycle && amount >= Number(cycle.remainingDebt ?? 0)
        ? "monthly"
        : isCyclePayment ? "partial" : "session";
      await PaymentRepository.recordPayment({
        studentId: student.id,
        // A cycle/package payment is intentionally not tied to the current
        // teacher session. The operational reports allocate package money to
        // teachers separately, while the ledger keeps one package balance.
        sessionId: isCyclePayment ? undefined : (activeSessionId || selectedSessionId || undefined),
        amount,
        paymentType: cyclePaymentType,
        // Keep every payment linked to the current obligation. The payment
        // purpose controls the session display, while the cycle link lets a
        // later "complete month/package" payment subtract the earlier
        // per-session amount from the same cap.
        debtCycleId: cycle?.id,
        subscriptionId: cycle?.packageSubscriptionId,
        notes: paymentNotes.trim() || undefined,
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
      setPaymentNotes("");
      Alert.alert("نجاح", Strings.paymentRecordedSuccess);
    } catch (err) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(err));
    } finally {
      setIsRecordingPayment(false);
    }
  };

  // Rebuilt attendance composition. The legacy JSX below is intentionally
  // unreachable while the migration is in progress; all business logic above
  // (repositories, offline queue, makeup rules and payment handling) is shared.
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.rebuildHeader}>
        {attendanceStarted ? <TouchableOpacity onPress={() => { setAllStudentSearch(""); setShowAllStudentPicker(true); }} style={styles.headerMenu}><Ionicons name="search-outline" size={21} color={Colors.primary} /></TouchableOpacity> : null}
        {student ? <TouchableOpacity onPress={() => void openAttendanceNotes()} style={styles.headerMenu}><Ionicons name="create-outline" size={21} color={Colors.primary} /></TouchableOpacity> : null}
        <TouchableOpacity onPress={attendanceStarted ? handleBackToGroups : () => router.back()} style={styles.rebuildBack}><Ionicons name="chevron-forward" size={24} color={Colors.slate900} /></TouchableOpacity>
        <View style={styles.rebuildHeaderCopy}><Text style={styles.rebuildTitle}>{attendanceStarted ? "حضور الجلسة" : "جلسات الحضور"}</Text><Text style={styles.rebuildSubtitle}>{attendanceStarted ? currentGroupLabel : "اختر مجموعة لبدء تسجيل الحضور"}</Text></View>
        {attendanceStarted ? <TouchableOpacity onPress={isSessionClosed ? reopenCurrentSession : closeCurrentSession} style={styles.headerMenu}><Ionicons name={isSessionClosed ? "lock-open-outline" : "ellipsis-horizontal"} size={21} color={Colors.primary} /></TouchableOpacity> : null}
      </View>
      {!attendanceStarted ? (
        <ScrollView contentContainerStyle={styles.rebuildContent}>
          <View style={styles.startAttendancePanel}><Text style={styles.rebuildSectionTitle}>مجموعات اليوم</Text><View style={styles.attendanceFilterRow}><TouchableOpacity style={[styles.attendanceFilter, !showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(false)}><Text style={[styles.attendanceFilterText, !showAllGroups && styles.attendanceFilterTextActive]}>اليوم</Text></TouchableOpacity><TouchableOpacity style={[styles.attendanceFilter, showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(true)}><Text style={[styles.attendanceFilterText, showAllGroups && styles.attendanceFilterTextActive]}>كل المجموعات</Text></TouchableOpacity></View>{(showAllGroups ? allGroups : todayGroups).flatMap((group) => GroupScheduleRepository.getSchedulesForGroup(group.id).filter((schedule) => showAllGroups || schedule.dayOfWeek === new Date().getDay()).map((schedule) => { const key = `${group.id}:${schedule.id}`; const selected = selectedGroupId === group.id && selectedScheduleId === schedule.id; return <TouchableOpacity key={key} onPress={() => { setSelectedGroupId(group.id); setSelectedScheduleId(schedule.id); }} style={[styles.rebuildGroupRow, selected && styles.rebuildGroupRowActive]}><View style={styles.rebuildGroupIcon}><Ionicons name="people-outline" size={20} color={Colors.primary} /></View><View style={styles.rebuildGroupCopy}><Text style={styles.rebuildGroupName}>{group.name}</Text><Text style={styles.rebuildGroupMeta}>{[group.subjectName, group.grade, group.teacherName].filter(Boolean).join(" · ")}</Text><Text style={styles.rebuildGroupMeta}>{DAYS_OF_WEEK[schedule.dayOfWeek]} · {formatTimeArabic(schedule.startTime)} - {formatTimeArabic(schedule.endTime)}</Text></View><Ionicons name="chevron-back" size={18} color={Colors.slate400} /></TouchableOpacity>; }))}<AppButton title="بدء جلسة الحضور" onPress={startAttendance} disabled={!selectedGroupId} size="lg" />{searchError ? <Text style={styles.errorAlertText}>{searchError}</Text> : null}</View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.rebuildContent} keyboardShouldPersistTaps="handled">
          {attendanceSummary ? <View style={styles.rebuildSummary}><View style={[styles.summaryTile, styles.summaryAll]}><Ionicons name="people" size={21} color={Colors.primary} /><Text style={styles.summaryValue}>{attendanceSummary.total}</Text><Text style={styles.summaryLabel}>الكل</Text></View><View style={[styles.summaryTile, styles.summaryPresent]}><Ionicons name="checkmark-circle" size={21} color={Colors.successText} /><Text style={styles.summaryValue}>{attendanceSummary.present}</Text><Text style={styles.summaryLabel}>حاضر</Text></View><View style={[styles.summaryTile, styles.summaryAbsent]}><Ionicons name="close-circle" size={21} color={Colors.dangerText} /><Text style={styles.summaryValue}>{attendanceSummary.absent}</Text><Text style={styles.summaryLabel}>غائب</Text></View><View style={[styles.summaryTile, styles.summaryMakeup]}><Ionicons name="people-outline" size={21} color={Colors.warningText} /><Text style={styles.summaryValue}>{attendanceSummary.makeup}</Text><Text style={styles.summaryLabel}>تعويض</Text></View></View> : null}
          <View style={styles.rebuildScanPanel}><View style={styles.rebuildScanInput}><Ionicons name="search-outline" size={23} color={Colors.slate400} /><AppInput value={manualCode} onChangeText={setManualCode} placeholder="اكتب كود الطالب للبحث اليدوي" containerStyle={{ flex: 1, marginBottom: 0 }} /></View><TouchableOpacity style={styles.rebuildManualButton} onPress={() => lookupCard(manualCode, undefined, true)}><Text style={styles.rebuildManualText}>بحث بالكود</Text></TouchableOpacity>{isCameraActive ? <BarcodeScannerView onDetected={(data) => handleBarcodeScanned({ data })} onClose={() => { setIsTorchOn(false); setIsCameraActive(false); }} style={styles.rebuildCamera} /> : <TouchableOpacity style={styles.rebuildScanButton} onPress={() => { isScanningBlockedRef.current = false; lastScannedRef.current = null; setIsCameraActive(true); }}><Ionicons name="scan-outline" size={25} color={Colors.white} /><Text style={styles.rebuildScanButtonText}>مسح كود الطالب</Text></TouchableOpacity>}</View>
          {student ? <View style={styles.rebuildStudentCard}><View style={styles.rebuildStudentAvatar}><Ionicons name="person" size={34} color={Colors.primary} /></View><View style={styles.rebuildStudentCopy}><Text style={styles.rebuildStudentName}>{student.fullName}</Text><Text style={styles.rebuildStudentMeta}>كود الطالب: {student.cardCode || student.studentCode}</Text><Text style={styles.rebuildStudentMeta}>{[student.grade, currentGroupLabel].filter(Boolean).join(" · ")}</Text></View><View style={styles.rebuildStatus}><Ionicons name={attendanceResult?.isLate ? "time-outline" : "checkmark-circle"} size={22} color={attendanceResult?.isLate ? Colors.warningText : Colors.successText} /><Text style={styles.rebuildStatusText}>{attendanceResult?.isLate ? "متأخر" : attendanceResult ? "حاضر" : isAlreadyAttended ? "مسجل" : makeupNotice ? "تعويض مستحق" : isExternalAttendance ? "خارج المجموعة" : "جاهز للتسجيل"}</Text>{attendanceResult?.checkInTime ? <Text style={styles.rebuildTime}>{attendanceResult.checkInTime}</Text> : null}</View>{!attendanceResult && !isAlreadyAttended ? <AppButton title={makeupNotice ? "تسجيل حضور تعويضي" : isExternalAttendance ? "تسجيل حضور خارجي" : "تسجيل الحضور"} onPress={requestAttendanceConfirmation} loading={isProcessing} disabled={isSessionClosed} size="lg" /> : null}<View style={styles.rebuildActions}><TouchableOpacity style={styles.rebuildSecondaryAction} onPress={handleReset}><Ionicons name="refresh" size={20} color={Colors.primary} /><Text style={styles.rebuildActionText}>مسح طالب آخر</Text></TouchableOpacity><TouchableOpacity style={styles.rebuildSecondaryAction} onPress={() => router.push({ pathname: "/(main)/students", params: { add: "1", attendanceSessionId: activeSessionId } } as any)}><Ionicons name="person-add-outline" size={20} color={Colors.primary} /><Text style={styles.rebuildActionText}>إضافة طالب</Text></TouchableOpacity></View></View> : null}
          {student ? <View style={styles.rebuildNotesSection}><View style={styles.rebuildSectionHeader}><View><Text style={styles.rebuildSectionTitle}>ملاحظات الطالب</Text><Text style={styles.rebuildFinanceHint}>{student.notes?.trim() ? "ملاحظة محفوظة" : "لا توجد ملاحظات"}</Text></View><TouchableOpacity onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: student.id } } as any)}><Text style={styles.rebuildLink}>+ إضافة ملاحظة</Text></TouchableOpacity></View>{student.notes?.trim() ? <View style={styles.rebuildNote}><Ionicons name="document-text-outline" size={19} color={Colors.primary} /><Text style={styles.rebuildNoteText}>{student.notes}</Text></View> : <Text style={styles.rebuildEmpty}>لا توجد ملاحظات لهذا الطالب</Text>}</View> : null}
          {paymentsEnabled && student && financialStatus ? <View style={styles.rebuildFinance}><TouchableOpacity style={styles.rebuildSectionHeader} onPress={() => setFinancialExpanded((value) => !value)}><View><Text style={styles.rebuildSectionTitle}>الحالة المالية</Text><Text style={styles.rebuildFinanceHint}>المستحق · المدفوع · المتبقي</Text></View><Ionicons name={financialExpanded ? "chevron-up" : "chevron-down"} size={23} color={Colors.primary} /></TouchableOpacity><View style={styles.rebuildFinanceTiles}><View><Text style={styles.rebuildFinanceLabel}>المستحق</Text><Text style={styles.rebuildFinanceDue}>{formatCurrency(financialStatus.totalDue)}</Text></View><View><Text style={styles.rebuildFinanceLabel}>المدفوع</Text><Text style={styles.rebuildFinancePaid}>{formatCurrency(financialStatus.totalPaid)}</Text></View><View><Text style={styles.rebuildFinanceLabel}>المتبقي</Text><Text style={styles.rebuildFinanceRemaining}>{formatCurrency(financialStatus.remainingBalance)}</Text></View></View>{financialExpanded ? <><Text style={styles.paymentHistoryTitle}>سجل مدفوعات الطالب</Text>{financialStatus.payments.map((payment) => <View key={payment.id} style={styles.paymentHistoryRow}><Text style={styles.paymentHistoryAmount}>{formatCurrency(payment.amount)}</Text><Text style={styles.paymentHistoryType}>{payment.paymentType === "monthly" ? "دفعة شهرية" : payment.paymentType === "session" ? "دفعة حصة" : "دفعة جزئية"}</Text><Text style={styles.paymentHistoryMeta}>{payment.paymentDate || payment.createdAt.slice(0, 10)}</Text></View>)}</> : null}<AppButton title="تسجيل دفعة" onPress={openQuickPaymentModal} size="lg" /></View> : null}
        </ScrollView>
      )}
      <Modal visible={showPaymentModal} transparent animationType="fade" onRequestClose={() => setShowPaymentModal(false)}><View style={styles.modalBackdrop}><View style={styles.modalContent}><Text style={styles.modalTitle}>تسجيل دفعة نقدية</Text><Text style={styles.modalSub}>{student?.fullName}</Text><View style={styles.paymentPurposeRow}>{(["session", "cycle"] as const).map((purpose) => <TouchableOpacity key={purpose} style={[styles.paymentPurposeButton, paymentPurpose === purpose && styles.paymentPurposeButtonActive]} onPress={() => { setPaymentPurpose(purpose); setSelectedPaymentCycleId(null); if (purpose === "cycle") setPaymentAmount(String(financialStatus?.remainingBalance ?? 0)); else { const session = activeSessionId ? SessionRepository.findById(activeSessionId) : null; setPaymentAmount(String(Number(session?.sessionPrice || financialStatus?.currentPeriodDebt || 0))); } }}><Text style={[styles.paymentPurposeText, paymentPurpose === purpose && styles.paymentPurposeTextActive]}>{purpose === "session" ? "دفع الحصة" : "استكمال الشهر / الباقة"}</Text></TouchableOpacity>)}</View>{paymentPurpose === "cycle" && (financialStatus?.cycles?.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).length || 0) > 1 ? <View style={styles.paymentCyclePicker}><Text style={styles.paymentCycleTitle}>اختر المجموعة أو الدورة</Text>{financialStatus?.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).map((cycle) => <TouchableOpacity key={cycle.id} style={[styles.paymentCycleOption, selectedPaymentCycleId === cycle.id && styles.paymentCycleOptionActive]} onPress={() => { setSelectedPaymentCycleId(cycle.id); setPaymentAmount(String(cycle.remainingDebt ?? cycle.effectivePrice ?? cycle.cyclePrice ?? 0)); }}><Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.paymentCycleAmount}>المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></TouchableOpacity>)}</View> : null}{paymentPurpose === "session" && (financialStatus?.cycles?.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).length || 0) > 1 ? <View style={styles.paymentCyclePicker}><Text style={styles.paymentCycleTitle}>اختار الدورة التي ستخصم منها الدفعة</Text>{financialStatus?.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).map((cycle) => <TouchableOpacity key={cycle.id} style={[styles.paymentCycleOption, selectedPaymentCycleId === cycle.id && styles.paymentCycleOptionActive]} onPress={() => setSelectedPaymentCycleId(cycle.id)}><Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.paymentCycleAmount}>المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></TouchableOpacity>)}</View> : null}<AppInput label="المبلغ" keyboardType="numeric" value={paymentAmount} onChangeText={setPaymentAmount} /><AppInput label="ملاحظة الدفع (اختياري)" placeholder="مثال: استكمال باقي الشهر" value={paymentNotes} onChangeText={setPaymentNotes} multiline /><View style={styles.modalButtonRow}><AppButton title="حفظ" onPress={handleConfirmQuickPayment} loading={isRecordingPayment} variant="success" style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setShowPaymentModal(false)} style={{ flex: 1 }} /></View></View></View></Modal>
      <Modal visible={showAllStudentPicker} transparent animationType="slide" onRequestClose={() => setShowAllStudentPicker(false)}><View style={styles.modalBackdrop}><View style={styles.confirmSheet}><Text style={styles.modalTitle}>اختيار طالب للحضور</Text><AppInput value={allStudentSearch} onChangeText={setAllStudentSearch} placeholder="ابحث بالاسم أو الهاتف أو الكود" /><ScrollView style={{ maxHeight: 360 }}>{attendancePickerStudents.map((item) => <TouchableOpacity key={item.id} style={styles.rebuildGroupRow} onPress={() => { setShowAllStudentPicker(false); setManualCode(item.cardCode || item.studentCode || item.phone || ""); void lookupCard(item.cardCode || item.studentCode || item.phone || "", item, true); }}><View style={styles.rebuildGroupCopy}><Text style={styles.rebuildGroupName}>{item.fullName}</Text><Text style={styles.rebuildGroupMeta}>{[item.phone, item.studentCode || item.cardCode, item.grade].filter(Boolean).join(" · ")}</Text></View><Ionicons name="chevron-back" size={18} color={Colors.slate400} /></TouchableOpacity>)}</ScrollView><AppButton title="إلغاء" variant="outline" onPress={() => setShowAllStudentPicker(false)} /></View></View></Modal>
      <Modal visible={showAttendanceNoteModal} transparent animationType="fade" onRequestClose={() => setShowAttendanceNoteModal(false)}><View style={styles.modalBackdrop}><View style={styles.modalContent}><Text style={styles.modalTitle}>إضافة ملاحظة</Text><Text style={styles.modalSub}>{student?.fullName}</Text><AppInput value={attendanceNoteText} onChangeText={setAttendanceNoteText} placeholder="اكتب ملاحظتك" multiline /><View style={styles.modalButtonRow}><AppButton title="حفظ" onPress={() => void saveAttendanceNote()} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setShowAttendanceNoteModal(false)} style={{ flex: 1 }} /></View>{attendanceNotes.map((note) => <View key={note.id} style={styles.paymentHistoryRow}><Text style={styles.paymentHistoryType}>{note.text}</Text><Text style={styles.paymentHistoryMeta}>{note.createdByName || "حساب"}</Text></View>)}</View></View></Modal>
      <Modal visible={Boolean(pendingAttendance)} transparent animationType="slide" onRequestClose={cancelPendingAttendance}>
        <View style={styles.modalBackdrop}>
          <View style={styles.confirmSheet}>
            <View style={styles.confirmIcon}><Ionicons name="checkmark-circle-outline" size={30} color={Colors.primary} /></View>
            <Text style={styles.modalTitle}>تأكيد تسجيل الحضور</Text>
            <Text style={styles.modalSub}>{pendingAttendance?.student.fullName}</Text>
            <Text style={styles.confirmQuestion}>{pendingAttendance?.makeup ? "الطالب تعويضي. هل تريد تسجيل حضوره في الجلسة الحالية؟" : pendingAttendance?.isExternal ? "الطالب خارج المجموعة الحالية. هل تريد تسجيله كحضور خارجي؟" : "هل تريد تسجيل حضور الطالب في الجلسة الحالية؟"}</Text>
            <Text style={styles.confirmGroup}>{pendingAttendance?.session.groupName || currentGroupLabel}</Text>
            <View style={styles.modalButtonRow}>
              <AppButton title="تأكيد" onPress={() => void confirmPendingAttendance()} style={{ flex: 1 }} />
              <AppButton title="إلغاء" variant="outline" onPress={cancelPendingAttendance} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );

  /* Legacy composition retained temporarily for source-level comparison only. */
  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Top Header */}
      <View style={styles.headerBar}>
        <View><Text style={styles.headerTitle}>{attendanceStarted ? "حضور الجلسة" : Strings.scanCardTitle}</Text>{attendanceStarted && currentGroupLabel ? <Text style={styles.headerSubtitle}>{currentGroupLabel}</Text> : null}</View>
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
                  <Text style={[styles.groupAttendanceState, activeSession && activeSession.status !== "closed" && styles.groupAttendanceStateActive]}>{activeSession?.status === "closed" ? "● مغلقة — اضغط لإعادة الفتح" : activeSession ? "● نشطة" : "● غير نشطة"}</Text>
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
            {isSessionClosed ? (
              <AppButton title={isClosingSession ? "جاري الفتح..." : "إعادة فتح الجلسة"} onPress={reopenCurrentSession} disabled={isClosingSession || !PermissionService.hasPermission(currentUser?.permissions, "sessions.reopen")} size="sm" variant="outline" />
            ) : (
              <AppButton title={isClosingSession ? "جاري الإغلاق..." : "إغلاق الجلسة"} onPress={closeCurrentSession} disabled={isClosingSession} size="sm" variant="outline" />
            )}
            <Text style={styles.counterItem}>الكل: {attendanceSummary!.total}</Text>
            <Text style={[styles.counterItem, { color: Colors.successText }]}>حاضر: {attendanceSummary!.present}</Text>
            <Text style={[styles.counterItem, { color: Colors.dangerText }]}>غائب: {attendanceSummary!.absent}</Text>
            <Text style={[styles.counterItem, { color: Colors.warningText }]}>تعويض: {attendanceSummary!.makeup}</Text>
          </View>
        ) : null}
        {/* CAMERA OR MANUAL SCANNER CARD */}
        {attendanceStarted && isSessionClosed ? (
          <AppCard style={styles.scannerCard}>
            <Text style={styles.permissionText}>الجلسة مغلقة. يمكنك إعادة فتح نفس الجلسة لاستكمال الحضور بدون تكرار الغياب.</Text>
          </AppCard>
        ) : null}
        {attendanceStarted && !student && !isSessionClosed ? (
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
                    title={isTorchOn ? "إغلاق الفلاش" : "تشغيل الفلاش"}
                    variant="outline"
                    size="sm"
                    onPress={() => setIsTorchOn((current) => !current)}
                    icon={<Ionicons name="flashlight-outline" size={18} color={Colors.primary} />}
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
            <TouchableOpacity
              style={styles.addStudentFromAttendance}
              onPress={() => router.push({ pathname: "/(main)/students", params: { add: "1", attendanceSessionId: activeSessionId } } as any)}
              activeOpacity={0.8}
            >
              <Ionicons name="person-add-outline" size={19} color={Colors.primary} />
              <Text style={styles.addStudentFromAttendanceText}>إضافة طالب</Text>
            </TouchableOpacity>
          </AppCard>
        ) : null}

        {/* STEP 1: STUDENT PROFILE RESULT */}
        {student ? (
          <AppCard style={styles.resultCard}>
            {makeupNotice && (
              <View style={styles.makeupNotice}>
                <Ionicons name="swap-horizontal" size={20} color={Colors.warningText} />
                <Text style={styles.makeupNoticeText}>هذا الطالب مسجل مع نفس المدرس في مجموعة {makeupNotice!.sourceGroupName || "أخرى"}، وسيتم تسجيل حضوره تعويضياً في المجموعة الحالية.</Text>
              </View>
            )}
            <View style={styles.studentHeader}>
              <View style={styles.studentAvatar}>
                <Ionicons name="person" size={28} color={Colors.primary} />
              </View>
              <View style={styles.studentDetails}>
                <Text style={styles.studentName}>{student!.fullName}</Text>
                <Text style={styles.studentSub}>
                  {Strings.cardCodePrefix} {student!.cardCode} • {student!.grade}
                </Text>
              </View>
              <StatusBadge
                text={
                  student!.status === "active"
                    ? Strings.studentStatusActive
                    : Strings.studentStatusInactive
                }
                type={student!.status === "active" ? "success" : "neutral"}
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
            {!attendanceResult && isAlreadyAttended ? (
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
            ) : null}

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
                    {attendanceResult!.checkInTime}
                  </Text>
                </View>
                <StatusBadge
                  text={
                    attendanceResult!.isLate
                      ? Strings.attendanceStatusLate
                      : Strings.attendanceStatusPresent
                  }
                  type={attendanceResult!.isLate ? "warning" : "success"}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {student ? <View style={styles.sectionContainer}><View style={styles.notesHeading}><Text style={styles.sectionTitle}>ملاحظات الطالب</Text><TouchableOpacity onPress={() => router.push({ pathname: "/(main)/students", params: { studentId: student!.id } } as any)}><Text style={styles.notesLink}>إدارة الملاحظات</Text></TouchableOpacity></View>{student!.notes?.trim() ? <AppCard style={styles.noteCard}><Ionicons name="document-text-outline" size={18} color={Colors.primary} /><Text style={styles.noteText}>{student!.notes}</Text></AppCard> : <Text style={styles.emptyNote}>لا توجد ملاحظات محفوظة لهذا الطالب.</Text>}</View> : null}

        {/* STEP 4: FINANCIAL STATUS & QUICK PAYMENT */}
        {paymentsEnabled && student && financialStatus ? (
          <View style={styles.sectionContainer}>
            <TouchableOpacity style={styles.financialHeading} onPress={() => setFinancialExpanded((value) => !value)}><View><Text style={styles.sectionTitle}>الحالة المالية</Text><Text style={styles.financialHint}>المستحق · المدفوع · المتبقي</Text></View><Ionicons name={financialExpanded ? "chevron-up" : "chevron-down"} size={22} color={Colors.primary} /></TouchableOpacity>
            <AppCard style={styles.financialCard}>
              {financialStatus!.subscriptions.length > 0 ? (
                <Text style={styles.packageNameText}>
                  {financialStatus!.subscriptions[0].packageName}
                </Text>
              ) : null}

              <View style={styles.financialBreakdown}>
                <View style={styles.financialItem}>
                  <Text style={styles.financialItemLabel}>
                    {Strings.totalDueLabel}
                  </Text>
                  <Text style={styles.financialItemVal}>
                    {formatCurrency(financialStatus!.totalDue)}
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
                    {formatCurrency(financialStatus!.totalPaid)}
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
                          financialStatus!.remainingBalance > 0
                            ? Colors.dangerText
                            : Colors.successText,
                      },
                    ]}
                  >
                    {formatCurrency(financialStatus!.remainingBalance)}
                  </Text>
                </View>
              </View>
              {(financialStatus!.creditBalance ?? 0) > 0 ? (
                <Text style={styles.creditBalanceText}>
                  رصيد مقدم للطالب: {formatCurrency(financialStatus!.creditBalance ?? 0)}
                </Text>
              ) : null}

              {financialExpanded && financialStatus!.payments.length ? <View style={styles.paymentHistory}><Text style={styles.paymentHistoryTitle}>سجل المدفوعات ({financialStatus!.payments.length})</Text>{financialStatus!.payments.map((payment) => <View key={payment.id} style={styles.paymentHistoryRow}><View><Text style={styles.paymentHistoryAmount}>{formatCurrency(payment.amount)}</Text><Text style={styles.paymentHistoryMeta}>{payment.paymentDate || payment.createdAt.slice(0, 10)}</Text></View><Text style={styles.paymentHistoryType}>{payment.paymentType === "monthly" ? "دفعة شهرية" : payment.paymentType === "session" ? "دفعة حصة" : "دفعة جزئية"}</Text></View>)}</View> : null}
              {financialStatus!.remainingBalance > 0 || (financialStatus!.currentPeriodDebt ?? 0) > 0 ? (
                <AppButton
                  title={Strings.quickPaymentTitle}
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    const hasCycleBalance = financialStatus!.remainingBalance > 0;
                    setPaymentPurpose(hasCycleBalance ? "cycle" : "session");
                    setPaymentAmount(String(hasCycleBalance ? financialStatus!.remainingBalance : (financialStatus!.currentPeriodDebt ?? 0)));
                    setPaymentNotes("");
                    const payableCycles = financialStatus!.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0);
                    setSelectedPaymentCycleId(payableCycles.length === 1 ? payableCycles[0].id : null);
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

            <View style={styles.paymentPurposeRow}>
              {(["session", "cycle"] as const).map((purpose) => (
                <TouchableOpacity
                  key={purpose}
                  style={[styles.paymentPurposeButton, paymentPurpose === purpose && styles.paymentPurposeButtonActive]}
                  onPress={() => {
                    setPaymentPurpose(purpose);
                    if (purpose === "cycle") {
                      setPaymentAmount(String(financialStatus?.remainingBalance ?? 0));
                    } else {
                      const session = activeSessionId ? SessionRepository.findById(activeSessionId) : null;
                      setPaymentAmount(String(Number(session?.sessionPrice || financialStatus?.currentPeriodDebt || 0)));
                    }
                  }}
                >
                  <Text style={[styles.paymentPurposeText, paymentPurpose === purpose && styles.paymentPurposeTextActive]}>
                    {purpose === "session" ? "دفع الحصة" : "استكمال الشهر / الباقة"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {paymentPurpose === "cycle" && (financialStatus?.cycles?.length || 0) > 1 ? <View style={styles.paymentCyclePicker}><Text style={styles.paymentCycleTitle}>اختر المجموعة أو الدورة</Text>{financialStatus?.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).map((cycle) => <TouchableOpacity key={cycle.id} style={[styles.paymentCycleOption, selectedPaymentCycleId === cycle.id && styles.paymentCycleOptionActive]} onPress={() => { setSelectedPaymentCycleId(cycle.id); setPaymentAmount(String(cycle.remainingDebt ?? cycle.effectivePrice ?? cycle.cyclePrice ?? 0)); }}><Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.paymentCycleAmount}>المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></TouchableOpacity>)}</View> : null}

            {paymentPurpose === "session" && (financialStatus?.cycles?.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).length || 0) > 1 ? <View style={styles.paymentCyclePicker}><Text style={styles.paymentCycleTitle}>اختار الدورة التي ستخصم منها الدفعة</Text>{financialStatus?.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).map((cycle) => <TouchableOpacity key={cycle.id} style={[styles.paymentCycleOption, selectedPaymentCycleId === cycle.id && styles.paymentCycleOptionActive]} onPress={() => setSelectedPaymentCycleId(cycle.id)}><Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.paymentCycleAmount}>المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></TouchableOpacity>)}</View> : null}

            <AppInput
              label={Strings.paymentAmountLabel}
              keyboardType="numeric"
              value={paymentAmount}
              onChangeText={setPaymentAmount}
            />

            <AppInput
              label="ملاحظة الدفع (اختياري)"
              placeholder="مثال: استكمال باقي الشهر"
              value={paymentNotes}
              onChangeText={setPaymentNotes}
              multiline
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
  paymentCyclePicker: { marginBottom: Spacing.md, gap: Spacing.sm },
  paymentCycleTitle: { color: Colors.slate800, fontWeight: "800", textAlign: "right" },
  paymentCycleOption: { borderWidth: 1, borderColor: Colors.slate200, borderRadius: BorderRadius.md, padding: Spacing.sm, backgroundColor: Colors.white },
  paymentCycleOptionActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  paymentCycleName: { color: Colors.slate800, fontWeight: "800", textAlign: "right" },
  paymentCycleAmount: { color: Colors.slate500, fontSize: 12, marginTop: 3, textAlign: "right" },
  paymentPurposeRow: { flexDirection: "row", gap: Spacing.sm, marginBottom: Spacing.md },
  paymentPurposeButton: { flex: 1, borderWidth: 1, borderColor: Colors.slate200, borderRadius: BorderRadius.md, paddingVertical: 10, paddingHorizontal: 8, alignItems: "center", backgroundColor: Colors.white },
  paymentPurposeButtonActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  paymentPurposeText: { color: Colors.slate600, fontSize: 12, fontWeight: "700", textAlign: "center" },
  paymentPurposeTextActive: { color: Colors.primaryDark },
  creditBalanceText: { marginTop: Spacing.sm, color: Colors.primaryDark, fontSize: 13, fontWeight: "800", textAlign: "center" },
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
  rebuildHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  rebuildBack: { width: 42, height: 42, borderRadius: 14, backgroundColor: Colors.slate50, alignItems: "center", justifyContent: "center" },
  rebuildHeaderCopy: { flex: 1, alignItems: "flex-end" },
  rebuildTitle: { ...Typography.h2, color: Colors.slate900, textAlign: "right" },
  rebuildSubtitle: { ...Typography.caption, color: Colors.slate500, marginTop: 2, textAlign: "right" },
  headerMenu: { width: 42, height: 42, borderRadius: 14, backgroundColor: Colors.primaryMuted, alignItems: "center", justifyContent: "center" },
  rebuildContent: { padding: Spacing.md, gap: Spacing.md, paddingBottom: 44 },
  rebuildSectionTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" },
  rebuildGroupRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.md, borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white, marginBottom: Spacing.sm },
  rebuildGroupRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  rebuildGroupIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  rebuildGroupCopy: { flex: 1, alignItems: "flex-end" }, rebuildGroupName: { color: Colors.slate900, fontSize: 15, fontWeight: "900", textAlign: "right" }, rebuildGroupMeta: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" },
  rebuildSummary: { flexDirection: "row-reverse", gap: 8, backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: 10, ...Shadows.card },
  summaryTile: { flex: 1, minHeight: 91, borderRadius: BorderRadius.lg, alignItems: "center", justifyContent: "center", gap: 4 }, summaryAll: { backgroundColor: Colors.primaryMuted }, summaryPresent: { backgroundColor: Colors.successLight }, summaryAbsent: { backgroundColor: Colors.dangerLight }, summaryMakeup: { backgroundColor: Colors.warningLight }, summaryValue: { color: Colors.slate900, fontSize: 23, fontWeight: "900" }, summaryLabel: { color: Colors.slate600, fontSize: 11, fontWeight: "800" },
  rebuildScanPanel: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card }, rebuildScanInput: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, paddingHorizontal: 10 }, rebuildScanButton: { marginTop: Spacing.sm, minHeight: 50, borderRadius: BorderRadius.lg, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 }, rebuildScanButtonText: { color: Colors.white, fontWeight: "900" }, rebuildManualButton: { marginTop: 7, alignItems: "center", paddingVertical: 8 }, rebuildManualText: { color: Colors.primary, fontWeight: "800" }, rebuildCamera: { marginTop: Spacing.sm, height: 230, borderRadius: BorderRadius.lg, overflow: "hidden", backgroundColor: Colors.slate900 }, closeCameraButton: { position: "absolute", bottom: 10, alignSelf: "center", backgroundColor: "rgba(15,23,42,.75)", paddingHorizontal: 14, paddingVertical: 7, borderRadius: 9 }, closeCameraText: { color: Colors.white, fontWeight: "800" },
  rebuildStudentCard: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card }, rebuildStudentAvatar: { width: 76, height: 76, borderRadius: 38, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center", alignSelf: "flex-end" }, rebuildStudentCopy: { alignItems: "flex-end", marginTop: -63, marginRight: 90, minHeight: 74 }, rebuildStudentName: { color: Colors.slate900, fontSize: 19, fontWeight: "900", textAlign: "right" }, rebuildStudentMeta: { color: Colors.slate500, fontSize: 12, marginTop: 4, textAlign: "right" }, rebuildStatus: { marginTop: 17, backgroundColor: Colors.successLight, borderRadius: 28, paddingVertical: 9, paddingHorizontal: 16, alignSelf: "flex-start", alignItems: "center", minWidth: 105 }, rebuildStatusText: { color: Colors.successText, fontWeight: "900", marginTop: 2 }, rebuildTime: { color: Colors.successText, fontSize: 11, marginTop: 2 }, rebuildActions: { flexDirection: "row-reverse", gap: 8, marginTop: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.md }, rebuildSecondaryAction: { flex: 1, minHeight: 46, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primaryLight, alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 6 }, rebuildActionText: { color: Colors.primary, fontWeight: "800", fontSize: 12 },
  rebuildNotesSection: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card }, rebuildSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, rebuildLink: { color: Colors.primary, fontWeight: "800", fontSize: 12 }, rebuildNote: { flexDirection: "row", gap: 8, marginTop: Spacing.md, padding: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.slate50 }, rebuildNoteText: { flex: 1, color: Colors.slate700, lineHeight: 20, textAlign: "right" }, rebuildEmpty: { color: Colors.slate500, fontSize: 12, textAlign: "right", marginTop: Spacing.md },
  rebuildFinance: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card }, rebuildFinanceHint: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" }, rebuildFinanceTiles: { flexDirection: "row-reverse", gap: 7, marginTop: Spacing.md }, rebuildFinanceLabel: { color: Colors.slate500, fontSize: 11, textAlign: "center" }, rebuildFinanceDue: { color: Colors.warningText, fontWeight: "900", marginTop: 4, textAlign: "center" }, rebuildFinancePaid: { color: Colors.primary, fontWeight: "900", marginTop: 4, textAlign: "center" }, rebuildFinanceRemaining: { color: Colors.dangerText, fontWeight: "900", marginTop: 4, textAlign: "center" },
  headerSubtitle: { ...Typography.caption, color: Colors.slate500, marginTop: 2, textAlign: "right" },
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
  addStudentFromAttendance: {
    marginTop: Spacing.md,
    minHeight: 44,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.primaryLight,
    backgroundColor: Colors.primaryMuted,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
  },
  addStudentFromAttendanceText: {
    color: Colors.primary,
    fontWeight: "800",
    fontSize: 13,
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
  notesHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  notesLink: { color: Colors.primary, fontSize: 12, fontWeight: "800" },
  noteCard: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm, padding: Spacing.md },
  noteText: { flex: 1, color: Colors.slate700, textAlign: "right", lineHeight: 20 },
  emptyNote: { color: Colors.slate500, fontSize: 12, textAlign: "right", paddingVertical: Spacing.sm },
  financialHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: Spacing.sm },
  financialHint: { ...Typography.caption, color: Colors.slate500, textAlign: "right", marginTop: 2 },
  paymentHistory: { marginTop: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.sm },
  paymentHistoryTitle: { ...Typography.bodyBold, color: Colors.slate800, textAlign: "right", marginBottom: Spacing.xs },
  paymentHistoryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.slate100 },
  paymentHistoryAmount: { ...Typography.bodyBold, color: Colors.slate900 },
  paymentHistoryMeta: { ...Typography.caption, color: Colors.slate500, marginTop: 2 },
  paymentHistoryType: { ...Typography.captionBold, color: Colors.primary },
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
  confirmSheet: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    width: "100%",
    maxWidth: 420,
    ...Shadows.elevated,
  },
  confirmIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    marginBottom: Spacing.sm,
  },
  confirmQuestion: {
    color: Colors.slate700,
    fontSize: 15,
    lineHeight: 24,
    textAlign: "right",
    marginTop: Spacing.sm,
  },
  confirmGroup: {
    color: Colors.primaryDark,
    fontSize: 14,
    fontWeight: "800",
    textAlign: "right",
    marginTop: Spacing.sm,
  },
  modalButtonRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 10, fontSize: 14, color: Colors.slate500 },
});
