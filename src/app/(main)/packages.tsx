import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PackageRepository } from "../../features/packages/PackageRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../../features/teachers/TeacherSubjectRepository";
import { Group, Package, Subject, Teacher } from "../../shared/types";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import { AppButton, AppCard, AppInput, EmptyState, StatusBadge } from "../../shared/components";
import { useAuthStore } from "../../features/auth/useAuthStore";

type OptionDraft = { teacherId: string; subjectId: string; groupId: string };

export default function PackagesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(), [colors]);
  const currentUser = useAuthStore((s) => s.currentUser);
  const permissions = resolveUserPermissions(currentUser);
  const [packages, setPackages] = useState<Package[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [editing, setEditing] = useState<Package | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [maxSelections, setMaxSelections] = useState("1");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [openTeacherPicker, setOpenTeacherPicker] = useState<number | null>(null);
  const [openGroupPicker, setOpenGroupPicker] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const canView = PermissionService.hasPermission(permissions, "packages.view");
  const canCreate = PermissionService.hasPermission(permissions, "packages.create");
  const canUpdate = PermissionService.hasPermission(permissions, "packages.update");
  const subjectsForTeacher = (teacherId: string): Subject[] => { try { return TeacherSubjectRepository.getSubjectsForTeacher(teacherId); } catch { return []; } };
  const load = () => { try { setPackages(PackageRepository.getPackages(true)); setTeachers(TeacherRepository.getAll()); setGroups(GroupRepository.getAll()); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحميل الباقات"); } };
  const activeCenterId = useAuthStore((s) => s.activeCenterId);
  useEffect(() => { load(); }, [activeCenterId]);
  const reset = () => { setEditing(null); setName(""); setPrice(""); setMaxSelections("1"); setDescription(""); setOptions([]); };
  const groupsForOption = (teacherId: string, subjectId: string) => groups.filter((group) => group.teacherId === teacherId && group.subjectId === subjectId && group.status === "active");
  const beginEdit = (pkg: Package) => { setEditing(pkg); setName(pkg.name); setPrice(String(pkg.price)); setMaxSelections(String(pkg.maxSelections || 1)); setDescription(pkg.description || ""); setOptions(PackageRepository.getPackageSubjects(pkg.id).map((s) => ({ subjectId: s.subjectId, teacherId: s.defaultTeacherId, groupId: s.groupId || "" }))); };
  const addOption = () => { const t = teachers[0]; const taught = t ? subjectsForTeacher(t.id) : []; const subjectId = taught[0]?.id || ""; setOptions((old) => [...old, { teacherId: t?.id || "", subjectId, groupId: groupsForOption(t?.id || "", subjectId)[0]?.id || "" }]); };
  const chooseTeacher = (index: number, teacherId: string) => setOptions((all) => all.map((option, i) => { if (i !== index) return option; const taught = subjectsForTeacher(teacherId); const subjectId = taught[0]?.id || ""; return { teacherId, subjectId, groupId: groupsForOption(teacherId, subjectId)[0]?.id || "" }; }));
  const save = async () => {
    if (saving) return;
    const amount = Number(price); const max = Number(maxSelections);
    if (!name.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(max) || max < 1) return Alert.alert("تنبيه", "أدخل اسمًا وسعرًا وحدًا أقصى صحيحًا.");
    if (!editing && !canCreate) return Alert.alert("غير مسموح", "لا تملك صلاحية إنشاء الباقات.");
    if (editing && !canUpdate) return Alert.alert("غير مسموح", "لا تملك صلاحية تعديل الباقات.");
    const valid = options.filter((x) => x.teacherId && x.subjectId);
    if (valid.some((x) => !x.groupId)) {
      return Alert.alert("Missing group", "Choose a group for every teacher in the package.");
    }
    if (new Set(valid.map((x) => x.teacherId)).size !== valid.length) {
      return Alert.alert("Duplicate teacher", "Each teacher can be added only once to a package.");
    }
    if (!valid.length || max > valid.length) return Alert.alert("تنبيه", "أضف مدرسين، والحد الأقصى لا يتجاوز عددهم.");
    setSaving(true);
    try {
      const pkg = editing ? await PackageRepository.updatePackage(editing.id, { name: name.trim(), price: amount, maxSelections: max, description: description.trim() }) : await PackageRepository.createPackage({ name: name.trim(), price: amount, maxSelections: max, description: description.trim() });
      if (editing) for (const old of PackageRepository.getPackageSubjects(pkg.id)) await PackageRepository.removePackageSubject({ id: old.id, packageId: pkg.id, subjectId: old.subjectId, defaultTeacherId: old.defaultTeacherId });
      for (const option of valid) await PackageRepository.addPackageSubject({ packageId: pkg.id, subjectId: option.subjectId, defaultTeacherId: option.teacherId, groupId: option.groupId || undefined });
      Alert.alert("تم بنجاح", editing ? "تم تحديث الباقة." : "تم إنشاء الباقة."); reset(); load();
    } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر حفظ الباقة."); }
    finally { setSaving(false); }
  };
  const toggleStatus = async (pkg: Package) => { try { await PackageRepository.updatePackage(pkg.id, { status: pkg.status === "active" ? "inactive" : "active" }); load(); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث الحالة."); } };
  if (!canView) return <SafeAreaView style={styles.center}><Text style={styles.denied}>ليس لديك صلاحية عرض الباقات</Text></SafeAreaView>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></TouchableOpacity><Text style={styles.title}>الباقات</Text></View>
    <AppCard style={styles.form}><Text style={styles.section}>{editing ? "تعديل الباقة" : "إنشاء باقة جديدة"}</Text><AppInput label="اسم الباقة *" value={name} onChangeText={setName} /><AppInput label="السعر الشهري *" value={price} onChangeText={setPrice} keyboardType="numeric" /><AppInput label="أقصى عدد مدرسين يختارهم الطالب *" value={maxSelections} onChangeText={setMaxSelections} keyboardType="numeric" /><AppInput label="الوصف" value={description} onChangeText={setDescription} />
      <Text style={styles.label}>مدرسو الباقة والمواد التي يدرسونها</Text><Text style={styles.hint}>اختيار المدرس يحدد المادة تلقائيًا من المواد المسندة إليه.</Text>
      {options.map((option, i) => <View style={styles.optionContainer} key={`${i}-${option.teacherId}`}><View style={styles.option}><TouchableOpacity style={styles.select} onPress={() => setOpenTeacherPicker(openTeacherPicker === i ? null : i)}><Text>{teachers.find((t) => t.id === option.teacherId)?.name || "اختر المدرس"}</Text></TouchableOpacity><View style={styles.subjectDisplay}><Text>{subjectsForTeacher(option.teacherId).find((s) => s.id === option.subjectId)?.name || "لا توجد مادة مسندة"}</Text></View><TouchableOpacity onPress={() => setOptions((all) => all.filter((_, n) => n !== i))}><Text style={styles.remove}>حذف</Text></TouchableOpacity></View>{openTeacherPicker === i && <View style={styles.teacherDropdown}>{teachers.length === 0 ? <Text style={styles.hint}>لا يوجد مدرسون متاحون.</Text> : teachers.map((teacher) => <TouchableOpacity key={teacher.id} style={styles.teacherDropdownItem} onPress={() => { chooseTeacher(i, teacher.id); setOpenTeacherPicker(null); }}><Text style={styles.teacherDropdownText}>{teacher.name}</Text></TouchableOpacity>)}</View>}</View>)}
      {options.map((option, i) => <View key={`group-${i}-${option.teacherId}`} style={styles.groupPickerRow}><Text style={styles.hint}>Group for {teachers.find((t) => t.id === option.teacherId)?.name || "teacher"} / {subjectsForTeacher(option.teacherId).find((s) => s.id === option.subjectId)?.name || "subject"}</Text><TouchableOpacity style={styles.select} onPress={() => setOpenGroupPicker(openGroupPicker === i ? null : i)}><Text>{groups.find((group) => group.id === option.groupId)?.name || "Choose group"}</Text></TouchableOpacity>{openGroupPicker === i && <View style={styles.teacherDropdown}>{groupsForOption(option.teacherId, option.subjectId).length === 0 ? <Text style={styles.hint}>No groups for this teacher and subject.</Text> : groupsForOption(option.teacherId, option.subjectId).map((group) => <TouchableOpacity key={group.id} style={styles.teacherDropdownItem} onPress={() => { setOptions((all) => all.map((item, n) => n === i ? { ...item, groupId: group.id } : item)); setOpenGroupPicker(null); }}><Text style={styles.teacherDropdownText}>{group.name} · {group.grade}</Text></TouchableOpacity>)}</View>}</View>)}
      <AppButton title="إضافة مدرس" variant="outline" onPress={addOption} /><View style={styles.actions}><AppButton title="حفظ" onPress={save} style={{ flex: 1 }} /><AppButton title="مسح" variant="outline" onPress={reset} style={{ flex: 1 }} /></View>
    </AppCard>
    {packages.length === 0 ? <EmptyState message="لا توجد باقات" /> : packages.map((pkg) => <AppCard key={pkg.id} style={styles.card}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.name}>{pkg.name}</Text><Text style={styles.meta}>{pkg.price} ج.م • حد الاختيارات {pkg.maxSelections || 1}</Text></View><StatusBadge text={pkg.status === "active" ? "نشطة" : "غير نشطة"} type={pkg.status === "active" ? "success" : "neutral"} /></View><Text style={styles.meta}>{PackageRepository.getPackageSubjects(pkg.id).map((s) => `${s.defaultTeacherName} - ${s.subjectName}${s.groupName ? ` - ${s.groupName}` : ""}`).join("، ")}</Text><View style={styles.actions}><AppButton title="تعديل" variant="outline" onPress={() => beginEdit(pkg)} style={{ flex: 1 }} /><AppButton title={pkg.status === "active" ? "تعطيل" : "إعادة تفعيل"} variant="outline" onPress={() => toggleStatus(pkg)} style={{ flex: 1 }} /></View></AppCard>)}
  </ScrollView></SafeAreaView>;
}

const createStyles = () => StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl }, center: { flex: 1, alignItems: "center", justifyContent: "center" }, denied: { color: Colors.danger, fontSize: 18, textAlign: "center" }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }, title: { ...Typography.h1, color: Colors.slate900 }, back: { color: Colors.primary, fontWeight: "800", padding: 8 }, form: { gap: Spacing.sm, borderRadius: 20 }, section: { ...Typography.h3, color: Colors.slate900 }, label: { color: Colors.slate700, fontWeight: "800", marginTop: Spacing.sm, textAlign: "right" }, hint: { color: Colors.slate500, fontSize: 12, lineHeight: 18, textAlign: "right" }, optionContainer: { gap: 6, padding: 10, borderRadius: 14, backgroundColor: Colors.slate50 }, groupPickerRow: { gap: 7, padding: 10, borderRadius: 14, backgroundColor: Colors.primaryMuted }, option: { flexDirection: "row", alignItems: "center", gap: 6 }, select: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 11, padding: 12, backgroundColor: Colors.white, minHeight: 46 }, subjectDisplay: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 11, padding: 12, backgroundColor: Colors.slate50, minHeight: 46 }, teacherDropdown: { borderWidth: 1, borderColor: Colors.border, borderRadius: 11, backgroundColor: Colors.white, overflow: "hidden" }, teacherDropdownItem: { padding: 13, borderBottomWidth: 1, borderBottomColor: Colors.border }, teacherDropdownText: { color: Colors.slate800, textAlign: "right", fontWeight: "700" }, remove: { color: Colors.danger, fontWeight: "800", paddingHorizontal: 4 }, actions: { flexDirection: "row", gap: 8, marginTop: Spacing.sm }, card: { gap: Spacing.sm, borderRadius: 20 }, row: { flexDirection: "row", alignItems: "center", gap: 8 }, name: { ...Typography.h3, color: Colors.slate900 }, meta: { color: Colors.slate600, marginTop: 5, lineHeight: 19, textAlign: "right" } });
