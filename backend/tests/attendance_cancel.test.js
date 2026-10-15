const assert = require("node:assert/strict");
const SyncProcessor = require("../src/services/SyncProcessor");

function makeClient(
  targetRows,
  latestOperationId = null,
  updateRowCount = 1,
  compatibleSessionIds = null,
  existingRows = [],
) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM session_ids/.test(sql)) {
        const sessionIds = compatibleSessionIds || [params[1] || "session-1"];
        return { rows: sessionIds.map((session_id) => ({ session_id })) };
      }
      if (/FROM attendance a/.test(sql)) {
        return { rows: targetRows.map((row) => ({ session_id: "session-1", ...row })) };
      }
      if (/SELECT center_id, session_id, student_id\s+FROM attendance/.test(sql)) {
        return { rows: existingRows };
      }
      if (/FROM server_sync_operations/.test(sql)) {
        return {
          rows: latestOperationId ? [{ operation_id: latestOperationId }] : [],
        };
      }
      if (/UPDATE attendance/.test(sql)) return { rowCount: updateRowCount, rows: [] };
      throw new Error(`Unexpected SQL in attendance cancellation test: ${sql}`);
    },
  };
}

function mutationContext(
  expectedOperationId = "attendance-create-operation",
  operationId = "attendance-cancel-operation",
) {
  return {
    centerId: "center-authorized",
    operationId,
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
      expectedOperationId,
      action: "attendance.cancel",
    },
  };
}

