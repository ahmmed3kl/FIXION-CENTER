import { Permission, RolePermissions } from "../../core/permissions";

export interface PermissionDescription {
  key: Permission;
  name: string;
  effect: string;
}

export interface PermissionGroup {
  id: string;
  title: string;
  permissions: PermissionDescription[];
}

const permissionDetails: Record<Permission, Omit<PermissionDescription, "key">> = {
  "dashboard.view": { name: "عرض لوحة التحكم", effect: "فتح الصفحة الرئيسية ومؤشرات السنتر." },
  "students.view": { name: "عرض الطلاب", effect: "مشاهدة قائمة الطلاب وبياناتهم." },
  "students.create": { name: "إضافة الطلاب", effect: "إنشاء ملفات طلاب جديدة." },
  "students.edit": { name: "تعديل بيانات الطلاب", effect: "تعديل بيانات الطالب الأساسية." },
  "students.update": { name: "تحديث بيانات الطلاب", effect: "حفظ التغييرات على ملفات الطلاب." },
  "students.deactivate": { name: "تعطيل الطلاب", effect: "إيقاف حساب الطالب دون حذفه." },
  "students.delete": { name: "حذف الطلاب", effect: "حذف ملفات الطلاب نهائياً." },
  "students.restore": { name: "استعادة الطلاب", effect: "إرجاع ملفات الطلاب المحذوفة." },
  "students.profile.view": { name: "عرض ملف الطالب", effect: "فتح التفاصيل الكاملة لملف الطالب." },
  "students.cards.manage": { name: "إدارة بطاقات الطلاب", effect: "إصدار بطاقات الطلاب وتعديلها." },
  "teachers.view": { name: "عرض المدرسين", effect: "مشاهدة قائمة المدرسين وبياناتهم." },
  "teachers.create": { name: "إضافة المدرسين", effect: "إنشاء ملفات مدرسين جديدة." },
  "teachers.update": { name: "تعديل المدرسين", effect: "تعديل بيانات المدرسين." },
  "teachers.deactivate": { name: "تعطيل المدرسين", effect: "إيقاف مدرس دون حذف سجله." },
  "subjects.view": { name: "عرض المواد", effect: "مشاهدة المواد المسجلة في السنتر." },
  "subjects.create": { name: "إضافة المواد", effect: "إضافة مادة جديدة للسنتر." },
  "subjects.update": { name: "تعديل المواد", effect: "تعديل بيانات المواد." },
  "subjects.deactivate": { name: "تعطيل المواد", effect: "إيقاف مادة دون حذف سجلها." },
  "subjects.teachers.manage": { name: "ربط المدرسين بالمواد", effect: "تعيين المدرسين للمواد أو إلغاء ربطهم." },
  "groups.view": { name: "عرض المجموعات", effect: "مشاهدة مجموعات السنتر." },
  "groups.create": { name: "إضافة المجموعات", effect: "إنشاء مجموعة دراسية جديدة." },
  "groups.update": { name: "تعديل المجموعات", effect: "تعديل بيانات المجموعة." },
  "groups.deactivate": { name: "تعطيل المجموعات", effect: "إيقاف مجموعة دون حذف سجلها." },
  "groups.schedule.manage": { name: "إدارة مواعيد المجموعات", effect: "إضافة مواعيد المجموعة أو تعديلها." },
  "groups.students.view": { name: "عرض طلاب المجموعات", effect: "مشاهدة الطلاب المسجلين في المجموعة." },
  "grades.view": { name: "عرض الدرجات", effect: "مشاهدة درجات الطلاب." },
  "grades.manage": { name: "إدارة الدرجات", effect: "إدخال الدرجات وتعديلها." },
  "homework.manage": { name: "إدارة الواجبات", effect: "تسجيل تقييمات الواجبات وتعديلها." },
  "enrollments.view": { name: "عرض التسجيلات", effect: "مشاهدة تسجيلات الطلاب في المجموعات." },
  "enrollments.create": { name: "إضافة التسجيلات", effect: "تسجيل طالب في مجموعة." },
  "enrollments.update": { name: "تعديل التسجيلات", effect: "تعديل بيانات تسجيل الطالب." },
  "enrollments.end": { name: "إنهاء التسجيلات", effect: "إنهاء تسجيل طالب في مجموعة." },
  "sessions.view": { name: "عرض الجلسات", effect: "مشاهدة الجلسات ومواعيدها." },
  "sessions.generate": { name: "إنشاء الجلسات", effect: "إنشاء جلسات للمجموعات." },
  "sessions.update": { name: "تعديل الجلسات", effect: "تعديل تفاصيل الجلسات." },
  "sessions.cancel": { name: "إلغاء الجلسات", effect: "إلغاء جلسة مجدولة." },
  "sessions.close": { name: "إغلاق الجلسات", effect: "إنهاء الجلسة وتثبيت حالتها." },
  "sessions.reopen": { name: "إعادة فتح الجلسات", effect: "إعادة فتح جلسة مغلقة." },
  "attendance.view": { name: "عرض الحضور", effect: "مشاهدة سجلات حضور الطلاب." },
  "attendance.create": { name: "تسجيل الحضور", effect: "تسجيل الحضور والغياب للجلسات." },
  "attendance.edit": { name: "تعديل الحضور", effect: "تعديل سجلات الحضور المسجلة." },
  "attendance.close": { name: "إغلاق الحضور", effect: "إقفال تسجيل الحضور للجلسة." },
  "attendance.makeup": { name: "تسجيل الحضور التعويضي", effect: "تسجيل حضور حصة تعويضية." },
  "attendance.external": { name: "تسجيل الحضور الاستثنائي", effect: "تسجيل حضور خارج الجلسات المعتادة." },
  "packages.view": { name: "عرض الباقات", effect: "مشاهدة باقات السنتر." },
  "packages.create": { name: "إضافة الباقات", effect: "إنشاء باقة جديدة." },
  "packages.update": { name: "تعديل الباقات", effect: "تعديل بيانات الباقات." },
  "packages.manage": { name: "إدارة الباقات", effect: "إدارة إعدادات الباقات." },
  "packages.subscribe": { name: "تسجيل اشتراكات الباقات", effect: "تسجيل اشتراك طالب في باقة." },
  "payments.view": { name: "عرض المدفوعات", effect: "مشاهدة سجلات المدفوعات." },
  "payments.create": { name: "تسجيل المدفوعات", effect: "تسجيل دفعة جديدة للطالب." },
  "payments.edit": { name: "تعديل المدفوعات", effect: "تعديل بيانات دفعة مسجلة." },
  "payments.reverse": { name: "عكس المدفوعات", effect: "إلغاء أثر دفعة مسجلة." },
  "payments.adjust": { name: "تعديل المديونية", effect: "إجراء تسوية على مديونية الطالب." },
  "payments.debt.view": { name: "عرض المديونية", effect: "مشاهدة أرصدة ومديونيات الطلاب." },
  "reports.view": { name: "عرض التقارير", effect: "فتح التقارير العامة للسنتر." },
  "reports.attendance.view": { name: "عرض تقارير الحضور", effect: "مشاهدة إحصاءات وتقارير الحضور." },
  "reports.financial.view": { name: "عرض التقارير المالية", effect: "مشاهدة الإيرادات والتقارير المالية." },
  "notifications.view": { name: "عرض الإشعارات", effect: "مشاهدة الإشعارات الواردة." },
  "notifications.send": { name: "إرسال الإشعارات", effect: "إرسال إشعارات للمستخدمين." },
  "notifications.templates.view": { name: "عرض قوالب الإشعارات", effect: "مشاهدة القوالب الجاهزة للإرسال." },
  "notifications.templates.update": { name: "تعديل قوالب الإشعارات", effect: "تعديل نصوص القوالب الجاهزة." },
  "notifications.templates.manage": { name: "إدارة قوالب الإشعارات", effect: "إضافة القوالب وتنظيمها." },
  "center.settings.view": { name: "عرض إعدادات السنتر", effect: "مشاهدة إعدادات المركز." },
  "center.settings.manage": { name: "إدارة إعدادات السنتر", effect: "تغيير إعدادات المركز." },
  "devices.view": { name: "عرض الأجهزة", effect: "مشاهدة الأجهزة المرتبطة بالسنتر." },
  "sync.view": { name: "عرض حالة المزامنة", effect: "مشاهدة معلومات مزامنة البيانات." },
  "sync.manage": { name: "إدارة المزامنة", effect: "التحكم بإجراءات مزامنة البيانات." },
  "settings.view": { name: "عرض الإعدادات", effect: "فتح إعدادات التطبيق المتاحة للحساب." },
  "audit.view": { name: "عرض سجل النشاط", effect: "مشاهدة سجل التغييرات والعمليات." },
  "users.view": { name: "عرض الحسابات", effect: "مشاهدة حسابات مستخدمي السنتر." },
  "users.manage": { name: "إدارة الحسابات", effect: "إضافة الحسابات وتعديلها وتغيير حالتها." },
  "daily_closing.view": { name: "عرض الإغلاق اليومي", effect: "مشاهدة ملخص الإغلاق اليومي." },
  "daily_closing.close": { name: "تنفيذ الإغلاق اليومي", effect: "إقفال حسابات اليوم." },
  "daily_closing.reopen": { name: "إعادة فتح الإغلاق اليومي", effect: "إعادة فتح يوم تم إقفاله." },
};

