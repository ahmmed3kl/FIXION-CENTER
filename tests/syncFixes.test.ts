import { DatabaseService } from "../src/core/database";
import "../src/core/database/registerAtomicRepositories";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { ConnectivityService } from "../src/core/connectivity";
import { MockSyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import { SyncOperationPayload } from "../src/core/api/contracts";
import { CenterAcademicStageRepository } from "../src/features/academic/CenterAcademicStageRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { TeacherRepository } from "../src/features/teachers/TeacherRepository";
import { SubjectRepository } from "../src/features/subjects/SubjectRepository";
import { TeacherSubjectRepository } from "../src/features/teachers/TeacherSubjectRepository";
import { useAuthStore } from "../src/features/auth/useAuthStore";

describe("Sync Fixes Verification: Academic stages, Group delete, and Auto-sync", () => {
  const centerId = "center-1";
  const previousAdapter = SyncEngine.getAdapter();
  class RecordingSyncAdapter extends MockSyncApiAdapter {
    lastPushedOperations: SyncOperationPayload[] = [];

    async pushOperations(centerId: string, operations: SyncOperationPayload[]) {
      this.lastPushedOperations = operations;
      return super.pushOperations(centerId, operations);
    }
  }
  const adapter = new RecordingSyncAdapter();

  beforeAll(async () => {
    DatabaseService.init();
    ConnectivityService.setState("offline");
    SyncEngine.setAdapter(adapter);
    await useAuthStore.getState().login("01000000001", "123456"); // admin login
    await useAuthStore.getState().selectCenter(centerId);
  });

  afterAll(() => {
    ConnectivityService.setState("offline");
    SyncEngine.setAdapter(previousAdapter);
  });

  describe("Task 1: Academic Stages Sync", () => {
    it("enqueues a center_academic_stage UPDATE operation upon saving stages", () => {
      const initialStages = CenterAcademicStageRepository.getStages();
      const testStageId = `test-stage-${Date.now()}`;
      const updatedStages = [
        ...initialStages,
        { id: testStageId, label: "مرحلة تجريبية", grades: ["صف أول تجريبي"] },
      ];

      CenterAcademicStageRepository.saveStages(updatedStages);

      const ops = SyncRepository.getPendingOperations(centerId)
        .filter((op) => op.entityType === "center_academic_stage");

      expect(ops.length).toBeGreaterThan(0);
      const latestOp = ops[ops.length - 1];
      expect(latestOp.operationType).toBe("UPDATE");
      expect(latestOp.entityId).toBe(centerId);
      const payload = JSON.parse(latestOp.payload);
      expect(payload.stages).toBeDefined();
      expect(payload.stages.some((s: any) => s.label === "مرحلة تجريبية")).toBe(true);
    });

    it("applies center_academic_stage incoming changes from server via applyServerChanges", () => {
      const remoteLabel = `مرحلة من السيرفر ${Date.now()}`;
      const serverChange = {
        operationId: `srv-op-stage-${Date.now()}`,
        entityType: "center_academic_stage",
        entityId: centerId,
        action: "update",
        data: {
          stages: [
            { id: `remote-stage-${Date.now()}`, label: remoteLabel, grades: ["الصف العاشر"] },
          ],
        },
      };

      SyncEngine.applyServerChanges(centerId, [serverChange]);

      const loaded = CenterAcademicStageRepository.getStages();
      expect(loaded.some((s) => s.label === remoteLabel)).toBe(true);
    });

    it("pushes queued stage updates through the sync adapter when online", async () => {
      const stageId = `outbound-stage-${Date.now()}`;
      CenterAcademicStageRepository.saveStages([
        ...CenterAcademicStageRepository.getStages(),
        { id: stageId, label: "مرحلة للإرسال", grades: ["صف تجريبي"] },
      ]);

      ConnectivityService.setState("online");
      SyncEngine.clearRateLimitForTesting();
      await SyncEngine.syncCenterNow(centerId);

      const pushed = adapter.lastPushedOperations.find(
        (operation) =>
          operation.entityType === "center_academic_stage" &&
          operation.entityId === centerId &&
          operation.payload.stages?.some((stage: { id: string }) => stage.id === stageId),
      );
      expect(pushed).toBeDefined();
      expect(pushed?.operationType).toBe("UPDATE");
      expect(pushed?.payload.stages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: stageId })]),
      );
      ConnectivityService.setState("offline");
    });
  });

  describe("Task 2: Group Delete and Update Sync", () => {
    let createdGroupId: string;

    beforeAll(() => {
      const teacher = TeacherRepository.createTeacher({ name: "مدرس المجموعات", phone: "01111111111" });
      const subject = SubjectRepository.createSubject({ name: "مادة المجموعات", code: `SUBJ-${Date.now()}` });
      TeacherSubjectRepository.assignTeacherToSubject(teacher.id, subject.id);
      const group = GroupRepository.createGroup({
        name: "مجموعة للحذف",
        teacherId: teacher.id,
        subjectId: subject.id,
        grade: "الصف الأول الثانوي",
        sessionPrice: 50,
        monthlyPrice: 200,
      });
      createdGroupId = group.id;
    });

    it("enqueues group updates with the group id and complete updated payload", () => {
      const updated = GroupRepository.updateGroup(createdGroupId, {
        name: "مجموعة بعد التعديل",
      });
      const updateOp = SyncRepository.getPendingOperations(centerId).find(
        (op) =>
          op.entityType === "group" &&
          op.entityId === createdGroupId &&
          op.operationType === "UPDATE",
      );

      expect(updated.name).toBe("مجموعة بعد التعديل");
      expect(updateOp).toBeDefined();
      expect(updateOp?.entityId).toBe(createdGroupId);
      const payload = JSON.parse(updateOp?.payload || "{}");
      expect(payload.id).toBe(createdGroupId);
      expect(payload.name).toBe("مجموعة بعد التعديل");
      expect(payload.teacher_id).toBeDefined();
      expect(payload.subject_id).toBeDefined();
    });

    it("enqueues a DELETE operation in sync queue when group is deleted", () => {
      GroupRepository.deleteGroup(createdGroupId);
      GroupRepository.deleteGroup(createdGroupId);

      const ops = SyncRepository.getPendingOperations(centerId)
        .filter((op) => op.entityType === "group" && op.entityId === createdGroupId);

      const deleteOp = ops.find((op) => op.operationType === "DELETE");
      expect(ops.filter((op) => op.operationType === "DELETE")).toHaveLength(1);
      expect(deleteOp).toBeDefined();
      expect(deleteOp?.entityId).toBe(createdGroupId);
      expect(GroupRepository.findById(createdGroupId)?.status).toBe("deleted");
    });

    it("rolls back enrollment and outbox changes if group removal fails", () => {
      const db = DatabaseService.getDb();
      const sourceGroup = GroupRepository.findById(createdGroupId);
      if (!sourceGroup) throw new Error("Group test fixture is missing");
      const group = GroupRepository.createGroup({
        name: `مجموعة تراجع ${Date.now()}`,
        teacherId: sourceGroup.teacherId,
        subjectId: sourceGroup.subjectId,
        grade: sourceGroup.grade,
        sessionPrice: sourceGroup.sessionPrice,
        monthlyPrice: sourceGroup.monthlyPrice,
      });
      const studentId = `rollback-student-${Date.now()}`;
      const enrollmentId = `rollback-enr-${Date.now()}`;
      const now = new Date().toISOString();
      db.runSync(
        `INSERT INTO students (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [studentId, centerId, "طالب اختبار التراجع", `CARD-RB-${Date.now()}`, "01000000000", "01000000001", "الصف الأول الثانوي", now],
      );
      db.runSync(
        `INSERT INTO student_group_enrollments
          (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [enrollmentId, centerId, studentId, group.id, now.slice(0, 10), now],
      );
      const originalRunSync = db.runSync.bind(db);
      db.runSync = ((sql: string, ...params: any[]) => {
        if (sql.includes("UPDATE groups SET status = 'deleted'")) {
          throw new Error("simulated group removal failure");
        }
        return originalRunSync(sql, ...params);
      }) as typeof db.runSync;

      try {
        expect(() => GroupRepository.deleteGroup(group.id)).toThrow("simulated group removal failure");
      } finally {
        db.runSync = originalRunSync;
      }

      expect(GroupRepository.findById(group.id)?.status).toBe("active");
      expect(
        db.getAllSync<any>(
          "SELECT id, status FROM student_group_enrollments WHERE center_id = ? AND student_id = ?",
          [centerId, studentId],
        ).find((row) => row.id === enrollmentId)?.status,
      ).toBe("active");
      expect(
        SyncRepository.getPendingOperations(centerId).some(
          (operation) => operation.entityType === "group" && operation.entityId === group.id && operation.operationType === "DELETE",
        ),
      ).toBe(false);
    });

    it("ends only the deleted group's active obligations and preserves student/payment history", () => {
      const teacher = TeacherRepository.createTeacher({ name: "مدرس تنظيف المجموعة", phone: "01011111111" });
      const subject = SubjectRepository.createSubject({ name: "مادة تنظيف المجموعة", code: `SUBJ-CLEAN-${Date.now()}` });
      TeacherSubjectRepository.assignTeacherToSubject(teacher.id, subject.id);
      const group = GroupRepository.createGroup({
        name: "مجموعة بحسابات مرتبطة",
        teacherId: teacher.id,
        subjectId: subject.id,
        grade: "الصف الأول الثانوي",
        sessionPrice: 50,
        monthlyPrice: 200,
      });
      const otherGroup = GroupRepository.createGroup({
        name: "مجموعة أخرى للطالب",
        teacherId: teacher.id,
        subjectId: subject.id,
        grade: "الصف الأول الثانوي",
        sessionPrice: 60,
        monthlyPrice: 240,
      });
      const db = DatabaseService.getDb();
      const userId = useAuthStore.getState().currentUser?.id;
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const studentId = `del-student-${Date.now()}`;
      const enrollmentId = `del-enr-${Date.now()}`;
      const otherEnrollmentId = `other-enr-${Date.now()}`;
      const primaryCycleId = `del-cycle-${Date.now()}`;
      const otherCycleId = `other-cycle-${Date.now()}`;
      const packageCycleId = `pkg-cycle-${Date.now()}`;

      db.runSync(
        `INSERT INTO students (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [studentId, centerId, "طالب اختبار حذف المجموعة", `CARD-${Date.now()}`, "01000000000", "01000000001", "الصف الأول الثانوي", now],
      );
      db.runSync(
        `INSERT INTO student_group_enrollments
          (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [enrollmentId, centerId, studentId, group.id, today, now],
      );
      db.runSync(
        `INSERT INTO student_group_enrollments
          (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [otherEnrollmentId, centerId, studentId, otherGroup.id, today, now],
      );
      const insertCycle = (id: string, ownerEnrollmentId: string | null, groupId: string | null, type = "monthly", packageSubscriptionId: string | null = null) => {
        db.runSync(
          `INSERT INTO debt_cycles
            (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, created_at, package_subscription_id, cycle_type, billing_mode)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, 200, 'open', ?, ?, ?, 'monthly')`,
          [id, centerId, studentId, ownerEnrollmentId, groupId, today, today, now, packageSubscriptionId, type],
        );
      };
      insertCycle(primaryCycleId, enrollmentId, group.id);
      insertCycle(otherCycleId, otherEnrollmentId, otherGroup.id);
      insertCycle(packageCycleId, null, group.id, "package", "pkg-sub-test");
      db.runSync(
        `INSERT INTO payments (id, operation_id, center_id, student_id, subscription_id, amount, payment_type, created_at, user_id, debt_cycle_id, payment_date, is_reversed)
         VALUES (?, ?, ?, ?, NULL, 75, 'monthly', ?, ?, ?, ?, 0)`,
        [`payment-${Date.now()}`, `payment-op-${Date.now()}`, centerId, studentId, now, userId, primaryCycleId, today],
      );
      db.runSync(
        `INSERT INTO student_subscriptions
          (id, center_id, student_id, group_id, package_name, amount_due, period_start, period_end, status)
         VALUES (?, ?, ?, ?, ?, 200, ?, ?, 'active')`,
        [`sub-${Date.now()}`, centerId, studentId, group.id, "اشتراك المجموعة", today, today],
      );
      db.runSync(
        `INSERT INTO student_subscriptions
          (id, center_id, student_id, group_id, package_name, amount_due, period_start, period_end, status)
         VALUES (?, ?, ?, ?, ?, 240, ?, ?, 'active')`,
        [`other-sub-${Date.now()}`, centerId, studentId, otherGroup.id, "اشتراك المجموعة الأخرى", today, today],
      );
      const scheduleId = `sched-${Date.now()}`;
      db.runSync(
        `INSERT INTO group_schedules (id, group_id, day_of_week, start_time, end_time, center_id, status, created_at, updated_at)
         VALUES (?, ?, 1, '10:00', '11:00', ?, 'active', ?, ?)`,
        [scheduleId, group.id, centerId, now, now],
      );
      const scheduledSessionId = `future-session-${Date.now()}`;
      const historicalSessionId = `old-session-${Date.now()}`;
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at, updated_at)
         VALUES (?, ?, ?, '2099-01-01', '10:00', '11:00', 'scheduled', ?, ?)`,
        [scheduledSessionId, centerId, group.id, now, now],
      );
      db.runSync(
        `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at, updated_at)
         VALUES (?, ?, ?, '2020-01-01', '10:00', '11:00', 'closed', ?, ?)`,
        [historicalSessionId, centerId, group.id, now, now],
      );
      db.runSync(
        `INSERT INTO attendance (id, center_id, student_id, session_id, check_in_time, status, operation_id)
         VALUES (?, ?, ?, ?, ?, 'present', ?)`,
        [`attendance-${Date.now()}`, centerId, studentId, historicalSessionId, now, `attendance-op-${Date.now()}`],
      );

      const scopedCycles = db.getAllSync<any>(
        `SELECT dc.id, dc.student_id as studentId, dc.enrollment_id as enrollmentId,
                dc.group_id as groupId, dc.cycle_type as cycleType,
                dc.package_subscription_id as packageSubscriptionId
           FROM debt_cycles dc
          WHERE dc.center_id = ?
            AND dc.status IN ('open', 'partial', 'pending')
            AND dc.cycle_type <> 'package'
            AND dc.package_subscription_id IS NULL
            AND (
              dc.group_id = ?
              OR dc.enrollment_id IN (
                SELECT e.id FROM student_group_enrollments e
                 WHERE e.center_id = ? AND e.group_id = ?
              )
            )`,
        [centerId, group.id, centerId, group.id],
      );
      expect(scopedCycles.map((cycle) => cycle.id)).toContain(primaryCycleId);

      GroupRepository.deleteGroup(group.id);
      SyncEngine.applyServerChanges(centerId, [
        {
          operationId: `stale-group-update-${Date.now()}`,
          entityType: "group",
          entityId: group.id,
          action: "UPDATE",
          data: { id: group.id, name: "اسم قديم", status: "active" },
        },
      ]);

      expect(GroupRepository.findById(group.id)?.status).toBe("deleted");
      expect(GroupRepository.getAll(true).some((item) => item.id === group.id)).toBe(false);
      expect(db.getFirstSync<any>(
        "SELECT id FROM students WHERE center_id = ? AND id = ?",
        [centerId, studentId],
      )?.id).toBe(studentId);
      const enrollments = db.getAllSync<any>(
        "SELECT id, status FROM student_group_enrollments WHERE center_id = ? AND student_id = ?",
        [centerId, studentId],
      );
      expect(enrollments.find((row) => row.id === enrollmentId)?.status).toBe("ended");
      expect(enrollments.find((row) => row.id === otherEnrollmentId)?.status).toBe("active");
      const cycles = db.getAllSync<any>("SELECT id, status, cycle_price FROM debt_cycles");
      expect(cycles.find((row) => row.id === primaryCycleId)).toMatchObject({ status: "cancelled", cycle_price: 75 });
      expect(cycles.find((row) => row.id === otherCycleId)?.status).toBe("open");
      expect(cycles.find((row) => row.id === packageCycleId)?.status).toBe("open");
      const payments = db.getAllSync<any>("SELECT * FROM payments");
      expect(payments.find((row) => row.debtCycleId === primaryCycleId)?.amount).toBe(75);
      const subscriptions = db.getAllSync<any>("SELECT * FROM student_subscriptions");
      expect(subscriptions.find((row) => row.groupId === group.id)?.status).toBe("cancelled");
      expect(subscriptions.find((row) => row.groupId === otherGroup.id)?.status).toBe("active");
      expect(db.getAllSync<any>("SELECT * FROM group_schedules").find((row) => row.id === scheduleId)?.status).toBe("inactive");
      const sessions = db.getAllSync<any>("SELECT * FROM sessions");
      expect(sessions.find((row) => row.id === scheduledSessionId)?.status).toBe("cancelled");
      expect(sessions.find((row) => row.id === historicalSessionId)?.status).toBe("closed");
      expect(db.getAllSync<any>("SELECT * FROM attendance")).toHaveLength(1);
    });

    it("applies group deletion via applyServerChanges when action is DELETE", () => {
      const teacher = TeacherRepository.createTeacher({ name: "مدرس الحذف عن بعد", phone: "01222222222" });
      const subject = SubjectRepository.createSubject({ name: "مادة الحذف عن بعد", code: `SUBJ-DEL-${Date.now()}` });
      TeacherSubjectRepository.assignTeacherToSubject(teacher.id, subject.id);
      const group = GroupRepository.createGroup({
        name: "مجموعة ستحذف من السيرفر",
        teacherId: teacher.id,
        subjectId: subject.id,
        grade: "الصف الثاني الثانوي",
        sessionPrice: 60,
        monthlyPrice: 240,
      });

      expect(GroupRepository.findById(group.id)).not.toBeNull();
      const db = DatabaseService.getDb();
      const now = new Date().toISOString();
      const studentId = `remote-del-student-${Date.now()}`;
      const enrollmentId = `remote-del-enr-${Date.now()}`;
      const cycleId = `remote-del-cycle-${Date.now()}`;
      db.runSync(
        `INSERT INTO students (id, center_id, full_name, card_code, phone, parent_phone, grade, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [studentId, centerId, "طالب حذف متزامن", `CARD-SYNC-${Date.now()}`, "01000000000", "01000000001", "الصف الثاني الثانوي", now],
      );
      db.runSync(
        `INSERT INTO student_group_enrollments
          (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [enrollmentId, centerId, studentId, group.id, now.slice(0, 10), now],
      );
      db.runSync(
        `INSERT INTO debt_cycles
          (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, created_at, cycle_type, billing_mode)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 120, 'open', ?, 'monthly', 'monthly')`,
        [cycleId, centerId, studentId, enrollmentId, group.id, now.slice(0, 10), now.slice(0, 10), now],
      );

      SyncEngine.applyServerChanges(centerId, [
        {
          operationId: `srv-del-${Date.now()}`,
          entityType: "group",
          entityId: group.id,
          action: "DELETE",
          data: { group: { id: group.id } },
        },
      ]);

      expect(GroupRepository.findById(group.id)?.status).toBe("deleted");
      expect(db.getAllSync<any>(
        "SELECT id, status FROM student_group_enrollments WHERE center_id = ? AND student_id = ?",
        [centerId, studentId],
      ).find((row) => row.id === enrollmentId)?.status).toBe("ended");
      expect(db.getAllSync<any>("SELECT id, status FROM debt_cycles").find((row) => row.id === cycleId)?.status).toBe("cancelled");
    });
  });

  describe("Task 3: Auto-sync Rate-limiting and Locking Guards", () => {
    it("exposes getLastSyncAttempt and records timestamps upon sync execution", async () => {
      ConnectivityService.setState("online");
      SyncEngine.clearRateLimitForTesting();
      const initialAttempt = SyncEngine.getLastSyncAttempt(centerId);

      const result = await SyncEngine.syncCenterNow(centerId);
      expect(result).toBeDefined();

      const lastAttempt = SyncEngine.getLastSyncAttempt(centerId);
      expect(lastAttempt).toBeGreaterThanOrEqual(initialAttempt);

      // Calling again immediately triggers the rate limit guard without throwing
      const secondResult = await SyncEngine.syncCenterNow(centerId);
      expect(secondResult.arabicMessage).toContain("المزامنة قيد التنفيذ بالفعل");
    });
  });
});
