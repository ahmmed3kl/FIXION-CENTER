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
       WHERE center_id = ? AND card_code = ? AND status = 'active'
       ORDER BY issued_at DESC, created_at DESC
       LIMIT 1`,
      [centerId, normalizedCardCode],
    );

    return row || null;
  }

  /** Physical card identifiers are unique across all centers. */
  static findByCardCodeAnywhere(cardCode: string): StudentCard | null {
    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id, center_id as centerId, student_id as studentId, card_code as cardCode,
              status, issued_at as issuedAt, deactivated_at as deactivatedAt, created_at as createdAt
       FROM student_cards
       WHERE card_code = ?
       LIMIT 1`,
      [cardCode.trim()],
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
       WHERE center_id = ? AND student_id = ? AND status = 'active'
       ORDER BY issued_at DESC, created_at DESC
       LIMIT 1`,
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

    // Check if card code is currently active anywhere (only block ACTIVE cards)
    const existingActive = db.getFirstSync<any>(
      `SELECT id, student_id as studentId FROM student_cards WHERE center_id = ? AND card_code = ? AND status = 'active' LIMIT 1`,
      [centerId, trimmedCard],
    );
    if (existingActive && existingActive.studentId !== studentId) {
      throw new ConflictError(
        `البطاقة رقم (${trimmedCard}) مفعّلة لطالب آخر بالفعل.`,
      );
    }

    const now = new Date().toISOString();
    const cardId = `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-card-issue-${Date.now()}-${cardId}`;
    let result!: StudentCard;
    DatabaseService.runInTransaction(() => {
    // Deactivate every currently active card for this student. This also
    // repairs legacy/synced databases that accidentally contain more than
    // one active card, so the newly issued card is the only card shown and
    // used for scans/search.
    const activeCards = this.getCardsByStudentId(studentId)
      .filter((card) => String(card.status).trim().toLowerCase() === "active");
    const activeCurrent = activeCards[0] || null;
    activeCards.forEach((card) => {
      db.runSync(
        `UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE id = ?`,
        [now, card.id],
      );
    });

    const reusableCard = db.getFirstSync<any>(
      `SELECT id FROM student_cards WHERE center_id = ? AND card_code = ? LIMIT 1`,
      [centerId, trimmedCard],
    );
    if (reusableCard) {
      db.runSync(
        `UPDATE student_cards SET student_id = ?, status = 'active', issued_at = ?, deactivated_at = NULL WHERE id = ? AND center_id = ?`,
        [studentId, now, reusableCard.id, centerId],
      );
    } else {
      db.runSync(
        `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [cardId, centerId, studentId, trimmedCard, now, now],
      );
    }

    // Keep students.card_code synchronized for legacy readers
    db.runSync(
      `UPDATE students SET card_code = ?, updated_at = ? WHERE id = ?`,
      [trimmedCard, now, studentId],
    );

    AuditService.recordEvent({
      operationId,
      centerId,
      userId: user.id,
      deviceId,
      entityType: "student_card",
      entityId: reusableCard?.id || cardId,
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
      operationType: reusableCard ? "UPDATE" : "CREATE",
      entityType: "student_card",
      entityId: reusableCard?.id || cardId,
      payload: { id: reusableCard?.id || cardId, studentId, cardCode: trimmedCard, issuedAt: now, status: "active" },
    });

    result = {
      id: reusableCard?.id || cardId,
      centerId,
      studentId,
      cardCode: trimmedCard,
      status: "active",
      issuedAt: now,
      createdAt: now,
    };
    });
    return result;
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
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-card-deact-${Date.now()}-${cardId}`;
    DatabaseService.runInTransaction(() => {
      db.runSync(
        `UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE id = ?`,
        [now, cardId],
      );
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "student_card", entityId: cardId, action: "student_card.deactivate", payload: { studentId: row.studentId, cardCode: row.cardCode } });
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "student_card", entityId: cardId, payload: { studentId: row.studentId, cardCode: row.cardCode, status: "inactive", deactivatedAt: now } });
    });
  }

  static reactivateCard(cardId: string): void {
    const { centerId, user } = this.getActiveContext();
    if (
      !PermissionService.hasPermission(
        user.permissions,
        "students.cards.manage",
      )
    ) {
      throw new ForbiddenError("ليس لديك صلاحية إعادة تفعيل بطاقة الطالب.");
    }

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      `SELECT id, student_id as studentId, card_code as cardCode, status FROM student_cards WHERE center_id = ? AND id = ?`,
      [centerId, cardId],
    );

    if (!row) {
      throw new NotFoundError("البطاقة غير موجودة.");
    }

    if (row.status === "active") {
      throw new ConflictError("البطاقة مفعّلة بالفعل.");
    }

    // Check if the card code is currently active for another student
    const existingActive = db.getFirstSync<any>(
      `SELECT id, student_id as studentId FROM student_cards WHERE card_code = ? AND status = 'active' AND id != ? LIMIT 1`,
      [row.cardCode, cardId],
    );
    if (existingActive) {
      throw new ConflictError(
        `كود البطاقة (${row.cardCode}) مستخدم حالياً لطالب آخر. قم بإلغاء تفعيله أولاً.`,
      );
    }

    // Deactivate any other currently active cards for this student first
    const activeCards = db.getAllSync<any>(
      `SELECT id FROM student_cards WHERE center_id = ? AND student_id = ? AND status = 'active' AND id != ?`,
      [centerId, row.studentId, cardId],
    );
    const now = new Date().toISOString();
    const deviceId = DeviceService.getDeviceIdSync();
    const operationId = `op-card-react-${Date.now()}-${cardId}`;
    DatabaseService.runInTransaction(() => {
      activeCards.forEach((c: any) => {
        db.runSync(
          `UPDATE student_cards SET status = 'inactive', deactivated_at = ? WHERE id = ?`,
          [now, c.id],
        );
      });
      db.runSync(
        `UPDATE student_cards SET status = 'active', deactivated_at = NULL, issued_at = ? WHERE id = ?`,
        [now, cardId],
      );
      // Keep students.card_code synchronized
      db.runSync(
        `UPDATE students SET card_code = ?, updated_at = ? WHERE id = ?`,
        [row.cardCode, now, row.studentId],
      );
      AuditService.recordEvent({ operationId, centerId, userId: user.id, deviceId, entityType: "student_card", entityId: cardId, action: "student_card.reactivate", payload: { studentId: row.studentId, cardCode: row.cardCode } });
      SyncRepository.enqueueOperation({ operationId, centerId, userId: user.id, deviceId, operationType: "UPDATE", entityType: "student_card", entityId: cardId, payload: { studentId: row.studentId, cardCode: row.cardCode, status: "active", deactivatedAt: null, issuedAt: now } });
    });
  }
}
