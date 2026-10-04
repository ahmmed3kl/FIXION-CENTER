﻿import { Ionicons } from "@expo/vector-icons";
import { useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Alert,
    FlatList,
    Linking,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";
import { formatCurrency, formatTimeArabic, Strings } from "../../core/localization";
import { formatLocalDateTime, getLocalDateOnly } from "../../shared/utils/date";
import { PermissionService } from "../../core/permissions";
import { AuditService } from "../../core/audit";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { EnrollmentRepository } from "../../features/enrollments/EnrollmentRepository";
import { AttendanceRepository } from "../../features/attendance/AttendanceRepository";
import { PackageRepository } from "../../features/packages/PackageRepository";
import { PackageSubscriptionRepository } from "../../features/packages/PackageSubscriptionRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { TeacherSubjectRepository } from "../../features/teachers/TeacherSubjectRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { DebtAdjustmentRepository } from "../../features/payments/DebtAdjustmentRepository";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import { GradeBookRepository, GradeExam, GradeScore } from "../../features/grades/GradeBookRepository";
import { StudentNoteRepository } from "../../features/students/StudentNoteRepository";
import { NotificationService } from "../../features/notifications/NotificationService";
import { StudentCardRepository } from "../../features/students/StudentCardRepository";
import { StudentRepository } from "../../features/students/StudentRepository";
import { smartSearch } from "../../shared/utils/smartSearch";
import { useResponsiveLayout } from "../../shared/utils/responsive";
import { AddStudentWizardModal } from "../../features/students/components/AddStudentWizardModal";
import {
    AppButton,
    AppCard,
    AppInput,
    EmptyState,
    StatusBadge,
} from "../../shared/components";
import { BarcodeScannerView } from "../../shared/components/BarcodeScannerView";
import {
    DebtCycle,
    DetailedStudentFinancialStatus,
    Group,
    PaymentEvent,
    Student,
    StudentPackageSubscription,
    StudentGroupEnrollment,
  StudentGroupAttendanceSummary,
  Attendance,
    Package,
    PackageSubject,
} from "../../shared/types";
import { formatDisplayIdentifier } from "../../shared/utils/formatters";

const WEEK_DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const CODE39_DIGITS: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
  "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  "*": "nwnnwnwnn",
};

function StudentCodeBarcode({ value }: { value: string }) {
  const { width: screenWidth } = useWindowDimensions();
  const normalizedValue = value.trim();
  const encoded = `*${normalizedValue}*`;
  const valid = encoded.length > 2 && [...encoded].every((char) => CODE39_DIGITS[char]);
  if (!valid) return <Text style={{ color: Colors.slate500, textAlign: "center", padding: 18 }}>لا يمكن عرض الرمز بهذا التنسيق.</Text>;
  const narrow = Math.max(1, Math.min(2, (screenWidth - 82) / (encoded.length * 14)));
  return <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "stretch", paddingVertical: 14, paddingHorizontal: 7, backgroundColor: "#FFFFFF" }} accessibilityLabel={`باركود كود الطالب ${value}`}>
    {[...encoded].map((character, charIndex) => <View key={`${charIndex}-${character}`} style={{ flexDirection: "row", marginRight: narrow }}>
      {[...CODE39_DIGITS[character]].map((width, index) => <View key={`${charIndex}-${index}`} style={{ width: width === "w" ? narrow * 2 : narrow, height: 76, backgroundColor: index % 2 === 0 ? "#10233F" : "#FFFFFF" }} />)}
    </View>)}
  </View>;
}

function groupScheduleLabel(groupId: string): string {
  try {
    const schedules = GroupScheduleRepository.getSchedulesForGroup(groupId);
    return schedules.slice(0, 2).map((schedule) => `${WEEK_DAYS[schedule.dayOfWeek] || "اليوم"} ${formatTimeArabic(schedule.startTime)}`).join(" · ") || "لم يتم تحديد الموعد";
  } catch {
    return "لم يتم تحديد الموعد";
  }
}

