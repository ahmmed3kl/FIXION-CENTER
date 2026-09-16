import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PackageRepository } from "../../features/packages/PackageRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../../features/teachers/TeacherSubjectRepository";
import { Package, Subject, Teacher } from "../../shared/types";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { Colors, Spacing, Typography } from "../../core/theme";
import { AppButton, AppCard, AppInput, EmptyState, StatusBadge } from "../../shared/components";
import { useAuthStore } from "../../features/auth/useAuthStore";

type OptionDraft = { teacherId: string; subjectId: string };

export default function PackagesScreen() {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.currentUser);
  const permissions = resolveUserPermissions(currentUser);
  const [packages, setPackages] = useState<Package[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [editing, setEditing] = useState<Package | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [maxSelections, setMaxSelections] = useState("1");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [openTeacherPicker, setOpenTeacherPicker] = useState<number | null>(null);
  const canView = PermissionService.hasPermission(permissions, "packages.view");
  const canCreate = PermissionService.hasPermission(permissions, "packages.create");
  const canUpdate = PermissionService.hasPermission(permissions, "packages.update");
  const subjectsForTeacher = (teacherId: string): Subject[] => { try { return TeacherSubjectRepository.getSubjectsForTeacher(teacherId); } catch { return []; } };
  const load = () => { try { setPackages(PackageRepository.getPackages(true)); setTeachers(TeacherRepository.getAll()); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحميل الباقات"); } };
  const activeCenterId = useAuthStore((s) => s.activeCenterId);
  useEffect(() => { load(); }, [activeCenterId]);
  const reset = () => { setEditing(null); setName(""); setPrice(""); setMaxSelections("1"); setDescription(""); setOptions([]); };
  const beginEdit = (pkg: Package) => { setEditing(pkg); setName(pkg.name); setPrice(String(pkg.price)); setMaxSelections(String(pkg.maxSelections || 1)); setDescription(pkg.description || ""); setOptions(PackageRepository.getPackageSubjects(pkg.id).map((s) => ({ subjectId: s.subjectId, teacherId: s.defaultTeacherId }))); };
  const addOption = () => { const t = teachers[0]; const taught = t ? subjectsForTeacher(t.id) : []; setOptions((old) => [...old, { teacherId: t?.id || "", subjectId: taught[0]?.id || "" }]); };
  const chooseTeacher = (index: number, teacherId: string) => setOptions((all) => all.map((option, i) => { if (i !== index) return option; const taught = subjectsForTeacher(teacherId); return { teacherId, subjectId: taught[0]?.id || "" }; }));
  const save = async () => {
    const amount = Number(price); const max = Number(maxSelections);
    if (!name.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(max) || max < 1) return Alert.alert("تنبيه", "أدخل اسمًا وسعرًا وحدًا أقصى صحيحًا.");
    if (!editing && !canCreate) return Alert.alert("غير مسموح", "لا تملك صلاحية إنشاء الباقات.");
    if (editing && !canUpdate) return Alert.alert("غير مسموح", "لا تملك صلاحية تعديل الباقات.");
    const valid = options.filter((x) => x.teacherId && x.subjectId);
    if (!valid.length || max > valid.length) return Alert.alert("تنبيه", "أضف مدرسين، والحد الأقصى لا يتجاوز عددهم.");
    try {
      const pkg = editing ? await PackageRepository.updatePackage(editing.id, { name: name.trim(), price: amount, maxSelections: max, description: description.trim() }) : await PackageRepository.createPackage({ name: name.trim(), price: amount, maxSelections: max, description: description.trim() });
      if (editing) for (const old of PackageRepository.getPackageSubjects(pkg.id)) await PackageRepository.removePackageSubject({ packageId: pkg.id, subjectId: old.subjectId });
      for (const option of valid) await PackageRepository.addPackageSubject({ packageId: pkg.id, subjectId: option.subjectId, defaultTeacherId: option.teacherId });
      Alert.alert("تم بنجاح", editing ? "تم تحديث الباقة." : "تم إنشاء الباقة."); reset(); load();
    } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر حفظ الباقة."); }
  };
  const toggleStatus = async (pkg: Package) => { try { await PackageRepository.updatePackage(pkg.id, { status: pkg.status === "active" ? "inactive" : "active" }); load(); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث الحالة."); } };
  if (!canView) return <SafeAreaView style={styles.center}><Text style={styles.denied}>ليس لديك صلاحية عرض الباقات</Text></SafeAreaView>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></TouchableOpacity><Text style={styles.title}>الباقات</Text></View>
    <AppCard style={styles.form}><Text style={styles.section}>{editing ? "تعديل الباقة" : "إنشاء باقة جديدة"}</Text><AppInput label="اسم الباقة *" value={name} onChangeText={setName} /><AppInput label="السعر الشهري *" value={price} onChangeText={setPrice} keyboardType="numeric" /><AppInput label="أقصى عدد مدرسين يختارهم الطالب *" value={maxSelections} onChangeText={setMaxSelections} keyboardType="numeric" /><AppInput label="الوصف" value={description} onChangeText={setDescription} />
      <Text style={styles.label}>مدرسو الباقة والمواد التي يدرسونها</Text><Text style={styles.hint}>اختيار المدرس يحدد المادة تلقائيًا من المواد المسندة إليه.</Text>
      {options.map((option, i) => <View style={styles.optionContainer} key={`${i}-${option.teacherId}`}><View style={styles.option}><TouchableOpacity style={styles.select} onPress={() => setOpenTeacherPicker(openTeacherPicker === i ? null : i)}><Text>{teachers.find((t) => t.id === option.teacherId)?.name || "اختر المدرس"}</Text></TouchableOpacity><View style={styles.subjectDisplay}><Text>{subjectsForTeacher(option.teacherId).find((s) => s.id === option.subjectId)?.name || "لا توجد مادة مسندة"}</Text></View><TouchableOpacity onPress={() => setOptions((all) => all.filter((_, n) => n !== i))}><Text style={styles.remove}>حذف</Text></TouchableOpacity></View>{openTeacherPicker === i && <View style={styles.teacherDropdown}>{teachers.length === 0 ? <Text style={styles.hint}>لا يوجد مدرسون متاحون.</Text> : teachers.map((teacher) => <TouchableOpacity key={teacher.id} style={styles.teacherDropdownItem} onPress={() => { chooseTeacher(i, teacher.id); setOpenTeacherPicker(null); }}><Text style={styles.teacherDropdownText}>{teacher.name}</Text></TouchableOpacity>)}</View>}</View>)}
      <AppButton title="إضافة مدرس" variant="outline" onPress={addOption} /><View style={styles.actions}><AppButton title="حفظ" onPress={save} style={{ flex: 1 }} /><AppButton title="مسح" variant="outline" onPress={reset} style={{ flex: 1 }} /></View>
    </AppCard>
    {packages.length === 0 ? <EmptyState message="لا توجد باقات" /> : packages.map((pkg) => <AppCard key={pkg.id} style={styles.card}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.name}>{pkg.name}</Text><Text style={styles.meta}>{pkg.price} ج.م • حد الاختيارات {pkg.maxSelections || 1}</Text></View><StatusBadge text={pkg.status === "active" ? "نشطة" : "غير نشطة"} type={pkg.status === "active" ? "success" : "neutral"} /></View><Text style={styles.meta}>{PackageRepository.getPackageSubjects(pkg.id).map((s) => `${s.defaultTeacherName} - ${s.subjectName}`).join("، ")}</Text><View style={styles.actions}><AppButton title="تعديل" variant="outline" onPress={() => beginEdit(pkg)} style={{ flex: 1 }} /><AppButton title={pkg.status === "active" ? "تعطيل" : "إعادة تفعيل"} variant="outline" onPress={() => toggleStatus(pkg)} style={{ flex: 1 }} /></View></AppCard>)}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.md, gap: Spacing.md }, center: { flex: 1, alignItems: "center", justifyContent: "center" }, denied: { color: Colors.danger, fontSize: 18 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, title: { ...Typography.h2, color: Colors.slate900 }, back: { color: Colors.primary, fontWeight: "700" }, form: { gap: Spacing.sm }, section: { ...Typography.h3, color: Colors.slate900 }, label: { color: Colors.slate700, fontWeight: "700", marginTop: Spacing.sm }, hint: { color: Colors.slate500, fontSize: 12 }, optionContainer: { gap: 4 }, option: { flexDirection: "row", alignItems: "center", gap: 6 }, select: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 10, backgroundColor: Colors.white }, subjectDisplay: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 10, backgroundColor: Colors.slate50 }, teacherDropdown: { borderWidth: 1, borderColor: Colors.border, borderRadius: 8, backgroundColor: Colors.white, overflow: "hidden" }, teacherDropdownItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: Colors.border }, teacherDropdownText: { color: Colors.slate800, textAlign: "right" }, remove: { color: Colors.danger, fontWeight: "700" }, actions: { flexDirection: "row", gap: 8, marginTop: Spacing.sm }, card: { gap: Spacing.sm }, row: { flexDirection: "row", alignItems: "center" }, name: { ...Typography.h3, color: Colors.slate900 }, meta: { color: Colors.slate600, marginTop: 4 } });
