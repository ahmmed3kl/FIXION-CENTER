export type UserRole = "admin" | "manager" | "secretary" | "accountant";

export type Permission =
  | "dashboard.view"
  | "students.view"
  | "students.create"
  | "students.edit"
  | "students.update"
  | "students.deactivate"
  | "students.cards.manage"
  | "teachers.view"
  | "teachers.create"
  | "teachers.update"
  | "teachers.deactivate"
  | "subjects.view"
  | "subjects.create"
  | "subjects.update"
  | "subjects.deactivate"
  | "subjects.teachers.manage"
  | "groups.view"
  | "groups.create"
  | "groups.update"
  | "groups.deactivate"
  | "groups.schedule.manage"
  | "enrollments.view"
  | "enrollments.create"
  | "enrollments.update"
  | "enrollments.end"
  | "sessions.view"
  | "sessions.generate"
  | "sessions.update"
  | "sessions.cancel"
  | "sessions.close"
  | "sessions.reopen"
  | "attendance.view"
  | "attendance.create"
  | "attendance.makeup"
  | "attendance.external"
  | "packages.view"
  | "packages.create"
  | "packages.update"
  | "packages.manage"
  | "packages.subscribe"
  | "payments.view"
  | "payments.create"
  | "payments.reverse"
  | "payments.adjust"
  | "reports.view"
  | "reports.attendance.view"
  | "reports.financial.view"
  | "users.view"
  | "users.manage"
  | "devices.view"
  | "settings.view"
  | "sync.manage"
  | "audit.view"
  | "notifications.view"
  | "notifications.send"
  | "notifications.templates.update"
  | "daily_closing.view"
  | "daily_closing.close"
  | "daily_closing.reopen";

export interface User {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  role: UserRole;
  centerId?: string;
  centerIds: string[];
  permissions: Permission[];
}

export interface Center {
  id: string;
  name: string;
  code: string;
  phone?: string;
  address?: string;
}

export interface StudentCard {
  id: string;
  centerId: string;
  studentId: string;
  cardCode: string;
  status: "active" | "inactive";
  issuedAt: string;
  deactivatedAt?: string | null;
  createdAt: string;
}

export interface Student {
  id: string;
  centerId: string;
  studentCode: string;
  fullName: string;
  cardCode?: string; // Legacy backward-compatibility only
  phone: string;
  parentPhone: string;
  grade: string;
  status: "active" | "inactive";
  studentType?: "registered" | "external";
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
}

export interface Teacher {
  id: string;
  centerId: string;
  name: string;
  phone?: string;
  status?: "active" | "inactive";
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
}

export interface Subject {
  id: string;
  centerId: string;
  name: string;
  code: string;
  status?: "active" | "inactive";
  createdAt?: string;
  updatedAt?: string | null;
}

export interface TeacherSubject {
  id: string;
  centerId: string;
  teacherId: string;
  subjectId: string;
  createdAt: string;
  teacherName?: string;
  subjectName?: string;
}

export interface Group {
  id: string;
  centerId: string;
  name: string;
  teacherId: string;
  subjectId: string;
  grade: string;
  defaultFee?: number;
  sessionPrice: number;
  monthlyPrice: number;
  sessionDurationMinutes: number;
  lateAfterMinutes: number;
  status: "active" | "inactive";
  createdAt?: string;
  updatedAt?: string | null;
  teacherName?: string;
  subjectName?: string;
}

export interface GroupSchedule {
  id: string;
  centerId?: string;
  groupId: string;
  dayOfWeek: number; // 0=Sunday, 1=Monday, etc.
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  status?: "active" | "inactive";
  createdAt?: string;
  updatedAt?: string | null;
}

export interface StudentGroupEnrollment {
  id: string;
  centerId: string;
  studentId: string;
  groupId: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null; // YYYY-MM-DD
  status: "active" | "inactive" | "ended";
  specialMonthlyPrice?: number | null;
  createdAt: string;
  updatedAt?: string | null;
  studentName?: string;
  groupName?: string;
}

export interface Session {
  id: string;
  centerId: string;
  groupId: string;
  scheduleId?: string | null;
  groupName?: string;
  subjectName?: string;
  teacherName?: string;
  subjectId?: string | null;
  teacherId?: string | null;
  sessionPrice?: number;
  lateAfterMinutes?: number;
  sessionDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  status: "scheduled" | "open" | "completed" | "closed" | "cancelled";
  createdAt?: string;
  updatedAt?: string | null;
}

