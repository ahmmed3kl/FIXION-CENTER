import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { StudentCardRepository } from "../src/features/students/StudentCardRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("student archive and restore lifecycle", () => {
  beforeEach(async () => {
    DatabaseService.init();
    useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
  });

  function createStudent(code = "00881") {
    return StudentRepository.createStudent({
      studentCode: code,
      cardCode: code,
      fullName: "اختبار دورة حياة الطالب",
      phone: "01012345678",
      parentPhone: "01112345678",
      grade: "الصف الأول الثانوي",
    });
  }

  it("archives instead of physically deleting, and hides the student from current lists and card lookup", () => {
    const student = createStudent();

    const archived = StudentRepository.deleteStudent(student.id);

    expect(archived.deletedAt).toBeTruthy();
    expect(archived.deletedBy).toBe(useAuthStore.getState().currentUser?.id);
    expect(StudentRepository.findById(student.id)).toBeNull();
    expect(StudentRepository.getAll(true).some((item) => item.id === student.id)).toBe(false);
    expect(StudentRepository.search("اختبار دورة حياة الطالب").some((item) => item.id === student.id)).toBe(false);
    expect(StudentRepository.findByCardCode(student.cardCode!)).toBeNull();
    expect(StudentRepository.getDeletedStudents().some((item) => item.id === student.id)).toBe(true);
    expect(StudentRepository.getDeletedStudents().find((item) => item.id === student.id)?.deletedByName)
      .toBe(useAuthStore.getState().currentUser?.fullName);
    expect(StudentCardRepository.getCardsByStudentId(student.id)[0]?.status).toBe("inactive");

    // The row and its card identity remain available for restore/history.
    expect(StudentRepository.findByStudentCode(student.studentCode!)).toMatchObject({
      id: student.id,
      cardCode: student.cardCode,
    });
  });

  it("searches archived students separately and restores the same identity and card code", () => {
    const student = createStudent("00882");
    StudentRepository.deleteStudent(student.id);

    expect(StudentRepository.searchDeletedStudents("00882").map((item) => item.id)).toContain(student.id);
    expect(StudentRepository.search("00882").map((item) => item.id)).not.toContain(student.id);

    const restored = StudentRepository.restoreDeletedStudent(student.id);
    expect(restored).toMatchObject({ id: student.id, studentCode: "00882", cardCode: "00882", deletedAt: null, deletedBy: null });
    expect(StudentRepository.findById(student.id)).toMatchObject({ id: student.id, cardCode: "00882" });
    expect(StudentRepository.findByCardCode("00882")?.id).toBe(student.id);
  });

  it("requires explicit confirmation before reusing an archived student's card and keeps the old record archived", () => {
    const archived = createStudent("00887");
    StudentRepository.deleteStudent(archived.id);

    expect(StudentRepository.getArchivedCardOwner("00887")?.id).toBe(archived.id);
    expect(() => StudentCardRepository.reactivateCard(
      StudentCardRepository.getCardsByStudentId(archived.id)[0].id,
    )).toThrow("لا يمكن إعادة تفعيل بطاقة لطالب مؤرشف.");
    expect(() => StudentRepository.createStudent({
      studentCode: "00888",
      cardCode: "00887",
      fullName: "طالب جديد",
      phone: "01098765432",
      parentPhone: "01198765432",
      grade: "الصف الأول الثانوي",
    })).toThrow("يتطلب تأكيد");
    expect(() => StudentCardRepository.issueCard(archived.id, "00887")).toThrow(
      "لا يمكن إصدار بطاقة لطالب مؤرشف.",
    );

    const replacement = StudentRepository.createStudent({
      studentCode: "00888",
      cardCode: "00887",
      fullName: "طالب جديد",
      phone: "01098765432",
      parentPhone: "01198765432",
      grade: "الصف الأول الثانوي",
    }, { reuseArchivedCard: true });
    console.log("DEBUG_ARCHIVE_REUSE", { archivedId: archived.id, replacementId: replacement.id, archivedStudent: StudentRepository.getDeletedStudents().find((item) => item.id === archived.id), allDeleted: StudentRepository.getDeletedStudents().map((item) => ({ id: item.id, cardCode: item.cardCode, deletedAt: item.deletedAt })), allActive: StudentRepository.getAll(true).map((item) => ({ id: item.id, cardCode: item.cardCode, deletedAt: item.deletedAt })) });

    expect(StudentRepository.findByCardCode("00887")?.id).toBe(replacement.id);
    const archivedRow = DatabaseService.getDb().getFirstSync<{ card_code: string | null }>(
      "SELECT id, card_code FROM students WHERE id = ?",
      [archived.id],
    );
    console.log("DEBUG_ARCHIVED_ROW", archivedRow);
    expect(archivedRow?.card_code).toBe("00887");
    expect(StudentRepository.findById(archived.id)).toBeNull();
    expect(StudentRepository.getDeletedStudents().some((item) => item.id === archived.id)).toBe(true);
    expect(StudentRepository.getDeletedStudents().find((item) => item.id === archived.id)?.cardCode).toBe("00887");
    expect(StudentRepository.findByStudentCode("00887")?.id).toBe(archived.id);
    expect(StudentCardRepository.getCardsByStudentId(replacement.id).map((card) => card.cardCode)).toContain("00887");
    expect(StudentRepository.restoreDeletedStudent(archived.id)).toMatchObject({ id: archived.id });
    expect(StudentRepository.findById(archived.id)?.cardCode).toBeUndefined();
    expect(StudentRepository.findByCardCode("00887")?.id).toBe(replacement.id);
  });

  it("keeps the authoritative student card_code when card history has no active row", () => {
    const student = createStudent("00886");
    const card = StudentCardRepository.getActiveCardByStudentId(student.id);
    expect(card?.cardCode).toBe("00886");

    StudentCardRepository.deactivateCard(card!.id);

    expect(StudentRepository.getAll(true).find((item) => item.id === student.id)?.cardCode).toBe("00886");
  });

  it("does not issue a card to a student from another center", async () => {
    await useAuthStore.getState().selectCenter("center-2");
    const foreignStudent = StudentRepository.getAll(true)[0];
    expect(foreignStudent).toBeDefined();
    await useAuthStore.getState().selectCenter("center-1");

    expect(() => StudentCardRepository.issueCard(foreignStudent.id, "00991")).toThrow(
      "الطالب غير موجود في هذا المركز.",
    );
    expect(() => SyncEngine.applyServerChanges("center-1", [{
      entityType: "student",
      entityId: foreignStudent.id,
      action: "create",
      data: { id: foreignStudent.id, student: { id: foreignStudent.id, student_code: "00990" } },
    }])).toThrow("Student sync change belongs to a different center");
    expect(() => SyncEngine.applyServerChanges("center-1", [{
      entityType: "student_card",
      entityId: "foreign-center-card",
      action: "create",
      data: {
        id: "foreign-center-card",
        student_id: foreignStudent.id,
        card_code: "00992",
        status: "active",
      },
    }])).toThrow("Student card owner is outside the center");
  });

  it("does not reactivate an archived student's card when an old create sync change is replayed", () => {
    const student = createStudent("00889");
    StudentRepository.deleteStudent(student.id);
    expect(StudentCardRepository.findByCardCode("00889")).toBeNull();

    SyncEngine.applyServerChanges("center-1", [{
      entityType: "student",
      entityId: student.id,
      action: "create",
      data: {
        id: student.id,
        student: {
          id: student.id,
          student_code: student.studentCode,
          card_code: student.cardCode,
          full_name: student.fullName,
          status: "active",
          deleted_at: null,
          deleted_by: null,
        },
        card: { id: `card-${student.id}`, card_code: student.cardCode },
      },
    }]);

    expect(StudentRepository.getDeletedStudents().some((item) => item.id === student.id)).toBe(true);
    expect(StudentCardRepository.findByCardCode("00889")).toBeNull();
    expect(() => SyncEngine.applyServerChanges("center-1", [{
      entityType: "student_card",
      entityId: `card-${student.id}`,
      action: "create",
      data: {
        id: `card-${student.id}`,
        student_id: student.id,
        card_code: "00889",
        status: "active",
      },
    }])).toThrow("Cannot activate a card for an archived student");
    expect(StudentCardRepository.findByCardCode("00889")).toBeNull();
  });

  it("does not restore an old card code when a stale student create is replayed after replacement", () => {
    const student = createStudent("00890");
    StudentCardRepository.replaceCard(student.id, "00993");

    SyncEngine.applyServerChanges("center-1", [{
      entityType: "student",
      entityId: student.id,
      action: "create",
      data: {
        id: student.id,
        student: {
          id: student.id,
          student_code: student.studentCode,
          card_code: "00890",
          full_name: student.fullName,
        },
        card: { id: `card-${student.id}`, card_code: "00890" },
      },
    }]);

    expect(StudentRepository.findByCardCode("00993")?.id).toBe(student.id);
    expect(StudentRepository.findByCardCode("00890")).toBeNull();
  });

  it("writes delete and restore audit events with the authenticated actor", () => {
    const student = createStudent("00883");
    StudentRepository.deleteStudent(student.id);
    StudentRepository.restoreDeletedStudent(student.id);

    const events = AuditService.getLogs("center-1", 100).filter(
      (event) => event.entityId === student.id && ["student.delete", "student.restore"].includes(event.action),
    );
    expect(events.map((event) => event.action).sort()).toEqual(["student.delete", "student.restore"]);
    for (const event of events) {
      expect(event.userId).toBe(useAuthStore.getState().currentUser?.id);
      expect(event.timestamp).toBeTruthy();
    }
  });

  it("rejects duplicate archive/restore requests without generating duplicate audit events", () => {
    const student = createStudent("00884");
    StudentRepository.deleteStudent(student.id);
    expect(() => StudentRepository.deleteStudent(student.id)).toThrow();
    StudentRepository.restoreDeletedStudent(student.id);
    expect(() => StudentRepository.restoreDeletedStudent(student.id)).toThrow();

    const events = AuditService.getLogs("center-1", 100).filter(
      (event) => event.entityId === student.id && ["student.delete", "student.restore"].includes(event.action),
    );
    expect(events).toHaveLength(2);
  });

  it("keeps archive and restore operations in the same local transaction as audit and outbox", () => {
    const student = createStudent("00885");
    const enqueueSpy = jest.spyOn(SyncRepository, "enqueueOperation").mockImplementation(() => {
      throw new Error("simulated outbox failure");
    });

    expect(() => StudentRepository.deleteStudent(student.id)).toThrow("simulated outbox failure");
    enqueueSpy.mockRestore();
    expect(StudentRepository.findById(student.id)).not.toBeNull();
    expect(AuditService.getLogs("center-1", 100).some((event) => event.entityId === student.id && event.action === "student.delete")).toBe(false);

    StudentRepository.deleteStudent(student.id);
    const restoreSpy = jest.spyOn(SyncRepository, "enqueueOperation").mockImplementation(() => {
      throw new Error("simulated outbox failure");
    });
    expect(() => StudentRepository.restoreDeletedStudent(student.id)).toThrow("simulated outbox failure");
    restoreSpy.mockRestore();
    expect(StudentRepository.getDeletedStudents().some((item) => item.id === student.id)).toBe(true);
    expect(AuditService.getLogs("center-1", 100).some((event) => event.entityId === student.id && event.action === "student.restore")).toBe(false);
  });
});
