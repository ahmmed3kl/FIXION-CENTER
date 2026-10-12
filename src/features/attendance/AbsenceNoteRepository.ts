import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { useAuthStore } from "../auth/useAuthStore";

export interface AbsenceNote {
  id: string;
  centerId: string;
  sessionId: string;
  studentId: string;
  text: string;
  createdAt: string;
  updatedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  updatedBy: string | null;
}

function getActiveContext() {
  const { activeCenterId, currentUser } = useAuthStore.getState();
  if (!activeCenterId || !currentUser) {
    throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
  }
  return { centerId: activeCenterId, user: currentUser };
}

function getEditContext() {
  const context = getActiveContext();
  const { user } = context;
  if (!PermissionService.hasPermission(user.permissions, "attendance.edit")) {
    throw new ForbiddenError("ليس لديك صلاحية إضافة ملاحظات الغياب.");
  }
  return context;
}

function mapNote(row: any): AbsenceNote {
  return {
    id: row.id,
    centerId: row.centerId,
    sessionId: row.sessionId,
    studentId: row.studentId,
    text: row.text,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || null,
    createdBy: row.createdBy,
    createdByName: row.createdByName || null,
    updatedBy: row.updatedBy || null,
  };
}

export class AbsenceNoteRepository {
  static getForSession(sessionId: string): AbsenceNote[] {
    const { centerId, user } = getActiveContext();
    if (!PermissionService.hasAnyPermission(user.permissions, ["attendance.view", "reports.attendance.view", "reports.view"])) {
      throw new ForbiddenError("ليس لديك صلاحية عرض ملاحظات الغياب.");
    }
    return DatabaseService.getDb().getAllSync<any>(
      `SELECT id, center_id as centerId, session_id as sessionId,
              student_id as studentId, note_text as text, created_at as createdAt,
              updated_at as updatedAt, created_by as createdBy,
              created_by_name as createdByName, updated_by as updatedBy
       FROM absence_notes WHERE center_id = ? AND session_id = ?`,
      [centerId, sessionId],
    ).map(mapNote);
  }

  static save(sessionId: string, studentId: string, text: string): AbsenceNote {
    const { centerId, user } = getEditContext();
    const noteText = text.trim();
    if (!noteText) throw new ValidationError("اكتب ملاحظة قبل الحفظ.");

    const db = DatabaseService.getDb();
    const target = db.getFirstSync<any>(
      `SELECT s.id as sessionId, s.status as sessionStatus,
              st.id as studentId, st.status as studentStatus,
              st.deleted_at as deletedAt
       FROM sessions s
       JOIN session_expected_students expected
         ON expected.center_id = s.center_id AND expected.session_id = s.id
        AND expected.student_id = ?
       JOIN students st ON st.center_id = s.center_id AND st.id = expected.student_id
       WHERE s.center_id = ? AND s.id = ?`,
      [studentId, centerId, sessionId],
    );
    if (
      !target ||
      target.deletedAt ||
      target.studentStatus === "deleted" ||
      (target.sessionStatus !== "open" && target.sessionStatus !== "closed")
    ) {
      throw new ConflictError("الطالب أو الجلسة غير صالحين لتسجيل ملاحظة الغياب.");
    }

    const existingAttendance = db.getFirstSync<any>(
      `SELECT status, attendance_type as attendanceType
       FROM attendance WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    if (
      existingAttendance &&
      existingAttendance.attendanceType !== "makeup" &&
      ["present", "late"].includes(String(existingAttendance.status).toLowerCase())
    ) {
      throw new ConflictError("لا يمكن إضافة ملاحظة غياب لطالب مسجل حضوره في هذه الجلسة.");
    }
    const advanceCoverage = db.getFirstSync<any>(
      `SELECT id FROM advance_coverages
       WHERE center_id = ? AND student_id = ? AND target_future_session_id = ?`,
      [centerId, studentId, sessionId],
    );
    if (advanceCoverage) {
      throw new ConflictError("الطالب مغطى بتعويض مسبق في هذه الجلسة.");
    }

    const previous = db.getFirstSync<any>(
      `SELECT id, created_at as createdAt, created_by as createdBy,
              created_by_name as createdByName
       FROM absence_notes
       WHERE center_id = ? AND session_id = ? AND student_id = ?`,
      [centerId, sessionId, studentId],
    );
    const now = new Date().toISOString();
    const id = previous?.id || `absence-note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const operationId = `op-absence-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const createdAt = previous?.createdAt || now;
    const createdBy = previous?.createdBy || user.id;
    const createdByName = previous?.createdByName || user.fullName;

    DatabaseService.runInTransaction(() => {
      if (previous) {
        db.runSync(
          `UPDATE absence_notes SET note_text = ?, updated_at = ?, updated_by = ?
           WHERE center_id = ? AND id = ?`,
          [noteText, now, user.id, centerId, id],
        );
      } else {
        db.runSync(
          `INSERT INTO absence_notes
            (id, center_id, session_id, student_id, note_text, created_at,
             updated_at, created_by, created_by_name, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, centerId, sessionId, studentId, noteText, now, now, user.id, user.fullName, user.id],
        );
      }
      const payload = {
        id,
        centerId,
        sessionId,
        studentId,
        text: noteText,
        createdAt,
        updatedAt: now,
        createdBy,
        createdByName,
        updatedBy: user.id,
      };
      SyncRepository.enqueueOperation({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        operationType: "absence_note.upsert",
        entityType: "absence_note",
        entityId: id,
        payload,
      });
      AuditService.recordEvent({
        operationId,
        centerId,
        userId: user.id,
        deviceId,
        entityType: "absence_note",
        entityId: id,
        action: "absence.note.upsert",
        payload: { sessionId, studentId, actorName: user.fullName },
      });
      DatabaseService.notifyLocalChange({ centerId, entityType: "absence_note", entityId: id });
    });

    SyncEngine.syncCenterNow(centerId).catch((error) => {
      console.warn("Background auto-sync absence note notice:", error);
    });

    return {
      id,
      centerId,
      sessionId,
      studentId,
      text: noteText,
      createdAt,
      updatedAt: now,
      createdBy,
      createdByName,
      updatedBy: user.id,
    };
  }
}
