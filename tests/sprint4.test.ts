import { DatabaseService } from "../src/core/database";
import {
    ConflictError,
    ForbiddenError,
    ValidationError,
} from "../src/core/errors";
import { AbsenceService } from "../src/features/attendance/AbsenceService";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { PackageRepository } from "../src/features/packages/PackageRepository";
import { PackageSubscriptionRepository } from "../src/features/packages/PackageSubscriptionRepository";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { PaymentRepository } from "../src/features/payments/PaymentRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { SubjectRepository } from "../src/features/subjects/SubjectRepository";
import { TeacherRepository } from "../src/features/teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../src/features/teachers/TeacherSubjectRepository";

describe("Sprint 4 - FIXION Packages, Makeups & Unified Attendance/Financial Integration", () => {
  beforeAll(async () => {
    // 1. Initialize SQLite schema & run all 4 migrations
    DatabaseService.init();

    // 2. Login as Admin for center-1 setup
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
  });

  describe("1. SQLite Schema Migration 4 Verification", () => {
    it("confirms DatabaseService migration version is at least 4", () => {
      const version = DatabaseService.getCurrentVersion();
      expect(version).toBeGreaterThanOrEqual(4);
    });

    it("confirms new tables exist in schema", () => {
      const db = DatabaseService.getDb();
      const packages = db.getAllSync("SELECT * FROM packages");
      expect(Array.isArray(packages)).toBe(true);

      const pkgSubjects = db.getAllSync("SELECT * FROM package_subjects");
      expect(Array.isArray(pkgSubjects)).toBe(true);

      const pkgSubs = db.getAllSync(
        "SELECT * FROM student_package_subscriptions",
      );
      expect(Array.isArray(pkgSubs)).toBe(true);

      const overrides = db.getAllSync(
        "SELECT * FROM package_subject_teacher_overrides",
      );
      expect(Array.isArray(overrides)).toBe(true);

      const advCov = db.getAllSync("SELECT * FROM advance_coverages");
      expect(Array.isArray(advCov)).toBe(true);
    });
  });

  describe("2. Standalone Package Management (PackageRepository)", () => {
    let createdPkg: any;

    it("creates a standalone package with valid name and price", async () => {
      createdPkg = await PackageRepository.createPackage({
        name: "باقة اللغات (إنجليزي + فرنساوي)",
        price: 800,
        description: "باقة تشمل مادتي اللغات",
      });

      expect(createdPkg.id).toBeDefined();
      expect(createdPkg.name).toBe("باقة اللغات (إنجليزي + فرنساوي)");
      expect(createdPkg.price).toBe(800);
      expect(createdPkg.status).toBe("active");
    });

    it("rejects creating package with negative price", async () => {
      await expect(
        PackageRepository.createPackage({
          name: "باقة غير صالحة",
          price: -100,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("updates package details (name, price, description)", async () => {
      const updated = await PackageRepository.updatePackage(createdPkg.id, {
        price: 850,
        description: "السعر المحدث",
      });

      expect(updated.price).toBe(850);
      expect(updated.description).toBe("السعر المحدث");
    });

    it("retrieves package by ID and lists packages", () => {
      const pkg = PackageRepository.getPackageById(createdPkg.id);
      expect(pkg).not.toBeNull();
      expect(pkg?.price).toBe(850);

      const list = PackageRepository.getPackages();
      expect(list.some((p) => p.id === createdPkg.id)).toBe(true);
    });
  });

  describe("3. Package Subjects & Strict Teacher-Subject Validation", () => {
    let testPkg: any;
    let mathTeacher: any;
    let physicsTeacher: any;
    let frenchSubject: any;

    beforeAll(async () => {
      testPkg = await PackageRepository.createPackage({
        name: "باقة علمي رياضة",
        price: 1200,
      });

      // Existing seed: teach-1 teaches subj-1 (رياضيات), teach-2 teaches subj-2 (فيزياء)
      mathTeacher = TeacherRepository.findById("teach-1");
      physicsTeacher = TeacherRepository.findById("teach-2");

      // Create a new subject without teacher assigned yet
      frenchSubject = SubjectRepository.createSubject({
        name: "لغة فرنسية",
        code: "FRN",
      });
    });

    it("assigns subjects with teachers who actually teach that subject in the center", async () => {
      const ps1 = await PackageRepository.addPackageSubject({
        packageId: testPkg.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      expect(ps1.packageId).toBe(testPkg.id);
      expect(ps1.subjectId).toBe("subj-1");
      expect(ps1.defaultTeacherId).toBe("teach-1");

      const ps2 = await PackageRepository.addPackageSubject({
        packageId: testPkg.id,
        subjectId: "subj-2",
        defaultTeacherId: "teach-2",
      });
      expect(ps2.subjectId).toBe("subj-2");

      const subjects = PackageRepository.getPackageSubjects(testPkg.id);
      expect(subjects.length).toBe(2);
    });

    it("strictly rejects assigning a teacher to a subject if they do NOT teach it in the center", async () => {
      // teach-1 (math teacher) does NOT teach frenchSubject
      await expect(
        PackageRepository.addPackageSubject({
          packageId: testPkg.id,
          subjectId: frenchSubject.id,
          defaultTeacherId: "teach-1",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects duplicate subject in the same package", async () => {
      await expect(
        PackageRepository.addPackageSubject({
          packageId: testPkg.id,
          subjectId: "subj-1",
          defaultTeacherId: "teach-1",
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("removes a subject from the package", async () => {
      await PackageRepository.removePackageSubject({
        packageId: testPkg.id,
        subjectId: "subj-2",
      });

      const subjects = PackageRepository.getPackageSubjects(testPkg.id);
      expect(subjects.length).toBe(1);
      expect(subjects[0].subjectId).toBe("subj-1");

      // Re-add subj-2 for future subscription tests
      await PackageRepository.addPackageSubject({
        packageId: testPkg.id,
        subjectId: "subj-2",
        defaultTeacherId: "teach-2",
      });
    });
  });

  describe("4. Student Package Subscriptions & Single Debt Cycle Rule", () => {
    let student: any;
    let pkg: any;
    let subscription: any;

    beforeAll(async () => {
      student = StudentRepository.createStudent({
        studentCode: "400001",
        fullName: "كريم حسام الدين",
        phone: "01099998888",
        parentPhone: "01199998888",
        grade: "الصف الثالث الثانوي",
      });

      pkg = await PackageRepository.createPackage({
        name: "باقة التفوق (رياضيات + فيزياء)",
        price: 1500,
      });

      await PackageRepository.addPackageSubject({
        packageId: pkg.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });
      await PackageRepository.addPackageSubject({
        packageId: pkg.id,
        subjectId: "subj-2",
        defaultTeacherId: "teach-2",
      });
    });

    it("subscribes a student to a package and generates exactly ONE debt cycle for the package", async () => {
      subscription = await PackageSubscriptionRepository.subscribeStudent({
        studentId: student.id,
        packageId: pkg.id,
        startDate: "2026-10-01",
      });

      expect(subscription.id).toBeDefined();
      expect(subscription.status).toBe("active");

      // Critical Rule: Exactly ONE debt cycle for 1500 EGP, NOT 1500 per subject
      const cycles = DebtCycleRepository.getCyclesForPackageSubscription(
        subscription.id,
      );
      expect(cycles.length).toBe(1);
      expect(cycles[0].cyclePrice).toBe(1500);
      expect(cycles[0].cycleType).toBe("package");
      expect(cycles[0].startDate).toBe("2026-10-01");
      expect(cycles[0].endDate).toBe("2026-10-28");
    });

    it("rejects duplicate active subscription for same student and package", async () => {
      await expect(
        PackageSubscriptionRepository.subscribeStudent({
          studentId: student.id,
          packageId: pkg.id,
          startDate: "2026-10-01",
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("snapshots price at cycle creation: updating package price later does NOT change existing cycle", async () => {
      // Change package price to 1800
      await PackageRepository.updatePackage(pkg.id, { price: 1800 });

      // Existing cycle must retain 1500
      const cycles = DebtCycleRepository.getCyclesForPackageSubscription(
        subscription.id,
      );
      expect(cycles[0].cyclePrice).toBe(1500);
    });
  });

  describe("5. Package Teacher Overrides & Immutability", () => {
    let student: any;
    let pkg: any;
    let sub: any;
    let secondMathTeacher: any;

    beforeAll(async () => {
      student = StudentRepository.createStudent({
        studentCode: "400002",
        fullName: "ياسين عادل",
        phone: "01077776666",
        parentPhone: "01177776666",
        grade: "الصف الثالث الثانوي",
      });

      // Create a second teacher in center-1 and assign to subj-1 (رياضيات)
      secondMathTeacher = TeacherRepository.createTeacher({
        name: "أ/ سامح فاروق (معلم رياضيات بديل)",
        phone: "01088887777",
      });
      TeacherSubjectRepository.assignTeacherToSubject(
        secondMathTeacher.id,
        "subj-1",
      );

      pkg = await PackageRepository.createPackage({
        name: "باقة العلوم المتكاملة",
        price: 1000,
      });

      await PackageRepository.addPackageSubject({
        packageId: pkg.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      sub = await PackageSubscriptionRepository.subscribeStudent({
        studentId: student.id,
        packageId: pkg.id,
        startDate: "2026-10-01",
      });
    });

    it("sets a teacher override for student subscription with an authorized teacher", async () => {
      const override = await PackageSubscriptionRepository.setTeacherOverride({
        subscriptionId: sub.id,
        subjectId: "subj-1",
        teacherId: secondMathTeacher.id,
      });

      expect(override.subscriptionId).toBe(sub.id);
      expect(override.subjectId).toBe("subj-1");
      expect(override.teacherId).toBe(secondMathTeacher.id);

      const overrides = PackageSubscriptionRepository.getTeacherOverrides(
        sub.id,
      );
      expect(overrides.length).toBe(1);
      expect(overrides[0].teacherId).toBe(secondMathTeacher.id);
    });

    it("rejects teacher override if teacher is NOT assigned to that subject", async () => {
      // teach-2 is a physics teacher, not a math teacher
      await expect(
        PackageSubscriptionRepository.setTeacherOverride({
          subscriptionId: sub.id,
          subjectId: "subj-1",
          teacherId: "teach-2",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("verifies package teacher override does NOT mutate the base package", () => {
      const packageSubjects = PackageRepository.getPackageSubjects(pkg.id);
      const mathPkgSubj = packageSubjects.find(
        (ps) => ps.subjectId === "subj-1",
      );
      // Default teacher remains teach-1
      expect(mathPkgSubj?.defaultTeacherId).toBe("teach-1");
    });

    it("removes teacher override and reverts back to package default teacher", async () => {
      await PackageSubscriptionRepository.removeTeacherOverride({
        subscriptionId: sub.id,
        subjectId: "subj-1",
      });

      const overrides = PackageSubscriptionRepository.getTeacherOverrides(
        sub.id,
      );
      expect(overrides.length).toBe(0);
    });
  });

  describe("6. Package Cancellation & Paid Cycle Boundary Rule", () => {
    let studentUnpaid: any;
    let pkgA: any;
    let subUnpaid: any;

    let studentPaid: any;
    let pkgB: any;
    let subPaid: any;

    beforeAll(async () => {
      pkgA = await PackageRepository.createPackage({
        name: "باقة غير مدفوعة للتجربة",
        price: 900,
      });
      await PackageRepository.addPackageSubject({
        packageId: pkgA.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      studentUnpaid = StudentRepository.createStudent({
        studentCode: "400003",
        fullName: "ماجد توفيق",
        phone: "01066665555",
        parentPhone: "01166665555",
        grade: "الصف الثالث الثانوي",
      });

      subUnpaid = await PackageSubscriptionRepository.subscribeStudent({
        studentId: studentUnpaid.id,
        packageId: pkgA.id,
        startDate: "2026-10-01",
      });

      pkgB = await PackageRepository.createPackage({
        name: "باقة مدفوعة بالكامل",
        price: 900,
      });
      await PackageRepository.addPackageSubject({
        packageId: pkgB.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      studentPaid = StudentRepository.createStudent({
        studentCode: "400004",
        fullName: "طارق سليم",
        phone: "01055554444",
        parentPhone: "01155554444",
        grade: "الصف الثالث الثانوي",
      });

      subPaid = await PackageSubscriptionRepository.subscribeStudent({
        studentId: studentPaid.id,
        packageId: pkgB.id,
        startDate: "2026-10-01",
      });

      // Pay the cycle in full
      const cyclesPaid = DebtCycleRepository.getCyclesForPackageSubscription(
        subPaid.id,
      );
      await PaymentRepository.recordPayment({
        studentId: studentPaid.id,
        debtCycleId: cyclesPaid[0].id,
        amount: 900,
        paymentType: "monthly",
        paymentDate: "2026-10-02",
      });
    });

    it("cancels unpaid package subscription with effective end date = cancellationDate", async () => {
      const cancelled = await PackageSubscriptionRepository.cancelSubscription(
        subUnpaid.id,
        "2026-10-10",
      );

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancellationDate).toBe("2026-10-10");
      expect(cancelled.endDate).toBe("2026-10-10");
    });

    it("STRICT PAID BOUNDARY: cancels paid package subscription with effective end date extended through the end of the paid cycle", async () => {
      // Cancellation date is 2026-10-10, but cycle is paid through 2026-10-28
      const cancelled = await PackageSubscriptionRepository.cancelSubscription(
        subPaid.id,
        "2026-10-10",
      );

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancellationDate).toBe("2026-10-10");
      // Effective eligibility boundary is extended to cycle end date
      expect(cancelled.endDate).toBe("2026-10-28");
    });

    it("prevents generating future debt cycles after cancellation boundary", () => {
      // Trying to generate cycles up to December 2026
      const cycles = DebtCycleRepository.generateCyclesForPackageSubscription(
        subPaid.id,
        "2026-12-01",
      );

      // Must NOT generate any cycle starting after 2026-10-28
      expect(cycles.length).toBe(1);
      expect(cycles[0].cycleNumber).toBe(1);
    });

    it("preserves historical debt cycles without deletion or mutation", () => {
      const cycles = DebtCycleRepository.getCyclesForPackageSubscription(
        subPaid.id,
      );
      expect(cycles.length).toBe(1);
      expect(cycles[0].cyclePrice).toBe(900);
      expect(cycles[0].status).toBe("paid");
    });
  });

  describe("7. Advance Coverage Verification & Strict Rules", () => {
    let student: any;
    let group: any;
    let sessionA: any;
    let sessionB: any;
    let sessionDiffTeacher: any;
    let sessionDiffSubject: any;

    beforeAll(() => {
      student = StudentRepository.createStudent({
        studentCode: "400005",
        fullName: "رامي وجدي",
        phone: "01044443333",
        parentPhone: "01144443333",
        grade: "الصف الثالث الثانوي",
      });

      group = GroupRepository.createGroup({
        name: "مجموعة الرياضيات - حضور مسبق",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 500,
        sessionPrice: 125,
      });

      EnrollmentRepository.enrollStudent({
        studentId: student.id,
        groupId: group.id,
        startDate: "2026-10-01",
      });

      const db = DatabaseService.getDb();
      // Session A: 2026-10-05 14:00 (teach-1, subj-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-adv-a', 'center-1', ?, 'subj-1', 'teach-1', 125, '2026-10-05', '14:00', '16:00', 'open', '2026-10-01')`,
        [group.id],
      );
      // Session B: 2026-10-12 14:00 (strictly future, same teach-1, subj-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-adv-b', 'center-1', ?, 'subj-1', 'teach-1', 125, '2026-10-12', '14:00', '16:00', 'open', '2026-10-01')`,
        [group.id],
      );
      // Session with different teacher: 2026-10-15 (teach-2, subj-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-diff-teach', 'center-1', ?, 'subj-1', 'teach-2', 125, '2026-10-15', '14:00', '16:00', 'open', '2026-10-01')`,
        [group.id],
      );
      // Session with different subject: 2026-10-16 (teach-1, subj-2)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-diff-subj', 'center-1', ?, 'subj-2', 'teach-1', 125, '2026-10-16', '14:00', '16:00', 'open', '2026-10-01')`,
        [group.id],
      );
      // Populate expected students for sess-adv-b
      db.runSync(
        `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
         VALUES ('exp-adv-b', 'center-1', 'sess-adv-b', ?, '2026-10-01')`,
        [student.id],
      );
    });

    it("records advance coverage between two sessions sharing same subject and teacher", async () => {
      const coverage = await MakeupService.recordAdvanceCoverage(
        student.id,
        "sess-adv-a",
        "sess-adv-b",
      );

      expect(coverage.studentId).toBe(student.id);
      expect(coverage.advanceSessionId).toBe("sess-adv-a");
      expect(coverage.targetFutureSessionId).toBe("sess-adv-b");

      expect(
        MakeupService.isSessionCoveredInAdvance(student.id, "sess-adv-b"),
      ).toBe(true);
    });

    it("rejects advance coverage if target session has a different teacher", async () => {
      await expect(
        MakeupService.recordAdvanceCoverage(
          student.id,
          "sess-adv-a",
          "sess-diff-teach",
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects advance coverage if target session has a different subject", async () => {
      await expect(
        MakeupService.recordAdvanceCoverage(
          student.id,
          "sess-adv-a",
          "sess-diff-subj",
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects advance coverage if target session is not in the future relative to advance session", async () => {
      // Reverse direction: sess-adv-b is 10-12, sess-adv-a is 10-05
      await expect(
        MakeupService.recordAdvanceCoverage(
          student.id,
          "sess-adv-b",
          "sess-adv-a",
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("enforces strictly 1-to-1 coverage: rejects covering the target session twice", async () => {
      await expect(
        MakeupService.recordAdvanceCoverage(
          student.id,
          "sess-adv-a",
          "sess-adv-b",
        ),
      ).rejects.toThrow(ConflictError);
    });

    it("enforces strictly 1-to-1 coverage: rejects reusing advance session for another future session", async () => {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-adv-c', 'center-1', 'grp-1', 'subj-1', 'teach-1', 125, '2026-10-19', '14:00', '16:00', 'open', '2026-10-01')`,
      );

      await expect(
        MakeupService.recordAdvanceCoverage(
          student.id,
          "sess-adv-a",
          "sess-adv-c",
        ),
      ).rejects.toThrow(ConflictError);
    });

    it("AbsenceService recognizes student as NOT absent when target future session occurs due to advance coverage", () => {
      // Student is expected in sess-adv-b, has no attendance record for it, but has advance coverage
      const isAbsent = AbsenceService.isStudentAbsent("sess-adv-b", student.id);
      expect(isAbsent).toBe(false);

      const absentees = AbsenceService.getAbsenteesForSession("sess-adv-b");
      expect(absentees.some((s) => s.id === student.id)).toBe(false);
    });
  });

  describe("8. Dynamic Absence Derivation & Next-Eligible-Session Makeup Rule", () => {
    let student: any;
    let missedSession: any;
    let nextEligibleSession: any;
    let thirdSession: any;

    beforeAll(() => {
      student = StudentRepository.createStudent({
        studentCode: "400006",
        fullName: "حسام خيري",
        phone: "01033332222",
        parentPhone: "01133332222",
        grade: "الصف الثالث الثانوي",
      });

      const db = DatabaseService.getDb();
      // Missed Session: 2026-11-01 10:00 (subj-1, teach-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-missed-1', 'center-1', 'grp-1', 'subj-1', 'teach-1', 100, '2026-11-01', '10:00', '12:00', 'open', '2026-09-20')`,
      );
      db.runSync(
        `INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at)
         VALUES ('exp-missed-1', 'center-1', 'sess-missed-1', ?, '2026-09-20')`,
        [student.id],
      );

      // Next eligible session: 2026-11-08 10:00 (subj-1, teach-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-next-elg', 'center-1', 'grp-1', 'subj-1', 'teach-1', 100, '2026-11-08', '10:00', '12:00', 'open', '2026-09-20')`,
      );

      // Third session: 2026-11-15 10:00 (subj-1, teach-1)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-third-elg', 'center-1', 'grp-1', 'subj-1', 'teach-1', 100, '2026-11-15', '10:00', '12:00', 'open', '2026-09-20')`,
      );
    });

    it("identifies student as absent for missed session", () => {
      const isAbsent = AbsenceService.isStudentAbsent(
        "sess-missed-1",
        student.id,
      );
      expect(isAbsent).toBe(true);
    });

    it("identifies the next eligible session strictly as the first subsequent session of the same subject & teacher", () => {
      const nextSession = MakeupService.getNextEligibleSession(
        student.id,
        "sess-missed-1",
      );
      expect(nextSession).not.toBeNull();
      expect(nextSession?.id).toBe("sess-next-elg");
    });

    it("records makeup attendance for the next eligible session linked to original absence", async () => {
      const att = await MakeupService.recordMakeupAttendance({
        studentId: student.id,
        sessionId: "sess-next-elg",
        originalAbsenceId: "sess-missed-1",
      });

      expect(att.attendanceType).toBe("makeup");
      expect(att.originalAbsenceId).toBe("sess-missed-1");
      expect(att.sessionId).toBe("sess-next-elg");
    });

    it("rejects recording makeup for a non-next session or once makeup opportunity is satisfied", async () => {
      // Since sess-next-elg is already attended as makeup for sess-missed-1, trying on sess-third-elg must fail
      await expect(
        MakeupService.recordMakeupAttendance({
          studentId: student.id,
          sessionId: "sess-third-elg",
          originalAbsenceId: "sess-missed-1",
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("9. External Makeup Attendance & Financial Isolation", () => {
    let externalStudent: any;
    let targetSession: any;

    beforeAll(() => {
      externalStudent = StudentRepository.createStudent({
        studentCode: "400007",
        fullName: "أيمن سامي (طالب خارجي)",
        phone: "01022221111",
        parentPhone: "01122221111",
        grade: "الصف الثالث الثانوي",
        studentType: "external",
      });

      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, subject_id, teacher_id, session_price, session_date, start_time, end_time, status, created_at)
         VALUES ('sess-ext-target', 'center-1', 'grp-1', 'subj-1', 'teach-1', 120, '2026-10-20', '16:00', '18:00', 'open', '2026-10-01')`,
      );
    });

    it("records external attendance with isExternal = true and charges snapshotted session_price as cash payment", async () => {
      const att = await AttendanceRepository.recordAttendance({
        studentId: externalStudent.id,
        sessionId: "sess-ext-target",
        status: "present",
        isLate: false,
        isExternal: true,
      });

      expect(att.isExternal).toBe(true);

      // Verify cash payment recorded in payments table
      const db = DatabaseService.getDb();
      const payments = db.getAllSync<any>(
        `SELECT * FROM payments WHERE center_id = ? AND student_id = ? AND session_id = ?`,
        ["center-1", externalStudent.id, "sess-ext-target"],
      );
      expect(payments.length).toBe(1);
      expect(payments[0].payment_type).toBe("session");
      expect(payments[0].payment_method).toBe("cash");
    });

    it("external attendance creates NO monthly debt and does NOT affect monthly subscription calculations", () => {
      const financial = FinancialCalculationService.getStudentFinancialStatus(
        externalStudent.id,
      );
      // External student has 0 monthly debt cycles
      expect(financial.monthlyTotalDue).toBe(0);
      expect(financial.monthlyRemainingDebt).toBe(0);
      // Session payment is isolated
      expect(financial.sessionTotalPaid).toBe(120);
      expect(financial.sessionPayments.length).toBe(1);
    });
  });

  describe("10. Unified Financial Breakdown (Group vs Package)", () => {
    let studentDual: any;
    let group: any;
    let pkg: any;

    beforeAll(async () => {
      studentDual = StudentRepository.createStudent({
        studentCode: "400008",
        fullName: "شريف منير (مشترك مجموعة + باقة)",
        phone: "01012341234",
        parentPhone: "01112341234",
        grade: "الصف الثالث الثانوي",
      });

      // 1. Group enrollment (monthlyPrice = 500)
      group = GroupRepository.createGroup({
        name: "مجموعة التاريخ",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 500,
        sessionPrice: 100,
      });

      EnrollmentRepository.enrollStudent({
        studentId: studentDual.id,
        groupId: group.id,
        startDate: "2026-10-01",
      });

      // 2. Package subscription (price = 800)
      pkg = await PackageRepository.createPackage({
        name: "باقة اللغات المكثفة",
        price: 800,
      });
      await PackageRepository.addPackageSubject({
        packageId: pkg.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      await PackageSubscriptionRepository.subscribeStudent({
        studentId: studentDual.id,
        packageId: pkg.id,
        startDate: "2026-10-01",
      });
    });

    it("correctly separates and aggregates group monthly due and package monthly due", () => {
      const financial = FinancialCalculationService.getStudentFinancialStatus(
        studentDual.id,
        "2026-10-01",
      );

      expect(financial.groupMonthlyDue).toBe(500);
      expect(financial.packageMonthlyDue).toBe(800);
      expect(financial.monthlyTotalDue).toBe(1300);
      expect(financial.monthlyRemainingDebt).toBe(1300);
    });

    it("applies payment to group cycle without affecting package debt", async () => {
      const cycles = DebtCycleRepository.getCyclesForStudent(studentDual.id);
      const groupCycle = cycles.find((c) => c.cycleType !== "package");
      expect(groupCycle).toBeDefined();

      await PaymentRepository.recordPayment({
        studentId: studentDual.id,
        debtCycleId: groupCycle!.id,
        amount: 500,
        paymentType: "monthly",
        paymentDate: "2026-10-02",
      });

      const financial = FinancialCalculationService.getStudentFinancialStatus(
        studentDual.id,
      );
      expect(financial.groupRemainingDebt).toBe(0);
      expect(financial.packageRemainingDebt).toBe(800);
      expect(financial.monthlyRemainingDebt).toBe(800);
    });

    it("session payments NEVER reduce package or group monthly debt", async () => {
      await PaymentRepository.recordSessionPayment({
        studentId: studentDual.id,
        sessionId: "sess-ext-target",
        amount: 200,
        paymentDate: "2026-10-03",
      });

      const financial = FinancialCalculationService.getStudentFinancialStatus(
        studentDual.id,
      );
      // Monthly remaining debt remains 800
      expect(financial.monthlyRemainingDebt).toBe(800);
      expect(financial.packageRemainingDebt).toBe(800);
      expect(financial.sessionTotalPaid).toBe(200);
    });
  });

  describe("11. Multi-Center Isolation", () => {
    it("ensures center-2 cannot view or modify packages from center-1", async () => {
      // Switch to center-2
      await useAuthStore.getState().selectCenter("center-2");

      const center2Packages = PackageRepository.getPackages(true);
      // center-1 packages must NOT appear in center-2
      expect(center2Packages.some((p) => p.name.includes("باقة اللغات"))).toBe(
        false,
      );

      // Switch back to center-1
      await useAuthStore.getState().selectCenter("center-1");
    });
  });

  describe("12. Role-Based Permission Enforcement", () => {
    it("rejects secretary role when attempting to create a package (requires packages.create)", async () => {
      // Login as secretary
      await useAuthStore.getState().login("01000000002", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      await expect(
        PackageRepository.createPackage({
          name: "باقة غير مصرح بها",
          price: 500,
        }),
      ).rejects.toThrow(ForbiddenError);

      // Restore Admin
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });
  });

  describe("13. Financial Totals Separation & Payment Method Regression Suite", () => {
    let regStudent: any;
    let regGroup: any;
    let regPkg: any;

    beforeAll(async () => {
      // Ensure admin login in center-1
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");

      regStudent = StudentRepository.createStudent({
        studentCode: "400009",
        fullName: "طارق سليم (اختبارات الفصل المالي)",
        phone: "01099998888",
        parentPhone: "01199998888",
        grade: "الصف الثالث الثانوي",
      });

      // Group with monthlyPrice = 400
      regGroup = GroupRepository.createGroup({
        name: "مجموعة الكيمياء للمراجعة",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 400,
        sessionPrice: 100,
      });

      EnrollmentRepository.enrollStudent({
        studentId: regStudent.id,
        groupId: regGroup.id,
        startDate: "2026-11-01",
      });

      // Package with price = 600
      regPkg = await PackageRepository.createPackage({
        name: "باقة العلوم المتكاملة",
        price: 600,
      });
      await PackageRepository.addPackageSubject({
        packageId: regPkg.id,
        subjectId: "subj-1",
        defaultTeacherId: "teach-1",
      });

      await PackageSubscriptionRepository.subscribeStudent({
        studentId: regStudent.id,
        packageId: regPkg.id,
        startDate: "2026-11-01",
      });
    });

    it("a) monthly debt + session payment: session payments do NOT reduce group subscription debt", async () => {
      const before = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      expect(before.groupMonthlyDue).toBe(400);
      expect(before.groupMonthlyPaid).toBe(0);
      expect(before.groupRemainingDebt).toBe(400);

      // Record a session payment of 150 EGP with paymentType: 'session', paymentMethod: 'cash'
      const pay = await PaymentRepository.recordPayment({
        studentId: regStudent.id,
        sessionId: "sess-1",
        amount: 150,
        paymentType: "session",
        paymentDate: "2026-11-02",
      });
      expect(pay.paymentType).toBe("session");
      expect(pay.paymentMethod).toBe("cash");

      const after = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );

      // Group subscription debt MUST remain completely unaffected (400 EGP)
      expect(after.groupMonthlyDue).toBe(400);
      expect(after.groupMonthlyPaid).toBe(0);
      expect(after.groupRemainingDebt).toBe(400);

      // Session payment is isolated
      expect(after.sessionTotalPaid).toBe(150);
      expect(after.sessionPaymentsTotal).toBe(150);

      // totalDue, totalPaid, totalRemainingDebt must represent subscription debt only
      expect(after.totalDue).toBe(1000); // 400 group + 600 package
      expect(after.totalPaid).toBe(0);
      expect(after.totalRemainingDebt).toBe(1000);
      expect(after.remainingBalance).toBe(1000);
    });

    it("b) package debt + session payment: session payments do NOT reduce package subscription debt", async () => {
      const status = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );

      // Package debt MUST remain completely unaffected (600 EGP)
      expect(status.packageMonthlyDue).toBe(600);
      expect(status.packageMonthlyPaid).toBe(0);
      expect(status.packageRemainingDebt).toBe(600);

      // Record another session payment of 100 EGP
      await PaymentRepository.recordSessionPayment({
        studentId: regStudent.id,
        sessionId: "sess-2",
        amount: 100,
        paymentDate: "2026-11-03",
      });

      const updated = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      expect(updated.packageRemainingDebt).toBe(600);
      expect(updated.sessionPaymentsTotal).toBe(250); // 150 + 100
      expect(updated.totalRemainingDebt).toBe(1000); // subscription debt intact
    });

    it("c) external makeup payment: records paymentType 'session' and paymentMethod 'cash', zero subscription debt", async () => {
      const extStudent = StudentRepository.createStudent({
        studentCode: "400010",
        fullName: "نادر فتحي (طالب خارجي تجريبي)",
        phone: "01033334444",
        parentPhone: "01133334444",
        grade: "الصف الثالث الثانوي",
        studentType: "external",
      });

      const att = await AttendanceRepository.recordAttendance({
        studentId: extStudent.id,
        sessionId: "sess-1",
        status: "present",
        isLate: false,
        isExternal: true,
      });
      expect(att.isExternal).toBe(true);

      const db = DatabaseService.getDb();
      const extPayments = db.getAllSync<any>(
        `SELECT * FROM payments WHERE center_id = ? AND student_id = ? AND session_id = ?`,
        ["center-1", extStudent.id, "sess-1"],
      );
      expect(extPayments.length).toBe(1);
      expect(extPayments[0].amount).toBe(400); // sess-1 seed price is 400
      expect(extPayments[0].payment_type).toBe("session");
      expect(extPayments[0].payment_method).toBe("cash");

      const extFin = FinancialCalculationService.getStudentFinancialStatus(
        extStudent.id,
      );
      expect(extFin.groupMonthlyDue).toBe(0);
      expect(extFin.packageMonthlyDue).toBe(0);
      expect(extFin.monthlyTotalDue).toBe(0);
      expect(extFin.totalDue).toBe(0);
      expect(extFin.totalPaid).toBe(0);
      expect(extFin.totalRemainingDebt).toBe(0);
      expect(extFin.remainingBalance).toBe(0);
      expect(extFin.sessionPaymentsTotal).toBe(400);
    });

    it("d) session payment exceeding monthly price: NEVER reduces monthly subscription debt", async () => {
      const bigSessionStudent = StudentRepository.createStudent({
        studentCode: "400011",
        fullName: "رامي خليل (مدفوعات حصص كبيرة)",
        phone: "01077776666",
        parentPhone: "01177776666",
        grade: "الصف الثالث الثانوي",
      });

      const grp = GroupRepository.createGroup({
        name: "مجموعة الأحياء الأساسية",
        teacherId: "teach-1",
        subjectId: "subj-1",
        grade: "الصف الثالث الثانوي",
        monthlyPrice: 300,
        sessionPrice: 100,
      });

      EnrollmentRepository.enrollStudent({
        studentId: bigSessionStudent.id,
        groupId: grp.id,
        startDate: "2026-11-01",
      });

      // Student has 300 EGP monthly debt
      const initFin = FinancialCalculationService.getStudentFinancialStatus(
        bigSessionStudent.id,
        "2026-11-01",
      );
      expect(initFin.groupMonthlyDue).toBe(300);
      expect(initFin.groupRemainingDebt).toBe(300);

      // Student pays 1500 EGP for multiple private/extra sessions (5x the monthly price)
      await PaymentRepository.recordSessionPayment({
        studentId: bigSessionStudent.id,
        sessionId: "sess-1",
        amount: 1500,
        paymentDate: "2026-11-02",
      });

      const afterBigSess =
        FinancialCalculationService.getStudentFinancialStatus(
          bigSessionStudent.id,
          "2026-11-01",
        );
      // Monthly debt remains 300 EGP — it is NOT wiped, NOT reduced, NOT negative!
      expect(afterBigSess.groupMonthlyDue).toBe(300);
      expect(afterBigSess.groupMonthlyPaid).toBe(0);
      expect(afterBigSess.groupRemainingDebt).toBe(300);
      expect(afterBigSess.totalDue).toBe(300);
      expect(afterBigSess.totalPaid).toBe(0);
      expect(afterBigSess.totalRemainingDebt).toBe(300);
      expect(afterBigSess.remainingBalance).toBe(300);
      expect(afterBigSess.sessionPaymentsTotal).toBe(1500);
    });

    it("e) payment reversal: restores subscription remaining debt and session payments independently", async () => {
      // 1. Pay 400 EGP for group monthly cycle
      const cycles = DebtCycleRepository.getCyclesForStudent(regStudent.id);
      const groupCycle = cycles.find((c) => c.cycleType !== "package");
      expect(groupCycle).toBeDefined();

      const monthlyPay = await PaymentRepository.recordPayment({
        studentId: regStudent.id,
        debtCycleId: groupCycle!.id,
        amount: 400,
        paymentType: "monthly",
        paymentDate: "2026-11-04",
      });

      let fin = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      expect(fin.groupRemainingDebt).toBe(0);
      expect(fin.totalRemainingDebt).toBe(600); // package debt remaining

      // Reverse the monthly payment
      await PaymentRepository.reversePayment({
        paymentId: monthlyPay.id,
        reason: "دفعة خاطئة للمجموعة",
      });

      fin = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      // Group remaining debt is restored back to 400 EGP!
      expect(fin.groupRemainingDebt).toBe(400);
      expect(fin.totalRemainingDebt).toBe(1000);
      expect(fin.sessionPaymentsTotal).toBe(250); // session payments unchanged

      // 2. Now record and reverse a session payment
      const sessPay = await PaymentRepository.recordSessionPayment({
        studentId: regStudent.id,
        sessionId: "sess-1",
        amount: 50,
        paymentDate: "2026-11-05",
      });

      fin = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      expect(fin.sessionPaymentsTotal).toBe(300); // 250 + 50

      await PaymentRepository.reversePayment({
        paymentId: sessPay.id,
        reason: "إلغاء حصة إضافية",
      });

      fin = FinancialCalculationService.getStudentFinancialStatus(
        regStudent.id,
        "2026-11-01",
      );
      // Session payments drops back to 250 EGP, subscription debt remains 1000 EGP!
      expect(fin.sessionPaymentsTotal).toBe(250);
      expect(fin.groupRemainingDebt).toBe(400);
      expect(fin.packageRemainingDebt).toBe(600);
      expect(fin.totalRemainingDebt).toBe(1000);
    });
  });
});
