import { AuditService } from "../../core/audit";
import { DatabaseService } from "../../core/database";
import { DeviceService } from "../../core/device";
import {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../../core/errors";
import { PermissionService } from "../../core/permissions";
import { SyncRepository } from "../../core/sync";
import { StudentCard } from "../../shared/types";
import { useAuthStore } from "../auth/useAuthStore";

export class StudentCardRepository {
  private static getActiveContext() {
    const { activeCenterId, currentUser } = useAuthStore.getState();
    if (!activeCenterId || !currentUser) {
      throw new UnauthorizedError("يجب تسجيل الدخول وتحديد المركز.");
    }
    return { centerId: activeCenterId, user: currentUser };
  }

  static findByCardCode(normalizedCardCode: string): StudentCard | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, card_code as cardCode,
              status, issued_at as issuedAt, deactivated_at as deactivatedAt, created_at as createdAt
       FROM student_cards
       WHERE center_id = ? AND card_code = ? AND status = 'active'`,
      [centerId, normalizedCardCode],
    );

    return row || null;
  }

  static getActiveCardByStudentId(studentId: string): StudentCard | null {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, card_code as cardCode,
              status, issued_at as issuedAt, deactivated_at as deactivatedAt, created_at as createdAt
       FROM student_cards
       WHERE center_id = ? AND student_id = ? AND status = 'active'`,
      [centerId, studentId],
    );

    return row || null;
  }

  static getCardsByStudentId(studentId: string): StudentCard[] {
    const { centerId } = this.getActiveContext();
    const db = DatabaseService.getDb();

    return db.getAllSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, card_code as cardCode,
              status, issued_at as issuedAt, deactivated_at as deactivatedAt, created_at as createdAt
       FROM student_cards
       WHERE center_id = ? AND student_id = ?
       ORDER BY created_at DESC`,
      [centerId, studentId],
    );
  }

  static issueCard(studentId: string, cardCode: string): StudentCard {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(
        user.permissions,
        "students.cards.manage",
      )
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إدارة وإصدار بطاقات الطلاب.");
    }

    if (!cardCode || !cardCode.trim()) {
      throw new ValidationError("كود البطاقة مطلوب ولا يمكن أن يكون فارغًا.");
    }

    const trimmedCard = cardCode.trim();
    const db = DatabaseService.getDb();

    // Check if card code is already active in center
    const existing = this.findByCardCode(trimmedCard);
    if (existing) {
      throw new ConflictError(
        `البطاقة رقم (${trimmedCard}) مخصصة لطالب آخر بالفعل ومفعلة.`,
      );
    }

    const now = new Date().toISOString();
    // Deactivate any currently active cards for this student
    const activeCurrent = this.getActiveCardByStudentId(studentId);
    if (activeCurrent) {
      db.runSync(
        `UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE id = ?`,
        [now, activeCurrent.id],
      );
    }

    const cardId = `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    db.runSync(
      `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [cardId, centerId, studentId, trimmedCard, now, now],
    );

    // Keep students.card_code synchronized for legacy readers
    db.runSync(
      `UPDATE students SET card_code = ?, updated_at = ? WHERE id = ?`,
      [trimmedCard, now, studentId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-card-issue-${Date.now()}-${cardId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student_card",
      entityId: cardId,
      action: "student_card.issue",
      payload: {
        studentId,
        cardCode: trimmedCard,
        previousCardId: activeCurrent?.id,
      },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "CREATE",
      entityType: "student_card",
      entityId: cardId,
      payload: { studentId, cardCode: trimmedCard, issuedAt: now },
    });

    return {
      id: cardId,
      centerId,
      studentId,
      cardCode: trimmedCard,
      status: "active",
      issuedAt: now,
      createdAt: now,
    };
  }

  static replaceCard(studentId: string, newCardCode: string): StudentCard {
    return this.issueCard(studentId, newCardCode);
  }

  static deactivateCard(cardId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(
        user.permissions,
        "students.cards.manage",
      )
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إلغاء تفعيل بطاقة الطالب.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id, student_id as studentId, card_code as cardCode FROM student_cards WHERE center_id = ? AND id = ?`,
      [centerId, cardId],
    );

    if (!row) {
      throw new NotFoundError("البطاقة غير موجودة.");
    }

    const now = new Date().toISOString();
    db.runSync(
      `UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE id = ?`,
      [now, cardId],
    );

    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-card-deact-${Date.now()}-${cardId}`;

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student_card",
      entityId: cardId,
      action: "student_card.deactivate",
      payload: { studentId: row.studentId, cardCode: row.cardCode },
    });

    SyncRepository.enqueueOperation({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      operationType: "UPDATE",
      entityType: "student_card",
      entityId: cardId,
      payload: { status: "inactive", deactivatedAt: now },
    });
  }
}
