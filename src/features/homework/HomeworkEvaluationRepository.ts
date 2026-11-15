import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { LocalDataEvents } from "../../core/database/localDataEvents";
import { DeviceService } from "../../core/device";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import {
  HomeworkEvaluationStatus,
  SessionHomeworkEvaluation,
} from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export const CAIRO_TIME_ZONE = "Africa/Cairo";

const ARABIC_DAYS_MAP: Record<number, string> = {
  0: "الأحد",
  1: "الإثنين",
  2: "الثلاثاء",
  3: "الأربعاء",
  4: "الخميس",
  5: "الجمعة",
  6: "السبت",
};

const ARABIC_MONTHS_MAP: Record<number, string> = {
  1: "يناير",
  2: "فبراير",
  3: "مارس",
  4: "أبريل",
  5: "مايو",
  6: "يونيو",
  7: "يوليو",
  8: "أغسطس",
  9: "سبتمبر",
  10: "أكتوبر",
  11: "نوفمبر",
  12: "ديسمبر",
};

const EGYPT_WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];

const ARABIC_ORDINALS: string[] = [
  "الأولى",
  "الثانية",
  "الثالثة",
  "الرابعة",
  "الخامسة",
  "السادسة",
  "السابعة",
  "الثامنة",
  "التاسعة",
  "العاشرة",
  "الحادية عشرة",
  "الثانية عشرة",
  "الثالثة عشرة",
  "الرابعة عشرة",
  "الخامسة عشرة",
  "السادسة عشرة",
  "السابعة عشرة",
  "الثامنة عشرة",
  "التاسعة عشرة",
  "العشرون",
];

export interface ResolvedSessionCalendarDate {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  isoDate: string;
}

function buildCalendarDateFromYMD(
  year: number,
  month: number,
  day: number,
): ResolvedSessionCalendarDate | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (
    utcNoon.getUTCFullYear() !== year ||
    utcNoon.getUTCMonth() !== month - 1 ||
    utcNoon.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    dayOfWeek: utcNoon.getUTCDay(),
    isoDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function extractDatePartsInTimeZone(
  instant: Date,
  timeZone: string,
): ResolvedSessionCalendarDate | null {
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);
    const day = Number(parts.find((p) => p.type === "day")?.value);
    return buildCalendarDateFromYMD(year, month, day);
  } catch {
    return null;
  }
}

/**
 * Resolves a stored session_date value into its exact calendar date:
 * 1. Date-only strings (YYYY-MM-DD) preserve their exact calendar date without any UTC/local timezone shift.
 * 2. Naive local timestamps without timezone offset (YYYY-MM-DD[T ]HH:mm...) preserve their calendar date without appending Z.
 * 3. UTC timestamps (e.g. 2026-09-25T00:00:00.000Z) and timestamps with timezone offsets are resolved in Africa/Cairo.
 */
export function resolveSessionCalendarDate(
  value: unknown,
  timeZone: string = CAIRO_TIME_ZONE,
): ResolvedSessionCalendarDate | null {
  if (value instanceof Date) {
    return extractDatePartsInTimeZone(value, timeZone);
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  // 1. Date-only YYYY-MM-DD -> preserve calendar date directly (never shift by timezone)
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnlyMatch) {
    return buildCalendarDateFromYMD(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]),
      Number(dateOnlyMatch[3]),
    );
  }

  // 2. Naive timestamp without Z or explicit offset -> preserve calendar date without appending Z
  const naiveDateTimeMatch =
    /^(\d{4})-(\d{2})-(\d{2})[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.exec(
      raw,
    );
  if (naiveDateTimeMatch) {
    return buildCalendarDateFromYMD(
      Number(naiveDateTimeMatch[1]),
      Number(naiveDateTimeMatch[2]),
      Number(naiveDateTimeMatch[3]),
    );
  }

  // 3. UTC timestamp or timestamp with explicit timezone offset -> resolve in Africa/Cairo
  if (
    /^\d{4}-\d{2}-\d{2}[T ].*(?:Z|[+-]\d{2}:?\d{2}|\bUTC\b)$/i.test(raw)
  ) {
    const instant = new Date(raw);
    return extractDatePartsInTimeZone(instant, timeZone);
  }

  return null;
}

export function normalizeSessionDateOnly(
  value: unknown,
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const resolved = resolveSessionCalendarDate(value, timeZone);
  if (resolved) return resolved.isoDate;
  return String(value || "").trim();
}

/**
 * Formats a session date in Arabic (e.g. "الجمعة 25 سبتمبر 2026"):
 * - Date-only values preserve their exact calendar date.
 * - Actual timestamps are formatted in Africa/Cairo.
 * - Never exposes raw ISO strings.
 */
export function formatSessionDateArabic(
  value: unknown,
  fallback = "تاريخ غير متاح",
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const resolved = resolveSessionCalendarDate(value, timeZone);
  if (!resolved) return fallback;
  const weekday = ARABIC_DAYS_MAP[resolved.dayOfWeek] || "";
  const monthName = ARABIC_MONTHS_MAP[resolved.month] || "";
  if (!weekday || !monthName) return fallback;
  return `${weekday} ${resolved.day} ${monthName} ${resolved.year}`;
}

