import { AuditService } from "../../core/audit";
import { DatabaseService, LocalDataEvents } from "../../core/database";
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
import { AttendanceType, Group, Student } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "../groups/GroupRepository";
import {
  extractTime24InCairo,
  formatSessionDateArabic,
  formatSessionTimeRangeArabic,
  normalizeSessionDateOnly,
} from "../homework/HomeworkEvaluationRepository";

export interface GradeExam {
  id: string;
  centerId: string;
  name: string;
  grade: string;
  /** Group scope for new exams. Null keeps legacy grade-wide exams readable. */
  groupId?: string | null;
  sessionId?: string | null;
  maxScore: number;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt?: string | null;
}

export interface GradeScore {
  id: string;
  centerId: string;
  examId: string;
  studentId: string;
  sessionId?: string | null;
  score: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface SessionGradeOption {
  id: string;
  groupId: string;
  sessionNumber: number;
  sessionOrdinalTitle: string;
  sessionDate: string;
  sessionDateFormatted: string;
  startTime: string;
  endTime: string;
  sessionTimeLabel: string;
  status: string;
  sessionStatusLabel: string;
}

export interface SessionGradeStudentItem {
  studentId: string;
  studentName: string;
  studentCode: string;
  attendanceId: string;
  attendanceStatus: "present" | "late";
  attendanceType: AttendanceType;
  isMakeup: boolean;
  gradeState: "graded" | "ungraded";
  score: number | null;
  scoreUpdatedAt: string | null;
}

export interface SessionGradeRoster {
  exam: GradeExam;
  session: SessionGradeOption;
  stats: {
    totalEligible: number;
    gradedCount: number;
    ungradedCount: number;
  };
  gradedStudents: SessionGradeStudentItem[];
  ungradedStudents: SessionGradeStudentItem[];
}

const SESSION_ORDINAL_TITLES = [
  "الحصة الأولى",
  "الحصة الثانية",
  "الحصة الثالثة",
  "الحصة الرابعة",
  "الحصة الخامسة",
  "الحصة السادسة",
  "الحصة السابعة",
  "الحصة الثامنة",
  "الحصة التاسعة",
  "الحصة العاشرة",
];

function getSessionOrdinalTitle(sessionNumber: number): string {
  if (sessionNumber >= 1 && sessionNumber <= SESSION_ORDINAL_TITLES.length) {
    return SESSION_ORDINAL_TITLES[sessionNumber - 1];
  }
  return `الحصة رقم ${sessionNumber}`;
}

function getSessionStatusLabel(status: string): string {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "open") return "مفتوحة";
  if (normalized === "closed" || normalized === "completed") return "مغلقة";
  return "مجدولة";
}

