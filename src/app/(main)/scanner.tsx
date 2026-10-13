import { Ionicons } from "@expo/vector-icons";
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
import {
  DuplicateAttendanceError,
  getUserErrorMessage,
} from "../../core/errors";
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
import { recordScannedAttendanceIfEligible } from "../../features/attendance/barcodeAttendance";
import { requiresAttendanceConfirmation } from "../../features/attendance/attendanceConfirmation";
import { AttendanceSessionService, AttendanceSummary } from "../../features/attendance/AttendanceSessionService";
import { MakeupService } from "../../features/attendance/MakeupService";
import { findPreviousSessionAbsence } from "../../features/attendance/previousSessionAbsence";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { HomeworkEvaluationRepository } from "../../features/homework/HomeworkEvaluationRepository";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { getDebtCyclePeriodLabel, getPaymentDescription } from "../../features/payments/paymentPresentation";
import { SessionRepository } from "../../features/sessions/SessionRepository";
import { SessionClosingService } from "../../features/sessions/SessionClosingService";
import { sortSessionsByActivation } from "../../features/sessions/sessionOrdering";
import { ScannerService } from "../../features/scanner/ScannerService";
import { StudentRepository } from "../../features/students/StudentRepository";
import { StudentNoteRepository } from "../../features/students/StudentNoteRepository";
import { getStudentColorPresentation } from "../../features/students/studentColor";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { formatLocalDate, formatLocalDateTime, getLocalDateOnly } from "../../shared/utils/date";
import { TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR } from "../../shared/utils/teacherWeeks";
import { searchAttendanceStudents } from "../../features/attendance/attendanceStudentSearch";
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
    DebtCycle,
    Group,
    Session,
    Student,
    StudentNote,
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
  const canViewPayments = PermissionService.hasPermission(currentUser?.permissions || [], "payments.view");
  const canCreatePayment = PermissionService.hasPermission(currentUser?.permissions || [], "payments.create");
  const canManageStudentNotes = PermissionService.hasPermission(currentUser?.permissions || [], "students.update");
  const activeCenterId = useAuthStore((state) => state.activeCenterId);
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);
  const { attendanceSessionId, addedStudentId } = useLocalSearchParams<{ attendanceSessionId?: string; addedStudentId?: string }>();
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [manualCode, setManualCode] = useState("00125");
  const [isProcessing, setIsProcessing] = useState(false);
  const attendanceSubmissionRef = useRef(false);

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
  const [sessionActivationTimes, setSessionActivationTimes] = useState<Map<string, string>>(() => new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [attendanceStarted, setAttendanceStarted] = useState(false);
  const [isStartingAttendance, setIsStartingAttendance] = useState(false);
  const [attendanceSummary, setAttendanceSummary] = useState<AttendanceSummary | null>(null);
  const [makeupNotice, setMakeupNotice] = useState<{ sourceGroupName?: string; teacherName?: string; originalAbsenceId?: string } | null>(null);
  const [showMakeupExpiredModal, setShowMakeupExpiredModal] = useState(false);
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
  const [attendanceNotes, setAttendanceNotes] = useState<StudentNote[]>([]);
  const [editingAttendanceNoteId, setEditingAttendanceNoteId] = useState<string | null>(null);
  const [attendanceNoteToDelete, setAttendanceNoteToDelete] = useState<StudentNote | null>(null);
  const [attendanceNoteError, setAttendanceNoteError] = useState<string | null>(null);
  const [previousAbsenceNotice, setPreviousAbsenceNotice] = useState<{ sessionDate: string; groupName?: string } | null>(null);
  const [homeworkStatuses, setHomeworkStatuses] = useState<import("../../shared/types").HomeworkEvaluationStatus[]>([]);
  const [homeworkEvaluation, setHomeworkEvaluation] = useState<import("../../shared/types").SessionHomeworkEvaluation | null>(null);
  const [homeworkError, setHomeworkError] = useState<string | null>(null);

  // Quick Payment Modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentPurpose, setPaymentPurpose] = useState<"session" | "cycle">("session");
  const [isAdvancePayment, setIsAdvancePayment] = useState(false);
  const [selectedPaymentCycleId, setSelectedPaymentCycleId] = useState<string | null>(null);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const paymentSubmissionRef = useRef(false);
  const [paymentFormError, setPaymentFormError] = useState("");
  const [financialExpanded, setFinancialExpanded] = useState(true);

  const isScanningBlockedRef = useRef(false);
  const isStartingAttendanceRef = useRef(false);
  const lastScannedRef = useRef<{ code: string; at: number } | null>(null);
  const returnedStudentHandledRef = useRef<string | null>(null);
  const displayedStudentIdRef = useRef<string | null>(null);
  const pendingAttendanceStudentIdRef = useRef<string | null>(null);

  const refreshDisplayedStudents = useCallback(() => {
    const studentIds = Array.from(new Set([
      displayedStudentIdRef.current,
      pendingAttendanceStudentIdRef.current,
    ].filter((id): id is string => Boolean(id))));
    if (studentIds.length === 0) return;

    const refreshedStudents = new Map<string, Student>();
    try {
      for (const studentId of studentIds) {
        const refreshed = StudentRepository.findByIdForAttendance(studentId);
        if (refreshed) refreshedStudents.set(studentId, refreshed);
      }
    } catch (error) {
      console.error("Failed to refresh the selected attendance student.", error);
      return;
    }

    const displayedStudentId = displayedStudentIdRef.current;
    if (displayedStudentId) {
      const refreshed = refreshedStudents.get(displayedStudentId);
      if (refreshed) setStudent(refreshed);
    }
    setPendingAttendance((current) => {
      if (!current) return current;
      const refreshed = refreshedStudents.get(current.student.id);
      return refreshed ? { ...current, student: refreshed } : current;
    });
  }, []);

  const refreshTodayData = useCallback(() => {
    try {
      setTodayGroups(AttendanceSessionService.getTodayGroups());
      const sessions = AttendanceSessionService.getTodaySessions();
      setActiveSessionsByGroup(Object.fromEntries(sessions.map((session) => [`${session.groupId}:${session.scheduleId}`, session])));
      setSessionActivationTimes(SessionRepository.getActivationTimestamps(sessions.map((session) => session.id)));
      setAllGroups(GroupRepository.getAll());
      setAllStudents(StudentRepository.getAllForAttendance());
      try {
        setHomeworkStatuses(HomeworkEvaluationRepository.listStatuses());
        setHomeworkError(null);
      } catch (error) {
        setHomeworkStatuses([]);
        setHomeworkError(getUserErrorMessage(error));
      }
    } catch (error) {
      setTodayGroups([]);
      setAllGroups([]);
      setActiveSessionsByGroup({});
      setSessionActivationTimes(new Map());
      setSearchError(getUserErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    displayedStudentIdRef.current = student?.id ?? null;
    pendingAttendanceStudentIdRef.current = pendingAttendance?.student.id ?? null;
  }, [student?.id, pendingAttendance?.student.id]);

  useEffect(() => {
    const sessionId = activeSessionId || selectedSessionId;
    if (!student || !sessionId) {
      setHomeworkEvaluation(null);
      setHomeworkError(null);
      return;
    }
    try {
      setHomeworkEvaluation(HomeworkEvaluationRepository.getForSession(sessionId, student.id));
      setHomeworkError(null);
    } catch (error) {
      setHomeworkEvaluation(null);
      setHomeworkError(getUserErrorMessage(error));
    }
  }, [student?.id, activeSessionId, selectedSessionId, localDataRevision]);

  useEffect(() => {
    if (!student) {
      setAttendanceNotes([]);
      return;
    }
    try {
      setAttendanceNotes(StudentNoteRepository.listForStudent(student.id));
    } catch (error) {
      console.warn("Failed to load student notes in attendance.", error);
      setAttendanceNotes([]);
    }
  }, [student?.id, localDataRevision]);

  const saveHomeworkEvaluation = (statusId: string | null) => {
    const sessionId = activeSessionId || selectedSessionId;
    if (!student || !sessionId) return;
    try {
      const result = HomeworkEvaluationRepository.setForSession(sessionId, student.id, statusId);
      setHomeworkEvaluation(result);
      setHomeworkError(null);
    } catch (error: any) {
      Alert.alert("تعذر حفظ تقييم الواجب", getUserErrorMessage(error));
    }
  };

  const handleAttendanceAction = () => {
    if (!student || isAlreadyAttended || attendanceResult) return;
    const session = eligibleSessions.find((item) => item.id === selectedSessionId)
      || (activeSessionId ? SessionRepository.findById(activeSessionId) : null);
    if (!session) {
      Alert.alert(Strings.errorTitle, "لا توجد جلسة حضور محددة لهذا الطالب.");
      return;
    }

    if (requiresAttendanceConfirmation(Boolean(makeupNotice), isExternalAttendance)) {
      requestAttendanceConfirmation();
      return;
    }

    void recordAttendanceFor(student, session);
  };

  // Refresh when the screen becomes active. Deduplication ensures we don't
  // double-load when focus and revision fire at the same time.
  useFocusEffect(useCallback(() => {
    hasInitialLoadedRef.current = true;
    lastLoadedRevisionRef.current = localDataRevision;
    refreshTodayData();
    refreshDisplayedStudents();
  }, [refreshTodayData, refreshDisplayedStudents, localDataRevision]));

  // React to local data changes (attendance recorded on another screen, sync, etc.)
  useEffect(() => {
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      refreshTodayData();
      refreshDisplayedStudents();
    }
  }, [localDataRevision, refreshTodayData, refreshDisplayedStudents]);

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

  const startAttendance = (requestedGroupId?: string, requestedScheduleId?: string, openExistingOnly = false) => {
    if (isStartingAttendanceRef.current) return;
    const groupId = requestedGroupId || selectedGroupId;
    const scheduleId = requestedScheduleId || selectedScheduleId || undefined;
    if (!groupId) return;

    isStartingAttendanceRef.current = true;
    setIsStartingAttendance(true);
    try {
      setSearchError(null);
      const selectedGroup = GroupRepository.findById(groupId);
      if (!selectedGroup || selectedGroup.status !== "active") {
        throw new Error("المجموعة غير موجودة أو غير مفعلة في المركز الحالي.");
      }
      if (!activeCenterId) throw new Error("يجب تحديد المركز الحالي.");

      const sessionDate = getLocalDateOnly();
      const session = AttendanceSessionService.ensureSessionForGroup(groupId, sessionDate, scheduleId);
      if (
        session.centerId !== activeCenterId ||
        session.groupId !== selectedGroup.id ||
        session.sessionDate !== sessionDate ||
        (scheduleId && session.scheduleId !== scheduleId)
      ) {
        throw new Error("بيانات الجلسة لا تطابق المجموعة أو المركز الحالي.");
      }
      if (openExistingOnly && session.status !== "open") {
        throw new Error("لم تعد هذه الجلسة نشطة. حدّث القائمة واختر الإجراء المناسب.");
      }

      if (session.status === "closed") {
        if (!PermissionService.hasPermission(currentUser?.permissions, "sessions.reopen")) {
          throw new Error("ليس لديك صلاحية إعادة فتح الجلسة.");
        }
        SessionClosingService.reopenSession(session.id, "استكمال تسجيل حضور نفس الجلسة");
      } else if (session.status !== "scheduled" && session.status !== "open") {
        throw new Error("لا يمكن بدء الحضور لهذه الجلسة بحالتها الحالية.");
      }
      AttendanceSessionService.activate(session.id);

      const activeSession: Session = session.status === "open"
        ? session
        : { ...session, status: "open" };
      const sessionKey = `${selectedGroup.id}:${session.scheduleId || scheduleId || ""}`;
      setSelectedGroupId(selectedGroup.id);
      setSelectedScheduleId(session.scheduleId || scheduleId || null);
      setActiveSessionsByGroup((current) => ({ ...current, [sessionKey]: activeSession }));
      setActiveSessionId(session.id);
      setCurrentGroupLabel([selectedGroup.name, selectedGroup.subjectName, selectedGroup.teacherName].filter(Boolean).join(" • "));
      setIsSessionClosed(false);
      setAttendanceStarted(true);
      setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
      refreshTodayData();
    } catch (error) {
      setSearchError(getUserErrorMessage(error));
    } finally {
      isStartingAttendanceRef.current = false;
      setIsStartingAttendance(false);
    }
  };

  const handleGroupPress = (group: Group, scheduleId: string, activeSession?: Session) => {
    if (isStartingAttendanceRef.current) return;
    if (activeSession?.status === "open") {
      startAttendance(group.id, scheduleId, true);
      return;
    }
    setSelectedGroupId(group.id);
    setSelectedScheduleId(scheduleId);
    setActiveSessionId(null);
    setSearchError(null);
  };

  const visibleGroupSchedules = useMemo(() => {
    const today = getLocalDateOnly();
    const todayDayOfWeek = new Date(`${today}T12:00:00`).getDay();
    const entries = (showAllGroups ? allGroups : todayGroups).flatMap((group) =>
      GroupScheduleRepository.getSchedulesForGroup(group.id)
        .filter((schedule) => showAllGroups || schedule.dayOfWeek === todayDayOfWeek)
        .map((schedule) => ({
          group,
          schedule,
          activeSession: activeSessionsByGroup[`${group.id}:${schedule.id}`],
        })),
    );
    const orderedActiveSessions = sortSessionsByActivation(
      Object.values(activeSessionsByGroup).filter((session) => session.status === "open"),
      sessionActivationTimes,
    );
    const activeSessionRank = new Map(orderedActiveSessions.map((session, index) => [session.id, index]));

    return entries.sort((left, right) => {
      const leftRank = left.activeSession?.status === "open"
        ? activeSessionRank.get(left.activeSession.id) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER;
      const rightRank = right.activeSession?.status === "open"
        ? activeSessionRank.get(right.activeSession.id) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.group.id.localeCompare(right.group.id) || left.schedule.id.localeCompare(right.schedule.id);
    });
  }, [activeSessionsByGroup, allGroups, sessionActivationTimes, showAllGroups, todayGroups]);

  const selectedSession = selectedGroupId
    ? activeSessionsByGroup[`${selectedGroupId}:${selectedScheduleId || ""}`]
    : undefined;

  // Reset student search
  const handleReset = () => {
    setPendingAttendance(null);
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
    setPreviousAbsenceNotice(null);
    setAttendanceNotes([]);
    setAttendanceNoteText("");
    setEditingAttendanceNoteId(null);
    setAttendanceNoteToDelete(null);
    setShowAttendanceNoteModal(false);
    setAttendanceNoteError(null);
    setShowMakeupExpiredModal(false);
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

  const lookupCard = async (rawCode: string, forcedStudent?: Student, allowExternal = false, isBarcodeScan = false) => {
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
      setPreviousAbsenceNotice(null);
      if (currentSession) {
        try {
          const previousSessionRecord = findPreviousSessionAbsence(
            AttendanceRepository.getStudentAttendance(foundStudent.id),
            currentSession,
          );
          if (previousSessionRecord) {
            setPreviousAbsenceNotice({
              sessionDate: previousSessionRecord.sessionDate,
              groupName: previousSessionRecord.groupName,
            });
          }
        } catch (error) {
          console.warn("Failed to verify the student's previous session absence.", error);
        }
      }
      
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
          setSearchError("الطالب لا ينتمي إلى المجموعة أو المستوى المحدد، ولا توجد له حصة تعويضية مؤهلة.");
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
        await recordScannedAttendanceIfEligible({
          isBarcodeScan,
          isExpectedInSession: expected,
          isMakeupEligible: makeupEligibility.eligible,
          isAlreadyAttended: attended,
          isSessionOpen: sessions[0].status === "open",
        }, () => recordAttendanceFor(foundStudent, sessions[0]));
      } else if (sessions.length > 1) {
        setSelectedSessionId(null);
        setIsAlreadyAttended(false);
      }

      // Load financial status calculated dynamically
      if (paymentsEnabled && canViewPayments) {
        const fin = FinancialCalculationService.getStudentFinancialStatus(foundStudent.id);
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
    setIsCameraActive(false);
    setManualCode(data);
    // Cards can belong to another group; allow lookup to resolve a valid
    // same-teacher makeup instead of hiding the student behind the roster.
    lookupCard(data, undefined, true, true);
  };

  const attendancePickerStudents = useMemo(() => {
    if (!activeSessionId) return [];
    const session = SessionRepository.findById(activeSessionId);
    const groupGrade = allGroups.find((group) => group.id === session?.groupId)?.grade;
    return searchAttendanceStudents(allStudents, allStudentSearch, groupGrade);
  }, [activeSessionId, allGroups, allStudentSearch, allStudents]);

  const openAttendanceNotes = async () => {
    if (!student) return;
    try {
      setAttendanceNotes(StudentNoteRepository.listForStudent(student.id));
      setAttendanceNoteText("");
      setEditingAttendanceNoteId(null);
      setAttendanceNoteError(null);
      setShowAttendanceNoteModal(true);
    } catch (error) {
      Alert.alert(Strings.errorTitle, getUserErrorMessage(error));
    }
  };

  const editAttendanceNote = (note: StudentNote) => {
    if (!canManageStudentNotes) return;
    setEditingAttendanceNoteId(note.id);
    setAttendanceNoteText(note.text);
    setAttendanceNoteError(null);
    setShowAttendanceNoteModal(true);
  };

  const saveAttendanceNote = () => {
    if (!student || !canManageStudentNotes) return;
    if (!attendanceNoteText.trim()) {
      setAttendanceNoteError("اكتب نص الملاحظة أولًا.");
      return;
    }
    try {
      if (editingAttendanceNoteId) {
        StudentNoteRepository.update(editingAttendanceNoteId, attendanceNoteText);
      } else {
        StudentNoteRepository.create(student.id, attendanceNoteText);
      }
      setAttendanceNotes(StudentNoteRepository.listForStudent(student.id));
      setAttendanceNoteText("");
      setEditingAttendanceNoteId(null);
      setAttendanceNoteError(null);
    } catch (error) {
      setAttendanceNoteError(getUserErrorMessage(error));
    }
  };

  const confirmRemoveAttendanceNote = () => {
    if (!student || !attendanceNoteToDelete || !canManageStudentNotes) return;
    try {
      StudentNoteRepository.remove(attendanceNoteToDelete.id);
      setAttendanceNotes(StudentNoteRepository.listForStudent(student.id));
      if (editingAttendanceNoteId === attendanceNoteToDelete.id) {
        setAttendanceNoteText("");
        setEditingAttendanceNoteId(null);
      }
      setAttendanceNoteToDelete(null);
      setAttendanceNoteError(null);
    } catch (error) {
      setAttendanceNoteError(getUserErrorMessage(error));
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
    if (attendanceSubmissionRef.current) return;
    attendanceSubmissionRef.current = true;
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
    } catch (err: unknown) {
      if (err instanceof DuplicateAttendanceError) {
        setAttendanceResult(null);
        setIsAlreadyAttended(true);
      } else if (makeup && err instanceof Error && err.message === TEACHER_MAKEUP_CYCLE_EXPIRED_ERROR) {
        setShowMakeupExpiredModal(true);
      } else {
        Alert.alert(Strings.errorTitle, getUserErrorMessage(err));
      }
    } finally {
      attendanceSubmissionRef.current = false;
      setIsProcessing(false);
    }
  };

  // Return to the same open session after student creation. The enrollment is
  // verified and appended to that session's expected roster before recording.
  useEffect(() => {
    if (!attendanceSessionId || !addedStudentId || returnedStudentHandledRef.current === String(addedStudentId)) return;
    returnedStudentHandledRef.current = String(addedStudentId);
    void (async () => {
      try {
        const session = SessionRepository.findById(String(attendanceSessionId));
        const createdStudent = StudentRepository.findById(String(addedStudentId));
        if (!session || !createdStudent) throw new Error("تعذر تحميل الطالب أو جلسة الحضور بعد الإضافة.");
        if (session.status !== "open") throw new Error("أُضيف الطالب، لكن جلسة الحضور لم تعد مفتوحة.");

        AttendanceSessionService.addEnrolledStudentToOpenSession(session.id, createdStudent.id);
        if (!AttendanceSessionService.isExpected(session.id, createdStudent.id)) {
          throw new Error("لم يتم التحقق من عضوية الطالب في المجموعة الحالية؛ لم يُسجل الحضور.");
        }

        setPendingAttendance(null);
        setAttendanceStarted(true);
        setActiveSessionId(session.id);
        setSelectedGroupId(session.groupId);
        setSelectedScheduleId(session.scheduleId || null);
        setIsSessionClosed(false);
        setAttendanceSummary(AttendanceSessionService.getSummary(session.id));
        setStudent(createdStudent);
        setCurrentGroupLabel([session.groupName, session.subjectName, session.teacherName].filter(Boolean).join(" • "));
        setMakeupNotice(null);
        setIsExternalAttendance(false);
        setEligibleSessions([session]);
        setSelectedSessionId(session.id);
        setIsAlreadyAttended(AttendanceRepository.isAlreadyAttended(session.id, createdStudent.id));
        setAttendanceResult(null);
        setSearchError(null);

        if (!AttendanceRepository.isAlreadyAttended(session.id, createdStudent.id)) {
          await recordAttendanceFor(createdStudent, session);
        }
      } catch (error) {
        Alert.alert("تعذر تسجيل الحضور", getUserErrorMessage(error));
      }
    })();
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

  const paymentCyclesForPurpose = (
    status: DetailedStudentFinancialStatus,
    purpose: "session" | "cycle",
  ) => status.cycles.filter((cycle) => purpose === "session"
    ? cycle.billingMode === "per_session" || cycle.cycleType === "per_session"
    : (cycle.remainingDebt ?? 0) > 0);

  const getSessionOutstandingForCycle = (
    studentId: string,
    status: DetailedStudentFinancialStatus,
    cycle?: DebtCycle,
  ) => cycle?.groupId
    ? Number(FinancialCalculationService.getStudentFinancialStatusForGroup(studentId, cycle.groupId).currentPeriodDebt || 0)
    : Number(status.currentPeriodDebt || 0);

  const openQuickPaymentModal = (advance = false) => {
    if (!student || !financialStatus || !canCreatePayment) return;
    const initialPurpose = advance || financialStatus.monthlyRemainingDebt > 0 ? "cycle" : "session";
    const cycles = paymentCyclesForPurpose(financialStatus, initialPurpose);
    const selectedCycle = cycles.length === 1 ? cycles[0] : undefined;
    const due = initialPurpose === "cycle"
      ? Number(selectedCycle?.remainingDebt ?? financialStatus.monthlyRemainingDebt)
      : getSessionOutstandingForCycle(student.id, financialStatus, selectedCycle);
    setPaymentPurpose(initialPurpose);
    setIsAdvancePayment(advance);
    setSelectedPaymentCycleId(selectedCycle?.id || null);
    setPaymentNotes("");
    setPaymentFormError("");
    setPaymentAmount(!advance && due > 0 && cycles.length <= 1 ? String(due) : "");
    setShowPaymentModal(true);
  };

  const handleConfirmQuickPayment = async () => {
    if (paymentSubmissionRef.current || !student || !canCreatePayment) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentFormError("يرجى إدخال مبلغ صحيح أكبر من صفر.");
      return;
    }

    paymentSubmissionRef.current = true;
    setIsRecordingPayment(true);
    setPaymentFormError("");
    try {
      const latestStatus = FinancialCalculationService.getStudentFinancialStatus(student.id);
      setFinancialStatus(latestStatus);
      const cycles = paymentCyclesForPurpose(latestStatus, isAdvancePayment ? "cycle" : paymentPurpose);
      const cycle = cycles.find((item) => item.id === selectedPaymentCycleId)
        || (cycles.length === 1 ? cycles[0] : undefined);
      if (!isAdvancePayment && cycles.length > 1 && !cycle) {
        throw new Error(paymentPurpose === "session"
          ? "اختر مجموعة رسوم الحصص التي ستُنسب إليها الدفعة."
          : "اختر الاشتراك أو الباقة التي ستُنسب إليها الدفعة.");
      }
      const outstanding = paymentPurpose === "cycle"
        ? Number(cycle?.remainingDebt ?? latestStatus.monthlyRemainingDebt ?? 0)
        : getSessionOutstandingForCycle(student.id, latestStatus, cycle);
      if (!isAdvancePayment && outstanding <= 0) {
        throw new Error("لا يوجد مبلغ مستحق للتحصيل عن هذا الالتزام.");
      }
      if (!isAdvancePayment && amount > outstanding + 0.000001) {
        throw new Error(`المبلغ يتجاوز المتبقي المستحق (${formatCurrency(outstanding)}).`);
      }

      const paymentType = !isAdvancePayment && paymentPurpose === "session"
        ? "session"
        : cycle && amount >= Number(cycle.remainingDebt ?? 0) ? "monthly" : "partial";
      await PaymentRepository.recordPayment({
        studentId: student.id,
        amount,
        paymentType,
        debtCycleId: cycle?.id,
        subscriptionId: cycle?.packageSubscriptionId,
        notes: paymentNotes.trim() || undefined,
        allowCreditBalance: isAdvancePayment,
      });

      setFinancialStatus(FinancialCalculationService.getStudentFinancialStatus(student.id));
      setShowPaymentModal(false);
      setPaymentAmount("");
      setPaymentNotes("");
      setIsAdvancePayment(false);
      Alert.alert("نجاح", Strings.paymentRecordedSuccess);
    } catch (err) {
      setPaymentFormError(getUserErrorMessage(err));
    } finally {
      paymentSubmissionRef.current = false;
      setIsRecordingPayment(false);
    }
  };

  // Rebuilt attendance composition. The legacy JSX below is intentionally
  // unreachable while the migration is in progress; all business logic above
  // (repositories, offline queue, makeup rules and payment handling) is shared.
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.rebuildHeader}>
        <TouchableOpacity onPress={attendanceStarted ? handleBackToGroups : () => router.back()} style={styles.rebuildBack}>
          <Ionicons name="chevron-forward" size={22} color={Colors.slate900} />
        </TouchableOpacity>
        <View style={styles.rebuildHeaderCopy}>
          <Text style={styles.rebuildTitle}>{attendanceStarted ? "حضور الجلسة" : "جلسات الحضور"}</Text>
          <Text numberOfLines={2} style={styles.rebuildSubtitle}>
            {attendanceStarted ? currentGroupLabel : "اختر مجموعة لبدء تسجيل الحضور"}
          </Text>
        </View>
        {attendanceStarted ? (
          <View style={styles.attendanceHeaderActions}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="البحث عن طالب"
              onPress={() => { setAllStudentSearch(""); setShowAllStudentPicker(true); }}
              style={styles.headerMenu}
            >
              <Ionicons name="search-outline" size={20} color={Colors.primary} />
            </TouchableOpacity>
            {student ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="ملاحظات الطالب"
                onPress={() => void openAttendanceNotes()}
                style={styles.headerMenu}
              >
                <Ionicons name="create-outline" size={20} color={Colors.primary} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={isSessionClosed ? "إعادة فتح الجلسة" : "إغلاق الجلسة"}
              onPress={isSessionClosed ? reopenCurrentSession : closeCurrentSession}
              style={styles.headerMenu}
            >
              <Ionicons name={isSessionClosed ? "lock-open-outline" : "ellipsis-horizontal"} size={20} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
      {!attendanceStarted ? (
        <ScrollView contentContainerStyle={styles.rebuildContent}>
          <View style={styles.startAttendancePanel}>
            <Text style={styles.rebuildSectionTitle}>مجموعات اليوم</Text>
            <View style={styles.attendanceFilterRow}>
              <TouchableOpacity style={[styles.attendanceFilter, !showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(false)}>
                <Text style={[styles.attendanceFilterText, !showAllGroups && styles.attendanceFilterTextActive]}>اليوم</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.attendanceFilter, showAllGroups && styles.attendanceFilterActive]} onPress={() => setShowAllGroups(true)}>
                <Text style={[styles.attendanceFilterText, showAllGroups && styles.attendanceFilterTextActive]}>كل المجموعات</Text>
              </TouchableOpacity>
            </View>
            {visibleGroupSchedules.map(({ group, schedule, activeSession }) => {
              const key = `${group.id}:${schedule.id}`;
              const selected = selectedGroupId === group.id && selectedScheduleId === schedule.id;
              const statusLabel = activeSession?.status === "open"
                ? "جلسة نشطة، اضغط للمتابعة"
                : activeSession?.status === "closed"
                  ? "جلسة مغلقة"
                  : "لم تبدأ الجلسة";
              return (
                <TouchableOpacity
                  key={key}
                  disabled={isStartingAttendance}
                  onPress={() => handleGroupPress(group, schedule.id, activeSession)}
                  style={[styles.rebuildGroupRow, selected && styles.rebuildGroupRowActive]}
                >
                  <View style={styles.rebuildGroupIcon}><Ionicons name="people-outline" size={20} color={Colors.primary} /></View>
                  <View style={styles.rebuildGroupCopy}>
                    <Text style={styles.rebuildGroupName}>{group.name}</Text>
                    <Text style={styles.rebuildGroupMeta}>{[group.subjectName, group.grade, group.teacherName].filter(Boolean).join(" · ")}</Text>
                    <Text style={styles.rebuildGroupMeta}>{DAYS_OF_WEEK[schedule.dayOfWeek]} · {formatTimeArabic(schedule.startTime)} - {formatTimeArabic(schedule.endTime)}</Text>
                    <Text style={[styles.rebuildGroupMeta, activeSession?.status === "open" ? styles.groupAttendanceStateActive : null]}>{statusLabel}</Text>
                  </View>
                  <Ionicons name="chevron-back" size={18} color={Colors.slate400} />
                </TouchableOpacity>
              );
            })}
            <AppButton
              title={isStartingAttendance ? "جارٍ فتح الجلسة..." : selectedSession?.status === "closed" ? "إعادة فتح الجلسة" : "بدء جلسة الحضور"}
              onPress={() => startAttendance()}
              disabled={!selectedGroupId || isStartingAttendance}
              size="lg"
            />
            {searchError ? <Text style={styles.errorAlertText}>{searchError}</Text> : null}
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.rebuildContent} keyboardShouldPersistTaps="handled">
          {attendanceSummary ? (
            <View style={styles.rebuildSummary}>
              <View style={[styles.summaryTile, styles.summaryAll]}>
                <Ionicons name="people" size={19} color={Colors.primary} />
                <Text style={styles.summaryValue}>{attendanceSummary.total}</Text>
                <Text style={styles.summaryLabel}>إجمالي الطلاب</Text>
              </View>
              <View style={[styles.summaryTile, styles.summaryPresent]}>
                <Ionicons name="checkmark-circle" size={19} color={Colors.successText} />
                <Text style={styles.summaryValue}>{attendanceSummary.present}</Text>
                <Text style={styles.summaryLabel}>حاضر</Text>
              </View>
              <View style={[styles.summaryTile, styles.summaryAbsent]}>
                <Ionicons name="close-circle" size={19} color={Colors.dangerText} />
                <Text style={styles.summaryValue}>{attendanceSummary.absent}</Text>
                <Text style={styles.summaryLabel}>غائب</Text>
              </View>
              <View style={[styles.summaryTile, styles.summaryMakeup]}>
                <Ionicons name="sync-outline" size={19} color={Colors.warningText} />
                <Text style={styles.summaryValue}>{attendanceSummary.makeup}</Text>
                <Text style={styles.summaryLabel}>تعويض</Text>
              </View>
            </View>
          ) : null}
          <View style={styles.rebuildScanPanel}>
            <View style={styles.rebuildSearchRow}>
              <View style={styles.rebuildScanInput}>
                <Ionicons name="search-outline" size={20} color={Colors.slate400} />
                <AppInput
                  value={manualCode}
                  onChangeText={setManualCode}
                  placeholder="اسم الطالب أو الكود"
                  containerStyle={{ flex: 1, marginBottom: 0 }}
                />
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.rebuildScanButton}
                onPress={() => {
                  isScanningBlockedRef.current = false;
                  lastScannedRef.current = null;
                  setIsCameraActive(true);
                }}
              >
                <Ionicons name="scan-outline" size={22} color={Colors.white} />
                <Text style={styles.rebuildScanButtonText}>مسح الكود</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.rebuildManualButton}
              onPress={() => {
                setAllStudentSearch(manualCode.trim());
                setShowAllStudentPicker(true);
              }}
            >
              <Text style={styles.rebuildManualText}>بحث بالاسم أو الكود</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.rebuildManualButton}
              onPress={() => lookupCard(manualCode, undefined, true)}
            >
              <Text style={styles.rebuildManualText}>تسجيل مباشر بالكود</Text>
            </TouchableOpacity>
            {isCameraActive ? (
              <BarcodeScannerView
                onDetected={(data) => handleBarcodeScanned({ data })}
                onClose={() => setIsCameraActive(false)}
                title="مسح كارت الطالب"
              />
            ) : null}
          </View>
          {student ? (
            <View style={[
              styles.rebuildStudentCard,
              getStudentColorPresentation(student.studentColor).backgroundColor
                ? { backgroundColor: getStudentColorPresentation(student.studentColor).backgroundColor }
                : null,
              getStudentColorPresentation(student.studentColor).accentColor
                ? { borderColor: getStudentColorPresentation(student.studentColor).accentColor }
                : null,
            ]}>
              <View style={styles.rebuildStudentTop}>
                <View style={styles.rebuildStudentAvatar}>
                  <Ionicons
                    name="person"
                    size={30}
                    color={getStudentColorPresentation(student.studentColor).accentColor || Colors.primary}
                  />
                </View>
                <View style={styles.rebuildStudentCopy}>
                  <Text numberOfLines={1} style={styles.rebuildStudentName}>{student.fullName}</Text>
                  <Text style={styles.rebuildStudentMeta}>كود الطالب: {student.cardCode || student.studentCode}</Text>
                  <Text numberOfLines={2} style={styles.rebuildStudentMeta}>{[student.grade, currentGroupLabel].filter(Boolean).join(" · ")}</Text>
                </View>
                <View style={[
                  styles.rebuildStatus,
                  attendanceResult || isAlreadyAttended ? styles.rebuildStatusPresent : null,
                  makeupNotice && !attendanceResult ? styles.rebuildStatusMakeup : null,
                ]}>
                  <Ionicons
                    name={attendanceResult?.isLate ? "time-outline" : attendanceResult || isAlreadyAttended ? "checkmark-circle" : makeupNotice ? "sync-outline" : "person-outline"}
                    size={20}
                    color={attendanceResult?.isLate ? Colors.warningText : attendanceResult || isAlreadyAttended ? Colors.successText : makeupNotice ? Colors.warningText : Colors.primary}
                  />
                  <Text style={[
                    styles.rebuildStatusText,
                    makeupNotice && !attendanceResult ? styles.rebuildStatusMakeupText : null,
                  ]}>
                    {attendanceResult?.isLate ? "متأخر" : attendanceResult ? "حاضر" : isAlreadyAttended ? "مسجل" : makeupNotice ? "تعويض مستحق" : isExternalAttendance ? "خارج المجموعة" : "جاهز للتسجيل"}
                  </Text>
                  {attendanceResult ? <Text style={styles.attendanceSuccessTitle}>{Strings.attendanceRecordedSuccess}</Text> : null}
                  {isAlreadyAttended && !attendanceResult ? <Text style={styles.duplicateWarningText}>{Strings.duplicateScanWarning}</Text> : null}
                  {attendanceResult?.checkInTime ? <Text style={styles.rebuildTime}>{attendanceResult.checkInTime}</Text> : null}
                </View>
              </View>
              {previousAbsenceNotice ? (
                <View style={styles.previousAbsenceBadge}>
                  <Ionicons name="calendar-outline" size={16} color={Colors.dangerText} />
                  <Text style={styles.previousAbsenceText}>
                    غائب في الحصة السابقة · {previousAbsenceNotice.groupName || "المجموعة"} · {previousAbsenceNotice.sessionDate}
                  </Text>
                </View>
              ) : null}
              {!attendanceResult && !isAlreadyAttended ? (
                <AppButton
                  title={makeupNotice ? "تسجيل حضور تعويضي" : isExternalAttendance ? "تسجيل حضور خارجي" : "تسجيل الحضور"}
                  onPress={handleAttendanceAction}
                  loading={isProcessing}
                  disabled={isSessionClosed}
                  size="md"
                  style={styles.rebuildAttendanceButton}
                />
              ) : null}
              <View style={styles.rebuildActions}>
                <TouchableOpacity style={styles.rebuildSecondaryAction} onPress={handleReset}>
                  <Ionicons name="refresh" size={19} color={Colors.primary} />
                  <Text style={styles.rebuildActionText}>مسح طالب آخر</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.rebuildSecondaryAction}
                  onPress={() => router.push({ pathname: "/(main)/students", params: { add: "1", attendanceSessionId: activeSessionId, groupId: selectedGroupId } } as any)}
                >
                  <Ionicons name="person-add-outline" size={19} color={Colors.primary} />
                  <Text style={styles.rebuildActionText}>إضافة طالب</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
          {student && (activeSessionId || selectedSessionId) ? (
            <View style={styles.homeworkEvaluationBox}>
              <View style={styles.rebuildSectionHeader}>
                <View>
                  <Text style={styles.rebuildSectionTitle}>حالة الواجب</Text>
                  <Text style={styles.rebuildFinanceHint}>{homeworkEvaluation?.statusName || "لم تُسجل حالة لهذه الحصة"}</Text>
                </View>
                <Ionicons name="document-text-outline" size={20} color={Colors.primary} />
              </View>
              {homeworkError ? <Text style={styles.errorAlertText}>{homeworkError}</Text> : homeworkStatuses.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.homeworkStatusChoices}>
                  {homeworkStatuses.map((status) => (
                    <TouchableOpacity
                      key={status.id}
                      onPress={() => saveHomeworkEvaluation(status.id)}
                      style={[styles.homeworkStatusChoice, homeworkEvaluation?.statusId === status.id && styles.homeworkStatusChoiceActive]}
                    >
                      <Text style={[styles.homeworkStatusChoiceText, homeworkEvaluation?.statusId === status.id && styles.homeworkStatusChoiceTextActive]}>
                        {status.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  {homeworkEvaluation ? (
                    <TouchableOpacity onPress={() => saveHomeworkEvaluation(null)} style={styles.homeworkClearChoice}>
                      <Text style={styles.homeworkClearChoiceText}>إزالة</Text>
                    </TouchableOpacity>
                  ) : null}
                </ScrollView>
              ) : <Text style={styles.rebuildEmpty}>لا توجد حالات مفعّلة؛ يمكن لمدير المركز إضافتها من إدارة الأكاديمية.</Text>}
            </View>
          ) : null}
          {student ? (
            <View style={styles.rebuildNotesSection}>
              <View style={styles.rebuildSectionHeader}>
                <View>
                  <Text style={styles.rebuildSectionTitle}>ملاحظات الطالب</Text>
                  <Text style={styles.rebuildFinanceHint}>{attendanceNotes.length ? `${attendanceNotes.length} ملاحظة` : "لا توجد ملاحظات"}</Text>
                </View>
                {canManageStudentNotes ? (
                  <TouchableOpacity onPress={() => void openAttendanceNotes()} style={styles.noteAddButton}>
                    <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
                    <Text style={styles.rebuildLink}>إضافة ملاحظة</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {attendanceNotes.length ? attendanceNotes.map((note) => (
                <View key={note.id} style={styles.rebuildNote}>
                  <View style={styles.noteContent}>
                    <Text style={styles.rebuildNoteText}>{note.text}</Text>
                    <Text style={styles.noteMeta}>
                      {note.createdByName || "مستخدم"} · {formatLocalDateTime(note.createdAt)}
                    </Text>
                  </View>
                  {canManageStudentNotes ? (
                    <View style={styles.noteActions}>
                      <TouchableOpacity accessibilityLabel="تعديل الملاحظة" onPress={() => editAttendanceNote(note)}>
                        <Ionicons name="create-outline" size={19} color={Colors.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="حذف الملاحظة"
                        onPress={() => {
                          setAttendanceNoteError(null);
                          setAttendanceNoteToDelete(note);
                        }}
                      >
                        <Ionicons name="trash-outline" size={19} color={Colors.dangerText} />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              )) : <Text style={styles.rebuildEmpty}>لا توجد ملاحظات لهذا الطالب</Text>}
              {student.notes?.trim() ? (
                <View style={[styles.rebuildNote, styles.legacyStudentNote]}>
                  <Ionicons name="document-text-outline" size={18} color={Colors.slate500} />
                  <Text style={styles.rebuildNoteText}>{student.notes}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {paymentsEnabled && canViewPayments && student && financialStatus ? (
            <View style={styles.rebuildFinance}>
              <TouchableOpacity
                style={styles.rebuildSectionHeader}
                onPress={() => setFinancialExpanded((value) => !value)}
              >
                <View>
                  <Text style={styles.rebuildSectionTitle}>الحالة المالية</Text>
                  <Text style={styles.rebuildFinanceHint}>ملخص الالتزامات وسجل المدفوعات</Text>
                </View>
                <Ionicons name={financialExpanded ? "chevron-up" : "chevron-down"} size={23} color={Colors.primary} />
              </TouchableOpacity>
              <View style={styles.attendanceFinanceSummary}>
                <Text style={styles.attendanceFinanceSummaryTitle}>ملخص الالتزامات</Text>
                <View style={styles.rebuildFinanceTiles}>
                  <View style={styles.attendanceFinanceMetric}>
                    <Text style={styles.rebuildFinanceLabel}>{Strings.totalDueLabel}</Text>
                    <Text style={styles.rebuildFinanceDue}>{formatCurrency(financialStatus.totalDue)}</Text>
                  </View>
                  <View style={styles.attendanceFinanceMetric}>
                    <Text style={styles.rebuildFinanceLabel}>{Strings.totalPaidLabel}</Text>
                    <Text style={styles.rebuildFinancePaid}>{formatCurrency(financialStatus.totalPaid)}</Text>
                  </View>
                  <View style={styles.attendanceFinanceMetric}>
                    <Text style={styles.rebuildFinanceLabel}>{Strings.remainingBalanceLabel}</Text>
                    <Text style={[
                      styles.rebuildFinanceRemaining,
                      { color: financialStatus.totalRemainingDebt > 0 ? Colors.dangerText : Colors.successText },
                    ]}>
                      {formatCurrency(financialStatus.totalRemainingDebt)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.attendanceFinanceHint}>دفعات الحصص المستقلة تظهر منفصلة عن اشتراك المجموعة أو الباقة.</Text>
              </View>
              {Number(financialStatus.creditBalance || 0) > 0 ? (
                <Text style={styles.attendanceFinanceCredit}>رصيد مقدم مرحّل: {formatCurrency(Number(financialStatus.creditBalance || 0))}</Text>
              ) : null}
              {financialExpanded ? (
                <>
                  {financialStatus.sessionDebt && Number(financialStatus.sessionDebt.currentDebt) > 0 ? (
                    <View style={styles.attendanceSessionDebt}>
                      <View style={styles.attendanceFinanceCardHeading}>
                        <View>
                          <Text style={styles.attendanceFinanceRowTitle}>رسوم الحصص المستحقة</Text>
                          <Text style={styles.attendanceFinanceMeta}>
                            {formatLocalDate(financialStatus.sessionDebt.periodStart)} إلى {formatLocalDate(financialStatus.sessionDebt.periodEnd)}
                          </Text>
                        </View>
                        <Text style={styles.attendanceSessionDebtAmount}>{formatCurrency(financialStatus.sessionDebt.currentDebt)}</Text>
                      </View>
                    </View>
                  ) : null}
                  <Text style={styles.attendanceFinanceSubsection}>الاشتراكات الشهرية والباقات</Text>
                  {financialStatus.cycles.filter((cycle) =>
                    cycle.billingMode !== "per_session" && cycle.cycleType !== "per_session",
                  ).length ? financialStatus.cycles
                    .filter((cycle) => cycle.billingMode !== "per_session" && cycle.cycleType !== "per_session")
                    .map((cycle) => {
                      const due = Math.max(0, Number(cycle.effectivePrice ?? cycle.effectiveDue ?? cycle.cyclePrice ?? 0));
                      const paid = Math.max(0, Number(cycle.paidAmount ?? cycle.totalPaid ?? 0));
                      const remaining = Math.max(0, Number(cycle.remainingDebt ?? 0));
                      const progress = due > 0 ? Math.min(100, (paid / due) * 100) : 100;
                      const period = getDebtCyclePeriodLabel(cycle);
                      const statusLabel = cycle.status === "cancelled"
                        ? "ملغي"
                        : due === 0
                          ? "مجاني"
                          : remaining === 0
                            ? Strings.cycleStatusPaid
                            : paid > 0
                              ? Strings.cycleStatusPartial
                              : Strings.cycleStatusOpen;
                      const statusType = cycle.status === "cancelled" ? "neutral" as const
                        : due === 0 || remaining === 0 ? "success" as const
                          : paid > 0 ? "info" as const : "warning" as const;
                      return (
                        <View key={cycle.id} style={styles.attendanceDebtCycleCard}>
                          <View style={styles.attendanceFinanceCardHeading}>
                            <View style={styles.attendanceFinanceRowCopy}>
                              <Text style={styles.attendanceFinanceRowTitle}>
                                {cycle.cycleType === "package" ? "باقة" : "اشتراك شهري"} · {period || `${Strings.cycleNumberPrefix} ${cycle.cycleNumber}`}
                              </Text>
                              <Text style={styles.attendanceFinanceMeta}>{cycle.packageName || cycle.groupName || "التزام مالي"}</Text>
                            </View>
                            <StatusBadge text={statusLabel} type={statusType} />
                          </View>
                          <View style={styles.attendanceCycleMetrics}>
                            <View><Text style={styles.attendanceCycleMetricLabel}>قيمة الالتزام</Text><Text style={styles.attendanceCycleMetricValue}>{formatCurrency(due)}</Text></View>
                            <View><Text style={styles.attendanceCycleMetricLabel}>المدفوع</Text><Text style={[styles.attendanceCycleMetricValue, { color: Colors.primary }]}>{formatCurrency(paid)}</Text></View>
                            <View><Text style={styles.attendanceCycleMetricLabel}>المتبقي</Text><Text style={[styles.attendanceCycleMetricValue, { color: remaining > 0 ? Colors.dangerText : Colors.successText }]}>{formatCurrency(remaining)}</Text></View>
                          </View>
                          <View style={styles.attendanceCycleProgressTrack}>
                            <View style={[styles.attendanceCycleProgress, { width: `${progress}%`, backgroundColor: remaining > 0 ? Colors.primary : Colors.success }]} />
                          </View>
                          {period ? <Text style={styles.attendanceCycleDates}>{formatLocalDate(cycle.startDate)} — {formatLocalDate(cycle.endDate)}</Text> : null}
                        </View>
                      );
                    }) : <Text style={styles.attendanceFinanceEmpty}>لا توجد اشتراكات شهرية أو باقات مسجلة.</Text>}
                  <Text style={styles.attendanceFinanceSubsection}>سجل المدفوعات</Text>
                  {financialStatus.payments.length ? financialStatus.payments.map((payment) => {
                    const cycle = payment.debtCycleId
                      ? financialStatus.cycles.find((item) => item.id === payment.debtCycleId)
                      : undefined;
                    const description = getPaymentDescription(payment, cycle);
                    return (
                      <View key={payment.id} style={styles.attendancePaymentHistoryCard}>
                        <View style={styles.attendanceFinanceRowCopy}>
                          <Text style={[styles.attendanceFinanceRowTitle, payment.isReversed && styles.attendancePaymentReversed]}>
                            {formatCurrency(payment.amount)}
                          </Text>
                          <Text style={styles.attendancePaymentKind}>
                            {description.title}{description.period ? ` — ${description.period}` : ""}
                          </Text>
                          {payment.paymentType !== "session" && !description.period ? (
                            <Text style={styles.attendanceFinanceMeta}>الفترة المستهدفة غير محفوظة في سجل هذه الدفعة.</Text>
                          ) : null}
                          <Text style={styles.attendanceFinanceMeta}>تاريخ العملية: {payment.paymentDate ? formatLocalDate(payment.paymentDate) : "غير متاح"}</Text>
                          <Text style={styles.attendanceFinanceMeta}>وقت التسجيل: {formatLocalDateTime(payment.createdAt)}</Text>
                          {payment.notes ? <Text style={styles.attendanceFinanceMeta}>{payment.notes}</Text> : null}
                        </View>
                        {payment.isReversed ? <StatusBadge text={Strings.reversedBadge} type="danger" /> : null}
                      </View>
                    );
                  }) : <Text style={styles.attendanceFinanceEmpty}>لا توجد مدفوعات مسجلة.</Text>}
                </>
              ) : null}
              {canCreatePayment ? (
                <View style={styles.attendanceFinanceActions}>
                  {financialStatus.totalRemainingDebt > 0 ? (
                    <AppButton
                      title={`تسجيل دفعة · المتبقي ${formatCurrency(financialStatus.totalRemainingDebt)}`}
                      onPress={() => openQuickPaymentModal(false)}
                      disabled={isRecordingPayment}
                      size="md"
                      style={styles.attendanceFinanceAction}
                    />
                  ) : (
                    <View style={styles.attendanceClearedDebt}>
                      <Ionicons name="checkmark-done-circle" size={18} color={Colors.success} />
                      <Text style={styles.attendanceClearedDebtText}>{Strings.noPendingDebt}</Text>
                    </View>
                  )}
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.attendanceAdvanceAction}
                    onPress={() => openQuickPaymentModal(true)}
                    disabled={isRecordingPayment}
                  >
                    <Ionicons name="wallet-outline" size={17} color={Colors.primary} />
                    <Text style={styles.attendanceAdvanceActionText}>إضافة رصيد مقدم</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}
      <Modal
        visible={showPaymentModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isRecordingPayment) setShowPaymentModal(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{isAdvancePayment ? "إضافة رصيد مقدم" : "تسجيل دفعة نقدية"}</Text>
            <Text style={styles.modalSub}>{student?.fullName}</Text>
            {isAdvancePayment ? (
              <Text style={styles.advancePaymentHint}>يُسدد المبلغ المستحق أولًا، ويُرحّل أي فائض إلى رصيد الطالب المقدم.</Text>
            ) : null}
            {paymentFormError ? (
              <View style={styles.paymentFormError}>
                <Ionicons name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={styles.paymentFormErrorText}>{paymentFormError}</Text>
              </View>
            ) : null}
            {!isAdvancePayment ? <View style={styles.paymentPurposeRow}>
              {(["session", "cycle"] as const).map((purpose) => {
                const availableCycles = financialStatus
                  ? paymentCyclesForPurpose(financialStatus, purpose)
                  : [];
                const enabled = purpose === "cycle"
                  ? Number(financialStatus?.monthlyRemainingDebt || 0) > 0
                  : Number(financialStatus?.currentPeriodDebt || 0) > 0;
                return (
                  <TouchableOpacity
                    key={purpose}
                    disabled={!enabled || isRecordingPayment}
                    style={[
                      styles.paymentPurposeButton,
                      paymentPurpose === purpose && styles.paymentPurposeButtonActive,
                      !enabled && styles.paymentPurposeButtonDisabled,
                    ]}
                    onPress={() => {
                      if (!financialStatus || !student) return;
                      const cycles = paymentCyclesForPurpose(financialStatus, purpose);
                      const cycle = cycles.length === 1 ? cycles[0] : undefined;
                      const due = purpose === "cycle"
                        ? Number(cycle?.remainingDebt ?? financialStatus.monthlyRemainingDebt)
                        : getSessionOutstandingForCycle(student.id, financialStatus, cycle);
                      setPaymentPurpose(purpose);
                      setSelectedPaymentCycleId(cycle?.id || null);
                      setPaymentFormError("");
                      setPaymentAmount(due > 0 && cycles.length <= 1 ? String(due) : "");
                    }}
                  >
                    <Text style={[styles.paymentPurposeText, paymentPurpose === purpose && styles.paymentPurposeTextActive]}>
                      {purpose === "session" ? "رسوم الحصص" : "اشتراك / باقة"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View> : null}
            {financialStatus ? (() => {
              const cycles = paymentCyclesForPurpose(financialStatus, isAdvancePayment ? "cycle" : paymentPurpose);
              const selectedCycle = cycles.find((cycle) => cycle.id === selectedPaymentCycleId)
                || (cycles.length === 1 ? cycles[0] : undefined);
              const outstanding = isAdvancePayment || paymentPurpose === "cycle"
                ? Number(selectedCycle?.remainingDebt ?? financialStatus.monthlyRemainingDebt ?? 0)
                : student
                  ? getSessionOutstandingForCycle(student.id, financialStatus, selectedCycle)
                  : 0;
              return (
                <>
                  {cycles.length > 1 ? (
                    <View style={styles.paymentCyclePicker}>
                      <Text style={styles.paymentCycleTitle}>
                        {!isAdvancePayment && paymentPurpose === "session" ? "اختر مجموعة رسوم الحصص" : "اختر الاشتراك أو الباقة"}
                      </Text>
                      {cycles.map((cycle) => (
                        <TouchableOpacity
                          key={cycle.id}
                          style={[
                            styles.paymentCycleOption,
                            selectedPaymentCycleId === cycle.id && styles.paymentCycleOptionActive,
                          ]}
                          onPress={() => {
                            const due = isAdvancePayment || paymentPurpose === "cycle"
                              ? Number(cycle.remainingDebt ?? 0)
                              : student ? getSessionOutstandingForCycle(student.id, financialStatus, cycle) : 0;
                            setSelectedPaymentCycleId(cycle.id);
                            setPaymentFormError("");
                            setPaymentAmount(due > 0 ? String(due) : "");
                          }}
                        >
                          <Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text>
                          <Text style={styles.paymentCycleAmount}>
                            المتبقي: {formatCurrency(isAdvancePayment || paymentPurpose === "cycle" ? Number(cycle.remainingDebt ?? 0) : student ? getSessionOutstandingForCycle(student.id, financialStatus, cycle) : 0)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                  <View style={styles.paymentDuePreview}>
                    <Text style={styles.paymentDuePreviewLabel}>
                      {cycles.length > 1 && !selectedCycle
                        ? "إجمالي المتبقي (اختر الالتزام لتحديد قيمته)"
                        : isAdvancePayment ? "المتبقي على الالتزام المحدد" : "المبلغ المستحق عن الالتزام المحدد"}
                    </Text>
                    <Text style={styles.paymentDuePreviewValue}>{formatCurrency(outstanding)}</Text>
                  </View>
                  <AppInput
                    label="المبلغ المدفوع (ج.م)"
                    keyboardType="numeric"
                    value={paymentAmount}
                    onChangeText={(value) => {
                      setPaymentAmount(value);
                      setPaymentFormError("");
                    }}
                  />
                  <AppInput
                    label="ملاحظة الدفع (اختياري)"
                    placeholder="مثال: استكمال باقي الالتزام"
                    value={paymentNotes}
                    onChangeText={setPaymentNotes}
                    multiline
                  />
                </>
              );
            })() : null}
            <View style={styles.modalButtonRow}>
              <AppButton
                title={Strings.confirmPaymentButton}
                onPress={handleConfirmQuickPayment}
                loading={isRecordingPayment}
                disabled={isRecordingPayment || !canCreatePayment}
                variant="success"
                style={{ flex: 1 }}
              />
              <AppButton
                title={Strings.cancelButton}
                variant="outline"
                onPress={() => setShowPaymentModal(false)}
                disabled={isRecordingPayment}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={showAllStudentPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAllStudentPicker(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.confirmSheet}>
            <Text style={styles.modalTitle}>اختيار طالب للحضور</Text>
            <AppInput
              value={allStudentSearch}
              onChangeText={setAllStudentSearch}
              placeholder="ابحث بالاسم أو الهاتف أو الكود"
            />
            <ScrollView style={{ maxHeight: 360 }}>
              {attendancePickerStudents.length > 0 ? (
                attendancePickerStudents.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      styles.rebuildGroupRow,
                      getStudentColorPresentation(item.studentColor).backgroundColor
                        ? {
                            backgroundColor: getStudentColorPresentation(item.studentColor).backgroundColor,
                            borderColor: getStudentColorPresentation(item.studentColor).accentColor,
                          }
                        : null,
                    ]}
                    onPress={() => {
                      setShowAllStudentPicker(false);
                      const code = item.cardCode || item.studentCode || item.phone || "";
                      setManualCode(code);
                      void lookupCard(code, item, true);
                    }}
                  >
                    <View style={styles.rebuildGroupCopy}>
                      <Text style={styles.rebuildGroupName}>{item.fullName}</Text>
                      <Text style={styles.rebuildGroupMeta}>
                        {[item.phone, item.studentCode || item.cardCode, item.grade]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Ionicons name="chevron-back" size={18} color={Colors.slate400} />
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.rebuildEmpty}>
                  {allStudentSearch.trim()
                    ? "لا يوجد طلاب مطابقون في المجموعة أو المستوى المحدد."
                    : "ابحث عن طالب من نطاق هذه المجموعة."}
                </Text>
              )}
            </ScrollView>
            <AppButton
              title="إلغاء"
              variant="outline"
              onPress={() => setShowAllStudentPicker(false)}
            />
          </View>
        </View>
      </Modal>
      <Modal
        visible={showAttendanceNoteModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAttendanceNoteModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{editingAttendanceNoteId ? "تعديل ملاحظة" : "إضافة ملاحظة"}</Text>
            <Text style={styles.modalSub}>{student?.fullName}</Text>
            <AppInput
              value={attendanceNoteText}
              onChangeText={(value) => {
                setAttendanceNoteText(value);
                setAttendanceNoteError(null);
              }}
              placeholder="اكتب ملاحظتك"
              multiline
            />
            {attendanceNoteError ? <Text style={styles.errorAlertText}>{attendanceNoteError}</Text> : null}
            <View style={styles.modalButtonRow}>
              <AppButton title="حفظ" onPress={saveAttendanceNote} style={{ flex: 1 }} />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => {
                  setShowAttendanceNoteModal(false);
                  setAttendanceNoteText("");
                  setEditingAttendanceNoteId(null);
                  setAttendanceNoteError(null);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={attendanceNoteToDelete !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setAttendanceNoteToDelete(null);
          setAttendanceNoteError(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>حذف الملاحظة؟</Text>
            <Text style={styles.modalSub}>سيتم حذف هذه الملاحظة من سجل الطالب.</Text>
            {attendanceNoteError ? <Text style={styles.errorAlertText}>{attendanceNoteError}</Text> : null}
            <View style={styles.modalButtonRow}>
              <AppButton title="حذف" variant="danger" onPress={confirmRemoveAttendanceNote} style={{ flex: 1 }} />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => {
                  setAttendanceNoteToDelete(null);
                  setAttendanceNoteError(null);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={showMakeupExpiredModal} transparent animationType="fade" onRequestClose={() => { setShowMakeupExpiredModal(false); handleReset(); }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>انتهت فرصة التعويض</Text>
            <Text style={styles.modalSub}>انتهت دورة شرح المدرس لهذه الحصة، لذلك لا يمكن تسجيل التعويض الآن.</Text>
            <AppButton title="حسنًا" onPress={() => { setShowMakeupExpiredModal(false); handleReset(); }} />
          </View>
        </View>
      </Modal>
      <Modal visible={Boolean(pendingAttendance && requiresAttendanceConfirmation(Boolean(pendingAttendance.makeup), pendingAttendance.isExternal === true))} transparent animationType="slide" onRequestClose={cancelPendingAttendance}>
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
              <BarcodeScannerView onDetected={(data) => handleBarcodeScanned({ data })} onClose={() => setIsCameraActive(false)} title="مسح كارت الطالب" />
            ) : (
              <View style={styles.cameraPlaceholder}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => { isScanningBlockedRef.current = false; lastScannedRef.current = null; setIsCameraActive(true); }}
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
              onPress={() => router.push({ pathname: "/(main)/students", params: { add: "1", attendanceSessionId: activeSessionId, groupId: selectedGroupId } } as any)}
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
  rebuildHeader: { flexDirection: "row-reverse", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  rebuildBack: { width: 40, height: 40, borderRadius: 13, backgroundColor: Colors.slate50, alignItems: "center", justifyContent: "center" },
  rebuildHeaderCopy: { flex: 1, alignItems: "flex-end", minWidth: 0 },
  rebuildTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" },
  rebuildSubtitle: { ...Typography.caption, color: Colors.slate500, marginTop: 2, textAlign: "right", lineHeight: 17 },
  attendanceHeaderActions: { flexDirection: "row", alignItems: "center", gap: 5 },
  headerMenu: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.primaryMuted, alignItems: "center", justifyContent: "center" },
  rebuildContent: { padding: Spacing.md, gap: Spacing.md, paddingBottom: 112 },
  rebuildSectionTitle: { ...Typography.h3, color: Colors.slate900, textAlign: "right" },
  rebuildGroupRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.md, borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white, marginBottom: Spacing.sm },
  rebuildGroupRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  rebuildGroupIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  rebuildGroupCopy: { flex: 1, alignItems: "flex-end" }, rebuildGroupName: { color: Colors.slate900, fontSize: 15, fontWeight: "900", textAlign: "right" }, rebuildGroupMeta: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" },
  rebuildSummary: { flexDirection: "row-reverse", gap: 7, backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: 8, ...Shadows.card },
  summaryTile: { flex: 1, minHeight: 78, borderRadius: BorderRadius.lg, alignItems: "center", justifyContent: "center", gap: 3, paddingHorizontal: 2 }, summaryAll: { backgroundColor: Colors.primaryMuted }, summaryPresent: { backgroundColor: Colors.successLight }, summaryAbsent: { backgroundColor: Colors.dangerLight }, summaryMakeup: { backgroundColor: Colors.warningLight }, summaryValue: { color: Colors.slate900, fontSize: 21, fontWeight: "900" }, summaryLabel: { color: Colors.slate600, fontSize: 10, fontWeight: "800", textAlign: "center" },
  rebuildScanPanel: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.sm, ...Shadows.card },
  rebuildSearchRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  rebuildScanInput: { flex: 1, minHeight: 48, flexDirection: "row-reverse", alignItems: "center", gap: 7, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, paddingHorizontal: 10 },
  rebuildScanButton: { width: "34%", minHeight: 48, borderRadius: BorderRadius.lg, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 5, paddingHorizontal: 6 },
  rebuildScanButtonText: { color: Colors.white, fontWeight: "900", fontSize: 12 },
  rebuildManualButton: { marginTop: 2, alignSelf: "flex-start", paddingVertical: 7, paddingHorizontal: 5 },
  rebuildManualText: { color: Colors.primary, fontWeight: "800", fontSize: 12 },
  rebuildCamera: { marginTop: Spacing.sm, height: 230, borderRadius: BorderRadius.lg, overflow: "hidden", backgroundColor: Colors.slate900 }, closeCameraButton: { position: "absolute", bottom: 10, alignSelf: "center", backgroundColor: "rgba(15,23,42,.75)", paddingHorizontal: 14, paddingVertical: 7, borderRadius: 9 }, closeCameraText: { color: Colors.white, fontWeight: "800" },
  rebuildStudentCard: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, borderWidth: 1, borderColor: Colors.border, ...Shadows.card },
  rebuildStudentTop: { flexDirection: "row-reverse", alignItems: "center", gap: Spacing.sm },
  rebuildStudentAvatar: { width: 54, height: 54, borderRadius: 27, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  rebuildStudentCopy: { flex: 1, alignItems: "flex-end", minWidth: 0 },
  rebuildStudentName: { color: Colors.slate900, fontSize: 17, fontWeight: "900", textAlign: "right" },
  rebuildStudentMeta: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" },
  rebuildStatus: { borderRadius: BorderRadius.lg, paddingVertical: 7, paddingHorizontal: 9, backgroundColor: Colors.primaryMuted, alignItems: "center", justifyContent: "center", minWidth: 76, maxWidth: 106 },
  rebuildStatusPresent: { backgroundColor: Colors.successLight },
  rebuildStatusMakeup: { backgroundColor: Colors.warningLight },
  rebuildStatusText: { color: Colors.primaryDark, fontSize: 11, fontWeight: "900", marginTop: 2, textAlign: "center" },
  rebuildStatusMakeupText: { color: Colors.warningText },
  rebuildTime: { color: Colors.successText, fontSize: 10, marginTop: 2 },
  rebuildAttendanceButton: { marginTop: Spacing.md },
  previousAbsenceBadge: { flexDirection: "row-reverse", alignItems: "center", gap: 6, marginTop: Spacing.md, paddingHorizontal: 10, paddingVertical: 8, borderRadius: BorderRadius.md, backgroundColor: Colors.dangerLight },
  previousAbsenceText: { flex: 1, color: Colors.dangerText, fontSize: 11, fontWeight: "800", textAlign: "right" },
  rebuildActions: { flexDirection: "row-reverse", gap: 8, marginTop: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.md },
  rebuildSecondaryAction: { flex: 1, minHeight: 43, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primaryLight, alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 5, paddingHorizontal: 4 },
  rebuildActionText: { color: Colors.primary, fontWeight: "800", fontSize: 11, textAlign: "center" },
  homeworkEvaluationBox: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card },
  homeworkStatusChoices: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingTop: Spacing.md },
  homeworkStatusChoice: { minHeight: 42, justifyContent: "center", paddingHorizontal: 14, borderRadius: BorderRadius.lg, backgroundColor: Colors.slate50, borderWidth: 1, borderColor: Colors.border },
  homeworkStatusChoiceActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  homeworkStatusChoiceText: { color: Colors.slate700, fontSize: 13, fontWeight: "800" },
  homeworkStatusChoiceTextActive: { color: Colors.white },
  homeworkClearChoice: { minHeight: 42, justifyContent: "center", paddingHorizontal: 14, borderRadius: BorderRadius.lg, backgroundColor: Colors.dangerLight },
  homeworkClearChoiceText: { color: Colors.dangerText, fontSize: 13, fontWeight: "800" },
  rebuildNotesSection: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card },
  rebuildSectionHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
  rebuildLink: { color: Colors.primary, fontWeight: "800", fontSize: 12 },
  noteAddButton: { flexDirection: "row-reverse", alignItems: "center", gap: 4, padding: 6 },
  rebuildNote: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 8, marginTop: Spacing.sm, padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.slate50 },
  noteContent: { flex: 1, gap: 4 },
  noteMeta: { color: Colors.slate500, fontSize: 10, textAlign: "right" },
  noteActions: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 2 },
  legacyStudentNote: { borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white },
  rebuildNoteText: { flex: 1, color: Colors.slate700, lineHeight: 20, textAlign: "right" },
  rebuildEmpty: { color: Colors.slate500, fontSize: 12, textAlign: "right", marginTop: Spacing.md },
  rebuildFinance: { backgroundColor: Colors.white, borderRadius: BorderRadius.xl, padding: Spacing.md, ...Shadows.card },
  rebuildFinanceHint: { color: Colors.slate500, fontSize: 11, marginTop: 3, textAlign: "right" },
  rebuildFinanceTiles: { flexDirection: "row-reverse", gap: 7, marginTop: Spacing.md, marginBottom: Spacing.md },
  rebuildFinanceLabel: { color: Colors.slate500, fontSize: 11, textAlign: "center" },
  rebuildFinanceDue: { color: Colors.warningText, fontWeight: "900", marginTop: 4, textAlign: "center" },
  rebuildFinancePaid: { color: Colors.primary, fontWeight: "900", marginTop: 4, textAlign: "center" },
  rebuildFinanceRemaining: { color: Colors.dangerText, fontWeight: "900", marginTop: 4, textAlign: "center" },
  attendanceFinanceSummary: { padding: 13, marginTop: 12, borderWidth: 1, borderColor: Colors.slate200, borderRadius: 16, backgroundColor: Colors.white },
  attendanceFinanceSummaryTitle: { color: Colors.slate800, fontSize: 13, fontWeight: "900", textAlign: "right" },
  attendanceFinanceMetric: { flex: 1, minWidth: 0, padding: 9, borderRadius: 11, backgroundColor: Colors.slate50 },
  attendanceFinanceHint: { color: Colors.slate500, fontSize: 10, lineHeight: 15, textAlign: "right", marginTop: 2 },
  attendanceFinanceCredit: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 9 },
  attendanceSessionDebt: { padding: 12, marginTop: 10, borderWidth: 1, borderColor: Colors.warningLight, borderRadius: 13, backgroundColor: Colors.warningLight + "55" },
  attendanceFinanceCardHeading: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8 },
  attendanceFinanceRowCopy: { flex: 1, minWidth: 0, alignItems: "flex-end" },
  attendanceFinanceRowTitle: { color: Colors.slate900, fontSize: 13, fontWeight: "900", textAlign: "right" },
  attendanceFinanceMeta: { color: Colors.slate500, fontSize: 10, lineHeight: 15, textAlign: "right", marginTop: 3 },
  attendanceSessionDebtAmount: { color: Colors.warningText, fontSize: 13, fontWeight: "900" },
  attendanceFinanceSubsection: { marginTop: 18, marginBottom: 7, color: Colors.slate700, fontSize: 12, fontWeight: "900", textAlign: "right" },
  attendanceDebtCycleCard: { padding: 13, marginTop: 9, borderWidth: 1, borderColor: Colors.slate200, borderRadius: 14, backgroundColor: Colors.white },
  attendanceCycleMetrics: { flexDirection: "row-reverse", justifyContent: "space-between", gap: 6, marginTop: 13 },
  attendanceCycleMetricLabel: { color: Colors.slate500, fontSize: 10, textAlign: "right" },
  attendanceCycleMetricValue: { color: Colors.slate800, fontSize: 12, fontWeight: "800", textAlign: "right", marginTop: 3 },
  attendanceCycleProgressTrack: { height: 5, overflow: "hidden", borderRadius: 3, backgroundColor: Colors.slate100, marginTop: 12 },
  attendanceCycleProgress: { height: 5, borderRadius: 3 },
  attendanceCycleDates: { color: Colors.slate400, fontSize: 9, textAlign: "right", marginTop: 7 },
  attendancePaymentHistoryCard: { flexDirection: "row-reverse", alignItems: "flex-start", justifyContent: "space-between", gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: Colors.slate100 },
  attendancePaymentKind: { color: Colors.primaryDark, fontSize: 12, fontWeight: "800", textAlign: "right", marginTop: 2 },
  attendancePaymentReversed: { textDecorationLine: "line-through", color: Colors.slate500 },
  attendanceFinanceEmpty: { color: Colors.slate500, fontSize: 11, textAlign: "right", paddingVertical: 8 },
  attendanceFinanceAction: { marginTop: 12 },
  attendanceFinanceActions: { marginTop: 11, gap: 9 },
  attendanceAdvanceAction: { minHeight: 38, alignSelf: "flex-start", flexDirection: "row-reverse", alignItems: "center", gap: 5, paddingHorizontal: 11, borderWidth: 1, borderColor: Colors.primaryLight, borderRadius: BorderRadius.md, backgroundColor: Colors.primaryMuted },
  attendanceAdvanceActionText: { color: Colors.primary, fontSize: 11, fontWeight: "800" },
  attendanceClearedDebt: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 11 },
  attendanceClearedDebtText: { color: Colors.successText, fontSize: 11, fontWeight: "800" },
  advancePaymentHint: { color: Colors.slate600, fontSize: 11, lineHeight: 17, textAlign: "right", marginBottom: Spacing.sm },
  paymentFormError: { flexDirection: "row-reverse", alignItems: "center", gap: 7, padding: 10, marginBottom: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.dangerLight },
  paymentFormErrorText: { flex: 1, color: Colors.dangerText, fontSize: 12, textAlign: "right" },
  paymentDuePreview: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", padding: 11, marginBottom: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.primaryMuted },
  paymentDuePreviewLabel: { color: Colors.slate700, fontSize: 11, textAlign: "right" },
  paymentDuePreviewValue: { color: Colors.primaryDark, fontSize: 13, fontWeight: "900" },
  paymentPurposeButtonDisabled: { opacity: 0.45 },
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
