import { Ionicons } from "@expo/vector-icons";
import { AuditLog, User } from "../../shared/types";

type ActivityTone = "primary" | "success" | "warning" | "danger" | "neutral";

export interface StudentActivityPresentation {
  title: string;
  description?: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone: ActivityTone;
  actorName: string;
}

const activityTypes: Record<
  string,
  Pick<StudentActivityPresentation, "title" | "icon" | "tone">
> = {
  "student.create": { title: "تمت إضافة الطالب", icon: "person-add-outline", tone: "success" },
  "student.update": { title: "تعديل بيانات الطالب", icon: "create-outline", tone: "primary" },
  "student.color.update": { title: "تعديل لون بطاقة الطالب", icon: "color-palette-outline", tone: "primary" },
  "student.color.reset": { title: "إعادة لون بطاقة الطالب للوضع الافتراضي", icon: "color-palette-outline", tone: "neutral" },
  "student.card_code.updated": { title: "تحديث كود بطاقة الطالب", icon: "card-outline", tone: "primary" },
  "student.card_reused": { title: "إعادة استخدام بطاقة طالب", icon: "card-outline", tone: "warning" },
  "student.card_reused.release": { title: "تحرير بطاقة طالب", icon: "card-outline", tone: "neutral" },
  "student.delete": { title: "أرشفة الطالب", icon: "archive-outline", tone: "danger" },
  "student.deactivate": { title: "إيقاف الطالب", icon: "pause-circle-outline", tone: "warning" },
  "student.restore": { title: "استعادة الطالب", icon: "refresh-circle-outline", tone: "success" },
  "student.note.create": { title: "إضافة ملاحظة للطالب", icon: "document-text-outline", tone: "primary" },
  "student.note.update": { title: "تعديل ملاحظة الطالب", icon: "create-outline", tone: "primary" },
  "student.note.delete": { title: "حذف ملاحظة الطالب", icon: "trash-outline", tone: "danger" },
  "student_card.issue": { title: "إصدار بطاقة طالب", icon: "card-outline", tone: "success" },
  "student_card.deactivate": { title: "إيقاف بطاقة طالب", icon: "card-outline", tone: "warning" },
  "student_card.reactivate": { title: "إعادة تفعيل بطاقة طالب", icon: "card-outline", tone: "success" },
  "attendance.record": { title: "تسجيل الحضور", icon: "checkmark-circle-outline", tone: "success" },
  "attendance.makeup": { title: "تسجيل حضور تعويض", icon: "repeat-outline", tone: "primary" },
  "attendance.cancel": { title: "إلغاء تسجيل الحضور", icon: "close-circle-outline", tone: "warning" },
  "absence.note.upsert": { title: "إضافة أو تحديث ملاحظة غياب", icon: "document-text-outline", tone: "warning" },
  "payment.record": { title: "تسجيل دفعة", icon: "wallet-outline", tone: "success" },
  "payment.create": { title: "تسجيل دفعة", icon: "wallet-outline", tone: "success" },
  "payment.create_external_session": { title: "تحصيل رسوم حصة", icon: "cash-outline", tone: "success" },
  "payment.reverse": { title: "عكس دفعة", icon: "return-down-back-outline", tone: "warning" },
  "payment.delete": { title: "حذف دفعة", icon: "trash-outline", tone: "danger" },
  "grade.score.save": { title: "حفظ الدرجة", icon: "school-outline", tone: "primary" },
  "grade.exam.create": { title: "إضافة اختبار", icon: "document-text-outline", tone: "primary" },
  "enrollment.create": { title: "تسجيل الطالب في مجموعة", icon: "people-outline", tone: "success" },
  "enrollment.end": { title: "إنهاء اشتراك المجموعة", icon: "exit-outline", tone: "warning" },
  "enrollment.transfer": { title: "نقل الطالب إلى مجموعة أخرى", icon: "swap-horizontal-outline", tone: "primary" },
  "enrollment.transfer_end": { title: "إنهاء الاشتراك السابق", icon: "exit-outline", tone: "warning" },
  "debt_cycle.cancel_on_enrollment_end": { title: "إنهاء دورة مديونية", icon: "calendar-outline", tone: "warning" },
  "debt_cycle.opening_balance": { title: "تسجيل رصيد افتتاحي", icon: "wallet-outline", tone: "primary" },
  "debt_cycle.generate": { title: "إنشاء دورة مديونية", icon: "calendar-outline", tone: "neutral" },
  "debt_cycle.status_update": { title: "تحديث حالة الالتزام المالي", icon: "wallet-outline", tone: "neutral" },
  "debt_cycle.billing_mode_set": { title: "تحديث طريقة احتساب الرسوم", icon: "settings-outline", tone: "neutral" },
  "debt_adjustment.create": { title: "تعديل رسوم الطالب", icon: "pricetag-outline", tone: "warning" },
  "advance_coverage.create": { title: "إضافة تغطية من رصيد مقدم", icon: "wallet-outline", tone: "primary" },
  "package_subscription.create": { title: "الاشتراك في باقة", icon: "albums-outline", tone: "success" },
  "package_subscription.cancel": { title: "إلغاء اشتراك الباقة", icon: "albums-outline", tone: "warning" },
  "package_override.set": { title: "تعديل اختيار ضمن الباقة", icon: "options-outline", tone: "primary" },
  "package_override.remove": { title: "إزالة اختيار من الباقة", icon: "options-outline", tone: "warning" },
  "package.create": { title: "إضافة باقة", icon: "albums-outline", tone: "primary" },
  "package.update": { title: "تعديل باقة", icon: "create-outline", tone: "primary" },
  "package_subject.add": { title: "إضافة مادة إلى باقة", icon: "book-outline", tone: "primary" },
  "package_subject.remove": { title: "إزالة مادة من باقة", icon: "book-outline", tone: "warning" },
  "group.create": { title: "إضافة مجموعة", icon: "people-outline", tone: "primary" },
  "group.update": { title: "تعديل مجموعة", icon: "create-outline", tone: "primary" },
  "group.deactivate": { title: "إيقاف مجموعة", icon: "pause-circle-outline", tone: "warning" },
  "group.reactivate": { title: "إعادة تفعيل مجموعة", icon: "refresh-circle-outline", tone: "success" },
  "group.delete": { title: "حذف مجموعة", icon: "trash-outline", tone: "danger" },
  "group_schedule.create": { title: "إضافة موعد للمجموعة", icon: "calendar-outline", tone: "primary" },
  "group_schedule.deactivate": { title: "إيقاف موعد المجموعة", icon: "calendar-outline", tone: "warning" },
  "group_schedule.reactivate": { title: "إعادة تفعيل موعد المجموعة", icon: "calendar-outline", tone: "success" },
  "session.attendance_start": { title: "بدء تسجيل الحضور", icon: "checkmark-circle-outline", tone: "primary" },
  "session.activated": { title: "تفعيل الجلسة", icon: "play-circle-outline", tone: "success" },
  "session.roster.add": { title: "إضافة طالب إلى قائمة الجلسة", icon: "person-add-outline", tone: "primary" },
  "session.generate": { title: "إنشاء جلسة", icon: "calendar-outline", tone: "primary" },
  "session.cancel": { title: "إلغاء جلسة", icon: "close-circle-outline", tone: "warning" },
  session_closed: { title: "إغلاق الجلسة", icon: "lock-closed-outline", tone: "neutral" },
  session_reopened: { title: "إعادة فتح الجلسة", icon: "lock-open-outline", tone: "warning" },
  daily_closing_closed: { title: "إغلاق اليوم المالي", icon: "calculator-outline", tone: "neutral" },
  daily_closing_reclosed: { title: "إعادة إغلاق اليوم المالي", icon: "calculator-outline", tone: "warning" },
  daily_closing_reopened: { title: "إعادة فتح اليوم المالي", icon: "refresh-outline", tone: "warning" },
  "subject.create": { title: "إضافة مادة", icon: "book-outline", tone: "primary" },
  "subject.update": { title: "تعديل مادة", icon: "create-outline", tone: "primary" },
  "subject.deactivate": { title: "إيقاف مادة", icon: "pause-circle-outline", tone: "warning" },
  "subject.reactivate": { title: "إعادة تفعيل مادة", icon: "refresh-circle-outline", tone: "success" },
  "subject.delete": { title: "حذف مادة", icon: "trash-outline", tone: "danger" },
  "teacher.create": { title: "إضافة مدرس", icon: "person-add-outline", tone: "primary" },
  "teacher.update": { title: "تعديل بيانات المدرس", icon: "create-outline", tone: "primary" },
  "teacher.week_start_day.update": { title: "تعديل يوم بداية أسبوع المدرس", icon: "calendar-outline", tone: "neutral" },
  "teacher.deactivate": { title: "إيقاف المدرس", icon: "pause-circle-outline", tone: "warning" },
  "teacher.reactivate": { title: "إعادة تفعيل المدرس", icon: "refresh-circle-outline", tone: "success" },
  "teacher.delete": { title: "حذف المدرس", icon: "trash-outline", tone: "danger" },
  "teacher_subject.assign": { title: "ربط مادة بمدرس", icon: "link-outline", tone: "primary" },
  "teacher_subject.remove": { title: "إزالة مادة من مدرس", icon: "unlink-outline", tone: "warning" },
  "homework_evaluation_status.create": { title: "إضافة حالة تقييم واجب", icon: "document-text-outline", tone: "primary" },
  "homework_evaluation_status.update": { title: "تعديل حالة تقييم واجب", icon: "create-outline", tone: "primary" },
  "homework_evaluation_status.delete": { title: "حذف حالة تقييم واجب", icon: "trash-outline", tone: "danger" },
  "academic_stages.update": { title: "تحديث المراحل الدراسية", icon: "school-outline", tone: "neutral" },
  notification_created: { title: "إرسال إشعار", icon: "notifications-outline", tone: "primary" },
  template_updated: { title: "تحديث قالب إشعار", icon: "document-text-outline", tone: "neutral" },
  "user.login": { title: "تسجيل الدخول", icon: "log-in-outline", tone: "neutral" },
  "center.switch": { title: "تغيير المركز النشط", icon: "swap-horizontal-outline", tone: "neutral" },
};

