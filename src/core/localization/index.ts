import { I18nManager } from "react-native";

// Force RTL layout for Arabic
export function initializeRTL() {
  if (!I18nManager.isRTL) {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(true);
  }
}

export const Strings = {
  appName: "FIXION",
  tagline: "نظام إدارة المراكز التعليمية",

  // Auth
  loginTitle: "تسجيل الدخول",
  loginSubtitle: "أدخل البريد الإلكتروني وكلمة المرور للوصول لحسابك",
  emailLabel: "البريد الإلكتروني",
  emailPlaceholder: "example@fixion.com",
  phoneLabel: "رقم الموبايل",
  phonePlaceholder: "01xxxxxxxxx",
  passwordLabel: "كلمة المرور",
  passwordPlaceholder: "••••••••",
  loginButton: "دخول",
  loginSubmitButton: "دخول",
  selectCenterTitle: "اختيار المركز التعليمي",
  selectCenterSubtitle: "يرجى تحديد المركز الذي ترغب في إدارته حاليًا",
  continueButton: "متابعة",
  logoutButton: "تسجيل الخروج",
  demoAccountAdmin: "دخول تجريبي (مدير)",
  demoAccountSecretary: "دخول تجريبي (سكرتير)",

  // Navigation Tabs
  tabDashboard: "الرئيسية",
  tabScanner: "مسح الكارت",
  tabStudents: "الطلاب",
  tabMore: "المزيد",

  // Dashboard
  dashboardTitle: "لوحة التحكم",
  todaySummaryTitle: "ملخص اليوم",
  expectedAttendance: "المتوقع",
  presentAttendance: "حاضر",
  absentAttendance: "غياب",
  lateAttendance: "متأخر",
  makeupAttendance: "تعويض",
  todaySessionsTitle: "حصص اليوم",
  openSessions: "مفتوحة",
  closedSessions: "مقفولة",
  todayCollectionsTitle: "تحصيل اليوم",
  currencyEGP: "جنيه",
  quickScanHeroButton: "مسح كارت الطالب",

  // Scanner
  scanCardTitle: "مسح كارت الطالب",
  scanCameraHint: "وجّه الكاميرا نحو باركود كارت الطالب",
  manualEntryTitle: "أو أدخل كود الكارت يدويًا",
  cardCodeLabel: "كود الكارت",
  cardCodePlaceholder: "مثال: 00125",
  searchCardButton: "بحث عن الكارت",
  cameraPermissionRequired: "مطلوب إذن الكاميرا لمسح الكروت",
  grantPermissionButton: "منح الإذن",

  // Student Result & Attendance Flow
  studentCardTitle: "بيانات الطالب",
  cardCodePrefix: "كود الطالب:",
  studentStatusActive: "نشط",
  studentStatusInactive: "غير نشط",
  eligibleSessionsTitle: "الحصص المؤهلة اليوم",
  selectSessionPrompt: "حدد الحصة لتسجيل الحضور:",
  singleSessionAutoSelected: "تم تحديد الحصة تلقائيًا",
  noSessionsToday: "لا توجد حصة متاحة للطالب اليوم",
  recordAttendanceButton: "تسجيل الحضور",
  recordingAttendance: "جارٍ تسجيل الحضور...",
  attendanceRecordedSuccess: "تم تسجيل الحضور بنجاح",
  attendanceTimePrefix: "وقت الحضور:",
  attendanceStatusPresent: "حاضر في الموعد",
  attendanceStatusLate: "متأخر",
  duplicateScanWarning: "تم تسجيل حضور الطالب مسبقًا لهذه الحصة اليوم",
  unregisteredCardError: "الكارت غير مسجل في هذا المركز",
  newStudentRegisterPrompt: "تسجيل طالب جديد",

  // Financial Status
  financialStatusTitle: "الموقف المالي للطالب",
  packageSubscriptionLabel: "الاشتراك الحالي:",
  totalDueLabel: "المستحق:",
  totalPaidLabel: "المدفوع:",
  remainingBalanceLabel: "المتبقي:",
  payFullButton: "دفع المبلغ المتبقي",
  payPartialButton: "دفع مبلغ جزئي",
  noPendingDebt: "لا توجد مديونية معلقة",
  quickPaymentTitle: "تسجيل دفعة سريعة",
  paymentAmountLabel: "المبلغ المدفوع (جنيه)",
  confirmPaymentButton: "تأكيد الدفع",
  paymentRecordedSuccess: "تم تسجيل الدفعة بنجاح",

  // Sync & Offline
  statusOnline: "متصل",
  statusOffline: "غير متصل (يعمل محليًا)",
  statusSyncing: "جارٍ المزامنة...",
  statusDegraded: "الشبكة متصلة والخادم غير متاح",
  pendingOperationsCount: "عملية في انتظار المزامنة",
  syncNowButton: "مزامنة الآن",
  lastSyncPrefix: "آخر مزامنة:",
  justNow: "الآن",

  tabAcademic: "الشؤون الأكاديمية",
  tabSettings: "الإعدادات",

  // Academic Core
  teachersTitle: "المعلمون",
  subjectsTitle: "المواد الدراسية",
  groupsTitle: "المجموعات",
  sessionsTitle: "الحصص والمحاضرات",
  addTeacherButton: "إضافة معلم",
  addSubjectButton: "إضافة مادة",
  addGroupButton: "إضافة مجموعة",
  generateSessionsButton: "توليد الحصص",
  issueCardButton: "إصدار بطاقة",
  replaceCardButton: "استبدال البطاقة",
  deactivateCardButton: "إلغاء البطاقة",
  enrollStudentButton: "تسجيل في مجموعة",
  endEnrollmentButton: "إنهاء الاشتراك",

  // General States & Errors
  loading: "جارٍ التحميل...",
  emptyData: "لا توجد بيانات متاحة للعرض",
  errorTitle: "حدث خطأ",
  retryButton: "إعادة المحاولة",
  closeButton: "إغلاق",
  cancelButton: "إلغاء",
  confirmButton: "تأكيد",

  // Sprint 3 Financial Core
  debtCyclesTitle: "الدورات المالية الشهرية",
  cycleNumberPrefix: "الدورة رقم",
  cycleStatusOpen: "مفتوحة",
  cycleStatusPartial: "سداد جزئي",
  cycleStatusPaid: "مسددة بالكامل",
  debtAdjustmentsTitle: "تعديلات الديون والرسوم",
  addAdjustmentButton: "تعديل الرسوم",
  adjustmentAmountLabel: "قيمة التعديل (+ للزيادة، - للخصم)",
  adjustmentReasonLabel: "سبب التعديل",
  reversePaymentButton: "إلغاء الدفعة",
  reversalReasonLabel: "سبب إلغاء الدفعة",
  confirmReversalButton: "تأكيد إلغاء الدفعة",
  sessionPaymentsTitle: "مدفوعات الحصص المنفصلة",
  monthlyDebtTitle: "المديونية الشهرية",
  sessionPaymentsNote:
    "مدفوعات الحصص منفصلة تماماً ولا تخصم من الاشتراكات الشهرية",
  reversedBadge: "ملغاة",

  // Sprint 4 Packages & Makeups
  packagesTitle: "الباقات الدراسية",
  packageLabel: "الباقة",
  packagePriceLabel: "سعر الباقة",
  packageSubjectsTitle: "مواد الباقة",
  addPackageButton: "إضافة باقة",
  addPackageSubjectButton: "إضافة مادة للباقة",
  subscribePackageButton: "اشتراك في باقة",
  cancelPackageSubscriptionButton: "إلغاء اشتراك الباقة",
  teacherOverrideButton: "تخصيص معلم بديل",
  teacherOverrideTitle: "تخصيص المعلم",
  revertTeacherOverrideButton: "استعادة المعلم الافتراضي",
  makeupAttendanceTitle: "حضور تعويضي",
  recordMakeupButton: "تسجيل حضور تعويضي",
  nextEligibleSessionLabel: "الحصة التعويضية التالية:",
  noEligibleMakeupSession: "لا توجد حصة تعويضية مؤهلة حالياً",
  advanceCoverageTitle: "تغطية حضور مسبقة",
  recordAdvanceCoverageButton: "تسجيل حضور مسبق",
  externalAttendanceTitle: "حضور خارجي",
  recordExternalAttendanceButton: "تسجيل كحضور خارجي (دفع نقدي)",
  isExternalBadge: "خارجي",
  isMakeupBadge: "تعويضي",
  groupMonthlyDebtLabel: "مديونية المجموعات الشهرية:",
  packageMonthlyDebtLabel: "مديونية الباقات الشهرية:",
};

export function formatCurrency(amount: number): string {
  return `${amount.toLocaleString("ar-EG")} ${Strings.currencyEGP}`;
}

export function formatNumber(num: number): string {
  return num.toLocaleString("ar-EG");
}

export function formatTimeArabic(timeStr: string): string {
  if (!timeStr) return "";
  const parts = timeStr.split(":");
  if (parts.length >= 2) {
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const period = hours >= 12 ? "م" : "ص";
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${period}`;
  }
  return timeStr;
}
