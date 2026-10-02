import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { UnauthorizedError, ValidationError } from "../../core/errors";
import { StudentNote } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

function context() {
  const { activeCenterId, currentUser } = useAuthStore.getState();
  if (!activeCenterId || !currentUser) throw new UnauthorizedError("يجب تسجيل الدخول أولاً.");
  return { centerId: activeCenterId, user: currentUser };
}

function map(row: any): StudentNote {
  return {
    id: row.id, centerId: row.centerId, studentId: row.studentId, text: row.text,
    createdAt: row.createdAt, updatedAt: row.updatedAt || null,
    createdBy: row.createdBy, createdByName: row.createdByName || null,
    updatedBy: row.updatedBy || null, deletedAt: row.deletedAt || null,
  };
}

export class StudentNoteRepository {
  static listForStudent(studentId: string): StudentNote[] {
    const { centerId } = context();
    return DatabaseService.getDb().getAllSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, note_text as text,
              created_at as createdAt, updated_at as updatedAt, created_by as createdBy,
              created_by_name as createdByName, updated_by as updatedBy, deleted_at as deletedAt
       FROM student_notes WHERE center_id = ? AND student_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`, [centerId, studentId],
    ).map(map);
  }

  static create(studentId: string, text: string): StudentNote {
    const { centerId, user } = context();
    if (!text.trim()) throw new ValidationError("نص الملاحظة مطلوب.");
    const now = new Date().toISOString();
    const id = `snote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const operationId = `op-snote-create-${id}`;
    DatabaseService.getDb().runSync(
      `INSERT INTO student_notes (id, center_id, student_id, note_text, created_at, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, centerId, studentId, text.trim(), now, user.id, user.fullName],
    );
    AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(), entityType: "student_note", entityId: id, action: "student.note.create", payload: { studentId, text: text.trim(), actorName: user.fullName } });
    DatabaseService.notifyLocalChange({ centerId, entityType: "student_note", entityId: id });
    return { id, centerId, studentId, text: text.trim(), createdAt: now, createdBy: user.id, createdByName: user.fullName };
  }

  static update(noteId: string, text: string): StudentNote {
    const { centerId, user } = context();
    if (!text.trim()) throw new ValidationError("نص الملاحظة مطلوب.");
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>("SELECT * FROM student_notes WHERE center_id = ? AND id = ? AND deleted_at IS NULL", [centerId, noteId]);
    if (!existing) throw new Error("الملاحظة غير موجودة.");
    const now = new Date().toISOString();
    db.runSync("UPDATE student_notes SET note_text = ?, updated_at = ?, updated_by = ? WHERE center_id = ? AND id = ?", [text.trim(), now, user.id, centerId, noteId]);
    AuditService.recordEvent({ operationId: `op-snote-update-${noteId}-${Date.now()}`, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(), entityType: "student_note", entityId: noteId, action: "student.note.update", payload: { studentId: existing.student_id, text: text.trim(), actorName: user.fullName } });
    DatabaseService.notifyLocalChange({ centerId, entityType: "student_note", entityId: noteId });
    return map({ ...existing, centerId, studentId: existing.student_id, text: text.trim(), updatedAt: now, updatedBy: user.id, createdByName: existing.created_by_name });
  }

  static remove(noteId: string): void {
    const { centerId, user } = context();
    const db = DatabaseService.getDb();
    const existing = db.getFirstSync<any>("SELECT * FROM student_notes WHERE center_id = ? AND id = ? AND deleted_at IS NULL", [centerId, noteId]);
    if (!existing) throw new Error("الملاحظة غير موجودة.");
    const now = new Date().toISOString();
    db.runSync("UPDATE student_notes SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE center_id = ? AND id = ?", [now, now, user.id, centerId, noteId]);
    AuditService.recordEvent({ operationId: `op-snote-delete-${noteId}-${Date.now()}`, centerId, userId: user.id, deviceId: DeviceService.getDeviceIdSync(), entityType: "student_note", entityId: noteId, action: "student.note.delete", payload: { studentId: existing.student_id, actorName: user.fullName } });
    DatabaseService.notifyLocalChange({ centerId, entityType: "student_note", entityId: noteId });
  }
}
