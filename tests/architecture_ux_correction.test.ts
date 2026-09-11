import { DatabaseService } from "../src/core/database";
import { ConflictError, ValidationError } from "../src/core/errors";
import { SyncRepository } from "../src/core/sync";
import { AuthRepository } from "../src/features/auth/AuthRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { StudentCardRepository } from "../src/features/students/StudentCardRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import {
    formatCardCode,
    formatDisplayIdentifier,
} from "../src/shared/utils/formatters";

describe("FIXION Architecture & UX Correction Pass", () => {
  beforeEach(async () => {
    DatabaseService.init();
    useAuthStore.getState().logout();
  });

  // ==========================================================
  // Section 1: Simplified Login Flow (No Center Selection)
  // ==========================================================
  describe("1. Simplified Login Flow — User -> Center -> Role -> Permissions", () => {
    it("Test 1: Logs in with email + password without requiring center selection", async () => {
      await useAuthStore.getState().login("admin@center1.com", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-1");
      expect(state.activeCenter?.name).toBe("مركز النور التعليمي");
      expect(state.currentUser?.email).toBe("admin@center1.com");
      expect(state.currentUser?.role).toBe("admin");
      expect(state.currentUser?.permissions).toContain("students.create");
      expect(state.currentUser?.permissions).toContain("payments.view");
    });

    it("Test 2: Secretary login automatically resolves Center 1 and secretary permissions", async () => {
      await useAuthStore.getState().login("secretary@center1.com", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-1");
      expect(state.currentUser?.role).toBe("secretary");
      expect(state.currentUser?.permissions).toContain("attendance.create");
      expect(state.currentUser?.permissions).toContain("students.create");
      expect(state.currentUser?.permissions).not.toContain("reports.view");
    });

    it("Test 3: Accountant login automatically resolves Center 1 and accountant permissions", async () => {
      await useAuthStore.getState().login("accountant@center1.com", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-1");
      expect(state.currentUser?.role).toBe("accountant");
      expect(state.currentUser?.permissions).toContain("payments.create");
      expect(state.currentUser?.permissions).toContain("payments.view");
      expect(state.currentUser?.permissions).not.toContain("groups.delete");
    });

    it("Test 4: Center 2 Admin login automatically resolves Center 2 context", async () => {
      await useAuthStore.getState().login("admin@center2.com", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-2");
      expect(state.activeCenter?.name).toBe("مركز الأمل التعليمي");
      expect(state.currentUser?.role).toBe("admin");
    });

    it("Test 5: Email matching is case-insensitive", async () => {
      await useAuthStore.getState().login("ADMIN@CENTER1.COM", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-1");
    });

    it("Test 6: Phone login backwards-compatibility continues to work and auto-resolves center", async () => {
      await useAuthStore.getState().login("01000000001", "123456");
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.activeCenterId).toBe("center-1");
      expect(state.currentUser?.fullName).toBe("أحمد الإدريسي (المدير)");
    });

    it("Test 7: Rejects invalid password and keeps unauthenticated state", async () => {
      const success = await useAuthStore
        .getState()
        .login("admin@center1.com", "wrong-password");
      expect(success).toBe(false);

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.activeCenterId).toBeNull();
      expect(state.error).toBeDefined();

      await expect(
        AuthRepository.login("admin@center1.com", "wrong-password"),
      ).rejects.toThrow();
    });

    it("Test 8: Rejects unknown email address", async () => {
      const success = await useAuthStore
        .getState()
        .login("nonexistent@domain.com", "123456");
      expect(success).toBe(false);

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.error).toBeDefined();

      await expect(
        AuthRepository.login("nonexistent@domain.com", "123456"),
      ).rejects.toThrow();
    });

    it("Test 9: Enforces multi-tenant center isolation between accounts", async () => {
      // Login as Center 1 Admin
      await useAuthStore.getState().login("admin@center1.com", "123456");
      const center1Students = StudentRepository.getAll();

      // Login as Center 2 Admin
      await useAuthStore.getState().login("admin@center2.com", "123456");
      const center2Students = StudentRepository.getAll();

      // Ensure students in center 1 are completely isolated from center 2
      const center1Ids = new Set(center1Students.map((s) => s.id));
      const overlap = center2Students.filter((s) => center1Ids.has(s.id));
      expect(overlap.length).toBe(0);
    });
  });

  // ==========================================================
  // Section 2: Physical Card System & Leading Zeros Preservation
  // ==========================================================
  describe("2. Physical Card System & Leading Zeros Preservation", () => {
    beforeEach(async () => {
      await useAuthStore.getState().login("admin@center1.com", "123456");
    });

    it("Test 10: Preserves leading zeros exactly for card codes (e.g. '00555')", () => {
      const codeWithLeadingZeros = "00555";
      const student = StudentRepository.createStudent({
        cardCode: codeWithLeadingZeros,
        fullName: "طالب باحث عن تفوق",
        phone: "01099887766",
        parentPhone: "01199887766",
      });

      expect(student.cardCode).toBe("00555");
      expect(student.studentCode).toBe("00555");
      expect(typeof student.cardCode).toBe("string");
      expect(student.cardCode?.startsWith("00")).toBe(true);

      const fetched = StudentRepository.findByCardCode("00555");
      expect(fetched).not.toBeNull();
      expect(fetched?.cardCode).toBe("00555");
      expect(fetched?.fullName).toBe("طالب باحث عن تفوق");
    });

    it("Test 11: Preserves single and multi-leading zeros (e.g. '00001', '07')", () => {
      expect(formatCardCode("00001")).toBe("00001");
      expect(formatCardCode("07")).toBe("07");
      expect(formatCardCode("100234")).toBe("100234");
    });

    it("Test 12: Rejects duplicate card code assignment within the same center", () => {
      const uniqueCode = "00889";
      StudentRepository.createStudent({
        cardCode: uniqueCode,
        fullName: "الطالب الأول",
        phone: "01011112222",
        parentPhone: "01111112222",
      });

      expect(() => {
        StudentRepository.createStudent({
          cardCode: uniqueCode,
          fullName: "الطالب الثاني",
          phone: "01033334444",
          parentPhone: "01133334444",
        });
      }).toThrow(ConflictError);
    });

    it("Test 13: Rejects duplicate student code assignment within the same center", () => {
      const code = "STD-CODE-999";
      StudentRepository.createStudent({
        studentCode: code,
        cardCode: "CARD-CODE-999",
        fullName: "طالب كود مكرر",
        phone: "01055556666",
        parentPhone: "01155556666",
      });

      expect(() => {
        StudentRepository.createStudent({
          studentCode: code,
          cardCode: "CARD-CODE-DIFF",
          fullName: "طالب آخر بنفس الكود",
          phone: "01077778888",
          parentPhone: "01177778888",
        });
      }).toThrow(ConflictError);
    });
  });

  // ==========================================================
  // Section 3: Atomic Student Creation & Multi-Group Enrollments
  // ==========================================================
  describe("3. Atomic Student Creation & Multi-Group Enrollments", () => {
    beforeEach(async () => {
      await useAuthStore.getState().login("admin@center1.com", "123456");
    });

    it("Test 14: Creates student, issues card, and enrolls in multiple groups atomically", () => {
      const groups = GroupRepository.getAll();
      expect(groups.length).toBeGreaterThanOrEqual(2);

      const group1Id = groups[0].id;
      const group2Id = groups[1].id;
      const cardCode = "00350";

      const student = StudentRepository.createStudent({
        cardCode,
        fullName: "ياسمين إبراهيم",
        phone: "01012349999",
        parentPhone: "01112349999",
        grade: "الصف الثالث الثانوي",
        groupIds: [group1Id, group2Id],
      });

      expect(student.id).toBeDefined();
      expect(student.fullName).toBe("ياسمين إبراهيم");

      // Verify active card issued
      const activeCard = StudentCardRepository.getActiveCardByStudentId(
        student.id,
      );
      expect(activeCard).not.toBeNull();
      expect(activeCard?.cardCode).toBe(cardCode);
      expect(activeCard?.status).toBe("active");

      // Verify active enrollments created
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForStudent(
        student.id,
      );
      expect(enrollments.length).toBe(2);
      const enrolledGroupIds = enrollments.map((e) => e.groupId);
      expect(enrolledGroupIds).toContain(group1Id);
      expect(enrolledGroupIds).toContain(group2Id);
    });

    it("Test 15: Enqueues sync operation idempotently upon student creation", () => {
      const cardCode = "00777";
      const student = StudentRepository.createStudent({
        cardCode,
        fullName: "كريم مروان",
        phone: "01066667777",
        parentPhone: "01166667777",
      });

      const pendingOps = SyncRepository.getPendingOperations("center-1");
      const studentOp = pendingOps.find(
        (op) => op.entityType === "student" && op.entityId === student.id,
      );

      expect(studentOp).toBeDefined();
      expect(studentOp?.operationType).toBe("CREATE");
      const parsedPayload = JSON.parse(studentOp?.payload || "{}");
      expect(parsedPayload.cardCode).toBe(cardCode);
      expect(studentOp?.operationId).toBeDefined();
    });

    it("Test 16: Rollback on failure ensures no inconsistent partial student data", () => {
      const db = DatabaseService.getDb();
      const countBefore =
        db.getFirstSync<{ count: number }>(
          `SELECT count(*) as count FROM students WHERE center_id = 'center-1'`,
        )?.count || 0;

      // Providing a non-existent group ID causes enrollment failure
      expect(() => {
        StudentRepository.createStudent({
          cardCode: "00999",
          fullName: "طالب اختبار التراجع",
          phone: "01088889999",
          parentPhone: "01188889999",
          groupIds: ["non-existent-group-xyz-999"],
        });
      }).toThrow();

      // Student record must have been rolled back
      const countAfter =
        db.getFirstSync<{ count: number }>(
          `SELECT count(*) as count FROM students WHERE center_id = 'center-1'`,
        )?.count || 0;

      expect(countAfter).toBe(countBefore);

      // Card must not exist
      const card = StudentCardRepository.findByCardCode("00999");
      expect(card).toBeNull();
    });

    it("Test 17: Validates required student fields (name, phones, code)", () => {
      expect(() => {
        StudentRepository.createStudent({
          cardCode: "",
          fullName: "طالب بلا كود",
          phone: "01011111111",
          parentPhone: "01111111111",
        });
      }).toThrow(ValidationError);

      expect(() => {
        StudentRepository.createStudent({
          cardCode: "00111",
          fullName: "",
          phone: "01011111111",
          parentPhone: "01111111111",
        });
      }).toThrow(ValidationError);

      expect(() => {
        StudentRepository.createStudent({
          cardCode: "00111",
          fullName: "طالب بلا هاتف",
          phone: "",
          parentPhone: "01111111111",
        });
      }).toThrow(ValidationError);
    });
  });

  // ==========================================================
  // Section 4: Display Hygiene & Identifier Sanitization
  // ==========================================================
  describe("4. Display Hygiene & Legacy Identifier Sanitization", () => {
    it("Test 18: Strips 'MIGRATED-LEGACY-' prefix from student codes", () => {
      const raw = "MIGRATED-LEGACY-00126";
      const clean = formatDisplayIdentifier(raw);
      expect(clean).toBe("00126");
      expect(clean.startsWith("00")).toBe(true);
    });

    it("Test 19: Preserves exact leading zeros for ordinary card codes", () => {
      expect(formatDisplayIdentifier("00126")).toBe("00126");
      expect(formatDisplayIdentifier("00001")).toBe("00001");
      expect(formatDisplayIdentifier("0123")).toBe("0123");
    });

    it("Test 20: Suppresses internal UUID/operation prefixes", () => {
      expect(formatDisplayIdentifier("op-std-create-12345")).toBe("");
      expect(formatDisplayIdentifier("sync-op-batch-999")).toBe("");
      expect(formatDisplayIdentifier("tok-session-abc")).toBe("");
    });

    it("Test 21: Gracefully handles null, undefined, or empty values", () => {
      expect(formatDisplayIdentifier(null)).toBe("");
      expect(formatDisplayIdentifier(undefined)).toBe("");
      expect(formatDisplayIdentifier("")).toBe("");
      expect(formatDisplayIdentifier("   ")).toBe("");
    });
  });

  // ==========================================================
  // Section 5: Group Selection & Center Isolation
  // ==========================================================
  describe("5. Group Selection Isolation", () => {
    it("Test 22: Center 1 groups are isolated to Center 1", async () => {
      await useAuthStore.getState().login("admin@center1.com", "123456");
      const c1Groups = GroupRepository.getAll();
      expect(c1Groups.length).toBeGreaterThan(0);
      c1Groups.forEach((g) => {
        expect(g.centerId).toBe("center-1");
      });
    });

    it("Test 23: Center 2 only sees Center 2 groups", async () => {
      await useAuthStore.getState().login("admin@center2.com", "123456");
      const c2Groups = GroupRepository.getAll();
      c2Groups.forEach((g) => {
        expect(g.centerId).toBe("center-2");
      });
    });
  });
});
