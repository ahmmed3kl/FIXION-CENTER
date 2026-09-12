import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { Subject, Teacher, TeacherSubject } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";
import { SubjectRepository } from "../subjects/SubjectRepository";
import { TeacherRepository } from "./TeacherRepository";

export class TeacherSubjectRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    // Normalize permissions — they may be missing/malformed after JSON.parse from SecureStorage
    const user = {
      ...currentUser,
      permissions: Array.isArray(currentUser.permissions)
        ? currentUser.permissions
        : [],
    };
    return { centerId: activeCenterId, user };
  }

  static isTeacherAssignedToSubject(
    teacherId: string,
    subjectId: string,
  ): boolean {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<{ id: string }>(
      `SELECT id FROM teacher_subjects WHERE center_id = ? AND teacher_id = ? AND subject_id = ?`,
      [centerId, teacherId, subjectId],
    );

    return !!row;
  }

  static assignTeacherToSubject(
    teacherId: string,
    subjectId: string,
  ): TeacherSubject {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "teachers.update") &&
      !PermissionService.hasPermission(user.permissions, "subjects.update")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية ربط المعلم بالمادة.");
    }

    const teacher = TeacherRepository.findById(teacherId);
    if (!teacher) {
      throw new NotFoundError("المعلم غير موجود في هذا المركز.");
    }

    const subject = SubjectRepository.findById(subjectId);
    if (!subject) {
      throw new NotFoundError("المادة غير موجودة في هذا المركز.");
    }

    if (this.isTeacherAssignedToSubject(teacherId, subjectId)) {
      throw new ConflictError(
        `المعلم (${teacher.name}) مرتبط بالمادة (${subject.name}) بالفعل.`,
      );
    }

    const db = DatabaseService.getDb();
    const id = `ts-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, centerId, teacherId, subjectId, now],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-ts-assign-${Date.now()}-${id}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "teacher_subject",
      entityId: id,
      action: "teacher_subject.assign",
      payload: {
        teacherId,
        subjectId,
        teacherName: teacher.name,
        subjectName: subject.name,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "teacher_subject",
      entityId: id,
      payload: { teacherId, subjectId, createdAt: now },
    });

    return {
      id,
      centerId,
      teacherId,
      subjectId,
      createdAt: now,
      teacherName: teacher.name,
      subjectName: subject.name,
    };
  }

  static removeTeacherFromSubject(teacherId: string, subjectId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(user.permissions, "teachers.update") &&
      !PermissionService.hasPermission(user.permissions, "subjects.update")
    ) {
      throw new ForbiddenError("ليس لديك صلاحية فك ارتباط المعلم بالمادة.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<{ id: string }>(
      `SELECT id FROM teacher_subjects WHERE center_id = ? AND teacher_id = ? AND subject_id = ?`,
      [centerId, teacherId, subjectId],
    );

    if (!row) {
      throw new NotFoundError("الارتباط بين المعلم والمادة غير موجود.");
    }

    db.runSync(
      `DELETE FROM teacher_subjects WHERE center_id = ? AND teacher_id = ? AND subject_id = ?`,
      [centerId, teacherId, subjectId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-ts-remove-${Date.now()}-${row.id}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "teacher_subject",
      entityId: row.id,
      action: "teacher_subject.remove",
      payload: { teacherId, subjectId },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "DELETE",
      entityType: "teacher_subject",
      entityId: row.id,
      payload: { teacherId, subjectId },
    });
  }

  static getSubjectsForTeacher(teacherId: string): Subject[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "subjects.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المواد الدراسية.");
    }

    const db = DatabaseService.getDb();
    return db.getAllSync<Subject>(
      `SELECT s.id, s.center_id as centerId, s.name, s.code, s.status, s.created_at as createdAt, s.updated_at as updatedAt
       FROM subjects s
       JOIN teacher_subjects ts ON s.id = ts.subject_id
       WHERE ts.center_id = ? AND ts.teacher_id = ? AND s.status = 'active'
       ORDER BY s.name ASC`,
      [centerId, teacherId],
    );
  }

  static getTeachersForSubject(subjectId: string): Teacher[] {
    const { centerId, user } = this.getActiveContext();
    if (!PermissionService.hasPermission(user.permissions, "teachers.view")) {
      throw new ForbiddenError("ليس لديك صلاحية عرض بيانات المعلمين.");
    }

    const db = DatabaseService.getDb();
    return db.getAllSync<Teacher>(
      `SELECT t.id, t.center_id as centerId, t.name, t.phone, t.status, t.notes, t.created_at as createdAt, t.updated_at as updatedAt
       FROM teachers t
       JOIN teacher_subjects ts ON t.id = ts.teacher_id
       WHERE ts.center_id = ? AND ts.subject_id = ? AND t.status = 'active'
       ORDER BY t.name ASC`,
      [centerId, subjectId],
    );
  }
}