export interface SessionExpectedStudent {
  id: string;
  centerId: string;
  sessionId: string;
  studentId: string;
}

export type AttendanceType = "present" | "makeup";

export interface Attendance {
  id: string;
  centerId: string;
  studentId: string;
  sessionId: string;
  checkInTime: string;
  status: "present" | "late";
  isLate: boolean;
  attendanceType: AttendanceType;
  originalAbsenceId?: string;
  isExternal?: boolean;
  operationId: string;
}

export interface StudentSubscription {
  id: string;
  centerId: string;
  studentId: string;
  groupId: string;
  packageName: string;
  amountDue: number;
  periodStart: string;
  periodEnd: string;
  status: "active" | "expired" | "canceled";
}

export interface Package {
  id: string;
  centerId: string;
  name: string;
  price: number;
  monthlyPrice?: number;
  description?: string | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt?: string | null;
  subjects?: PackageSubject[];
}

export interface PackageSubject {
  id: string;
  centerId: string;
  packageId: string;
  subjectId: string;
  defaultTeacherId: string;
  teacherId?: string;
  status?: "active" | "inactive";
  createdAt: string;
  subjectName?: string;
  subjectCode?: string;
  defaultTeacherName?: string;
  teacherName?: string;
}

export interface StudentPackageSubscription {
  id: string;
  centerId: string;
  studentId: string;
  packageId: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null; // YYYY-MM-DD
  cancellationDate?: string | null;
  status: "active" | "cancelled" | "ended";
  createdAt: string;
  updatedAt?: string | null;
  packageName?: string;
  packagePrice?: number;
  studentName?: string;
  monthlyPrice?: number;
}

export interface PackageTeacherOverride {
  id: string;
  centerId: string;
  subscriptionId: string;
  packageSubscriptionId?: string;
  packageId?: string;
  subjectId: string;
  teacherId: string;
  originalTeacherId?: string;
  overrideTeacherId?: string;
  status?: "active" | "inactive";
  createdAt: string;
  updatedAt?: string | null;
  subjectName?: string;
  teacherName?: string;
  originalTeacherName?: string;
  overrideTeacherName?: string;
}

export interface MakeupOpportunity {
  originalAbsenceSessionId?: string;
  originalSessionId?: string;
  studentId?: string;
  subjectId: string;
  teacherId: string;
  originalSessionDate?: string;
  nextEligibleSessionId?: string;
  nextEligibleSessionDate?: string;
  nextEligibleSessionStartTime?: string;
  isExpired?: boolean;
  status?: "available" | "expired" | "attended";
  subjectName?: string;
  teacherName?: string;
}

