import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
    Alert,
    FlatList,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatCurrency, Strings } from "../../core/localization";
import { PermissionService } from "../../core/permissions";
import { Colors, Spacing, Typography } from "../../core/theme";
import { useServiceVisibility } from "../../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { EnrollmentRepository } from "../../features/enrollments/EnrollmentRepository";
import { PackageRepository } from "../../features/packages/PackageRepository";
import { PackageSubscriptionRepository } from "../../features/packages/PackageSubscriptionRepository";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { TeacherSubjectRepository } from "../../features/teachers/TeacherSubjectRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { DebtAdjustmentRepository } from "../../features/payments/DebtAdjustmentRepository";
import { FinancialCalculationService } from "../../features/payments/FinancialCalculationService";
import { PaymentRepository } from "../../features/payments/PaymentRepository";
import { StudentCardRepository } from "../../features/students/StudentCardRepository";
import { StudentRepository } from "../../features/students/StudentRepository";
import { smartSearch } from "../../shared/utils/smartSearch";
import { AddStudentWizardModal } from "../../features/students/components/AddStudentWizardModal";
import {
    AppButton,
    AppCard,
    AppInput,
    EmptyState,
    StatusBadge,
} from "../../shared/components";
import {
    DebtCycle,
    DetailedStudentFinancialStatus,
    Group,
    PaymentEvent,
    Student,
    StudentCard,
    StudentGroupEnrollment,
    Package,
    PackageSubject,
} from "../../shared/types";
import { formatDisplayIdentifier } from "../../shared/utils/formatters";