export class GradeBookRepository {
  private static context(required: "view" | "manage" = "view") {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser)
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    const permission = required === "manage" ? "grades.manage" : "grades.view";
    const hasPermission =
      PermissionService.hasPermission(currentUser.permissions, permission) ||
      PermissionService.hasPermission(
        currentUser.permissions,
        required === "manage" ? "groups.update" : "groups.view",
      );
    if (!hasPermission) {
      throw new ForbiddenError("ليس لديك صلاحية الوصول إلى رصد الدرجات.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  static getGroups(): Group[] {
    this.context();
    return GroupRepository.getAll().filter((group) => group.status === "active");
  }

  static getStudentsForGroup(groupId: string): Student[] {
    const { centerId } = this.context();
    const db = DatabaseService.getDb();
    return db.getAllSync<Student>(
      `SELECT s.id, s.center_id as centerId, s.student_code as studentCode,
              s.full_name as fullName, s.card_code as cardCode, s.phone,
              s.parent_phone as parentPhone, s.grade, s.status,
              s.student_type as studentType, s.notes, s.created_at as createdAt,
              s.updated_at as updatedAt
       FROM students s
       JOIN student_group_enrollments e ON e.student_id = s.id AND e.center_id = s.center_id
       WHERE s.center_id = ? AND e.group_id = ? AND e.status = 'active' AND s.status = 'active'
         AND s.deleted_at IS NULL
       ORDER BY s.full_name COLLATE NOCASE`,
      [centerId, groupId],
    );
  }

  static getExams(groupId: string, grade: string): GradeExam[] {
    const { centerId } = this.context();
    return DatabaseService.getDb().getAllSync<GradeExam>(
      `SELECT id, center_id as centerId, name, grade, group_id as groupId, session_id as sessionId, max_score as maxScore,
              status, created_at as createdAt, updated_at as updatedAt
       FROM grade_exams WHERE center_id = ? AND grade = ? AND status = 'active'
         AND (group_id = ? OR group_id IS NULL)
       ORDER BY created_at ASC`,
      [centerId, grade, groupId],
    );
  }

  static getSessionsForGroup(
    groupId: string,
  ): Array<{ id: string; sessionDate: string; startTime: string }> {
    const { centerId } = this.context();
    return DatabaseService.getDb().getAllSync(
      `SELECT id, session_date as sessionDate, start_time as startTime
       FROM sessions
       WHERE center_id = ? AND group_id = ? AND status != 'cancelled'
       ORDER BY session_date DESC, start_time DESC`,
      [centerId, groupId],
    );
  }

  /**
   * Returns active/non-cancelled sessions belonging strictly to the selected
   * group in chronological order (oldest first) for session-based grading.
   */
  static getSessionsForGroupChronological(
    groupId: string,
  ): SessionGradeOption[] {
    const { centerId } = this.context();
    const db = DatabaseService.getDb();
    const rows = db.getAllSync<any>(
      `SELECT id, group_id as groupId, session_date as sessionDate,
              start_time as startTime, end_time as endTime, status,
              created_at as createdAt
       FROM sessions
       WHERE center_id = ? AND group_id = ? AND status != 'cancelled'`,
      [centerId, groupId],
    );

    const sorted = [...rows].sort((a, b) => {
      const dateA = normalizeSessionDateOnly(a.sessionDate);
      const dateB = normalizeSessionDateOnly(b.sessionDate);
      if (dateA !== dateB) return dateA.localeCompare(dateB);

      const timeA = extractTime24InCairo(a.startTime)?.canonical24 || "";
      const timeB = extractTime24InCairo(b.startTime)?.canonical24 || "";
      if (timeA !== timeB) return timeA.localeCompare(timeB);

      const createdA = String(a.createdAt || "");
      const createdB = String(b.createdAt || "");
      if (createdA !== createdB) return createdA.localeCompare(createdB);

      return String(a.id).localeCompare(String(b.id));
    });

    return sorted.map((row, idx) => {
      const sessionNumber = idx + 1;
      const startTime = String(row.startTime || "");
      const endTime = String(row.endTime || "");
      return {
        id: String(row.id),
        groupId: String(row.groupId || groupId),
        sessionNumber,
        sessionOrdinalTitle: getSessionOrdinalTitle(sessionNumber),
        sessionDate: normalizeSessionDateOnly(row.sessionDate),
        sessionDateFormatted: formatSessionDateArabic(row.sessionDate),
        startTime,
        endTime,
        sessionTimeLabel: formatSessionTimeRangeArabic(startTime, endTime),
        status: String(row.status || "scheduled"),
        sessionStatusLabel: getSessionStatusLabel(row.status),
      };
    });
  }

  /**
   * Loads only students who actually attended the selected session (present,
   * eligible late, or makeup attendees in this exact host session) and separates
   * already-graded students (first) from ungraded students (below).
   * Read-only: never creates or modifies attendance records.
   */
  static getSessionGradeRoster(
    examId: string,
    sessionId: string,
  ): SessionGradeRoster {
    const { centerId } = this.context();
    const db = DatabaseService.getDb();

    const exam = db.getFirstSync<GradeExam>(
      `SELECT id, center_id as centerId, name, grade, group_id as groupId,
              session_id as sessionId, max_score as maxScore, status,
              created_at as createdAt, updated_at as updatedAt
       FROM grade_exams
       WHERE center_id = ? AND id = ? AND status = 'active'`,
      [centerId, examId],
    );
    if (!exam) {
      throw new NotFoundError("الامتحان غير موجود أو غير نشط في هذا المركز.");
    }

    const sessionRow = db.getFirstSync<any>(
      `SELECT id, group_id as groupId, session_date as sessionDate,
              start_time as startTime, end_time as endTime, status
       FROM sessions
       WHERE center_id = ? AND id = ? AND status != 'cancelled'`,
      [centerId, sessionId],
    );
    if (!sessionRow) {
      throw new NotFoundError("الحصة غير موجودة في هذا المركز.");
    }

    const sessionGroupId = String(sessionRow.groupId || "");
    if (exam.groupId && exam.groupId !== sessionGroupId) {
      throw new ValidationError("الحصة المختارة لا تتبع مجموعة هذا الامتحان.");
    }

    const chronological = sessionGroupId
      ? this.getSessionsForGroupChronological(sessionGroupId)
      : [];
    const matchedSession =
      chronological.find((item) => item.id === sessionId) || {
        id: String(sessionRow.id),
        groupId: sessionGroupId,
        sessionNumber: 1,
        sessionOrdinalTitle: getSessionOrdinalTitle(1),
        sessionDate: normalizeSessionDateOnly(sessionRow.sessionDate),
        sessionDateFormatted: formatSessionDateArabic(sessionRow.sessionDate),
        startTime: String(sessionRow.startTime || ""),
        endTime: String(sessionRow.endTime || ""),
        sessionTimeLabel: formatSessionTimeRangeArabic(
          sessionRow.startTime,
          sessionRow.endTime,
        ),
        status: String(sessionRow.status || "scheduled"),
        sessionStatusLabel: getSessionStatusLabel(sessionRow.status),
      };

    // Read existing attendance records strictly for this center and exact session
    const attendanceRows = db.getAllSync<any>(
      `SELECT id, student_id as studentId, status, attendance_type as attendanceType
       FROM attendance
       WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    );

    const eligibleMap = new Map<
      string,
      {
        attendanceId: string;
        attendanceStatus: "present" | "late";
        attendanceType: AttendanceType;
      }
    >();
    for (const att of attendanceRows) {
      const sid = String(att.studentId || "");
      const st = String(att.status || "").toLowerCase();
      if (!sid) continue;
      if (st === "present" || st === "late") {
        const attendanceType = (att.attendanceType || "present") as AttendanceType;
        eligibleMap.set(sid, {
          attendanceId: String(att.id || ""),
          attendanceStatus: st as "present" | "late",
          attendanceType,
        });
      }
    }

    const eligibleIds = Array.from(eligibleMap.keys());
    if (eligibleIds.length === 0) {
      return {
        exam,
        session: matchedSession,
        stats: { totalEligible: 0, gradedCount: 0, ungradedCount: 0 },
        gradedStudents: [],
        ungradedStudents: [],
      };
    }

    const placeholders = eligibleIds.map(() => "?").join(",");
    const studentRows = db.getAllSync<any>(
      `SELECT id, full_name as fullName, student_code as studentCode
       FROM students
       WHERE center_id = ? AND id IN (${placeholders}) AND status = 'active' AND deleted_at IS NULL
       ORDER BY full_name COLLATE NOCASE ASC, student_code ASC, id ASC`,
      [centerId, ...eligibleIds],
    );

    const scoreRows = db.getAllSync<GradeScore>(
      `SELECT id, center_id as centerId, exam_id as examId, student_id as studentId,
              session_id as sessionId, score, created_at as createdAt, updated_at as updatedAt
       FROM grade_scores
       WHERE center_id = ? AND exam_id = ? AND student_id IN (${placeholders})`,
      [centerId, examId, ...eligibleIds],
    );
    const scoreByStudent = new Map<string, GradeScore>();
    for (const row of scoreRows) {
      scoreByStudent.set(String(row.studentId), row);
    }

    const gradedStudents: SessionGradeStudentItem[] = [];
    const ungradedStudents: SessionGradeStudentItem[] = [];

    for (const student of studentRows) {
      const studentId = String(student.id);
      const att = eligibleMap.get(studentId);
      if (!att) continue;

      const existingScore = scoreByStudent.get(studentId);
      const belongsToOtherSession = Boolean(
        existingScore?.sessionId && existingScore.sessionId !== sessionId,
      );
      const hasSavedGradeInSession =
        !belongsToOtherSession &&
        existingScore !== undefined &&
        existingScore.score !== null &&
        existingScore.score !== undefined &&
        Number.isFinite(Number(existingScore.score));

      const baseItem = {
        studentId,
        studentName: String(student.fullName || ""),
        studentCode: String(student.studentCode || ""),
        attendanceId: att.attendanceId,
        attendanceStatus: att.attendanceStatus,
        attendanceType: att.attendanceType,
        isMakeup: att.attendanceType === "makeup",
      };

      if (hasSavedGradeInSession && existingScore) {
        gradedStudents.push({
          ...baseItem,
          gradeState: "graded",
          score: Number(existingScore.score),
          scoreUpdatedAt: existingScore.updatedAt || existingScore.createdAt,
        });
      } else {
        ungradedStudents.push({
          ...baseItem,
          gradeState: "ungraded",
          score: null,
          scoreUpdatedAt: null,
        });
      }
    }

    return {
      exam,
      session: matchedSession,
      stats: {
        totalEligible: gradedStudents.length + ungradedStudents.length,
        gradedCount: gradedStudents.length,
        ungradedCount: ungradedStudents.length,
      },
      gradedStudents,
      ungradedStudents,
    };
  }

  static getSessionDate(sessionId: string): string | null {
    const { centerId } = this.context();
    return (
      DatabaseService.getDb().getFirstSync<{ sessionDate: string }>(
        "SELECT session_date as sessionDate FROM sessions WHERE center_id = ? AND id = ?",
        [centerId, sessionId],
      )?.sessionDate || null
    );
  }

  static getScores(examIds: string[], studentIds: string[]): GradeScore[] {
    const { centerId } = this.context();
    if (!examIds.length || !studentIds.length) return [];
    const exams = examIds.map(() => "?").join(",");
    const students = studentIds.map(() => "?").join(",");
    return DatabaseService.getDb().getAllSync<GradeScore>(
      `SELECT id, center_id as centerId, exam_id as examId, student_id as studentId,
              session_id as sessionId, score, created_at as createdAt, updated_at as updatedAt
       FROM grade_scores WHERE center_id = ? AND exam_id IN (${exams}) AND student_id IN (${students})`,
      [centerId, ...examIds, ...studentIds],
    );
  }

  static createExam(
    name: string,
    groupId: string,
    grade: string,
    maxScore: number,
    sessionId?: string | null,
  ): GradeExam {
    const { centerId, user } = this.context("manage");
    const cleanName = name.trim();
    const cleanGrade = grade.trim();
    if (
      !cleanName ||
      !cleanGrade ||
      !Number.isFinite(maxScore) ||
      maxScore <= 0
    ) {
      throw new ValidationError(
        "أدخل اسم الامتحان والصف ودرجة نهائية صحيحة.",
      );
    }
    if (sessionId) {
      const session = DatabaseService.getDb().getFirstSync<any>(
        "SELECT id FROM sessions WHERE center_id = ? AND id = ? AND group_id = ?",
        [centerId, sessionId, groupId],
      );
      if (!session)
        throw new ValidationError("الحصة المختارة لا تتبع هذه المجموعة.");
    }
    const now = new Date().toISOString();
    const id = `exam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const operationId = `op-grade-exam-${id}`;
    const exam: GradeExam = {
      id,
      centerId,
      name: cleanName,
      grade: cleanGrade,
      groupId,
      sessionId: sessionId || null,
      maxScore,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const db = DatabaseService.getDb();
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO grade_exams (id, center_id, name, grade, group_id, session_id, max_score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          id,
          centerId,
          cleanName,
          cleanGrade,
          groupId,
          sessionId || null,
          maxScore,
          now,
          now,
        ],
      );
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: "CREATE",
        entityType: "grade_exam",
        entityId: id,
        payload: {
          ...exam,
          maxScore,
          groupId,
          sessionId: sessionId || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "grade_exam",
        entityId: id,
        action: "grade.exam.create",
        payload: { name: cleanName, groupId, actorName: user.fullName },
      });
    });
    LocalDataEvents.emit({ entityType: "grade_exam", entityId: id, centerId });
    SyncEngine.syncCenterNow(centerId).catch(() => undefined);
    return exam;
  }

  static setScore(
    exam: GradeExam,
    studentId: string,
    value: string,
  ): GradeScore {
    const { centerId, user } = this.context("manage");
    const score = value.trim() === "" ? null : Number(value.replace(",", "."));
    if (
      score !== null &&
      (!Number.isFinite(score) || score < 0 || score > exam.maxScore)
    ) {
      throw new ValidationError(`الدرجة يجب أن تكون بين 0 و ${exam.maxScore}.`);
    }
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<GradeScore>(
      "SELECT id, center_id as centerId, exam_id as examId, student_id as studentId, session_id as sessionId, score, created_at as createdAt, updated_at as updatedAt FROM grade_scores WHERE center_id = ? AND exam_id = ? AND student_id = ?",
      [centerId, exam.id, studentId],
    );
    const now = new Date().toISOString();
    const id = existing?.id || `score-${exam.id}-${studentId}`;
    // Keep the outbox key below PostgreSQL's VARCHAR(64) limit. The exam and
    // student IDs are already carried in the payload for reconciliation.
    const operationId = `op-grade-score-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result: GradeScore = {
      id,
      centerId,
      examId: exam.id,
      studentId,
      sessionId: existing?.sessionId ?? exam.sessionId ?? null,
      score,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO grade_scores (id, center_id, exam_id, student_id, session_id, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET score = excluded.score, session_id = COALESCE(grade_scores.session_id, excluded.session_id), updated_at = excluded.updated_at`,
        [
          id,
          centerId,
          exam.id,
          studentId,
          result.sessionId || null,
          score,
          result.createdAt,
          now,
        ],
      );
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: existing ? "UPDATE" : "CREATE",
        entityType: "grade_score",
        entityId: id,
        payload: {
          ...result,
          examId: exam.id,
          studentId,
          sessionId: result.sessionId || null,
          score,
          updatedAt: now,
        },
      });
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "grade_score",
        entityId: id,
        action: "grade.score.save",
        payload: {
          examId: exam.id,
          studentId,
          sessionId: result.sessionId || null,
          score,
          actorName: user.fullName,
        },
      });
    });
    LocalDataEvents.emit({ entityType: "grade_score", entityId: id, centerId });
    SyncEngine.syncCenterNow(centerId).catch(() => undefined);
    return result;
  }

  /**
   * Session-validated grade recording: verifies center, exam, session, and
   * actual attendance eligibility (present, late, or host-session makeup),
   * prevents overwriting grades recorded in another session, and prevents
   * duplicate grade records via deterministic conflict handling.
   */
  static setSessionScore(
    exam: GradeExam,
    sessionId: string,
    studentId: string,
    value: string,
  ): GradeScore {
    const { centerId, user } = this.context("manage");
    if (!sessionId) {
      throw new ValidationError("يجب اختيار الجلسة قبل رصد الدرجة.");
    }

    const db = DatabaseService.getDb();

    const examRow = db.getFirstSync<GradeExam>(
      `SELECT id, center_id as centerId, name, grade, group_id as groupId,
              session_id as sessionId, max_score as maxScore, status,
              created_at as createdAt, updated_at as updatedAt
       FROM grade_exams
       WHERE center_id = ? AND id = ? AND status = 'active'`,
      [centerId, exam.id],
    );
    if (!examRow) {
      throw new NotFoundError("الامتحان غير موجود أو غير نشط في هذا المركز.");
    }

    const sessionRow = db.getFirstSync<any>(
      `SELECT id, group_id as groupId, status
       FROM sessions
       WHERE center_id = ? AND id = ? AND status != 'cancelled'`,
      [centerId, sessionId],
    );
    if (!sessionRow) {
      throw new NotFoundError("الجلسة المختارة غير موجودة في هذا المركز.");
    }

    if (examRow.groupId && examRow.groupId !== sessionRow.groupId) {
      throw new ValidationError("الجلسة المختارة لا تتبع مجموعة هذا الامتحان.");
    }

    const attendanceRows = db.getAllSync<any>(
      `SELECT id, status
       FROM attendance
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    const isEligibleAttendee = attendanceRows.some((row) => {
      const st = String(row.status || "").toLowerCase();
      return st === "present" || st === "late";
    });
    if (!isEligibleAttendee) {
      throw new ValidationError(
        "لا يمكن رصد درجة لطالب لم يسجل حضوره الفعلي في هذه الجلسة.",
      );
    }

    const score = value.trim() === "" ? null : Number(value.replace(",", "."));
    if (
      score !== null &&
      (!Number.isFinite(score) || score < 0 || score > examRow.maxScore)
    ) {
      throw new ValidationError(
        `الدرجة يجب أن تكون بين 0 و ${examRow.maxScore}.`,
      );
    }

    const existing = db.getFirstSync<GradeScore>(
      `SELECT id, center_id as centerId, exam_id as examId, student_id as studentId,
              session_id as sessionId, score, created_at as createdAt, updated_at as updatedAt
       FROM grade_scores
       WHERE center_id = ? AND exam_id = ? AND student_id = ?`,
      [centerId, examRow.id, studentId],
    );

    if (existing?.sessionId && existing.sessionId !== sessionId) {
      throw new ConflictError(
        "تم رصد درجة لهذا الطالب في هذا الامتحان ضمن جلسة أخرى، ولا يمكن استبدالها من جلسة مختلفة.",
      );
    }

    const now = new Date().toISOString();
    const id = existing?.id || `score-${examRow.id}-${studentId}`;
    // Compact operation ID (< 64 chars) — stable for outbox/retry without truncation
    const operationId = `op-gs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result: GradeScore = {
      id,
      centerId,
      examId: examRow.id,
      studentId,
      sessionId,
      score,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    DatabaseService.runInTransaction(() => {
      db.runSync(
        `INSERT INTO grade_scores (id, center_id, exam_id, student_id, session_id, score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET
           score = excluded.score,
           session_id = COALESCE(grade_scores.session_id, excluded.session_id),
           updated_at = excluded.updated_at`,
        [
          id,
          centerId,
          examRow.id,
          studentId,
          sessionId,
          score,
          result.createdAt,
          now,
        ],
      );
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        operationType: existing ? "UPDATE" : "CREATE",
        entityType: "grade_score",
        entityId: id,
        payload: {
          ...result,
          examId: examRow.id,
          studentId,
          sessionId,
          score,
          updatedAt: now,
        },
      });
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId: DeviceService.getDeviceIdSync(),
        entityType: "grade_score",
        entityId: id,
        action: "grade.score.session.save",
        payload: {
          examId: examRow.id,
          sessionId,
          studentId,
          score,
          actorName: user.fullName,
        },
      });
    });
    LocalDataEvents.emit({ entityType: "grade_score", entityId: id, centerId });
    SyncEngine.syncCenterNow(centerId).catch(() => undefined);
    return result;
  }
}