export interface AdvanceCoverage {
  id?: string;
  operationId?: string;
  centerId?: string;
  studentId: string;
  advanceSessionId: string;
  targetFutureSessionId: string;
  subjectId?: string;
  teacherId?: string;
  coveredAt?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface DebtCycle {
  id: string;
  centerId: string;
  studentId: string;
  enrollmentId?: string;
  groupId?: string;
  packageSubscriptionId?: string;
  packageId?: string;
  cycleType?: "group" | "package";
  cycleNumber: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  cyclePrice: number;
  status: "open" | "partial" | "paid" | "overdue" | "cancelled";
  createdAt: string;
  updatedAt?: string | null;
  // Calculated runtime fields
  totalPaid?: number;
  paidAmount?: number;
  remainingDebt?: number;
  netAdjustments?: number;
  effectiveDue?: number;
  effectivePrice?: number;
  groupName?: string;
  packageName?: string;
}

export interface PaymentEvent {
  id: string;
  operationId: string;
  centerId: string;
  studentId: string;
  subscriptionId?: string;
  debtCycleId?: string;
  sessionId?: string;
  amount: number;
  paymentType: "monthly" | "session" | "partial" | "full";
  paymentMethod?: "cash" | string;
  paymentDate?: string;
  notes?: string | null;
  isReversed?: boolean;
  createdAt: string;
  userId: string;
  updatedAt?: string | null;
}

export interface PaymentReversal {
  id: string;
  operationId: string;
  centerId: string;
  paymentId: string;
  studentId: string;
  reversedAmount: number;
  reason: string;
  reversedBy: string;
  reversedAt: string;
  createdAt: string;
}

export interface DebtAdjustment {
  id: string;
  operationId: string;
  centerId: string;
  studentId: string;
  enrollmentId?: string;
  debtCycleId: string;
  amountBefore: number;
  adjustmentAmount: number; // positive = increase debt, negative = discount/waiver
  amountAfter: number;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface StudentFinancialStatus {
  totalDue: number;
  totalPaid: number;
  remainingBalance: number;
  subscriptions: StudentSubscription[];
  payments: PaymentEvent[];
}

export interface DetailedStudentFinancialStatus extends StudentFinancialStatus {
  monthlyTotalDue: number;
  monthlyTotalPaid: number;
  monthlyAdjustments: number;
  monthlyRemainingDebt: number;
  totalRemainingDebt: number;
  sessionTotalPaid: number;
  sessionPaymentsTotal: number;
  groupMonthlyDue: number;
  groupMonthlyPaid: number;
  groupRemainingDebt: number;
  packageMonthlyDue: number;
  packageMonthlyPaid: number;
  packageRemainingDebt: number;
  cycles: DebtCycle[];
  adjustments: DebtAdjustment[];
  sessionPayments: PaymentEvent[];
  monthlyPayments: PaymentEvent[];
  reversals: PaymentReversal[];
}

export type SyncOperationStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "failed"
  | "conflict";

export interface SyncOperation {
  id: string;
  operationId: string;
  centerId: string;
  userId: string;
  deviceId: string;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: string;
  status: SyncOperationStatus;
  createdAt: string;
  syncedAt?: string;
  retryCount: number;
  lastError?: string;
}

export interface AuditLog {
  id: string;
  operationId: string;
  centerId: string;
  userId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  action: string;
  timestamp: string;
  payload?: string;
}

export type ConnectivityState = "online" | "offline" | "syncing" | "degraded";

// =========================================================
// SPRINT 5 — OPERATIONAL LAYER TYPES
// =========================================================

export type NotificationChannel = "push" | "sms";
export type NotificationDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed";
export type NotificationEventType = "attendance" | "absence";

export interface NotificationEvent {
  id: string;
  operationId: string;
  centerId: string;
  studentId: string;
  sessionId: string;
  attendanceId?: string | null;
  eventType: NotificationEventType;
  templateId?: string | null;
  createdBy: string;
  createdAt: string;
}

export interface NotificationDelivery {
  id: string;
  centerId: string;
  notificationEventId: string;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  recipient: string;
  renderedMessage: string;
  sentAt?: string | null;
  failureReason?: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt?: string | null;
}

export interface NotificationTemplate {
  id: string;
  centerId: string;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  templateBody: string;
  isDefault: boolean;
  createdBy: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface SessionClosingRecord {
  id: string;
  operationId: string;
  centerId: string;
  sessionId: string;
  action: "close" | "reopen";
  reason?: string | null;
  performedBy: string;
  performedAt: string;
  previousStatus: string;
  newStatus: string;
  totalAttendance?: number;
  totalSessionPayments?: number;
  createdAt: string;
}

export interface DailyClosingSummary {
  id: string;
  operationId: string;
  centerId: string;
  businessDate: string;
  status: "open" | "closed";
  closedBy?: string | null;
  closedAt?: string | null;
  reopenedBy?: string | null;
  reopenedAt?: string | null;
  reopenReason?: string | null;
  totalCash: number;
  monthlyTotal: number;
  partialTotal: number;
  sessionTotal: number;
  externalMakeupTotal: number;
  packageTotal: number;
  paymentCount: number;
  createdAt: string;
  updatedAt?: string | null;
}

export interface DailyAttendanceReport {
  date: string;
  centerId: string;
  sessions: {
    sessionId: string;
    groupName: string;
    subjectName: string;
    teacherName: string;
    startTime: string;
    endTime: string;
    status: string;
    expectedCount: number;
    presentCount: number;
    absentCount: number;
    lateCount: number;
    makeupCount: number;
    attendanceRate: number;
  }[];
  totals: {
    totalSessions: number;
    totalExpected: number;
    totalPresent: number;
    totalAbsent: number;
    attendanceRate: number;
  };
}

export interface StudentAttendanceReport {
  studentId: string;
  studentName: string;
  centerId: string;
  fromDate: string;
  toDate: string;
  sessions: {
    sessionId: string;
    sessionDate: string;
    groupName: string;
    subjectName: string;
    status: "present" | "late" | "absent" | "makeup" | "not_expected";
    checkInTime?: string;
    isExternal?: boolean;
  }[];
  totals: {
    totalSessions: number;
    presentCount: number;
    lateCount: number;
    absentCount: number;
    makeupCount: number;
    attendanceRate: number;
  };
}
