import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";

describe("cleanupSupersededConflicts - Early Resolution Prevention Tests", () => {
  const centerId = "center-test-clean";

  beforeEach(() => {
    DatabaseService.init();
    const db = DatabaseService.getDb();
    // Clean tables for the test center
    db.runSync("DELETE FROM sync_operations WHERE center_id = ?", [centerId]);
    db.runSync("DELETE FROM sync_conflicts WHERE center_id = ?", [centerId]);
    db.runSync("DELETE FROM groups WHERE center_id = ?", [centerId]);
    db.runSync("DELETE FROM group_schedules WHERE center_id = ?", [centerId]);
  });

  function setupConflictedSchedule(opId: string, schedId: string, groupId: string) {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
       VALUES (?, ?, ?, 'user-1', 'dev-1', 'REPAIR_AFTER_SERVER_RESET', 'group_schedule', ?, ?, 'conflict', ?)`,
      [`id-${opId}`, opId, centerId, schedId, JSON.stringify({ groupId, dayOfWeek: 1, startTime: "10:00", endTime: "12:00" }), now],
    );
    db.runSync(
      `INSERT INTO sync_conflicts (id, operation_id, center_id, entity_type, entity_id, reason, local_payload, server_payload, created_at, resolved_at)
       VALUES (?, ?, ?, 'group_schedule', ?, 'TEACHER_SCHEDULE_CONFLICT', '{}', NULL, ?, NULL)`,
      [`conf-${opId}`, opId, centerId, schedId, now],
    );
  }

  function getConflict(opId: string) {
    const db = DatabaseService.getDb();
    return db.getFirstSync<{ resolved_at?: string | null }>(
      "SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?",
      [opId],
    );
  }

  test("1. حذف محلي مع pending: لا يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-pending";
    const schedId = "sched-pending";
    const opId = "op-sched-pending";

    // Group deleted locally
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group P', 't1', 's1', 'grade1', 'deleted')",
      [groupId, centerId],
    );
    // Delete operation in flight (pending)
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
       VALUES ('id-del-p', 'op-del-p', ?, 'user-1', 'dev-1', 'DELETE', 'group', ?, '{}', 'pending', ?)`,
      [centerId, groupId, new Date().toISOString()],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    // Run getStats which triggers cleanupSupersededConflicts
    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeNull();
  });

  test("2. حذف محلي مع failed: لا يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-failed";
    const schedId = "sched-failed";
    const opId = "op-sched-failed";

    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group F', 't1', 's1', 'grade1', 'deleted')",
      [groupId, centerId],
    );
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
       VALUES ('id-del-f', 'op-del-f', ?, 'user-1', 'dev-1', 'DELETE', 'group', ?, '{}', 'failed', ?)`,
      [centerId, groupId, new Date().toISOString()],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeNull();
  });

  test("3. حذف محلي مع syncing: لا يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-syncing";
    const schedId = "sched-syncing";
    const opId = "op-sched-syncing";

    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group S', 't1', 's1', 'grade1', 'deleted')",
      [groupId, centerId],
    );
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
       VALUES ('id-del-s', 'op-del-s', ?, 'user-1', 'dev-1', 'DELETE', 'group', ?, '{}', 'syncing', ?)`,
      [centerId, groupId, new Date().toISOString()],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeNull();
  });

  test("4. حذف محلي مع synced: يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-synced";
    const schedId = "sched-synced";
    const opId = "op-sched-synced";

    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group Synced', 't1', 's1', 'grade1', 'deleted')",
      [groupId, centerId],
    );
    db.runSync(
      `INSERT INTO sync_operations (id, operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at)
       VALUES ('id-del-ok', 'op-del-ok', ?, 'user-1', 'dev-1', 'DELETE', 'group', ?, '{}', 'synced', ?)`,
      [centerId, groupId, new Date().toISOString()],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeTruthy();
  });

  test("5. تأكيد موثوق من السيرفر بأن المجموعة مؤرشفة: يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-archived";
    const schedId = "sched-archived";
    const opId = "op-sched-archived";

    // Status is 'archived' from server
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group Arch', 't1', 's1', 'grade1', 'archived')",
      [groupId, centerId],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeTruthy();
  });

  test("6. مجموعة نشطة: لا يُحسم التعارض", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-active";
    const schedId = "sched-active";
    const opId = "op-sched-active";

    // Active group
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group Active', 't1', 's1', 'grade1', 'active')",
      [groupId, centerId],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeNull();
  });

  test("7. غياب سجل المجموعة دون دليل حذف: لا يُحسم التعارض", () => {
    const groupId = "grp-missing";
    const schedId = "sched-missing";
    const opId = "op-sched-missing";

    // No group record in groups table, and no delete operation
    setupConflictedSchedule(opId, schedId, groupId);

    SyncRepository.getStats(centerId);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeNull();
  });

  test("8. تكرار التنظيف لا ينشئ سجلات أو عمليات Repair مكررة", () => {
    const db = DatabaseService.getDb();
    const groupId = "grp-repeat";
    const schedId = "sched-repeat";
    const opId = "op-sched-repeat";

    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status) VALUES (?, ?, 'Group Repeat', 't1', 's1', 'grade1', 'archived')",
      [groupId, centerId],
    );
    setupConflictedSchedule(opId, schedId, groupId);

    // Call getStats 3 times
    SyncRepository.getStats(centerId);
    SyncRepository.getStats(centerId);
    SyncRepository.getStats(centerId);

    const opCount = db.getAllSync<any>(
      "SELECT id FROM sync_operations WHERE center_id = ? AND entity_type = 'group_schedule'",
      [centerId],
    );
    expect(opCount.length).toBe(1);

    const conflictCount = db.getAllSync<any>(
      "SELECT id FROM sync_conflicts WHERE center_id = ? AND entity_type = 'group_schedule'",
      [centerId],
    );
    expect(conflictCount.length).toBe(1);

    const conf = getConflict(opId);
    expect(conf?.resolved_at).toBeTruthy();
  });
});