async function run() {
  const client = makeClient(
    [{
      id: "attendance-1",
      session_id: "session-1",
      status: "present",
      operation_id: "attendance-create-operation",
    }],
    "attendance-create-operation",
  );
  await SyncProcessor.applyDomainMutation(client, mutationContext());
  const update = client.calls.find(({ sql }) => /UPDATE attendance/.test(sql));
  assert.ok(update, "cancellation updates the matching existing row");
  assert.deepEqual(update.params, [
    "center-authorized",
    "attendance-1",
    "session-1",
    "student-1",
    "attendance-create-operation",
    "attendance-cancel-operation",
  ]);
  assert.match(update.sql, /status = 'absent', is_late = FALSE/);
  assert.match(update.sql, /operation_id = \$6/);
  assert.doesNotMatch(update.sql, /attendance_type\s*=|original_absence_id\s*=/);
  assert.equal(
    SyncProcessor.cancelledSessionAttendanceAuditOutcome(
      new Error("ATTENDANCE_SESSION_CANCELLED_REQUIRES_REVIEW: event order is unknown."),
    ),
    "REQUIRES_REVIEW",
  );

  const aliasCancelClient = makeClient(
    [{
      id: "attendance-legacy",
      session_id: "legacy-session",
      status: "present",
      operation_id: "attendance-create-operation",
    }],
    "attendance-create-operation",
    1,
    ["canonical-session", "legacy-session"],
  );
  const aliasCancelContext = mutationContext();
  aliasCancelContext.payload.id = "attendance-legacy";
  aliasCancelContext.payload.sessionId = "canonical-session";
  await SyncProcessor.applyDomainMutation(aliasCancelClient, aliasCancelContext);
  const aliasUpdate = aliasCancelClient.calls.find(({ sql }) => /UPDATE attendance/.test(sql));
  assert.equal(aliasUpdate.params[2], "legacy-session");
  assert.deepEqual(
    aliasCancelClient.calls.find(({ sql }) => /FROM server_sync_operations/.test(sql)).params[2],
    ["canonical-session", "legacy-session"],
  );
  assert.equal(
    aliasCancelContext.ledgerPayload.session_id,
    "legacy-session",
    "cancellation updates the historical attendance in place without moving its session reference",
  );

  const replayClient = makeClient([{
    id: "attendance-1",
    session_id: "session-1",
    status: "absent",
    operation_id: "attendance-cancel-operation",
  }]);
  await SyncProcessor.applyDomainMutation(replayClient, mutationContext());
  assert.equal(replayClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)), false);

  const staleCancelClient = makeClient(
    [{
      id: "attendance-1",
      session_id: "session-1",
      status: "present",
      operation_id: "attendance-create-operation",
    }],
    "newer-present-operation",
  );
  await assert.rejects(
    SyncProcessor.applyDomainMutation(staleCancelClient, mutationContext()),
    /ATTENDANCE_CANCEL_STALE_REVISION/,
  );
  assert.equal(
    staleCancelClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)),
    false,
    "an old cancel does not overwrite a newer server-side attendance operation",
  );

  const legacyCancelClient = makeClient(
    [{
      id: "attendance-1",
      session_id: "session-1",
      status: "present",
      operation_id: "attendance-create-operation",
    }],
    "newer-present-operation",
  );
  const legacyContext = mutationContext();
  delete legacyContext.payload.expectedOperationId;
  await assert.rejects(
    SyncProcessor.applyDomainMutation(legacyCancelClient, legacyContext),
    /ATTENDANCE_CANCEL_REVISION_REQUIRED/,
  );
  assert.equal(
    legacyCancelClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)),
    false,
  );

  const missingRevisionClient = makeClient(
    [{
      id: "attendance-1",
      session_id: "session-1",
      status: "present",
      operation_id: "attendance-create-operation",
    }],
    "attendance-create-operation",
  );
  const missingRevisionContext = mutationContext();
  delete missingRevisionContext.payload.expectedOperationId;
  await assert.rejects(
    SyncProcessor.applyDomainMutation(missingRevisionClient, missingRevisionContext),
    /ATTENDANCE_CANCEL_REVISION_REQUIRED/,
  );
  assert.equal(
    missingRevisionClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)),
    false,
    "legacy cancellations without a revision token cannot cancel the current server row",
  );

  const freshCancelClient = makeClient(
    [{
      id: "attendance-1",
      session_id: "session-1",
      status: "present",
      operation_id: "newer-present-operation",
    }],
    "newer-present-operation",
  );
  await SyncProcessor.applyDomainMutation(
    freshCancelClient,
    mutationContext("newer-present-operation", "fresh-cancel-operation"),
  );
  assert.deepEqual(
    freshCancelClient.calls.find(({ sql }) => /UPDATE attendance/.test(sql)).params,
    [
      "center-authorized",
      "attendance-1",
      "session-1",
      "student-1",
      "newer-present-operation",
      "fresh-cancel-operation",
    ],
    "a cancellation created against the latest pulled attendance revision is accepted",
  );

  const missingAttendanceClient = makeClient([]);
  await assert.rejects(
    SyncProcessor.applyDomainMutation(missingAttendanceClient, mutationContext()),
    /ATTENDANCE_CANCEL_TARGET_NOT_FOUND/,
  );
  assert.equal(
    missingAttendanceClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)),
    false,
    "an actually missing attendance row remains retryable",
  );

  const otherCenterClient = makeClient([], null, 1, null, [{
    center_id: "another-center",
    session_id: "session-1",
    student_id: "student-1",
  }]);
  await assert.rejects(
    SyncProcessor.applyDomainMutation(otherCenterClient, mutationContext()),
    /ATTENDANCE_CANCEL_CENTER_MISMATCH/,
  );

  const mismatchedAttendanceClient = makeClient([], null, 1, null, [{
    center_id: "center-authorized",
    session_id: "another-session",
    student_id: "student-1",
  }]);
  await assert.rejects(
    SyncProcessor.applyDomainMutation(mismatchedAttendanceClient, mutationContext()),
    /ATTENDANCE_CANCEL_TARGET_MISMATCH/,
  );
  assert.equal(
    mismatchedAttendanceClient.calls.some(({ sql }) => /UPDATE attendance/.test(sql)),
    false,
    "an existing row with the wrong target is not treated as a dependency",
  );

  console.log("attendance_cancel: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