function getDescription(action: string, payload: Record<string, unknown>): string | undefined {
  const value = (key: string) => {
    const candidate = payload[key];
    return typeof candidate === "string" || typeof candidate === "number"
      ? String(candidate).trim()
      : "";
  };
  switch (action) {
    case "student.create":
      return value("fullName") ? `الاسم: ${value("fullName")}` : undefined;
    case "student.update": {
      return "تم حفظ تعديلات بيانات الطالب.";
    }
    case "student.color.update":
      return value("colorName") ? `اللون: ${value("colorName")}` : undefined;
    case "student.color.reset":
      return undefined;
    case "absence.note.upsert":
      return value("text") ? value("text") : "تم حفظ ملاحظة الغياب.";
    case "grade.score.save":
      return value("score") ? `الدرجة: ${value("score")}` : undefined;
    case "payment.record":
    case "payment.create":
    case "payment.create_external_session":
      return value("amount") ? `المبلغ: ${value("amount")} جنيه` : undefined;
    case "attendance.record":
      if (payload.isLate === true || value("status") === "late") return "حضور متأخر";
      return payload.attendanceType === "makeup" ? "حضور تعويض" : "تم تسجيل الحضور.";
    case "student.note.create":
    case "student.note.update":
      return value("text") || undefined;
    case "enrollment.create":
      return value("groupName") ? `المجموعة: ${value("groupName")}` : undefined;
    default:
      return undefined;
  }
}

export function getStudentActivityPresentation(
  log: AuditLog,
  currentUser?: Pick<User, "id" | "fullName"> | null,
): StudentActivityPresentation {
  let payload: Record<string, unknown> = {};
  if (log.payload) {
    try {
      const parsed: unknown = JSON.parse(log.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
  }

  const type = activityTypes[log.action] || {
    title: "نشاط على ملف الطالب",
    icon: "time-outline" as const,
    tone: "neutral" as const,
  };
  const payloadActor = typeof payload.actorName === "string" ? payload.actorName.trim() : "";
  const actorName = payloadActor ||
    (currentUser?.id === log.userId ? currentUser.fullName : "") ||
    "مستخدم غير معروف";

  return {
    ...type,
    description: getDescription(log.action, payload),
    actorName,
  };
}
