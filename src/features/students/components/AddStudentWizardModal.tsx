import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useEffect, useState } from "react";
import {
    Alert,
    Modal,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from "react-native";
import { formatCurrency, formatTimeArabic } from "../../../core/localization";
import {
    BorderRadius,
    Colors,
    Shadows,
    Spacing
} from "../../../core/theme";
import {
    AppButton,
    AppCard,
    AppInput
} from "../../../shared/components";
import { Group, GroupSchedule, Package, PackageSubject } from "../../../shared/types";
import { formatDisplayIdentifier } from "../../../shared/utils/formatters";
import { isEgyptianPhone, isNumericCode, isValidName, ValidationMessages } from "../../../shared/utils/validation";
import { GroupRepository } from "../../groups/GroupRepository";
import { GroupScheduleRepository } from "../../groups/GroupScheduleRepository";
import { TeacherRepository } from "../../teachers/TeacherRepository";
import { StudentCardRepository } from "../StudentCardRepository";
import { StudentRepository } from "../StudentRepository";
import { PackageRepository } from "../../packages/PackageRepository";
import { PackageSubscriptionRepository } from "../../packages/PackageSubscriptionRepository";
import { AcademicStage, CenterAcademicStageRepository, DEFAULT_ACADEMIC_STAGES } from "../../academic/CenterAcademicStageRepository";

const DAYS_OF_WEEK = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

interface AddStudentWizardModalProps {
  visible: boolean;
  onClose: () => void;
  onStudentCreated: () => void;
}

type WizardStep = 1 | 2 | 3 | 4 | 5;

export const AddStudentWizardModal: React.FC<AddStudentWizardModalProps> = ({
  visible,
  onClose,
  onStudentCreated,
}) => {
  const [step, setStep] = useState<WizardStep>(1);

  // Step 1: Card scanning & manual fallback
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [scannedCardCode, setScannedCardCode] = useState("");
  const [manualCardInput, setManualCardInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);

  // Step 2: Student information
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [phoneDuplicateWarning, setPhoneDuplicateWarning] = useState(false);
  const [parentPhoneDuplicateWarning, setParentPhoneDuplicateWarning] = useState(false);
  const [grade, setGrade] = useState("");
  const [gradeStages, setGradeStages] = useState<AcademicStage[]>(() => DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] })));
  const [gradeStage, setGradeStage] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [step2Errors, setStep2Errors] = useState<{
    fullName?: string;
    phone?: string;
    parentPhone?: string;
  }>({});

  // Step 3: Group enrollments
  const [availableGroups, setAvailableGroups] = useState<Group[]>([]);
  const [groupSchedules, setGroupSchedules] = useState<
    Record<string, GroupSchedule[]>
  >({});
  const [teachersMap, setTeachersMap] = useState<Record<string, string>>({});
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [availablePackages, setAvailablePackages] = useState<Package[]>([]);
  const [packageOptions, setPackageOptions] = useState<Record<string, PackageSubject[]>>({});
  const [enrollmentMode, setEnrollmentMode] = useState<"groups" | "package">("groups");
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [selectedPackageOptionIds, setSelectedPackageOptionIds] = useState<string[]>([]);
  const [packageGroupByOption, setPackageGroupByOption] = useState<Record<string, string>>({});
  const [selectionPhase, setSelectionPhase] = useState<"teachers" | "groups">("teachers");
  const [selectedTeacherIds, setSelectedTeacherIds] = useState<string[]>([]);
  const [currentGroupTeacherIndex, setCurrentGroupTeacherIndex] = useState(0);
  const [openTeacherPicker, setOpenTeacherPicker] = useState<number | null>(null);

  // Step 4 & 5: Submission & creation
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load groups, schedules, and teachers when opening wizard
  useEffect(() => {
    if (visible) {
      loadContextData();
    }
  }, [visible]);

  const loadContextData = () => {
    try {
      setGradeStages(CenterAcademicStageRepository.getStages());
      // Load inactive/archived groups too: a student may need to be attached
      // to a group that was created before its schedule was activated.
      const groups = GroupRepository.getAll(true);
      setAvailableGroups(groups);
      try {
        const pkgs = PackageRepository.getPackages();
        setAvailablePackages(pkgs);
        const opts: Record<string, PackageSubject[]> = {};
        pkgs.forEach((p) => { opts[p.id] = PackageRepository.getPackageSubjects(p.id); });
        setPackageOptions(opts);
      } catch (err) { console.warn("Could not load packages:", err); }

      // Load active schedules
      try {
        const schedules = GroupScheduleRepository.getAllActiveSchedules();
        const schedMap: Record<string, GroupSchedule[]> = {};
        for (const s of schedules) {
          if (!schedMap[s.groupId]) schedMap[s.groupId] = [];
          schedMap[s.groupId].push(s);
        }
        setGroupSchedules(schedMap);
      } catch (err) {
        console.warn("Could not load group schedules:", err);
      }

      // Load teachers
      try {
        const teachers = TeacherRepository.getAll();
        const tMap: Record<string, string> = {};
        for (const t of teachers) {
          tMap[t.id] = t.name;
        }
        setTeachersMap(tMap);
      } catch (err) {
        console.warn("Could not load teachers:", err);
      }
    } catch (err) {
      console.error("Error loading context data in wizard:", err);
    }
  };

  const resetForm = () => {
    setStep(1);
    setIsCameraActive(false);
    setTorchEnabled(false);
    setScannedCardCode("");
    setManualCardInput("");
    setScanError(null);
    setFullName("");
    setPhone("");
    setParentPhone("");
    setPhoneDuplicateWarning(false);
    setParentPhoneDuplicateWarning(false);
    setGrade("");
    setGradeStage(null);
    setNotes("");
    setStep2Errors({});
    setSelectedGroupIds([]);
    setEnrollmentMode("groups");
    setSelectedPackageId("");
    setSelectedPackageOptionIds([]);
    setPackageGroupByOption({});
    setSelectionPhase("teachers");
    setSelectedTeacherIds([]);
    setCurrentGroupTeacherIndex(0);
    setIsSubmitting(false);
  };

  const handleClose = () => {
    if (step === 5) {
      resetForm();
      onClose();
      return;
    }

    if (scannedCardCode || fullName.trim()) {
      Alert.alert(
        "إلغاء إضافة الطالب",
        "هل أنت متأكد من الخروج؟ سيتم فقد البيانات المدخلة.",
        [
          { text: "متابعة الإدخال", style: "cancel" },
          {
            text: "خروج",
            style: "destructive",
            onPress: () => {
              resetForm();
              onClose();
            },
          },
        ],
      );
    } else {
      resetForm();
      onClose();
    }
  };

  // Card validation logic (preserves leading zeros)
  const validateAndSetCard = (code: string): boolean => {
    const raw = code.trim();
    if (!raw) {
      setScanError("يرجى إدخال أو مسح كود الكارت.");
      return false;
    }
    if (!isNumericCode(raw)) {
      setScanError(ValidationMessages.code);
      return false;
    }

    // Check if card is already assigned to a student in this center
    try {
      const existingCard = StudentCardRepository.findByCardCode(raw);
      if (existingCard) {
        setScanError(`الكارت (${raw}) مستخدم بالفعل لطالب آخر في هذا المركز.`);
        return false;
      }

      const existingStudent = StudentRepository.findByStudentCode(raw);
      if (existingStudent) {
        setScanError(
          `كود الطالب/الكارت (${raw}) مسجل بالفعل لطالب آخر في هذا المركز.`,
        );
        return false;
      }
    } catch (err: any) {
      console.error("Error validating card code:", err);
    }

    setScannedCardCode(raw);
    setManualCardInput(raw);
    setScanError(null);
    setIsCameraActive(false);
    return true;
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (!data) return;
    const ok = validateAndSetCard(data);
    if (ok) {
      // Advance to step 2 directly after valid scan
      setStep(2);
    }
  };

  const handleManualCardSubmit = () => {
    const ok = validateAndSetCard(manualCardInput);
    if (ok) {
      setStep(2);
    }
  };

  const handleStep2Next = () => {
    const errors: {
      fullName?: string;
      phone?: string;
      parentPhone?: string;
    } = {};

    if (!isValidName(fullName)) {
      errors.fullName = "اسم الطالب مطلوب.";
    }
    if (!isEgyptianPhone(phone)) {
      errors.phone = "رقم هاتف الطالب مطلوب.";
    }
    if (!isEgyptianPhone(parentPhone)) {
      errors.parentPhone = "رقم هاتف ولي الأمر مطلوب.";
    }
    if (!grade.trim()) {
      Alert.alert("تنبيه", "اختر المرحلة والصف الدراسي للطالب.");
      return;
    }

    if (Object.keys(errors).length > 0) {
      setStep2Errors(errors);
      return;
    }

    setStep2Errors({});
    setStep(3);
  };

  const toggleGroupSelection = (groupId: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId],
    );
  };

  // A teacher may teach multiple subjects and have multiple weekly groups.
  // The student chooses the concrete group for the selected teacher; do not
  // hide a valid group merely because the package option's subject snapshot
  // differs from the group's current subject.
  // Group creation historically allowed entering "الصف ..." while the
  // student wizard stores the same grade without that prefix. Compare the
  // canonical grade text so only groups for this student's grade appear.
  const normalizeGrade = (value: string) => value.trim().replace(/^الصف\s*/u, "");
  const groupMatchesGrade = (group: Group) => !grade.trim() || normalizeGrade(String(group.grade || "")) === normalizeGrade(grade);
  // A teacher with groups is eligible only when at least one of those groups
  // matches the student's grade. Teachers without groups yet remain visible
  // so enrollment can be completed later when schedules are created.
  const teacherMatchesGrade = (teacherId: string) => {
    const teacherGroups = availableGroups.filter((group) => String(group.teacherId) === String(teacherId));
    return teacherGroups.length === 0 || teacherGroups.some(groupMatchesGrade);
  };
  const groupsForPackageOption = (option: PackageSubject) => availableGroups.filter((group) => String(group.teacherId) === String(option.defaultTeacherId) && groupMatchesGrade(group));
  const selectPackageGroup = (optionId: string, groupId: string) => setPackageGroupByOption((current) => ({ ...current, [optionId]: groupId }));
  const validatePackageGroups = () => {
    if (enrollmentMode !== "package") return true;
    const options = packageOptions[selectedPackageId] || [];
    const selected = options.filter((option) => selectedPackageOptionIds.includes(option.id));
    const missing = selected.find((option) => groupsForPackageOption(option).length > 0 && !packageGroupByOption[option.id]);
    if (missing) { Alert.alert("تنبيه", `اختر مجموعة للمدرس ${missing.defaultTeacherName || "المحدد"}.`); return false; }
    return true;
  };
  const validateCurrentGroupSelection = () => {
    if (enrollmentMode === "package") {
      const optionId = selectedPackageOptionIds[currentGroupTeacherIndex];
      const option = (packageOptions[selectedPackageId] || []).find((item) => item.id === optionId);
      if (option && groupsForPackageOption(option).length > 0 && !packageGroupByOption[option.id]) { Alert.alert("تنبيه", `اختر مجموعة للمدرس ${option.defaultTeacherName || "المحدد"}.`); return false; }
    } else {
      const teacherId = selectedTeacherIds[currentGroupTeacherIndex];
      const teacherGroups = availableGroups.filter((group) => group.teacherId === teacherId && groupMatchesGrade(group));
      if (teacherGroups.length > 0 && !selectedGroupIds.some((id) => teacherGroups.some((group) => group.id === id))) { Alert.alert("تنبيه", "اختر مجموعة لهذا المدرس قبل المتابعة."); return false; }
    }
    return true;
  };

  const handleConfirmAddStudent = () => {
    setIsSubmitting(true);
    try {
      const created = StudentRepository.createStudent({
        studentCode: scannedCardCode,
        cardCode: scannedCardCode,
        fullName: fullName.trim(),
        phone: phone.trim(),
        parentPhone: parentPhone.trim(),
        grade: grade.trim(),
        notes: notes.trim() || undefined,
        groupIds: enrollmentMode === "groups" ? selectedGroupIds : selectedPackageOptionIds.map((optionId) => packageGroupByOption[optionId]).filter(Boolean),
      });
      if (enrollmentMode === "package" && selectedPackageId) {
        PackageSubscriptionRepository.subscribeStudent({
          studentId: created.id,
          packageId: selectedPackageId,
          startDate: new Date().toISOString().split("T")[0],
          selectedOptionIds: selectedPackageOptionIds,
        });
      }

      setIsSubmitting(false);
      setStep(5);
      onStudentCreated();
    } catch (err: any) {
      setIsSubmitting(false);
      Alert.alert("خطأ أثناء الإضافة", err?.message || "فشل تسجيل الطالب");
    }
  };

  const calculateTotalMonthly = () => {
    if (enrollmentMode === "package") return availablePackages.find((p) => p.id === selectedPackageId)?.price || 0;
    return selectedGroupIds.reduce((sum, gId) => {
      const grp = availableGroups.find((g) => g.id === gId);
      return sum + (grp?.monthlyPrice || 0);
    }, 0);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <SafeAreaView style={styles.modalContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {step > 1 && step < 5 ? (
                <TouchableOpacity
                  onPress={() => {
                    if (step === 3 && selectionPhase === "groups") setSelectionPhase("teachers");
                    else setStep((prev) => Math.max(1, prev - 1) as WizardStep);
                  }}
                  style={styles.backButton}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={22}
                    color={Colors.slate700}
                  />
                  <Text style={styles.backButtonText}>السابق</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <Text style={styles.headerTitle}>
              {step === 1 && "مسح كارت الطالب"}
              {step === 2 && "بيانات الطالب"}
              {step === 3 && (selectionPhase === "teachers" ? "اختيار المدرسين" : "اختيار المجموعات")}
              {step === 4 && "مراجعة وتأكيد"}
              {step === 5 && "تمت الإضافة بنجاح"}
            </Text>

            <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={Colors.slate600} />
            </TouchableOpacity>
          </View>

          {/* Stepper Progress Bar (Steps 1 to 4) */}
          {step < 5 && (
            <View style={styles.stepperContainer}>
              {[
                { s: 1, title: "الكارت" },
                { s: 2, title: "البيانات" },
                { s: 3, title: "المجموعات" },
                { s: 4, title: "المراجعة" },
              ].map((item, index) => {
                const isActive = step === item.s;
                const isCompleted = step > item.s;
                return (
                  <React.Fragment key={item.s}>
                    <View style={styles.stepItem}>
                      <View
                        style={[
                          styles.stepBadge,
                          isActive && styles.stepBadgeActive,
                          isCompleted && styles.stepBadgeCompleted,
                        ]}
                      >
                        {isCompleted ? (
                          <Ionicons
                            name="checkmark"
                            size={14}
                            color={Colors.white}
                          />
                        ) : (
                          <Text
                            style={[
                              styles.stepBadgeText,
                              isActive && styles.stepBadgeTextActive,
                            ]}
                          >
                            {item.s}
                          </Text>
                        )}
                      </View>
                      <Text
                        style={[
                          styles.stepTitle,
                          isActive && styles.stepTitleActive,
                          isCompleted && styles.stepTitleCompleted,
                        ]}
                      >
                        {item.title}
                      </Text>
                    </View>
                    {index < 3 && (
                      <View
                        style={[
                          styles.stepConnector,
                          step > item.s && styles.stepConnectorActive,
                        ]}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </View>
          )}

          {/* Body Content */}
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* ============================================================ */}
            {/* STEP 1: SCAN CARD */}
            {/* ============================================================ */}
            {step === 1 && (
              <View style={styles.stepContent}>
                {isCameraActive ? (
                  <View style={styles.cameraBox}>
                    {permission?.granted ? (
                      <View style={styles.cameraWrapper}>
                        <CameraView
                          style={styles.camera}
                          enableTorch={torchEnabled}
                          barcodeScannerSettings={{
                            barcodeTypes: [
                              "qr",
                              "code128",
                              "ean13",
                              "upc_a",
                              "code39",
                            ],
                          }}
                          onBarcodeScanned={handleBarcodeScanned}
                        />

                        {/* Scanner Viewport Overlay */}
                        <View style={styles.scannerOverlay}>
                          <View style={styles.scannerControls}>
                            <TouchableOpacity
                              style={styles.scannerControlBtn}
                              onPress={() => setTorchEnabled((prev) => !prev)}
                            >
                              <Ionicons
                                name={torchEnabled ? "flash" : "flash-outline"}
                                size={22}
                                color={
                                  torchEnabled ? Colors.warning : Colors.white
                                }
                              />
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.scannerControlBtn}
                              onPress={() => setIsCameraActive(false)}
                            >
                              <Ionicons
                                name="close"
                                size={22}
                                color={Colors.white}
                              />
                            </TouchableOpacity>
                          </View>

                          <View style={styles.scannerTargetFrame}>
                            <View
                              style={[
                                styles.cornerBorder,
                                styles.cornerTopRight,
                              ]}
                            />
                            <View
                              style={[
                                styles.cornerBorder,
                                styles.cornerTopLeft,
                              ]}
                            />
                            <View
                              style={[
                                styles.cornerBorder,
                                styles.cornerBottomRight,
                              ]}
                            />
                            <View
                              style={[
                                styles.cornerBorder,
                                styles.cornerBottomLeft,
                              ]}
                            />
                          </View>

                          <Text style={styles.scannerHint}>
                            قم بتوجيه الكاميرا نحو باركود أو QR كارت الطالب
                          </Text>
                        </View>
                      </View>
                    ) : (
                      <View style={styles.permissionContainer}>
                        <Ionicons
                          name="camera-outline"
                          size={48}
                          color={Colors.slate400}
                        />
                        <Text style={styles.permissionTitle}>
                          إذن الكاميرا مطلوب
                        </Text>
                        <Text style={styles.permissionSubtitle}>
                          يلزم السماح لتطبيق فيكسيون باستخدام الكاميرا لمسح كارت
                          الطالب.
                        </Text>
                        <AppButton
                          title="منح إذن الكاميرا"
                          onPress={requestPermission}
                          style={{ marginTop: Spacing.md }}
                        />
                        <AppButton
                          title="إلغاء واستخدام الإدخال اليدوي"
                          variant="outline"
                          onPress={() => setIsCameraActive(false)}
                          style={{ marginTop: Spacing.sm }}
                        />
                      </View>
                    )}
                  </View>
                ) : (
                  <View>
                    {/* Scanned Card Success Badge */}
                    {scannedCardCode ? (
                      <AppCard style={styles.scannedSuccessCard}>
                        <View style={styles.scannedSuccessRow}>
                          <Ionicons
                            name="checkmark-circle"
                            size={36}
                            color={Colors.success}
                          />
                          <View style={{ marginRight: Spacing.md, flex: 1 }}>
                            <Text style={styles.scannedSuccessTitle}>
                              تم قراءة الكارت بنجاح
                            </Text>
                            <Text style={styles.scannedSuccessCode}>
                              كود الكارت:{" "}
                              {formatDisplayIdentifier(scannedCardCode)}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.scannedActions}>
                          <AppButton
                            title="التالي: إدخال البيانات"
                            onPress={() => setStep(2)}
                            style={{ flex: 1 }}
                          />
                          <TouchableOpacity
                            style={styles.rescanButton}
                            onPress={() => {
                              setScannedCardCode("");
                              setIsCameraActive(true);
                            }}
                          >
                            <Ionicons
                              name="scan-outline"
                              size={18}
                              color={Colors.primary}
                            />
                            <Text style={styles.rescanText}>إعادة المسح</Text>
                          </TouchableOpacity>
                        </View>
                      </AppCard>
                    ) : (
                      <View>
                        {/* Error Alert Box */}
                        {scanError && (
                          <View style={styles.errorBanner}>
                            <Ionicons
                              name="alert-circle"
                              size={20}
                              color={Colors.danger}
                            />
                            <Text style={styles.errorBannerText}>
                              {scanError}
                            </Text>
                          </View>
                        )}

                        {/* Scan Button Card */}
                        <AppCard style={styles.heroScanCard}>
                          <View style={styles.heroIconBox}>
                            <Ionicons
                              name="qr-code"
                              size={48}
                              color={Colors.primary}
                            />
                          </View>
                          <Text style={styles.heroScanTitle}>
                            مسح كارت الطالب الذكي
                          </Text>
                          <Text style={styles.heroScanDesc}>
                            وجّه كاميرا الجهاز نحو بطاقة الطالب لقراءة الكود
                            تلقائياً
                          </Text>
                          <AppButton
                            title="مسح كارت الطالب"
                            size="lg"
                            icon={
                              <Ionicons
                                name="camera"
                                size={20}
                                color={Colors.white}
                              />
                            }
                            onPress={() => {
                              setScanError(null);
                              setIsCameraActive(true);
                            }}
                            style={{ width: "100%", marginTop: Spacing.md }}
                          />
                        </AppCard>

                        {/* Divider */}
                        <View style={styles.dividerRow}>
                          <View style={styles.dividerLine} />
                          <Text style={styles.dividerText}>
                            أو الإدخال اليدوي
                          </Text>
                          <View style={styles.dividerLine} />
                        </View>

                        {/* Manual Entry Fallback */}
                        <AppCard style={styles.manualEntryCard}>
                          <AppInput
                            label="كود الكارت يدوياً *"
                            placeholder="مثال: 00126"
                            value={manualCardInput}
                            onChangeText={(text) => {
                              setManualCardInput(text);
                              setScanError(null);
                            }}
                            keyboardType="default"
                            inputKind="cardCode"
                            autoCapitalize="none"
                            containerStyle={{ marginBottom: Spacing.sm }}
                          />
                          <Text style={styles.leadingZerosHint}>
                            * يتم الاحتفاظ بالأصفار البادئة (مثلاً 00126) دون أي
                            تعديل.
                          </Text>
                          <AppButton
                            title="تأكيد كود الكارت والمتابعة"
                            variant="secondary"
                            onPress={handleManualCardSubmit}
                            disabled={!manualCardInput.trim()}
                            style={{ marginTop: Spacing.sm }}
                          />
                        </AppCard>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}

            {/* ============================================================ */}
            {/* STEP 2: STUDENT INFORMATION */}
            {/* ============================================================ */}
            {step === 2 && (
              <View style={styles.stepContent}>
                <View style={styles.cardIndicatorRow}>
                  <Ionicons
                    name="card-outline"
                    size={18}
                    color={Colors.primary}
                  />
                  <Text style={styles.cardIndicatorText}>
                    كود الكارت المحدد:{" "}
                    <Text style={{ fontWeight: "700" }}>
                      {formatDisplayIdentifier(scannedCardCode)}
                    </Text>
                  </Text>
                </View>

                <AppInput
                  label="اسم الطالب ثلاثي / رباعي *"
                  placeholder="مثال: يوسف أحمد علي"
                  value={fullName}
                  onChangeText={(val) => {
                    setFullName(val);
                    if (step2Errors.fullName)
                      setStep2Errors((e) => ({ ...e, fullName: undefined }));
                  }}
                  error={step2Errors.fullName}
                  onBlur={() => setStep2Errors((e) => ({ ...e, fullName: isValidName(fullName) ? undefined : ValidationMessages.name }))}
                  containerStyle={styles.formField}
                />

                <AppInput
                  label="رقم هاتف الطالب *"
                  placeholder="مثال: 01012345678"
                  value={phone}
                  onChangeText={(val) => {
                    setPhone(val);
                    setPhoneDuplicateWarning(false);
                    if (step2Errors.phone)
                      setStep2Errors((e) => ({ ...e, phone: undefined }));
                  }}
                  keyboardType="phone-pad"
                  inputKind="phone"
                  error={step2Errors.phone}
                  onBlur={() => {
                    const valid = isEgyptianPhone(phone);
                    setStep2Errors((e) => ({ ...e, phone: valid ? undefined : ValidationMessages.phone }));
                    setPhoneDuplicateWarning(valid && StudentRepository.isPhoneUsedInActiveCenter(phone));
                  }}
                  containerStyle={styles.formField}
                />
                {phoneDuplicateWarning ? (
                  <View style={styles.phoneWarning}>
                    <Text style={styles.phoneWarningText}>⚠️ الرقم ده مستخدم قبل كده</Text>
                    <Text style={styles.phoneWarningHint}>ممكن تستخدم نفس الرقم عادي لو ده مقصود</Text>
                    <View style={styles.phoneWarningActions}>
                      <AppButton title="تعديل الرقم" size="sm" variant="outline" onPress={() => setPhoneDuplicateWarning(false)} />
                      <AppButton title="استخدام الرقم على أي حال" size="sm" variant="secondary" onPress={() => setPhoneDuplicateWarning(false)} />
                    </View>
                  </View>
                ) : null}

                <AppInput
                  label="رقم هاتف ولي الأمر *"
                  placeholder="مثال: 01198765432"
                  value={parentPhone}
                  onChangeText={(val) => {
                    setParentPhone(val);
                    setParentPhoneDuplicateWarning(false);
                    if (step2Errors.parentPhone)
                      setStep2Errors((e) => ({ ...e, parentPhone: undefined }));
                  }}
                  keyboardType="phone-pad"
                  inputKind="phone"
                  error={step2Errors.parentPhone}
                  onBlur={() => {
                    const valid = isEgyptianPhone(parentPhone);
                    setStep2Errors((e) => ({ ...e, parentPhone: valid ? undefined : ValidationMessages.phone }));
                    setParentPhoneDuplicateWarning(valid && StudentRepository.isPhoneUsedInActiveCenter(parentPhone));
                  }}
                  containerStyle={styles.formField}
                />
                {parentPhoneDuplicateWarning ? (
                  <View style={styles.phoneWarning}>
                    <Text style={styles.phoneWarningText}>⚠️ الرقم ده مستخدم قبل كده</Text>
                    <Text style={styles.phoneWarningHint}>ممكن تستخدم نفس الرقم عادي لو ده مقصود</Text>
                    <View style={styles.phoneWarningActions}>
                      <AppButton title="تعديل الرقم" size="sm" variant="outline" onPress={() => setParentPhoneDuplicateWarning(false)} />
                      <AppButton title="استخدام الرقم على أي حال" size="sm" variant="secondary" onPress={() => setParentPhoneDuplicateWarning(false)} />
                    </View>
                  </View>
                ) : null}

                <View style={styles.formField}>
                  <Text style={styles.gradeLabel}>المرحلة الدراسية</Text>
                  <View style={styles.gradeStageRow}>
                    {gradeStages.filter((stage) => stage.grades.length > 0).map((stage) => (
                      <TouchableOpacity key={stage.id} style={[styles.gradeStage, gradeStage === stage.id && styles.gradeStageActive]} onPress={() => { setGradeStage(stage.id); setGrade(""); }}>
                        <Text style={[styles.gradeStageText, gradeStage === stage.id && styles.gradeStageTextActive]}>{stage.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {gradeStage ? <View style={styles.gradeOptions}>
                    {gradeStages.find((stage) => stage.id === gradeStage)?.grades.map((option) => (
                      <TouchableOpacity key={option} style={[styles.gradeOption, grade === option && styles.gradeOptionActive]} onPress={() => setGrade(option)}>
                        <Text style={[styles.gradeOptionText, grade === option && styles.gradeOptionTextActive]}>{grade === option ? "✓ " : ""}{option}</Text>
                      </TouchableOpacity>
                    ))}
                  </View> : <Text style={styles.gradeHint}>اختر المرحلة أولاً ثم الصف الدراسي.</Text>}
                </View>

                <AppInput
                  label="ملاحظات إضافية (اختياري)"
                  placeholder="أي تفاصيل خاصة بالطالب..."
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={2}
                  containerStyle={styles.formField}
                />

                <View style={styles.stepNavRow}>
                  <AppButton
                    title="السابق"
                    variant="outline"
                    onPress={() => setStep(1)}
                    style={{ flex: 1, marginLeft: Spacing.sm }}
                  />
                  <AppButton
                    title="التالي: اختيار المجموعات"
                    onPress={handleStep2Next}
                    style={{ flex: 2 }}
                  />
                </View>
              </View>
            )}

            {/* ============================================================ */}
            {/* STEP 3: GROUP ENROLLMENTS */}
            {/* ============================================================ */}
            {step === 3 && selectionPhase === "teachers" && (
              <View style={styles.stepContent}>
                <View style={styles.modeSwitch}>
                  <TouchableOpacity style={[styles.modeButton, enrollmentMode === "groups" && styles.modeButtonActive]} onPress={() => setEnrollmentMode("groups")}><Text style={styles.modeText}>مجموعات عادية</Text></TouchableOpacity>
                  <TouchableOpacity style={[styles.modeButton, enrollmentMode === "package" && styles.modeButtonActive]} onPress={() => setEnrollmentMode("package")}><Text style={styles.modeText}>باقة</Text></TouchableOpacity>
                </View>
                <Text style={styles.stepSubtitle}>اختر المدرسين أولًا، ثم اختر مجموعة كل مدرس في الخطوة التالية.</Text>
                {enrollmentMode === "package" ? <View>
                  {availablePackages.map((pkg) => <TouchableOpacity key={pkg.id} onPress={() => { setSelectedPackageId(pkg.id); setSelectedPackageOptionIds([]); setPackageGroupByOption({}); }}><AppCard style={[styles.groupSelectCard, selectedPackageId === pkg.id && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{pkg.name}</Text><Text>{formatCurrency(pkg.price)} / شهر • حتى {pkg.maxSelections} مدرسين</Text></AppCard></TouchableOpacity>)}
                  {!!selectedPackageId && (packageOptions[selectedPackageId] || []).filter((option) => teacherMatchesGrade(option.defaultTeacherId)).map((option) => { const selected = selectedPackageOptionIds.includes(option.id); const pkg = availablePackages.find((p) => p.id === selectedPackageId)!; return <TouchableOpacity key={option.id} onPress={() => { if (!selected && selectedPackageOptionIds.length >= pkg.maxSelections) { Alert.alert("تنبيه", `يمكنك اختيار ${pkg.maxSelections} فقط.`); return; } setSelectedPackageOptionIds((old) => selected ? old.filter((id) => id !== option.id) : [...old, option.id]); }}><AppCard style={[styles.groupSelectCard, selected && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{selected ? "✓ " : "□ "}{option.defaultTeacherName} - {option.subjectName}</Text></AppCard></TouchableOpacity>; })}
                </View> : <View>{Object.entries(teachersMap).filter(([teacherId]) => teacherMatchesGrade(teacherId)).map(([teacherId, teacherName]) => <TouchableOpacity key={teacherId} onPress={() => setSelectedTeacherIds((old) => old.includes(teacherId) ? old.filter((id) => id !== teacherId) : [...old, teacherId])}><AppCard style={[styles.groupSelectCard, selectedTeacherIds.includes(teacherId) && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{selectedTeacherIds.includes(teacherId) ? "✓ " : "□ "}{teacherName}</Text></AppCard></TouchableOpacity>)}</View>}
                <View style={styles.stepNavRow}><AppButton title="التالي: اختيار المجموعات" onPress={() => { if (enrollmentMode === "package" ? !selectedPackageId || selectedPackageOptionIds.length === 0 : selectedTeacherIds.length === 0) { Alert.alert("تنبيه", "اختر مدرسًا واحدًا على الأقل."); return; } setCurrentGroupTeacherIndex(0); setSelectionPhase("groups"); }} style={{ flex: 1 }} /></View>
              </View>
            )}
            {step === 3 && selectionPhase === "groups" && (
              <View style={styles.stepContent}>
                <View style={styles.modeSwitch}>
                  <TouchableOpacity style={[styles.modeButton, enrollmentMode === "groups" && styles.modeButtonActive]} onPress={() => setEnrollmentMode("groups")}><Text style={styles.modeText}>مجموعات عادية</Text></TouchableOpacity>
                  <TouchableOpacity style={[styles.modeButton, enrollmentMode === "package" && styles.modeButtonActive]} onPress={() => setEnrollmentMode("package")}><Text style={styles.modeText}>باقة</Text></TouchableOpacity>
                </View>
                {false && enrollmentMode === "package" && <View>
                  <Text style={styles.stepSubtitle}>اختر باقة ثم اختيارات المدرسين/المواد.</Text>
                  {availablePackages.map((pkg) => <TouchableOpacity key={pkg.id} onPress={() => { setSelectedPackageId(pkg.id); setSelectedPackageOptionIds([]); setPackageGroupByOption({}); }}><AppCard style={[styles.groupSelectCard, selectedPackageId === pkg.id && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{pkg.name}</Text><Text>{formatCurrency(pkg.price)} / شهر • حتى {pkg.maxSelections} اختيارات</Text></AppCard></TouchableOpacity>)}
                  {!!selectedPackageId && (packageOptions[selectedPackageId] || []).map((option) => { const selected = selectedPackageOptionIds.includes(option.id); const pkg = availablePackages.find((p) => p.id === selectedPackageId)!; return <TouchableOpacity key={option.id} onPress={() => { if (!selected && selectedPackageOptionIds.length >= pkg.maxSelections) { Alert.alert("تنبيه", `يمكنك اختيار ${pkg.maxSelections} فقط.`); return; } setSelectedPackageOptionIds((old) => selected ? old.filter((id) => id !== option.id) : [...old, option.id]); }}><AppCard style={[styles.groupSelectCard, selected && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{selected ? "✓ " : "□ "}{option.subjectName} - {option.defaultTeacherName}</Text></AppCard></TouchableOpacity>; })}
                </View>}
                {enrollmentMode === "package" && selectedPackageId && (packageOptions[selectedPackageId] || []).filter((option) => selectedPackageOptionIds.includes(option.id) && selectedPackageOptionIds.indexOf(option.id) === currentGroupTeacherIndex).map((option) => {
                  const matchingGroups = groupsForPackageOption(option);
                  return <View key={`available-package-groups-${option.id}`} style={styles.packageGroupBox}>
                    <Text style={styles.packageGroupTitle}>{option.defaultTeacherName} - اختر المجموعة</Text>
                    {matchingGroups.length === 0 ? <Text style={styles.packageGroupHint}>لا توجد مجموعة لهذا المدرس حاليًا؛ يمكنك المتابعة بدون مجموعة.</Text> : matchingGroups.map((group) => <TouchableOpacity key={group.id} onPress={() => { if (!selectedPackageOptionIds.includes(option.id)) setSelectedPackageOptionIds((old) => [...old, option.id]); selectPackageGroup(option.id, group.id); }}><AppCard style={[styles.groupSelectCard, packageGroupByOption[option.id] === group.id && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{packageGroupByOption[option.id] === group.id ? "✓ " : "□ "}{group.name}</Text><Text style={styles.groupCardTeacher}>{group.status === "active" ? "نشطة" : "مؤرشفة"}</Text></AppCard></TouchableOpacity>)}
                  </View>;
                })}
                {false && enrollmentMode === "package" && selectedPackageOptionIds.map((optionId) => {
                  const option = (packageOptions[selectedPackageId] || []).find((item) => item.id === optionId);
                  if (!option) return null;
                  const matchingGroups = groupsForPackageOption(option);
                  return <View key={`package-groups-${option.id}`} style={styles.packageGroupBox}>
                    <Text style={styles.packageGroupTitle}>{option.defaultTeacherName} - {option.subjectName}</Text>
                    {matchingGroups.length === 0 ? <Text style={styles.packageGroupHint}>لا توجد مجموعات لهذا المدرس حاليًا؛ يمكنك المتابعة وسيتم تحديدها لاحقًا.</Text> : matchingGroups.map((group) => <TouchableOpacity key={group.id} onPress={() => selectPackageGroup(option.id, group.id)}><AppCard style={[styles.groupSelectCard, packageGroupByOption[option.id] === group.id && styles.groupSelectCardActive]}><Text style={styles.groupCardName}>{packageGroupByOption[option.id] === group.id ? "✓ " : "□ "}{group.name}</Text><Text style={styles.groupCardTeacher}>{groupSchedules[group.id]?.length ? groupSchedules[group.id].map((s) => `${DAYS_OF_WEEK[s.dayOfWeek]} ${s.startTime}-${s.endTime}`).join(" • ") : "بدون موعد محدد بعد"}</Text></AppCard></TouchableOpacity>)}
                  </View>;
                })}
                {enrollmentMode === "groups" && <Text style={styles.stepSubtitle}>
                  اختر المجموعات التي سينضم إليها الطالب (يمكنك اختيار أكثر من
                  مجموعة):
                </Text>}

                {enrollmentMode === "groups" && (availableGroups.length === 0 ? (
                  <AppCard style={styles.emptyGroupsCard}>
                    <Ionicons
                      name="people-outline"
                      size={42}
                      color={Colors.slate400}
                    />
                    <Text style={styles.emptyGroupsText}>
                      لا توجد مجموعات نشطة في هذا المركز حالياً.
                    </Text>
                    <Text style={styles.emptyGroupsSubtext}>
                      يمكنك متابعة تسجيل الطالب بدون مجموعات، ثم تسجيله لاحقاً.
                    </Text>
                  </AppCard>
                ) : (
                  <View style={{ marginBottom: Spacing.md }}>
                    {availableGroups.filter((grp) => grp.teacherId === selectedTeacherIds[currentGroupTeacherIndex] && groupMatchesGrade(grp)).map((grp) => {
                      const isSelected = selectedGroupIds.includes(grp.id);
                      const teacherName =
                        teachersMap[grp.teacherId] || "غير محدد";
                      const schedules = groupSchedules[grp.id] || [];

                      return (
                        <TouchableOpacity
                          key={grp.id}
                          activeOpacity={0.8}
                          onPress={() => toggleGroupSelection(grp.id)}
                        >
                          <AppCard
                            style={[
                              styles.groupSelectCard,
                              isSelected && styles.groupSelectCardActive,
                            ]}
                          >
                            <View style={styles.groupCardHeader}>
                              <View style={styles.checkboxIcon}>
                                <Ionicons
                                  name={
                                    isSelected ? "checkbox" : "square-outline"
                                  }
                                  size={24}
                                  color={
                                    isSelected
                                      ? Colors.primary
                                      : Colors.slate400
                                  }
                                />
                              </View>
                              <View
                                style={{ flex: 1, marginRight: Spacing.sm }}
                              >
                                <Text style={styles.groupCardName}>
                                  {grp.name}
                                </Text>
                                <Text style={styles.groupCardTeacher}>
                                  المعلم: {teacherName} • {grp.grade}
                                </Text>
                              </View>
                              <View style={styles.groupPriceBadge}>
                                <Text style={styles.groupPriceText}>
                                  {formatCurrency(grp.monthlyPrice)} / شهر
                                </Text>
                              </View>
                            </View>

                            {/* Schedule info */}
                            {schedules.length > 0 ? (
                              <View style={styles.groupScheduleBox}>
                                <Ionicons
                                  name="time-outline"
                                  size={14}
                                  color={Colors.slate500}
                                />
                                <Text style={styles.groupScheduleText}>
                                  {schedules
                                    .map(
                                      (s) =>
                                        `${DAYS_OF_WEEK[s.dayOfWeek]} (${formatTimeArabic(s.startTime)} - ${formatTimeArabic(s.endTime)})`,
                                    )
                                    .join(" • ")}
                                </Text>
                              </View>
                            ) : null}
                          </AppCard>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}

                <View style={styles.stepNavRow}>
                  <AppButton
                    title="السابق"
                    variant="outline"
                    onPress={() => { if (selectionPhase === "groups") setSelectionPhase("teachers"); else setStep(2); }}
                    style={{ flex: 1, marginLeft: Spacing.sm }}
                  />
                  <AppButton
                    title={`التالي: المراجعة (${enrollmentMode === "package" ? selectedPackageOptionIds.length : selectedGroupIds.length})`}
                    onPress={() => { const total = enrollmentMode === "package" ? selectedPackageOptionIds.length : selectedTeacherIds.length; if (!validateCurrentGroupSelection()) return; if (currentGroupTeacherIndex < total - 1) setCurrentGroupTeacherIndex((index) => index + 1); else if (validatePackageGroups()) setStep(4); }}
                    style={{ flex: 2 }}
                  />
                </View>
              </View>
            )}

            {/* ============================================================ */}
            {/* STEP 4: REVIEW & CONFIRMATION */}
            {/* ============================================================ */}
            {step === 4 && (
              <View style={styles.stepContent}>
                <Text style={styles.stepSubtitle}>
                  تأكد من صحة بيانات الطالب قبل الحفظ النهائي:
                </Text>

                <AppCard style={styles.reviewCard}>
                  {/* Card Identifier */}
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>كود الكارت / الطالب:</Text>
                    <View style={styles.codeTag}>
                      <Ionicons name="card" size={14} color={Colors.primary} />
                      <Text style={styles.codeTagText}>
                        {formatDisplayIdentifier(scannedCardCode)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.reviewDivider} />

                  {/* Student Details */}
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>اسم الطالب:</Text>
                    <Text style={styles.reviewValue}>{fullName}</Text>
                  </View>

                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>المرحلة الدراسية:</Text>
                    <Text style={styles.reviewValue}>{grade}</Text>
                  </View>

                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>هاتف الطالب:</Text>
                    <Text style={styles.reviewValue}>{phone}</Text>
                  </View>

                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>هاتف ولي الأمر:</Text>
                    <Text style={styles.reviewValue}>{parentPhone}</Text>
                  </View>

                  {notes ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>ملاحظات:</Text>
                      <Text style={styles.reviewValue}>{notes}</Text>
                    </View>
                  ) : null}

                  <View style={styles.reviewDivider} />

                  {/* Selected Groups */}
                  <View style={{ marginTop: Spacing.xs }}>
                    <Text style={styles.reviewLabel}>
                      المجموعات المختارة ({selectedGroupIds.length}):
                    </Text>
                    {selectedGroupIds.length === 0 ? (
                      <Text style={styles.noGroupsReview}>
                        لم يتم اختيار مجموعات حالياً.
                      </Text>
                    ) : (
                      selectedGroupIds.map((gId) => {
                        const grp = availableGroups.find((g) => g.id === gId);
                        if (!grp) return null;
                        return (
                          <View key={gId} style={styles.selectedGroupItem}>
                            <Ionicons
                              name="checkmark-circle"
                              size={16}
                              color={Colors.success}
                            />
                            <Text style={styles.selectedGroupName}>
                              {grp.name}
                            </Text>
                            <Text style={styles.selectedGroupPrice}>
                              {formatCurrency(grp.monthlyPrice)}
                            </Text>
                          </View>
                        );
                      })
                    )}

                    {selectedGroupIds.length > 0 && (
                      <View style={styles.totalMonthlyRow}>
                        <Text style={styles.totalMonthlyLabel}>
                          إجمالي الرسوم الشهرية:
                        </Text>
                        <Text style={styles.totalMonthlyValue}>
                          {formatCurrency(calculateTotalMonthly())}
                        </Text>
                      </View>
                    )}
                  </View>
                </AppCard>

                <View style={styles.stepNavRow}>
                  <AppButton
                    title="تعديل البيانات"
                    variant="outline"
                    onPress={() => setStep(3)}
                    style={{ flex: 1, marginLeft: Spacing.sm }}
                    disabled={isSubmitting}
                  />
                  <AppButton
                    title="إضافة الطالب"
                    onPress={handleConfirmAddStudent}
                    loading={isSubmitting}
                    style={{ flex: 2 }}
                  />
                </View>
              </View>
            )}

            {/* ============================================================ */}
            {/* STEP 5: SUCCESS CONFIRMATION */}
            {/* ============================================================ */}
            {step === 5 && (
              <View style={styles.successContainer}>
                <View style={styles.successIconCircle}>
                  <Ionicons name="checkmark" size={48} color={Colors.white} />
                </View>

                <Text style={styles.successTitle}>تم إضافة الطالب بنجاح!</Text>
                <Text style={styles.successSubtitle}>
                  تم تسجيل بيانات الطالب وتفعيل الكارت الذكي والاشتراك في
                  المجموعات المختارة.
                </Text>

                <AppCard style={styles.successSummaryCard}>
                  <View style={styles.successSummaryRow}>
                    <Text style={styles.successSummaryLabel}>اسم الطالب:</Text>
                    <Text style={styles.successSummaryValue}>{fullName}</Text>
                  </View>
                  <View style={styles.successSummaryRow}>
                    <Text style={styles.successSummaryLabel}>كود الكارت:</Text>
                    <Text style={styles.successSummaryValue}>
                      {formatDisplayIdentifier(scannedCardCode)}
                    </Text>
                  </View>
                  <View style={styles.successSummaryRow}>
                    <Text style={styles.successSummaryLabel}>
                      المجموعات المسجل بها:
                    </Text>
                    <Text style={styles.successSummaryValue}>
                      {selectedGroupIds.length} مجموعات
                    </Text>
                  </View>
                </AppCard>

                <AppButton
                  title="العودة لقائمة الطلاب"
                  size="lg"
                  onPress={() => {
                    resetForm();
                    onClose();
                  }}
                  style={{ width: "100%", marginBottom: Spacing.sm }}
                />

                <AppButton
                  title="إضافة طالب آخر"
                  variant="outline"
                  size="md"
                  onPress={resetForm}
                  style={{ width: "100%" }}
                />
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    maxHeight: "92%",
    minHeight: "75%",
    ...Shadows.elevated,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.slate200,
  },
  headerLeft: {
    minWidth: 70,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  backButtonText: {
    fontSize: 14,
    color: Colors.slate700,
    fontWeight: "600",
    marginRight: 2,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.slate800,
    textAlign: "center",
  },
  closeButton: {
    minWidth: 70,
    alignItems: "flex-start",
  },
  stepperContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.slate50,
    borderBottomWidth: 1,
    borderBottomColor: Colors.slate200,
  },
  stepItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.slate200,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBadgeActive: {
    backgroundColor: Colors.primary,
  },
  stepBadgeCompleted: {
    backgroundColor: Colors.success,
  },
  stepBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.slate600,
  },
  stepBadgeTextActive: {
    color: Colors.white,
  },
  stepTitle: {
    fontSize: 13,
    color: Colors.slate500,
    marginRight: 6,
    fontWeight: "500",
  },
  stepTitleActive: {
    color: Colors.primary,
    fontWeight: "700",
  },
  stepTitleCompleted: {
    color: Colors.slate700,
    fontWeight: "600",
  },
  stepConnector: {
    flex: 1,
    height: 2,
    backgroundColor: Colors.slate200,
    marginHorizontal: Spacing.xs,
  },
  stepConnectorActive: {
    backgroundColor: Colors.success,
  },
  scrollContent: {
    padding: Spacing.lg,
    paddingBottom: Spacing.xl * 2,
  },
  stepContent: {
    width: "100%",
  },
  modeSwitch: { flexDirection: "row", gap: 8, marginBottom: Spacing.md },
  modeButton: { flex: 1, padding: 12, borderRadius: BorderRadius.md, backgroundColor: Colors.slate100, alignItems: "center" },
  modeButtonActive: { backgroundColor: Colors.primary },
  modeText: { color: Colors.slate800, fontWeight: "700" },
  packageGroupBox: { marginTop: Spacing.sm },
  packageGroupTitle: { fontSize: 14, fontWeight: "700", color: Colors.slate800, marginBottom: Spacing.xs },
  packageGroupHint: { fontSize: 12, color: Colors.slate500, backgroundColor: Colors.slate50, padding: Spacing.sm, borderRadius: BorderRadius.sm },
  stepSubtitle: {
    fontSize: 14,
    color: Colors.slate600,
    marginBottom: Spacing.md,
    textAlign: "right",
  },
  // Step 1 Styles
  cameraBox: {
    height: 380,
    borderRadius: BorderRadius.lg,
    overflow: "hidden",
    backgroundColor: Colors.slate900,
  },
  cameraWrapper: {
    flex: 1,
    position: "relative",
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  scannerControls: {
    position: "absolute",
    top: Spacing.md,
    left: Spacing.md,
    right: Spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  scannerControlBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  scannerTargetFrame: {
    width: 240,
    height: 180,
    position: "relative",
  },
  cornerBorder: {
    position: "absolute",
    width: 28,
    height: 28,
    borderColor: Colors.primary,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 6,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 6,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 6,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 6,
  },
  scannerHint: {
    color: Colors.white,
    fontSize: 14,
    marginTop: Spacing.lg,
    textAlign: "center",
    fontWeight: "600",
    paddingHorizontal: Spacing.md,
  },
  permissionContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.lg,
    backgroundColor: Colors.white,
  },
  permissionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.slate800,
    marginTop: Spacing.sm,
  },
  permissionSubtitle: {
    fontSize: 14,
    color: Colors.slate500,
    textAlign: "center",
    marginTop: Spacing.xs,
  },
  heroScanCard: {
    alignItems: "center",
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  heroIconBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.slate50,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  heroScanTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.slate800,
    marginBottom: 4,
  },
  heroScanDesc: {
    fontSize: 14,
    color: Colors.slate500,
    textAlign: "center",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: Spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.slate200,
  },
  dividerText: {
    paddingHorizontal: Spacing.md,
    fontSize: 12,
    color: Colors.slate400,
    fontWeight: "600",
  },
  manualEntryCard: {
    padding: Spacing.md,
  },
  leadingZerosHint: {
    fontSize: 12,
    color: Colors.slate500,
    marginBottom: Spacing.xs,
    textAlign: "right",
  },
  scannedSuccessCard: {
    padding: Spacing.lg,
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderWidth: 1,
  },
  scannedSuccessRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  scannedSuccessTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.success,
    textAlign: "right",
  },
  scannedSuccessCode: {
    fontSize: 14,
    color: Colors.slate700,
    marginTop: 2,
    textAlign: "right",
  },
  scannedActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  rescanButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginLeft: Spacing.sm,
  },
  rescanText: {
    fontSize: 14,
    color: Colors.primary,
    fontWeight: "600",
    marginRight: 4,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  errorBannerText: {
    color: Colors.danger,
    fontSize: 14,
    fontWeight: "600",
    marginRight: Spacing.sm,
    flex: 1,
    textAlign: "right",
  },
  // Step 2 Styles
  cardIndicatorRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.slate100,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.md,
  },
  cardIndicatorText: {
    fontSize: 14,
    color: Colors.slate700,
    marginRight: Spacing.sm,
  },
  formField: {
    marginBottom: Spacing.md,
  },
  stepNavRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: Spacing.lg,
  },
  // Step 3 Styles
  emptyGroupsCard: {
    alignItems: "center",
    padding: Spacing.xl,
    marginBottom: Spacing.md,
  },
  emptyGroupsText: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.slate700,
    marginTop: Spacing.sm,
    textAlign: "center",
  },
  emptyGroupsSubtext: {
    fontSize: 14,
    color: Colors.slate500,
    marginTop: 4,
    textAlign: "center",
  },
  groupSelectCard: {
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    borderWidth: 1.5,
    borderColor: Colors.slate200,
  },
  groupSelectCardActive: {
    borderColor: Colors.primary,
    backgroundColor: "#F8FAFC",
  },
  groupCardHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  checkboxIcon: {
    marginLeft: Spacing.sm,
  },
  groupCardName: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.slate800,
    textAlign: "right",
  },
  groupCardTeacher: {
    fontSize: 13,
    color: Colors.slate500,
    marginTop: 2,
    textAlign: "right",
  },
  groupPriceBadge: {
    backgroundColor: Colors.slate100,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: BorderRadius.sm,
  },
  groupPriceText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.primary,
  },
  groupScheduleBox: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: Spacing.sm,
    paddingTop: Spacing.xs,
    borderTopWidth: 1,
    borderTopColor: Colors.slate100,
  },
  groupScheduleText: {
    fontSize: 11,
    color: Colors.slate500,
    marginRight: 4,
  },
  // Step 4 Styles
  reviewCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.sm,
  },
  reviewLabel: {
    fontSize: 14,
    color: Colors.slate500,
  },
  reviewValue: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.slate800,
  },
  codeTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.slate100,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
  },
  codeTagText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.primary,
    marginRight: 4,
  },
  reviewDivider: {
    height: 1,
    backgroundColor: Colors.slate100,
    marginVertical: Spacing.sm,
  },
  noGroupsReview: {
    fontSize: 14,
    color: Colors.slate400,
    fontStyle: "italic",
    marginTop: 4,
    textAlign: "right",
  },
  selectedGroupItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  selectedGroupName: {
    fontSize: 14,
    color: Colors.slate700,
    flex: 1,
    marginRight: Spacing.xs,
    textAlign: "right",
  },
  selectedGroupPrice: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.primary,
  },
  totalMonthlyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.slate200,
  },
  totalMonthlyLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.slate700,
  },
  totalMonthlyValue: {
    fontSize: 17,
    fontWeight: "800",
    color: Colors.primary,
  },
  // Step 5 Styles
  successContainer: {
    alignItems: "center",
    paddingVertical: Spacing.xl,
  },
  successIconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.success,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.lg,
    ...Shadows.card,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.slate900,
    marginBottom: Spacing.xs,
    textAlign: "center",
  },
  successSubtitle: {
    fontSize: 14,
    color: Colors.slate500,
    textAlign: "center",
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.lg,
  },
  successSummaryCard: {
    width: "100%",
    padding: Spacing.md,
    marginBottom: Spacing.xl,
  },
  successSummaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
  },
  successSummaryLabel: {
    fontSize: 14,
    color: Colors.slate500,
  },
  successSummaryValue: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.slate800,
  },
  phoneWarning: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginTop: -Spacing.sm,
    marginBottom: Spacing.md,
  },
  phoneWarningText: { fontSize: 13, fontWeight: "700", color: Colors.warningText },
  phoneWarningHint: { fontSize: 12, color: Colors.warningText, marginTop: 2 },
  phoneWarningActions: { flexDirection: "row", gap: Spacing.xs, marginTop: Spacing.sm },
  gradeLabel: { color: Colors.slate700, fontSize: 14, fontWeight: "700", marginBottom: Spacing.xs, textAlign: "right" },
  gradeStageRow: { flexDirection: "row", gap: Spacing.xs },
  gradeStage: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.sm, paddingVertical: Spacing.sm, alignItems: "center", backgroundColor: Colors.white },
  gradeStageActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  gradeStageText: { color: Colors.slate700, fontWeight: "700" },
  gradeStageTextActive: { color: Colors.white },
  gradeOptions: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs, marginTop: Spacing.xs },
  gradeOption: { borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.sm, paddingHorizontal: Spacing.sm, paddingVertical: 7, backgroundColor: Colors.white },
  gradeOptionActive: { backgroundColor: Colors.primaryLight, borderColor: Colors.primary },
  gradeOptionText: { color: Colors.slate700, fontSize: 13 },
  gradeOptionTextActive: { color: Colors.primaryDark, fontWeight: "700" },
  gradeHint: { color: Colors.slate500, fontSize: 12, marginTop: Spacing.xs, textAlign: "right" },
});
