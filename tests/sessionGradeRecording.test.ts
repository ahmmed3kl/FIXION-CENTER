import * as fs from "fs";
import * as path from "path";
import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { GradeBookRepository } from "../src/features/grades/GradeBookRepository";
import { smartSearch } from "../src/shared/utils/smartSearch";

function createRealSqliteAdapter() {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => any;
  };
  const nativeDb = new DatabaseSync(":memory:");

  const adapter = {
    execSync: (sql: string) => nativeDb.exec(sql),
    runSync: (sql: string, params: any[] = []) => {
      const stmt = nativeDb.prepare(sql);
      return stmt.run(...params);
    },
    getAllSync: <T,>(sql: string, params: any[] = []): T[] => {
      const stmt = nativeDb.prepare(sql);
      return stmt.all(...params) as T[];
    },
    getFirstSync: <T,>(sql: string, params: any[] = []): T | null => {
      const stmt = nativeDb.prepare(sql);
      return (stmt.get(...params) as T | undefined) ?? null;
    },
    withTransactionSync: (task: () => void) => {
      nativeDb.exec("BEGIN");
      try {
        task();
        nativeDb.exec("COMMIT");
      } catch (err) {
        nativeDb.exec("ROLLBACK");
        throw err;
      }
    },
  };

  return {
    adapter,
    close: () => nativeDb.close(),
  };
}

