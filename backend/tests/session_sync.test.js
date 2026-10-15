const assert = require("assert");
const db = require("../src/db");
const SyncProcessor = require("../src/services/SyncProcessor");

async function run() {
  const receivedAt = "2026-10-12T10:05:00.000Z";
  assert.strictEqual(
    SyncProcessor.acceptedSessionStartTime(
      "2026-10-12T10:02:00.000Z",
      receivedAt,
    ),
    "2026-10-12T10:02:00.000Z",
  );
  assert.strictEqual(
    SyncProcessor.acceptedSessionStartTime(
      "2026-10-12T09:00:00.000Z",
      receivedAt,
    ),
    "2026-10-12T10:00:00.000Z",
  );
  assert.strictEqual(
    SyncProcessor.acceptedSessionStartTime(
      "2026-10-12T10:10:00.000Z",
      receivedAt,
    ),
    receivedAt,
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("open", "update", "cancelled"),
    "cancelled",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("cancelled", "create", "open"),
    "cancelled",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("closed", "update", "open"),
    "closed",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("closed", "reopen", "open"),
    "open",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("scheduled", "activate", "open"),
    "open",
    "an explicit activation opens a scheduled session",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("open", "activate", "open"),
    "open",
    "activation is idempotent for an already-open session",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("closed", "activate", "open"),
    "closed",
    "activation does not reopen a closed session",
  );
  assert.strictEqual(
    SyncProcessor.resolveSessionStatus("cancelled", "activate", "open"),
    "cancelled",
    "activation does not reopen a cancelled session",
  );

  let naturalKeySql;
  const naturalKeys = await SyncProcessor.getSessionNaturalKeys(
    {
      async query(sql, params) {
        naturalKeySql = sql;
        assert.deepStrictEqual(params, ["center-a"]);
        return {
          rows: [{
            groupId: "group-a",
            scheduleKey: "schedule-a",
            sessionDate: "2026-10-12",
            canonicalSessionId: "session-a",
            status: "scheduled",
            hasNonCancelledDuplicate: false,
            hasCancelledDuplicate: true,
          }],
        };
      },
    },
    "center-a",
  );
  assert.match(naturalKeySql, /FROM session_natural_keys snk/i);
  assert.doesNotMatch(naturalKeySql, /\bnatural\s*\./i);
  assert.match(naturalKeySql, /sibling\.center_id = snk\.center_id/i);
  assert.deepStrictEqual(naturalKeys, [{
    centerId: "center-a",
    groupId: "group-a",
    scheduleKey: "schedule-a",
    sessionDate: "2026-10-12",
    canonicalSessionId: "session-a",
    status: "scheduled",
    hasNonCancelledDuplicate: false,
    hasCancelledDuplicate: true,
  }]);

  const originalWithTransaction = db.withTransaction;
  const pushState = { canonicalSessionId: "canonical-session" };
  const pushClient = {
    async query(sql, params = []) {
      if (/FROM session_id_aliases aliases/.test(sql)) {
        if (params[1] !== "local-session") return { rows: [] };
        return {
          rows: [{
            canonical_session_id: pushState.canonicalSessionId,
            canonical_center_id: "center-a",
            canonical_group_id: "group-a",
            canonical_schedule_id: "schedule-a",
            canonical_session_date: "2026-10-12",
            canonical_status: "open",
            source_center_id: "center-a",
            source_group_id: "group-a",
            source_schedule_id: "schedule-a",
            source_session_date: "2026-10-12",
            source_status: "open",
          }],
        };
      }
      if (/SELECT COALESCE\(MAX\(server_seq\)/.test(sql)) {
        return { rows: [{ max_seq: "8" }] };
      }
      if (/SELECT server_seq, status, center_id FROM server_sync_operations/.test(sql)) {
        return {
          rows: [{
            server_seq: "5",
            status: "applied",
            center_id: "center-a",
          }],
        };
      }
      if (/FROM session_natural_keys/.test(sql)) {
        return { rows: [{ session_id: pushState.canonicalSessionId }] };
      }
      return { rows: [] };
    },
  };
  db.withTransaction = (callback) => callback(pushClient);
  try {
    const canonicalRetry = await SyncProcessor.processPush(
      "center-a",
      "user-a",
      "device-a",
      [{
        operationId: "canonical-session-retry",
        operationType: "CREATE",
        entityType: "session",
        entityId: "canonical-session",
        payload: {
          id: "canonical-session",
          groupId: "group-a",
          scheduleId: "schedule-a",
          sessionDate: "2026-10-12",
        },
      }],
    );
    assert.deepStrictEqual(
      canonicalRetry.sessionMappings,
      [],
      "an idempotent retry of the canonical session must not return a self-alias",
    );

    const aliasRetry = await SyncProcessor.processPush(
      "center-a",
      "user-a",
      "device-b",
      [{
        operationId: "local-session-retry",
        operationType: "CREATE",
        entityType: "session",
        entityId: "local-session",
        payload: {
          id: "local-session",
          groupId: "group-a",
          scheduleId: "schedule-a",
          sessionDate: "2026-10-12",
        },
      }],
    );
    assert.deepStrictEqual(
      aliasRetry.sessionMappings,
      [{
        localSessionId: "local-session",
        canonicalSessionId: "canonical-session",
      }],
      "an idempotent retry must continue returning its actual scheduled-session alias",
    );
  } finally {
    db.withTransaction = originalWithTransaction;
  }

  function activationFixture(initialStatus, exists = true) {
    const state = {
      status: initialStatus,
      exists,
      insertedSessions: 0,
      startEvents: 0,
    };
    const session = () => ({
      group_id: "group-a",
      schedule_id: "schedule-a",
      subject_id: "subject-a",
      teacher_id: "teacher-a",
      session_price: 100,
      late_after_minutes: 15,
      session_date: "2026-10-12",
      start_time: "10:00",
      end_time: "11:00",
      status: state.status,
    });
    return {
      state,
      client: {
        async query(sql, params = []) {
          if (/FROM session_id_aliases aliases/.test(sql)) return { rows: [] };
          if (/SELECT center_id FROM sessions WHERE id = \$1/.test(sql)) {
            return { rows: state.exists ? [{ center_id: "center-a" }] : [] };
          }
          if (/FROM groups/.test(sql)) {
            return { rows: [{ id: "group-a", subject_id: "subject-a", teacher_id: "teacher-a", grade: "Grade 8" }] };
          }
          if (/FROM session_natural_keys/.test(sql)) {
            return { rows: state.exists ? [{ session_id: "session-a" }] : [] };
          }
          if (/FROM sessions WHERE center_id = \$1::varchar AND id = \$2::varchar/.test(sql)) {
            return { rows: state.exists ? [session()] : [] };
          }
          if (/INSERT INTO sessions/.test(sql)) {
            state.insertedSessions += 1;
            state.status = params[11];
            return { rows: [] };
          }
          if (/INSERT INTO session_start_events/.test(sql)) {
            state.startEvents += 1;
            return { rows: [] };
          }
          return { rows: [] };
        },
      },
    };
  }

  function activationContext(operationId) {
    return {
      centerId: "center-a",
      userId: "user-a",
      deviceId: "device-a",
      operationId,
      operationType: "UPDATE",
      entityType: "session",
      entityId: "session-a",
      payload: {
        action: "activate",
        id: "session-a",
        groupId: "group-a",
        scheduleId: "schedule-a",
        subjectId: "subject-a",
        teacherId: "teacher-a",
        sessionPrice: 100,
        lateAfterMinutes: 15,
        sessionDate: "2026-10-12",
        startTime: "10:00",
        endTime: "11:00",
        status: "open",
        expectedStudentIds: [],
      },
    };
  }

  const scheduledActivation = activationFixture("scheduled");
  const scheduledActivationContext = activationContext("activation-operation");
  await SyncProcessor.applyDomainMutation(
    scheduledActivation.client,
    scheduledActivationContext,
  );
  assert.equal(scheduledActivation.state.status, "open");
  assert.equal(scheduledActivation.state.startEvents, 1);
  assert.equal(scheduledActivationContext.canonicalEntityId, "session-a");
  assert.ok(Number.isFinite(Date.parse(scheduledActivationContext.sessionStartedAt)));

  await SyncProcessor.applyDomainMutation(
    scheduledActivation.client,
    activationContext("activation-retry-from-another-device"),
  );
  assert.equal(
    scheduledActivation.state.startEvents,
    1,
    "an activation retry against an already-open session has no duplicate start effect",
  );

  const cancelledActivation = activationFixture("cancelled");
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      cancelledActivation.client,
      activationContext("cancelled-activation"),
    ),
    /SESSION_CANCELLED/,
  );
  assert.equal(cancelledActivation.state.insertedSessions, 0);

  const missingActivation = activationFixture("scheduled", false);
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      missingActivation.client,
      activationContext("missing-activation-target"),
    ),
    /SESSION_ACTIVATION_TARGET_NOT_FOUND/,
  );
  assert.equal(missingActivation.state.insertedSessions, 0);

  const aliases = new Map([
    ["center-a:local-session-a", "canonical-session-a"],
    ["center-b:local-session-b", "canonical-session-b"],
  ]);
  const client = {
    async query(_sql, [centerId, sessionId]) {
      const canonicalSessionId = aliases.get(`${centerId}:${sessionId}`);
      return {
        rows: canonicalSessionId
          ? [{
              canonical_session_id: canonicalSessionId,
              canonical_center_id: centerId,
              canonical_group_id: "group-a",
              canonical_schedule_id: "schedule-a",
              canonical_session_date: "2026-10-12",
              canonical_status: "open",
              source_center_id: null,
              source_group_id: null,
              source_schedule_id: null,
              source_session_date: null,
              source_status: null,
            }]
          : [],
      };
    },
  };
  assert.strictEqual(
    await SyncProcessor.resolveSessionAlias(client, "center-a", "local-session-a"),
    "canonical-session-a",
  );
  assert.strictEqual(
    await SyncProcessor.resolveSessionAlias(client, "center-a", "local-session-b"),
    null,
  );
  const aliasChain = new Map([
    ["legacy-session-a", "legacy-session-b"],
    ["legacy-session-b", "canonical-session-c"],
  ]);
  const aliasChainClient = {
    async query(sql, [centerId, sessionId]) {
      if (/FROM session_natural_keys/.test(sql)) {
        return { rows: [{ session_id: "legacy-session-a" }] };
      }
      const canonicalSessionId = aliasChain.get(sessionId);
      return {
        rows: canonicalSessionId
          ? [{
              canonical_session_id: canonicalSessionId,
              canonical_center_id: centerId,
              canonical_group_id: "group-a",
              canonical_schedule_id: "schedule-a",
              canonical_session_date: "2026-10-12",
              canonical_status: "open",
              source_center_id: null,
              source_group_id: null,
              source_schedule_id: null,
              source_session_date: null,
              source_status: null,
            }]
          : [],
      };
    },
  };
  assert.strictEqual(
    await SyncProcessor.resolveSessionAlias(
      aliasChainClient,
      "center-a",
      "legacy-session-a",
    ),
    "canonical-session-c",
    "aliases resolve to their terminal canonical session",
  );
  assert.strictEqual(
    await SyncProcessor.findSessionByNaturalKey(
      aliasChainClient,
      "center-a",
      "group-a",
      "schedule-a",
      "2026-10-12",
    ),
    "canonical-session-c",
    "natural-key lookup does not return a stale alias row",
  );
  const cyclicAliases = new Map([
    ["cycle-session-a", "cycle-session-b"],
    ["cycle-session-b", "cycle-session-a"],
  ]);
  const cyclicAliasClient = {
    async query(_sql, [_centerId, sessionId]) {
      const canonicalSessionId = cyclicAliases.get(sessionId);
      return {
        rows: canonicalSessionId
          ? [{
              canonical_session_id: canonicalSessionId,
              canonical_center_id: "center-a",
              canonical_group_id: "group-a",
              canonical_schedule_id: "schedule-a",
              canonical_session_date: "2026-10-12",
              canonical_status: "open",
              source_center_id: null,
              source_group_id: null,
              source_schedule_id: null,
              source_session_date: null,
              source_status: null,
            }]
          : [],
      };
    },
  };
  await assert.rejects(
    SyncProcessor.resolveSessionAlias(
      cyclicAliasClient,
      "center-a",
      "cycle-session-a",
    ),
    /SESSION_ALIAS_CYCLE/,
  );
  const canonicalized = await SyncProcessor.canonicalizeSessionReferences(
    client,
    "center-a",
    {
      sessionId: "local-session-a",
      originalAbsenceId: "local-session-b",
      detail: [{ target_future_session_id: "local-session-a" }],
    },
    new Map(),
  );
  assert.deepStrictEqual(canonicalized, {
    sessionId: "canonical-session-a",
    originalAbsenceId: "local-session-b",
    detail: [{ target_future_session_id: "canonical-session-a" }],
  });

  const canonicalIds = new Map([
    ["center-a:local-session-a", "canonical-session-a"],
    ["center-a:local-session-b", "canonical-session-b"],
  ]);
  let activeAliasQueries = 0;
  let maxActiveAliasQueries = 0;
  let aliasQueryCount = 0;
  const serializedAliasClient = {
    async query(_sql, [centerId, sessionId]) {
      aliasQueryCount += 1;
      activeAliasQueries += 1;
      maxActiveAliasQueries = Math.max(
        maxActiveAliasQueries,
        activeAliasQueries,
      );
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const canonicalSessionId = canonicalIds.get(
          `${centerId}:${sessionId}`,
        );
        return {
          rows: canonicalSessionId
            ? [{
                canonical_session_id: canonicalSessionId,
                canonical_center_id: centerId,
                canonical_group_id: "group-a",
                canonical_schedule_id: "schedule-a",
                canonical_session_date: "2026-10-12",
                canonical_status: "open",
                source_center_id: centerId,
                source_group_id: "group-a",
                source_schedule_id: "schedule-a",
                source_session_date: "2026-10-12",
                source_status: "open",
              }]
            : [],
        };
      } finally {
        activeAliasQueries -= 1;
      }
    },
  };
  const canonicalizedArray = await SyncProcessor.canonicalizeSessionReferences(
    serializedAliasClient,
    "center-a",
    [
      { session_id: "local-session-a" },
      { session_id: "local-session-a" },
      { session_id: "local-session-b" },
    ],
    new Map(),
  );
  assert.deepStrictEqual(canonicalizedArray, [
    { session_id: "canonical-session-a" },
    { session_id: "canonical-session-a" },
    { session_id: "canonical-session-b" },
  ]);
  assert.equal(aliasQueryCount, 4, "repeated aliases reuse the resolved mapping");
  assert.equal(maxActiveAliasQueries, 1);

  let activeHomeworkQueries = 0;
  let maxActiveHomeworkQueries = 0;
  const homeworkClient = {
    async query(sql) {
      activeHomeworkQueries += 1;
      maxActiveHomeworkQueries = Math.max(
        maxActiveHomeworkQueries,
        activeHomeworkQueries,
      );
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (/FROM students/.test(sql)) return { rows: [{ id: "student-a" }] };
        if (/FROM sessions/.test(sql)) return { rows: [{ id: "session-a" }] };
        if (/UPDATE session_homework_evaluations/.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected homework-evaluation SQL: ${sql}`);
      } finally {
        activeHomeworkQueries -= 1;
      }
    },
  };
  await SyncProcessor.applyDomainMutation(homeworkClient, {
    centerId: "center-a",
    userId: "user-a",
    operationId: "homework-evaluation-delete",
    operationType: "UPDATE",
    entityType: "session_homework_evaluation",
    entityId: "evaluation-a",
    payload: {
      id: "evaluation-a",
      student_id: "student-a",
      session_id: "session-a",
    },
  });
  assert.equal(maxActiveHomeworkQueries, 1);

  const pulledReferences = SyncProcessor.canonicalizePulledSessionReferences(
    {
      session_id: "local-session-a",
      original_absence_id: "local-session-a",
      advance_session_id: "local-session-a",
      target_future_session_id: "local-session-a",
    },
    new Map([["local-session-a", "canonical-session-a"]]),
  );
  assert.deepStrictEqual(pulledReferences, {
    session_id: "canonical-session-a",
    original_absence_id: "local-session-a",
    advance_session_id: "canonical-session-a",
    target_future_session_id: "canonical-session-a",
  });
  const cancelledAliasClient = {
    async query() {
      return {
        rows: [{
          canonical_session_id: "canonical-session-a",
          canonical_center_id: "center-a",
          canonical_group_id: "group-a",
          canonical_schedule_id: "schedule-a",
          canonical_session_date: "2026-10-12",
          canonical_status: "open",
          source_center_id: "center-a",
          source_group_id: "group-a",
          source_schedule_id: "schedule-a",
          source_session_date: "2026-10-12",
          source_status: "cancelled",
        }],
      };
    },
  };
  await assert.rejects(
    SyncProcessor.resolveSessionAlias(
      cancelledAliasClient,
      "center-a",
      "local-session-a",
    ),
    /SESSION_ALIAS_CANCELLED_STATUS_CONFLICT/,
  );
  assert.strictEqual(
    SyncProcessor.resolveAttendanceStatus("absent", "present"),
    "present",
  );
  assert.strictEqual(
    SyncProcessor.resolveAttendanceStatus("present", "absent"),
    "present",
  );
  assert.strictEqual(
    SyncProcessor.resolveAttendanceStatus("absent", "absent"),
    "absent",
  );

  const mergedAttendance = {
    id: "existing-attendance",
    session_id: "legacy-session-open",
    student_id: "student-a",
    check_in_time: "2026-10-12T10:00:00.000Z",
    status: "present",
    is_late: false,
    attendance_type: "present",
    original_absence_id: null,
    operation_id: "existing-present-operation",
  };
  const attendanceMergeCalls = [];
  const attendanceMergeClient = {
    async query(sql, params = []) {
      attendanceMergeCalls.push({ sql, params });
      if (/FROM sessions s/.test(sql)) {
        return {
          rows: [{
            id: "session-open",
            session_date: "2026-10-12",
            start_time: "10:00:00",
            group_id: "group-a",
            subject_id: "subject-a",
            teacher_id: "teacher-a",
            status: "open",
            validated_group_id: "group-a",
            group_grade: "Grade 8",
          }],
        };
      }
      if (/FROM students/.test(sql)) {
        return { rows: [{ center_id: "center-a" }] };
      }
      if (/INSERT INTO attendance/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM session_ids/.test(sql)) {
        return {
          rows: [
            { session_id: "session-open" },
            { session_id: "legacy-session-open" },
          ],
        };
      }
      if (/FROM attendance a/.test(sql)) {
        return { rows: [{ ...mergedAttendance }] };
      }
      if (/UPDATE attendance\s+SET status = \$3, is_late = \$4, operation_id = \$5/.test(sql)) {
        mergedAttendance.status = params[2];
        mergedAttendance.is_late = params[3];
        mergedAttendance.operation_id = params[4];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE attendance\s+SET operation_id = \$3/.test(sql)) {
        mergedAttendance.operation_id = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT id, session_id, student_id, check_in_time/.test(sql)) {
        return { rows: [{ ...mergedAttendance }] };
      }
      throw new Error(`Unexpected attendance merge SQL: ${sql}`);
    },
  };
  const attendanceMergeContext = {
    centerId: "center-a",
    userId: "user-a",
    deviceId: "device-b",
    operationId: "newer-absent-operation",
    operationType: "CREATE",
    entityType: "attendance",
    entityId: "duplicate-attendance",
    payload: {
      id: "duplicate-attendance",
      session_id: "session-open",
      student_id: "student-a",
      status: "absent",
      is_external: true,
    },
  };
  await SyncProcessor.applyDomainMutation(
    attendanceMergeClient,
    attendanceMergeContext,
  );
  assert.equal(mergedAttendance.status, "present");
  assert.equal(
    mergedAttendance.session_id,
    "legacy-session-open",
    "attendance under a historical alias is updated in place without moving its session reference",
  );
  assert.equal(mergedAttendance.operation_id, "newer-absent-operation");
  assert.equal(
    attendanceMergeContext.ledgerPayload.operation_id,
    "newer-absent-operation",
  );
  assert.equal(attendanceMergeContext.ledgerPayload.status, "present");
  assert.equal(
    attendanceMergeContext.ledgerPayload.session_id,
    "legacy-session-open",
  );
  assert.ok(
    attendanceMergeCalls.some(({ sql }) => /UPDATE attendance\s+SET operation_id/.test(sql)),
    "server records the current resolved attendance revision even when present wins",
  );

  const duplicateAliasAttendanceClient = {
    async query(sql) {
      if (/FROM sessions s/.test(sql)) {
        return {
          rows: [{
            id: "session-open",
            session_date: "2026-10-12",
            start_time: "10:00:00",
            group_id: "group-a",
            subject_id: "subject-a",
            teacher_id: "teacher-a",
            status: "open",
            validated_group_id: "group-a",
            group_grade: "Grade 8",
          }],
        };
      }
      if (/FROM students/.test(sql)) return { rows: [{ center_id: "center-a" }] };
      if (/FROM session_ids/.test(sql)) {
        return { rows: [{ session_id: "session-open" }] };
      }
      if (/FROM attendance a/.test(sql)) {
        return {
          rows: [
            { ...mergedAttendance, id: "historical-attendance-a" },
            { ...mergedAttendance, id: "historical-attendance-b" },
          ],
        };
      }
      throw new Error(`Unexpected duplicate-alias SQL: ${sql}`);
    },
  };
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      duplicateAliasAttendanceClient,
      attendanceMergeContext,
    ),
    /ATTENDANCE_ALIAS_RECORD_CONFLICT/,
  );

  mergedAttendance.status = "absent";
  mergedAttendance.operation_id = "accepted-cancel-operation";
  const presentAfterCancelContext = {
    ...attendanceMergeContext,
    operationId: "present-after-cancel-operation",
    payload: {
      ...attendanceMergeContext.payload,
      id: "present-after-cancel",
      status: "present",
    },
  };
  await SyncProcessor.applyDomainMutation(
    attendanceMergeClient,
    presentAfterCancelContext,
  );
  assert.equal(mergedAttendance.status, "present");
  assert.equal(
    mergedAttendance.operation_id,
    "present-after-cancel-operation",
    "a later explicit presence remains authoritative after an accepted cancellation",
  );

  const cancelledSessionClient = {
    async query(sql) {
      assert.match(sql, /FROM sessions s/);
      return {
        rows: [{
          session_date: "2026-10-12",
          group_id: "group-a",
          subject_id: "subject-a",
          teacher_id: "teacher-a",
          status: "cancelled",
          updated_at: "2026-10-12T10:00:00.000Z",
          validated_group_id: "group-a",
        }],
      };
    },
  };
  const cancelledAttendanceContext = {
    centerId: "center-a",
    userId: "user-a",
    deviceId: "device-a",
    operationId: "late-cancelled-attendance",
    operationType: "create",
    entityType: "attendance",
    entityId: "attendance-a",
    payload: {
      id: "attendance-a",
      session_id: "session-cancelled",
      student_id: "student-a",
      check_in_time: "2026-10-12T09:58:00.000Z",
    },
  };
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      cancelledSessionClient,
      cancelledAttendanceContext,
    ),
    /ATTENDANCE_SESSION_CANCELLED_REQUIRES_REVIEW/,
  );
  await assert.rejects(
    SyncProcessor.applyDomainMutation(cancelledSessionClient, {
      ...cancelledAttendanceContext,
      operationId: "new-cancelled-attendance",
      payload: {
        ...cancelledAttendanceContext.payload,
        check_in_time: "2026-10-12T10:05:00.000Z",
      },
    }),
    /ATTENDANCE_SESSION_CANCELLED_REQUIRES_REVIEW/,
  );

  console.log("PASS: session activation, alias, attendance conflict, and cancellation policies");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