const definitions: Array<{ id: string; title: string; keys: Permission[] }> = [
  { id: "overview", title: "الرئيسية", keys: ["dashboard.view"] },
  { id: "students", title: "الطلاب", keys: ["students.view", "students.create", "students.edit", "students.update", "students.deactivate", "students.delete", "students.restore", "students.profile.view", "students.cards.manage"] },
  { id: "teachers", title: "المدرسون", keys: ["teachers.view", "teachers.create", "teachers.update", "teachers.deactivate"] },
  { id: "subjects", title: "المواد", keys: ["subjects.view", "subjects.create", "subjects.update", "subjects.deactivate", "subjects.teachers.manage"] },
  { id: "groups", title: "المجموعات والتسجيلات", keys: ["groups.view", "groups.create", "groups.update", "groups.deactivate", "groups.students.view", "groups.schedule.manage", "enrollments.view", "enrollments.create", "enrollments.update", "enrollments.end"] },
  { id: "learning", title: "الدرجات والواجبات", keys: ["grades.view", "grades.manage", "homework.manage"] },
  { id: "attendance", title: "الجلسات والحضور", keys: ["sessions.view", "sessions.generate", "sessions.update", "sessions.cancel", "sessions.close", "sessions.reopen", "attendance.view", "attendance.create", "attendance.edit", "attendance.close", "attendance.makeup", "attendance.external"] },
  { id: "packages", title: "الباقات والاشتراكات", keys: ["packages.view", "packages.create", "packages.update", "packages.manage", "packages.subscribe"] },
  { id: "payments", title: "المدفوعات والمالية", keys: ["payments.view", "payments.create", "payments.edit", "payments.debt.view", "payments.reverse", "payments.adjust", "reports.financial.view", "daily_closing.view", "daily_closing.close", "daily_closing.reopen"] },
  { id: "reports", title: "التقارير", keys: ["reports.view", "reports.attendance.view"] },
  { id: "notifications", title: "الإشعارات", keys: ["notifications.view", "notifications.send", "notifications.templates.view", "notifications.templates.update", "notifications.templates.manage"] },
  { id: "administration", title: "إدارة السنتر والحسابات", keys: ["center.settings.view", "center.settings.manage", "devices.view", "sync.view", "sync.manage", "settings.view", "audit.view", "users.view", "users.manage"] },
];