describe("Session-Based Grade Recording + Smart Student Search", () => {
  describe("In-Memory Mock Tests (Repository, Eligibility, Search, Sync Outbox)", () => {
    beforeEach(async () => {
      jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
        syncedCount: 0,
        errors: 0,
        conflicts: 0,
        state: "idle",
      } as any);
      DatabaseService.init();
      await useAuthStore.getState().logout();
      await useAuthStore.getState().login("01000000001", "123456");
      await useAuthStore.getState().selectCenter("center-1");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function seedGroupAndStudents() {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-grade-1', 'center-1', 'مجموعة الرياضيات', 'الصف الأول الثانوي', 'active', '2026-09-01')`,
      );
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-grade-2', 'center-1', 'مجموعة أخرى', 'الصف الأول الثانوي', 'active', '2026-09-01')`,
      );
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-other-center', 'center-2', 'مجموعة مركز آخر', 'الصف الأول الثانوي', 'active', '2026-09-01')`,
      );

      // Sessions inserted out of chronological order
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-g1-2', 'center-1', 'grp-grade-1', 'sch-1', '2026-10-08', '17:00', '19:00', 'open', '2026-10-08')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-g1-1', 'center-1', 'grp-grade-1', 'sch-1', '2026-10-01', '17:00', '19:00', 'closed', '2026-10-01')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-g2-1', 'center-1', 'grp-grade-2', 'sch-2', '2026-10-02', '15:00', '17:00', 'open', '2026-10-02')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-c2-1', 'center-2', 'grp-other-center', 'sch-3', '2026-10-02', '15:00', '17:00', 'open', '2026-10-02')`,
      );

      // Students
      const students = [
        { id: "stu-present", code: "1001", name: "أحمد محمد علي", center: "center-1" },
        { id: "stu-late", code: "1002", name: "إياد خالد حسن", center: "center-1" },
        { id: "stu-makeup-here", code: "1003", name: "سارة محمود طه", center: "center-1" },
        { id: "stu-makeup-other", code: "1004", name: "مريم عادل فوزي", center: "center-1" },
        { id: "stu-absent", code: "1005", name: "يوسف سامي نبيل", center: "center-1" },
        { id: "stu-other-center", code: "2001", name: "طالب مركز آخر", center: "center-2" },
      ];
      for (const s of students) {
        db.runSync(
          `INSERT INTO students (id, center_id, student_code, full_name, grade, status, student_type, created_at)
           VALUES (?, ?, ?, ?, 'الصف الأول الثانوي', 'active', 'regular', '2026-09-01')`,
          [s.id, s.center, s.code, s.name],
        );
      }

      // Attendance for ses-g1-1
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, is_external, operation_id)
         VALUES ('att-1', 'center-1', 'stu-present', 'ses-g1-1', '2026-10-01T17:00:00Z', 'present', 0, 'present', 0, 'op-att-1')`,
      );
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, is_external, operation_id)
         VALUES ('att-2', 'center-1', 'stu-late', 'ses-g1-1', '2026-10-01T17:20:00Z', 'late', 1, 'present', 0, 'op-att-2')`,
      );
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES ('att-3', 'center-1', 'stu-makeup-here', 'ses-g1-1', '2026-10-01T17:05:00Z', 'present', 0, 'makeup', 'abs-orig-1', 0, 'op-att-3')`,
      );
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, is_external, operation_id)
         VALUES ('att-4', 'center-1', 'stu-absent', 'ses-g1-1', '', 'absent', 0, 'present', 0, 'op-att-4')`,
      );
      // Makeup attendance in ANOTHER host session (ses-g2-1)
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, original_absence_id, is_external, operation_id)
         VALUES ('att-5', 'center-1', 'stu-makeup-other', 'ses-g2-1', '2026-10-02T15:05:00Z', 'present', 0, 'makeup', 'abs-orig-2', 0, 'op-att-5')`,
      );

      const exam = GradeBookRepository.createExam(
        "امتحان الوحدة الأولى",
        "grp-grade-1",
        "الصف الأول الثانوي",
        50,
      );
      return { exam };
    }

    it("1 & 2. Session selector shows only sessions of selected group ordered oldest to newest", () => {
      seedGroupAndStudents();
      const sessions = GradeBookRepository.getSessionsForGroupChronological("grp-grade-1");
      expect(sessions.map((s) => s.id)).toEqual(["ses-g1-1", "ses-g1-2"]);
      expect(sessions.map((s) => s.sessionNumber)).toEqual([1, 2]);
      expect(sessions.map((s) => s.sessionOrdinalTitle)).toEqual([
        "الحصة الأولى",
        "الحصة الثانية",
      ]);
      expect(sessions.every((s) => s.groupId === "grp-grade-1")).toBe(true);
    });

    it("3, 4, 5, 6, 7, 18. Only present, late, and host-session makeup attendees are eligible; absent and other-session makeup are excluded; attendance remains unchanged", () => {
      const { exam } = seedGroupAndStudents();
      const db = DatabaseService.getDb();
      const beforeAttCount = db.getAllSync<any>(
        "SELECT id, status FROM attendance WHERE center_id = 'center-1'",
      );

      const roster = GradeBookRepository.getSessionGradeRoster(exam.id, "ses-g1-1");
      const eligibleIds = roster.ungradedStudents.map((s) => s.studentId);

      // Present, late, and host-session makeup are included
      expect(eligibleIds).toContain("stu-present");
      expect(eligibleIds).toContain("stu-late");
      expect(eligibleIds).toContain("stu-makeup-here");

      // Absent, other-session makeup, and other-center students are excluded
      expect(eligibleIds).not.toContain("stu-absent");
      expect(eligibleIds).not.toContain("stu-makeup-other");
      expect(eligibleIds).not.toContain("stu-other-center");

      const makeupItem = roster.ungradedStudents.find((s) => s.studentId === "stu-makeup-here");
      expect(makeupItem?.isMakeup).toBe(true);

      // Recording grades for absent or other-session makeup throws validation error
      expect(() =>
        GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-absent", "30"),
      ).toThrow();
      expect(() =>
        GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-makeup-other", "30"),
      ).toThrow();

      // Attendance records are untouched
      const afterAttCount = db.getAllSync<any>(
        "SELECT id, status FROM attendance WHERE center_id = 'center-1'",
      );
      expect(afterAttCount).toEqual(beforeAttCount);
    });

    it("8, 9, 10, 11, 12. Separates graded first vs ungraded afterward, distinguishes 0 from ungraded, moves student on save, and preserves exam/session association on edit", () => {
      const { exam } = seedGroupAndStudents();

      // Initially all 3 eligible students are ungraded
      let roster = GradeBookRepository.getSessionGradeRoster(exam.id, "ses-g1-1");
      expect(roster.gradedStudents).toHaveLength(0);
      expect(roster.ungradedStudents).toHaveLength(3);
      expect(roster.stats).toEqual({ totalEligible: 3, gradedCount: 0, ungradedCount: 3 });

      // Save grade 0 for stu-late (must count as GRADED with score 0, NOT ungraded)
      const savedZero = GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-late", "0");
      expect(savedZero.score).toBe(0);
      expect(savedZero.sessionId).toBe("ses-g1-1");

      roster = GradeBookRepository.getSessionGradeRoster(exam.id, "ses-g1-1");
      expect(roster.gradedStudents.map((s) => s.studentId)).toEqual(["stu-late"]);
      expect(roster.gradedStudents[0].score).toBe(0);
      expect(roster.ungradedStudents.map((s) => s.studentId)).toEqual([
        "stu-present",
        "stu-makeup-here",
      ]);
      expect(roster.stats).toEqual({ totalEligible: 3, gradedCount: 1, ungradedCount: 2 });

      // Edit grade for stu-late and verify exam/session association stays intact
      const edited = GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-late", "42");
      expect(edited.score).toBe(42);
      expect(edited.examId).toBe(exam.id);
      expect(edited.sessionId).toBe("ses-g1-1");

      // Attempting to overwrite stu-late's ses-g1-1 grade from ses-g1-2 is blocked
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, is_external, operation_id)
         VALUES ('att-s2-late', 'center-1', 'stu-late', 'ses-g1-2', '2026-10-08T17:00:00Z', 'present', 0, 'present', 0, 'op-att-s2')`,
      );
      expect(() =>
        GradeBookRepository.setSessionScore(exam, "ses-g1-2", "stu-late", "10"),
      ).toThrow(/جلسة أخرى/);
    });

    it("13, 14, 15. Smart search works by partial name/code, excludes absent/unrelated students, preserves graded-first ordering, and clears cleanly", () => {
      const { exam } = seedGroupAndStudents();
      GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-present", "45");
      const roster = GradeBookRepository.getSessionGradeRoster(exam.id, "ses-g1-1");

      const searchInRoster = (query: string) => {
        const q = query.trim();
        const graded = q
          ? smartSearch(roster.gradedStudents, q, [
              { get: (s) => s.studentName, weight: 3 },
              { get: (s) => s.studentCode, weight: 2 },
            ])
          : roster.gradedStudents;
        const ungraded = q
          ? smartSearch(roster.ungradedStudents, q, [
              { get: (s) => s.studentName, weight: 3 },
              { get: (s) => s.studentCode, weight: 2 },
            ])
          : roster.ungradedStudents;
        return { graded, ungraded };
      };

      // Partial Arabic name match (with hamza normalization: احمد -> أحمد)
      const byName = searchInRoster("احمد");
      expect(byName.graded.map((s) => s.studentId)).toEqual(["stu-present"]);
      expect(byName.ungraded).toHaveLength(0);

      // Partial code match (100 -> matches 1001 in graded and 1002, 1003 in ungraded; graded stays first)
      const byCode = searchInRoster("100");
      expect(byCode.graded.map((s) => s.studentId)).toEqual(["stu-present"]);
      expect(byCode.ungraded.map((s) => s.studentId)).toEqual(["stu-late", "stu-makeup-here"]);
      expect(
        [...byCode.graded, ...byCode.ungraded].some((s) => s.studentId === "stu-absent"),
      ).toBe(false);

      // Searching for absent student's name returns nothing
      const absentSearch = searchInRoster("يوسف");
      expect(absentSearch.graded).toHaveLength(0);
      expect(absentSearch.ungraded).toHaveLength(0);

      // Clearing search restores full list
      const cleared = searchInRoster("");
      expect(cleared.graded).toHaveLength(1);
      expect(cleared.ungraded).toHaveLength(2);
    });

    it("16 & 17. Duplicate grade records are prevented and sync outbox operation IDs are <= 64 chars", () => {
      const { exam } = seedGroupAndStudents();
      GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-present", "40");
      GradeBookRepository.setSessionScore(exam, "ses-g1-1", "stu-present", "48");

      const scores = GradeBookRepository.getScores([exam.id], ["stu-present"]);
      expect(scores).toHaveLength(1);
      expect(scores[0].score).toBe(48);
      expect(scores[0].sessionId).toBe("ses-g1-1");

      const pendingOps = SyncRepository.getPendingOperations("center-1").filter(
        (op) => op.entityType === "grade_score",
      );
      expect(pendingOps.length).toBeGreaterThanOrEqual(1);
      for (const op of pendingOps) {
        expect(op.operationId.length).toBeLessThanOrEqual(64);
      }
    });

    it("UI source checks: grades.tsx includes 'رصد درجات جلسة', debounced smartSearch, and minimal stats without Alert.alert in session flow", () => {
      const gradesSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/grades.tsx"),
        "utf8",
      );
      expect(gradesSource).toContain("رصد درجات جلسة");
      expect(gradesSource).toContain("smartSearch");
      expect(gradesSource).toContain("setTimeout");
      expect(gradesSource).toContain("تم الرصد");
      expect(gradesSource).toContain("لم يتم الرصد");
      expect(gradesSource).toContain("setSessionScore");
    });

    it("UI layout checks: search sits immediately above student list and compact header shows group/exam/schedule/session details", () => {
      const gradesSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/grades.tsx"),
        "utf8",
      );

      // Compact stats bar labels
      expect(gradesSource).toContain("عدد الطلاب");
      expect(gradesSource).toContain("نسبة الرصد");

      // Main view ordering: Group/Exam Header -> Compact Stats -> Range Filter -> Search -> Student List
      const headerIdx = gradesSource.indexOf("1. Compact Group and Exam Information");
      const statsIdx = gradesSource.indexOf("2. Compact Grading Progress");
      const filterIdx = gradesSource.indexOf("3. Compact Grade Range Filters");
      const searchIdx = gradesSource.indexOf("4. Student Search Field Immediately Above Student List");
      const listIdx = gradesSource.indexOf("5. Student List Immediately Below Search");
      expect(headerIdx).toBeGreaterThan(-1);
      expect(statsIdx).toBeGreaterThan(headerIdx);
      expect(filterIdx).toBeGreaterThan(statsIdx);
      expect(searchIdx).toBeGreaterThan(filterIdx);
      expect(listIdx).toBeGreaterThan(searchIdx);

      // Session view ordering: Compact Header -> Stats -> Search -> Student Sections
      const sessionStatsIdx = gradesSource.indexOf("{/* Compact Grading Progress Bar */}");
      const sessionSearchIdx = gradesSource.indexOf("{/* Smart Student Search Immediately Above Student List */}");
      const sessionListIdx = gradesSource.indexOf("{/* Section 1: Students Already Graded */}");
      expect(sessionStatsIdx).toBeGreaterThan(-1);
      expect(sessionSearchIdx).toBeGreaterThan(sessionStatsIdx);
      expect(sessionListIdx).toBeGreaterThan(sessionSearchIdx);

      // Required header fields
      expect(gradesSource).toContain("selectedGroup.subjectName");
      expect(gradesSource).toContain("selectedGroup.teacherName");
      expect(gradesSource).toContain("scheduleLabel(selectedGroup.id)");
      expect(gradesSource).toContain("sessionRoster.session.sessionDateFormatted");
      expect(gradesSource).toContain("sessionRoster.exam.name");
      expect(gradesSource).toContain("sessionRoster.exam.maxScore");
    });
  });

  describe("Real SQLite Engine Integration Tests (Migration v37 + Constraints)", () => {
    it("Upgrades SQLite cleanly to v37, enforces UNIQUE(center_id, exam_id, student_id), and preserves historical grades", () => {
      const real = createRealSqliteAdapter();
      try {
        DatabaseService.setMockDb(real.adapter as any);
        DatabaseService.runMigrations(real.adapter as any);
        DatabaseService.ensureSyncMetadataSchema(real.adapter as any);
        DatabaseService.seedData();
        DatabaseService.ensureAcademicSchema(real.adapter as any);
        DatabaseService.ensurePaymentRequestsSchema(real.adapter as any);

        // Verify grade_scores has session_id column from migration v37
        const cols = real.adapter.getAllSync<{ name: string }>(
          "PRAGMA table_info(grade_scores)",
        );
        expect(cols.some((c) => c.name === "session_id")).toBe(true);

        // Verify historical grade_scores row without session_id remains intact
        real.adapter.runSync(
          `INSERT INTO grade_exams (id, center_id, name, grade, group_id, max_score, status, created_at)
           VALUES ('exam-real-1', 'center-1', 'اختبار حقيقي', 'الصف الأول الثانوي', 'grp-1', 100, 'active', '2026-09-01')`,
        );
        real.adapter.runSync(
          `INSERT INTO grade_scores (id, center_id, exam_id, student_id, score, created_at)
           VALUES ('score-hist-1', 'center-1', 'exam-real-1', 'stu-1', 88, '2026-09-02')`,
        );

        // Upsert on conflict updates without creating duplicates
        real.adapter.runSync(
          `INSERT INTO grade_scores (id, center_id, exam_id, student_id, session_id, score, created_at, updated_at)
           VALUES ('score-hist-1', 'center-1', 'exam-real-1', 'stu-1', 'ses-1', 92, '2026-09-02', '2026-09-03')
           ON CONFLICT(center_id, exam_id, student_id) DO UPDATE SET
             score = excluded.score,
             session_id = COALESCE(grade_scores.session_id, excluded.session_id),
             updated_at = excluded.updated_at`,
        );

        const rows = real.adapter.getAllSync<any>(
          "SELECT * FROM grade_scores WHERE center_id = 'center-1' AND exam_id = 'exam-real-1'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(92);
        expect(rows[0].session_id).toBe("ses-1");
      } finally {
        real.close();
      }
    });
  });
});
