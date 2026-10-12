import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { StudentColorRepository } from "../src/features/students/StudentColorRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { Permission, User } from "../src/shared/types";
import { useAuthStore } from "../src/features/auth/useAuthStore";

const CENTER_ID = "student-color-center";
const STUDENT_ID = "student-color-student";
const USER_ID = "student-color-user";

function setUser(permissions: Permission[]): void {
  const user: User = {
    id: USER_ID,
    fullName: "Test Staff",
    phone: "01000000000",
    role: "assistant",
    centerId: CENTER_ID,
    centerIds: [CENTER_ID],
    permissions,
  };
  useAuthStore.setState({ currentUser: user, activeCenterId: CENTER_ID, isAuthenticated: true });
}

describe("persistent student colors", () => {
  beforeEach(() => {
    DatabaseService.init();
    setUser(["students.view", "students.update"]);
    jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "online",
      arabicMessage: "متصل",
    });
    DatabaseService.getDb().runSync(
      `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [STUDENT_ID, CENTER_ID, "00123", "طالب للاختبار", "00123", "", "", "الصف الثالث الثانوي", new Date().toISOString()],
    );
    DatabaseService.getDb().runSync(
      `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["color-attendance", CENTER_ID, STUDENT_ID, "color-session", new Date().toISOString(), "present", "color-attendance-op"],
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("persists a chosen color, queues only a color mutation, syncs it to another local replica, and resets it", () => {
    StudentColorRepository.setColor(STUDENT_ID, "lavender");
    expect(DatabaseService.getDb().getFirstSync<{ student_color: string }>(
      "SELECT student_color FROM students WHERE center_id = ? AND id = ?",
      [CENTER_ID, STUDENT_ID],
    )?.student_color).toBe("lavender");
    expect(StudentRepository.getAll(true).find((student) => student.id === STUDENT_ID)?.studentColor)
      .toBe("lavender");

    const operations = SyncRepository.getRecentOperations(CENTER_ID);
    const colorOperation = operations.find((operation) => operation.entityType === "student_color");
    expect(colorOperation).toBeDefined();
    expect(colorOperation?.payload).toContain("lavender");

    SyncEngine.applyServerChanges(CENTER_ID, [{
      entityType: "student",
      entityId: STUDENT_ID,
      data: { id: STUDENT_ID, full_name: "اسم محدث" },
    }]);
    expect(StudentRepository.getAll(true).find((student) => student.id === STUDENT_ID)?.studentColor)
      .toBe("lavender");

    SyncEngine.applyServerChanges(CENTER_ID, [{
      entityType: "student_color",
      entityId: STUDENT_ID,
      data: { studentId: STUDENT_ID, studentColor: "rose" },
    }]);
    expect(DatabaseService.getDb().getFirstSync<{ student_color: string }>(
      "SELECT student_color FROM students WHERE center_id = ? AND id = ?",
      [CENTER_ID, STUDENT_ID],
    )?.student_color).toBe("rose");

    StudentColorRepository.setColor(STUDENT_ID, null);
    expect(DatabaseService.getDb().getFirstSync<{ student_color: string | null }>(
      "SELECT student_color FROM students WHERE center_id = ? AND id = ?",
      [CENTER_ID, STUDENT_ID],
    )?.student_color).toBeNull();
    expect(DatabaseService.getDb().getFirstSync<{ status: string }>(
      "SELECT status FROM attendance WHERE id = ?",
      ["color-attendance"],
    )?.status).toBe("present");
  });

  it("rejects unauthorized, invalid, and out-of-center color changes", () => {
    setUser(["students.view"]);
    expect(() => StudentColorRepository.setColor(STUDENT_ID, "lavender")).toThrow("ليس لديك صلاحية");

    setUser(["students.view", "students.update"]);
    expect(() => StudentColorRepository.setColor(STUDENT_ID, "not-a-palette-color" as never)).toThrow("غير صالح");
    expect(() => StudentColorRepository.setColor("another-center-student", "lavender")).toThrow("غير موجود");
  });
});