export function extractTime24InCairo(
  timeValue: unknown,
  timeZone: string = CAIRO_TIME_ZONE,
): { hours24: number; minutes: string; canonical24: string } | null {
  if (timeValue instanceof Date) {
    if (!Number.isFinite(timeValue.getTime())) return null;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        numberingSystem: "latn",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(timeValue);
      const rawHour = Number(parts.find((p) => p.type === "hour")?.value);
      const rawMin = parts.find((p) => p.type === "minute")?.value || "00";
      if (Number.isNaN(rawHour)) return null;
      const hours24 = rawHour % 24;
      const minutes = String(rawMin).padStart(2, "0");
      return {
        hours24,
        minutes,
        canonical24: `${String(hours24).padStart(2, "0")}:${minutes}`,
      };
    } catch {
      return null;
    }
  }

  if (typeof timeValue !== "string") return null;
  const clean = timeValue.trim();
  if (!clean) return null;

  // 1. Time-only string HH:mm or HH:mm:ss
  const timeOnlyMatch = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(clean);
  if (timeOnlyMatch) {
    const hours24 = Number(timeOnlyMatch[1]);
    const minutes = timeOnlyMatch[2];
    if (
      Number.isNaN(hours24) ||
      hours24 < 0 ||
      hours24 > 23 ||
      Number(minutes) > 59
    ) {
      return null;
    }
    return {
      hours24,
      minutes,
      canonical24: `${String(hours24).padStart(2, "0")}:${minutes}`,
    };
  }

  // 2. Full timestamp with Z or timezone offset -> convert to Africa/Cairo local time
  if (
    /^\d{4}-\d{2}-\d{2}[T ].*(?:Z|[+-]\d{2}:?\d{2}|\bUTC\b)$/i.test(clean)
  ) {
    const instant = new Date(clean);
    return extractTime24InCairo(instant, timeZone);
  }

  // 3. Naive datetime without offset -> extract wall-clock time without appending Z
  const naiveMatch = /^\d{4}-\d{2}-\d{2}[T ](\d{1,2}):(\d{2})/.exec(clean);
  if (naiveMatch) {
    const hours24 = Number(naiveMatch[1]);
    const minutes = naiveMatch[2];
    if (
      Number.isNaN(hours24) ||
      hours24 < 0 ||
      hours24 > 23 ||
      Number(minutes) > 59
    ) {
      return null;
    }
    return {
      hours24,
      minutes,
      canonical24: `${String(hours24).padStart(2, "0")}:${minutes}`,
    };
  }

  return null;
}

export function formatTimeArabic12h(
  time24?: unknown,
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const clean = typeof time24 === "string" ? time24.trim() : "";
  const extracted = extractTime24InCairo(time24, timeZone);
  if (!extracted) return clean;
  const period = extracted.hours24 >= 12 ? "م" : "ص";
  const hours12 = extracted.hours24 % 12 || 12;
  return `${String(hours12).padStart(2, "0")}:${extracted.minutes} ${period}`;
}

export function formatScheduleTimeRangeArabic(
  startTime?: string | null,
  endTime?: string | null,
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const startFormatted = formatTimeArabic12h(startTime, timeZone);
  const endFormatted = formatTimeArabic12h(endTime, timeZone);
  if (startFormatted && endFormatted) {
    return `من ${startFormatted} إلى ${endFormatted}`;
  }
  if (startFormatted) {
    return `من ${startFormatted}`;
  }
  return "الموعد غير محدد";
}

/**
 * Formats a session time range in compact Arabic format using en-dash:
 * e.g. "05:00 م – 07:00 م"
 */
export function formatSessionTimeRangeArabic(
  startTime?: unknown,
  endTime?: unknown,
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const startFormatted = formatTimeArabic12h(startTime, timeZone);
  const endFormatted = formatTimeArabic12h(endTime, timeZone);
  if (startFormatted && endFormatted) {
    return `${startFormatted} – ${endFormatted}`;
  }
  if (startFormatted) {
    return startFormatted;
  }
  return "الموعد غير محدد";
}

export function formatCairoDateTime(
  value: unknown,
  fallback = "تاريخ غير متاح",
  timeZone: string = CAIRO_TIME_ZONE,
): string {
  const datePart = formatSessionDateArabic(value, "", timeZone);
  const timePart = formatTimeArabic12h(value, timeZone);
  if (!datePart) return fallback;
  if (!timePart) return datePart;
  return `${datePart} — ${timePart}`;
}

export function formatScheduledDaysArabic(daysOfWeek: number[]): string {
  const uniqueDays = Array.from(
    new Set(
      daysOfWeek.filter(
        (d) => typeof d === "number" && d >= 0 && d <= 6 && !Number.isNaN(d),
      ),
    ),
  ).sort((a, b) => EGYPT_WEEK_ORDER.indexOf(a) - EGYPT_WEEK_ORDER.indexOf(b));

  if (uniqueDays.length === 0) return "الأيام غير محددة";
  return uniqueDays.map((d) => ARABIC_DAYS_MAP[d] || "").filter(Boolean).join(" و");
}

export function formatSessionOrdinalTitle(sessionNumber: number): string {
  const ordinal = ARABIC_ORDINALS[sessionNumber - 1];
  if (ordinal) {
    return `الحصة ${ordinal}`;
  }
  return `الحصة رقم ${sessionNumber}`;
}

export interface HomeworkEvaluationGroupCard {
  id: string;
  centerId: string;
  name: string;
  subjectId: string;
  subjectName: string;
  teacherId: string;
  teacherName: string;
  grade: string;
  scheduledDaysLabel: string;
  timeRangeLabel: string;
  sessionTimeRangeLabel: string;
  startTime: string | null;
  endTime: string | null;
  startTimeFormatted: string;
  endTimeFormatted: string;
  schedules: {
    id: string;
    dayOfWeek: number;
    dayName: string;
    startTime: string;
    endTime: string;
  }[];
  sessionsCount: number;
}

export interface HomeworkEvaluationSessionCard {
  id: string;
  centerId: string;
  groupId: string;
  groupName: string;
  subjectName: string;
  teacherName: string;
  sessionNumber: number;
  sessionOrdinalTitle: string;
  sessionNumericTitle: string;
  sessionDate: string;
  sessionDateFormatted: string;
  startTime: string;
  endTime: string;
  sessionTimeLabel: string;
  timeRangeLabel: string;
  status: string;
  sessionStatusLabel: string;
  attendedCount: number;
  evaluatedCount: number;
  unevaluatedCount: number;
  completionPercentage: number;
  progressStatusLabel: string;
}

