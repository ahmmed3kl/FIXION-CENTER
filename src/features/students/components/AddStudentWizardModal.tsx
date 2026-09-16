import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { formatCurrency, formatTimeArabic } from "../../../core/localization";
import { Colors } from "../../../core/theme";
import { AppButton, AppInput } from "../../../shared/components";
import { Group, GroupSchedule, Package, PackageSubject, Teacher } from "../../../shared/types";
import { smartSearch } from "../../../shared/utils/smartSearch";
import { isEgyptianPhone, isNumericCode, isValidName, ValidationMessages } from "../../../shared/utils/validation";
import { CenterAcademicStageRepository, DEFAULT_ACADEMIC_STAGES, AcademicStage } from "../../academic/CenterAcademicStageRepository";
import { useAuthStore } from "../../auth/useAuthStore";
import { GroupRepository } from "../../groups/GroupRepository";
import { GroupScheduleRepository } from "../../groups/GroupScheduleRepository";
import { PackageRepository } from "../../packages/PackageRepository";
import { PackageSubscriptionRepository } from "../../packages/PackageSubscriptionRepository";
import { TeacherRepository } from "../../teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../../teachers/TeacherSubjectRepository";
import { StudentCardRepository } from "../StudentCardRepository";
import { StudentRepository } from "../StudentRepository";

const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

interface AddStudentWizardModalProps {
  visible: boolean;
  onClose: () => void;
  onStudentCreated: () => void;
}

type FieldErrors = {
  cardCode?: string;
  fullName?: string;
  phone?: string;
  parentPhone?: string;
  grade?: string;
  package?: string;
};

const Section = ({
  icon,
  title,
  hint,
  badge,
  children,
  tone = "blue",
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  hint?: string;
  badge?: string;
  children: React.ReactNode;
  tone?: "blue" | "purple" | "slate";
}) => (
  <View style={styles.section}>
    <View style={styles.sectionHeading}>
      <View style={[styles.sectionIcon, tone === "purple" && styles.sectionIconPurple, tone === "slate" && styles.sectionIconSlate]}>
        <Ionicons name={icon} size={18} color={tone === "purple" ? "#7C3AED" : tone === "slate" ? "#475569" : "#2563EB"} />
      </View>
      <View style={styles.sectionTitleWrap}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      </View>
      {badge ? <View style={styles.countBadge}><Text style={styles.countBadgeText}>{badge}</Text></View> : null}
    </View>
    {children}
  </View>
);