export const permissionGroups: PermissionGroup[] = definitions.map((group) => ({
  id: group.id,
  title: group.title,
  permissions: group.keys.map((key) => ({ key, ...permissionDetails[key] })),
}));

export const editablePermissions = RolePermissions.admin;

export const sensitivePermissions = new Set<Permission>([
  "students.delete",
  "payments.reverse",
  "payments.adjust",
  "sessions.reopen",
  "attendance.close",
  "daily_closing.reopen",
  "center.settings.manage",
  "sync.manage",
  "users.manage",
  "notifications.templates.manage",
]);

export function updateGroupPermissions(
  selected: readonly Permission[],
  groupPermissions: readonly Permission[],
  enabled: boolean,
  managerPermissions: readonly Permission[],
): Permission[] {
  const next = new Set(selected);
  for (const permission of groupPermissions) {
    if (
      sensitivePermissions.has(permission) ||
      !managerPermissions.includes(permission)
    ) continue;
    if (enabled) next.add(permission);
    else next.delete(permission);
  }
  return Array.from(next);
}

export function updateIndividualPermission(
  selected: readonly Permission[],
  permission: Permission,
  enabled: boolean,
  managerPermissions: readonly Permission[],
): Permission[] {
  const next = new Set(selected);
  if (enabled && !managerPermissions.includes(permission)) return Array.from(next);
  if (enabled) next.add(permission);
  else next.delete(permission);
  return Array.from(next);
}

export function keepManagerGrantablePermissions(
  selected: readonly Permission[],
  managerPermissions: readonly Permission[],
): Permission[] {
  return selected.filter((permission) => managerPermissions.includes(permission));
}
