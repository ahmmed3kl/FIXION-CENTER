import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { Group, Student } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { GroupRepository } from "../groups/GroupRepository";

export interface GradeExam {
  id: string;
  centerId: string;
  name: string;
  grade: string;
  /** Group scope for new exams. Null keeps legacy grade-wide exams readable. */
  groupId?: string | null;
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
  score: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

export class GradeBookRepository {
  private static context(required: "view" | "manage" = "view") {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    const permission = required === "manage" ? "grades.manage" : "grades.view";
    const hasPermission = PermissionService.hasPermission(currentUser.permissions, permission) ||
      PermissionService.hasPermission(currentUser.permissions, required === "manage" ? "groups.update" : "groups.view");
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
       ORDER BY s.full_name COLLATE NOCASE`,
      [centerId, groupId],
    );
  }

  static getExams(groupId: string, grade: string): GradeExam[] {
    const { centerId } = this.context();
    return DatabaseService.getDb().getAllSync<GradeExam>(
      `SELECT id, center_id as centerId, name, grade, group_id as groupId, max_score as maxScore,
              status, created_at as createdAt, updated_at as updatedAt
       FROM grade_exams WHERE center_id = ? AND grade = ? AND status = 'active'
         AND (group_id = ? OR group_id IS NULL)
       ORDER BY created_at ASC`,
      [centerId, grade, groupId],
    );
  }

  static getScores(examIds: string[], studentIds: string[]): GradeScore[] {
    const { centerId } = this.context();
    if (!examIds.length || !studentIds.length) return [];
    const exams = examIds.map(() => "?").join(",");
    const students = studentIds.map(() => "?").join(",");
    return DatabaseService.getDb().getAllSync<GradeScore>(
      `SELECT id, center_id as centerId, exam_id as examId, student_id as studentId,
              score, created_at as createdAt, updated_at as updatedAt
       FROM grade_scores WHERE center_id = ? AND exam_id IN (${exams}) AND student_id IN (${students})`,
      [centerId, ...examIds, ...studentIds],
    );
  }

  static createExam(name: string, groupId: string, grade: string, maxScore: number): GradeExam {
    const { centerId, user } = this.context("manage");
    const cleanName = name.trim();
    const cleanGrade = grade.trim();
    if (!cleanName || !cleanGrade || !Number.isFinite(maxScore) || maxScore <= 0) {
      throw new ValidationError("أدخل اسم الامتحان والصف ودرجة نهائية صحيحة.");
    }
    const now = new Date().toISOString();
    const id = `exam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const operationId = `op-grade-exam-${id}`;
    const exam: GradeExam = { id, centerId, name: cleanName, grade: cleanGrade, groupId, maxScore, status: "active", createdAt: now, updatedAt: now };
    const db = DatabaseService.getDb();
    DatabaseService.runInTransaction(() => {
      db.runSync(`INSERT INTO grade_exams (id, center_id, name, grade, group_id, max_score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`, [id, centerId, cleanName, cleanGrade, groupId, maxScore, now, now]);
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(), operationType: "CREATE", entityType: "grade_exam", entityId: id, payload: { ...exam, maxScore, groupId, createdAt: now, updatedAt: now } });
    });
    SyncEngine.syncCenterNow(centerId).catch(() => undefined);
    return exam;
  }

  static setScore(exam: GradeExam, studentId: string, value: string): GradeScore {
    const { centerId, user } = this.context("manage");
    const score = value.trim() === "" ? null : Number(value.replace(",", "."));
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > exam.maxScore)) {
      throw new ValidationError(`الدرجة يجب أن تكون بين 0 و ${exam.maxScore}.`);
    }
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<GradeScore>("SELECT id, center_id as centerId, exam_id as examId, student_id as studentId, score, created_at as createdAt, updated_at as updatedAt FROM grade_scores WHERE center_id = ? AND exam_id = ? AND student_id = ?", [centerId, exam.id, studentId]);
    const now = new Date().toISOString();
    const id = existing?.id || `score-${exam.id}-${studentId}`;
    // Keep the outbox key below PostgreSQL's VARCHAR(64) limit. The exam and
    // student IDs are already carried in the payload for reconciliation.
    const operationId = `op-grade-score-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result: GradeScore = { id, centerId, examId: exam.id, studentId, score, createdAt: existing?.createdAt || now, updatedAt: now };
    DatabaseService.runInTransaction(() => {
      db.runSync(`INSERT INTO grade_scores (id, center_id, exam_id, student_id, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`, [id, centerId, exam.id, studentId, score, result.createdAt, now]);
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(), operationType: existing ? "UPDATE" : "CREATE", entityType: "grade_score", entityId: id, payload: { ...result, examId: exam.id, studentId, score, updatedAt: now } });
    });
    SyncEngine.syncCenterNow(centerId).catch(() => undefined);
    return result;
  }
}
