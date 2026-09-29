import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
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
