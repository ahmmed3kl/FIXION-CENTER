const assert = require("node:assert/strict");
const SyncProcessor = require("../src/services/SyncProcessor");

function makeClient(targetRows, updateRowCount = 1) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT a\.id, a\.status/.test(sql)) return { rows: targetRows };
      if (/UPDATE attendance/.test(sql)) return { rowCount: updateRowCount, rows: [] };
      throw new Error(`Unexpected SQL in attendance cancellation test: ${sql}`);
    },
  };
}

function mutationContext() {
  return {
    centerId: "center-authorized",
    entityId: "attendance-1",
    entityType: "attendance",
    operationType: "UPDATE",
    payload: {
      id: "attendance-1",
      sessionId: "session-1",
      studentId: "student-1",
      status: "absent",
      attendanceType: "makeup",
      originalAbsenceId: "source-absence-1",
      action: "attendance.cancel",
    },
  };
}

async function run() {
  const client = makeClient([{ id: "attendance-1", status: "present" }]);
  await SyncProcessor.applyDomainMutation(client, mutationContext());
  const update = client.calls.find(({ sql }) => /UPDATE attendance/.test(sql));
  assert.ok(update, "cancellation updates the matching existing row");
  assert.deepEqual(update.params, ["center-authorized", "attendance-1", "session-1", "student-1"]);
  assert.match(update.sql, /status = 'absent', is_late = FALSE/);
  assert.doesNotMatch(update.sql, /attendance_type\s*=|original_absence_id\s*=/);

  const replayClient = makeClient([{ id: "attendance-1", status: "absent" }]);
  await SyncProcessor.applyDomainMutation(replayClient, mutationContext());
  assert.equal(replayClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)), false);

  const outOfCenterClient = makeClient([]);
  await assert.rejects(
    SyncProcessor.applyDomainMutation(outOfCenterClient, mutationContext()),
    /ATTENDANCE_CANCEL_TARGET_NOT_FOUND/,
  );
  assert.equal(outOfCenterClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)), false);

  console.log("attendance_cancel: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
