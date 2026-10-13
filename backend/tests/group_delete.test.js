const assert = require("node:assert/strict");
const SyncProcessor = require("../src/services/SyncProcessor");

function makeClient({ deleted = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id FROM debt_cycles/.test(sql)) {
        return { rows: [{ id: "cycle-1" }] };
      }
      if (/SELECT id FROM student_group_enrollments/.test(sql)) {
        return { rows: [{ id: "enrollment-1" }] };
      }
      if (/SELECT COALESCE\(SUM\(amount\), 0\)::numeric AS amount/.test(sql)) {
        return { rows: [{ amount: "40" }] };
      }
      if (/SELECT 1 AS deleted FROM server_sync_operations/.test(sql)) {
        return { rows: deleted ? [{ deleted: true }] : [] };
      }
      if (/SELECT name, teacher_id/.test(sql)) {
        return { rows: [] };
      }
      if (/^(UPDATE|INSERT)/.test(sql.trim())) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in group deletion test: ${sql}`);
    },
  };
}

async function run() {
  const client = makeClient();
  await SyncProcessor.applyDomainMutation(client, {
    centerId: "center-1",
    entityId: "group-1",
    entityType: "group",
    operationType: "DELETE",
    payload: { id: "group-1" },
  });

  const cycleLookup = client.calls.find(({ sql }) => /SELECT id FROM debt_cycles/.test(sql));
  assert.ok(cycleLookup, "group removal selects its own active cycles");
  assert.match(cycleLookup.sql, /package_subscription_id IS NULL/);
  assert.match(cycleLookup.sql, /cycle_type <> 'package'/);
  const cycleUpdate = client.calls.find(({ sql }) => /UPDATE debt_cycles/.test(sql));
  assert.ok(cycleUpdate, "unpaid group debt is cancelled");
  assert.deepEqual(cycleUpdate.params, ["center-1", "cycle-1", 40]);
  assert.ok(
    client.calls.some(({ sql }) => /UPDATE groups SET status = 'archived'/.test(sql)),
    "group is archived rather than physically deleted",
  );
  assert.equal(client.calls.some(({ sql }) => /DELETE FROM (groups|sessions|group_schedules)/.test(sql)), false);

  const deletedGroupClient = makeClient({ deleted: true });
  await SyncProcessor.applyDomainMutation(deletedGroupClient, {
    centerId: "center-1",
    entityId: "group-1",
    entityType: "group",
    operationType: "UPDATE",
    payload: { id: "group-1", status: "active", name: "Stale active group" },
  });
  assert.equal(
    deletedGroupClient.calls.some(({ sql }) => /INSERT INTO groups/.test(sql)),
    false,
    "later stale updates do not recreate a deleted group",
  );

  console.log("group_delete: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
