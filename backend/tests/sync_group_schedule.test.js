const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");
const db = require("../src/db");

const centerId = "schedule-center";
const scheduleId = "schedule-stable-id";
const groupId = "schedule-group";

test("group schedule freshness check does not query a nonexistent updated_at column", async () => {
  let queryCount = 0;
  const client = {
    async query(sql) {
      queryCount += 1;
      assert.doesNotMatch(sql, /updated_at/i);
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await SyncProcessor.assertFreshMutation(
    client,
    centerId,
    "group_schedule",
    scheduleId,
    { updatedAt: "2026-10-10T10:00:00.000Z" },
    "UPDATE",
  );

  assert.equal(queryCount, 0);
});

test("group schedule update preserves schedule id and center scope", async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("SELECT group_id, day_of_week")) {
        return { rows: [{ group_id: groupId, day_of_week: 2, start_time: "09:00", end_time: "10:00" }] };
      }
      if (sql.includes("SELECT teacher_id FROM groups")) {
        return { rows: [{ teacher_id: "schedule-teacher" }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT gs.id AS schedule_id")) return { rows: [] };
      if (sql.includes("INSERT INTO group_schedules")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await SyncProcessor.assertFreshMutation(
    client,
    centerId,
    "group_schedule",
    scheduleId,
    { updatedAt: "2026-10-10T10:00:00.000Z" },
    "UPDATE",
  );
  await SyncProcessor.applyDomainMutation(client, {
    centerId,
    operationId: "schedule-update-operation",
    operationType: "UPDATE",
    entityType: "group_schedule",
    entityId: scheduleId,
    payload: { groupId, dayOfWeek: 2, startTime: "10:00", endTime: "11:00" },
  });

  const scheduleWrite = statements.find(({ sql }) => sql.includes("INSERT INTO group_schedules"));
  assert.ok(scheduleWrite);
  assert.equal(scheduleWrite.params[0], scheduleId);
  assert.equal(scheduleWrite.params[1], centerId);
  assert.match(scheduleWrite.sql, /ON CONFLICT \(id\) DO UPDATE/i);
  assert.match(scheduleWrite.sql, /WHERE group_schedules\.center_id = EXCLUDED\.center_id/i);
});

test("group schedule identity cannot be changed by a mismatched payload id", async () => {
  let queryCount = 0;
  const client = {
    async query() {
      queryCount += 1;
      return { rows: [] };
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: { id: "different-schedule-id", groupId, dayOfWeek: 2, startTime: "10:00", endTime: "11:00" },
    }),
    /GROUP_SCHEDULE_ID_MISMATCH/,
  );
  assert.equal(queryCount, 0);
});

test("overlapping schedule for the same teacher remains a manual-review conflict", async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("SELECT group_id, day_of_week")) return { rows: [] };
      if (sql.includes("SELECT teacher_id FROM groups")) return { rows: [{ teacher_id: "schedule-teacher" }] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT gs.id AS schedule_id")) {
        return {
          rows: [{
            schedule_id: "existing-schedule",
            group_id: "existing-group",
            day_of_week: 2,
            group_name: "المجموعة القائمة",
            start_time: "09:30",
            end_time: "10:30",
          }],
        };
      }
      if (sql.includes("INSERT INTO group_schedules")) throw new Error("conflicting schedule must not be written");
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      operationType: "CREATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: { groupId, dayOfWeek: 2, startTime: "10:00", endTime: "11:00" },
    }),
    /TEACHER_SCHEDULE_CONFLICT:المجموعة القائمة:09:30-10:30:schedule=existing-schedule:group=existing-group:day=2/,
  );

  const conflictCheck = statements.find(({ sql }) => sql.includes("SELECT gs.id AS schedule_id"));
  assert.ok(conflictCheck);
  assert.match(conflictCheck.sql, /gs\.center_id = \$1 AND gs\.id <> \$2 AND gs\.day_of_week = \$3/i);
  assert.match(conflictCheck.sql, /g\.teacher_id = \$4/i);
  assert.match(conflictCheck.sql, /NOT \(\$5::varchar <= gs\.start_time OR \$6::varchar >= gs\.end_time\)/i);
  assert.deepEqual(conflictCheck.params, [
    centerId,
    scheduleId,
    2,
    "schedule-teacher",
    "11:00",
    "10:00",
  ]);
});

test("schedule id collision owned by another center is rejected by the upsert", async () => {
  const client = {
    async query(sql) {
      if (sql.includes("SELECT group_id, day_of_week")) return { rows: [] };
      if (sql.includes("SELECT teacher_id FROM groups")) return { rows: [{ teacher_id: "schedule-teacher" }] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT gs.id AS schedule_id")) return { rows: [] };
      if (sql.includes("INSERT INTO group_schedules")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      operationType: "UPDATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: { groupId, dayOfWeek: 2, startTime: "10:00", endTime: "11:00" },
    }),
    (error) => error.code === "GROUP_SCHEDULE_BELONGS_TO_OTHER_CENTER",
  );
});

test("replaying an already-applied schedule operation acknowledges its ledger entry without reapplying it", async () => {
  const originalWithTransaction = db.withTransaction;
  let mutationStarted = false;
  db.withTransaction = (callback) => callback({
    async query(sql) {
      if (sql.includes("INSERT INTO center_data_state")) return { rowCount: 1, rows: [] };
      if (sql.includes("SELECT center_id") && sql.includes("FOR UPDATE")) {
        return { rows: [{ center_id: centerId }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT COALESCE(MAX(server_seq)")) {
        return { rows: [{ max_seq: "21" }] };
      }
      if (sql.includes("SELECT server_seq, status, center_id")) {
        return { rows: [{ server_seq: "21", status: "applied", center_id: centerId }] };
      }
      if (sql.includes("INSERT INTO sync_checkpoints")) return { rowCount: 1, rows: [] };
      if (sql.includes("SAVEPOINT op_savepoint")) mutationStarted = true;
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  try {
    const result = await SyncProcessor.processPush(centerId, "schedule-user", "schedule-device", [{
      operationId: "schedule-create-already-applied",
      centerId,
      operationType: "CREATE",
      entityType: "group_schedule",
      entityId: scheduleId,
      payload: { groupId, dayOfWeek: 2, startTime: "10:00", endTime: "11:00" },
    }]);

    assert.deepEqual(result.syncedOperationIds, ["schedule-create-already-applied"]);
    assert.deepEqual(result.conflicts, []);
    assert.equal(mutationStarted, false);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});