export type StudentHomeworkEvaluationState =
  | "evaluated"
  | "unevaluated"
  | "absent";

export interface HomeworkSessionStudentItem {
  studentId: string;
  studentName: string;
  studentCode: string;
  phone: string;
  parentPhone: string;
  attendanceId: string;
  attendanceStatus: "present" | "late" | "absent";
  checkInTime: string | null;
  evaluationState: StudentHomeworkEvaluationState;
  evaluationStateLabel: "تم تقييمه" | "لم يتم تقييمه" | "غائب";
  evaluationId: string | null;
  statusId: string | null;
  statusName: string | null;
  evaluatedAt: string | null;
  notificationSent: boolean;
  lastNotificationAt: string | null;
}

export interface HomeworkSessionEvaluationRoster {
  session: {
    id: string;
    centerId: string;
    groupId: string;
    groupName: string;
    subjectId: string;
    subjectName: string;
    teacherId: string;
    teacherName: string;
    sessionNumber: number;
    sessionOrdinalTitle: string;
    sessionNumericTitle: string;
    sessionDate: string;
    sessionDateFormatted: string;
    startTime: string;
    endTime: string;
    sessionTimeLabel: string;
    timeRangeLabel: string;
    status: string;
    sessionStatusLabel: string;
  };
  stats: {
    totalAttended: number;
    evaluatedCount: number;
    unevaluatedCount: number;
    absentCount: number;
    completionPercentage: number;
  };
  evaluatedStudents: HomeworkSessionStudentItem[];
  unevaluatedStudents: HomeworkSessionStudentItem[];
  absentStudents: HomeworkSessionStudentItem[];
}

