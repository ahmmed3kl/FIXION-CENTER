import * as fs from "fs";
import * as path from "path";
import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import {
  formatCairoDateTime,
  formatSessionDateArabic,
  formatSessionTimeRangeArabic,
  HomeworkEvaluationRepository,
  normalizeSessionDateOnly,
} from "../src/features/homework/HomeworkEvaluationRepository";
import { NotificationService } from "../src/features/notifications/NotificationService";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";

describe("homework evaluation data", () => {
  beforeEach(async () => {
    jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "idle",
    } as any);
    DatabaseService.init();
    DatabaseService.getDb().runSync(
      `INSERT INTO card_ranges (id, center_id, start_code, end_code, status, created_at)
       VALUES ('range-hw-test-c1', 'center-1', '00001', '99999', 'active', '2026-09-01')`,
    );
    await useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createSession(id: string, centerId = "center-1", groupId = "group-homework") {
    DatabaseService.getDb().runSync(
      `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, centerId, groupId, `schedule-${id}`, "2026-10-06", "10:00", "12:00", "completed", "2026-10-06T10:00:00.000Z"],
    );
  }

  function createExam(id: string, sessionId: string) {
    DatabaseService.getDb().runSync(
      `INSERT INTO grade_exams (id, center_id, name, grade, session_id, max_score, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, "center-1", "اختبار الواجب", "الصف الأول الثانوي", sessionId, 10, "active", "2026-10-06", "2026-10-06"],
    );
  }

  function createStudent() {
    return StudentRepository.createStudent({
      studentCode: "99101",
      cardCode: "99101",
      fullName: "طالب اختبار الواجب",
      phone: "01012345678",
      parentPhone: "01112345678",
      grade: "الصف الأول الثانوي",
    });
  }

  it("keeps each student evaluation scoped to its session and preserves history when cleared", () => {
    const student = createStudent();
    createSession("session-homework-1");
    createSession("session-homework-2");
    const completed = HomeworkEvaluationRepository.createStatus("مكتمل");
    const notSolved = HomeworkEvaluationRepository.createStatus("لم يحل");

    HomeworkEvaluationRepository.setForSession("session-homework-1", student.id, completed.id);
    HomeworkEvaluationRepository.setForSession("session-homework-2", student.id, notSolved.id);

    expect(HomeworkEvaluationRepository.getForSession("session-homework-1", student.id)?.statusName).toBe("مكتمل");
    expect(HomeworkEvaluationRepository.getForSession("session-homework-2", student.id)?.statusName).toBe("لم يحل");
    expect(HomeworkEvaluationRepository.getForStudent(student.id)).toHaveLength(2);
    expect(() => HomeworkEvaluationRepository.removeStatus(completed.id)).toThrow("لا يمكن حذف حالة");

    HomeworkEvaluationRepository.setForSession("session-homework-1", student.id, null);
    expect(HomeworkEvaluationRepository.getForSession("session-homework-1", student.id)).toBeNull();
    expect(HomeworkEvaluationRepository.getForStudent(student.id)).toHaveLength(1);
    expect(() => HomeworkEvaluationRepository.removeStatus(completed.id)).toThrow("لا يمكن حذف حالة");
  });

  it("isolates master statuses by active center and rejects cross-center session assignment", () => {
    const student = createStudent();
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO homework_evaluation_statuses (id, center_id, name, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["other-center-status", "center-2", "خاص بمركز آخر", "active", "2026-10-06"],
    );
    createSession("other-center-session", "center-2", "other-group");

    expect(HomeworkEvaluationRepository.listStatuses()).toEqual([]);
    expect(() => HomeworkEvaluationRepository.setForSession("other-center-session", student.id, "other-center-status"))
      .toThrow("الحصة غير موجودة في هذا المركز");
  });

  it("requires the dedicated homework management permission for master data", () => {
    const currentUser = useAuthStore.getState().currentUser!;
    useAuthStore.setState({
      currentUser: { ...currentUser, permissions: ["attendance.create"] },
    });

    expect(() => HomeworkEvaluationRepository.createStatus("مكتمل")).toThrow("ليس لديك صلاحية إدارة");
  });

  it("allows reusing a name only after an unused status is deleted", () => {
    const oldStatus = HomeworkEvaluationRepository.createStatus("قديم");
    HomeworkEvaluationRepository.removeStatus(oldStatus.id);

    const replacement = HomeworkEvaluationRepository.createStatus("قديم");

    expect(replacement.id).not.toBe(oldStatus.id);
    expect(HomeworkEvaluationRepository.listStatuses().map((status) => status.id)).toContain(replacement.id);
  });

  it("includes the evaluation from the exam's matching session in grade notifications", () => {
    const student = createStudent();
    createSession("session-homework-grade");
    createExam("exam-homework-grade", "session-homework-grade");
    const completed = HomeworkEvaluationRepository.createStatus("مكتمل");
    HomeworkEvaluationRepository.setForSession("session-homework-grade", student.id, completed.id);

    const event = NotificationService.notifyGrades({
      studentId: student.id,
      examId: "exam-homework-grade",
      examName: "اختبار الواجب",
      summary: "اختبار الواجب: 9/10",
    });
    const deliveries = DatabaseService.getDb().getAllSync<{ rendered_message: string }>(
      "SELECT rendered_message FROM notification_deliveries WHERE center_id = ? AND notification_event_id = ?",
      ["center-1", event.id],
    );

    expect(event.sessionId).toBe("session-homework-grade");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.rendered_message.includes("حالة الواجب: مكتمل"))).toBe(true);
  });

  it("omits the homework line from grade notifications when that session has no evaluation", () => {
    const student = createStudent();
    createSession("session-homework-empty");
    createExam("exam-homework-empty", "session-homework-empty");

    const event = NotificationService.notifyGrades({
      studentId: student.id,
      examId: "exam-homework-empty",
      examName: "اختبار بلا تقييم",
      summary: "اختبار بلا تقييم: 8/10",
    });
    const deliveries = DatabaseService.getDb().getAllSync<{ rendered_message: string }>(
      "SELECT rendered_message FROM notification_deliveries WHERE center_id = ? AND notification_event_id = ?",
      ["center-1", event.id],
    );

    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => !delivery.rendered_message.includes("حالة الواجب") && !delivery.rendered_message.includes("{{homework_evaluation}}"))).toBe(true);
  });

  it("does not use an evaluation from a different session in a grade notification", () => {
    const student = createStudent();
    createSession("session-homework-unrelated");
    createSession("session-homework-exam");
    createExam("exam-homework-session-bound", "session-homework-exam");
    const status = HomeworkEvaluationRepository.createStatus("حصة أخرى");
    HomeworkEvaluationRepository.setForSession("session-homework-unrelated", student.id, status.id);

    const event = NotificationService.notifyGrades({
      studentId: student.id,
      examId: "exam-homework-session-bound",
      sessionId: "session-homework-exam",
      examName: "امتحان الحصة الثانية",
      summary: "امتحان الحصة الثانية: 8/10",
    });
    const deliveries = DatabaseService.getDb().getAllSync<{ rendered_message: string }>(
      "SELECT rendered_message FROM notification_deliveries WHERE center_id = ? AND notification_event_id = ?",
      ["center-1", event.id],
    );

    expect(event.sessionId).toBe("session-homework-exam");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => !delivery.rendered_message.includes("حالة الواجب:"))).toBe(true);
    expect(() => NotificationService.notifyGrades({
      studentId: student.id,
      examId: "exam-homework-session-bound",
      sessionId: "session-homework-unrelated",
      examName: "جلسة لا تطابق الامتحان",
      summary: "8/10",
    })).toThrow("الحصة المرتبطة لا تطابق حصة الامتحان.");
  });

  it("applies homework evaluations and exam-session links from incremental server changes", () => {
    const student = createStudent();
    createSession("session-homework-incremental");
    const statusId = "server-homework-status";
    const examId = "server-homework-exam";

    SyncEngine.applyServerChanges("center-1", [
      {
        entityType: "homework_evaluation_status",
        entityId: statusId,
        action: "create",
        data: { id: statusId, center_id: "center-1", name: "تمت المزامنة", status: "active", created_at: "2026-10-06" },
      },
      {
        entityType: "session_homework_evaluation",
        entityId: "server-homework-evaluation",
        action: "create",
        data: {
          id: "server-homework-evaluation",
          center_id: "center-1",
          student_id: student.id,
          session_id: "session-homework-incremental",
          status_id: statusId,
          created_at: "2026-10-06",
          updated_at: "2026-10-06",
        },
      },
      {
        entityType: "grade_exam",
        entityId: examId,
        action: "create",
        data: {
          id: examId,
          name: "امتحان مرتبط",
          grade: "الصف الأول الثانوي",
          group_id: "group-homework",
          session_id: "session-homework-incremental",
          max_score: 10,
          status: "active",
        },
      },
    ]);

    expect(HomeworkEvaluationRepository.getForSession("session-homework-incremental", student.id)?.statusName).toBe("تمت المزامنة");
    expect(DatabaseService.getDb().getFirstSync<{ session_id: string }>(
      "SELECT session_id FROM grade_exams WHERE center_id = ? AND id = ?",
      ["center-1", examId],
    )?.session_id).toBe("session-homework-incremental");
  });

  it("requeues homework evaluation status and session evaluation conflicts safely", () => {
    const student = createStudent();
    createSession("session-hw-conflict");
    const status = HomeworkEvaluationRepository.createStatus("حالة متعارضة");
    const db = DatabaseService.getDb();

    const opId = "op-parked-hweval";
    db.runSync(
      `INSERT INTO sync_operations (operation_id, center_id, device_id, user_id, operation_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'conflict', 2, ?, ?)`,
      [
        opId,
        "center-1",
        "dev-1",
        "usr-1",
        "CREATE",
        "session_homework_evaluation",
        "hweval-conflict-1",
        JSON.stringify({
          id: "hweval-conflict-1",
          center_id: "center-1",
          student_id: student.id,
          session_id: "session-hw-conflict",
          status_id: status.id,
        }),
        "تضارب مع الخادم: Homework evaluation status must be active in the authenticated center. (manual_review)",
        new Date().toISOString(),
      ],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, resolution, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual_review', ?)`,
      [
        "conflict-hw-1",
        opId,
        "center-1",
        "session_homework_evaluation",
        "hweval-conflict-1",
        "Homework evaluation status must be active in the authenticated center.",
        new Date().toISOString(),
      ],
    );

    const changes = SyncRepository.requeueRecoverableConflicts("center-1");

    expect(changes).toBeGreaterThanOrEqual(1);
    const recoveredOp = db.getFirstSync<any>(
      "SELECT status, retry_count, last_error, next_retry_at FROM sync_operations WHERE operation_id = ?",
      [opId],
    );
    expect(recoveredOp?.status).toBe("pending");
    expect(recoveredOp?.last_error).toBeNull();
    expect(recoveredOp?.next_retry_at).toBeNull();

    const resolvedConflict = db.getFirstSync<any>(
      "SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?",
      [opId],
    );
    expect(resolvedConflict?.resolved_at).not.toBeNull();
  });

  describe("Homework Distribution & Evaluation Workflow Redesign (Parts 1-8)", () => {
    function setupPhysicsGroupWithSchedulesAndSessions() {
      const db = DatabaseService.getDb();

      db.runSync(
        `INSERT INTO subjects (id, center_id, name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        ["subj-physics-hw", "center-1", "الفيزياء", "2026-10-01T08:00:00.000Z"],
      );
      db.runSync(
        `INSERT INTO teachers (id, center_id, name, phone, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        ["teacher-physics-hw", "center-1", "أ. محمود فوزي", "01099998888", "2026-10-01T08:00:00.000Z"],
      );
      db.runSync(
        `INSERT INTO groups (id, center_id, name, subject_id, teacher_id, grade, default_fee, session_price, monthly_price, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 100, 100, 400, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = 'active'`,
        [
          "group-physics-hw",
          "center-1",
          "مجموعة الفيزياء",
          "subj-physics-hw",
          "teacher-physics-hw",
          "الصف الثالث الثانوي",
          "2026-10-01T08:00:00.000Z",
        ],
      );

      // Sunday (0) & Tuesday (2) from 17:00 (05:00 م) to 18:30 (06:30 م)
      db.runSync(
        `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        ["sched-phys-sun", "center-1", "group-physics-hw", 0, "17:00", "18:30", "2026-10-01T08:00:00.000Z"],
      );
      db.runSync(
        `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        ["sched-phys-tue", "center-1", "group-physics-hw", 2, "17:00", "18:30", "2026-10-01T08:00:00.000Z"],
      );

      // Insert sessions out of order to verify chronological sorting (oldest -> newest: 1, 2, 3)
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "sess-phys-3",
          "center-1",
          "group-physics-hw",
          "sched-phys-sun",
          "subj-physics-hw",
          "teacher-physics-hw",
          "2026-10-11",
          "17:00",
          "18:30",
          "open",
          "2026-10-11T17:00:00.000Z",
        ],
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "sess-phys-1",
          "center-1",
          "group-physics-hw",
          "sched-phys-sun",
          "subj-physics-hw",
          "teacher-physics-hw",
          "2026-10-04",
          "17:00",
          "18:30",
          "closed",
          "2026-10-04T17:00:00.000Z",
        ],
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "sess-phys-2",
          "center-1",
          "group-physics-hw",
          "sched-phys-tue",
          "subj-physics-hw",
          "teacher-physics-hw",
          "2026-10-06",
          "17:00",
          "18:30",
          "closed",
          "2026-10-06T17:00:00.000Z",
        ],
      );

      const s1 = StudentRepository.createStudent({
        studentCode: "99201",
        cardCode: "99201",
        fullName: "أحمد محمد علي",
        phone: "01011112221",
        parentPhone: "01111112221",
        grade: "الصف الثالث الثانوي",
      });
      const s2 = StudentRepository.createStudent({
        studentCode: "99202",
        cardCode: "99202",
        fullName: "سارة خالد حسن",
        phone: "01011112222",
        parentPhone: "01111112222",
        grade: "الصف الثالث الثانوي",
      });
      const s3Absent = StudentRepository.createStudent({
        studentCode: "99203",
        cardCode: "99203",
        fullName: "عمر طارق غائب",
        phone: "01011112223",
        parentPhone: "01111112223",
        grade: "الصف الثالث الثانوي",
      });

      // Record attendance in sess-phys-1: s1 present, s2 late, s3Absent absent
      db.runSync(
        `INSERT INTO attendance (id, operation_id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type)
         VALUES (?, ?, 'center-1', 'sess-phys-1', ?, '2026-10-04T17:02:00.000Z', 'present', 0, 'present')`,
        ["att-phys-1-s1", "op-att-phys-1-s1", s1.id],
      );
      db.runSync(
        `INSERT INTO attendance (id, operation_id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type)
         VALUES (?, ?, 'center-1', 'sess-phys-1', ?, '2026-10-04T17:20:00.000Z', 'late', 1, 'present')`,
        ["att-phys-1-s2", "op-att-phys-1-s2", s2.id],
      );
      db.runSync(
        `INSERT INTO attendance (id, operation_id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type)
         VALUES (?, ?, 'center-1', 'sess-phys-1', ?, '2026-10-04T17:00:00.000Z', 'absent', 0, 'present')`,
        ["att-phys-1-s3", "op-att-phys-1-s3", s3Absent.id],
      );

      // Record attendance in sess-phys-2: s1 present
      db.runSync(
        `INSERT INTO attendance (id, operation_id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type)
         VALUES (?, ?, 'center-1', 'sess-phys-2', ?, '2026-10-06T17:01:00.000Z', 'present', 0, 'present')`,
        ["att-phys-2-s1", "op-att-phys-2-s1", s1.id],
      );

      return { s1, s2, s3Absent };
    }

    it("1-5. preserves homework distribution settings and lists active groups with days and session times", () => {
      setupPhysicsGroupWithSchedulesAndSessions();
      const complete = HomeworkEvaluationRepository.createStatus("مكتمل");
      const incomplete = HomeworkEvaluationRepository.createStatus("غير مكتمل");
      const updated = HomeworkEvaluationRepository.updateStatus(incomplete.id, {
        name: "واجب غير مكتمل",
      });
      expect(updated.name).toBe("واجب غير مكتمل");
      expect(HomeworkEvaluationRepository.listStatuses().map((s) => s.name)).toEqual(
        expect.arrayContaining(["مكتمل", "واجب غير مكتمل"]),
      );

      const groups = HomeworkEvaluationRepository.getGroupsForEvaluation();
      const physGroup = groups.find((g) => g.id === "group-physics-hw");
      expect(physGroup).toBeDefined();
      expect(physGroup?.name).toBe("مجموعة الفيزياء");
      expect(physGroup?.subjectName).toBe("الفيزياء");
      expect(physGroup?.teacherName).toBe("أ. محمود فوزي");
      expect(physGroup?.scheduledDaysLabel).toBe("الأحد والثلاثاء");
      expect(physGroup?.timeRangeLabel).toBe("من 05:00 م إلى 06:30 م");
      expect(physGroup?.sessionsCount).toBe(3);

      // Re-verify distribution settings were not touched by evaluation group queries
      expect(HomeworkEvaluationRepository.listStatuses().find((s) => s.id === complete.id)?.name).toBe("مكتمل");
    });

    it("6-8. orders group sessions chronologically from oldest to newest (1, 2, 3...) and keeps each session independent", () => {
      const { s1 } = setupPhysicsGroupWithSchedulesAndSessions();
      const complete = HomeworkEvaluationRepository.createStatus("مكتمل");

      const sessions = HomeworkEvaluationRepository.getSessionsForGroup("group-physics-hw");
      expect(sessions).toHaveLength(3);
      expect(sessions.map((s) => s.id)).toEqual(["sess-phys-1", "sess-phys-2", "sess-phys-3"]);
      expect(sessions.map((s) => s.sessionNumber)).toEqual([1, 2, 3]);
      expect(sessions.map((s) => s.sessionOrdinalTitle)).toEqual([
        "الحصة الأولى",
        "الحصة الثانية",
        "الحصة الثالثة",
      ]);
      expect(sessions.map((s) => s.sessionDate)).toEqual([
        "2026-10-04",
        "2026-10-06",
        "2026-10-11",
      ]);

      // Evaluate s1 in sess-phys-1 only
      HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s1.id, complete.id);

      const updatedSessions = HomeworkEvaluationRepository.getSessionsForGroup("group-physics-hw");
      expect(updatedSessions[0].evaluatedCount).toBe(1);
      expect(updatedSessions[0].attendedCount).toBe(2);
      expect(updatedSessions[0].unevaluatedCount).toBe(1);
      expect(updatedSessions[0].completionPercentage).toBe(50);

      // sess-phys-2 remains untouched
      expect(updatedSessions[1].evaluatedCount).toBe(0);
      expect(updatedSessions[1].attendedCount).toBe(1);
      expect(updatedSessions[1].unevaluatedCount).toBe(1);
    });

    it("9-15. restricts evaluation to attended students, separates evaluated/unevaluated tabs, moves students immediately, and never alters attendance", () => {
      const { s1, s2, s3Absent } = setupPhysicsGroupWithSchedulesAndSessions();
      const complete = HomeworkEvaluationRepository.createStatus("مكتمل");
      const incomplete = HomeworkEvaluationRepository.createStatus("لم يحل الواجب");

      const db = DatabaseService.getDb();
      const attendanceBefore = db.getAllSync<any>(
        "SELECT id, session_id, student_id, status FROM attendance WHERE center_id = 'center-1' AND session_id = 'sess-phys-1' ORDER BY id",
      );

      // Initial roster for sess-phys-1
      const initialRoster = HomeworkEvaluationRepository.getSessionEvaluationRoster("sess-phys-1");
      expect(initialRoster.stats.totalAttended).toBe(2);
      expect(initialRoster.stats.evaluatedCount).toBe(0);
      expect(initialRoster.stats.unevaluatedCount).toBe(2);
      expect(initialRoster.stats.absentCount).toBe(1);
      expect(initialRoster.stats.completionPercentage).toBe(0);

      expect(initialRoster.unevaluatedStudents.map((s) => s.studentId).sort()).toEqual([s1.id, s2.id].sort());
      expect(initialRoster.evaluatedStudents).toHaveLength(0);
      // Absent student is strictly excluded from both evaluated and unevaluated queues
      expect(initialRoster.unevaluatedStudents.some((s) => s.studentId === s3Absent.id)).toBe(false);
      expect(initialRoster.evaluatedStudents.some((s) => s.studentId === s3Absent.id)).toBe(false);

      // Absent student cannot be evaluated
      expect(() =>
        HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s3Absent.id, complete.id),
      ).toThrow("لا يمكن تقييم الواجب لطالب غائب");
      expect(() =>
        HomeworkEvaluationRepository.setForSession("sess-phys-1", s3Absent.id, complete.id),
      ).toThrow("لا يمكن تقييم الواجب لطالب غائب");

      // Evaluate s1 as complete -> immediately moves to evaluatedStudents
      HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s1.id, complete.id);
      const rosterAfterS1 = HomeworkEvaluationRepository.getSessionEvaluationRoster("sess-phys-1");
      expect(rosterAfterS1.stats.totalAttended).toBe(2);
      expect(rosterAfterS1.stats.evaluatedCount).toBe(1);
      expect(rosterAfterS1.stats.unevaluatedCount).toBe(1);
      expect(rosterAfterS1.stats.completionPercentage).toBe(50);
      expect(rosterAfterS1.evaluatedStudents.map((s) => s.studentId)).toEqual([s1.id]);
      expect(rosterAfterS1.evaluatedStudents[0].statusName).toBe("مكتمل");
      expect(rosterAfterS1.unevaluatedStudents.map((s) => s.studentId)).toEqual([s2.id]);

      // Evaluate s2 as incomplete -> also moves to evaluatedStudents (even though homework was not solved)
      HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s2.id, incomplete.id);
      const rosterAfterS2 = HomeworkEvaluationRepository.getSessionEvaluationRoster("sess-phys-1");
      expect(rosterAfterS2.stats.totalAttended).toBe(2);
      expect(rosterAfterS2.stats.evaluatedCount).toBe(2);
      expect(rosterAfterS2.stats.unevaluatedCount).toBe(0);
      expect(rosterAfterS2.stats.completionPercentage).toBe(100);
      expect(rosterAfterS2.unevaluatedStudents).toHaveLength(0);
      expect(rosterAfterS2.evaluatedStudents).toHaveLength(2);

      // Attendance table must remain 100% untouched
      const attendanceAfter = db.getAllSync<any>(
        "SELECT id, session_id, student_id, status FROM attendance WHERE center_id = 'center-1' AND session_id = 'sess-phys-1' ORDER BY id",
      );
      expect(attendanceAfter).toEqual(attendanceBefore);
    });

    it("16-22. previews and sends single, multi, and all-evaluated homework notifications idempotently with compact sync IDs <= 64 chars", () => {
      const { s1, s2, s3Absent } = setupPhysicsGroupWithSchedulesAndSessions();
      const complete = HomeworkEvaluationRepository.createStatus("مكتمل");
      const incomplete = HomeworkEvaluationRepository.createStatus("غير مكتمل");

      // Evaluate s1 only first
      HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s1.id, complete.id);

      // Unevaluated student (s2) and absent student (s3Absent) cannot receive homework notifications
      expect(() =>
        NotificationService.previewHomeworkNotifications({
          sessionId: "sess-phys-1",
          studentIds: [s2.id],
        }),
      ).toThrow("لا يمكن إرسال حالة الواجب لطالب لم يتم تقييمه بعد");
      expect(() =>
        NotificationService.notifyHomeworkEvaluations({
          sessionId: "sess-phys-1",
          studentIds: [s2.id],
        }),
      ).toThrow("لا يمكن إرسال حالة الواجب لطالب لم يتم تقييمه بعد");

      expect(() =>
        NotificationService.notifyHomeworkEvaluations({
          sessionId: "sess-phys-1",
          studentIds: [s3Absent.id],
        }),
      ).toThrow("لا يمكن إرسال حالة الواجب لطالب غائب");

      // Single student preview & send for s1
      const singlePreview = NotificationService.previewHomeworkNotifications({
        sessionId: "sess-phys-1",
        studentIds: [s1.id],
      });
      expect(singlePreview).toHaveLength(1);
      expect(singlePreview[0].studentName).toBe("أحمد محمد علي");
      expect(singlePreview[0].groupName).toBe("مجموعة الفيزياء");
      expect(singlePreview[0].subjectName).toBe("الفيزياء");
      expect(singlePreview[0].sessionDate).toBe("2026-10-04");
      expect(singlePreview[0].homeworkStatus).toBe("مكتمل");
      expect(singlePreview[0].renderedMessage).toContain("أحمد محمد علي");
      expect(singlePreview[0].renderedMessage).toContain("مجموعة الفيزياء");
      expect(singlePreview[0].renderedMessage).toContain("مكتمل");

      const firstSend = NotificationService.notifyHomeworkEvaluations({
        sessionId: "sess-phys-1",
        studentIds: [s1.id],
      });
      expect(firstSend).toHaveLength(1);
      expect(firstSend[0].eventType).toBe("homework");
      expect(firstSend[0].operationId.length).toBeLessThanOrEqual(64);
      expect(firstSend[0].id.length).toBeLessThanOrEqual(64);

      // Repeated press for the same student and evaluation status is idempotent (no duplicate events)
      const duplicateSend = NotificationService.notifyHomeworkEvaluations({
        sessionId: "sess-phys-1",
        studentIds: [s1.id],
      });
      expect(duplicateSend).toHaveLength(1);
      expect(duplicateSend[0].id).toBe(firstSend[0].id);
      expect(duplicateSend[0].operationId).toBe(firstSend[0].operationId);

      // Now evaluate s2 as incomplete and send for all evaluated students ([s1.id, s2.id])
      HomeworkEvaluationRepository.evaluateSessionStudent("sess-phys-1", s2.id, incomplete.id);
      const multiPreview = NotificationService.previewHomeworkNotifications({
        sessionId: "sess-phys-1",
        studentIds: [s1.id, s2.id],
      });
      expect(multiPreview).toHaveLength(2);
      expect(multiPreview[0].renderedMessage).toContain("أحمد محمد علي");
      expect(multiPreview[0].renderedMessage).toContain("مكتمل");
      expect(multiPreview[0].renderedMessage).not.toContain("سارة خالد حسن");
      expect(multiPreview[1].renderedMessage).toContain("سارة خالد حسن");
      expect(multiPreview[1].renderedMessage).toContain("غير مكتمل");
      expect(multiPreview[1].renderedMessage).not.toContain("أحمد محمد علي");

      const multiEvents = NotificationService.notifyHomeworkEvaluations({
        sessionId: "sess-phys-1",
        studentIds: [s1.id, s2.id],
      });
      expect(multiEvents).toHaveLength(2);

      // Check all generated sync_operations have operation_id and entity_id <= 64 chars
      const syncOps = DatabaseService.getDb().getAllSync<any>(
        `SELECT operation_id as operationId, entity_id as entityId, entity_type as entityType
         FROM sync_operations
         WHERE center_id = 'center-1'
           AND entity_type IN ('homework_evaluation_status', 'session_homework_evaluation', 'notification_event', 'notification_delivery', 'notification_template')`,
      );
      expect(syncOps.length).toBeGreaterThan(0);
      for (const op of syncOps) {
        expect(String(op.operationId).length).toBeLessThanOrEqual(64);
        expect(String(op.entityId).length).toBeLessThanOrEqual(64);
      }
    });
  });

  // =========================================================================
  // REAL SQLITE ENGINE TESTS (node:sqlite) — URGENT FIX VERIFICATION (1..8)
  // =========================================================================
  describe("Real SQLite Engine Verification (Groups, Schedules, Sessions, Navigation, Error Propagation)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");

    function createRealSqliteAdapter() {
      const raw = new DatabaseSync(":memory:");
      const normalizeParams = (params?: any[]): any[] => {
        if (!params || params.length === 0) return [];
        if (params.length === 1 && Array.isArray(params[0])) {
          return params[0].map((v: any) => (v === undefined ? null : v));
        }
        return params.map((v: any) => (v === undefined ? null : v));
      };
      const adapter = {
        execSync(sql: string): void {
          raw.exec(sql);
        },
        runSync(sql: string, ...params: any[]) {
          const stmt = raw.prepare(sql);
          const res = stmt.run(...normalizeParams(params));
          return {
            changes: Number(res?.changes ?? 0),
            lastInsertRowId: Number(res?.lastInsertRowid ?? 0),
          };
        },
        getFirstSync<T = any>(sql: string, ...params: any[]): T | null {
          const stmt = raw.prepare(sql);
          const row = stmt.get(...normalizeParams(params));
          return (row ?? null) as T | null;
        },
        getAllSync<T = any>(sql: string, ...params: any[]): T[] {
          const stmt = raw.prepare(sql);
          const rows = stmt.all(...normalizeParams(params));
          return (rows ?? []) as T[];
        },
      };
      return { adapter, raw, close: () => raw.close() };
    }

    function setOwnerUser(permissions: string[]) {
      const currentUser = useAuthStore.getState().currentUser;
      useAuthStore.setState({
        currentUser: {
          ...(currentUser || {
            id: "owner-real-1",
            name: "مدير المركز",
            email: "admin@center1.com",
          }),
          role: "owner",
          centerId: "center-1",
          permissions: permissions as any,
        } as any,
      });
    }

    afterEach(() => {
      (DatabaseService as any).db = null;
      (DatabaseService as any).initializedDbInstance = null;
      (DatabaseService as any).initializedMigrationVersion = 0;
      DatabaseService.init();
    });

    it("1 & 3 & 4 & 5 & 6. Existing SQLite database loads active groups, excludes other centers, displays schedules, orders sessions oldest-to-newest, and preserves homework settings", () => {
      const real = createRealSqliteAdapter();
      try {
        // Simulate an existing SQLite installation (migrated up to v35 before v36)
        DatabaseService.runMigrations(real.adapter as any);
        real.adapter.runSync(
          "DELETE FROM schema_migrations WHERE version = 36",
        );
        real.adapter.execSync("PRAGMA user_version = 35;");

        // Verify actual SQLite schema uses `status` (NOT `is_active`) on groups and group_schedules
        const groupCols = real.adapter
          .getAllSync<{ name: string }>("PRAGMA table_info(groups)")
          .map((c) => c.name);
        expect(groupCols).toContain("status");
        expect(groupCols).not.toContain("is_active");

        const scheduleCols = real.adapter
          .getAllSync<{ name: string }>("PRAGMA table_info(group_schedules)")
          .map((c) => c.name);
        expect(scheduleCols).toContain("status");
        expect(scheduleCols).not.toContain("is_active");

        // Seed existing installation data in real SQLite
        real.adapter.runSync(
          "INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
          [
            "center-1",
            "مركز النور",
            "NOOR",
            "Africa/Cairo",
            "center-2",
            "مركز الأمل",
            "AMAL",
            "Africa/Cairo",
          ],
        );
        real.adapter.runSync(
          "INSERT INTO teachers (id, center_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, 'active', '2026-09-01'), (?, ?, ?, ?, 'active', '2026-09-01')",
          [
            "t-real-1",
            "center-1",
            "أ. محمود فيزياء",
            "01011112222",
            "t-real-2",
            "center-2",
            "أ. سامي كيمياء",
            "01033334444",
          ],
        );
        real.adapter.runSync(
          "INSERT INTO subjects (id, center_id, name, code, status, created_at) VALUES (?, ?, ?, ?, 'active', '2026-09-01'), (?, ?, ?, ?, 'active', '2026-09-01')",
          [
            "sub-real-1",
            "center-1",
            "الفيزياء",
            "PHYS",
            "sub-real-2",
            "center-2",
            "الكيمياء",
            "CHEM",
          ],
        );
        // Active group in center-1, inactive group in center-1, active group in center-2
        real.adapter.runSync(
          `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at)
           VALUES (?, 'center-1', 'مجموعة الفيزياء', 't-real-1', 'sub-real-1', 'الصف الثالث الثانوي', 400, 100, 400, 'active', '2026-09-01'),
                  (?, 'center-1', 'مجموعة مؤرشفة', 't-real-1', 'sub-real-1', 'الصف الثالث الثانوي', 400, 100, 400, 'inactive', '2026-09-01'),
                  (?, 'center-2', 'مجموعة مركز آخر', 't-real-2', 'sub-real-2', 'الصف الثالث الثانوي', 400, 100, 400, 'active', '2026-09-01')`,
          ["grp-real-phys", "grp-real-inactive", "grp-real-other"],
        );
        // Schedules for grp-real-phys: Sunday (0) and Tuesday (2) from 17:00 to 18:30
        real.adapter.runSync(
          `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
           VALUES ('sch-r-1', 'center-1', 'grp-real-phys', 0, '17:00', '18:30', 'active', '2026-09-01'),
                  ('sch-r-2', 'center-1', 'grp-real-phys', 2, '17:00', '18:30', 'active', '2026-09-01'),
                  ('sch-r-inactive', 'center-1', 'grp-real-phys', 4, '19:00', '20:30', 'inactive', '2026-09-01')`,
        );
        // Sessions inserted out of chronological order
        real.adapter.runSync(
          `INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
           VALUES ('ses-r-3', 'center-1', 'grp-real-phys', 'sch-r-1', 'sub-real-1', 't-real-1', '2026-10-11', '17:00', '18:30', 'open', '2026-10-11'),
                  ('ses-r-1', 'center-1', 'grp-real-phys', 'sch-r-1', 'sub-real-1', 't-real-1', '2026-10-04', '17:00', '18:30', 'closed', '2026-10-04'),
                  ('ses-r-2', 'center-1', 'grp-real-phys', 'sch-r-2', 'sub-real-1', 't-real-1', '2026-10-06', '17:00', '18:30', 'closed', '2026-10-06')`,
        );
        // Existing homework settings
        real.adapter.runSync(
          `INSERT INTO homework_evaluation_statuses (id, center_id, name, status, created_at, updated_at)
           VALUES ('hw-st-1', 'center-1', 'الواجب كامل', 'active', '2026-09-01', '2026-09-01'),
                  ('hw-st-2', 'center-1', 'الواجب غير مكتمل', 'active', '2026-09-01', '2026-09-01')`,
        );

        // Attach live v35 handle and let DatabaseService.getDb() upgrade to v36
        (DatabaseService as any).db = real.adapter;
        (DatabaseService as any).initializedDbInstance = real.adapter;
        (DatabaseService as any).initializedMigrationVersion = 35;

        setOwnerUser([
          "homework.manage",
          "grades.view",
          "grades.manage",
          "attendance.view",
          "groups.view",
        ]);

        const groups = HomeworkEvaluationRepository.getGroupsForEvaluation();
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe("grp-real-phys");
        expect(groups[0].name).toBe("مجموعة الفيزياء");
        expect(groups[0].subjectName).toBe("الفيزياء");
        expect(groups[0].teacherName).toBe("أ. محمود فيزياء");
        expect(groups[0].scheduledDaysLabel).toBe("الأحد والثلاثاء");
        expect(groups[0].timeRangeLabel).toBe("من 05:00 م إلى 06:30 م");

        // Verify sessions are ordered oldest to newest (1, 2, 3)
        const sessions =
          HomeworkEvaluationRepository.getSessionsForGroup("grp-real-phys");
        expect(sessions.map((s) => s.id)).toEqual([
          "ses-r-1",
          "ses-r-2",
          "ses-r-3",
        ]);
        expect(sessions.map((s) => s.sessionNumber)).toEqual([1, 2, 3]);
        expect(sessions.map((s) => s.sessionOrdinalTitle)).toEqual([
          "الحصة الأولى",
          "الحصة الثانية",
          "الحصة الثالثة",
        ]);

        // Verify existing homework settings remain intact
        const statuses = HomeworkEvaluationRepository.listStatuses(true);
        expect(statuses.map((s) => s.name)).toEqual([
          "الواجب غير مكتمل",
          "الواجب كامل",
        ]);
      } finally {
        real.close();
      }
    });

    it("2. Fresh SQLite database loads active groups and schedules successfully", () => {
      const real = createRealSqliteAdapter();
      try {
        (DatabaseService as any).db = real.adapter;
        DatabaseService.runMigrations(real.adapter as any);
        DatabaseService.ensureSyncMetadataSchema(real.adapter as any);
        DatabaseService.seedData();
        DatabaseService.ensureAcademicSchema(real.adapter as any);
        DatabaseService.ensurePaymentRequestsSchema(real.adapter as any);
        (DatabaseService as any).initializedDbInstance = real.adapter;
        (DatabaseService as any).initializedMigrationVersion = 36;

        setOwnerUser([
          "homework.manage",
          "grades.view",
          "attendance.view",
          "groups.view",
        ]);

        const groups = HomeworkEvaluationRepository.getGroupsForEvaluation();
        expect(groups.length).toBeGreaterThanOrEqual(2);
        expect(groups.every((g) => g.centerId === "center-1")).toBe(true);
        expect(groups[0].schedules.length).toBeGreaterThanOrEqual(1);
        expect(groups[0].timeRangeLabel).toContain("من");
      } finally {
        real.close();
      }
    });

    it("7. Duplicate navigation entries ('تقسيم الواجب' alongside 'تقييم الواجب') are consolidated into a single 'تقييم الواجب' entry while keeping configuration accessible", () => {
      const moreSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/more.tsx"),
        "utf8",
      );
      const academicSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/academic.tsx"),
        "utf8",
      );
      const homeworkScreenSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/homework-evaluations.tsx"),
        "utf8",
      );

      // more.tsx and academic.tsx must have 'تقييم الواجب' and must NOT have a duplicate 'تقسيم الواجب' navigation item
      expect(moreSource).toContain("تقييم الواجب");
      expect(moreSource).not.toContain("تقسيم الواجب");
      expect(academicSource).toContain("تقييم الواجب");
      expect(academicSource).not.toContain("تقسيم الواجب");

      // homework-evaluations.tsx must not have the duplicate modeSwitcherContainer tabs, while keeping status configuration accessible
      expect(homeworkScreenSource).not.toContain("modeSwitcherContainer");
      expect(homeworkScreenSource).toContain("إعدادات الحالات");
      expect(homeworkScreenSource).toContain("HomeworkEvaluationRepository.createStatus");
      expect(homeworkScreenSource).toContain("HomeworkEvaluationRepository.updateStatus");
      expect(homeworkScreenSource).toContain("HomeworkEvaluationRepository.removeStatus");
    });

    it("8. Database errors are logged and thrown, never silently converted into an empty group list", () => {
      const real = createRealSqliteAdapter();
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        // Initialize an empty SQLite connection without running migrations (no groups table)
        DatabaseService.setMockDb(real.adapter as any);
        setOwnerUser(["homework.manage", "groups.view"]);

        expect(() =>
          HomeworkEvaluationRepository.getGroupsForEvaluation(),
        ).toThrow(/no such table: groups/i);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        real.close();
      }
    });
  });

  describe("Homework Sessions UI Polish & Cairo Timezone Correction", () => {
    it("1. Date-only session dates do not shift by timezone and format in Arabic", () => {
      expect(normalizeSessionDateOnly("2026-09-25")).toBe("2026-09-25");
      expect(formatSessionDateArabic("2026-09-25")).toBe("الجمعة 25 سبتمبر 2026");

      // Naive timestamp without timezone offset also preserves calendar date
      expect(normalizeSessionDateOnly("2026-09-25 17:00:00")).toBe("2026-09-25");
      expect(formatSessionDateArabic("2026-09-25 17:00:00")).toBe(
        "الجمعة 25 سبتمبر 2026",
      );
    });

    it("2. UTC timestamps display correctly in Africa/Cairo", () => {
      // Midnight UTC is 02:00/03:00 AM in Cairo on the same calendar date (2026-09-25)
      expect(normalizeSessionDateOnly("2026-09-25T00:00:00.000Z")).toBe(
        "2026-09-25",
      );
      expect(formatSessionDateArabic("2026-09-25T00:00:00.000Z")).toBe(
        "الجمعة 25 سبتمبر 2026",
      );

      // 2026-09-24T22:30:00.000Z in Cairo (UTC+3 DST in Sept 2026) is 2026-09-25 01:30 AM
      expect(normalizeSessionDateOnly("2026-09-24T22:30:00.000Z")).toBe(
        "2026-09-25",
      );
      expect(formatSessionDateArabic("2026-09-24T22:30:00.000Z")).toBe(
        "الجمعة 25 سبتمبر 2026",
      );

      // 2026-01-15T22:30:00.000Z in Cairo (UTC+2 standard time in Jan) is 2026-01-16 00:30 AM
      expect(normalizeSessionDateOnly("2026-01-15T22:30:00.000Z")).toBe(
        "2026-01-16",
      );
      expect(formatSessionDateArabic("2026-01-15T22:30:00.000Z")).toBe(
        "الجمعة 16 يناير 2026",
      );

      // Cairo date-time formatter produces Arabic date & 12h time, never raw ISO
      const formattedCairo = formatCairoDateTime("2026-09-25T14:30:00.000Z");
      expect(formattedCairo).toContain("25 سبتمبر 2026");
      expect(formattedCairo).not.toContain("T14:30:00.000Z");
    });

    it("3. Session times display in the correct local time (05:00 م – 07:00 م)", () => {
      expect(formatSessionTimeRangeArabic("17:00", "19:00")).toBe(
        "05:00 م – 07:00 م",
      );
      expect(formatSessionTimeRangeArabic("17:00:00", "19:00:00")).toBe(
        "05:00 م – 07:00 م",
      );
      expect(formatSessionTimeRangeArabic("09:05", "11:30")).toBe(
        "09:05 ص – 11:30 ص",
      );
      expect(formatSessionTimeRangeArabic("17:00", null)).toBe("05:00 م");
      expect(
        formatSessionTimeRangeArabic(
          "2026-09-25T14:00:00.000Z",
          "2026-09-25T16:00:00.000Z",
        ),
      ).toBe("05:00 م – 07:00 م");
    });

    it("4. No raw ISO timestamps appear in the session cards, roster, or notification previews", () => {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-iso-ui', 'center-1', 'مجموعة الأحياء', 'الثالث الثانوي', 'active', '2026-09-01')`,
      );
      // Simulate bootstrapped row from Postgres where session_date is an ISO UTC string
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-iso-1', 'center-1', 'grp-iso-ui', 'sch-iso-1', '2026-09-25T00:00:00.000Z', '17:00', '19:00', 'open', '2026-09-25T00:00:00.000Z')`,
      );

      const sessions =
        HomeworkEvaluationRepository.getSessionsForGroup("grp-iso-ui");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionDateFormatted).toBe("الجمعة 25 سبتمبر 2026");
      expect(sessions[0].sessionTimeLabel).toBe("05:00 م – 07:00 م");
      expect(sessions[0].sessionDateFormatted).not.toMatch(/T\d{2}:\d{2}/);
      expect(sessions[0].sessionTimeLabel).not.toMatch(/T\d{2}:\d{2}/);

      const roster =
        HomeworkEvaluationRepository.getSessionEvaluationRoster("ses-iso-1");
      expect(roster.session.sessionDateFormatted).toBe("الجمعة 25 سبتمبر 2026");
      expect(roster.session.sessionTimeLabel).toBe("05:00 م – 07:00 م");

      // Verify UI source never renders raw session.sessionDate or item.sessionDate
      const homeworkScreenSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/homework-evaluations.tsx"),
        "utf8",
      );
      expect(homeworkScreenSource).not.toContain("{session.sessionDate}");
      expect(homeworkScreenSource).not.toContain(
        "{sessionRoster.session.sessionDate}",
      );
      expect(homeworkScreenSource).not.toContain("({item.sessionDate})");
      expect(homeworkScreenSource).toContain("session.sessionDateFormatted");
      expect(homeworkScreenSource).toContain("session.sessionTimeLabel");
      expect(homeworkScreenSource).toContain("formatCairoDateTime");
    });

    it("5. Session ordering remains oldest to newest across mixed date-only and UTC ISO session dates", () => {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-order-mix', 'center-1', 'مجموعة الترتيب الزمني', 'الثاني الثانوي', 'active', '2026-09-01')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-mix-3', 'center-1', 'grp-order-mix', 'sch-1', '2026-10-02T00:00:00.000Z', '17:00', '19:00', 'open', '2026-10-02')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-mix-1', 'center-1', 'grp-order-mix', 'sch-1', '2026-09-18', '17:00', '19:00', 'closed', '2026-09-18')`,
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES ('ses-mix-2', 'center-1', 'grp-order-mix', 'sch-1', '2026-09-25T00:00:00.000Z', '17:00', '19:00', 'closed', '2026-09-25')`,
      );

      const sessions =
        HomeworkEvaluationRepository.getSessionsForGroup("grp-order-mix");
      expect(sessions.map((s) => s.id)).toEqual([
        "ses-mix-1",
        "ses-mix-2",
        "ses-mix-3",
      ]);
      expect(sessions.map((s) => s.sessionNumber)).toEqual([1, 2, 3]);
      expect(sessions.map((s) => s.sessionDateFormatted)).toEqual([
        "الجمعة 18 سبتمبر 2026",
        "الجمعة 25 سبتمبر 2026",
        "الجمعة 2 أكتوبر 2026",
      ]);
    });

    it("6. Cards do not overlap on common mobile screen widths and remove duplicated session numbering", () => {
      const homeworkScreenSource = fs.readFileSync(
        path.join(__dirname, "../src/app/(main)/homework-evaluations.tsx"),
        "utf8",
      );

      // No duplicated session numbering (removed `.sessionNumber.` prefix and `sessionNumericPill`)
      expect(homeworkScreenSource).not.toContain("sessionNumericPill");
      expect(homeworkScreenSource).not.toContain("{session.sessionNumber}.");

      // Separate date and time pills with flexWrap for narrow mobile screens (320px+)
      expect(homeworkScreenSource).toContain("sessionDateTimeBar");
      expect(homeworkScreenSource).toContain("sessionDatePill");
      expect(homeworkScreenSource).toContain("sessionTimePill");
      expect(homeworkScreenSource).toContain("flexWrap: \"wrap\"");
      expect(homeworkScreenSource).toContain("flexShrink: 0");
      expect(homeworkScreenSource).toContain("sessionCountsRow");
    });

    it("7. Existing session evaluation functionality remains unchanged", () => {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO groups (id, center_id, name, grade, status, created_at)
         VALUES ('grp-eval-keep', 'center-1', 'مجموعة الكيمياء', 'الثالث الثانوي', 'active', '2026-09-01')`,
      );
      createSession("ses-eval-keep", "center-1", "grp-eval-keep");
      const student = createStudent();
      const studentId = student.id;
      db.runSync(
        `INSERT INTO attendance (id, center_id, session_id, student_id, status, source, recorded_at, updated_at)
         VALUES ('att-keep-1', 'center-1', 'ses-eval-keep', ?, 'present', 'manual', '2026-10-06T10:05:00.000Z', '2026-10-06T10:05:00.000Z')`,
        [studentId],
      );
      const status = HomeworkEvaluationRepository.createStatus("مكتمل");

      // Evaluate student
      HomeworkEvaluationRepository.evaluateSessionStudent(
        "ses-eval-keep",
        studentId,
        status.id,
      );

      const sessions =
        HomeworkEvaluationRepository.getSessionsForGroup("grp-eval-keep");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].attendedCount).toBe(1);
      expect(sessions[0].evaluatedCount).toBe(1);
      expect(sessions[0].unevaluatedCount).toBe(0);
      expect(sessions[0].completionPercentage).toBe(100);

      const roster =
        HomeworkEvaluationRepository.getSessionEvaluationRoster("ses-eval-keep");
      expect(roster.evaluatedStudents).toHaveLength(1);
      expect(roster.unevaluatedStudents).toHaveLength(0);
      expect(roster.evaluatedStudents[0].statusName).toBe("مكتمل");

      // Notification preview uses clean normalized date without raw ISO
      const previews = NotificationService.previewHomeworkNotifications({
        sessionId: "ses-eval-keep",
        studentIds: [studentId],
        channel: "sms",
        recipientType: "parent",
      });
      expect(previews).toHaveLength(1);
      expect(previews[0].sessionDate).toBe("2026-10-06");
    });
  });
});