export default function StudentsScreen() {
  const { studentId } = useLocalSearchParams<{ studentId?: string }>();
  const services = useServiceVisibility();
  const paymentsEnabled = services.isEnabled("payments");
  const currentUser = useAuthStore((s) => s.currentUser);
  const activeCenterId = useAuthStore((s) => s.activeCenterId);
  const permissions = Array.isArray(currentUser?.permissions)
    ? currentUser.permissions
    : [];

  const [students, setStudents] = useState<Student[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [studentCards, setStudentCards] = useState<StudentCard[]>([]);
  const [studentEnrollments, setStudentEnrollments] = useState<
    StudentGroupEnrollment[]
  >([]);
  const [availableGroups, setAvailableGroups] = useState<Group[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [financialStatus, setFinancialStatus] =
    useState<DetailedStudentFinancialStatus | null>(null);

  // Modal States
  const [isAddStudentOpen, setIsAddStudentOpen] = useState(false);
  const [isCardModalOpen, setIsCardModalOpen] = useState(false);
  const [isEnrollModalOpen, setIsEnrollModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isAdjModalOpen, setIsAdjModalOpen] = useState(false);
  const [isRevModalOpen, setIsRevModalOpen] = useState(false);
  const [isPackageModalOpen, setIsPackageModalOpen] = useState(false);
  const [availablePackages, setAvailablePackages] = useState<Package[]>([]);
  const [packageOptions, setPackageOptions] = useState<PackageSubject[]>([]);
  const [packageId, setPackageId] = useState("");
  const [packageOptionIds, setPackageOptionIds] = useState<string[]>([]);
  const [packageTeacherIds, setPackageTeacherIds] = useState<Record<string, string>>({});
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
  const [enrollStartDate, setEnrollStartDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [enrollSpecialPrice, setEnrollSpecialPrice] = useState("");

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
    setPackageTeacherSearch("");
    setIsPackageModalOpen(true);
  };
  const handlePackageChange = (id: string) => { const options = PackageRepository.getPackageSubjects(id); setPackageId(id); setPackageOptions(options); setPackageOptionIds([]); setPackageTeacherIds(Object.fromEntries(options.map((subject) => [subject.id, subject.defaultTeacherId]))); setPackageTeacherSearch(""); };
  const handleSubscribePackage = async () => {
    if (!selectedStudent || !packageId || packageOptionIds.length === 0) return Alert.alert("تنبيه", "اختر الباقة واختيارًا واحدًا على الأقل.");
    const selectedOptions = packageOptions.filter((option) => packageOptionIds.includes(option.id));
    if (selectedOptions.some((option) => !packageTeacherIds[option.id])) return Alert.alert("تنبيه", "اختار مدرس للمادة دي.");
    try {
      const subscription = await PackageSubscriptionRepository.subscribeStudent({ studentId: selectedStudent.id, packageId, startDate: new Date().toISOString().split("T")[0], selectedOptionIds: packageOptionIds });
      if (PermissionService.hasPermission(permissions, "packages.manage")) {
        for (const option of selectedOptions) {
          const teacherId = packageTeacherIds[option.id] || option.defaultTeacherId;
          if (teacherId !== option.defaultTeacherId) await PackageSubscriptionRepository.setTeacherOverride({ subscriptionId: subscription.id, subjectId: option.subjectId, teacherId });
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
    setStudentCards([]);
    setStudentEnrollments([]);
    setFinancialStatus(null);
    if (studentId) {
      const requested = StudentRepository.findById(String(studentId));
      if (requested) openStudentDetails(requested);
    }
  }, [activeCenterId, studentId]);

  const openStudentDetails = (student: Student) => {
    setSelectedStudent(student);
    try {
      const cards = StudentCardRepository.getCardsByStudentId(student.id);
      setStudentCards(cards);
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForStudent(
        student.id,
      );
      setStudentEnrollments(enrollments);
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

  const handleRecordPayment = async () => {
    if (!selectedStudent) return;
    const amountNum = parseFloat(paymentAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert("تنبيه", "يرجى إدخال مبلغ صحيح أكبر من صفر.");
      return;
    }
    try {
      await PaymentRepository.recordPayment({
        studentId: selectedStudent.id,
        amount: amountNum,
        paymentType,
        debtCycleId: paymentCycleId || undefined,
        notes: paymentNotes.trim() || undefined,
      });
      Alert.alert("تم بنجاح", Strings.paymentRecordedSuccess);
      setIsPaymentModalOpen(false);
      setPaymentAmount("");
      setPaymentNotes("");
      setPaymentCycleId("");
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
      Alert.alert("تم بنجاح", `تم ربط البطاقة (${cardInput.trim()}) بالطالب.`);
      setIsCardModalOpen(false);
      setCardInput("");
      openStudentDetails(selectedStudent);
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تحديث البطاقة");
    }
  };

  const handleDeactivateCard = (cardId: string) => {
    if (!selectedStudent) return;
    Alert.alert("تأكيد", "هل أنت متأكد من رغبتك في إلغاء تفعيل هذه البطاقة؟", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "نعم، إلغاء البطاقة",
        style: "destructive",
        onPress: () => {
          try {
            StudentCardRepository.deactivateCard(cardId);
            openStudentDetails(selectedStudent);
            loadData();
          } catch (e: any) {
            Alert.alert("خطأ", e?.message || "فشل إلغاء تفعيل البطاقة");
          }
        },
      },
    ]);
  };

  const handleEnrollStudent = () => {
    if (!selectedStudent) return;
    if (!enrollGroupId) {
      Alert.alert("تنبيه", "يرجى اختيار المجموعة أولاً.");
      return;
    }

    try {
      EnrollmentRepository.enrollStudent({
        studentId: selectedStudent.id,
        groupId: enrollGroupId,
        startDate: enrollStartDate,
        specialMonthlyPrice: enrollSpecialPrice
          ? parseFloat(enrollSpecialPrice)
          : undefined,
      });

      Alert.alert("تم بنجاح", "تم تسجيل الطالب في المجموعة بنجاح.");
      setIsEnrollModalOpen(false);
      setEnrollGroupId("");
      setEnrollSpecialPrice("");
      openStudentDetails(selectedStudent);
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل تسجيل الطالب في المجموعة");
    }
  };

  const handleEndEnrollment = (enrollmentId: string) => {
    if (!selectedStudent) return;
    const today = new Date().toISOString().split("T")[0];
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

  const handleDeactivateStudent = () => {
    if (!selectedStudent) return;
    Alert.alert(
      "تأكيد التعطيل",
      `هل أنت متأكد من تعطيل حساب الطالب (${selectedStudent.fullName})؟`,
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "نعم، تعطيل",
          style: "destructive",
          onPress: () => {
            try {
              StudentRepository.deactivateStudent(selectedStudent.id);
              setSelectedStudent(null);
              loadData();
            } catch (e: any) {
              Alert.alert("خطأ", e?.message || "فشل تعطيل حساب الطالب");
            }
          },
        },
      ],
    );
  };

  const filteredStudents = smartSearch(students, searchQuery, [
    { get: (s) => s.fullName, weight: 1.2 },
    { get: (s) => s.studentCode, weight: 1.1 },
    { get: (s) => s.cardCode, weight: 1.1 },
    { get: (s) => s.phone },
    { get: (s) => s.parentPhone },
  ]);

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
  const canDeactivate = PermissionService.hasPermission(
    permissions,
    "students.deactivate",
  );
  const canViewPayments = paymentsEnabled && PermissionService.hasPermission(
    permissions,
    "payments.view",
  );
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

      <View style={styles.content}>
        <AppInput
          placeholder="ابحث بالاسم، كود الطالب، كود الكارت، أو الهاتف..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          containerStyle={{ marginBottom: Spacing.md }}
        />

        <FlatList
          data={filteredStudents}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState message="لا يوجد طلاب مطابقين للبحث الحالي" />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={() => openStudentDetails(item)}
            >
              <AppCard style={styles.studentCard}>
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
                  <StatusBadge
                    text={
                      item.status === "active"
                        ? Strings.studentStatusActive
                        : Strings.studentStatusInactive
                    }
                    type={item.status === "active" ? "success" : "neutral"}
                  />
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

      {/* 1. Add Student Guided Wizard Modal */}
      <AddStudentWizardModal
        visible={isAddStudentOpen}
        onClose={() => setIsAddStudentOpen(false)}
        onStudentCreated={loadData}
      />

      {/* 2. Student Details Modal */}
      {selectedStudent && (
        <Modal visible={!!selectedStudent} animationType="fade" transparent>
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
                <TouchableOpacity onPress={() => setSelectedStudent(null)}>
                  <Ionicons name="close" size={24} color={Colors.slate500} />
                </TouchableOpacity>
              </View>
              <View style={styles.profileActions}>
                <TouchableOpacity style={styles.profileAction} onPress={() => setIsCardModalOpen(true)}><Ionicons name="card-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>الكارت</Text></TouchableOpacity>
                <TouchableOpacity style={styles.profileAction}><Ionicons name="chatbubble-ellipses-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>رسالة</Text></TouchableOpacity>
                <TouchableOpacity style={styles.profileAction}><Ionicons name="call-outline" size={18} color={Colors.primary} /><Text style={styles.profileActionText}>اتصال</Text></TouchableOpacity>
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
                          إصدار / استبدال
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {studentCards.length === 0 ? (
                    <Text style={styles.emptyText}>
                      لم يتم إصدار بطاقة لهذا الطالب بعد.
                    </Text>
                  ) : (
                    studentCards.map((card) => (
                      <View key={card.id} style={styles.cardItemRow}>
                        <View>
                          <Text style={styles.cardItemCode}>
                            كود الكارت: {formatDisplayIdentifier(card.cardCode)}
                          </Text>
                          <Text style={styles.cardItemMeta}>
                            تاريخ الإصدار: {card.issuedAt.split("T")[0]}
                          </Text>
                        </View>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <StatusBadge
                            text={card.status === "active" ? "نشطة" : "ملغاة"}
                            type={
                              card.status === "active" ? "success" : "neutral"
                            }
                          />
                          {canManageCards && card.status === "active" && (
                            <TouchableOpacity
                              onPress={() => handleDeactivateCard(card.id)}
                              style={styles.deactBtn}
                            >
                              <Ionicons
                                name="trash-outline"
                                size={16}
                                color={Colors.danger}
                              />
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    ))
                  )}
                </View>

                {/* Group Enrollments */}
                <View style={styles.sectionBox}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>
                      الاشتراك في المجموعات
                    </Text>
                    {canEnroll && (
                      <TouchableOpacity
                        style={styles.smallActionBtn}
                        onPress={() => setIsEnrollModalOpen(true)}
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
                    studentEnrollments.map((enr) => (
                      <View key={enr.id} style={styles.enrollItemRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.enrollGroupName}>
                            {enr.groupName}
                          </Text>
                          <Text style={styles.enrollMeta}>
                            بدء: {enr.startDate}
                          </Text>
                          {enr.specialMonthlyPrice && (
                            <Text style={styles.enrollMeta}>
                              سعر شهري خاص: {enr.specialMonthlyPrice} ج.م
                            </Text>
                          )}
                        </View>
                        {canEnroll && enr.status === "active" && (
                          <TouchableOpacity
                            onPress={() => handleEndEnrollment(enr.id)}
                            style={styles.endEnrollBtn}
                          >
                            <Text style={styles.endEnrollBtnText}>إنهاء</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    ))
                  )}
                </View>

                {/* Financial Core: Debt Cycles & Cash Payments */}
                {canViewPayments && financialStatus && (
                  <View style={styles.sectionBox}>
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
                      onPress={handleDeactivateStudent}
                      style={{ borderColor: Colors.danger }}
                    />
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      <Modal visible={isPackageModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}><View style={styles.packageModalCard}>
          <Text style={styles.modalTitle}>تحويل الطالب إلى باقة</Text>
          <Text style={styles.fieldNote}>يبدأ الاشتراك من اليوم، ولا يتم حذف التسجيلات أو الدورات السابقة.</Text>
          <AppInput label="بحث المدرس" placeholder="ابحث بالاسم" value={packageTeacherSearch} onChangeText={setPackageTeacherSearch} containerStyle={{ marginBottom: Spacing.sm }} />
          <ScrollView style={{ maxHeight: 360 }}>
            {availablePackages.map((pkg) => <TouchableOpacity key={pkg.id} onPress={() => handlePackageChange(pkg.id)} style={[styles.enrollChoice, packageId === pkg.id && styles.enrollChoiceActive]}><Text>{pkg.name} • {pkg.price} ج.م • حد {pkg.maxSelections}</Text></TouchableOpacity>)}
            {packageOptions.map((option) => { const selected = packageOptionIds.includes(option.id); const max = availablePackages.find((p) => p.id === packageId)?.maxSelections || 1; const subjectTeachers = smartSearch(teachers.filter((teacher) => teacher.id === option.defaultTeacherId), packageTeacherSearch, [{ get: (teacher) => teacher.name }]); return <View key={option.id} style={styles.packageSubjectSection}><TouchableOpacity onPress={() => { if (!selected && packageOptionIds.length >= max) return Alert.alert("تنبيه", `يمكنك اختيار ${max} فقط.`); setPackageOptionIds((old) => selected ? old.filter((id) => id !== option.id) : [...old, option.id]); }} style={[styles.enrollChoice, selected && styles.enrollChoiceActive]}><Text>{selected ? "✓ " : "□ "}{option.subjectName}{option.groupName ? ` · ${option.groupName}` : ""}</Text></TouchableOpacity><Text style={styles.packageTeacherLabel}>المدرس والمجموعة</Text><ScrollView horizontal>{subjectTeachers.map((teacher) => <TouchableOpacity key={teacher.id} style={[styles.chip, packageTeacherIds[option.id] === teacher.id && styles.chipActive]} onPress={() => setPackageTeacherIds((old) => ({ ...old, [option.id]: teacher.id }))}><Text style={[styles.chipText, packageTeacherIds[option.id] === teacher.id && styles.chipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView>{selected ? <Text style={styles.packageSelectionSummary}>المادة: {option.subjectName} · المجموعة: {option.groupName || "غير محددة"} ← المدرس: {teachers.find((teacher) => teacher.id === packageTeacherIds[option.id])?.name || option.defaultTeacherName || "غير محدد"}</Text> : null}</View>; })}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}><AppButton title="تأكيد التحويل" onPress={handleSubscribePackage} style={{ flex: 1 }} /><AppButton title="إلغاء" variant="outline" onPress={() => setIsPackageModalOpen(false)} style={{ flex: 1 }} /></View>
        </View></View>
      </Modal>

      {/* 3. Issue/Replace Card Modal */}
      <Modal visible={isCardModalOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>إصدار / استبدال كارت الطالب</Text>
            <Text style={styles.fieldNote}>
              سيتم تفعيل الكارت الجديد وإلغاء تفعيل أي كروت سابقة لهذا الطالب
              تلقائياً.
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
            <ScrollView style={{ maxHeight: 150, marginVertical: Spacing.sm }}>
              {availableGroups.map((g) => (
                <TouchableOpacity
                  key={g.id}
                  style={[
                    styles.groupPickItem,
                    enrollGroupId === g.id && styles.groupPickItemActive,
                  ]}
                  onPress={() => setEnrollGroupId(g.id)}
                >
                  <Text
                    style={[
                      styles.groupPickText,
                      enrollGroupId === g.id && styles.groupPickTextActive,
                    ]}
                  >
                    {g.name} ({g.teacherName})
                  </Text>
                </TouchableOpacity>
              ))}
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
                      ? "شهري"
                      : type === "partial"
                        ? "جزئي"
                        : "حصة"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
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
    ...Typography.h2,
    color: Colors.slate900,
    fontWeight: "700",
  },
  headerAddButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: 8,
    gap: 6,
  },
  headerAddButtonText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "600",
  },
  content: {
    flex: 1,
    padding: Spacing.lg,
  },
  studentCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
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
    marginVertical: 4,
  },
  codeBadge: {
    fontSize: 11,
    fontWeight: "600",
    backgroundColor: Colors.slate100,
    color: Colors.slate700,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  cardBadge: {
    fontSize: 11,
    fontWeight: "600",
    backgroundColor: Colors.primaryLight + "30",
    color: Colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  noCardBadge: {
    fontSize: 11,
    backgroundColor: Colors.slate100,
    color: Colors.slate400,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
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
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  detailsModalCard: {
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
    maxHeight: "85%",
  },
  smallModalCard: {
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  packageModalCard: {
    width: "100%",
    maxHeight: "88%",
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: Spacing.md,
  },
  enrollChoice: { padding: 10, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, marginBottom: 6, backgroundColor: Colors.white },
  packageSubjectSection: { backgroundColor: Colors.slate50, borderRadius: 10, padding: 8, marginBottom: 7, borderWidth: 1, borderColor: Colors.slate200 },
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
    fontWeight: "700",
    color: Colors.slate800,
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
});
