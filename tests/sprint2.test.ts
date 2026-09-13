import { DatabaseService } from "../src/core/database";
import {
    ConflictError,
    ForbiddenError,
    ValidationError,
} from "../src/core/errors";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { GroupScheduleRepository } from "../src/features/groups/GroupScheduleRepository";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { SessionGenerationService } from "../src/features/sessions/SessionGenerationService";
import { StudentCardRepository } from "../src/features/students/StudentCardRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { SubjectRepository } from "../src/features/subjects/SubjectRepository";
import { TeacherRepository } from "../src/features/teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../src/features/teachers/TeacherSubjectRepository";

describe("Sprint 2 - FIXION Academic Core", () => {
  beforeAll(async () => {
    // Initialize SQLite Database schema and migrations
    DatabaseService.init();

    // Login as Demo Admin for test setup
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  describe("1. External Student Code & Student Creation", () => {
    it("requires external student_code and rejects missing code", () => {
      expect(() => {
        StudentRepository.createStudent({
          studentCode: "",
          fullName: "طالب جديد بدون كود",
          phone: "01099998888",
          parentPhone: "01199998888",
          grade: "الصف الأول الثانوي",
        });
      }).toThrow(ValidationError);
    });

    it("creates student with external student_code successfully", () => {
      const student = StudentRepository.createStudent({
        studentCode: "210100",
        fullName: "زياد عمرو حسن",
        phone: "01099991111",
        parentPhone: "01199991111",
        grade: "الصف الثاني الثانوي",
        studentType: "registered",
        notes: "طالب متفوق",
      });

      expect(student).not.toBeNull();
      expect(student.studentCode).toBe("210100");
      expect(student.fullName).toBe("زياد عمرو حسن");
      expect(student.centerId).toBe("center-1");
      expect(student.status).toBe("active");
    });

    it("enforces unique external student_code per center", () => {
      expect(() => {
        StudentRepository.createStudent({
          studentCode: "210100", // duplicate in center-1
          fullName: "طالب مكرر الكود",
          phone: "01088882222",
          parentPhone: "01188882222",
          grade: "الصف الثاني الثانوي",
        });
      }).toThrow(ConflictError);
    });

    it("verifies legacy Sprint 1 students have clearly marked migration student_code values", () => {
      const legacyStudent = StudentRepository.findByCardCode("00125");
      expect(legacyStudent).not.toBeNull();
      expect(legacyStudent?.id).toBe("std-1");
      expect(legacyStudent?.studentCode).toBe("MIGRATED-LEGACY-std-1");
    });
  });

  describe("2. Canonical Student Cards Source of Truth", () => {
    it("resolves active student card while strictly preserving leading zeros", () => {
      const card = StudentCardRepository.findByCardCode("00125");
      expect(card).not.toBeNull();
      expect(card?.cardCode).toBe("00125");
      expect(card?.status).toBe("active");
      expect(card?.studentId).toBe("std-1");
      expect(card?.centerId).toBe("center-1");
    });

    it("enforces multi-center isolation for cards: same code in center-2 belongs to different student", async () => {
      await useAuthStore.getState().selectCenter("center-2");

      const cardCenter2 = StudentCardRepository.findByCardCode("00125");
      expect(cardCenter2).not.toBeNull();
      expect(cardCenter2?.studentId).toBe("std-4");
      expect(cardCenter2?.centerId).toBe("center-2");

      // Switch back to center-1
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("replaces student card: deactivates previous card and issues new active card", () => {
      const student = StudentRepository.findByStudentCode("210100");
      expect(student).not.toBeNull();

      // Issue initial card 00901
      const initialCard = StudentCardRepository.issueCard(student!.id, "00901");
      expect(initialCard.cardCode).toBe("00901");
      expect(initialCard.status).toBe("active");

      // Replace card with 00902
      const newCard = StudentCardRepository.replaceCard(student!.id, "00902");
      expect(newCard.cardCode).toBe("00902");
      expect(newCard.status).toBe("active");

      // Verify old card is now inactive
      const oldCardLookedUp = StudentCardRepository.findByCardCode("00901");
      expect(oldCardLookedUp).toBeNull(); // inactive cards are not returned by findByCardCode

      // Verify active card for student is 00902
      const activeCard = StudentCardRepository.getActiveCardByStudentId(
        student!.id,
      );
      expect(activeCard?.cardCode).toBe("00902");
      expect(activeCard?.status).toBe("active");
    });

    it("deactivates card properly", () => {
      const student = StudentRepository.findByStudentCode("210100");
      const activeCard = StudentCardRepository.getActiveCardByStudentId(
        student!.id,
      );
      expect(activeCard).not.toBeNull();

      StudentCardRepository.deactivateCard(activeCard!.id);

      const afterDeact = StudentCardRepository.getActiveCardByStudentId(
        student!.id,
      );
      expect(afterDeact).toBeNull();

      // Deactivated card must also not be returned by StudentRepository.findByCardCode
      expect(StudentRepository.findByCardCode("00902")).toBeNull();

      // Restore active card for student
      StudentCardRepository.issueCard(student!.id, "00905");
    });
  });

  describe("3. Teachers Management", () => {
    it("creates a new teacher in the active center", () => {
      const teacher = TeacherRepository.createTeacher({
        name: "أ/ ياسر جلال",
        phone: "01012344321",
        notes: "مدرس كيمياء متميز",
      });

      expect(teacher).not.toBeNull();
      expect(teacher.name).toBe("أ/ ياسر جلال");
      expect(teacher.centerId).toBe("center-1");
      expect(teacher.status).toBe("active");
    });

    it("enforces multi-center isolation for teachers", async () => {
      // In center-1, teacher exists
      const teachersCenter1 = TeacherRepository.getAll();
      expect(teachersCenter1.some((t) => t.name === "أ/ ياسر جلال")).toBe(true);

      // In center-2, teacher does not exist
      await useAuthStore.getState().selectCenter("center-2");
      const teachersCenter2 = TeacherRepository.getAll();
      expect(teachersCenter2.some((t) => t.name === "أ/ ياسر جلال")).toBe(
        false,
      );

      await useAuthStore.getState().selectCenter("center-1");
    });

    it("updates and soft-deactivates teacher", () => {
      const tempTeacher = TeacherRepository.createTeacher({
        name: "أ/ معلم مؤقت للتجربة",
        phone: "01000000999",
      });

      const updated = TeacherRepository.updateTeacher(tempTeacher.id, {
        notes: "ملاحظة محدثة",
      });
      expect(updated.notes).toBe("ملاحظة محدثة");

      TeacherRepository.deactivateTeacher(tempTeacher.id);
      const afterDeact = TeacherRepository.findById(tempTeacher.id);
      expect(afterDeact?.status).toBe("inactive");
    });
  });

  describe("4. Subjects Management", () => {
    it("creates a new subject with unique code in the active center", () => {
      const subject = SubjectRepository.createSubject({
        name: "كيمياء",
        code: "CHEM",
      });

      expect(subject).not.toBeNull();
      expect(subject.name).toBe("كيمياء");
      expect(subject.code).toBe("CHEM");
      expect(subject.centerId).toBe("center-1");
    });

    it("rejects duplicate subject code in the same center", () => {
      expect(() => {
        SubjectRepository.createSubject({
          name: "كيمياء لغات",
          code: "CHEM",
        });
      }).toThrow(ConflictError);
    });

    it("allows same subject code in a different center (multi-center isolation)", async () => {
      await useAuthStore.getState().selectCenter("center-2");

      const subjectCenter2 = SubjectRepository.createSubject({
        name: "كيمياء فرع الأمل",
        code: "CHEM",
      });
      expect(subjectCenter2.centerId).toBe("center-2");
      expect(subjectCenter2.code).toBe("CHEM");

      await useAuthStore.getState().selectCenter("center-1");
    });
  });

  describe("5. Teacher-Subject Relationships", () => {
    it("assigns teacher to subject and prevents duplicates", () => {
      const teachers = TeacherRepository.getAll(true);
      const teacher = teachers.find((t) => t.name === "أ/ ياسر جلال");
      const subject = SubjectRepository.findByCode("CHEM");

      expect(teacher).toBeDefined();
      expect(subject).toBeDefined();

      const ts = TeacherSubjectRepository.assignTeacherToSubject(
        teacher!.id,
        subject!.id,
      );
      expect(ts.teacherId).toBe(teacher!.id);
      expect(ts.subjectId).toBe(subject!.id);

      // Verify duplicate throws ConflictError
      expect(() => {
        TeacherSubjectRepository.assignTeacherToSubject(
          teacher!.id,
          subject!.id,
        );
      }).toThrow(ConflictError);
    });

    it("verifies isTeacherAssignedToSubject returns true when assigned", () => {
      const teacher = TeacherRepository.getAll(true).find(
        (t) => t.name === "أ/ ياسر جلال",
      );
      const subject = SubjectRepository.findByCode("CHEM");
      expect(
        TeacherSubjectRepository.isTeacherAssignedToSubject(
          teacher!.id,
          subject!.id,
        ),
      ).toBe(true);
    });
  });

  describe("6. Groups & Business Validation Rules", () => {
    it("rejects creating group if teacher is NOT assigned to subject", () => {
      const teacher = TeacherRepository.getAll(true).find(
        (t) => t.name === "أ/ ياسر جلال",
      );
      const mathSubject = SubjectRepository.findByCode("MATH"); // Yasir is assigned to CHEM, not MATH

      expect(() => {
        GroupRepository.createGroup({
          name: "رياضيات مع أ/ ياسر",
          teacherId: teacher!.id,
          subjectId: mathSubject!.id,
          grade: "الصف الثالث الثانوي",
          sessionPrice: 80,
          monthlyPrice: 320,
        });
      }).toThrow(ValidationError);
    });

    it("creates group successfully when teacher IS assigned to subject", () => {
      const teacher = TeacherRepository.getAll(true).find(
        (t) => t.name === "أ/ ياسر جلال",
      );
      const chemSubject = SubjectRepository.findByCode("CHEM");

      const group = GroupRepository.createGroup({
        name: "كيمياء 3 ثانوي (مجموعة التفوق)",
        teacherId: teacher!.id,
        subjectId: chemSubject!.id,
        grade: "الصف الثالث الثانوي",
        sessionPrice: 90,
        monthlyPrice: 360,
        sessionDurationMinutes: 120,
        lateAfterMinutes: 20,
      });

      expect(group).not.toBeNull();
      expect(group.name).toBe("كيمياء 3 ثانوي (مجموعة التفوق)");
      expect(group.sessionPrice).toBe(90);
      expect(group.monthlyPrice).toBe(360);
      expect(group.lateAfterMinutes).toBe(20);
    });
  });

  describe("7. Group Schedules Validation", () => {
    it("rejects schedule when endTime <= startTime", () => {
      const groups = GroupRepository.getAll();
      const group = groups.find((g) => g.name.includes("كيمياء 3 ثانوي"));

      expect(() => {
        GroupScheduleRepository.createSchedule({
          groupId: group!.id,
          dayOfWeek: 1, // Monday
          startTime: "16:00",
          endTime: "14:00", // End before start
        });
      }).toThrow(ValidationError);
    });

    it("creates schedule successfully and rejects overlapping schedule on same day", () => {
      const groups = GroupRepository.getAll();
      const group = groups.find((g) => g.name.includes("كيمياء 3 ثانوي"));

      const sched = GroupScheduleRepository.createSchedule({
        groupId: group!.id,
        dayOfWeek: 1, // Monday
        startTime: "14:00",
        endTime: "16:00",
      });
      expect(sched).not.toBeNull();
      expect(sched.startTime).toBe("14:00");
      expect(sched.endTime).toBe("16:00");

      // Overlapping schedule on same day (15:00 - 17:00 overlaps 14:00 - 16:00)
      expect(() => {
        GroupScheduleRepository.createSchedule({
          groupId: group!.id,
          dayOfWeek: 1,
          startTime: "15:00",
          endTime: "17:00",
        });
      }).toThrow(ConflictError);
    });
  });

  describe("8. Student Group Enrollments", () => {
    it("enrolls student in group with valid date and optional special price", () => {
      const student = StudentRepository.findByStudentCode("210100");
      const group = GroupRepository.getAll().find((g) =>
        g.name.includes("كيمياء 3 ثانوي"),
      );

      const enrollment = EnrollmentRepository.enrollStudent({
        studentId: student!.id,
        groupId: group!.id,
        startDate: "2026-09-01",
        specialMonthlyPrice: 300, // special discounted price
      });

      expect(enrollment).not.toBeNull();
      expect(enrollment.studentId).toBe(student!.id);
      expect(enrollment.groupId).toBe(group!.id);
      expect(enrollment.specialMonthlyPrice).toBe(300);
      expect(enrollment.status).toBe("active");
    });

    it("prevents duplicate active enrollment for the same student in the same group", () => {
      const student = StudentRepository.findByStudentCode("210100");
      const group = GroupRepository.getAll().find((g) =>
        g.name.includes("كيمياء 3 ثانوي"),
      );

      expect(() => {
        EnrollmentRepository.enrollStudent({
          studentId: student!.id,
          groupId: group!.id,
          startDate: "2026-09-10",
        });
      }).toThrow(ConflictError);
    });

    it("ends enrollment properly with end_date", () => {
      const student = StudentRepository.findByStudentCode("210100");
      const enrollments = EnrollmentRepository.getActiveEnrollmentsForStudent(
        student!.id,
      );
      const enr = enrollments[0];

      EnrollmentRepository.endEnrollment(enr.id, "2026-09-30");

      const activeAfter = EnrollmentRepository.getActiveEnrollmentsForStudent(
        student!.id,
      );
      expect(activeAfter.some((e) => e.id === enr.id)).toBe(false);
    });
  });

  describe("9. Session Generation, Historical Snapshots & Immutability", () => {
    it("generates sessions idempotently for group schedule in date range", () => {
      // Group 1 has schedule on today's day of week
      const today = new Date().toISOString().split("T")[0];

      const sessions1 = SessionGenerationService.generateSessionsForRange(
        today,
        today,
      );
      expect(Array.isArray(sessions1)).toBe(true);

      // Running generation again for the same date must be idempotent (no duplicates created)
      const sessions2 = SessionGenerationService.generateSessionsForRange(
        today,
        today,
      );
      expect(sessions2.length).toBe(0);
    });

    it("snapshots group configuration (prices, subject, teacher, late threshold) at generation time", () => {
      const today = new Date().toISOString().split("T")[0];
      const todaySessions = SessionGenerationService.getSessionsForDate(today);
      expect(todaySessions.length).toBeGreaterThan(0);

      const sess = todaySessions[0];
      expect(sess.sessionPrice).toBeDefined();
      expect(sess.lateAfterMinutes).toBeDefined();
      expect(sess.subjectId).toBeDefined();
      expect(sess.teacherId).toBeDefined();
    });

    it("captures immutable session_expected_students snapshot that is not rewritten by subsequent enrollment changes", () => {
      const today = new Date().toISOString().split("T")[0];
      const sess = SessionGenerationService.getSessionsForDate(today)[0];

      const initialExpected =
        SessionGenerationService.getExpectedStudentsForSession(sess.id);
      const initialCount = initialExpected.length;
      expect(initialCount).toBeGreaterThanOrEqual(1);

      // Enroll a new student today in the same group after session generation
      const newStudent = StudentRepository.createStudent({
        studentCode: "210101",
        fullName: "طالب مسجل متأخر",
        phone: "01077776666",
        parentPhone: "01177776666",
        grade: "الصف الثالث الثانوي",
      });

      EnrollmentRepository.enrollStudent({
        studentId: newStudent.id,
        groupId: sess.groupId,
        startDate: today,
      });

      // The historical session's expected students snapshot must remain completely immutable!
      const expectedAfter =
        SessionGenerationService.getExpectedStudentsForSession(sess.id);
      expect(expectedAfter.length).toBe(initialCount);
      expect(expectedAfter.some((s) => s.id === newStudent.id)).toBe(false);
    });
  });

  describe("10. Scanner Integration & Back-to-Back Sessions", () => {
    it("ScannerService returns eligible sessions for enrolled student on session date", () => {
      const today = new Date().toISOString().split("T")[0];
      const sessions = ScannerService.getEligibleSessionsForStudent(
        "std-1",
        today,
      );

      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0].centerId).toBe("center-1");
    });

    it("ScannerService strictly derives eligibility from immutable expected students snapshot, excluding late enrollees", () => {
      const today = new Date().toISOString().split("T")[0];
      // Student 210101 was enrolled in test 9.3 AFTER session was generated
      const lateStudent = StudentRepository.findByStudentCode("210101");
      expect(lateStudent).not.toBeNull();

      const eligibleSessions = ScannerService.getEligibleSessionsForStudent(
        lateStudent!.id,
        today,
      );
      // Because the session snapshot was already captured before their enrollment, they are NOT in expected students
      expect(eligibleSessions.length).toBe(0);
    });
  });

  describe("11. Permission Enforcement (Defense in Depth)", () => {
    it("rejects non-admin role when attempting to create teacher without teachers.create permission", async () => {
      // Login as accountant (which lacks teachers.create)
      await useAuthStore.getState().login("01000000003", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        TeacherRepository.createTeacher({
          name: "معلم غير مصرح",
        });
      }).toThrow(ForbiddenError);

      // Restore admin session
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("rejects secretary when attempting to create group without groups.create permission", async () => {
      // Login as secretary
      await useAuthStore.getState().login("01000000002", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        GroupRepository.createGroup({
          name: "مجموعة غير مصرح بها",
          teacherId: "teach-1",
          subjectId: "subj-1",
          grade: "الصف الثالث الثانوي",
          sessionPrice: 100,
          monthlyPrice: 400,
        });
      }).toThrow(ForbiddenError);

      // Restore admin session
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("rejects unauthorized role when attempting to create subject without subjects.create permission", async () => {
      // Login as accountant (which lacks subjects.create)
      await useAuthStore.getState().login("01000000003", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        SubjectRepository.createSubject({
          name: "مادة غير مصرحة",
          code: "UNAUTH",
        });
      }).toThrow(ForbiddenError);

      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("rejects unauthorized role when attempting to enroll student without enrollments.create permission", async () => {
      // Login as accountant (which lacks enrollments.create)
      await useAuthStore.getState().login("01000000003", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        EnrollmentRepository.enrollStudent({
          studentId: "std-1",
          groupId: "grp-1",
          startDate: "2026-09-10",
        });
      }).toThrow(ForbiddenError);

      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    it("rejects unauthorized role when attempting to generate sessions without sessions.create permission", async () => {
      // Login as accountant (which lacks sessions.create)
      await useAuthStore.getState().login("01000000003", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      expect(() => {
        SessionGenerationService.generateSessionsForRange(
          "2026-09-10",
          "2026-09-10",
        );
      }).toThrow(ForbiddenError);

      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });
  });

  describe("12. Audit Logging & Sync Queue for Academic Mutations", () => {
    it("records audit logs and queues sync operations for academic entities", () => {
      const db = DatabaseService.getDb();
      const auditRows = db.getAllSync(
        "SELECT * FROM audit_logs WHERE center_id = 'center-1'",
      );
      const syncRows = db.getAllSync(
        "SELECT * FROM sync_operations WHERE center_id = 'center-1'",
      );

      expect(auditRows.length).toBeGreaterThan(0);
      expect(syncRows.length).toBeGreaterThan(0);

      // Verify specific entity types were audited
      const entityTypes = new Set(
        auditRows.map((a) => a.entityType || a.entity_type),
      );
      expect(
        entityTypes.has("student") || entityTypes.has("student_card"),
      ).toBe(true);
      expect(entityTypes.has("teacher")).toBe(true);
      expect(entityTypes.has("subject")).toBe(true);
    });
  });
});