function firstScheduledDate(groupId: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const schedules = GroupScheduleRepository.getSchedulesForGroup(groupId);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const parseMinutes = (value: string | undefined) => {
    const [hours, minutes] = String(value || "00:00").split(":").map(Number);
    return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  };
  let offset = 0;
  for (; offset <= 7; offset += 1) {
    const candidateDay = (today.getDay() + offset) % 7;
    const daySchedules = schedules.filter((schedule) => schedule.dayOfWeek === candidateDay);
    if (!daySchedules.length) continue;
    if (offset === 0 && !daySchedules.some((schedule) => currentMinutes < parseMinutes(schedule.endTime || schedule.startTime))) continue;
    break;
  }
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Math.min(offset, 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function StudentsScreen() {
  const localDataRevision = useLocalDataRevision();
  const { colors } = useTheme();
  const { width: screenWidth, height: screenHeight, gutter, isTablet, isLandscape } = useResponsiveLayout();
  const styles = useMemo(() => createStyles(screenWidth, screenHeight, gutter, isTablet, isLandscape), [colors, screenWidth, screenHeight, gutter, isTablet, isLandscape]);
  const { studentId, add, attendanceSessionId } = useLocalSearchParams<{ studentId?: string; add?: string; attendanceSessionId?: string }>();
  const services = useServiceVisibility();
  const paymentsEnabled = services.isEnabled("payments");
  const currentUser = useAuthStore((s) => s.currentUser);
  const activeCenterId = useAuthStore((s) => s.activeCenterId);
  const permissions = Array.isArray(currentUser?.permissions)
    ? currentUser.permissions
    : [];

  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [bulkEnrollModalOpen, setBulkEnrollModalOpen] = useState(false);
  const [bulkEnrollGroupId, setBulkEnrollGroupId] = useState("");
  const [bulkEnrollmentMode, setBulkEnrollmentMode] = useState<"group" | "package">("group");
  const [bulkSubjectId, setBulkSubjectId] = useState("");
  const [bulkTeacherId, setBulkTeacherId] = useState("");
  const [bulkPackageId, setBulkPackageId] = useState("");
  const [bulkPackageOptionIds, setBulkPackageOptionIds] = useState<string[]>([]);
  const [bulkPackageTeacherIds, setBulkPackageTeacherIds] = useState<Record<string, string>>({});
  const [bulkPackageGroupIds, setBulkPackageGroupIds] = useState<Record<string, string>>({});
  const [cardScannerOpen, setCardScannerOpen] = useState(false);
  const [cardCameraPermission, requestCardCameraPermission] = useCameraPermissions();
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [studentSubscriptions, setStudentSubscriptions] = useState<StudentPackageSubscription[]>([]);
  const [studentAttendance, setStudentAttendance] = useState<Attendance[]>([]);
  const [studentNotes, setStudentNotes] = useState<import("../../shared/types").StudentNote[]>([]);
  const [studentAuditLogs, setStudentAuditLogs] = useState<import("../../shared/types").AuditLog[]>([]);
  const [noteText, setNoteText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<"groups" | "packages" | "attendance" | "payments" | "notes" | "activity">("groups");
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [studentEnrollments, setStudentEnrollments] = useState<
    StudentGroupEnrollment[]
  >([]);
  const [availableGroups, setAvailableGroups] = useState<Group[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [financialStatus, setFinancialStatus] =
    useState<DetailedStudentFinancialStatus | null>(null);
  const [attendanceSummaries, setAttendanceSummaries] = useState<StudentGroupAttendanceSummary[]>([]);
  const [selectedGroupPanel, setSelectedGroupPanel] = useState<{
    groupId: string;
    panel: "attendance" | "finance" | "grades";
  } | null>(null);
  const [groupFinancialStatus, setGroupFinancialStatus] =
    useState<DetailedStudentFinancialStatus | null>(null);
  const [groupDetailsModalOpen, setGroupDetailsModalOpen] = useState(false);
  const [groupAttendanceRows, setGroupAttendanceRows] = useState<Attendance[]>([]);
  const [groupGradeExams, setGroupGradeExams] = useState<GradeExam[]>([]);
  const [groupGradeScores, setGroupGradeScores] = useState<GradeScore[]>([]);

  // Modal States
  const [isAddStudentOpen, setIsAddStudentOpen] = useState(false);
  const [returningToAttendanceAfterCreate, setReturningToAttendanceAfterCreate] = useState(false);
  const returningToAttendanceAfterCreateRef = useRef(false);
  const [isCardModalOpen, setIsCardModalOpen] = useState(false);
  const [isEnrollModalOpen, setIsEnrollModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isAdjModalOpen, setIsAdjModalOpen] = useState(false);
  const [isRevModalOpen, setIsRevModalOpen] = useState(false);
  const [isPackageModalOpen, setIsPackageModalOpen] = useState(false);
  const [isStudentEditModalOpen, setIsStudentEditModalOpen] = useState(false);
  const [isCustomSmsModalOpen, setIsCustomSmsModalOpen] = useState(false);
  const [customSmsMessage, setCustomSmsMessage] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editParentPhone, setEditParentPhone] = useState("");
  const [editGrade, setEditGrade] = useState("");
  const [editStudentType, setEditStudentType] = useState<"registered" | "external">("registered");
  const [editNotes, setEditNotes] = useState("");
  const [availablePackages, setAvailablePackages] = useState<Package[]>([]);
  const [packageOptions, setPackageOptions] = useState<PackageSubject[]>([]);
  const [packageId, setPackageId] = useState("");
  const [packageOptionIds, setPackageOptionIds] = useState<string[]>([]);
  const [packageTeacherIds, setPackageTeacherIds] = useState<Record<string, string>>({});
  const [packageGroupIds, setPackageGroupIds] = useState<Record<string, string>>({});
  const [packageTeacherSearch, setPackageTeacherSearch] = useState("");

  // Financial Form States
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentType, setPaymentType] = useState<
    "monthly" | "session" | "partial"
  >("monthly");
  const [paymentCycleId, setPaymentCycleId] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const [targetCycleForAdj, setTargetCycleForAdj] = useState<DebtCycle | null>(
    null,
  );
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");

  const [targetPaymentForRev, setTargetPaymentForRev] =
    useState<PaymentEvent | null>(null);
  const [revReason, setRevReason] = useState("");

  // Card Replace Form State
  const [cardInput, setCardInput] = useState("");

  // Enrollment Form State
  const [enrollGroupId, setEnrollGroupId] = useState("");
  const [transferFromEnrollmentId, setTransferFromEnrollmentId] = useState<string | null>(null);
  const [enrollStartDate, setEnrollStartDate] = useState(
    getLocalDateOnly(),
  );
  const [enrollSpecialPrice, setEnrollSpecialPrice] = useState("");
  const [enrollGroupSearch, setEnrollGroupSearch] = useState("");

  const openCardScanner = async () => {
    if (!cardCameraPermission?.granted) {
      const result = await requestCardCameraPermission();
      if (!result.granted) return Alert.alert("إذن الكاميرا", "فعّل إذن الكاميرا لمسح كود الكارت.");
    }
    setCardScannerOpen(true);
  };
  const handleStudentCardScan = ({ data }: { data: string }) => {
    const code = String(data || "").trim();
    if (!code) return;
    setCardScannerOpen(false);
    setSearchQuery(code);
    const found = StudentRepository.findByCardCode(code);
    if (found) openStudentDetails(found);
    else Alert.alert("لم يتم العثور", "لا يوجد طالب مرتبط بهذا الكارت في المركز الحالي.");
  };

  const loadData = () => {
    try {
      // The students screen is the administrative directory; show inactive
      // records as well so a locally stored student is never mistaken for a
      // failed creation. Operational flows (attendance/search) still use the
      // active-only repository queries where appropriate.
      const all = StudentRepository.getAll(true);
      setStudents(all);
      const groups = GroupRepository.getAll();
      setAvailableGroups(groups);
      setTeachers(TeacherRepository.getAll());
      try { setAvailablePackages(PackageRepository.getPackages()); } catch {}
    } catch (e: any) {
      console.error(e);
    }
  };

  const openPackageModal = () => {
    if (!selectedStudent) return;
    const first = availablePackages[0];
    setPackageId(first?.id || "");
    setPackageOptions(first ? PackageRepository.getPackageSubjects(first.id) : []);
    setPackageOptionIds([]);
    setPackageTeacherIds(Object.fromEntries((first ? PackageRepository.getPackageSubjects(first.id) : []).map((subject) => [subject.id, subject.defaultTeacherId])));
    setPackageGroupIds({});
    setPackageTeacherSearch("");
    setIsPackageModalOpen(true);
  };
  const handlePackageChange = (id: string) => { const options = PackageRepository.getPackageSubjects(id); setPackageId(id); setPackageOptions(options); setPackageOptionIds([]); setPackageTeacherIds(Object.fromEntries(options.map((subject) => [subject.id, subject.defaultTeacherId]))); setPackageGroupIds({}); setPackageTeacherSearch(""); };
  const handleSubscribePackage = async () => {
    if (!selectedStudent || !packageId || packageOptionIds.length === 0) return Alert.alert("تنبيه", "اختر الباقة واختيارًا واحدًا على الأقل.");
    const selectedOptions = packageOptions.filter((option) => packageOptionIds.includes(option.id));
    if (selectedOptions.some((option) => !packageTeacherIds[option.id])) return Alert.alert("تنبيه", "اختار مدرس للمادة دي.");
    if (selectedOptions.some((option) => !packageGroupIds[option.id])) return Alert.alert("تنبيه", "اختار مجموعة لكل مدرس في الباقة.");
    try {
      // Create the package first. Package billing is one ledger obligation;
      // the selected groups are attendance/reporting scopes only.
      const packageStartDate = selectedOptions
        .map((option) => packageGroupIds[option.id] ? firstScheduledDate(packageGroupIds[option.id]) : null)
        .filter((value): value is string => Boolean(value))
        .sort()[0] || getLocalDateOnly();
      const subscription = await PackageSubscriptionRepository.subscribeStudent({ studentId: selectedStudent.id, packageId, startDate: packageStartDate, selectedOptionIds: packageOptionIds, selectedTeacherIds: packageTeacherIds, selectedGroupIds: packageGroupIds });
      for (const groupId of selectedOptions.map((option) => packageGroupIds[option.id]).filter(Boolean)) {
        if (!studentEnrollments.some((enrollment) => enrollment.groupId === groupId && enrollment.status === "active")) {
          EnrollmentRepository.enrollStudent({ studentId: selectedStudent.id, groupId, startDate: firstScheduledDate(groupId) });
        }
      }
      if (PermissionService.hasPermission(permissions, "packages.manage")) {
        for (const option of selectedOptions) {
          const teacherId = packageTeacherIds[option.id] || option.defaultTeacherId;
          if (teacherId !== option.defaultTeacherId) await PackageSubscriptionRepository.setTeacherOverride({ subscriptionId: subscription.id, subjectId: option.subjectId, teacherId, groupId: packageGroupIds[option.id] });
        }
      }
      Alert.alert("تم بنجاح", "تم تحويل الطالب إلى الباقة مع حفظ مدرس كل مادة."); setIsPackageModalOpen(false);
    } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تسجيل الباقة."); }
  };

  useEffect(() => {
    loadData();
    // The screen stays mounted while the user switches centers. Reload all
    // center-scoped lists so the previous center can never remain visible.
    setSelectedStudent(null);
    setStudentEnrollments([]);
    setFinancialStatus(null);
    setAttendanceSummaries([]);
    setSelectedGroupPanel(null);
    setGroupFinancialStatus(null);
    setGroupDetailsModalOpen(false);
    setGroupAttendanceRows([]);
    setGroupGradeExams([]);
    setGroupGradeScores([]);
    if (studentId) {
      const requested = StudentRepository.findById(String(studentId));
      if (requested) openStudentDetails(requested);
    }
    if (add === "1") setIsAddStudentOpen(true);
  }, [activeCenterId, studentId, add]);
  useEffect(() => {
    if (localDataRevision > 0) loadData();
  }, [localDataRevision]);

  // Keep the profile payment form aligned with the attendance payment flow:
  // cycle payments start with the open month/package balance, while a session
  // payment starts with a per-session amount and remains separate.
  useEffect(() => {
    if (!isPaymentModalOpen || !financialStatus) return;
    if (paymentType !== "session") {
      const openCycles = financialStatus.cycles
        .filter((cycle) => (cycle.remainingDebt ?? 0) > 0)
        .sort((a, b) => {
          const byStart = String(a.startDate).localeCompare(String(b.startDate));
          if (byStart !== 0) return byStart;
          return a.cycleType === "package" ? -1 : b.cycleType === "package" ? 1 : 0;
        });
      const openCycle = openCycles.find((cycle) => cycle.id === paymentCycleId) || (openCycles.length === 1 ? openCycles[0] : undefined);
      if (openCycles.length === 1 && paymentCycleId !== openCycles[0].id) setPaymentCycleId(openCycles[0].id);
      if (openCycles.length !== 1 && paymentCycleId && !openCycles.some((cycle) => cycle.id === paymentCycleId)) setPaymentCycleId("");
      const balance = openCycle?.remainingDebt ?? financialStatus.monthlyRemainingDebt ?? 0;
      if (!paymentAmount || Number(paymentAmount) === 0) setPaymentAmount(openCycles.length > 1 && !paymentCycleId ? "" : String(balance));
    }
  }, [isPaymentModalOpen, paymentType, financialStatus, paymentCycleId]);

  const openStudentDetails = (student: Student) => {
    if (selectedStudent?.id !== student.id) setProfileTab("groups");
    setSelectedStudent(student);
    setFinancialStatus(null);
    setStudentEnrollments([]);
    setStudentSubscriptions([]);
    setStudentAttendance([]);
    setStudentNotes([]);
    setStudentAuditLogs([]);
    setNoteText("");
    setEditingNoteId(null);
    setAttendanceSummaries([]);
    try {
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForStudent(
        student.id,
      );
      setStudentEnrollments(enrollments);
      try {
        setStudentSubscriptions(PermissionService.hasPermission(permissions, "packages.view")
          ? PackageSubscriptionRepository.getSubscriptionsForStudent(student.id, true)
          : []);
      } catch { setStudentSubscriptions([]); }
      try {
        setStudentAttendance(AttendanceRepository.getStudentAttendance(student.id));
      } catch { setStudentAttendance([]); }
      try { setStudentNotes(StudentNoteRepository.listForStudent(student.id)); } catch { setStudentNotes([]); }
      try { setStudentAuditLogs(AuditService.getEntityLogs(activeCenterId || student.centerId, student.id)); } catch { setStudentAuditLogs([]); }
      try {
        setAttendanceSummaries(AttendanceRepository.getStudentGroupAttendanceSummaries(student.id));
      } catch {
        setAttendanceSummaries([]);
      }
      if (paymentsEnabled && PermissionService.hasPermission(permissions, "payments.view")) {
        const fin = FinancialCalculationService.getStudentFinancialStatus(
          student.id,
        );
        setFinancialStatus(fin);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const saveStudentNote = () => {
    if (!selectedStudent || !noteText.trim()) return Alert.alert("الملاحظة", "اكتب نص الملاحظة أولاً.");
    try {
      if (editingNoteId) StudentNoteRepository.update(editingNoteId, noteText);
      else StudentNoteRepository.create(selectedStudent.id, noteText);
      setStudentNotes(StudentNoteRepository.listForStudent(selectedStudent.id));
      setNoteText(""); setEditingNoteId(null);
    } catch (error: any) { Alert.alert("تعذر حفظ الملاحظة", error?.message || "حاول مرة أخرى."); }
  };

  const removeStudentNote = (noteId: string) => {
    Alert.alert("حذف الملاحظة", "هل تريد حذف هذه الملاحظة؟", [
      { text: "إلغاء", style: "cancel" },
      { text: "حذف", style: "destructive", onPress: () => { try { StudentNoteRepository.remove(noteId); if (selectedStudent) setStudentNotes(StudentNoteRepository.listForStudent(selectedStudent.id)); } catch (error: any) { Alert.alert("تعذر الحذف", error?.message || "حاول مرة أخرى."); } } },
    ]);
  };

  const openStudentEdit = () => {
    if (!selectedStudent) return;
    setEditFullName(selectedStudent.fullName);
    setEditPhone(selectedStudent.phone);
    setEditParentPhone(selectedStudent.parentPhone);
    setEditGrade(selectedStudent.grade);
    setEditStudentType(selectedStudent.studentType === "external" ? "external" : "registered");
    setEditNotes(selectedStudent.notes || "");
    setIsStudentEditModalOpen(true);
  };

  const saveStudentEdit = () => {
    if (!selectedStudent) return;
    try {
      const updated = StudentRepository.updateStudent(selectedStudent.id, {
        fullName: editFullName,
        phone: editPhone,
        parentPhone: editParentPhone,
        grade: editGrade,
        studentType: editStudentType,
        notes: editNotes,
      });
      setSelectedStudent(updated);
      setIsStudentEditModalOpen(false);
      loadData();
      openStudentDetails(updated);
      Alert.alert("تم بنجاح", "تم تحديث بيانات الطالب.");
    } catch (error: any) {
      Alert.alert("تعذر الحفظ", error?.message || "راجع الاسم وأرقام الهاتف.");
    }
  };

  const sendCustomSms = async () => {
    if (!selectedStudent) return;
    if (!services.isEnabled("notifications")) return Alert.alert("الإشعارات غير مفعلة", "فعّل خدمة الإشعارات لهذا المركز أولاً.");
    if (!customSmsMessage.trim()) return Alert.alert("تنبيه", "اكتب نص الرسالة أولاً.");
    try {
      const event = NotificationService.notifyCustomSms({ studentId: selectedStudent.id, message: customSmsMessage });
      await NotificationService.sendPendingDeliveries(event.id);
      setCustomSmsMessage("");
      setIsCustomSmsModalOpen(false);
      Alert.alert("تم تجهيز الرسالة", "تم حفظ الرسالة وإرسالها إلى طابور SMS للمزامنة.");
    } catch (error: any) { Alert.alert("تعذر إرسال الرسالة", error?.message || "راجع صلاحية الإشعارات ورقم ولي الأمر."); }
  };

  const handleCallStudent = () => {
    if (!selectedStudent) return;
    const call = (label: string, phone?: string) => {
      if (!phone?.trim()) {
        Alert.alert("لا يوجد رقم", `لا يوجد ${label} مسجل لهذا الطالب.`);
        return;
      }
      Linking.openURL(`tel:${phone.trim()}`).catch(() =>
        Alert.alert("تعذر الاتصال", "لا يمكن فتح تطبيق الاتصال على هذا الجهاز."),
      );
    };
    Alert.alert("اتصال", "اختر الرقم المطلوب الاتصال به", [
      { text: "رقم الطالب", onPress: () => call("رقم الطالب", selectedStudent.phone) },
      { text: "رقم ولي الأمر", onPress: () => call("رقم ولي الأمر", selectedStudent.parentPhone) },
      { text: "إلغاء", style: "cancel" },
    ]);
  };

  const callNumber = (phone: string | undefined, label: string) => {
    if (!phone?.trim()) return Alert.alert("لا يوجد رقم", `لا يوجد ${label} مسجل لهذا الطالب.`);
    Linking.openURL(`tel:${phone.trim()}`).catch(() => Alert.alert("تعذر الاتصال", "لا يمكن فتح تطبيق الاتصال على هذا الجهاز."));
  };

  const handleCancelPackage = (subscription: StudentPackageSubscription) => {
    Alert.alert("إلغاء اشتراك الباقة", `سيتم تطبيق سياسة الاشتراك المالي الحالية على «${subscription.packageName || "الباقة"}». هل تريد المتابعة؟`, [
      { text: "رجوع", style: "cancel" },
      { text: "تأكيد الإلغاء", style: "destructive", onPress: async () => {
        try {
          await PackageSubscriptionRepository.cancelSubscription(subscription.id, getLocalDateOnly());
          if (selectedStudent) openStudentDetails(StudentRepository.findById(selectedStudent.id) || selectedStudent);
          Alert.alert("تم", "تم إلغاء الاشتراك وفق السياسة الحالية.");
        } catch (error: any) { Alert.alert("تعذر الإلغاء", error?.message || "حاول مرة أخرى."); }
      } },
    ]);
  };

  const openGroupPanel = (groupId: string, panel: "attendance" | "finance") => {
    if (!selectedStudent) return;
    if (panel === "finance") {
      if (!canViewPayments) {
        Alert.alert("غير متاح", "ليس لديك صلاحية عرض الموقف المالي.");
        return;
      }
      try {
        setGroupFinancialStatus(
          FinancialCalculationService.getStudentFinancialStatusForGroup(
            selectedStudent.id,
            groupId,
          ),
        );
      } catch (error: any) {
        setGroupFinancialStatus(null);
        Alert.alert("تعذر تحميل الموقف المالي", error?.message || "حاول مرة أخرى.");
        return;
      }
    } else {
      setGroupFinancialStatus(null);
      try {
        setGroupAttendanceRows(
          AttendanceRepository.getStudentAttendance(selectedStudent.id).filter(
            (row) => row.groupId === groupId,
          ),
        );
      } catch (error: any) {
        setGroupAttendanceRows([]);
        Alert.alert("تعذر تحميل الحضور", error?.message || "حاول مرة أخرى.");
        return;
      }
    }
    setSelectedGroupPanel({ groupId, panel });
    setGroupDetailsModalOpen(true);
  };

  const openGroupGrades = (groupId: string) => {
    if (!selectedStudent) return;
    const group = availableGroups.find((item) => item.id === groupId);
    if (!group) {
      Alert.alert("تعذر تحميل الدرجات", "بيانات المجموعة غير متاحة.");
      return;
    }
    try {
      const exams = GradeBookRepository.getExams(group.id, group.grade || selectedStudent.grade);
      const scores = GradeBookRepository.getScores(
        exams.map((exam) => exam.id),
        [selectedStudent.id],
      );
      setGroupGradeExams(exams);
      setGroupGradeScores(scores);
      setGroupAttendanceRows([]);
      setGroupFinancialStatus(null);
      setSelectedGroupPanel({ groupId, panel: "grades" });
      setGroupDetailsModalOpen(true);
    } catch (error: any) {
      Alert.alert("تعذر تحميل الدرجات", error?.message || "حاول مرة أخرى.");
    }
  };

  const handleRecordPayment = async () => {
    if (!selectedStudent) return;
    const amountNum = parseFloat(paymentAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert("تنبيه", "يرجى إدخال مبلغ صحيح أكبر من صفر.");
      return;
    }
    try {
      // A session payment must stay in the per-session ledger. Monthly and
      // partial payments belong to the oldest open debt cycle unless the
      // operator explicitly selected a cycle. This keeps profile payments
      // consistent with the attendance payment flow and package-as-one-ledger
      // rule.
      // Profile payments use the same ledger as attendance. Even a payment
      // labelled "session" must be linked to the student's open cycle when
      // one exists, so it reduces the monthly/package cap instead of becoming
      // an unrelated cash entry.
      const openCycles = (financialStatus?.cycles || [])
        .filter((cycle) => (cycle.remainingDebt ?? 0) > 0)
        .sort((a, b) => {
          const byStart = String(a.startDate).localeCompare(String(b.startDate));
          if (byStart !== 0) return byStart;
          if (a.cycleType === b.cycleType) return 0;
          return a.cycleType === "package" ? -1 : 1;
        });
      const selectedCycle = openCycles.find((cycle) => cycle.id === paymentCycleId)
        || (openCycles.length === 1 ? openCycles[0] : undefined);
      if (openCycles.length > 1 && !selectedCycle) {
        throw new Error("اختر دورة المديونية التي ستخصم منها الدفعة.");
      }
      const normalizedPaymentType = paymentType === "monthly" && selectedCycle && amountNum >= Number(selectedCycle.remainingDebt ?? 0)
        ? "monthly"
        : paymentType;
      await PaymentRepository.recordPayment({
        studentId: selectedStudent.id,
        amount: amountNum,
        paymentType: normalizedPaymentType,
        debtCycleId: selectedCycle?.id,
        subscriptionId: selectedCycle?.packageSubscriptionId,
        notes: paymentNotes.trim() || undefined,
      });
      Alert.alert("تم بنجاح", Strings.paymentRecordedSuccess);
      setIsPaymentModalOpen(false);
      setPaymentAmount("");
      setPaymentNotes("");
      setPaymentCycleId("");
      openStudentDetails(selectedStudent);
      const updatedFin = FinancialCalculationService.getStudentFinancialStatus(
        selectedStudent.id,
      );
      setFinancialStatus(updatedFin);
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تسجيل الدفعة");
    }
  };

  const handleCreateAdjustment = async () => {
    if (!selectedStudent || !targetCycleForAdj) return;
    const adjNum = parseFloat(adjAmount);
    if (isNaN(adjNum) || adjNum === 0) {
      Alert.alert("تنبيه", "قيمة التعديل لا يمكن أن تكون صفراً.");
      return;
    }
    if (!adjReason.trim()) {
      Alert.alert("تنبيه", "سبب التعديل مطلوب.");
      return;
    }
    try {
      await DebtAdjustmentRepository.createAdjustment({
        debtCycleId: targetCycleForAdj.id,
        adjustmentAmount: adjNum,
        reason: adjReason.trim(),
      });
      Alert.alert("تم بنجاح", "تم تسجيل التعديل المالي بنجاح.");
      setIsAdjModalOpen(false);
      setAdjAmount("");
      setAdjReason("");
      setTargetCycleForAdj(null);
      const updatedFin = FinancialCalculationService.getStudentFinancialStatus(
        selectedStudent.id,
      );
      setFinancialStatus(updatedFin);
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تسجيل التعديل المالي");
    }
  };

  const handleReversePayment = async () => {
    if (!selectedStudent || !targetPaymentForRev) return;
    if (!revReason.trim()) {
      Alert.alert("تنبيه", "سبب إلغاء الدفعة مطلوب.");
      return;
    }
    try {
      await PaymentRepository.reversePayment({
        paymentId: targetPaymentForRev.id,
        reason: revReason.trim(),
      });
      Alert.alert("تم بنجاح", "تم إلغاء الدفعة بنجاح.");
      setIsRevModalOpen(false);
      setRevReason("");
      setTargetPaymentForRev(null);
      const updatedFin = FinancialCalculationService.getStudentFinancialStatus(
        selectedStudent.id,
      );
      setFinancialStatus(updatedFin);
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل إلغاء الدفعة");
    }
  };

  const handleReplaceCard = () => {
    if (!selectedStudent) return;
    if (!cardInput.trim()) {
      Alert.alert("تنبيه", "يرجى إدخال كود البطاقة الجديدة.");
      return;
    }

    try {
      StudentCardRepository.replaceCard(selectedStudent.id, cardInput.trim());
      Alert.alert("تم بنجاح", `تم تحديث كود الكارت إلى (${cardInput.trim()}).`);
      setIsCardModalOpen(false);
      setCardInput("");
      const updatedStudent = StudentRepository.findById(selectedStudent.id);
      if (updatedStudent) openStudentDetails(updatedStudent);
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تحديث البطاقة");
    }
  };

  const handleEnrollStudent = () => {
    if (!selectedStudent) return;
    if (!enrollGroupId) {
      Alert.alert("تنبيه", "يرجى اختيار المجموعة أولاً.");
      return;
    }

    try {
      if (transferFromEnrollmentId) {
        // Keep the same enrollment identity (and therefore the same debt
        // cycle) when transferring between groups.
        EnrollmentRepository.transferEnrollment(transferFromEnrollmentId, enrollGroupId);
      } else {
        EnrollmentRepository.enrollStudent({
          studentId: selectedStudent.id,
          groupId: enrollGroupId,
          // The subscription starts on the first scheduled class, not on the
          // day the admin happens to create the enrollment.
          startDate: enrollStartDate === getLocalDateOnly()
            ? firstScheduledDate(enrollGroupId)
            : (enrollStartDate || firstScheduledDate(enrollGroupId)),
          specialMonthlyPrice: enrollSpecialPrice
            ? parseFloat(enrollSpecialPrice)
            : undefined,
        });
      }

      Alert.alert("تم بنجاح", "تم تسجيل الطالب في المجموعة بنجاح.");
      setIsEnrollModalOpen(false);
      setEnrollGroupId("");
      setEnrollSpecialPrice("");
      setTransferFromEnrollmentId(null);
      openStudentDetails(selectedStudent);
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تسجيل الطالب في المجموعة");
    }
  };

  const handleEndEnrollment = (enrollmentId: string) => {
    if (!selectedStudent) return;
    const today = getLocalDateOnly();
    Alert.alert("تأكيد", "هل ترغب في إنهاء اشتراك الطالب في هذه المجموعة؟", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "نعم، إنهاء الاشتراك",
        style: "destructive",
        onPress: () => {
          try {
            EnrollmentRepository.endEnrollment(enrollmentId, today);
            openStudentDetails(selectedStudent);
            loadData();
          } catch (e: any) {
            Alert.alert("خطأ", e?.message || "فشل إنهاء الاشتراك");
          }
        },
      },
    ]);
  };

  const handleDeleteStudent = () => {
    if (!selectedStudent) return;
    Alert.alert(
      "حذف الطالب",
      `سيختفي الطالب (${selectedStudent.fullName}) من القوائم الحالية، مع الاحتفاظ ببياناته ومجموعاته وباقاته وسجل الحضور والمدفوعات لإمكانية استرجاعه لاحقًا.`,
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "حذف الطالب",
          style: "destructive",
          onPress: () => {
            try {
              StudentRepository.deleteStudent(selectedStudent.id);
              setSelectedStudent(null);
              loadData();
            } catch (e: any) {
              Alert.alert("خطأ", e?.message || "تعذر حذف الطالب.");
            }
          },
        },
      ],
    );
  };

  const searchedStudents = smartSearch(students, searchQuery, [
    { get: (s) => s.fullName, weight: 1.2 },
    { get: (s) => s.studentCode, weight: 1.1 },
    { get: (s) => s.cardCode, weight: 1.1 },
    { get: (s) => s.phone },
    { get: (s) => s.parentPhone },
  ]);
  const filteredStudents = gradeFilter
    ? searchedStudents.filter((student) => student.grade === gradeFilter)
    : searchedStudents;
  const gradeOptions = Array.from(new Set(students.map((student) => student.grade).filter(Boolean))).sort();

  const canCreate = PermissionService.hasPermission(
    permissions,
    "students.create",
  );
  const canManageCards = PermissionService.hasPermission(
    permissions,
    "students.cards.manage",
  );
  const canEnroll = PermissionService.hasPermission(
    permissions,
    "enrollments.create",
  );
  const canUpdateStudent = PermissionService.hasPermission(permissions, "students.update");
  const canViewPackages = PermissionService.hasPermission(permissions, "packages.view");
  const eligibleEnrollmentGroups = availableGroups
    .filter(
      (group) =>
        group.status === "active" &&
        (!selectedStudent?.grade || group.grade === selectedStudent.grade || group.grade === "كل الصفوف"),
    )
    .filter((group) => {
      const query = enrollGroupSearch.trim().toLocaleLowerCase();
      if (!query) return true;
      return [group.name, group.teacherName, group.subjectName, group.grade]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  const selectedGrades = new Set(students.filter((student) => selectedStudentIds.includes(student.id)).map((student) => student.grade));
  const bulkEligibleGroups = eligibleEnrollmentGroups.filter((group) => selectedGrades.size === 0 || (selectedGrades.size === 1 && (selectedGrades.has(group.grade) || group.grade === "كل الصفوف")));
  const bulkGrade = selectedGrades.size === 1 ? Array.from(selectedGrades)[0] : "";
  const bulkSubjects = Array.from(new Set(bulkEligibleGroups.map((group) => group.subjectId))).map((id) => ({ id, name: bulkEligibleGroups.find((group) => group.subjectId === id)?.subjectName || "المادة" }));
  const bulkTeachers = teachers.filter((teacher) => teacher.status !== "inactive" && bulkEligibleGroups.some((group) => group.subjectId === bulkSubjectId && group.teacherId === teacher.id));
  const bulkVisibleGroups = bulkEligibleGroups.filter((group) => (!bulkSubjectId || group.subjectId === bulkSubjectId) && (!bulkTeacherId || group.teacherId === bulkTeacherId));
  const bulkSelectedPackage = availablePackages.find((item) => item.id === bulkPackageId);
  const bulkPackageOptions = bulkPackageId ? PackageRepository.getPackageSubjects(bulkPackageId) : [];
  const bulkPackageGroupsForOption = (option: PackageSubject) => {
    const teacherId = bulkPackageTeacherIds[option.id] || option.defaultTeacherId;
    return availableGroups.filter((group) => group.status === "active" && (!bulkGrade || group.grade === bulkGrade || group.grade === "كل الصفوف") && group.subjectId === option.subjectId && group.teacherId === teacherId);
  };
  const canDeactivate = PermissionService.hasPermission(
    permissions,
    "students.deactivate",
  );
  const canViewPayments = paymentsEnabled && PermissionService.hasPermission(
    permissions,
    "payments.view",
  );
  const canViewAttendance = PermissionService.hasAnyPermission(permissions, ["attendance.view", "reports.attendance.view", "reports.view"]);
  const canCreatePayment = paymentsEnabled && PermissionService.hasPermission(
    permissions,
    "payments.create",
  );
  const canReversePayment = paymentsEnabled && PermissionService.hasPermission(
    permissions,
    "payments.reverse",
  );
  const canAdjustDebt = paymentsEnabled && PermissionService.hasPermission(
    permissions,
    "payments.adjust",
  );

  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudentIds((current) => current.includes(studentId)
      ? current.filter((id) => id !== studentId)
      : [...current, studentId]);
  };

  const openBulkEnrollment = () => {
    if (!selectedStudentIds.length) {
      Alert.alert("اختيار الطلاب", "حدد طالبًا واحدًا على الأقل أولًا.");
      return;
    }
    setBulkEnrollGroupId("");
    setBulkEnrollmentMode("group");
    setBulkSubjectId("");
    setBulkTeacherId("");
    const firstPackage = availablePackages[0];
    setBulkPackageId(firstPackage?.id || "");
    const firstOptions = firstPackage ? PackageRepository.getPackageSubjects(firstPackage.id) : [];
    setBulkPackageOptionIds([]);
    setBulkPackageTeacherIds(Object.fromEntries(firstOptions.map((option) => [option.id, option.defaultTeacherId])));
    setBulkPackageGroupIds({});
    setBulkEnrollModalOpen(true);
  };

  const enrollSelectedStudents = async () => {
    if (bulkEnrollmentMode === "package") {
      if (!bulkPackageId || !bulkPackageOptionIds.length || bulkPackageOptionIds.some((id) => !bulkPackageGroupIds[id])) {
        Alert.alert("بيانات الباقة ناقصة", "اختر الباقة، ثم مادة ومدرسًا ومجموعة لكل اختيار.");
        return;
      }
      let completed = 0;
      let skipped = 0;
      const skippedReasons: string[] = [];
      const selectedOptions = bulkPackageOptions.filter((option) => bulkPackageOptionIds.includes(option.id));
      const selectedGroups = selectedOptions.map((option) => bulkPackageGroupIds[option.id]).filter(Boolean);
      for (const id of selectedStudentIds) {
        try {
          const existingPackage = PackageSubscriptionRepository.getSubscriptionsForStudent(id)
            .some((subscription) => subscription.packageId === bulkPackageId && subscription.status === "active");
          if (existingPackage) {
            throw new Error("الطالب مشترك بالفعل في هذه الباقة.");
          }
          const startDate = selectedGroups.map((groupId) => firstScheduledDate(groupId)).sort()[0] || getLocalDateOnly();
          await PackageSubscriptionRepository.subscribeStudent({ studentId: id, packageId: bulkPackageId, startDate, selectedOptionIds: bulkPackageOptionIds, selectedTeacherIds: bulkPackageTeacherIds, selectedGroupIds: bulkPackageGroupIds });
          const existingEnrollments = EnrollmentRepository.getActiveEnrollmentsForStudent(id);
          for (const groupId of Array.from(new Set(selectedGroups))) {
            if (!existingEnrollments.some((enrollment) => enrollment.groupId === groupId)) {
              EnrollmentRepository.enrollStudent({ studentId: id, groupId, startDate: firstScheduledDate(groupId) });
            }
          }
          completed += 1;
        } catch (error: any) {
          skipped += 1;
          const studentName = StudentRepository.findById(id)?.fullName || id;
          skippedReasons.push(`${studentName}: ${error?.message || "سبب غير معروف"}`);
          console.warn("Bulk package enrollment skipped", { studentId: id, error });
        }
      }
      setBulkEnrollModalOpen(false);
      setSelectedStudentIds([]);
      setSelectionMode(false);
      loadData();
      Alert.alert("تم الاشتراك", `تم اشتراك ${completed} طالب${skipped ? `، وتخطّي ${skipped}` : ""}.${skippedReasons.length ? `\n\n${skippedReasons.slice(0, 4).join("\n")}${skippedReasons.length > 4 ? "\n…" : ""}` : ""}`);
      return;
    }
    if (!bulkEnrollGroupId) {
      Alert.alert("المجموعة مطلوبة", "اختر المجموعة التي سيُسجّل بها الطلاب.");
      return;
    }
    let completed = 0;
    let skipped = 0;
    const skippedReasons: string[] = [];
    for (const id of selectedStudentIds) {
      try {
        EnrollmentRepository.enrollStudent({ studentId: id, groupId: bulkEnrollGroupId, startDate: firstScheduledDate(bulkEnrollGroupId) });
        completed += 1;
      } catch (error: any) {
        skipped += 1;
        const studentName = StudentRepository.findById(id)?.fullName || id;
        skippedReasons.push(`${studentName}: ${error?.message || "سبب غير معروف"}`);
        console.warn("Bulk group enrollment skipped", { studentId: id, error });
      }
    }
    setBulkEnrollModalOpen(false);
    setSelectedStudentIds([]);
    setSelectionMode(false);
    loadData();
    Alert.alert("تم التسجيل", `تم تسجيل ${completed} طالب${skipped ? `، وتخطّي ${skipped} (مسجلين بالفعل أو غير متاحين)` : ""}.${skippedReasons.length ? `\n\n${skippedReasons.slice(0, 4).join("\n")}${skippedReasons.length > 4 ? "\n…" : ""}` : ""}`);
  };

  const openEnrollModal = () => {
    setEnrollGroupId("");
    setEnrollGroupSearch("");
    setEnrollStartDate("");
    setEnrollSpecialPrice("");
    setTransferFromEnrollmentId(null);
    setIsEnrollModalOpen(true);
  };

  const openTransferModal = (enrollmentId: string) => {
    setEnrollGroupId("");
    setEnrollGroupSearch("");
    setEnrollStartDate(getLocalDateOnly());
    setEnrollSpecialPrice("");
    setTransferFromEnrollmentId(enrollmentId);
    setIsEnrollModalOpen(true);
  };


  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{Strings.tabStudents}</Text>
        {canCreate && (
          <TouchableOpacity
            style={styles.headerAddButton}
            onPress={() => setIsAddStudentOpen(true)}
          >
            <Ionicons name="person-add" size={18} color={Colors.white} />
            <Text style={styles.headerAddButtonText}>إضافة طالب</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.headerActions}>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => setFilterOpen((current) => !current)} accessibilityLabel="فلترة الطلاب">
          <Ionicons name="filter-outline" size={20} color={Colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => { setSelectionMode((current) => !current); setSelectedStudentIds([]); }} accessibilityLabel="تحديد عدة طلاب">
          <Ionicons name={selectionMode ? "close-outline" : "checkmark-circle-outline"} size={20} color={Colors.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <AppInput
          placeholder="ابحث بالاسم، كود الطالب، كود الكارت، أو الهاتف..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          containerStyle={{ marginBottom: Spacing.md }}
        />

        <TouchableOpacity style={styles.cardSearchButton} onPress={openCardScanner} activeOpacity={0.8}>
          <Ionicons name="scan-outline" size={20} color={Colors.primary} />
          <Text style={styles.cardSearchButtonText}>مسح كارت للبحث</Text>
        </TouchableOpacity>

        {filterOpen && <View style={styles.filterPanel}>
          <Text style={styles.filterTitle}>السنة الدراسية</Text>
          <TouchableOpacity style={[styles.filterChip, !gradeFilter && styles.filterChipActive]} onPress={() => setGradeFilter("")}><Text style={[styles.filterChipText, !gradeFilter && styles.filterChipTextActive]}>الكل</Text></TouchableOpacity>
          {gradeOptions.map((grade) => <TouchableOpacity key={grade} style={[styles.filterChip, gradeFilter === grade && styles.filterChipActive]} onPress={() => setGradeFilter(grade)}><Text style={[styles.filterChipText, gradeFilter === grade && styles.filterChipTextActive]}>{grade}</Text></TouchableOpacity>)}
        </View>}
        {selectionMode && <View style={styles.bulkToolbar}><Text style={styles.bulkCount}>تم تحديد {selectedStudentIds.length}</Text><TouchableOpacity style={styles.bulkButton} onPress={openBulkEnrollment}><Ionicons name="people-outline" size={17} color={Colors.white} /><Text style={styles.bulkButtonText}>تسجيل في مجموعة</Text></TouchableOpacity></View>}

        <FlatList
          data={filteredStudents}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState message="لا يوجد طلاب مطابقين للبحث الحالي" />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={() => selectionMode ? toggleStudentSelection(item.id) : openStudentDetails(item)}
            >
              <AppCard style={[styles.studentCard, selectedStudentIds.includes(item.id) && styles.studentCardSelected]}>
                {selectionMode && <Ionicons name={selectedStudentIds.includes(item.id) ? "checkmark-circle" : "ellipse-outline"} size={24} color={selectedStudentIds.includes(item.id) ? Colors.primary : Colors.slate400} style={styles.selectionIcon} />}
                <View style={styles.studentInfo}>
                  <Text style={styles.studentName}>{item.fullName}</Text>
                  <View style={styles.badgeRow}>
                    <Text style={styles.codeBadge}>
                      كود: {formatDisplayIdentifier(item.studentCode)}
                    </Text>
                    {item.cardCode ? (
                      <Text style={styles.cardBadge}>
                        كارت: {formatDisplayIdentifier(item.cardCode)}
                      </Text>
                    ) : (
                      <Text style={styles.noCardBadge}>بدون كارت</Text>
                    )}
                  </View>
                  <Text style={styles.studentMeta}>
                    {item.grade} • {item.phone}
                  </Text>
                </View>

                <View style={styles.cardActions}>
                  <Ionicons
                    name="chevron-back"
                    size={20}
                    color={Colors.slate400}
                    style={{ marginTop: Spacing.sm }}
                  />
                </View>
              </AppCard>
            </TouchableOpacity>
          )}
        />
      </View>

      <Modal visible={bulkEnrollModalOpen} transparent animationType="slide" onRequestClose={() => setBulkEnrollModalOpen(false)}>
        <View style={styles.modalOverlay}><View style={styles.smallModalCard}>
          <View style={styles.modalHeader}><Text style={styles.modalTitle}>تسجيل الطلاب في مجموعة</Text><TouchableOpacity onPress={() => setBulkEnrollModalOpen(false)}><Ionicons name="close" size={22} color={Colors.slate700} /></TouchableOpacity></View>
          <Text style={styles.modalSubtitle}>سيتم إنشاء تسجيل ومديونية مستقلة لكل طالب من الطلاب المحددين ({selectedStudentIds.length}).</Text>
          <View style={styles.bulkModeRow}><TouchableOpacity style={[styles.bulkModeChip, bulkEnrollmentMode === "group" && styles.bulkModeChipActive]} onPress={() => setBulkEnrollmentMode("group")}><Text style={[styles.bulkModeText, bulkEnrollmentMode === "group" && styles.bulkModeTextActive]}>مجموعة</Text></TouchableOpacity><TouchableOpacity style={[styles.bulkModeChip, bulkEnrollmentMode === "package" && styles.bulkModeChipActive]} onPress={() => setBulkEnrollmentMode("package")}><Text style={[styles.bulkModeText, bulkEnrollmentMode === "package" && styles.bulkModeTextActive]}>باقة</Text></TouchableOpacity></View>
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingVertical: 10 }}>
            {bulkEnrollmentMode === "group" && <><Text style={styles.bulkStepTitle}>المادة</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}><TouchableOpacity style={[styles.chip, !bulkSubjectId && styles.chipActive]} onPress={() => { setBulkSubjectId(""); setBulkTeacherId(""); }}><Text style={[styles.chipText, !bulkSubjectId && styles.chipTextActive]}>كل المواد</Text></TouchableOpacity>{bulkSubjects.map((subject) => <TouchableOpacity key={subject.id} style={[styles.chip, bulkSubjectId === subject.id && styles.chipActive]} onPress={() => { setBulkSubjectId(subject.id); setBulkTeacherId(""); }}><Text style={[styles.chipText, bulkSubjectId === subject.id && styles.chipTextActive]}>{subject.name}</Text></TouchableOpacity>)}</ScrollView><Text style={styles.bulkStepTitle}>المدرس</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}><TouchableOpacity style={[styles.chip, !bulkTeacherId && styles.chipActive]} onPress={() => setBulkTeacherId("")}><Text style={[styles.chipText, !bulkTeacherId && styles.chipTextActive]}>كل المدرسين</Text></TouchableOpacity>{bulkTeachers.map((teacher) => <TouchableOpacity key={teacher.id} style={[styles.chip, bulkTeacherId === teacher.id && styles.chipActive]} onPress={() => setBulkTeacherId(teacher.id)}><Text style={[styles.chipText, bulkTeacherId === teacher.id && styles.chipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView></>}
            {bulkEnrollmentMode === "group" && bulkVisibleGroups.map((group) => <TouchableOpacity key={group.id} style={[styles.enrollChoice, bulkEnrollGroupId === group.id && styles.enrollChoiceActive]} onPress={() => setBulkEnrollGroupId(group.id)}><Text style={styles.groupPickHeader}>{group.name}</Text><Text style={styles.groupPickMeta}>{[group.subjectName, group.teacherName, group.grade].filter(Boolean).join(" · ")} · {groupScheduleLabel(group.id)}</Text></TouchableOpacity>)}
            {bulkEnrollmentMode === "package" && <><Text style={styles.bulkStepTitle}>الباقة</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>{availablePackages.map((item) => <TouchableOpacity key={item.id} style={[styles.chip, bulkPackageId === item.id && styles.chipActive]} onPress={() => { setBulkPackageId(item.id); setBulkPackageOptionIds([]); setBulkPackageGroupIds({}); setBulkPackageTeacherIds(Object.fromEntries(PackageRepository.getPackageSubjects(item.id).map((option) => [option.id, option.defaultTeacherId]))); }}><Text style={[styles.chipText, bulkPackageId === item.id && styles.chipTextActive]}>{item.name}</Text></TouchableOpacity>)}</ScrollView>{bulkSelectedPackage && bulkPackageOptions.map((option) => { const chosen = bulkPackageOptionIds.includes(option.id); const teacherId = bulkPackageTeacherIds[option.id] || option.defaultTeacherId; const optionGroups = bulkPackageGroupsForOption(option); return <View key={option.id} style={styles.bulkPackageCard}><TouchableOpacity style={[styles.enrollChoice, chosen && styles.enrollChoiceActive]} onPress={() => setBulkPackageOptionIds((current) => chosen ? current.filter((id) => id !== option.id) : [...current, option.id])}><Text style={styles.groupPickHeader}>{chosen ? "✓ " : "□ "}{option.subjectName}</Text><Text style={styles.groupPickMeta}>مدرس الباقة: {teachers.find((teacher) => teacher.id === teacherId)?.name || option.defaultTeacherName || "غير محدد"}</Text></TouchableOpacity>{chosen && <><Text style={styles.bulkStepTitle}>مجموعات المدرس للمادة</Text>{optionGroups.map((group) => <TouchableOpacity key={group.id} style={[styles.enrollChoice, bulkPackageGroupIds[option.id] === group.id && styles.enrollChoiceActive]} onPress={() => setBulkPackageGroupIds((current) => ({ ...current, [option.id]: group.id }))}><Text style={styles.groupPickHeader}>{group.name}</Text><Text style={styles.groupPickMeta}>{[group.teacherName, group.grade].filter(Boolean).join(" · ")} · {groupScheduleLabel(group.id)}</Text></TouchableOpacity>)}</>}</View>; })}</>}
          </ScrollView>
          <View style={styles.modalFooter}><AppButton title="تسجيل الكل" onPress={enrollSelectedStudents} /></View>
        </View></View>
      </Modal>

      {/* 1. Add Student Guided Wizard Modal */}
      <AddStudentWizardModal
        visible={isAddStudentOpen}
        keepOpenAfterCreate={!attendanceSessionId}
        onClose={() => {
          setIsAddStudentOpen(false);
          if (attendanceSessionId && !returningToAttendanceAfterCreateRef.current) {
            router.replace({ pathname: "/(main)/scanner", params: { attendanceSessionId: String(attendanceSessionId) } } as any);
          }
          returningToAttendanceAfterCreateRef.current = false;
          setReturningToAttendanceAfterCreate(false);
        }}
        onStudentCreated={(createdStudent) => {
          loadData();
          if (attendanceSessionId && createdStudent?.id) {
            setReturningToAttendanceAfterCreate(true);
            returningToAttendanceAfterCreateRef.current = true;
            router.replace({ pathname: "/(main)/scanner", params: { attendanceSessionId: String(attendanceSessionId), addedStudentId: createdStudent.id } } as any);
          }
        }}
      />

      <Modal visible={cardScannerOpen} animationType="slide" transparent onRequestClose={() => setCardScannerOpen(false)}>
        <View style={styles.cardScannerOverlay}>
          <View style={styles.cardScannerSheet}>
            <Text style={styles.cardScannerTitle}>امسح كارت الطالب</Text>
            <BarcodeScannerView onDetected={(data) => handleStudentCardScan({ data })} onClose={() => setCardScannerOpen(false)} style={styles.cardScannerCamera} />
            <TouchableOpacity style={styles.cardScannerClose} onPress={() => setCardScannerOpen(false)}><Text style={styles.cardScannerCloseText}>إلغاء</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Student profile, rebuilt as a full-screen profile with section navigation. */}
      {selectedStudent && (
        <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => { setGroupDetailsModalOpen(false); setSelectedStudent(null); }}>
          <SafeAreaView style={styles.profileScreen}>
            <View style={styles.profileTopBar}>
              <TouchableOpacity style={styles.profileTopButton} accessibilityLabel="رجوع" onPress={() => { setGroupDetailsModalOpen(false); setSelectedStudent(null); }}><Ionicons name="chevron-forward" size={22} color={Colors.slate900} /></TouchableOpacity>
              <Text style={styles.profileTopTitle}>بيانات الطالب</Text>
              {canUpdateStudent ? <TouchableOpacity style={styles.profileTopButton} accessibilityLabel="تعديل بيانات الطالب" onPress={openStudentEdit}><Ionicons name="create-outline" size={21} color={Colors.primary} /></TouchableOpacity> : <View style={{ width: 40 }} />}
            </View>
            <ScrollView style={styles.profileMainScroll} contentContainerStyle={styles.profileContent} showsVerticalScrollIndicator={false}>
              <View style={styles.profileHero}>
                <View style={styles.profileAvatarLarge}><Text style={styles.profileAvatarLargeText}>{selectedStudent.fullName.trim().charAt(0) || "ط"}</Text></View>
                <Text style={styles.profileStudentName}>{selectedStudent.fullName}</Text>
                <Text style={styles.profileGrade}>{selectedStudent.grade}</Text>
                <Text style={styles.profileGroupSummary} numberOfLines={2}>{studentEnrollments.length ? studentEnrollments.map((item) => item.groupName || availableGroups.find((group) => group.id === item.groupId)?.name).filter(Boolean).join(" · ") : "غير مسجل في مجموعة حالية"}</Text>
              </View>

              <View style={styles.profileContactList}>
                <TouchableOpacity style={styles.profileContactRow} onPress={() => callNumber(selectedStudent.phone, "رقم الطالب")}><View style={styles.profileContactText}><Text style={styles.profileContactLabel}>رقم الهاتف</Text><Text style={styles.profileContactValue} selectable>{selectedStudent.phone || "غير مسجل"}</Text></View><View style={styles.profileContactIcon}><Ionicons name="call" size={20} color={Colors.primary} /></View><Ionicons name="chevron-back" size={18} color={Colors.slate500} /></TouchableOpacity>
                <TouchableOpacity style={styles.profileContactRow} onPress={() => callNumber(selectedStudent.parentPhone, "رقم ولي الأمر")}><View style={styles.profileContactText}><Text style={styles.profileContactLabel}>رقم ولي الأمر</Text><Text style={styles.profileContactValue} selectable>{selectedStudent.parentPhone || "غير مسجل"}</Text></View><View style={styles.profileContactIcon}><Ionicons name="call" size={20} color={Colors.primary} /></View><Ionicons name="chevron-back" size={18} color={Colors.slate500} /></TouchableOpacity>
                <View style={styles.profileContactRow}><View style={styles.profileContactText}><Text style={styles.profileContactLabel}>كود الطالب</Text><Text style={styles.profileContactValue} selectable>{formatDisplayIdentifier(selectedStudent.studentCode)}</Text></View><View style={styles.profileContactIcon}><Ionicons name="barcode-outline" size={21} color={Colors.primary} /></View><Ionicons name="chevron-back" size={18} color={Colors.slate400} /></View>
              </View>

              <View style={styles.profilePrimaryActions}>
                <TouchableOpacity style={styles.profileCodeButton} onPress={() => setBarcodeModalOpen(true)}><Ionicons name="barcode-outline" size={20} color={Colors.white} /><Text style={styles.profileCodeButtonText}>عرض كود الطالب</Text></TouchableOpacity>
                {canManageCards && <TouchableOpacity style={styles.profileManageCardButton} onPress={() => setIsCardModalOpen(true)}><Ionicons name="card-outline" size={19} color={Colors.primary} /><Text style={styles.profileManageCardText}>إدارة البطاقة</Text></TouchableOpacity>}
              </View>
              <View style={styles.profileCardList}>
                <Text style={styles.profileRowTitle}>الكارت الحالي</Text>
                <Text style={styles.profileRowMeta}>{selectedStudent.cardCode ? formatDisplayIdentifier(selectedStudent.cardCode) : "لا يوجد كارت حالي"}</Text>
              </View>
              {canDeactivate && <TouchableOpacity style={styles.profileDeactivateButton} onPress={handleDeleteStudent}><Ionicons name="trash-outline" size={17} color={Colors.danger} /><Text style={styles.profileDeactivateText}>حذف الطالب</Text></TouchableOpacity>}

              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.profileTabsScroller} contentContainerStyle={styles.profileTabs}>
                {([
                  ["groups", "المجموعات", "people-outline"], ...(canViewPackages ? [["packages", "الباقات", "card-outline"] as const] : []), ...(canViewAttendance ? [["attendance", "الحضور والغياب", "calendar-outline"] as const] : []), ...(canViewPayments ? [["payments", "المدفوعات", "wallet-outline"] as const] : []), ["notes", "الملاحظات", "document-text-outline"],
                ] as const).map(([key, label, icon]) => <TouchableOpacity key={key} style={[styles.profileTab, profileTab === key && styles.profileTabActive]} onPress={() => setProfileTab(key)}><Ionicons name={icon} size={16} color={profileTab === key ? Colors.primary : Colors.slate500} /><Text style={[styles.profileTabText, profileTab === key && styles.profileTabTextActive]}>{label}</Text></TouchableOpacity>)}
                <TouchableOpacity key="activity" style={[styles.profileTab, profileTab === "activity" && styles.profileTabActive]} onPress={() => setProfileTab("activity")}><Ionicons name="time-outline" size={16} color={profileTab === "activity" ? Colors.primary : Colors.slate500} /><Text style={[styles.profileTabText, profileTab === "activity" && styles.profileTabTextActive]}>سجل النشاط</Text></TouchableOpacity>
              </ScrollView>

              {profileTab === "groups" && <View style={styles.profileSection}>
                <View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>المجموعات</Text><Text style={styles.profileSectionCaption}>{studentEnrollments.length} مجموعة نشطة</Text></View>{canEnroll && <TouchableOpacity style={styles.profileInlineAction} onPress={openEnrollModal}><Ionicons name="add" size={18} color={Colors.primary} /><Text style={styles.profileInlineActionText}>تسجيل</Text></TouchableOpacity>}</View>
                {studentEnrollments.length === 0 ? <View style={styles.profileEmpty}><Ionicons name="people-outline" size={25} color={Colors.slate400} /><Text style={styles.profileEmptyTitle}>لا توجد مجموعات حالية</Text><Text style={styles.profileEmptyText}>ستظهر هنا المجموعات المسجل بها الطالب.</Text></View> : studentEnrollments.map((enrollment) => { const group = availableGroups.find((item) => item.id === enrollment.groupId); return <View key={enrollment.id} style={styles.profileListRow}><TouchableOpacity style={styles.profileRowMain} onPress={() => group && router.push({ pathname: "/(main)/group-details", params: { groupId: group.id } })}><View style={styles.profileRowIcon}><Ionicons name="people-outline" size={19} color={Colors.primary} /></View><View style={styles.profileRowCopy}><Text style={styles.profileRowTitle}>{enrollment.groupName || group?.name || "مجموعة"}</Text><Text style={styles.profileRowMeta}>{[group?.subjectName, group?.teacherName, group?.grade].filter(Boolean).join(" · ") || selectedStudent.grade}</Text><Text style={styles.profileRowMeta}>{groupScheduleLabel(enrollment.groupId)} · منذ {enrollment.startDate}</Text></View><Ionicons name="chevron-back" size={17} color={Colors.slate500} /></TouchableOpacity><View style={styles.profileRowActions}><TouchableOpacity onPress={() => openGroupPanel(enrollment.groupId, "attendance")}><Text style={styles.profileSmallAction}>الحضور</Text></TouchableOpacity><TouchableOpacity onPress={() => openGroupGrades(enrollment.groupId)}><Text style={styles.profileSmallAction}>الدرجات</Text></TouchableOpacity>{enrollment.status === "active" && canEnroll && <TouchableOpacity onPress={() => openTransferModal(enrollment.id)}><Text style={styles.profileSmallAction}>تحويل</Text></TouchableOpacity>}{enrollment.status === "active" && PermissionService.hasPermission(permissions, "enrollments.end") && <TouchableOpacity onPress={() => handleEndEnrollment(enrollment.id)}><Text style={styles.profileSmallDanger}>إنهاء</Text></TouchableOpacity>}</View></View>; })}
              </View>}

              {profileTab === "packages" && canViewPackages && <View style={styles.profileSection}>
                <View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>الباقات</Text><Text style={styles.profileSectionCaption}>الاشتراكات المسجلة للطالب</Text></View>{PermissionService.hasPermission(permissions, "packages.subscribe") && availablePackages.length > 0 && <TouchableOpacity style={styles.profileInlineAction} onPress={openPackageModal}><Ionicons name="add" size={18} color={Colors.primary} /><Text style={styles.profileInlineActionText}>إضافة</Text></TouchableOpacity>}</View>
                {studentSubscriptions.length === 0 ? <View style={styles.profileEmpty}><Ionicons name="card-outline" size={25} color={Colors.slate400} /><Text style={styles.profileEmptyTitle}>لا توجد باقات مسجلة</Text><Text style={styles.profileEmptyText}>ستظهر هنا تفاصيل اشتراكات الطالب.</Text></View> : studentSubscriptions.map((subscription) => { let subjects: PackageSubject[] = []; let overrides: ReturnType<typeof PackageSubscriptionRepository.getTeacherOverrides> = []; try { subjects = PackageRepository.getPackageSubjects(subscription.packageId); overrides = PackageSubscriptionRepository.getTeacherOverrides(subscription.id); } catch {} return <View key={subscription.id} style={styles.profilePackageRow}><View style={styles.profileSectionHeader}><View style={{ flex: 1 }}><Text style={styles.profileRowTitle}>{subscription.packageName || "باقة"}</Text><Text style={styles.profileRowMeta}>{subscription.startDate}{subscription.endDate ? ` إلى ${subscription.endDate}` : " · مستمرة"}</Text></View><StatusBadge text={subscription.status === "active" ? "نشطة" : subscription.status === "cancelled" ? "ملغاة" : "منتهية"} type={subscription.status === "active" ? "success" : "neutral"} /></View>{subjects.map((subject) => { const override = overrides.find((item) => item.subjectId === subject.subjectId); const teacherName = teachers.find((item) => item.id === (override?.teacherId || subject.defaultTeacherId))?.name || override?.teacherName || subject.defaultTeacherName || "غير محدد"; return <View key={subject.id} style={styles.profileSubjectRow}><Text style={styles.profileSubjectName}>{subject.subjectName || "مادة"}{subject.groupName ? ` · ${subject.groupName}` : ""}</Text><Text style={styles.profileRowMeta}>المدرس: {teacherName}</Text></View>; })}{typeof subscription.packagePrice === "number" && <Text style={styles.profilePackagePrice}>قيمة الباقة: {formatCurrency(subscription.packagePrice)}</Text>}{subscription.status === "active" && PermissionService.hasPermission(permissions, "packages.manage") && <TouchableOpacity style={styles.profileSmallDangerButton} onPress={() => handleCancelPackage(subscription)}><Text style={styles.profileSmallDanger}>إلغاء الاشتراك</Text></TouchableOpacity>}</View>; })}
              </View>}

              {profileTab === "attendance" && canViewAttendance && <View style={styles.profileSection}><View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>الحضور والغياب</Text><Text style={styles.profileSectionCaption}>ملخص حضور الطالب في جميع مجموعاته</Text></View></View>{attendanceSummaries.length === 0 ? <View style={styles.profileEmpty}><Ionicons name="calendar-outline" size={25} color={Colors.slate400} /><Text style={styles.profileEmptyTitle}>لا توجد سجلات حضور</Text><Text style={styles.profileEmptyText}>ستظهر بيانات الحضور بعد تسجيل الجلسات.</Text></View> : attendanceSummaries.map((summary) => <View key={summary.groupId} style={styles.profileAttendanceGroup}><View style={styles.profileSectionHeader}><Text style={styles.profileRowTitle}>{summary.groupName}</Text><TouchableOpacity onPress={() => openGroupPanel(summary.groupId, "attendance")}><Text style={styles.profileSmallAction}>السجل</Text></TouchableOpacity></View><Text style={styles.profileRowMeta}>{[summary.subjectName, summary.teacherName].filter(Boolean).join(" · ")}</Text><View style={styles.profileAttendanceMetrics}><View><Text style={styles.profileAttendanceValue}>{summary.presentCount}</Text><Text style={styles.profileAttendanceLabel}>حضور</Text></View><View><Text style={[styles.profileAttendanceValue, { color: Colors.danger }]}>{summary.absentCount}</Text><Text style={styles.profileAttendanceLabel}>غياب</Text></View><View><Text style={[styles.profileAttendanceValue, { color: Colors.warning }]}>{summary.makeupCount}</Text><Text style={styles.profileAttendanceLabel}>تعويض</Text></View><View><Text style={styles.profileAttendanceValue}>{summary.expectedSessions}</Text><Text style={styles.profileAttendanceLabel}>حصص</Text></View></View></View>)}<Text style={styles.profileSubsectionTitle}>آخر السجلات</Text>{studentAttendance.slice(0, 12).map((row) => <View key={row.id} style={styles.profileHistoryRow}><View style={styles.profileHistoryIcon}><Ionicons name={row.attendanceType === "makeup" ? "refresh-outline" : "checkmark-outline"} size={16} color={row.attendanceType === "makeup" ? Colors.warning : Colors.success} /></View><View style={styles.profileRowCopy}><Text style={styles.profileRowTitle}>{row.attendanceType === "makeup" ? "حصة تعويضية" : row.status === "late" ? "حضور متأخر" : "حضور"}</Text><Text style={styles.profileRowMeta}>{row.groupName || "مجموعة"} · {row.checkInTime?.slice(0, 16).replace("T", " ") || "بدون تاريخ"}</Text></View></View>)}</View>}

              {profileTab === "payments" && canViewPayments && <View style={styles.profileSection}><View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>{Strings.financialStatusTitle}</Text><Text style={styles.profileSectionCaption}>الموقف المالي وسجل المدفوعات</Text></View>{canCreatePayment && <TouchableOpacity style={styles.profileInlineAction} onPress={() => { setPaymentAmount(""); setPaymentType("monthly"); setPaymentCycleId(""); setPaymentNotes(""); setIsPaymentModalOpen(true); }}><Ionicons name="add" size={18} color={Colors.primary} /><Text style={styles.profileInlineActionText}>تسجيل دفعة</Text></TouchableOpacity>}</View>{!financialStatus ? <View style={styles.profileEmpty}><Text style={styles.profileEmptyText}>تعذر تحميل بيانات المدفوعات.</Text></View> : <><View style={styles.profileFinanceSummary}><View><Text style={styles.profileFinanceLabel}>{Strings.totalDueLabel}</Text><Text style={styles.profileFinanceValue}>{formatCurrency(financialStatus.monthlyTotalDue)}</Text></View><View><Text style={styles.profileFinanceLabel}>{Strings.totalPaidLabel}</Text><Text style={[styles.profileFinanceValue, { color: Colors.successText }]}>{formatCurrency(financialStatus.monthlyTotalPaid)}</Text></View><View><Text style={styles.profileFinanceLabel}>{Strings.remainingBalanceLabel}</Text><Text style={[styles.profileFinanceValue, { color: Colors.dangerText }]}>{formatCurrency(financialStatus.monthlyRemainingDebt)}</Text></View></View>{financialStatus.sessionDebt && <View style={styles.profileSessionDebt}><Text style={styles.profileRowTitle}>مديونية الحصص الحالية</Text><Text style={styles.profileRowMeta}>{financialStatus.sessionDebt.periodStart} إلى {financialStatus.sessionDebt.periodEnd}</Text><Text style={styles.profileFinanceValue}>{formatCurrency(financialStatus.sessionDebt.currentDebt)}</Text></View>}<Text style={styles.profileSubsectionTitle}>{Strings.debtCyclesTitle}</Text>{financialStatus.cycles.length ? financialStatus.cycles.map((cycle) => <View key={cycle.id} style={styles.profilePaymentRow}><View style={styles.profileRowCopy}><Text style={styles.profileRowTitle}>{Strings.cycleNumberPrefix} {cycle.cycleNumber} · {cycle.groupName || "مجموعة"}</Text><Text style={styles.profileRowMeta}>{cycle.startDate} إلى {cycle.endDate} · المتبقي {formatCurrency(cycle.remainingDebt ?? 0)}</Text></View><View style={styles.profilePaymentActions}>{cycle.status === "paid" ? <StatusBadge text={Strings.cycleStatusPaid} type="success" /> : <StatusBadge text={cycle.status === "partial" ? Strings.cycleStatusPartial : Strings.cycleStatusOpen} type="warning" />}{canAdjustDebt && <TouchableOpacity onPress={() => { setTargetCycleForAdj(cycle); setAdjAmount(""); setAdjReason(""); setIsAdjModalOpen(true); }}><Ionicons name="create-outline" size={18} color={Colors.primary} /></TouchableOpacity>}</View></View>) : <Text style={styles.profileEmptyText}>لا توجد دورات مديونية مسجلة.</Text>}<Text style={styles.profileSubsectionTitle}>سجل المدفوعات النقدية</Text>{financialStatus.payments.length ? financialStatus.payments.map((payment) => <View key={payment.id} style={styles.profilePaymentRow}><View style={styles.profileRowCopy}><Text style={[styles.profileRowTitle, payment.isReversed && styles.strikeText]}>{formatCurrency(payment.amount)} · {payment.paymentType === "session" ? "حصة" : payment.paymentType === "monthly" ? "شهري" : "جزئي"}</Text><Text style={styles.profileRowMeta}>{payment.paymentDate || payment.createdAt.slice(0, 10)}{payment.notes ? ` · ${payment.notes}` : ""}</Text></View>{payment.isReversed ? <StatusBadge text={Strings.reversedBadge} type="danger" /> : canReversePayment ? <TouchableOpacity style={styles.reverseBtn} onPress={() => { setTargetPaymentForRev(payment); setRevReason(""); setIsRevModalOpen(true); }}><Text style={styles.reverseBtnText}>{Strings.reversePaymentButton}</Text></TouchableOpacity> : null}</View>) : <Text style={styles.profileEmptyText}>لا توجد مدفوعات مسجلة.</Text>}</>}</View>}

              {profileTab === "notes" && <View style={styles.profileSection}><View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>الملاحظات</Text><Text style={styles.profileSectionCaption}>ملاحظة الطالب المحفوظة في بياناته</Text></View>{canUpdateStudent && <TouchableOpacity style={styles.profileInlineAction} onPress={openStudentEdit}><Ionicons name="create-outline" size={17} color={Colors.primary} /><Text style={styles.profileInlineActionText}>{selectedStudent.notes ? "تعديل" : "إضافة"}</Text></TouchableOpacity>}</View>{selectedStudent.notes?.trim() ? <View style={styles.profileNoteCard}><Ionicons name="document-text-outline" size={18} color={Colors.primary} /><Text style={styles.profileNoteText}>{selectedStudent.notes}</Text></View> : <View style={styles.profileEmpty}><Ionicons name="document-text-outline" size={25} color={Colors.slate400} /><Text style={styles.profileEmptyTitle}>لا توجد ملاحظات بعد</Text><Text style={styles.profileEmptyText}>يمكنك إضافة ملاحظة ضمن بيانات الطالب.</Text></View>}</View>}
              {profileTab === "activity" && <View style={styles.profileSection}>
                {canUpdateStudent && <View style={styles.profileNoteCard}><AppInput value={noteText} onChangeText={setNoteText} placeholder="Ø£Ø¶Ù Ù…Ù„Ø§Ø­Ø¸Ø© Ø¬Ø¯ÙŠØ¯Ø©" multiline /><TouchableOpacity style={styles.profileInlineAction} onPress={() => void saveStudentNote()}><Ionicons name="save-outline" size={17} color={Colors.primary} /><Text style={styles.profileInlineActionText}>{editingNoteId ? "ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù…Ù„Ø§Ø­Ø¸Ø©" : "Ø­ÙØ¸ Ø§Ù„Ù…Ù„Ø§Ø­Ø¸Ø©"}</Text></TouchableOpacity></View>}
                {studentNotes.map((note) => <View key={note.id} style={styles.profilePaymentRow}><View style={styles.profileRowCopy}><Text style={styles.profileRowTitle}>{note.text}</Text><Text style={styles.profileRowMeta}>{note.createdByName || "Ø­Ø³Ø§Ø¨"} Â· {formatLocalDateTime(note.createdAt)}</Text></View><View style={styles.profilePaymentActions}><TouchableOpacity onPress={() => { setEditingNoteId(note.id); setNoteText(note.text); }}><Ionicons name="create-outline" size={18} color={Colors.primary} /></TouchableOpacity><TouchableOpacity onPress={() => void removeStudentNote(note.id)}><Ionicons name="trash-outline" size={18} color={Colors.danger} /></TouchableOpacity></View></View>)}
                <View style={styles.profileSectionHeader}><View><Text style={styles.profileSectionTitle}>سجل النشاط</Text><Text style={styles.profileSectionCaption}>من أضاف الطالب أو عدّل بياناته أو سجّل دفعة أو حضورًا</Text></View></View>
                {studentAuditLogs.length === 0 ? <Text style={styles.profileEmptyText}>لا يوجد نشاط مسجل لهذا الطالب.</Text> : studentAuditLogs.slice(0, 100).map((log) => { let payload: any = {}; try { payload = log.payload ? JSON.parse(log.payload) : {}; } catch {} const actionLabels: Record<string, string> = { "student.create": "تم إضافة الطالب", "student.update": "تم تعديل بيانات الطالب", "student.card_code.updated": "تم تحديث كود الكارت", "student.deactivate": "تم تعطيل الطالب", "student.delete": "تم حذف الطالب", "student_card.issue": "تم إصدار بطاقة جديدة", "student_card.deactivate": "تم تحديث سجل بطاقة قديم", "student_card.reactivate": "تم تحديث سجل بطاقة قديم", "attendance.record": "تم تسجيل الحضور", "attendance.makeup": "تم تسجيل تعويض", "payment.create": "تم تسجيل دفعة", "payment.delete": "تم حذف دفعة", "enrollment.create": "تم التسجيل في مجموعة", "enrollment.end": "تم إنهاء التسجيل", "enrollment.transfer": "تم تحويل المجموعة", "note.create": "تم إضافة ملاحظة", "note.update": "تم تعديل ملاحظة", "note.delete": "تم حذف ملاحظة" }; const actionLabel = actionLabels[log.action] || log.action; return <View key={log.id} style={styles.profileHistoryRow}><View style={styles.profileHistoryIcon}><Ionicons name="time-outline" size={16} color={Colors.primary} /></View><View style={styles.profileRowCopy}><Text style={styles.profileRowTitle}>{actionLabel}</Text><Text style={styles.profileRowMeta}>{payload.actorName || (log.userId === currentUser?.id ? currentUser?.fullName : `مستخدم`)} · {formatLocalDateTime(log.timestamp)}</Text></View></View>; })}
              </View>}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}

      <Modal visible={barcodeModalOpen} animationType="fade" transparent onRequestClose={() => setBarcodeModalOpen(false)}>
        <View style={styles.modalOverlay}><View style={styles.barcodeModalCard}><View style={styles.profileSectionHeader}><Text style={styles.profileSectionTitle}>كود الطالب</Text><TouchableOpacity accessibilityLabel="إغلاق" onPress={() => setBarcodeModalOpen(false)}><Ionicons name="close" size={24} color={Colors.slate600} /></TouchableOpacity></View><Text style={styles.barcodeModalHint}>اعرض هذا الرمز لمسحه بواسطة قارئ FIXION</Text>{selectedStudent && <StudentCodeBarcode value={selectedStudent.studentCode} />}<Text style={styles.barcodeCodeText}>{selectedStudent ? formatDisplayIdentifier(selectedStudent.studentCode) : ""}</Text><TouchableOpacity style={styles.barcodeCloseButton} onPress={() => setBarcodeModalOpen(false)}><Text style={styles.barcodeCloseButtonText}>إغلاق</Text></TouchableOpacity></View></View>
      </Modal>

      {/* Legacy modal is intentionally disabled; the full-screen profile above uses the same repositories and actions. */}
      {selectedStudent && (
        <Modal visible={false} animationType="fade" transparent>
          <View style={styles.modalOverlay}>
            <View style={styles.detailsModalCard}>
              <View style={styles.modalHeader}>
                <View style={styles.profileIdentity}>
                  <View style={styles.avatar}><Text style={styles.avatarText}>{selectedStudent.fullName.trim().charAt(0) || "ط"}</Text></View>
                  <View style={styles.profileCopy}>
                  <Text style={styles.modalTitle}>
                    {selectedStudent.fullName}
                  </Text>
                  <Text style={styles.modalSubtitle}>
                    كود: {formatDisplayIdentifier(selectedStudent.studentCode)}
                  </Text>
                    <View style={styles.profileStatus}><View style={styles.statusDot} /><Text style={styles.profileStatusText}>{selectedStudent.status === "active" ? "نشط" : "غير نشط"} · {selectedStudent.grade}</Text></View>
                  </View>
                </View>
                <TouchableOpacity onPress={() => { setGroupDetailsModalOpen(false); setSelectedStudent(null); }}>
                  <Ionicons name="close" size={24} color={Colors.slate500} />
                </TouchableOpacity>
              </View>
              <View style={styles.profileActions}>
                {canUpdateStudent && <TouchableOpacity style={styles.profileAction} onPress={openStudentEdit}><Ionicons name="create-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>تعديل</Text></TouchableOpacity>}
                {PermissionService.hasPermission(permissions, "notifications.send") && <TouchableOpacity style={styles.profileAction} onPress={() => setIsCustomSmsModalOpen(true)}><Ionicons name="chatbubble-ellipses-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>SMS لولي الأمر</Text></TouchableOpacity>}
                <TouchableOpacity style={styles.profileAction} onPress={() => setIsCardModalOpen(true)}><Ionicons name="card-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>الكارت</Text></TouchableOpacity>
                <TouchableOpacity style={styles.profileAction} onPress={handleCallStudent}><Ionicons name="call-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>اتصال</Text></TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 500 }}>
                {/* Info Card */}
                <View style={styles.sectionBox}>
                  <Text style={styles.sectionTitle}>البيانات الأساسية</Text>
                  <Text style={styles.infoLine}>
                    المرحلة: {selectedStudent.grade}
                  </Text>
                  <Text style={styles.infoLine}>
                    هاتف الطالب: {selectedStudent.phone}
                  </Text>
                  <Text style={styles.infoLine}>
                    هاتف ولي الأمر: {selectedStudent.parentPhone}
                  </Text>
                  {selectedStudent.notes && (
                    <Text style={styles.infoLine}>
                      ملاحظات: {selectedStudent.notes}
                    </Text>
                  )}
                </View>

                {/* Physical Card Management */}
                <View style={styles.sectionBox}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>
                      بطاقة الطالب (RFID / Barcode)
                    </Text>
                    {canManageCards && (
                      <TouchableOpacity
                        style={styles.smallActionBtn}
                        onPress={() => setIsCardModalOpen(true)}
                      >
                        <Ionicons name="card" size={14} color={Colors.white} />
                        <Text style={styles.smallActionBtnText}>
                          استبدال الكارت
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={styles.cardItemRow}>
                    <View>
                      <Text style={styles.cardItemCode}>
                        كود الكارت الحالي: {selectedStudent.cardCode ? formatDisplayIdentifier(selectedStudent.cardCode) : "لا يوجد"}
                      </Text>
                      <Text style={styles.cardItemMeta}>
                        استبدال الكود يعدل بطاقة الطالب الحالية فقط.
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Group Enrollments */}
                <View style={styles.sectionBox}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>المجموعات</Text>
                    {canEnroll && (
                      <TouchableOpacity
                        style={styles.smallActionBtn}
                        onPress={openEnrollModal}
                      >
                        <Ionicons
                          name="add-circle"
                          size={14}
                          color={Colors.white}
                        />
                        <Text style={styles.smallActionBtnText}>
                          تسجيل بمجموعة
                        </Text>
                      </TouchableOpacity>
                    )}
                    {PermissionService.hasPermission(permissions, "packages.subscribe") && availablePackages.length > 0 && (
                      <TouchableOpacity style={styles.smallActionBtn} onPress={openPackageModal}>
                        <Ionicons name="pricetags-outline" size={14} color={Colors.white} />
                        <Text style={styles.smallActionBtnText}>تحويل إلى باقة</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {studentEnrollments.length === 0 ? (
                    <Text style={styles.emptyText}>
                      الطالب غير مسجل في أي مجموعة حالياً.
                    </Text>
                  ) : (
                    studentEnrollments.map((enr) => {
                      const group = availableGroups.find((item) => item.id === enr.groupId);
                      const attendance = attendanceSummaries.find(
                        (summary) => summary.groupId === enr.groupId,
                      );
                      const panel = selectedGroupPanel?.groupId === enr.groupId
                        ? selectedGroupPanel.panel
                        : null;
                      const groupFinancial = panel === "finance" ? groupFinancialStatus : null;
                      return (
                        <View key={enr.id} style={styles.groupCard}>
                          <View style={styles.groupCardHeader}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.groupCardName}>{enr.groupName || group?.name || "المجموعة"}</Text>
                              <Text style={styles.groupCardMeta}>
                                {[group?.subjectName, group?.teacherName, group?.grade].filter(Boolean).join(" • ")}{group ? " • " : ""}بدء: {enr.startDate}{enr.specialMonthlyPrice ? ` • ${enr.specialMonthlyPrice} ج.م` : ""}
                              </Text>
                            </View>
                            {canEnroll && enr.status === "active" && (
                              <TouchableOpacity onPress={() => handleEndEnrollment(enr.id)} style={styles.endEnrollBtn}>
                                <Text style={styles.endEnrollBtnText}>إنهاء</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                          <View style={styles.groupActionRow}>
                            <TouchableOpacity style={[styles.groupActionButton, panel === "attendance" && styles.groupActionButtonActive]} onPress={() => openGroupPanel(enr.groupId, "attendance")}>
                              <Ionicons name="calendar-outline" size={16} color={panel === "attendance" ? Colors.white : Colors.primary} />
                              <Text style={[styles.groupActionText, panel === "attendance" && styles.groupActionTextActive]}>الحضور</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.groupActionButton, panel === "finance" && styles.groupActionButtonActive]} onPress={() => openGroupPanel(enr.groupId, "finance")}>
                              <Ionicons name="wallet-outline" size={16} color={panel === "finance" ? Colors.white : Colors.primary} />
                              <Text style={[styles.groupActionText, panel === "finance" && styles.groupActionTextActive]}>المالي</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.groupActionButton} onPress={() => openGroupGrades(enr.groupId)}>
                              <Ionicons name="school-outline" size={16} color={Colors.primary} />
                              <Text style={styles.groupActionText}>الدرجات</Text>
                            </TouchableOpacity>
                          </View>
                          {panel === "attendance" && (
                            <View style={styles.groupInlinePanel}>
                              <Text style={styles.groupInlinePanelTitle}>حالة الحضور</Text>
                              <View style={styles.groupInlineMetricRow}>
                                <Text style={styles.groupInlineMetric}>متوقع: {attendance?.expectedSessions ?? 0}</Text>
                                <Text style={[styles.groupInlineMetric, { color: Colors.successText }]}>حضور: {attendance?.presentCount ?? 0}</Text>
                                <Text style={[styles.groupInlineMetric, { color: Colors.dangerText }]}>غياب: {attendance?.absentCount ?? 0}</Text>
                                <Text style={[styles.groupInlineMetric, { color: Colors.warningText }]}>تعويض: {attendance?.makeupCount ?? 0}</Text>
                              </View>
                            </View>
                          )}
                          {panel === "finance" && groupFinancial && (
                            <View style={styles.groupInlinePanel}>
                              <Text style={styles.groupInlinePanelTitle}>الموقف المالي للمجموعة</Text>
                              <View style={styles.groupInlineMetricRow}>
                                <Text style={styles.groupInlineMetric}>المستحق: {formatCurrency(groupFinancial.monthlyTotalDue)}</Text>
                                <Text style={[styles.groupInlineMetric, { color: Colors.successText }]}>المدفوع: {formatCurrency(groupFinancial.monthlyTotalPaid)}</Text>
                                <Text style={[styles.groupInlineMetric, { color: Colors.dangerText }]}>المتبقي: {formatCurrency(groupFinancial.monthlyRemainingDebt)}</Text>
                              </View>
                            </View>
                          )}
                        </View>
                      );
                    })
                  )}
                </View>

                {/* Attendance profile: totals are grouped by the session's group. */}
                <View style={[styles.sectionBox, { display: "none" }]}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>سجل الحضور والغياب حسب المجموعة</Text>
                    <Ionicons name="calendar-outline" size={18} color={Colors.primary} />
                  </View>
                  {attendanceSummaries.length === 0 ? (
                    <Text style={styles.emptyText}>لا توجد حصص مسجلة لهذا الطالب حتى الآن.</Text>
                  ) : (
                    attendanceSummaries.map((summary) => (
                      <View key={summary.groupId} style={styles.attendanceSummaryCard}>
                        <Text style={styles.attendanceSummaryTitle}>{summary.groupName}</Text>
                        <Text style={styles.attendanceSummaryMeta}>
                          {[summary.subjectName, summary.teacherName].filter(Boolean).join(" • ") || "بيانات المجموعة"}
                        </Text>
                        <View style={styles.attendanceMetricRow}>
                          <View style={styles.attendanceMetric}>
                            <Text style={styles.attendanceMetricValue}>{summary.expectedSessions}</Text>
                            <Text style={styles.attendanceMetricLabel}>حصص متوقعة</Text>
                          </View>
                          <View style={styles.attendanceMetric}>
                            <Text style={[styles.attendanceMetricValue, { color: Colors.successText }]}>{summary.presentCount}</Text>
                            <Text style={styles.attendanceMetricLabel}>حضور</Text>
                          </View>
                          <View style={styles.attendanceMetric}>
                            <Text style={[styles.attendanceMetricValue, { color: Colors.dangerText }]}>{summary.absentCount}</Text>
                            <Text style={styles.attendanceMetricLabel}>غياب</Text>
                          </View>
                          <View style={styles.attendanceMetric}>
                            <Text style={[styles.attendanceMetricValue, { color: Colors.warningText }]}>{summary.makeupCount}</Text>
                            <Text style={styles.attendanceMetricLabel}>تعويض</Text>
                          </View>
                        </View>
                        {summary.makeupCount > 0 ? <Text style={styles.makeupSummaryText}>حضر في هذه المجموعة كحصة تعويضية.</Text> : null}
                      </View>
                    ))
                  )}
                </View>

                {/* Financial Core: Debt Cycles & Cash Payments */}
                {canViewPayments && financialStatus && (
                  <View style={[styles.sectionBox, { display: "none" }]}>
                    <View style={styles.sectionHeaderRow}>
                      <Text style={styles.sectionTitle}>
                        {Strings.financialStatusTitle}
                      </Text>
                      {canCreatePayment && (
                        <TouchableOpacity
                          style={styles.smallActionBtn}
                          onPress={() => {
                            setPaymentAmount("");
                            setPaymentType("monthly");
                            setPaymentCycleId("");
                            setPaymentNotes("");
                            setIsPaymentModalOpen(true);
                          }}
                        >
                          <Ionicons
                            name="cash-outline"
                            size={14}
                            color={Colors.white}
                          />
                          <Text style={styles.smallActionBtnText}>
                            تسجيل دفعة
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* Financial Summary Cards */}
                    <View style={styles.finSummaryRow}>
                      <View
                        style={[
                          styles.finSummaryCard,
                          { borderLeftColor: Colors.primary },
                        ]}
                      >
                        <Text style={styles.finSummaryLabel}>
                          {Strings.totalDueLabel}
                        </Text>
                        <Text style={styles.finSummaryValue}>
                          {formatCurrency(financialStatus.monthlyTotalDue)}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.finSummaryCard,
                          { borderLeftColor: Colors.success },
                        ]}
                      >
                        <Text style={styles.finSummaryLabel}>
                          {Strings.totalPaidLabel}
                        </Text>
                        <Text style={styles.finSummaryValue}>
                          {formatCurrency(financialStatus.monthlyTotalPaid)}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.finSummaryCard,
                          { borderLeftColor: Colors.danger },
                        ]}
                      >
                        <Text style={styles.finSummaryLabel}>
                          {Strings.remainingBalanceLabel}
                        </Text>
                        <Text style={styles.finSummaryValue}>
                          {formatCurrency(financialStatus.monthlyRemainingDebt)}
                        </Text>
                      </View>
                    </View>

                    {financialStatus.sessionDebt && (
                      <View style={styles.sessionDebtCard}>
                        <Text style={styles.sessionDebtTitle}>تفصيل حصص الشهر</Text>
                        <Text style={styles.sessionDebtPeriod}>
                          {financialStatus.sessionDebt.periodStart} - {financialStatus.sessionDebt.periodEnd}
                        </Text>
                        <View style={styles.sessionDebtGrid}>
                          <Text style={styles.sessionDebtItem}>متبقية غير مدفوعة: {financialStatus.sessionDebt.futureUnpaidSessions}</Text>
                          <Text style={styles.sessionDebtItem}>متبقية مدفوعة: {financialStatus.sessionDebt.futurePaidSessions}</Text>
                          <Text style={styles.sessionDebtItem}>حضر ودفع: {financialStatus.sessionDebt.attendedPaidSessions}</Text>
                          <Text style={styles.sessionDebtItem}>حضر ولم يدفع: {financialStatus.sessionDebt.attendedUnpaidSessions}</Text>
                        </View>
                        <Text style={styles.sessionDebtAmount}>المديونية الحالية: {formatCurrency(financialStatus.sessionDebt.currentDebt)}</Text>
                      </View>
                    )}

                    {/* Session Payments Note/Total if any */}
                    {financialStatus.sessionTotalPaid > 0 && (
                      <View style={styles.sessionPaymentsBanner}>
                        <Text style={styles.sessionPaymentsBannerTitle}>
                          {Strings.sessionPaymentsTitle}:{" "}
                          {formatCurrency(financialStatus.sessionTotalPaid)}
                        </Text>
                        <Text style={styles.sessionPaymentsBannerNote}>
                          {Strings.sessionPaymentsNote}
                        </Text>
                      </View>
                    )}

                    {/* Debt Cycles List */}
                    <Text
                      style={[
                        styles.sectionSubtitle,
                        { marginTop: Spacing.sm },
                      ]}
                    >
                      {Strings.debtCyclesTitle}
                    </Text>
                    {financialStatus.cycles.length === 0 ? (
                      <Text style={styles.emptyText}>
                        لا توجد دورات مديونية مسجلة.
                      </Text>
                    ) : (
                      financialStatus.cycles.map((cycle) => (
                        <View key={cycle.id} style={styles.cycleCard}>
                          <View style={styles.cycleHeader}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.cycleTitle}>
                                {Strings.cycleNumberPrefix} {cycle.cycleNumber}{" "}
                                ({cycle.groupName || "مجموعة"})
                              </Text>
                              <Text style={styles.cyclePeriod}>
                                {cycle.startDate} إلى {cycle.endDate}
                              </Text>
                            </View>
                            <StatusBadge
                              text={
                                cycle.status === "paid"
                                  ? Strings.cycleStatusPaid
                                  : cycle.status === "partial"
                                    ? Strings.cycleStatusPartial
                                    : Strings.cycleStatusOpen
                              }
                              type={
                                cycle.status === "paid"
                                  ? "success"
                                  : cycle.status === "partial"
                                    ? "warning"
                                    : "neutral"
                              }
                            />
                          </View>
                          <View style={styles.cyclePriceRow}>
                            <Text style={styles.cyclePriceText}>
                              الرسم: {cycle.effectivePrice ?? cycle.cyclePrice}{" "}
                              ج.م | مدفوع: {cycle.paidAmount ?? 0} ج.م | متبقي:{" "}
                              {cycle.remainingDebt ?? 0} ج.م
                            </Text>
                            {canAdjustDebt && (
                              <TouchableOpacity
                                style={styles.adjBtn}
                                onPress={() => {
                                  setTargetCycleForAdj(cycle);
                                  setAdjAmount("");
                                  setAdjReason("");
                                  setIsAdjModalOpen(true);
                                }}
                              >
                                <Ionicons
                                  name="create-outline"
                                  size={12}
                                  color={Colors.primary}
                                />
                                <Text style={styles.adjBtnText}>
                                  {Strings.addAdjustmentButton}
                                </Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                      ))
                    )}

                    {/* Payments History & Reversals */}
                    <Text
                      style={[
                        styles.sectionSubtitle,
                        { marginTop: Spacing.md },
                      ]}
                    >
                      سجل المدفوعات النقدية
                    </Text>
                    {financialStatus.payments.length === 0 ? (
                      <Text style={styles.emptyText}>
                        لا توجد مدفوعات مسجلة.
                      </Text>
                    ) : (
                      financialStatus.payments.map((p) => (
                        <View
                          key={p.id}
                          style={[
                            styles.paymentRow,
                            p.isReversed && styles.paymentRowReversed,
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <View
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              <Text
                                style={[
                                  styles.paymentAmount,
                                  p.isReversed && styles.strikeText,
                                ]}
                              >
                                {p.amount} ج.م
                              </Text>
                              <Text style={styles.paymentTypeTag}>
                                {p.paymentType === "session"
                                  ? "حصة منفصلة"
                                  : p.paymentType === "monthly"
                                    ? "شهري"
                                    : "جزئي"}
                              </Text>
                              {p.isReversed && (
                                <StatusBadge
                                  text={Strings.reversedBadge}
                                  type="danger"
                                />
                              )}
                            </View>
                            <Text style={styles.paymentMeta}>
                              التاريخ:{" "}
                              {p.paymentDate || p.createdAt.slice(0, 10)}
                              {p.notes ? ` • ${p.notes}` : ""}
                            </Text>
                          </View>
                          {canReversePayment && !p.isReversed && (
                            <TouchableOpacity
                              style={styles.reverseBtn}
                              onPress={() => {
                                setTargetPaymentForRev(p);
                                setRevReason("");
                                setIsRevModalOpen(true);
                              }}
                            >
                              <Text style={styles.reverseBtnText}>
                                {Strings.reversePaymentButton}
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      ))
                    )}
                  </View>
                )}

                {/* Deactivate Student */}
                {canDeactivate && selectedStudent.status === "active" && (
                  <View style={{ marginTop: Spacing.md }}>
                    <AppButton
                      title="تعطيل حساب الطالب"
                      variant="outline"
                      onPress={handleDeleteStudent}
                      style={{ borderColor: Colors.danger }}
                    />
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      <Modal visible={isStudentEditModalOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setIsStudentEditModalOpen(false)}>
        <SafeAreaView style={styles.profileScreen}>
          <View style={styles.profileTopBar}><TouchableOpacity style={styles.profileTopButton} onPress={() => setIsStudentEditModalOpen(false)} accessibilityLabel="إغلاق التعديل"><Ionicons name="close" size={22} color={Colors.slate900} /></TouchableOpacity><Text style={styles.profileTopTitle}>تعديل بيانات الطالب</Text><View style={{ width: 40 }} /></View>
          <ScrollView contentContainerStyle={styles.editProfileContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.profileSectionTitle}>البيانات الأساسية</Text><Text style={styles.profileSectionCaption}>حدّث البيانات المسموح بها للطالب.</Text>
            <AppInput label="اسم الطالب" value={editFullName} onChangeText={setEditFullName} containerStyle={styles.editField} />
            <AppInput label="رقم هاتف الطالب" value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" containerStyle={styles.editField} />
            <AppInput label="رقم هاتف ولي الأمر" value={editParentPhone} onChangeText={setEditParentPhone} keyboardType="phone-pad" containerStyle={styles.editField} />
            <AppInput label="المرحلة الدراسية" value={editGrade} onChangeText={setEditGrade} containerStyle={styles.editField} />
            <Text style={styles.inputLabel}>نوع الطالب</Text>
            <View style={styles.editTypeRow}><TouchableOpacity style={[styles.editTypeChoice, editStudentType === "registered" && styles.editTypeChoiceActive]} onPress={() => setEditStudentType("registered")}><Text style={[styles.editTypeText, editStudentType === "registered" && styles.editTypeTextActive]}>مسجل</Text></TouchableOpacity><TouchableOpacity style={[styles.editTypeChoice, editStudentType === "external" && styles.editTypeChoiceActive]} onPress={() => setEditStudentType("external")}><Text style={[styles.editTypeText, editStudentType === "external" && styles.editTypeTextActive]}>خارجي</Text></TouchableOpacity></View>
            <AppInput label="ملاحظات الطالب" value={editNotes} onChangeText={setEditNotes} multiline numberOfLines={4} containerStyle={styles.editField} style={{ minHeight: 100, textAlignVertical: "top" }} />
            <View style={styles.profileInfoNotice}><Ionicons name="information-circle-outline" size={18} color={Colors.slate500} /><Text style={styles.profileInfoNoticeText}>كود الطالب ثابت. يمكنك إدارة كود البطاقة من صفحة الملف. إدارة المجموعات والباقات متاحة من تبويباتها.</Text></View>
            <View style={styles.editProfileActions}><AppButton title="حفظ التعديلات" onPress={saveStudentEdit} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setIsStudentEditModalOpen(false)} style={{ flex: 1 }} /></View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={isCustomSmsModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}><View style={styles.smallModalCard}>
          <Text style={styles.modalTitle}>رسالة SMS لولي الأمر</Text>
          <Text style={styles.fieldNote}>سيتم إرسال الرسالة إلى رقم ولي الأمر المسجل: {selectedStudent?.parentPhone || "غير مسجل"}</Text>
          <AppInput label="نص الرسالة" value={customSmsMessage} onChangeText={setCustomSmsMessage} multiline numberOfLines={6} style={{ minHeight: 120, textAlignVertical: "top" }} maxLength={480} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}><AppButton title="إرسال SMS" onPress={sendCustomSms} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setIsCustomSmsModalOpen(false)} style={{ flex: 1 }} /></View>
        </View></View>
      </Modal>

      <Modal visible={isPackageModalOpen} animationType="slide" transparent onDismiss={() => { if (selectedStudent) { loadData(); openStudentDetails(selectedStudent); } }}>
        <View style={styles.modalOverlay}><View style={styles.packageModalCard}>
          <Text style={styles.modalTitle}>تحويل الطالب إلى باقة</Text>
          <Text style={styles.fieldNote}>يبدأ الاشتراك من اليوم، ولا يتم حذف التسجيلات أو الدورات السابقة.</Text>
          <AppInput label="بحث المدرس" placeholder="ابحث بالاسم" value={packageTeacherSearch} onChangeText={setPackageTeacherSearch} containerStyle={{ marginBottom: Spacing.sm }} />
          <ScrollView style={{ maxHeight: 360 }}>
            {availablePackages.map((pkg) => <TouchableOpacity key={pkg.id} onPress={() => handlePackageChange(pkg.id)} style={[styles.enrollChoice, packageId === pkg.id && styles.enrollChoiceActive]}><Text>{pkg.name} • {pkg.price} ج.م • حد {pkg.maxSelections}</Text></TouchableOpacity>)}
            {packageOptions.map((option) => { const selected = packageOptionIds.includes(option.id); const max = availablePackages.find((p) => p.id === packageId)?.maxSelections || 1; const subjectTeachers = smartSearch(teachers.filter((teacher) => teacher.id === option.defaultTeacherId), packageTeacherSearch, [{ get: (teacher) => teacher.name }]); const selectedTeacherId = packageTeacherIds[option.id] || option.defaultTeacherId; const selectedTeacher = teachers.find((teacher) => teacher.id === selectedTeacherId); const optionGroups = availableGroups.filter((group) => group.status === "active" && (group.grade === selectedStudent?.grade || group.grade === "كل الصفوف") && group.subjectId === option.subjectId && group.teacherId === selectedTeacherId); return <View key={option.id} style={[styles.packageSubjectSection, selected && styles.packageSubjectSectionActive]}><TouchableOpacity onPress={() => { if (!selected && packageOptionIds.length >= max) return Alert.alert("تنبيه", `يمكنك اختيار ${max} فقط.`); setPackageOptionIds((old) => selected ? old.filter((id) => id !== option.id) : [...old, option.id]); }} style={[styles.enrollChoice, selected && styles.enrollChoiceActive]}><Text>{selected ? "✓ " : "□ "}{option.subjectName}</Text></TouchableOpacity><Text style={styles.packageTeacherLabel}>مدرس الباقة: {selectedTeacher?.name || option.defaultTeacherName || "غير محدد"}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false}>{subjectTeachers.map((teacher) => <TouchableOpacity key={teacher.id} style={[styles.chip, packageTeacherIds[option.id] === teacher.id && styles.chipActive]} onPress={() => { setPackageTeacherIds((old) => ({ ...old, [option.id]: teacher.id })); setPackageGroupIds((old) => ({ ...old, [option.id]: "" })); }}><Text style={[styles.chipText, packageTeacherIds[option.id] === teacher.id && styles.chipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView>{selected ? <><Text style={styles.packageTeacherLabel}>اختر مجموعة المدرس للصف {selectedStudent?.grade || "الطالب"}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.packageGroupList}>{optionGroups.map((group) => <TouchableOpacity key={group.id} style={[styles.packageGroupChoice, packageGroupIds[option.id] === group.id && styles.packageGroupChoiceActive]} onPress={() => setPackageGroupIds((old) => ({ ...old, [option.id]: group.id }))}><View style={styles.packageGroupChoiceHeader}><Text style={[styles.packageGroupName, packageGroupIds[option.id] === group.id && styles.packageGroupTextActive]}>{group.name}</Text><Ionicons name={packageGroupIds[option.id] === group.id ? "checkmark-circle" : "ellipse-outline"} size={20} color={packageGroupIds[option.id] === group.id ? Colors.primary : Colors.slate400} /></View><Text style={styles.packageGroupMeta}>{group.subjectName || option.subjectName} · {group.teacherName || selectedTeacher?.name || "المدرس"}</Text><Text style={styles.packageGroupSchedule}>{groupScheduleLabel(group.id)}</Text></TouchableOpacity>)}</ScrollView>{!optionGroups.length ? <Text style={styles.emptyText}>لا توجد مجموعات لهذا المدرس في صف الطالب.</Text> : null}<Text style={styles.packageSelectionSummary}>المادة: {option.subjectName} · المجموعة: {availableGroups.find((group) => group.id === packageGroupIds[option.id])?.name || "غير محددة"} ← المدرس: {selectedTeacher?.name || option.defaultTeacherName || "غير محدد"}</Text></> : null}</View>; })}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}><AppButton title="تأكيد التحويل" onPress={handleSubscribePackage} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setIsPackageModalOpen(false)} style={{ flex: 1 }} /></View>
        </View></View>
      </Modal>

      <Modal visible={groupDetailsModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.groupDetailsModalCard}>
            <View style={styles.groupDetailsHeader}>
              <TouchableOpacity onPress={() => setGroupDetailsModalOpen(false)} style={styles.groupDetailsBackButton}>
                <Ionicons name="arrow-forward" size={22} color={Colors.slate700} />
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: "flex-end" }}>
                <Text style={styles.modalTitle}>{availableGroups.find((group) => group.id === selectedGroupPanel?.groupId)?.name || "تفاصيل المجموعة"}</Text>
                <Text style={styles.modalSubtitle}>{selectedStudent?.fullName}</Text>
              </View>
            </View>

            {selectedGroupPanel?.panel === "attendance" && (
              <ScrollView style={styles.groupDetailsScroll}>
                <Text style={styles.groupDetailsTitle}>تفاصيل الحضور والغياب</Text>
                {(() => {
                  const summary = attendanceSummaries.find((item) => item.groupId === selectedGroupPanel.groupId);
                  return (
                    <>
                      <View style={styles.detailMetricGrid}>
                        <View style={styles.detailMetricCard}><Text style={styles.detailMetricValue}>{summary?.expectedSessions ?? 0}</Text><Text style={styles.detailMetricLabel}>حصص متوقعة</Text></View>
                        <View style={styles.detailMetricCard}><Text style={[styles.detailMetricValue, { color: Colors.successText }]}>{summary?.presentCount ?? 0}</Text><Text style={styles.detailMetricLabel}>حضور</Text></View>
                        <View style={styles.detailMetricCard}><Text style={[styles.detailMetricValue, { color: Colors.dangerText }]}>{summary?.absentCount ?? 0}</Text><Text style={styles.detailMetricLabel}>غياب</Text></View>
                        <View style={styles.detailMetricCard}><Text style={[styles.detailMetricValue, { color: Colors.warningText }]}>{summary?.makeupCount ?? 0}</Text><Text style={styles.detailMetricLabel}>تعويض</Text></View>
                      </View>
                      <Text style={styles.groupDetailsSubtitle}>السجل المسجل</Text>
                      {groupAttendanceRows.length === 0 ? <Text style={styles.emptyText}>لا توجد سجلات حضور لهذه المجموعة.</Text> : groupAttendanceRows.map((row) => (
                        <View key={row.id} style={styles.detailHistoryRow}>
                          <View style={{ flex: 1 }}><Text style={styles.detailHistoryTitle}>{row.checkInTime?.slice(0, 16).replace("T", " ") || "بدون تاريخ"}</Text><Text style={styles.detailHistoryMeta}>{row.attendanceType === "makeup" ? "حصة تعويضية" : "الحصة الأساسية"}</Text></View>
                          <StatusBadge text={row.status === "late" ? "متأخر" : "حاضر"} type={row.status === "late" ? "warning" : "success"} />
                        </View>
                      ))}
                    </>
                  );
                })()}
              </ScrollView>
            )}

            {selectedGroupPanel?.panel === "finance" && groupFinancialStatus && (
              <ScrollView style={styles.groupDetailsScroll}>
                <Text style={styles.groupDetailsTitle}>الموقف المالي للمجموعة</Text>
                <View style={styles.detailMetricGrid}>
                  <View style={styles.detailMetricCard}><Text style={styles.detailMetricValue}>{formatCurrency(groupFinancialStatus.monthlyTotalDue)}</Text><Text style={styles.detailMetricLabel}>المستحق</Text></View>
                  <View style={styles.detailMetricCard}><Text style={[styles.detailMetricValue, { color: Colors.successText }]}>{formatCurrency(groupFinancialStatus.monthlyTotalPaid)}</Text><Text style={styles.detailMetricLabel}>المدفوع</Text></View>
                  <View style={styles.detailMetricCard}><Text style={[styles.detailMetricValue, { color: Colors.dangerText }]}>{formatCurrency(groupFinancialStatus.monthlyRemainingDebt)}</Text><Text style={styles.detailMetricLabel}>المتبقي</Text></View>
                </View>
                {(groupFinancialStatus.creditBalance ?? 0) > 0 ? <Text style={styles.detailDebtLine}>رصيد مقدم: {formatCurrency(groupFinancialStatus.creditBalance ?? 0)}</Text> : null}
                {groupFinancialStatus.sessionDebt && <View style={styles.detailSectionCard}><Text style={styles.groupDetailsSubtitle}>تفصيل حصص الشهر</Text><Text style={styles.detailHistoryMeta}>{groupFinancialStatus.sessionDebt.periodStart} - {groupFinancialStatus.sessionDebt.periodEnd}</Text><Text style={styles.detailLine}>حضر ودفع: {groupFinancialStatus.sessionDebt.attendedPaidSessions}</Text><Text style={styles.detailLine}>حضر ولم يدفع: {groupFinancialStatus.sessionDebt.attendedUnpaidSessions}</Text><Text style={styles.detailLine}>الحصص المستقبلية غير المدفوعة: {groupFinancialStatus.sessionDebt.futureUnpaidSessions}</Text><Text style={styles.detailDebtLine}>المديونية الحالية: {formatCurrency(groupFinancialStatus.sessionDebt.currentDebt)}</Text></View>}
                <Text style={styles.groupDetailsSubtitle}>دورات المديونية</Text>
                {groupFinancialStatus.cycles.length === 0 ? <Text style={styles.emptyText}>لا توجد دورات مديونية.</Text> : groupFinancialStatus.cycles.map((cycle) => <View key={cycle.id} style={styles.detailSectionCard}><View style={styles.detailHistoryRow}><View><Text style={styles.detailHistoryTitle}>الدورة {cycle.cycleNumber}</Text><Text style={styles.detailHistoryMeta}>{cycle.startDate} - {cycle.endDate}</Text></View><StatusBadge text={cycle.status === "paid" ? "مدفوعة" : cycle.status === "partial" ? "جزئية" : "مفتوحة"} type={cycle.status === "paid" ? "success" : cycle.status === "partial" ? "warning" : "neutral"} /></View><Text style={styles.detailLine}>الرسوم: {formatCurrency(cycle.effectivePrice ?? cycle.cyclePrice)} | المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></View>)}
                <Text style={styles.groupDetailsSubtitle}>المدفوعات</Text>
                {groupFinancialStatus.payments.length === 0 ? <Text style={styles.emptyText}>لا توجد مدفوعات مسجلة.</Text> : groupFinancialStatus.payments.map((payment) => <View key={payment.id} style={styles.detailHistoryRow}><View><Text style={styles.detailHistoryTitle}>{formatCurrency(payment.amount)}</Text><Text style={styles.detailHistoryMeta}>{payment.paymentDate || payment.createdAt.slice(0, 10)}{payment.isReversed ? " • ملغاة" : ""}</Text>{payment.notes ? <Text style={styles.detailHistoryMeta}>ملاحظة: {payment.notes}</Text> : null}</View><Text style={styles.detailHistoryMeta}>{payment.paymentType}</Text></View>)}
              </ScrollView>
            )}

            {selectedGroupPanel?.panel === "grades" && (
              <ScrollView style={styles.groupDetailsScroll}>
                <Text style={styles.groupDetailsTitle}>درجات الطالب في المجموعة</Text>
                {groupGradeExams.length === 0 ? <Text style={styles.emptyText}>لا توجد امتحانات أو درجات مسجلة لهذه المجموعة.</Text> : groupGradeExams.map((exam) => {
                  const score = groupGradeScores.find((item) => item.examId === exam.id && item.studentId === selectedStudent?.id);
                  return <View key={exam.id} style={styles.detailSectionCard}><Text style={styles.detailHistoryTitle}>{exam.name}</Text><Text style={styles.detailHistoryMeta}>الدرجة النهائية: {exam.maxScore}</Text><Text style={[styles.gradeScoreValue, { color: score?.score === null || !score ? Colors.slate500 : Colors.primary }]}>{score?.score === null || !score ? "لم ترصد بعد" : `${score.score} / ${exam.maxScore}`}</Text></View>;
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* 3. Issue/Replace Card Modal */}
      <Modal visible={isCardModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>استبدال كارت الطالب</Text>
            <Text style={styles.fieldNote}>
              سيتم تحديث كود الكارت الحالي للطالب مع الحفاظ على كل بياناته.
            </Text>
            <AppInput
              label="كود الكارت الجديد *"
              placeholder="مثال: 00130"
              value={cardInput}
              onChangeText={setCardInput}
              containerStyle={{ marginVertical: Spacing.md }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="تأكيد الربط"
                onPress={handleReplaceCard}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsCardModalOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 4. Group Enrollment Modal */}
      <Modal visible={isEnrollModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>تسجيل الطالب في مجموعة</Text>

            <Text style={styles.inputLabel}>اختر المجموعة:</Text>
            <AppInput
              placeholder="ابحث باسم المجموعة أو المدرس أو المادة"
              value={enrollGroupSearch}
              onChangeText={setEnrollGroupSearch}
              containerStyle={{ marginBottom: Spacing.xs }}
            />
            <Text style={styles.groupPickHeader}>
              مجموعات {selectedStudent?.grade ? `مرحلة ${selectedStudent.grade}` : "المرحلة الحالية"} ({eligibleEnrollmentGroups.length})
            </Text>
            <ScrollView style={{ maxHeight: 220, marginVertical: Spacing.sm }}>
              {eligibleEnrollmentGroups.map((g) => (
                <TouchableOpacity
                  key={g.id}
                  style={[
                    styles.groupPickItem,
                    enrollGroupId === g.id && styles.groupPickItemActive,
                  ]}
                  onPress={() => { setEnrollGroupId(g.id); setEnrollStartDate(firstScheduledDate(g.id)); }}
                >
                  <Text style={styles.groupPickSchedule}>{groupScheduleLabel(g.id)}</Text>
                  <Text style={[styles.groupPickText, enrollGroupId === g.id && styles.groupPickTextActive]}>{g.name}</Text>
                  <Text style={styles.groupPickMeta}>{[g.subjectName, g.teacherName, g.grade].filter(Boolean).join(" • ")}</Text>
                </TouchableOpacity>
              ))}
              {eligibleEnrollmentGroups.length === 0 && <Text style={styles.groupPickEmpty}>لا توجد مجموعات نشطة لهذه المرحلة.</Text>}
            </ScrollView>

            <AppInput
              label="تاريخ بدء الاشتراك (YYYY-MM-DD)"
              value={enrollStartDate}
              onChangeText={setEnrollStartDate}
              containerStyle={{ marginBottom: Spacing.sm }}
            />

            <AppInput
              label="سعر شهري خاص (اختياري - ج.م)"
              placeholder="اتركه فارغاً للسعر الافتراضي"
              value={enrollSpecialPrice}
              onChangeText={setEnrollSpecialPrice}
              keyboardType="numeric"
              containerStyle={{ marginBottom: Spacing.md }}
            />

            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="تأكيد التسجيل"
                onPress={handleEnrollStudent}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsEnrollModalOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 4. Record Payment Modal */}
      <Modal visible={isPaymentModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>تسجيل دفعة نقدية</Text>
            <AppInput
              label="المبلغ المدفوع (ج.م) *"
              placeholder="مثال: 400"
              value={paymentAmount}
              onChangeText={setPaymentAmount}
              keyboardType="numeric"
              containerStyle={{ marginVertical: Spacing.sm }}
            />

            <Text style={styles.inputLabel}>نوع الدفعة:</Text>
            <View
              style={{ flexDirection: "row", gap: 8, marginBottom: Spacing.md }}
            >
              {(["monthly", "partial", "session"] as const).map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.typePickBtn,
                    paymentType === type && styles.typePickBtnActive,
                  ]}
                  onPress={() => setPaymentType(type)}
                >
                  <Text
                    style={[
                      styles.typePickText,
                      paymentType === type && styles.typePickTextActive,
                    ]}
                  >
                    {type === "monthly"
                      ? "استكمال الشهر / الباقة"
                      : type === "partial"
                        ? "مبلغ مخصص"
                        : "دفع حصة"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {(financialStatus?.cycles?.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).length || 0) > 1 ? <View style={styles.paymentCyclePicker}><Text style={styles.paymentCycleTitle}>اختر دورة الشهر أو الباقة</Text>{financialStatus?.cycles.filter((cycle) => (cycle.remainingDebt ?? 0) > 0).map((cycle) => <TouchableOpacity key={cycle.id} style={[styles.paymentCycleOption, paymentCycleId === cycle.id && styles.paymentCycleOptionActive]} onPress={() => { setPaymentCycleId(cycle.id); if (paymentType !== "session") setPaymentAmount(String(cycle.remainingDebt ?? cycle.effectivePrice ?? cycle.cyclePrice ?? 0)); }}><Text style={styles.paymentCycleName}>{cycle.groupName || cycle.packageName || "دورة مديونية"}</Text><Text style={styles.paymentCycleAmount}>المتبقي: {formatCurrency(cycle.remainingDebt ?? 0)}</Text></TouchableOpacity>)}</View> : null}

            <AppInput
              label="ملاحظات (اختياري)"
              placeholder="ملاحظات الدفع..."
              value={paymentNotes}
              onChangeText={setPaymentNotes}
              containerStyle={{ marginBottom: Spacing.md }}
            />

            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="تأكيد الدفع"
                onPress={handleRecordPayment}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsPaymentModalOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 5. Debt Adjustment Modal */}
      <Modal visible={isAdjModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>{Strings.addAdjustmentButton}</Text>
            {targetCycleForAdj && (
              <Text style={styles.fieldNote}>
                الدورة رقم {targetCycleForAdj.cycleNumber} — الرسم الحالي:{" "}
                {targetCycleForAdj.effectivePrice ??
                  targetCycleForAdj.cyclePrice}{" "}
                ج.م
              </Text>
            )}
            <AppInput
              label="قيمة التعديل (مثال: -50 للخصم أو +50 للزيادة) *"
              placeholder="-50"
              value={adjAmount}
              onChangeText={setAdjAmount}
              keyboardType="numeric"
              containerStyle={{ marginVertical: Spacing.sm }}
            />
            <AppInput
              label="سبب التعديل *"
              placeholder="مثال: خصم تفوق أو رسوم إضافية..."
              value={adjReason}
              onChangeText={setAdjReason}
              containerStyle={{ marginBottom: Spacing.md }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="حفظ التعديل"
                onPress={handleCreateAdjustment}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsAdjModalOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 6. Payment Reversal Modal */}
      <Modal visible={isRevModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>
              {Strings.confirmReversalButton}
            </Text>
            {targetPaymentForRev && (
              <Text style={styles.fieldNote}>
                إلغاء دفعة بمبلغ {targetPaymentForRev.amount} ج.م بتاريخ{" "}
                {targetPaymentForRev.paymentDate ||
                  targetPaymentForRev.createdAt.slice(0, 10)}
              </Text>
            )}
            <AppInput
              label="سبب إلغاء الدفعة *"
              placeholder="مثال: تسجيل خاطئ أو استرجاع..."
              value={revReason}
              onChangeText={setRevReason}
              containerStyle={{ marginVertical: Spacing.md }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="تأكيد الإلغاء"
                variant="outline"
                onPress={handleReversePayment}
                style={{ flex: 1, borderColor: Colors.danger }}
              />
              <AppButton
                title="تراجع"
                onPress={() => setIsRevModalOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (screenWidth = 390, screenHeight = 844, gutter = Spacing.lg, isTablet = false, isLandscape = false) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: gutter,
    paddingVertical: Spacing.lg,
    backgroundColor: Colors.cardBackground,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    shadowColor: Colors.slate900,
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  headerTitle: {
    ...Typography.h2,
    color: Colors.slate900,
    fontWeight: "900",
  },
  headerAddButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 6,
    minHeight: 44,
  },
  headerAddButtonText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "600",
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  headerIconButton: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  filterPanel: { flexDirection: "row-reverse", flexWrap: "wrap", alignItems: "center", gap: 7, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.slate50, marginBottom: Spacing.md },
  filterTitle: { width: "100%", textAlign: "right", color: Colors.slate700, fontWeight: "900", fontSize: 12 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white },
  filterChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  filterChipText: { color: Colors.slate600, fontSize: 12, fontWeight: "700" },
  filterChipTextActive: { color: Colors.primaryDark },
  bulkToolbar: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", padding: 10, borderRadius: 14, backgroundColor: Colors.primaryLight, marginBottom: Spacing.md },
  bulkCount: { color: Colors.primaryDark, fontWeight: "900", fontSize: 13 },
  bulkButton: { flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 },
  bulkButtonText: { color: Colors.white, fontWeight: "800", fontSize: 12 },
  bulkModeRow: { flexDirection: "row-reverse", gap: 8, marginTop: 10 },
  bulkModeChip: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.white },
  bulkModeChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  bulkModeText: { color: Colors.slate600, fontWeight: "800", fontSize: 13 },
  bulkModeTextActive: { color: Colors.primaryDark },
  bulkStepTitle: { color: Colors.slate700, textAlign: "right", fontSize: 12, fontWeight: "900", marginTop: 8, marginBottom: 5 },
  chipRow: { flexDirection: "row-reverse", gap: 6, paddingVertical: 2 },
  bulkPackageCard: { backgroundColor: Colors.slate50, borderRadius: 11, padding: 7, marginBottom: 7, borderWidth: 1, borderColor: Colors.slate200 },
  cardSearchButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.primaryLight, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: Spacing.md },
  cardSearchButtonText: { color: Colors.primaryDark, fontSize: 13, fontWeight: "800" },
  cardScannerOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.72)", justifyContent: "center", padding: 20 },
  cardScannerSheet: { backgroundColor: Colors.cardBackground, borderRadius: 20, padding: 14, overflow: "hidden" },
  cardScannerTitle: { color: Colors.slate900, fontSize: 18, fontWeight: "900", textAlign: "right", marginBottom: 10 },
  cardScannerCamera: { height: 330, borderRadius: 14, overflow: "hidden", backgroundColor: Colors.slate900 },
  cardScannerClose: { minHeight: 46, borderRadius: 12, backgroundColor: Colors.slate100, alignItems: "center", justifyContent: "center", marginTop: 12 },
  cardScannerCloseText: { color: Colors.slate800, fontSize: 14, fontWeight: "800" },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xxxl,
  },
  studentCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: Spacing.lg,
    marginBottom: Spacing.sm,
    borderRadius: 18,
  },
  studentCardSelected: { borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.primaryLight + "30" },
  selectionIcon: { marginRight: Spacing.sm },
  studentInfo: {
    flex: 1,
  },
  studentName: {
    ...Typography.bodyBold,
    fontWeight: "700",
    color: Colors.slate900,
  },
  badgeRow: {
    flexDirection: "row",
    gap: 8,
    marginVertical: 7,
  },
  codeBadge: {
    fontSize: 11,
    fontWeight: "600",
    backgroundColor: Colors.slate100,
    color: Colors.slate700,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
  },
  cardBadge: {
    fontSize: 11,
    fontWeight: "600",
    backgroundColor: Colors.primaryLight + "30",
    color: Colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
  },
  noCardBadge: {
    fontSize: 11,
    backgroundColor: Colors.slate100,
    color: Colors.slate400,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
  },
  studentMeta: {
    ...Typography.caption,
    color: Colors.slate500,
    marginTop: 2,
  },
  cardActions: {
    alignItems: "flex-end",
    marginLeft: Spacing.sm,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.lg,
  },
  modalCard: {
    width: Math.min(isTablet ? 680 : 520, screenWidth - gutter * 2),
    maxWidth: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  detailsModalCard: {
    width: Math.min(isTablet ? 720 : 560, screenWidth - gutter * 2),
    maxWidth: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
    maxHeight: "85%",
  },
  smallModalCard: {
    width: Math.min(isTablet ? 620 : 500, screenWidth - gutter * 2),
    maxWidth: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  packageModalCard: {
    width: Math.min(isTablet ? 760 : 600, screenWidth - gutter * 2),
    maxWidth: "100%",
    maxHeight: "88%",
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: Spacing.md,
  },
  enrollChoice: { padding: 10, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, marginBottom: 6, backgroundColor: Colors.white },
  packageSubjectSection: { backgroundColor: Colors.slate50, borderRadius: 10, padding: 8, marginBottom: 7, borderWidth: 1, borderColor: Colors.slate200 }, packageSubjectSectionActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted }, packageGroupList: { gap: 8, paddingVertical: 3 }, packageGroupChoice: { width: Math.max(160, Math.min(isTablet ? 250 : 220, (screenWidth - gutter * 2 - 32) * 0.72)), minHeight: 92, borderRadius: 13, padding: 10, backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.slate200 }, packageGroupChoiceActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight }, packageGroupChoiceHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 5 }, packageGroupName: { flex: 1, color: Colors.slate900, fontSize: 13, fontWeight: "900", textAlign: "right" }, packageGroupTextActive: { color: Colors.primaryDark }, packageGroupMeta: { color: Colors.slate600, fontSize: 10, textAlign: "right", marginTop: 7 }, packageGroupSchedule: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right", marginTop: 5 },
  packageTeacherLabel: { fontSize: 12, fontWeight: "700", color: Colors.slate700, marginBottom: 6, textAlign: "right" },
  packageSelectionSummary: { fontSize: 12, color: Colors.primaryDark, fontWeight: "700", marginTop: 8, textAlign: "right" },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: Colors.slate100, marginRight: 5 },
  chipActive: { backgroundColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.slate700 },
  chipTextActive: { color: Colors.white, fontWeight: "700" },
  enrollChoiceActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight + "20" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  profileIdentity: { flexDirection: "row", alignItems: "center", flex: 1, gap: 10 },
  profileCopy: { flex: 1, alignItems: "flex-end" },
  avatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: Colors.primaryLight, borderWidth: 2, borderColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: Colors.primaryDark, fontSize: 26, fontWeight: "800" },
  profileStatus: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.success },
  profileStatusText: { color: Colors.slate500, fontSize: 11 },
  profileActions: { flexDirection: "row", gap: 8, marginBottom: Spacing.md },
  profileAction: { flex: 1, alignItems: "center", gap: 4, backgroundColor: Colors.primaryLight + "35", borderRadius: 10, paddingVertical: 9 },
  profileActionText: { color: Colors.primaryDark, fontSize: 11, fontWeight: "700" },
  modalTitle: {
    ...Typography.h2,
    fontWeight: "700",
    color: Colors.slate900,
  },
  modalSubtitle: {
    ...Typography.caption,
    color: Colors.slate500,
  },
  modalFooter: {
    marginTop: Spacing.md,
  },
  fieldNote: {
    fontSize: 12,
    color: Colors.warning,
    marginBottom: Spacing.sm,
  },
  formField: {
    marginBottom: Spacing.sm,
  },
  sectionBox: {
    backgroundColor: Colors.slate50,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: Colors.slate800,
  },
  attendanceSummaryCard: {
    backgroundColor: Colors.white,
    borderRadius: 10,
    padding: Spacing.sm,
    marginTop: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  attendanceSummaryTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.slate900,
  },
  attendanceSummaryMeta: {
    fontSize: 11,
    color: Colors.slate500,
    marginTop: 2,
  },
  attendanceMetricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing.sm,
  },
  attendanceMetric: {
    alignItems: "center",
    minWidth: 58,
  },
  attendanceMetricValue: {
    fontSize: 16,
    fontWeight: "800",
    color: Colors.slate800,
  },
  attendanceMetricLabel: {
    fontSize: 10,
    color: Colors.slate500,
    marginTop: 2,
  },
  makeupSummaryText: {
    fontSize: 11,
    color: Colors.warningText,
    fontWeight: "700",
    marginTop: Spacing.sm,
  },
  smallActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  smallActionBtnText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: "600",
  },
  infoLine: {
    fontSize: 13,
    color: Colors.slate600,
    marginBottom: 4,
  },
  emptyText: {
    fontSize: 12,
    color: Colors.slate400,
    fontStyle: "italic",
  },
  cardItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: Colors.white,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  cardItemCode: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.slate900,
  },
  cardItemMeta: {
    fontSize: 11,
    color: Colors.slate500,
  },
  deactBtn: {
    padding: 4,
  },
  enrollItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: Colors.white,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  enrollGroupName: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.slate900,
  },
  enrollMeta: {
    fontSize: 11,
    color: Colors.slate500,
  },
  endEnrollBtn: {
    backgroundColor: Colors.dangerLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  endEnrollBtnText: {
    color: Colors.danger,
    fontSize: 11,
    fontWeight: "600",
  },
  groupCard: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: Spacing.sm,
    marginTop: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  groupCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  groupCardName: {
    fontSize: 14,
    fontWeight: "800",
    color: Colors.slate900,
    textAlign: "right",
  },
  groupCardMeta: {
    fontSize: 11,
    color: Colors.slate500,
    marginTop: 3,
    textAlign: "right",
  },
  groupActionRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: Spacing.sm,
  },
  groupActionButton: {
    flex: 1,
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: 9,
    backgroundColor: Colors.primaryLight + "22",
    borderWidth: 1,
    borderColor: Colors.primaryLight,
  },
  groupActionButtonActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  groupActionText: {
    color: Colors.primaryDark,
    fontSize: 11,
    fontWeight: "800",
  },
  groupActionTextActive: {
    color: Colors.white,
  },
  groupInlinePanel: {
    display: "none",
    marginTop: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: 9,
    backgroundColor: Colors.slate50,
  },
  groupInlinePanelTitle: {
    color: Colors.slate700,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "right",
    marginBottom: 6,
  },
  groupInlineMetricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 5,
  },
  groupInlineMetric: {
    color: Colors.slate700,
    fontSize: 11,
    fontWeight: "700",
  },
  groupDetailsModalCard: {
    width: "100%",
    maxHeight: "88%",
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: Spacing.md,
  },
  groupDetailsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  groupDetailsBackButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.slate100,
    alignItems: "center",
    justifyContent: "center",
  },
  groupDetailsScroll: {
    maxHeight: 560,
  },
  groupDetailsTitle: {
    color: Colors.slate900,
    fontSize: 16,
    fontWeight: "800",
    textAlign: "right",
    marginBottom: Spacing.sm,
  },
  groupDetailsSubtitle: {
    color: Colors.slate700,
    fontSize: 13,
    fontWeight: "800",
    textAlign: "right",
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
  },
  detailMetricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  detailMetricCard: {
    flex: 1,
    minWidth: "29%",
    backgroundColor: Colors.slate50,
    borderRadius: 10,
    padding: Spacing.sm,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailMetricValue: {
    color: Colors.primary,
    fontSize: 17,
    fontWeight: "800",
  },
  detailMetricLabel: {
    color: Colors.slate500,
    fontSize: 10,
    marginTop: 3,
  },
  detailHistoryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.slate50,
    borderRadius: 9,
    padding: Spacing.sm,
    marginTop: 6,
  },
  detailHistoryTitle: {
    color: Colors.slate800,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "right",
  },
  detailHistoryMeta: {
    color: Colors.slate500,
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  detailSectionCard: {
    backgroundColor: Colors.slate50,
    borderRadius: 10,
    padding: Spacing.sm,
    marginTop: 6,
  },
  detailLine: {
    color: Colors.slate600,
    fontSize: 11,
    marginTop: 4,
    textAlign: "right",
  },
  detailDebtLine: {
    color: Colors.dangerText,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 6,
    textAlign: "right",
  },
  gradeScoreValue: {
    fontSize: 20,
    fontWeight: "800",
    marginTop: 8,
    textAlign: "right",
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.slate700,
    marginBottom: 4,
  },
  groupPickItem: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: Colors.slate50,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  groupPickItemActive: {
    backgroundColor: Colors.primaryLight + "20",
    borderColor: Colors.primary,
  },
  groupPickText: {
    fontSize: 13,
    color: Colors.slate800,
  },
  groupPickTextActive: {
    fontWeight: "700",
    color: Colors.primary,
  },
  groupPickHeader: {
    color: Colors.slate600,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "right",
  },
  groupPickMeta: {
    color: Colors.slate500,
    fontSize: 10,
    marginTop: 3,
    textAlign: "right",
  },
  groupPickSchedule: {
    color: Colors.primary,
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 2,
    textAlign: "right",
  },
  groupPickEmpty: {
    color: Colors.slate500,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: Spacing.md,
  },
  finSummaryRow: {
    flexDirection: "row",
    gap: 8,
    marginVertical: Spacing.sm,
  },
  finSummaryCard: {
    flex: 1,
    backgroundColor: Colors.white,
    padding: 8,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  finSummaryLabel: {
    fontSize: 10,
    color: Colors.slate500,
    marginBottom: 2,
  },
  finSummaryValue: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.slate900,
  },
  sessionPaymentsBanner: {
    backgroundColor: Colors.primaryLight + "15",
    padding: 8,
    borderRadius: 8,
    marginVertical: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.primaryLight + "40",
  },
  sessionPaymentsBannerTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.primaryDark,
  },
  sessionPaymentsBannerNote: {
    fontSize: 10,
    color: Colors.slate600,
    marginTop: 2,
  },
  sessionDebtCard: {
    backgroundColor: Colors.white,
    padding: Spacing.sm,
    borderRadius: 10,
    marginVertical: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sessionDebtTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.slate900,
  },
  sessionDebtPeriod: {
    fontSize: 10,
    color: Colors.slate500,
    marginTop: 2,
  },
  sessionDebtGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  sessionDebtItem: {
    width: "48%",
    fontSize: 11,
    color: Colors.slate700,
  },
  sessionDebtAmount: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.danger,
    marginTop: 8,
  },
  sectionSubtitle: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.slate700,
    marginBottom: 4,
  },
  cycleCard: {
    backgroundColor: Colors.white,
    padding: 8,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cycleHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cycleTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.slate800,
  },
  cyclePeriod: {
    fontSize: 10,
    color: Colors.slate500,
  },
  cyclePriceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: Colors.slate100,
  },
  cyclePriceText: {
    fontSize: 10,
    color: Colors.slate600,
  },
  adjBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.slate100,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  adjBtnText: {
    fontSize: 10,
    color: Colors.primary,
    fontWeight: "600",
  },
  paymentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: Colors.white,
    padding: 8,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  paymentRowReversed: {
    opacity: 0.6,
    backgroundColor: Colors.slate50,
  },
  paymentAmount: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.slate900,
  },
  strikeText: {
    textDecorationLine: "line-through",
    color: Colors.slate400,
  },
  paymentTypeTag: {
    fontSize: 10,
    color: Colors.slate500,
    backgroundColor: Colors.slate100,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  paymentMeta: {
    fontSize: 10,
    color: Colors.slate500,
    marginTop: 2,
  },
  reverseBtn: {
    backgroundColor: Colors.dangerLight,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  reverseBtnText: {
    fontSize: 10,
    color: Colors.danger,
    fontWeight: "600",
  },
  typePickBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    backgroundColor: Colors.slate50,
  },
  typePickBtnActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight + "20",
  },
  typePickText: {
    fontSize: 11,
    color: Colors.slate700,
  },
  typePickTextActive: {
    fontWeight: "700",
    color: Colors.primary,
  },
  paymentCyclePicker: { marginBottom: Spacing.md, gap: Spacing.sm },
  paymentCycleTitle: { color: Colors.slate800, fontWeight: "800", textAlign: "right" },
  paymentCycleOption: { borderWidth: 1, borderColor: Colors.slate200, borderRadius: 10, padding: 10, backgroundColor: Colors.white },
  paymentCycleOptionActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight + "30" },
  paymentCycleName: { color: Colors.slate800, fontWeight: "800", textAlign: "right" },
  paymentCycleAmount: { color: Colors.slate500, fontSize: 12, marginTop: 3, textAlign: "right" },
  profileScreen: { flex: 1, backgroundColor: Colors.background },
  profileTopBar: { minHeight: 54, paddingHorizontal: Spacing.md, flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.cardBackground },
  profileTopButton: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight + "30" },
  profileTopTitle: { flex: 1, marginHorizontal: 12, color: Colors.slate900, fontSize: 17, fontWeight: "800", textAlign: "right" },
  profileMainScroll: { flex: 1 },
  profileContent: { paddingHorizontal: Spacing.md, paddingBottom: 36 },
  profileHero: { alignItems: "center", paddingTop: 18, paddingBottom: 16 },
  profileAvatarLarge: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight + "70", marginBottom: 9 },
  profileAvatarLargeText: { color: Colors.primary, fontSize: 42, fontWeight: "800" },
  profileStudentName: { color: Colors.slate900, fontSize: 22, fontWeight: "900", textAlign: "center" },
  profileGrade: { color: Colors.slate600, fontSize: 14, fontWeight: "700", marginTop: 2 },
  profileGroupSummary: { maxWidth: "100%", color: Colors.slate500, fontSize: 12, marginTop: 5, textAlign: "center" },
  profileStatusPill: { flexDirection: "row-reverse", alignItems: "center", gap: 6, marginTop: 9, paddingHorizontal: 13, paddingVertical: 6, borderRadius: 20, backgroundColor: Colors.primaryLight + "55" },
  profileStatusPillInactive: { backgroundColor: Colors.slate200 },
  profileStatusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.success },
  profileStatusDotInactive: { backgroundColor: Colors.slate500 },
  profileStatusPillText: { color: Colors.primaryDark, fontSize: 12, fontWeight: "800" },
  profileContactList: { gap: 8, marginBottom: 10 },
  profileContactRow: { minHeight: 70, flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: Colors.border, borderRadius: 15, backgroundColor: Colors.cardBackground, ...Platform.select({ ios: { shadowColor: Colors.slate900, shadowOpacity: 0.04, shadowRadius: 9, shadowOffset: { width: 0, height: 3 } }, android: { elevation: 1 } }) },
  profileContactText: { flex: 1, alignItems: "flex-end" },
  profileContactLabel: { color: Colors.slate500, fontSize: 11 },
  profileContactValue: { color: Colors.slate900, fontSize: 16, fontWeight: "700", marginTop: 2 },
  profileContactIcon: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight + "55" },
  profilePrimaryActions: { flexDirection: "row-reverse", gap: 8, marginTop: 1, marginBottom: 10 },
  profileCardList: { marginBottom: 8, paddingHorizontal: 11, borderRadius: 13, backgroundColor: Colors.cardBackground },
  profileCardRow: { minHeight: 48, flexDirection: "row-reverse", alignItems: "center", gap: 8, borderBottomWidth: 1, borderBottomColor: Colors.slate100 },
  profileCodeButton: { minHeight: 48, flex: 1, flexDirection: "row-reverse", justifyContent: "center", alignItems: "center", gap: 8, borderRadius: 12, backgroundColor: Colors.primary },
  profileCodeButtonText: { color: Colors.white, fontSize: 14, fontWeight: "800" },
  profileManageCardButton: { minHeight: 48, flex: 1, flexDirection: "row-reverse", justifyContent: "center", alignItems: "center", gap: 7, borderRadius: 12, backgroundColor: Colors.primaryLight + "55" },
  profileManageCardText: { color: Colors.primary, fontSize: 13, fontWeight: "800" },
  profileDeactivateButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 7, marginBottom: 8 },
  profileDeactivateText: { color: Colors.danger, fontSize: 12, fontWeight: "700" },
  profileTabsScroller: { marginHorizontal: -Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.cardBackground },
  profileTabs: { flexDirection: "row-reverse", paddingHorizontal: Spacing.sm, gap: 3 },
  profileTab: { minHeight: 47, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 12, borderBottomWidth: 2, borderBottomColor: "transparent" },
  profileTabActive: { borderBottomColor: Colors.primary },
  profileTabText: { color: Colors.slate500, fontSize: 11, fontWeight: "700" },
  profileTabTextActive: { color: Colors.primary, fontWeight: "900" },
  profileSection: { paddingTop: 16, paddingBottom: 10 },
  profileSectionHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 10 },
  profileSectionTitle: { color: Colors.slate900, fontSize: 16, fontWeight: "900", textAlign: "right" },
  profileSectionCaption: { color: Colors.slate500, fontSize: 11, marginTop: 2, textAlign: "right" },
  profileInlineAction: { minHeight: 35, flexDirection: "row-reverse", alignItems: "center", gap: 3, paddingHorizontal: 10, borderRadius: 10, backgroundColor: Colors.primaryLight + "45" },
  profileInlineActionText: { color: Colors.primary, fontSize: 11, fontWeight: "800" },
  profileTransferAction: { flexDirection: "row-reverse", alignItems: "center", alignSelf: "flex-start", gap: 5, marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: Colors.primaryLight + "45" },
  profileEmpty: { alignItems: "center", justifyContent: "center", paddingVertical: 30, paddingHorizontal: 16, marginTop: 12, borderRadius: 15, backgroundColor: Colors.slate50 },
  profileEmptyTitle: { color: Colors.slate800, fontSize: 13, fontWeight: "800", marginTop: 8 },
  profileEmptyText: { color: Colors.slate500, fontSize: 11, marginTop: 4, textAlign: "center" },
  profileListRow: { marginTop: 9, padding: 11, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.cardBackground },
  profileRowMain: { flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  profileRowIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: Colors.primaryLight + "50" },
  profileRowCopy: { flex: 1, alignItems: "flex-end" },
  profileRowTitle: { color: Colors.slate900, fontSize: 13, fontWeight: "800", textAlign: "right" },
  profileRowMeta: { color: Colors.slate500, fontSize: 10, marginTop: 3, textAlign: "right" },
  profileRowActions: { flexDirection: "row-reverse", alignItems: "center", gap: 18, marginTop: 9, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.slate100 },
  profileSmallAction: { color: Colors.primary, fontSize: 11, fontWeight: "800" },
  profileSmallDanger: { color: Colors.danger, fontSize: 11, fontWeight: "800" },
  profilePackageRow: { padding: 13, marginTop: 10, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.cardBackground },
  profileSubjectRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 8, paddingTop: 9, marginTop: 8, borderTopWidth: 1, borderTopColor: Colors.slate100 },
  profileSubjectName: { flex: 1, color: Colors.slate800, fontSize: 11, fontWeight: "800", textAlign: "right" },
  profilePackagePrice: { color: Colors.slate700, fontSize: 11, fontWeight: "700", marginTop: 9, textAlign: "right" },
  profileSmallDangerButton: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 9, marginTop: 8, borderRadius: 8, backgroundColor: Colors.dangerLight },
  profileAttendanceGroup: { padding: 12, marginTop: 9, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.cardBackground },
  profileAttendanceMetrics: { flexDirection: "row-reverse", justifyContent: "space-around", marginTop: 12, paddingTop: 9, borderTopWidth: 1, borderTopColor: Colors.slate100 },
  profileAttendanceValue: { color: Colors.slate900, fontSize: 16, fontWeight: "900", textAlign: "center" },
  profileAttendanceLabel: { color: Colors.slate500, fontSize: 9, marginTop: 2, textAlign: "center" },
  profileSubsectionTitle: { marginTop: 18, marginBottom: 7, color: Colors.slate700, fontSize: 12, fontWeight: "900", textAlign: "right" },
  profileHistoryRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.slate100 },
  profileHistoryIcon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: Colors.slate50 },
  profileFinanceSummary: { flexDirection: "row-reverse", justifyContent: "space-between", gap: 6, padding: 12, marginTop: 13, borderRadius: 13, backgroundColor: Colors.slate50 },
  profileFinanceLabel: { color: Colors.slate500, fontSize: 9, textAlign: "right" },
  profileFinanceValue: { color: Colors.slate900, fontSize: 13, fontWeight: "900", marginTop: 5, textAlign: "right" },
  profileSessionDebt: { padding: 12, marginTop: 9, borderRadius: 12, backgroundColor: Colors.primaryLight + "35" },
  profilePaymentRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: Colors.slate100 },
  profilePaymentActions: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  profileNoteCard: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 9, padding: 14, marginTop: 12, borderRadius: 13, backgroundColor: Colors.slate50 },
  profileNoteText: { flex: 1, color: Colors.slate800, fontSize: 13, lineHeight: 21, textAlign: "right" },
  barcodeModalCard: { width: "92%", padding: 18, borderRadius: 18, backgroundColor: Colors.cardBackground },
  barcodeModalHint: { marginTop: 8, color: Colors.slate500, fontSize: 11, textAlign: "center" },
  barcodeCodeText: { color: Colors.slate900, fontSize: 18, fontWeight: "900", letterSpacing: 1.5, textAlign: "center" },
  barcodeCloseButton: { minHeight: 43, alignItems: "center", justifyContent: "center", marginTop: 15, borderRadius: 11, backgroundColor: Colors.primary },
  barcodeCloseButtonText: { color: Colors.white, fontWeight: "800" },
  editTypeRow: { flexDirection: "row-reverse", gap: 8, marginVertical: 6 },
  editTypeChoice: { flex: 1, paddingVertical: 9, alignItems: "center", borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.slate50 },
  editTypeChoiceActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight + "40" },
  editTypeText: { color: Colors.slate600, fontSize: 12, fontWeight: "700" },
  editTypeTextActive: { color: Colors.primary, fontWeight: "900" },
  editProfileContent: { padding: Spacing.lg, paddingBottom: 36 },
  editField: { marginTop: 13 },
  editProfileActions: { flexDirection: "row", gap: 9, marginTop: 20 },
  profileInfoNotice: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 7, padding: 11, marginTop: 12, borderRadius: 11, backgroundColor: Colors.slate100 },
  profileInfoNoticeText: { flex: 1, color: Colors.slate600, fontSize: 10, lineHeight: 16, textAlign: "right" },
});