export const AddStudentWizardModal: React.FC<AddStudentWizardModalProps> = ({ visible, onClose, onStudentCreated }) => {
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraActive, setCameraActive] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cardCode, setCardCode] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [grade, setGrade] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phoneDuplicateWarning, setPhoneDuplicateWarning] = useState(false);
  const [parentPhoneDuplicateWarning, setParentPhoneDuplicateWarning] = useState(false);
  const [stages, setStages] = useState<AcademicStage[]>(() => DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] })));
  const [groups, setGroups] = useState<Group[]>([]);
  const [schedules, setSchedules] = useState<Record<string, GroupSchedule[]>>({});
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [levelFilter, setLevelFilter] = useState("all");
  const [teacherFilter, setTeacherFilter] = useState("all");
  const [teacherSearch, setTeacherSearch] = useState("");
  const [showLevels, setShowLevels] = useState(false);
  const [showTeachers, setShowTeachers] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [availablePackages, setAvailablePackages] = useState<Package[]>([]);
  const [packageOptions, setPackageOptions] = useState<Record<string, PackageSubject[]>>({});
  const [packageId, setPackageId] = useState("");
  const [packageOptionIds, setPackageOptionIds] = useState<string[]>([]);
  const [packageTeacherIds, setPackageTeacherIds] = useState<Record<string, string>>({});
  const [packageTeacherSearch, setPackageTeacherSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const currentUser = useAuthStore((state) => state.currentUser);

  useEffect(() => {
    if (!visible) return;
    try {
      setStages(CenterAcademicStageRepository.getStages());
      setGroups(GroupRepository.getAll(true));
      setTeachers(TeacherRepository.getAll());
      const map: Record<string, GroupSchedule[]> = {};
      GroupScheduleRepository.getAllActiveSchedules().forEach((schedule) => {
        (map[schedule.groupId] ||= []).push(schedule);
      });
      setSchedules(map);
      const packages = PackageRepository.getPackages().filter((item) => item.status === "active");
      setAvailablePackages(packages);
      setPackageOptions(Object.fromEntries(packages.map((item) => [item.id, PackageRepository.getPackageSubjects(item.id)])));
    } catch (error) {
      console.warn("Unable to load add-student context:", error);
    }
  }, [visible]);

  const allGrades = useMemo(() => stages.flatMap((stage) => [...stage.grades]), [stages]);
  const filteredTeachers = useMemo(
    () => smartSearch(teachers.filter((teacher) => teacher.status !== "inactive"), teacherSearch, [{ get: (teacher) => teacher.name }]),
    [teacherSearch, teachers],
  );
  const visibleGroups = useMemo(() => groups.filter((group) => {
    if (group.status !== "active") return false;
    if (levelFilter !== "all" && group.grade !== levelFilter) return false;
    return teacherFilter === "all" || group.teacherId === teacherFilter;
  }), [groups, levelFilter, teacherFilter]);
  const selectedGroups = useMemo(() => groups.filter((group) => selectedGroupIds.includes(group.id)), [groups, selectedGroupIds]);
  const selectedPackage = availablePackages.find((item) => item.id === packageId);
  const currentPackageOptions = packageId ? packageOptions[packageId] || [] : [];
  const selectedPackageOptions = currentPackageOptions.filter((option) => packageOptionIds.includes(option.id));

  const resetForm = () => {
    setCameraActive(false); setTorchEnabled(false); setCardCode(""); setScanError(null);
    setFullName(""); setPhone(""); setParentPhone(""); setGrade(""); setNotes(""); setErrors({});
    setPhoneDuplicateWarning(false); setParentPhoneDuplicateWarning(false);
    setLevelFilter("all"); setTeacherFilter("all"); setTeacherSearch(""); setShowLevels(false); setShowTeachers(false); setSelectedGroupIds([]);
    setPackageId(""); setPackageOptionIds([]); setPackageTeacherIds({}); setPackageTeacherSearch(""); setSubmitting(false);
  };

  const close = () => {
    if (cardCode || fullName || phone || selectedGroupIds.length) {
      Alert.alert("إلغاء إضافة الطالب", "سيتم فقد البيانات التي تم إدخالها.", [
        { text: "متابعة الإدخال", style: "cancel" },
        { text: "خروج", style: "destructive", onPress: () => { resetForm(); onClose(); } },
      ]);
      return;
    }
    resetForm(); onClose();
  };

  const validateCard = (value: string) => {
    const raw = value.trim();
    if (!raw) { setScanError("أدخل أو امسح كود الكارت أولاً."); return false; }
    if (!isNumericCode(raw)) { setScanError(ValidationMessages.code); return false; }
    try {
      if (StudentCardRepository.findByCardCode(raw) || StudentRepository.findByStudentCode(raw)) {
        setScanError("هذا الكود مستخدم بالفعل لطالب آخر في هذا المركز."); return false;
      }
    } catch (error) { console.warn("Card validation notice:", error); }
    setCardCode(raw); setScanError(null); setErrors((old) => ({ ...old, cardCode: undefined })); return true;
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) { Alert.alert("إذن الكاميرا", "فعّل إذن الكاميرا لمسح كارت الطالب."); return; }
    }
    setCameraActive(true);
  };

  const onBarcodeScanned = ({ data }: { data: string }) => {
    if (data && validateCard(data)) setCameraActive(false);
  };

  const checkPhone = (value: string, parent = false) => {
    const key = parent ? "parentPhone" : "phone";
    if (!isEgyptianPhone(value)) {
      setErrors((old) => ({ ...old, [key]: ValidationMessages.phone }));
      return;
    }
    setErrors((old) => ({ ...old, [key]: undefined }));
    try {
      const used = StudentRepository.isPhoneUsedInActiveCenter(value);
      parent ? setParentPhoneDuplicateWarning(used) : setPhoneDuplicateWarning(used);
    } catch (error) { console.warn("Phone warning lookup notice:", error); }
  };

  const validateNameOnBlur = () => {
    setErrors((old) => ({ ...old, fullName: isValidName(fullName) ? undefined : ValidationMessages.name }));
  };

  const clearError = (key: keyof FieldErrors) => {
    setErrors((old) => old[key] ? ({ ...old, [key]: undefined }) : old);
  };

  const toggleGroup = (groupId: string) => setSelectedGroupIds((old) => old.includes(groupId) ? old.filter((id) => id !== groupId) : [...old, groupId]);
  const groupTeacherName = (group: Group) => teachers.find((teacher) => teacher.id === group.teacherId)?.name || group.teacherName || "مدرس غير محدد";
  const scheduleText = (groupId: string) => (schedules[groupId] || []).slice(0, 2).map((item) => `${DAYS[item.dayOfWeek]} ${formatTimeArabic(item.startTime)}`).join("  •  ") || "لم يتم تحديد الموعد";

  const selectPackage = (nextPackageId: string) => {
    if (!nextPackageId) { setPackageId(""); setPackageOptionIds([]); setPackageTeacherIds({}); return; }
    const options = packageOptions[nextPackageId] || [];
    const defaults = Object.fromEntries(options.map((option) => [option.id, option.defaultTeacherId]));
    setPackageId(nextPackageId); setPackageOptionIds(options.map((option) => option.id)); setPackageTeacherIds(defaults);
  };

  const togglePackageOption = (option: PackageSubject) => {
    const selected = packageOptionIds.includes(option.id);
    if (!selected && selectedPackage && packageOptionIds.length >= selectedPackage.maxSelections) {
      Alert.alert("تنبيه", `يمكنك اختيار ${selectedPackage.maxSelections} مواد فقط من هذه الباقة.`); return;
    }
    setPackageOptionIds((old) => selected ? old.filter((id) => id !== option.id) : [...old, option.id]);
  };

  const validateForm = () => {
    const next: FieldErrors = {};
    const code = cardCode.trim();
    if (!code || !isNumericCode(code)) next.cardCode = !code ? "كود الطالب مطلوب." : ValidationMessages.code;
    if (!isValidName(fullName)) next.fullName = ValidationMessages.name;
    if (!isEgyptianPhone(phone)) next.phone = ValidationMessages.phone;
    if (!isEgyptianPhone(parentPhone)) next.parentPhone = ValidationMessages.phone;
    if (!grade) next.grade = "اختر الصف الدراسي.";
    if (packageId && (!packageOptionIds.length || packageOptionIds.some((id) => !packageTeacherIds[id]))) next.package = "اختر مادة ومدرساً لكل مادة مختارة في الباقة.";
    setErrors(next);
    return !Object.keys(next).length;
  };

  const submit = async () => {
    if (!validateForm()) { Alert.alert("راجع البيانات", "أكمل الحقول المطلوبة قبل إضافة الطالب."); return; }
    setSubmitting(true);
    try {
      const student = StudentRepository.createStudent({ studentCode: cardCode.trim(), cardCode: cardCode.trim(), fullName: fullName.trim(), phone: phone.trim(), parentPhone: parentPhone.trim(), grade, notes: notes.trim(), groupIds: selectedGroupIds });
      if (packageId) {
        const subscription = await PackageSubscriptionRepository.subscribeStudent({ studentId: student.id, packageId, startDate: new Date().toISOString().slice(0, 10), selectedOptionIds: packageOptionIds });
        if (currentUser?.permissions?.includes("packages.manage")) {
          for (const option of selectedPackageOptions) {
            const teacherId = packageTeacherIds[option.id];
            if (teacherId && teacherId !== option.defaultTeacherId) await PackageSubscriptionRepository.setTeacherOverride({ subscriptionId: subscription.id, subjectId: option.subjectId, teacherId });
          }
        }
      }
      Alert.alert("تمت الإضافة", "تمت إضافة الطالب بنجاح.");
      resetForm(); onStudentCreated(); onClose();
    } catch (error: any) {
      Alert.alert("تعذر إضافة الطالب", error?.message || "حدث خطأ غير متوقع.");
    } finally { setSubmitting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={styles.overlay}>
        <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityLabel="رجوع" style={styles.headerButton} onPress={close}><Ionicons name="chevron-forward" color="#FFF" size={27} /></TouchableOpacity>
            <View style={styles.headerCopy}><Text style={styles.headerTitle}>إضافة طالب</Text><Text style={styles.headerSubtitle}>بيانات الطالب والمجموعات في صفحة واحدة</Text></View>
            <View style={styles.headerMark}><Ionicons name="school-outline" size={25} color="#2563EB" /></View>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Section icon="card-outline" title="الكارت / كود الطالب" hint="امسح الكارت أو أدخل الكود يدوياً">
              {cameraActive ? <View style={styles.cameraWrap}><CameraView style={styles.camera} facing="back" autofocus="on" zoom={0.2} enableTorch={torchEnabled} onBarcodeScanned={onBarcodeScanned} barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8"] }} /><View style={styles.cameraActions}><TouchableOpacity style={styles.cameraAction} onPress={() => setTorchEnabled((value) => !value)}><Ionicons name={torchEnabled ? "flash" : "flash-outline"} size={18} color="#FFF" /></TouchableOpacity><TouchableOpacity style={styles.cameraAction} onPress={() => setCameraActive(false)}><Text style={styles.cameraActionText}>إلغاء</Text></TouchableOpacity></View></View> : <View style={styles.codeRow}><AppInput value={cardCode} onChangeText={(value) => { setCardCode(value); setScanError(null); clearError("cardCode"); }} onBlur={() => cardCode && validateCard(cardCode)} error={scanError || errors.cardCode} placeholder="00126" keyboardType="number-pad" inputKind="cardCode" containerStyle={styles.codeInputWrap} style={styles.compactInput} /><TouchableOpacity style={styles.scanButton} onPress={openCamera}><Ionicons name="camera-outline" size={22} color="#FFF" /></TouchableOpacity></View>}
            </Section>

            <Section icon="person-outline" title="بيانات الطالب">
              <AppInput label="اسم الطالب *" value={fullName} onChangeText={(value) => { setFullName(value); clearError("fullName"); }} onBlur={validateNameOnBlur} error={errors.fullName} placeholder="اكتب الاسم بالكامل" containerStyle={styles.field} style={styles.compactInput} />
              <View style={styles.phoneRow}>
                <AppInput label="هاتف الطالب *" value={phone} onChangeText={(value) => { setPhone(value); setPhoneDuplicateWarning(false); clearError("phone"); }} onBlur={() => checkPhone(phone)} error={errors.phone} placeholder="01012345678" keyboardType="phone-pad" inputKind="phone" maxLength={11} containerStyle={[styles.field, styles.phoneField]} style={styles.compactInput} />
                <AppInput label="هاتف ولي الأمر *" value={parentPhone} onChangeText={(value) => { setParentPhone(value); setParentPhoneDuplicateWarning(false); clearError("parentPhone"); }} onBlur={() => checkPhone(parentPhone, true)} error={errors.parentPhone} placeholder="01276543210" keyboardType="phone-pad" inputKind="phone" maxLength={11} containerStyle={[styles.field, styles.phoneField]} style={styles.compactInput} />
              </View>
              {(phoneDuplicateWarning || parentPhoneDuplicateWarning) ? <View style={styles.phoneWarning}><View style={styles.warningTitleRow}><Ionicons name="alert-circle" color="#D97706" size={18} /><Text style={styles.warningTitle}>هذا الرقم مسجل مسبقاً</Text></View><Text style={styles.warningText}>يمكنك تعديل الرقم أو الاستمرار إذا كان الاستخدام مقصوداً.</Text><View style={styles.warningActions}><TouchableOpacity style={styles.warningAction} onPress={() => { setPhoneDuplicateWarning(false); setParentPhoneDuplicateWarning(false); }}><Text style={styles.warningActionText}>استخدام الرقم</Text></TouchableOpacity><TouchableOpacity style={[styles.warningAction, styles.warningActionSecondary]} onPress={() => { setPhoneDuplicateWarning(false); setParentPhoneDuplicateWarning(false); }}><Text style={styles.warningActionText}>تعديل الرقم</Text></TouchableOpacity></View></View> : null}
              <Text style={styles.fieldLabel}>الصف الدراسي *</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeRow}>{allGrades.map((item) => <TouchableOpacity key={item} onPress={() => { setGrade(item); setErrors((old) => ({ ...old, grade: undefined })); }} style={[styles.gradeChip, grade === item && styles.gradeChipActive]}><Text style={[styles.gradeChipText, grade === item && styles.gradeChipTextActive]}>{item}</Text></TouchableOpacity>)}</ScrollView>
              {errors.grade ? <Text style={styles.inlineError}>{errors.grade}</Text> : null}
              <AppInput label="ملاحظات (اختياري)" value={notes} onChangeText={setNotes} placeholder="أي ملاحظات مهمة عن الطالب" multiline containerStyle={[styles.field, styles.notesField]} style={[styles.compactInput, styles.notesInput]} />
            </Section>

            <Section icon="people-outline" title="معلومات المجموعة" hint="اختر المجموعات التي سينضم إليها الطالب" badge={selectedGroupIds.length ? String(selectedGroupIds.length) : undefined}>
              <View style={styles.filtersRow}>
                <TouchableOpacity style={styles.filterControl} onPress={() => { setShowLevels((value) => !value); setShowTeachers(false); }}><Ionicons name="chevron-down" size={16} color="#64748B" /><View style={styles.filterCopy}><Text style={styles.filterLabel}>المستوى</Text><Text numberOfLines={1} style={styles.filterValue}>{levelFilter === "all" ? "الكل" : levelFilter}</Text></View></TouchableOpacity>
                <TouchableOpacity style={styles.filterControl} onPress={() => { setShowTeachers((value) => !value); setShowLevels(false); }}><Ionicons name="chevron-down" size={16} color="#64748B" /><View style={styles.filterCopy}><Text style={styles.filterLabel}>المدرس</Text><Text numberOfLines={1} style={styles.filterValue}>{teacherFilter === "all" ? "الكل" : teachers.find((teacher) => teacher.id === teacherFilter)?.name || "الكل"}</Text></View></TouchableOpacity>
              </View>
              {showLevels ? <View style={styles.optionPanel}><TouchableOpacity style={[styles.optionChip, levelFilter === "all" && styles.optionChipActive]} onPress={() => { setLevelFilter("all"); setShowLevels(false); }}><Text style={[styles.optionChipText, levelFilter === "all" && styles.optionChipTextActive]}>الكل</Text></TouchableOpacity>{allGrades.map((item) => <TouchableOpacity key={item} style={[styles.optionChip, levelFilter === item && styles.optionChipActive]} onPress={() => { setLevelFilter(item); setShowLevels(false); }}><Text style={[styles.optionChipText, levelFilter === item && styles.optionChipTextActive]}>{item}</Text></TouchableOpacity>)}</View> : null}
              {showTeachers ? <View style={styles.teacherPanel}><AppInput value={teacherSearch} onChangeText={setTeacherSearch} placeholder="ابحث عن مدرس" containerStyle={styles.teacherSearch} style={styles.compactInput} /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionPanel}><TouchableOpacity style={[styles.optionChip, teacherFilter === "all" && styles.optionChipActive]} onPress={() => { setTeacherFilter("all"); setShowTeachers(false); }}><Text style={[styles.optionChipText, teacherFilter === "all" && styles.optionChipTextActive]}>كل المدرسين</Text></TouchableOpacity>{filteredTeachers.map((teacher) => <TouchableOpacity key={teacher.id} style={[styles.optionChip, teacherFilter === teacher.id && styles.optionChipActive]} onPress={() => { setTeacherFilter(teacher.id); setShowTeachers(false); }}><Text style={[styles.optionChipText, teacherFilter === teacher.id && styles.optionChipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView></View> : null}
              <AppInput value={teacherSearch} onChangeText={setTeacherSearch} placeholder="ابحث باسم المجموعة أو المدرس" containerStyle={styles.groupSearch} style={styles.compactInput} />
              <Text style={styles.listCaption}>المجموعات المتاحة ({visibleGroups.length})</Text>
              {visibleGroups.filter((group) => smartSearch([group], teacherSearch, [{ get: (item) => item.name }, { get: (item) => groupTeacherName(item) }]).length).map((group) => { const selected = selectedGroupIds.includes(group.id); return <TouchableOpacity key={group.id} activeOpacity={0.8} onPress={() => toggleGroup(group.id)} style={[styles.groupCard, selected && styles.groupCardSelected]}><View style={[styles.checkBox, selected && styles.checkBoxSelected]}>{selected ? <Ionicons name="checkmark" size={16} color="#FFF" /> : null}</View><View style={styles.groupInfo}><Text numberOfLines={1} style={styles.groupName}>{group.name}</Text><Text numberOfLines={1} style={styles.groupMeta}>{group.subjectName || "المادة"}  •  {groupTeacherName(group)}</Text><View style={styles.timeLine}><Ionicons name="calendar-outline" size={13} color="#64748B" /><Text numberOfLines={1} style={styles.timeText}>{scheduleText(group.id)}</Text></View></View></TouchableOpacity>; })}
              {!visibleGroups.length ? <Text style={styles.emptyText}>لا توجد مجموعات متاحة بهذا الفلتر.</Text> : null}
            </Section>

            {selectedGroups.length ? <Section icon="people" title="المجموعات المختارة" badge={String(selectedGroups.length)} tone="slate">{selectedGroups.map((group) => <View key={group.id} style={styles.selectedGroupRow}><TouchableOpacity accessibilityLabel={`إزالة ${group.name}`} style={styles.removeButton} onPress={() => toggleGroup(group.id)}><Ionicons name="close" size={17} color="#17213A" /></TouchableOpacity><View style={styles.selectedGroupCopy}><Text numberOfLines={1} style={styles.selectedGroupName}>{group.name}</Text><Text numberOfLines={1} style={styles.selectedGroupMeta}>{groupTeacherName(group)}  •  {scheduleText(group.id)}</Text></View></View>)}</Section> : null}

            <Section icon="gift-outline" title="إضافة باقة (اختياري)" hint="يمكنك إضافتها الآن أو لاحقاً" tone="purple">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.packageList}><TouchableOpacity style={[styles.packageChoice, !packageId && styles.packageChoiceActive]} onPress={() => selectPackage("")}><Text style={[styles.packageChoiceText, !packageId && styles.packageChoiceTextActive]}>بدون باقة</Text></TouchableOpacity>{availablePackages.map((item) => <TouchableOpacity key={item.id} style={[styles.packageChoice, packageId === item.id && styles.packageChoiceActive]} onPress={() => selectPackage(item.id)}><Text numberOfLines={1} style={[styles.packageChoiceText, packageId === item.id && styles.packageChoiceTextActive]}>{item.name}</Text><Text style={[styles.packagePrice, packageId === item.id && styles.packageChoiceTextActive]}>{formatCurrency(item.monthlyPrice ?? item.price)}</Text></TouchableOpacity>)}</ScrollView>
              {selectedPackage ? <View style={styles.packageBody}><Text style={styles.packageRule}>اختر حتى {selectedPackage.maxSelections} مواد، وحدد مدرس كل مادة.</Text><AppInput value={packageTeacherSearch} onChangeText={setPackageTeacherSearch} placeholder="ابحث عن مدرس للمادة" containerStyle={styles.groupSearch} style={styles.compactInput} />{currentPackageOptions.map((option) => { const chosen = packageOptionIds.includes(option.id); const subjectTeachers = smartSearch(teachers.filter((teacher) => teacher.status !== "inactive" && TeacherSubjectRepository.isTeacherAssignedToSubject(teacher.id, option.subjectId)), packageTeacherSearch, [{ get: (teacher) => teacher.name }]); const selectedTeacher = teachers.find((teacher) => teacher.id === packageTeacherIds[option.id]); return <View key={option.id} style={[styles.subjectCard, chosen && styles.subjectCardSelected]}><TouchableOpacity onPress={() => togglePackageOption(option)} style={styles.subjectTop}><View style={[styles.checkBox, chosen && styles.checkBoxSelected]}>{chosen ? <Ionicons name="checkmark" size={16} color="#FFF" /> : null}</View><View style={styles.subjectTitleCopy}><Text style={styles.subjectName}>{option.subjectName || "مادة"}</Text><Text style={styles.subjectSub}>اختر المدرس المناسب لهذه المادة</Text></View></TouchableOpacity>{chosen ? <View><Text style={styles.teacherPickerLabel}>المدرس *</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.teacherChoices}>{subjectTeachers.map((teacher) => <TouchableOpacity key={teacher.id} onPress={() => setPackageTeacherIds((old) => ({ ...old, [option.id]: teacher.id }))} style={[styles.teacherChoice, packageTeacherIds[option.id] === teacher.id && styles.teacherChoiceActive]}><Ionicons name="person-outline" size={14} color={packageTeacherIds[option.id] === teacher.id ? "#2563EB" : "#64748B"} /><Text style={[styles.teacherChoiceText, packageTeacherIds[option.id] === teacher.id && styles.teacherChoiceTextActive]}>{teacher.name}</Text></TouchableOpacity>)}</ScrollView><Text style={styles.subjectSummary}>المادة: {option.subjectName || "مادة"} ← المدرس: {selectedTeacher?.name || option.defaultTeacherName || "غير محدد"}</Text></View> : null}</View>; })}<View style={styles.subscriptionSummary}><View style={styles.summaryHeading}><Ionicons name="receipt-outline" size={17} color="#2563EB" /><Text style={styles.summaryTitle}>ملخص الاشتراك</Text></View><View style={styles.summaryLine}><Text style={styles.summaryValue}>{selectedPackage.name}</Text><Text style={styles.summaryLabel}>الباقة</Text></View><View style={styles.summaryLine}><Text style={styles.summaryValue}>{selectedPackageOptions.length} مواد</Text><Text style={styles.summaryLabel}>المواد المختارة</Text></View><View style={styles.summaryLine}><Text style={styles.summaryPrice}>{formatCurrency(selectedPackage.monthlyPrice ?? selectedPackage.price)}</Text><Text style={styles.summaryLabel}>السعر الشهري</Text></View></View>{errors.package ? <Text style={styles.inlineError}>{errors.package}</Text> : null}</View> : null}
            </Section>
            <AppButton title="إضافة الطالب" onPress={submit} loading={submitting} style={styles.submitButton} icon={<Ionicons name="person-add-outline" size={19} color="#FFF" />} />
          </ScrollView>
        </SafeAreaView>
        </SafeAreaProvider>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(10, 20, 42, 0.4)", justifyContent: "flex-end" },
  sheet: { maxHeight: "96%", backgroundColor: "#FFFFFF", borderTopLeftRadius: 25, borderTopRightRadius: 25, overflow: "hidden" },
  header: { backgroundColor: "#121C35", minHeight: 91, paddingHorizontal: 16, paddingVertical: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#27324A", alignItems: "center", justifyContent: "center" },
  headerCopy: { alignItems: "center", flex: 1, paddingHorizontal: 8 }, headerTitle: { color: "#FFF", fontSize: 23, fontWeight: "800" }, headerSubtitle: { color: "#B9C3D6", fontSize: 12, marginTop: 3 },
  headerMark: { width: 48, height: 48, borderRadius: 15, backgroundColor: "#E7F0FF", alignItems: "center", justifyContent: "center" },
  content: { padding: 12, paddingBottom: 28, backgroundColor: "#FFFFFF" },
  section: { backgroundColor: "#F4F7FC", borderRadius: 17, padding: 12, marginBottom: 10 },
  sectionHeading: { flexDirection: "row-reverse", alignItems: "center", marginBottom: 10 }, sectionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "#E5EEFF", marginLeft: 8 }, sectionIconPurple: { backgroundColor: "#F0E8FF" }, sectionIconSlate: { backgroundColor: "#E9EEF5" },
  sectionTitleWrap: { flex: 1, alignItems: "flex-start" }, sectionTitle: { color: "#17213A", fontWeight: "800", fontSize: 17, textAlign: "right" }, sectionHint: { color: "#6B7890", fontSize: 11, marginTop: 1, textAlign: "right" }, countBadge: { minWidth: 25, height: 25, borderRadius: 13, paddingHorizontal: 7, backgroundColor: "#D9E7FF", alignItems: "center", justifyContent: "center" }, countBadgeText: { color: "#2563EB", fontSize: 13, fontWeight: "800" },
  codeRow: { flexDirection: "row-reverse", gap: 9, alignItems: "flex-end" }, codeInputWrap: { flex: 1, marginBottom: 0 }, scanButton: { width: 48, height: 48, borderRadius: 12, backgroundColor: "#2563EB", alignItems: "center", justifyContent: "center", marginBottom: 0 },
  field: { marginBottom: 9 }, compactInput: { height: 43, minHeight: 43, borderRadius: 11, backgroundColor: "#FFF", borderColor: "#D8E1EF", fontSize: 14, paddingHorizontal: 12 },
  phoneRow: { flexDirection: "row-reverse", gap: 8 }, phoneField: { flex: 1 }, phoneWarning: { backgroundColor: "#FFF7ED", borderWidth: 1, borderColor: "#FDE0B6", borderRadius: 12, padding: 10, marginBottom: 10 }, warningTitleRow: { flexDirection: "row-reverse", alignItems: "center", gap: 5 }, warningTitle: { color: "#C26708", fontWeight: "800", fontSize: 13 }, warningText: { color: "#8A5B24", fontSize: 11, marginTop: 3, textAlign: "right" }, warningActions: { flexDirection: "row-reverse", gap: 7, marginTop: 8 }, warningAction: { flex: 1, minHeight: 31, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#F5C681", backgroundColor: "#FFF" }, warningActionSecondary: { backgroundColor: "#FFF9F2" }, warningActionText: { fontSize: 11, color: "#9A5B0C", fontWeight: "700" },
  fieldLabel: { color: "#46546B", fontSize: 12, fontWeight: "700", textAlign: "right", marginBottom: 6 }, gradeRow: { gap: 7, flexDirection: "row-reverse", paddingBottom: 1 }, gradeChip: { minHeight: 33, borderRadius: 17, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderColor: "#D8E1EF", backgroundColor: "#FFF" }, gradeChipActive: { backgroundColor: "#2563EB", borderColor: "#2563EB" }, gradeChipText: { color: "#4A5970", fontSize: 12, fontWeight: "700" }, gradeChipTextActive: { color: "#FFF" }, inlineError: { color: "#DC2626", fontSize: 11, marginTop: 5, textAlign: "right" }, notesField: { marginTop: 9, marginBottom: 0 }, notesInput: { height: 62, minHeight: 62, paddingTop: 10, textAlignVertical: "top" },
  filtersRow: { flexDirection: "row-reverse", gap: 8 }, filterControl: { flex: 1, height: 49, borderRadius: 11, borderWidth: 1, borderColor: "#D8E1EF", backgroundColor: "#FFF", flexDirection: "row", paddingHorizontal: 10, alignItems: "center", gap: 7 }, filterCopy: { flex: 1, alignItems: "flex-end" }, filterLabel: { color: "#66758D", fontSize: 10 }, filterValue: { color: "#1E293B", fontSize: 13, fontWeight: "700", marginTop: 1 }, optionPanel: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6, marginTop: 8 }, teacherPanel: { marginTop: 7 }, teacherSearch: { marginBottom: 0 }, optionChip: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#FFF", borderWidth: 1, borderColor: "#D8E1EF" }, optionChipActive: { backgroundColor: "#E7F0FF", borderColor: "#2563EB" }, optionChipText: { fontSize: 11, color: "#526078", fontWeight: "700" }, optionChipTextActive: { color: "#2563EB" }, groupSearch: { marginTop: 9, marginBottom: 0 }, listCaption: { color: "#334155", fontWeight: "800", fontSize: 13, textAlign: "right", marginTop: 11, marginBottom: 6 },
  groupCard: { backgroundColor: "#FFF", borderWidth: 1, borderColor: "#E0E7F1", borderRadius: 13, padding: 10, marginBottom: 7, flexDirection: "row-reverse", alignItems: "flex-start", gap: 9 }, groupCardSelected: { borderColor: "#2563EB", backgroundColor: "#F8FBFF" }, checkBox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: "#9CADC3", alignItems: "center", justifyContent: "center", marginTop: 1 }, checkBoxSelected: { backgroundColor: "#2563EB", borderColor: "#2563EB" }, groupInfo: { flex: 1, alignItems: "flex-end" }, groupName: { color: "#14213D", fontWeight: "800", fontSize: 14, textAlign: "right" }, groupMeta: { color: "#65748B", fontSize: 11, marginTop: 2, textAlign: "right" }, timeLine: { flexDirection: "row-reverse", alignItems: "center", gap: 4, marginTop: 4 }, timeText: { color: "#64748B", fontSize: 10 }, emptyText: { color: "#64748B", textAlign: "center", fontSize: 12, paddingVertical: 9 },
  selectedGroupRow: { backgroundColor: "#FFF", borderRadius: 12, padding: 9, flexDirection: "row-reverse", alignItems: "center", marginBottom: 7, gap: 8 }, removeButton: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" }, selectedGroupCopy: { flex: 1, alignItems: "flex-end" }, selectedGroupName: { color: "#16213B", fontWeight: "800", fontSize: 13 }, selectedGroupMeta: { color: "#65748B", fontSize: 10, marginTop: 2 },
  packageList: { flexDirection: "row-reverse", gap: 7 }, packageChoice: { maxWidth: 170, minHeight: 53, borderRadius: 11, borderWidth: 1, borderColor: "#D8E1EF", backgroundColor: "#FFF", paddingHorizontal: 11, paddingVertical: 7, justifyContent: "center" }, packageChoiceActive: { borderColor: "#7C3AED", backgroundColor: "#F8F5FF" }, packageChoiceText: { color: "#334155", fontWeight: "800", fontSize: 12, textAlign: "right" }, packageChoiceTextActive: { color: "#6D28D9" }, packagePrice: { color: "#708097", fontSize: 10, marginTop: 2, textAlign: "right" }, packageBody: { marginTop: 11 }, packageRule: { color: "#65748B", fontSize: 11, textAlign: "right", marginBottom: 1 }, subjectCard: { backgroundColor: "#FFF", borderRadius: 12, borderWidth: 1, borderColor: "#E0E7F1", padding: 9, marginTop: 7 }, subjectCardSelected: { borderColor: "#BFD4FF" }, subjectTop: { flexDirection: "row-reverse", gap: 8, alignItems: "center" }, subjectTitleCopy: { alignItems: "flex-end", flex: 1 }, subjectName: { color: "#17213A", fontSize: 13, fontWeight: "800" }, subjectSub: { color: "#718098", fontSize: 10, marginTop: 1 }, teacherPickerLabel: { color: "#64748B", fontSize: 10, textAlign: "right", marginTop: 8, marginBottom: 4 }, teacherChoices: { flexDirection: "row-reverse", gap: 6 }, teacherChoice: { flexDirection: "row-reverse", alignItems: "center", gap: 4, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, borderColor: "#D8E1EF", backgroundColor: "#FDFEFF" }, teacherChoiceActive: { borderColor: "#93B7FF", backgroundColor: "#EEF5FF" }, teacherChoiceText: { color: "#506079", fontSize: 11, fontWeight: "700" }, teacherChoiceTextActive: { color: "#2563EB" }, subjectSummary: { color: "#526078", fontSize: 10, textAlign: "right", marginTop: 6 }, subscriptionSummary: { backgroundColor: "#EEF4FF", borderRadius: 12, padding: 10, marginTop: 10 }, summaryHeading: { flexDirection: "row-reverse", alignItems: "center", gap: 5, marginBottom: 5 }, summaryTitle: { color: "#173C7A", fontSize: 13, fontWeight: "800" }, summaryLine: { flexDirection: "row-reverse", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#D9E6FB", paddingTop: 5, marginTop: 4 }, summaryLabel: { color: "#65748B", fontSize: 11 }, summaryValue: { color: "#233654", fontSize: 11, fontWeight: "700" }, summaryPrice: { color: "#173C7A", fontSize: 12, fontWeight: "800" },
  submitButton: { marginTop: 3, height: 52, borderRadius: 14, backgroundColor: "#2563EB" },
  cameraWrap: { overflow: "hidden", borderRadius: 14, height: 235, backgroundColor: "#0F172A" }, camera: { flex: 1 }, cameraActions: { position: "absolute", bottom: 10, left: 10, right: 10, flexDirection: "row", justifyContent: "space-between" }, cameraAction: { backgroundColor: "rgba(15,23,42,0.75)", paddingHorizontal: 12, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" }, cameraActionText: { color: "#FFF", fontSize: 12, fontWeight: "700" },
});
