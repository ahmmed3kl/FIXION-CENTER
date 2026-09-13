import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { PackageRepository } from "../../features/packages/PackageRepository";
import { SubjectRepository } from "../../features/subjects/SubjectRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { Package, PackageSubject, Subject, Teacher } from "../../shared/types";
import { PermissionService, resolveUserPermissions } from "../../core/permissions";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { Colors, Spacing, Typography } from "../../core/theme";
import { AppButton, AppCard, AppInput, EmptyState, StatusBadge } from "../../shared/components";

type OptionDraft = { subjectId: string; teacherId: string };

export default function PackagesScreen() {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.currentUser);
  const permissions = resolveUserPermissions(currentUser);
  const [packages, setPackages] = useState<Package[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [editing, setEditing] = useState<Package | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [maxSelections, setMaxSelections] = useState("1");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<OptionDraft[]>([]);

  const canView = PermissionService.hasPermission(permissions, "packages.view");
  const canCreate = PermissionService.hasPermission(permissions, "packages.create");
  const canUpdate = PermissionService.hasPermission(permissions, "packages.update");

  const load = () => {
    try {
      setPackages(PackageRepository.getPackages(true));
      setSubjects(SubjectRepository.getAll());
      setTeachers(TeacherRepository.getAll());
    } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحميل الباقات"); }
  };
  useEffect(() => { load(); }, []);

  const reset = () => { setEditing(null); setName(""); setPrice(""); setMaxSelections("1"); setDescription(""); setOptions([]); };
  const beginEdit = (pkg: Package) => {
    setEditing(pkg); setName(pkg.name); setPrice(String(pkg.price)); setMaxSelections(String(pkg.maxSelections || 1)); setDescription(pkg.description || "");
    setOptions(PackageRepository.getPackageSubjects(pkg.id).map((s) => ({ subjectId: s.subjectId, teacherId: s.defaultTeacherId })));
  };
  const addOption = () => setOptions((old) => [...old, { subjectId: subjects[0]?.id || "", teacherId: teachers[0]?.id || "" }]);
  const save = async () => {
    if (!name.trim() || !price.trim()) return Alert.alert("تنبيه", "اسم الباقة والسعر مطلوبان.");
    const max = Number(maxSelections); const amount = Number(price);
    if (!Number.isInteger(max) || max < 1 || !Number.isFinite(amount) || amount < 0) return Alert.alert("تنبيه", "أدخل سعرًا وحدًا أقصى صحيحين.");
    if (!editing && !canCreate) return Alert.alert("غير مسموح", "لا تملك صلاحية إنشاء الباقات.");
    if (editing && !canUpdate) return Alert.alert("غير مسموح", "لا تملك صلاحية تعديل الباقات.");
    if (options.length === 0 || max > options.length) return Alert.alert("تنبيه", "أضف اختيارات للباقة، ولا يتجاوز الحد الأقصى عدد الاختيارات.");
    try {
      const pkg = editing
        ? await PackageRepository.updatePackage(editing.id, { name: name.trim(), price: amount, maxSelections: max, description: description.trim() })
        : await PackageRepository.createPackage({ name: name.trim(), price: amount, maxSelections: max, description: description.trim() });
      if (editing) {
        for (const old of PackageRepository.getPackageSubjects(pkg.id)) await PackageRepository.removePackageSubject({ packageId: pkg.id, subjectId: old.subjectId });
      }
      for (const option of options) if (option.subjectId && option.teacherId) await PackageRepository.addPackageSubject({ packageId: pkg.id, subjectId: option.subjectId, defaultTeacherId: option.teacherId });
      Alert.alert("تم بنجاح", editing ? "تم تحديث الباقة." : "تم إنشاء الباقة."); reset(); load();
    } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر حفظ الباقة."); }
  };
  const toggleStatus = async (pkg: Package) => {
    try { await PackageRepository.updatePackage(pkg.id, { status: pkg.status === "active" ? "inactive" : "active" }); Alert.alert("تم بنجاح", pkg.status === "active" ? "تم تعطيل الباقة." : "تم إعادة تفعيل الباقة."); load(); }
    catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث حالة الباقة."); }
  };
  if (!canView) return <SafeAreaView style={styles.center}><Text style={styles.denied}>ليس لديك صلاحية عرض الباقات</Text></SafeAreaView>;
  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}><TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></TouchableOpacity><Text style={styles.title}>الباقات</Text></View>
      <AppCard style={styles.form}>
        <Text style={styles.section}>{editing ? "تعديل الباقة" : "إنشاء باقة جديدة"}</Text>
        <AppInput label="اسم الباقة *" value={name} onChangeText={setName} />
        <AppInput label="السعر الشهري *" value={price} onChangeText={setPrice} keyboardType="numeric" />
        <AppInput label="أقصى عدد اختيارات للطالب *" value={maxSelections} onChangeText={setMaxSelections} keyboardType="numeric" />
        <AppInput label="الوصف" value={description} onChangeText={setDescription} />
        <Text style={styles.label}>اختيارات المدرسين والمواد</Text>
        {options.map((option, i) => <View style={styles.option} key={`${i}-${option.subjectId}`}>
          <TouchableOpacity style={styles.select} onPress={() => setOptions((all) => all.map((x, n) => n === i ? { ...x, subjectId: subjects[(subjects.findIndex((s) => s.id === x.subjectId) + 1) % Math.max(subjects.length, 1)]?.id || "" } : x))}><Text>{subjects.find((s) => s.id === option.subjectId)?.name || "اختر المادة"}</Text></TouchableOpacity>
          <TouchableOpacity style={styles.select} onPress={() => setOptions((all) => all.map((x, n) => n === i ? { ...x, teacherId: teachers[(teachers.findIndex((t) => t.id === x.teacherId) + 1) % Math.max(teachers.length, 1)]?.id || "" } : x))}><Text>{teachers.find((t) => t.id === option.teacherId)?.name || "اختر المدرس"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setOptions((all) => all.filter((_, n) => n !== i))}><Text style={styles.remove}>حذف</Text></TouchableOpacity>
        </View>)}
        <AppButton title="إضافة مدرس/مادة" variant="outline" onPress={addOption} />
        <View style={styles.actions}><AppButton title="حفظ" onPress={save} style={{ flex: 1 }} /><AppButton title="مسح" variant="outline" onPress={reset} style={{ flex: 1 }} /></View>
      </AppCard>
      {packages.length === 0 ? <EmptyState message="لا توجد باقات" /> : packages.map((pkg) => <AppCard key={pkg.id} style={styles.card}>
        <View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.name}>{pkg.name}</Text><Text style={styles.meta}>{pkg.price} ج.م • يختار الطالب حتى {pkg.maxSelections || 1}</Text></View><StatusBadge text={pkg.status === "active" ? "نشطة" : "غير نشطة"} type={pkg.status === "active" ? "success" : "neutral"} /></View>
        <Text style={styles.meta}>{PackageRepository.getPackageSubjects(pkg.id).map((s) => `${s.subjectName} - ${s.defaultTeacherName}`).join("، ")}</Text>
        <View style={styles.actions}><AppButton title="تعديل" variant="outline" onPress={() => beginEdit(pkg)} style={{ flex: 1 }} /><AppButton title={pkg.status === "active" ? "تعطيل" : "إعادة تفعيل"} variant="outline" onPress={() => toggleStatus(pkg)} style={{ flex: 1 }} /></View>
      </AppCard>)}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: Colors.background }, content: { padding: Spacing.md, gap: Spacing.md }, center: { flex: 1, alignItems: "center", justifyContent: "center" }, denied: { color: Colors.danger, fontSize: 18 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, title: { ...Typography.h2, color: Colors.slate900 }, back: { color: Colors.primary, fontWeight: "700" }, form: { gap: Spacing.sm }, section: { ...Typography.h3, color: Colors.slate900 }, label: { color: Colors.slate700, fontWeight: "700", marginTop: Spacing.sm }, option: { flexDirection: "row", alignItems: "center", gap: 6 }, select: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 10, backgroundColor: Colors.white }, remove: { color: Colors.danger, fontWeight: "700" }, actions: { flexDirection: "row", gap: 8, marginTop: Spacing.sm }, card: { gap: Spacing.sm }, row: { flexDirection: "row", alignItems: "center" }, name: { ...Typography.h3, color: Colors.slate900 }, meta: { color: Colors.slate600, marginTop: 4 } });
