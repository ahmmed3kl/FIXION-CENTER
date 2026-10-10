import { DatabaseService } from "../src/core/database";
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

      const ops = SyncRepository.getPendingOperations(centerId)
        .filter((op) => op.entityType === "group" && op.entityId === createdGroupId);

      const deleteOp = ops.find((op) => op.operationType === "DELETE");
      expect(deleteOp).toBeDefined();
      expect(deleteOp?.entityId).toBe(createdGroupId);
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

      SyncEngine.applyServerChanges(centerId, [
        {
          operationId: `srv-del-${Date.now()}`,
          entityType: "group",
          entityId: group.id,
          action: "DELETE",
          data: { group: { id: group.id } },
        },
      ]);

      expect(GroupRepository.findById(group.id)).toBeNull();
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