export class HomeworkEvaluationRepository {
  private static context() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser)
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    return { centerId: activeCenterId, user: currentUser };
  }

  private static requireView(): {
    centerId: string;
    user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]>;
  } {
    const context = this.context();
    if (
      !PermissionService.hasAnyPermission(context.user.permissions, [
        "homework.manage",
        "grades.view",
        "grades.manage",
        "attendance.view",
        "attendance.create",
        "attendance.edit",
        "students.profile.view",
        "notifications.send",
        "groups.view",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية عرض تقييمات الواجب.");
    }
    return context;
  }

  private static requireAssignment(): {
    centerId: string;
    user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]>;
  } {
    const context = this.context();
    if (
      !PermissionService.hasAnyPermission(context.user.permissions, [
        "homework.manage",
        "grades.manage",
        "attendance.create",
        "attendance.edit",
      ])
    ) {
      throw new ForbiddenError("ليس لديك صلاحية تسجيل تقييم الواجب.");
    }
    return context;
  }

  private static requireManagement(): {
    centerId: string;
    user: NonNullable<ReturnType<typeof useAuthStore.getState>["currentUser"]>;
  } {
    const context = this.context();
    if (
      !PermissionService.hasPermission(
        context.user.permissions,
        "homework.manage",
      )
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إدارة حالات تقييم الواجب.");
    }
    return context;
  }

  static listStatuses(includeInactive = false): HomeworkEvaluationStatus[] {
    const { centerId } = this.requireView();
    return DatabaseService.getDb().getAllSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses
       WHERE center_id = ? AND status ${includeInactive ? "!= 'deleted'" : "= 'active'"}
       ORDER BY name COLLATE NOCASE`,
      [centerId],
    );
  }

  static createStatus(name: string): HomeworkEvaluationStatus {
    const { centerId, user } = this.requireManagement();
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120)
      throw new ValidationError("أدخل اسمًا للحالة لا يتجاوز 120 حرفًا.");
    const db = DatabaseService.getDb();
    const duplicate = db.getFirstSync<any>(
      `SELECT id FROM homework_evaluation_statuses
       WHERE center_id = ? AND lower(name) = lower(?) AND status != 'deleted'`,
      [centerId, cleanName],
    );
    if (duplicate) throw new ConflictError("حالة بهذا الاسم موجودة بالفعل.");

    const now = new Date().toISOString();
    const status: HomeworkEvaluationStatus = {
      id: id("hwstatus"),
      centerId,
      name: cleanName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const operationId = id("op-hwstatus-create");
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO homework_evaluation_statuses (id, center_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
        [status.id, centerId, cleanName, now, now],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status",
        entityId: status.id,
        action: "homework_evaluation_status.create",
        payload: { name: cleanName, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: "CREATE",
        entityType: "homework_evaluation_status",
        entityId: status.id,
        payload: {
          ...status,
          center_id: centerId,
          created_at: now,
          updated_at: now,
        },
      });
    });
    LocalDataEvents.emit();
    SyncEngine.syncCenterNow(centerId).catch((error) =>
      console.warn("Background homework status sync notice:", error),
    );
    return status;
  }

  static updateStatus(
    statusId: string,
    updates: { name?: string; status?: "active" | "inactive" },
  ): HomeworkEvaluationStatus {
    const { centerId, user } = this.requireManagement();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses WHERE center_id = ? AND id = ? AND status != 'deleted'`,
      [centerId, statusId],
    );
    if (!existing) throw new NotFoundError("حالة تقييم الواجب غير موجودة.");
    const name =
      updates.name === undefined ? existing.name : updates.name.trim();
    const status = updates.status || existing.status;
    if (!name || name.length > 120)
      throw new ValidationError("أدخل اسمًا صحيحًا للحالة.");
    const duplicate = db.getFirstSync<any>(
      `SELECT id FROM homework_evaluation_statuses
       WHERE center_id = ? AND lower(name) = lower(?) AND id != ? AND status != 'deleted'`,
      [centerId, name, statusId],
    );
    if (duplicate) throw new ConflictError("حالة بهذا الاسم موجودة بالفعل.");
    const now = new Date().toISOString();
    const operationId = id("op-hwstatus-update");
    const result = { ...existing, name, status, updatedAt: now };
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE homework_evaluation_statuses SET name = ?, status = ?, updated_at = ?
         WHERE center_id = ? AND id = ? AND status != 'deleted'`,
        [name, status, now, centerId, statusId],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status",
        entityId: statusId,
        action: "homework_evaluation_status.update",
        payload: { name, status, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: "UPDATE",
        entityType: "homework_evaluation_status",
        entityId: statusId,
        payload: { ...result, center_id: centerId, updated_at: now },
      });
    });
    LocalDataEvents.emit();
    SyncEngine.syncCenterNow(centerId).catch((error) =>
      console.warn("Background homework status sync notice:", error),
    );
    return result;
  }

  static removeStatus(statusId: string): void {
    const { centerId, user } = this.requireManagement();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses WHERE center_id = ? AND id = ? AND status != 'deleted'`,
      [centerId, statusId],
    );
    if (!existing) throw new NotFoundError("حالة تقييم الواجب غير موجودة.");
    const usage = db.getAllSync<{ id: string }>(
      `SELECT id FROM session_homework_evaluations
       WHERE center_id = ? AND status_id = ?`,
      [centerId, statusId],
    );
    if (usage.length > 0) {
      throw new ConflictError(
        "لا يمكن حذف حالة استُخدمت في سجل واجب. يمكنك تعطيلها بدلًا من ذلك.",
      );
    }
    const now = new Date().toISOString();
    const operationId = id("op-hwstatus-delete");
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE homework_evaluation_statuses SET status = 'deleted', updated_at = ?
         WHERE center_id = ? AND id = ? AND status != 'deleted'`,
        [now, centerId, statusId],
      );
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "homework_evaluation_status",
        entityId: statusId,
        action: "homework_evaluation_status.delete",
        payload: { name: existing.name, actorName: user.fullName },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: "UPDATE",
        entityType: "homework_evaluation_status",
        entityId: statusId,
        payload: {
          id: statusId,
          status: "deleted",
          updatedAt: now,
          updated_at: now,
        },
      });
    });
    LocalDataEvents.emit();
    SyncEngine.syncCenterNow(centerId).catch((error) =>
      console.warn("Background homework status sync notice:", error),
    );
  }

  /**
   * Returns all active groups belonging to the active center with their schedule
   * days and session start/end times for the Homework Evaluation Groups screen.
   */
  static getGroupsForEvaluation(): HomeworkEvaluationGroupCard[] {
    const { centerId } = this.requireView();
    const db = DatabaseService.getDb();

    try {
      const rawGroups = db.getAllSync<any>(
        `SELECT g.id, g.center_id as centerId, g.name, g.subject_id as subjectId,
                g.teacher_id as teacherId, g.grade, g.status,
                s.name as subjectName, t.name as teacherName
         FROM groups g
         LEFT JOIN subjects s ON g.subject_id = s.id
         LEFT JOIN teachers t ON g.teacher_id = t.id
         WHERE g.center_id = ?
         ORDER BY g.name ASC`,
        [centerId],
      );

      const activeGroups = rawGroups.filter(
        (g) => String(g.status || "active").toLowerCase() === "active",
      );

      return activeGroups.map((g) => {
        const rawSchedules = db.getAllSync<any>(
          `SELECT id, center_id as centerId, group_id as groupId, day_of_week as dayOfWeek,
                  start_time as startTime, end_time as endTime, status, created_at as createdAt, updated_at as updatedAt
           FROM group_schedules
           WHERE center_id = ? AND group_id = ? AND status = 'active'
           ORDER BY day_of_week ASC, start_time ASC`,
          [centerId, g.id],
        );

        const activeSchedules = rawSchedules
          .filter(
            (sch) =>
              String(sch.status || "active").toLowerCase() === "active",
          )
          .map((sch) => ({
            id: String(sch.id),
            dayOfWeek: Number(sch.dayOfWeek),
            dayName: ARABIC_DAYS_MAP[Number(sch.dayOfWeek)] || "",
            startTime: String(sch.startTime || ""),
            endTime: String(sch.endTime || ""),
          }));

        const groupSessions = db.getAllSync<any>(
          `SELECT id, session_date as sessionDate, start_time as startTime, end_time as endTime, status
           FROM sessions
           WHERE center_id = ? AND group_id = ? AND status != 'cancelled'`,
          [centerId, g.id],
        );

        const scheduledDaysLabel = formatScheduledDaysArabic(
          activeSchedules.map((s) => s.dayOfWeek),
        );
        let primaryStart = activeSchedules[0]?.startTime || null;
        let primaryEnd = activeSchedules[0]?.endTime || null;

        if (activeSchedules.length === 0 && groupSessions.length > 0) {
          const latestSession = [...groupSessions].sort((a, b) => {
            const dateA = normalizeSessionDateOnly(a.sessionDate);
            const dateB = normalizeSessionDateOnly(b.sessionDate);
            return dateB.localeCompare(dateA);
          })[0];
          primaryStart = latestSession?.startTime || null;
          primaryEnd = latestSession?.endTime || null;
        }

        const timeRangeLabel = formatScheduleTimeRangeArabic(
          primaryStart,
          primaryEnd,
        );
        const sessionTimeRangeLabel = formatSessionTimeRangeArabic(
          primaryStart,
          primaryEnd,
        );

        return {
          id: String(g.id),
          centerId: String(g.centerId || centerId),
          name: String(g.name || ""),
          subjectId: String(g.subjectId || ""),
          subjectName: String(g.subjectName || ""),
          teacherId: String(g.teacherId || ""),
          teacherName: String(g.teacherName || ""),
          grade: String(g.grade || ""),
          scheduledDaysLabel,
          timeRangeLabel,
          sessionTimeRangeLabel,
          startTime: primaryStart,
          endTime: primaryEnd,
          startTimeFormatted: formatTimeArabic12h(primaryStart),
          endTimeFormatted: formatTimeArabic12h(primaryEnd),
          schedules: activeSchedules,
          sessionsCount: groupSessions.length,
        };
      });
    } catch (error) {
      console.error(
        "[HomeworkEvaluationRepository.getGroupsForEvaluation] Database query error:",
        error,
      );
      throw error;
    }
  }

  /**
   * Returns all non-cancelled sessions for a group in chronological order (oldest to newest: 1, 2, 3...)
   * along with each session's independent homework evaluation progress.
   */
  static getSessionsForGroup(groupId: string): HomeworkEvaluationSessionCard[] {
    const { centerId } = this.requireView();
    const db = DatabaseService.getDb();

    const group = db.getFirstSync<any>(
      `SELECT g.id, g.name, g.subject_id as subjectId, g.teacher_id as teacherId,
              s.name as subjectName, t.name as teacherName
       FROM groups g
       LEFT JOIN subjects s ON g.subject_id = s.id
       LEFT JOIN teachers t ON g.teacher_id = t.id
       WHERE g.center_id = ? AND g.id = ?`,
      [centerId, groupId],
    );
    if (!group) {
      throw new NotFoundError("المجموعة غير موجودة في هذا المركز.");
    }

    const rawSessions = db.getAllSync<any>(
      `SELECT id, center_id as centerId, group_id as groupId,
              session_date as sessionDate, start_time as startTime, end_time as endTime,
              status, created_at as createdAt
       FROM sessions
       WHERE center_id = ? AND group_id = ? AND status != 'cancelled'
       ORDER BY session_date ASC, start_time ASC, created_at ASC, id ASC`,
      [centerId, groupId],
    );

    const chronologicalSessions = rawSessions
      .filter(
        (s) =>
          String(s.centerId || centerId) === centerId &&
          String(s.groupId) === groupId &&
          String(s.status || "").toLowerCase() !== "cancelled",
      )
      .sort((a, b) => {
        const dateA = normalizeSessionDateOnly(a.sessionDate);
        const dateB = normalizeSessionDateOnly(b.sessionDate);
        const dateCmp = dateA.localeCompare(dateB);
        if (dateCmp !== 0) return dateCmp;

        const timeA =
          extractTime24InCairo(a.startTime)?.canonical24 ||
          String(a.startTime || "");
        const timeB =
          extractTime24InCairo(b.startTime)?.canonical24 ||
          String(b.startTime || "");
        const timeCmp = timeA.localeCompare(timeB);
        if (timeCmp !== 0) return timeCmp;

        const createdCmp = String(a.createdAt || "").localeCompare(
          String(b.createdAt || ""),
        );
        if (createdCmp !== 0) return createdCmp;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });

    return chronologicalSessions.map((session, index) => {
      const sessionNumber = index + 1;
      const sessionId = String(session.id);

      const attendedStudentIds = this.getAttendedStudentIdsForSession(
        centerId,
        sessionId,
      );
      const attendedSet = new Set(attendedStudentIds);

      const evaluations = db.getAllSync<any>(
        `SELECT student_id as studentId, status_id as statusId, deleted_at as deletedAt
         FROM session_homework_evaluations
         WHERE center_id = ? AND session_id = ? AND deleted_at IS NULL`,
        [centerId, sessionId],
      );

      const evaluatedAttendedIds = new Set(
        evaluations
          .filter((ev) => !ev.deletedAt && attendedSet.has(String(ev.studentId)))
          .map((ev) => String(ev.studentId)),
      );

      const attendedCount = attendedSet.size;
      const evaluatedCount = evaluatedAttendedIds.size;
      const unevaluatedCount = Math.max(0, attendedCount - evaluatedCount);
      const completionPercentage =
        attendedCount > 0
          ? Math.round((evaluatedCount / attendedCount) * 100)
          : 0;

      let progressStatusLabel = "لا يوجد حضور مسجل";
      if (attendedCount > 0) {
        if (evaluatedCount === 0) {
          progressStatusLabel = "لم يبدأ التقييم";
        } else if (evaluatedCount < attendedCount) {
          progressStatusLabel = `تم تقييم ${evaluatedCount} من ${attendedCount}`;
        } else {
          progressStatusLabel = `مكتمل (${evaluatedCount}/${attendedCount})`;
        }
      }

      const rawStatus = String(session.status || "scheduled").toLowerCase();
      const sessionStatusLabel =
        rawStatus === "open"
          ? "مفتوحة"
          : rawStatus === "closed" || rawStatus === "completed"
            ? "مغلقة"
            : "مجدولة";

      const normalizedDate = normalizeSessionDateOnly(session.sessionDate);
      const sessionDateFormatted = formatSessionDateArabic(session.sessionDate);
      const sessionTimeLabel = formatSessionTimeRangeArabic(
        session.startTime,
        session.endTime,
      );

      return {
        id: sessionId,
        centerId,
        groupId: String(group.id),
        groupName: String(group.name || ""),
        subjectName: String(group.subjectName || ""),
        teacherName: String(group.teacherName || ""),
        sessionNumber,
        sessionOrdinalTitle: formatSessionOrdinalTitle(sessionNumber),
        sessionNumericTitle: `الحصة رقم ${sessionNumber}`,
        sessionDate: normalizedDate,
        sessionDateFormatted,
        startTime: String(session.startTime || ""),
        endTime: String(session.endTime || ""),
        sessionTimeLabel,
        timeRangeLabel: sessionTimeLabel,
        status: rawStatus,
        sessionStatusLabel,
        attendedCount,
        evaluatedCount,
        unevaluatedCount,
        completionPercentage,
        progressStatusLabel,
      };
    });
  }

  /**
   * Returns the complete session homework evaluation roster, strictly separating:
   * - evaluatedStudents (attended + has saved homework evaluation)
   * - unevaluatedStudents (attended + no saved homework evaluation yet)
   * - absentStudents (did not attend / marked absent; excluded from evaluation tabs)
   */
  static getSessionEvaluationRoster(
    sessionId: string,
  ): HomeworkSessionEvaluationRoster {
    const { centerId } = this.requireView();
    const db = DatabaseService.getDb();

    const sessionRow = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, group_id as groupId,
              subject_id as subjectId, teacher_id as teacherId,
              session_date as sessionDate, start_time as startTime, end_time as endTime,
              status
       FROM sessions
       WHERE center_id = ? AND id = ?`,
      [centerId, sessionId],
    );
    if (!sessionRow) {
      throw new NotFoundError("الحصة غير موجودة في هذا المركز.");
    }

    const groupId = String(sessionRow.groupId || "");
    const groupRow = groupId
      ? db.getFirstSync<any>(
          `SELECT g.id, g.name, g.subject_id as subjectId, g.teacher_id as teacherId,
                  s.name as subjectName, t.name as teacherName
           FROM groups g
           LEFT JOIN subjects s ON g.subject_id = s.id
           LEFT JOIN teachers t ON g.teacher_id = t.id
           WHERE g.center_id = ? AND g.id = ?`,
          [centerId, groupId],
        )
      : null;

    // Determine sequential chronological number within the group
    let sessionNumber = 1;
    if (groupId) {
      const groupSessions = this.getSessionsForGroup(groupId);
      const foundIdx = groupSessions.findIndex((s) => s.id === sessionId);
      if (foundIdx >= 0) {
        sessionNumber = groupSessions[foundIdx].sessionNumber;
      }
    }

    // Load statuses map
    const statuses = db.getAllSync<HomeworkEvaluationStatus>(
      `SELECT id, center_id as centerId, name, status, created_at as createdAt, updated_at as updatedAt
       FROM homework_evaluation_statuses
       WHERE center_id = ?`,
      [centerId],
    );
    const statusMap = new Map<string, string>();
    for (const st of statuses) {
      statusMap.set(st.id, st.name);
    }

    // Load session evaluations
    const rawEvaluations = db.getAllSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND session_id = ? AND deleted_at IS NULL`,
      [centerId, sessionId],
    );
    const evaluationByStudent = new Map<string, SessionHomeworkEvaluation>();
    for (const ev of rawEvaluations) {
      if (!ev.deletedAt) {
        evaluationByStudent.set(String(ev.studentId), ev);
      }
    }

    // Load homework notifications sent for this session
    const homeworkNotifEvents = db.getAllSync<any>(
      `SELECT student_id as studentId, created_at as createdAt
       FROM notification_events
       WHERE center_id = ? AND session_id = ? AND event_type = 'homework'`,
      [centerId, sessionId],
    );
    const notifByStudent = new Map<string, string>();
    for (const ne of homeworkNotifEvents) {
      const sid = String(ne.studentId || "");
      const prev = notifByStudent.get(sid);
      if (!prev || String(ne.createdAt || "") > prev) {
        notifByStudent.set(sid, String(ne.createdAt || ""));
      }
    }

    // Load attendance records for this session
    const rawAttendance = db.getAllSync<any>(
      `SELECT id, student_id as studentId, status, check_in_time as checkInTime
       FROM attendance
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );

    const attendedMap = new Map<
      string,
      { id: string; status: "present" | "late"; checkInTime: string | null }
    >();
    const explicitAbsentMap = new Map<
      string,
      { id: string; checkInTime: string | null }
    >();

    for (const att of rawAttendance) {
      const sid = String(att.studentId || "");
      if (!sid) continue;
      const st = String(att.status || "").toLowerCase();
      if (st === "present" || st === "late") {
        attendedMap.set(sid, {
          id: String(att.id || ""),
          status: st as "present" | "late",
          checkInTime: att.checkInTime || null,
        });
        explicitAbsentMap.delete(sid);
      } else if (st === "absent" && !attendedMap.has(sid)) {
        explicitAbsentMap.set(sid, {
          id: String(att.id || ""),
          checkInTime: att.checkInTime || null,
        });
      }
    }

    // Also include expected students who did not attend as absent
    const expectedRows = db.getAllSync<any>(
      `SELECT student_id as studentId
       FROM session_expected_students
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    for (const exp of expectedRows) {
      const sid = String(exp.studentId || "");
      if (sid && !attendedMap.has(sid) && !explicitAbsentMap.has(sid)) {
        explicitAbsentMap.set(sid, { id: "", checkInTime: null });
      }
    }

    const evaluatedStudents: HomeworkSessionStudentItem[] = [];
    const unevaluatedStudents: HomeworkSessionStudentItem[] = [];
    const absentStudents: HomeworkSessionStudentItem[] = [];

    for (const [studentId, attInfo] of attendedMap.entries()) {
      const student = db.getFirstSync<any>(
        `SELECT id, full_name, student_code, phone, parent_phone, deleted_at
         FROM students
         WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
        [centerId, studentId],
      );
      if (!student) continue;

      const ev = evaluationByStudent.get(studentId);
      const lastNotificationAt = notifByStudent.get(studentId) || null;
      const itemBase = {
        studentId,
        studentName: String(student.full_name || ""),
        studentCode: String(student.student_code || ""),
        phone: String(student.phone || ""),
        parentPhone: String(student.parent_phone || ""),
        attendanceId: attInfo.id,
        attendanceStatus: attInfo.status,
        checkInTime: attInfo.checkInTime,
        notificationSent: Boolean(lastNotificationAt),
        lastNotificationAt,
      };

      if (ev) {
        evaluatedStudents.push({
          ...itemBase,
          evaluationState: "evaluated",
          evaluationStateLabel: "تم تقييمه",
          evaluationId: ev.id,
          statusId: ev.statusId,
          statusName:
            statusMap.get(ev.statusId) ||
            this.getStatusName(centerId, ev.statusId) ||
            "تم التقييم",
          evaluatedAt: ev.updatedAt || ev.createdAt,
        });
      } else {
        unevaluatedStudents.push({
          ...itemBase,
          evaluationState: "unevaluated",
          evaluationStateLabel: "لم يتم تقييمه",
          evaluationId: null,
          statusId: null,
          statusName: null,
          evaluatedAt: null,
        });
      }
    }

    for (const [studentId, absInfo] of explicitAbsentMap.entries()) {
      const student = db.getFirstSync<any>(
        `SELECT id, full_name, student_code, phone, parent_phone, deleted_at
         FROM students
         WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
        [centerId, studentId],
      );
      if (!student) continue;

      absentStudents.push({
        studentId,
        studentName: String(student.full_name || ""),
        studentCode: String(student.student_code || ""),
        phone: String(student.phone || ""),
        parentPhone: String(student.parent_phone || ""),
        attendanceId: absInfo.id,
        attendanceStatus: "absent",
        checkInTime: absInfo.checkInTime,
        evaluationState: "absent",
        evaluationStateLabel: "غائب",
        evaluationId: null,
        statusId: null,
        statusName: null,
        evaluatedAt: null,
        notificationSent: false,
        lastNotificationAt: null,
      });
    }

    evaluatedStudents.sort((a, b) =>
      a.studentName.localeCompare(b.studentName, "ar"),
    );
    unevaluatedStudents.sort((a, b) =>
      a.studentName.localeCompare(b.studentName, "ar"),
    );
    absentStudents.sort((a, b) =>
      a.studentName.localeCompare(b.studentName, "ar"),
    );

    const totalAttended =
      evaluatedStudents.length + unevaluatedStudents.length;
    const evaluatedCount = evaluatedStudents.length;
    const unevaluatedCount = unevaluatedStudents.length;
    const completionPercentage =
      totalAttended > 0
        ? Math.round((evaluatedCount / totalAttended) * 100)
        : 0;

    const rawStatus = String(sessionRow.status || "scheduled").toLowerCase();
    const sessionStatusLabel =
      rawStatus === "open"
        ? "مفتوحة"
        : rawStatus === "closed" || rawStatus === "completed"
          ? "مغلقة"
          : "مجدولة";

    const normalizedSessionDate = normalizeSessionDateOnly(
      sessionRow.sessionDate,
    );
    const sessionDateFormatted = formatSessionDateArabic(
      sessionRow.sessionDate,
    );
    const sessionTimeLabel = formatSessionTimeRangeArabic(
      sessionRow.startTime,
      sessionRow.endTime,
    );

    return {
      session: {
        id: String(sessionRow.id),
        centerId,
        groupId,
        groupName: String(groupRow?.name || ""),
        subjectId: String(
          sessionRow.subjectId || groupRow?.subjectId || "",
        ),
        subjectName: String(groupRow?.subjectName || ""),
        teacherId: String(
          sessionRow.teacherId || groupRow?.teacherId || "",
        ),
        teacherName: String(groupRow?.teacherName || ""),
        sessionNumber,
        sessionOrdinalTitle: formatSessionOrdinalTitle(sessionNumber),
        sessionNumericTitle: `الحصة رقم ${sessionNumber}`,
        sessionDate: normalizedSessionDate,
        sessionDateFormatted,
        startTime: String(sessionRow.startTime || ""),
        endTime: String(sessionRow.endTime || ""),
        sessionTimeLabel,
        timeRangeLabel: sessionTimeLabel,
        status: rawStatus,
        sessionStatusLabel,
      },
      stats: {
        totalAttended,
        evaluatedCount,
        unevaluatedCount,
        absentCount: absentStudents.length,
        completionPercentage,
      },
      evaluatedStudents,
      unevaluatedStudents,
      absentStudents,
    };
  }

  /**
   * Evaluates a student in a session with strict attendance verification.
   * Only students with present/late attendance in the session can be evaluated.
   * Never creates or modifies attendance or absence records.
   */
  static evaluateSessionStudent(
    sessionId: string,
    studentId: string,
    statusId: string | null,
    options?: { operationId?: string },
  ): SessionHomeworkEvaluation | null {
    return this.setForSession(sessionId, studentId, statusId, {
      ...options,
      requireAttendance: true,
    });
  }

  static getForSession(
    sessionId: string,
    studentId: string,
  ): SessionHomeworkEvaluation | null {
    const { centerId } = this.requireView();
    const row = DatabaseService.getDb().getFirstSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND session_id = ? AND student_id = ? AND deleted_at IS NULL`,
      [centerId, sessionId, studentId],
    );
    if (!row) return null;
    return { ...row, statusName: this.getStatusName(centerId, row.statusId) };
  }

  static getForStudent(studentId: string): SessionHomeworkEvaluation[] {
    const { centerId } = this.requireView();
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND student_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );
    return rows.map((row) => {
      const session = db.getFirstSync<any>(
        `SELECT session_date as sessionDate, group_id as groupId
         FROM sessions WHERE center_id = ? AND id = ?`,
        [centerId, row.sessionId],
      );
      const group = session?.groupId
        ? db.getFirstSync<any>(
            "SELECT name FROM groups WHERE center_id = ? AND id = ?",
            [centerId, session.groupId],
          )
        : null;
      const attendance = db.getFirstSync<any>(
        `SELECT status FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        [centerId, row.sessionId, studentId],
      );
      return {
        ...row,
        statusName: this.getStatusName(centerId, row.statusId),
        sessionDate: session?.sessionDate,
        groupName: group?.name,
        attendanceStatus: attendance?.status,
      };
    });
  }

  static setForSession(
    sessionId: string,
    studentId: string,
    statusId: string | null,
    options?: { requireAttendance?: boolean; operationId?: string },
  ): SessionHomeworkEvaluation | null {
    const { centerId, user } = this.requireAssignment();
    const db = DatabaseService.getDb();
    const session = db.getFirstSync<any>(
      "SELECT id FROM sessions WHERE center_id = ? AND id = ?",
      [centerId, sessionId],
    );
    if (!session) throw new NotFoundError("الحصة غير موجودة في هذا المركز.");
    const student = db.getFirstSync<any>(
      "SELECT id FROM students WHERE center_id = ? AND id = ? AND deleted_at IS NULL",
      [centerId, studentId],
    );
    if (!student) throw new NotFoundError("الطالب غير موجود في هذا المركز.");

    if (statusId) {
      const sessionAttendance = db.getAllSync<any>(
        `SELECT student_id as studentId, status
         FROM attendance
         WHERE center_id = ? AND session_id = ?`,
        [centerId, sessionId],
      );
      const studentAttendance = sessionAttendance.filter(
        (r) => String(r.studentId) === studentId,
      );
      const hasAttended = studentAttendance.some((r) =>
        ["present", "late"].includes(String(r.status || "").toLowerCase()),
      );
      const isExplicitlyAbsent = studentAttendance.some(
        (r) => String(r.status || "").toLowerCase() === "absent",
      );

      if (isExplicitlyAbsent && !hasAttended) {
        throw new ValidationError(
          "لا يمكن تقييم الواجب لطالب غائب في هذه الحصة.",
        );
      }

      const expectedRows = db.getAllSync<any>(
        `SELECT student_id as studentId
         FROM session_expected_students
         WHERE center_id = ? AND session_id = ?`,
        [centerId, sessionId],
      );

      if (
        (options?.requireAttendance ||
          sessionAttendance.length > 0 ||
          expectedRows.length > 0) &&
        !hasAttended
      ) {
        throw new ValidationError(
          "لا يمكن تقييم الواجب لطالب لم يحضر الحصة.",
        );
      }
    }

    const existing = db.getFirstSync<SessionHomeworkEvaluation>(
      `SELECT id, center_id as centerId, student_id as studentId, session_id as sessionId,
              status_id as statusId, created_at as createdAt, updated_at as updatedAt,
              deleted_at as deletedAt
       FROM session_homework_evaluations
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (!statusId && (!existing || existing.deletedAt)) return null;
    if (statusId) {
      const status = db.getFirstSync<any>(
        `SELECT id FROM homework_evaluation_statuses
         WHERE center_id = ? AND id = ? AND status = 'active'`,
        [centerId, statusId],
      );
      if (!status)
        throw new ValidationError(
          "حالة تقييم الواجب غير متاحة في هذا المركز.",
        );
    }

    const now = new Date().toISOString();
    const operationId = options?.operationId || id("op-hweval");
    let result: SessionHomeworkEvaluation | null = null;
    DatabaseService.runInTransaction(() => {
      if (statusId) {
        const evaluationId = existing?.id || id("hweval");
        const createdAt = existing?.createdAt || now;
        db.runSync(
          `INSERT INTO session_homework_evaluations
             (id, center_id, student_id, session_id, status_id, created_at, updated_at, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(center_id, student_id, session_id) DO UPDATE SET
             status_id = excluded.status_id, updated_at = excluded.updated_at,
             deleted_at = NULL, deleted_by = NULL`,
          [
            evaluationId,
            centerId,
            studentId,
            sessionId,
            statusId,
            createdAt,
            now,
          ],
        );
        result = {
          id: evaluationId,
          centerId,
          studentId,
          sessionId,
          statusId,
          statusName: this.getStatusName(centerId, statusId),
          createdAt,
          updatedAt: now,
          deletedAt: null,
        };
      } else if (existing) {
        db.runSync(
          `UPDATE session_homework_evaluations SET deleted_at = ?, deleted_by = ?, updated_at = ?
           WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
          [now, user.id, now, centerId, existing.id],
        );
        result = null;
      }
      const action = statusId
        ? existing
          ? "homework_evaluation.update"
          : "homework_evaluation.create"
        : "homework_evaluation.delete";
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "session_homework_evaluation",
        entityId: existing?.id || result?.id || "",
        action,
        payload: {
          studentId,
          sessionId,
          statusId,
          actorName: user.fullName,
        },
      });
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: existing ? "UPDATE" : "CREATE",
        entityType: "session_homework_evaluation",
        entityId: existing?.id || result?.id || "",
        payload: {
          ...(existing || result || {}),
          id: existing?.id || result?.id || "",
          center_id: centerId,
          student_id: studentId,
          session_id: sessionId,
          status_id: statusId,
          deleted_at: statusId ? null : now,
          deleted_by: statusId ? null : user.id,
          updated_at: now,
          updatedAt: now,
        },
      });
    });
    LocalDataEvents.emit();
    SyncEngine.syncCenterNow(centerId).catch((error) =>
      console.warn("Background homework evaluation sync notice:", error),
    );
    return result;
  }

  private static getAttendedStudentIdsForSession(
    centerId: string,
    sessionId: string,
  ): string[] {
    const db = DatabaseService.getDb();
    const rawAttendance = db.getAllSync<any>(
      `SELECT student_id as studentId, status
       FROM attendance
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );
    const candidateIds = Array.from(
      new Set(
        rawAttendance
          .filter((r) =>
            ["present", "late"].includes(String(r.status || "").toLowerCase()),
          )
          .map((r) => String(r.studentId || ""))
          .filter(Boolean),
      ),
    );
    return candidateIds.filter((studentId) => {
      const student = db.getFirstSync<any>(
        `SELECT id FROM students WHERE center_id = ? AND id = ? AND deleted_at IS NULL`,
        [centerId, studentId],
      );
      return Boolean(student);
    });
  }

  private static getStatusName(
    centerId: string,
    statusId: string,
  ): string | undefined {
    return DatabaseService.getDb().getFirstSync<{ name: string }>(
      `SELECT name FROM homework_evaluation_statuses
       WHERE center_id = ? AND id = ?`,
      [centerId, statusId],
    )?.name;
  }
}
