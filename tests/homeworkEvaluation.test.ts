import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { HomeworkEvaluationRepository } from "../src/features/homework/HomeworkEvaluationRepository";
import { NotificationService } from "../src/features/notifications/NotificationService";
import { StudentRepository } from "../src/features/students/StudentRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";

describe("homework evaluation data", () => {
  beforeEach(async () => {
    DatabaseService.init();
    useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
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
});
