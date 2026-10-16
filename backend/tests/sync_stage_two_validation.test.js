const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");

const centerId = "stage-two-center";
const studentId = "stage-two-student";
const sourceSessionId = "stage-two-source";
const targetSessionId = "stage-two-target";

function makeSession(id, overrides = {}) {
  return {
    id,
    center_id: centerId,
    group_id: `${id}-group`,
    validated_group_id: `${id}-group`,
    group_grade: "Grade 8",
    session_date: id === sourceSessionId ? "2026-10-01" : "2026-10-08",
    start_time: "10:00:00",
    status: "open",
    subject_id: "stage-two-subject",
    teacher_id: "stage-two-teacher",
    schedule_id: `${id}-schedule`,
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  const state = {
    sessions: new Map([
      [sourceSessionId, makeSession(sourceSessionId)],
      [targetSessionId, makeSession(targetSessionId)],
    ]),
    students: new Map([
      [studentId, { id: studentId, center_id: centerId, deleted_at: null }],
    ]),
    attendance: [
      {
        id: "stage-two-absence",
        center_id: centerId,
        session_id: sourceSessionId,
        student_id: studentId,
        status: "absent",
        attendance_type: "present",
        operation_id: "stage-two-absence-operation",
      },
    ],
    coverages: [],
    aliases: [],
    expectedStudent: true,
    hasTargetSnapshot: true,
    notificationEvents: new Map(),
    statements: [],
    ...overrides,
  };

  const client = {
    state,
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, " ").trim();
      state.statements.push({ sql: statement, params });

      if (statement.includes("FROM sessions s") && statement.includes("WHERE s.center_id = $1")) {
        const session = state.sessions.get(String(params[1]));
        return {
          rows:
            session && String(session.center_id) === String(params[0])
              ? [{ ...session }]
              : [],
        };
      }
      if (statement.includes("SELECT center_id FROM sessions WHERE id = $1")) {
        const session = state.sessions.get(String(params[0]));
        return { rows: session ? [{ center_id: session.center_id }] : [] };
      }
      if (
        statement.includes("FROM session_id_aliases aliases") &&
        statement.includes("SELECT aliases.canonical_session_id")
      ) {
        const [requestedCenterId, localSessionId] = params;
        const mapping = state.aliases.find(
          (alias) =>
            typeof alias === "object" &&
            String(alias.centerId || centerId) === String(requestedCenterId) &&
            String(alias.localSessionId) === String(localSessionId),
        );
        const canonical = mapping
          ? state.sessions.get(String(mapping.canonicalSessionId))
          : null;
        const source = state.sessions.get(String(localSessionId));
        const matchingScheduledIdentity =
          canonical?.schedule_id &&
          (!source ||
            (source.schedule_id &&
              String(source.group_id) === String(canonical.group_id) &&
              String(source.schedule_id) === String(canonical.schedule_id) &&
              String(source.session_date).slice(0, 10) ===
                String(canonical.session_date).slice(0, 10)));
        return {
          rows:
            canonical &&
            String(canonical.center_id) === String(requestedCenterId) &&
            matchingScheduledIdentity
              ? [{
                  canonical_session_id: mapping.canonicalSessionId,
                  canonical_center_id: canonical.center_id,
                  canonical_group_id: canonical.group_id,
                  canonical_schedule_id: canonical.schedule_id,
                  canonical_session_date: canonical.session_date,
                  canonical_status: canonical.status,
                  source_center_id: source?.center_id || null,
                  source_group_id: source?.group_id || null,
                  source_schedule_id: source?.schedule_id || null,
                  source_session_date: source?.session_date || null,
                  source_status: source?.status || null,
                }]
              : [],
        };
      }
      if (statement.includes("FROM students")) {
        const student = state.students.get(String(params[params.length - 1]));
        return { rows: student ? [{ ...student }] : [] };
      }
      if (
        statement.includes("SELECT id, status, attendance_type FROM attendance") &&
        statement.includes("session_id = ANY($3::varchar[])")
      ) {
        const [requestedCenterId, requestedStudentId, sessionIds] = params;
        return {
          rows: state.attendance
            .filter(
              (row) =>
                String(row.center_id) === String(requestedCenterId) &&
                String(row.student_id) === String(requestedStudentId) &&
                sessionIds.map(String).includes(String(row.session_id)),
            )
            .map((row) => ({ ...row })),
        };
      }
      if (
        statement.includes("FROM attendance") &&
        statement.includes("session_id = ANY($2::varchar[])") &&
        statement.includes("student_id = $3")
      ) {
        const [requestedCenterId, sessionIds, requestedStudentId] = params;
        return {
          rows: state.attendance
            .filter(
              (row) =>
                String(row.center_id) === String(requestedCenterId) &&
                String(row.student_id) === String(requestedStudentId) &&
                sessionIds.map(String).includes(String(row.session_id)),
            )
            .map((row) => ({ ...row })),
        };
      }
      if (
        statement.includes("FROM attendance") &&
        statement.includes("original_absence_id = ANY($3::varchar[])")
      ) {
        const [requestedCenterId, requestedStudentId, references] = params;
        return {
          rows: state.attendance
            .filter(
              (row) =>
                String(row.center_id) === String(requestedCenterId) &&
                String(row.student_id) === String(requestedStudentId) &&
                String(row.attendance_type).toLowerCase() === "makeup" &&
                references.map(String).includes(String(row.original_absence_id)),
            )
            .map((row) => ({ ...row })),
        };
      }
      if (
        statement.includes("FROM attendance") &&
        statement.includes("session_id = $2 AND student_id = $3")
      ) {
        const [requestedCenterId, requestedSessionId, requestedStudentId] = params;
        return {
          rows: state.attendance
            .filter(
              (row) =>
                String(row.center_id) === String(requestedCenterId) &&
                String(row.session_id) === String(requestedSessionId) &&
                String(row.student_id) === String(requestedStudentId),
            )
            .map((row) => ({ ...row })),
        };
      }
      if (
        statement.includes("FROM session_id_aliases") &&
        statement.includes("SELECT aliases.local_session_id") ||
        statement.includes("FROM session_id_aliases") &&
        statement.includes("SELECT local_session_id")
      ) {
        const [requestedCenterId, canonicalSessionId] = params;
        return {
          rows: state.aliases
            .filter(
              (alias) => {
                if (
                  typeof alias !== "object" ||
                  String(alias.centerId || centerId) !== String(requestedCenterId) ||
                  String(alias.canonicalSessionId) !== String(canonicalSessionId)
                ) {
                  return false;
                }
                const source = state.sessions.get(String(alias.localSessionId));
                const canonical = state.sessions.get(String(alias.canonicalSessionId));
                return Boolean(
                  canonical?.schedule_id &&
                  (!source ||
                    (source.schedule_id &&
                      String(source.group_id) === String(canonical.group_id) &&
                      String(source.schedule_id) === String(canonical.schedule_id) &&
                      String(source.session_date) === String(canonical.session_date) &&
                      !(
                        (String(canonical.status || "").toLowerCase() === "cancelled" &&
                          String(source.status || "").toLowerCase() !== "cancelled") ||
                        (String(source.status || "").toLowerCase() === "cancelled" &&
                          String(canonical.status || "").toLowerCase() !== "cancelled")
                      ))),
                );
              },
            )
            .map((alias) => ({ local_session_id: alias.localSessionId })),
        };
      }
      if (statement.includes("FROM advance_coverages")) {
        if (statement.includes("WHERE id = $1")) {
          return {
            rows: state.coverages
              .filter((row) => String(row.id) === String(params[0]))
              .map((row) => ({ ...row })),
          };
        }
        if (statement.includes("target_future_session_id = ANY($3::varchar[])")) {
          const [requestedCenterId, requestedStudentId, sessionIds] = params;
          return {
            rows: state.coverages
              .filter(
                (row) =>
                  String(row.center_id) === String(requestedCenterId) &&
                  String(row.student_id) === String(requestedStudentId) &&
                  sessionIds.map(String).includes(String(row.target_future_session_id)),
              )
              .map((row) => ({ ...row })),
          };
        }
        if (statement.includes("target_future_session_id = $3")) {
          const [requestedCenterId, requestedStudentId, sessionId] = params;
          return {
            rows: state.coverages
              .filter(
                (row) =>
                  String(row.center_id) === String(requestedCenterId) &&
                  String(row.student_id) === String(requestedStudentId) &&
                  String(row.target_future_session_id) === String(sessionId),
              )
              .map((row) => ({ ...row })),
          };
        }
        if (statement.includes("advance_session_id = $3")) {
          const [requestedCenterId, requestedStudentId, sessionId] = params;
          return {
            rows: state.coverages
              .filter(
                (row) =>
                  String(row.center_id) === String(requestedCenterId) &&
                  String(row.student_id) === String(requestedStudentId) &&
                  String(row.advance_session_id) === String(sessionId),
              )
              .map((row) => ({ ...row })),
          };
        }
      }
      if (statement.includes("FROM session_expected_students")) {
        if (statement.includes("student_id = $3")) {
          return { rows: state.expectedStudent ? [{ "?column?": 1 }] : [] };
        }
        return { rows: state.hasTargetSnapshot ? [{ "?column?": 1 }] : [] };
      }
      if (
        statement.includes("FROM notification_events") &&
        statement.includes("WHERE center_id = $1 AND id = $2")
      ) {
        const event = state.notificationEvents.get(String(params[1]));
        return { rows: event ? [{ ...event }] : [] };
      }
      if (statement.includes("INSERT INTO notification_events")) {
        return { rows: [] };
      }
      if (statement.includes("INSERT INTO notification_deliveries")) {
        return { rows: [] };
      }
      if (statement.includes("INSERT INTO advance_coverages")) {
        return { rows: [] };
      }
      if (
        statement.includes("FROM student_group_enrollments") ||
        statement.includes("FROM student_package_subscriptions")
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  };
  return client;
}

function mutationContext(entityType, payload, overrides = {}) {
  return {
    centerId,
    userId: "stage-two-user",
    operationId: "stage-two-operation",
    operationType: "CREATE",
    entityType,
    entityId: payload.id || "stage-two-entity",
    payload,
    ...overrides,
  };
}

test("makeup requires an explicit source absence and retries when its session has not arrived", async () => {
  const client = makeClient({
    sessions: new Map([[targetSessionId, makeSession(targetSessionId)]]),
  });

  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId: sourceSessionId,
      targetSession: makeSession(targetSessionId),
      targetSessionId,
      studentId,
    }),
    /ATTENDANCE_TARGET_NOT_FOUND/,
  );
  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId: "",
      targetSession: makeSession(targetSessionId),
      targetSessionId,
      studentId,
    }),
    /MAKEUP_ORIGINAL_ABSENCE_REQUIRED/,
  );
});

test("makeup accepts only a same-center explicit absence and later matching session", async () => {
  const client = makeClient();
  const valid = await SyncProcessor.validateMakeupAttendance(client, {
    centerId,
    sourceSessionId,
    targetSession: makeSession(targetSessionId),
    targetSessionId,
    studentId,
  });
  assert.equal(valid.originalSessionId, sourceSessionId);
  assert.equal(valid.absenceId, "stage-two-absence");

  client.state.attendance[0].status = "present";
  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId,
      targetSession: makeSession(targetSessionId),
      targetSessionId,
      studentId,
    }),
    /MAKEUP_ORIGINAL_ABSENCE_INVALID/,
  );
});

test("accepted makeup preserves the original absence and rejects duplicate coverage", async () => {
  const otherTargetId = "stage-two-duplicate-target";
  const client = makeClient({
    sessions: new Map([
      [sourceSessionId, makeSession(sourceSessionId)],
      [targetSessionId, makeSession(targetSessionId)],
      [otherTargetId, makeSession(otherTargetId, { session_date: "2026-10-15" })],
    ]),
  });
  const accepted = await SyncProcessor.validateMakeupAttendance(client, {
    centerId,
    sourceSessionId,
    targetSession: makeSession(targetSessionId),
    targetSessionId,
    studentId,
  });

  assert.equal(accepted.absenceId, "stage-two-absence");
  assert.equal(
    client.state.attendance.find((row) => row.id === accepted.absenceId).status,
    "absent",
  );

  client.state.attendance.push({
    id: "stage-two-recorded-makeup",
    center_id: centerId,
    session_id: targetSessionId,
    student_id: studentId,
    status: "present",
    attendance_type: "makeup",
    original_absence_id: sourceSessionId,
  });
  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId,
      targetSession: makeSession(otherTargetId, { session_date: "2026-10-15" }),
      targetSessionId: otherTargetId,
      studentId,
    }),
    /MAKEUP_ORIGINAL_ABSENCE_ALREADY_USED/,
  );
  assert.equal(
    client.state.attendance.find((row) => row.id === accepted.absenceId).status,
    "absent",
  );
});

test("makeup cannot reuse one explicit absence in a different target session", async () => {
  const otherTargetId = "stage-two-other-target";
  const client = makeClient({
    sessions: new Map([
      [sourceSessionId, makeSession(sourceSessionId)],
      [targetSessionId, makeSession(targetSessionId)],
      [otherTargetId, makeSession(otherTargetId, { session_date: "2026-10-15" })],
    ]),
    attendance: [
      {
        id: "stage-two-absence",
        center_id: centerId,
        session_id: sourceSessionId,
        student_id: studentId,
        status: "absent",
        attendance_type: "present",
      },
      {
        id: "stage-two-existing-makeup",
        center_id: centerId,
        session_id: targetSessionId,
        student_id: studentId,
        status: "present",
        attendance_type: "makeup",
        original_absence_id: sourceSessionId,
      },
    ],
  });

  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId,
      targetSession: makeSession(otherTargetId, { session_date: "2026-10-15" }),
      targetSessionId: otherTargetId,
      studentId,
    }),
    /MAKEUP_ORIGINAL_ABSENCE_ALREADY_USED/,
  );
});

test("makeup cannot duplicate a source absence through an equivalent target alias", async () => {
  const aliasedTargetId = "stage-two-legacy-target";
  const sharedGroupId = "stage-two-shared-target-group";
  const sharedScheduleId = "stage-two-shared-target-schedule";
  const targetDate = "2026-10-08";
  const client = makeClient({
    sessions: new Map([
      [sourceSessionId, makeSession(sourceSessionId)],
      [targetSessionId, makeSession(targetSessionId, {
        group_id: sharedGroupId,
        schedule_id: sharedScheduleId,
        session_date: targetDate,
      })],
      [aliasedTargetId, makeSession(aliasedTargetId, {
        group_id: sharedGroupId,
        schedule_id: sharedScheduleId,
        session_date: targetDate,
      })],
    ]),
    aliases: [{
      centerId,
      localSessionId: aliasedTargetId,
      canonicalSessionId: targetSessionId,
    }],
    attendance: [
      {
        id: "stage-two-absence",
        center_id: centerId,
        session_id: sourceSessionId,
        student_id: studentId,
        status: "absent",
        attendance_type: "present",
      },
      {
        id: "stage-two-existing-aliased-makeup",
        center_id: centerId,
        session_id: aliasedTargetId,
        student_id: studentId,
        status: "present",
        attendance_type: "makeup",
        original_absence_id: sourceSessionId,
      },
    ],
  });

  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId,
      targetSession: makeSession(targetSessionId, {
        group_id: sharedGroupId,
        schedule_id: sharedScheduleId,
        session_date: targetDate,
      }),
      targetSessionId,
      studentId,
    }),
    /MAKEUP_TARGET_ALIAS_CONFLICT/,
  );
});

test("session aliases never merge unscheduled legacy sessions by date alone", async () => {
  const firstId = "stage-two-unscheduled-a";
  const secondId = "stage-two-unscheduled-b";
  const sharedGroupId = "stage-two-unscheduled-group";
  const sharedDate = "2026-10-08";
  const client = makeClient({
    sessions: new Map([
      [firstId, makeSession(firstId, {
        group_id: sharedGroupId,
        schedule_id: null,
        session_date: sharedDate,
      })],
      [secondId, makeSession(secondId, {
        group_id: sharedGroupId,
        schedule_id: null,
        session_date: sharedDate,
      })],
    ]),
    aliases: [{
      centerId,
      localSessionId: firstId,
      canonicalSessionId: secondId,
    }],
  });

  assert.equal(
    await SyncProcessor.resolveSessionAlias(client, centerId, firstId),
    null,
  );
});

test("makeup refuses a source session owned by another center", async () => {
  const foreignSource = "stage-two-foreign-source";
  const client = makeClient({
    sessions: new Map([
      [foreignSource, makeSession(foreignSource, { center_id: "another-center" })],
      [targetSessionId, makeSession(targetSessionId)],
    ]),
  });

  await assert.rejects(
    SyncProcessor.validateMakeupAttendance(client, {
      centerId,
      sourceSessionId: foreignSource,
      targetSession: makeSession(targetSessionId),
      targetSessionId,
      studentId,
    }),
    /MAKEUP_ORIGINAL_ABSENCE_CENTER_MISMATCH/,
  );
});

test("advance coverage retries missing sessions and rejects cross-center students", async () => {
  const noTarget = makeClient({
    sessions: new Map([[sourceSessionId, makeSession(sourceSessionId)]]),
  });
  await assert.rejects(
    SyncProcessor.validateAdvanceCoverage(noTarget, {
      centerId,
      coverage: {
        id: "stage-two-coverage",
        studentId,
        advanceSessionId: sourceSessionId,
        targetFutureSessionId: targetSessionId,
      },
    }),
    /ADVANCE_COVERAGE_SESSION_NOT_FOUND/,
  );

  const foreignStudent = makeClient({
    students: new Map([
      [studentId, { id: studentId, center_id: "another-center", deleted_at: null }],
    ]),
  });
  await assert.rejects(
    SyncProcessor.validateAdvanceCoverage(foreignStudent, {
      centerId,
      coverage: {
        id: "stage-two-coverage",
        studentId,
        advanceSessionId: sourceSessionId,
        targetFutureSessionId: targetSessionId,
      },
    }),
    /ADVANCE_COVERAGE_STUDENT_CENTER_MISMATCH/,
  );
});

test("advance coverage accepts a scheduled target but rejects closed or cancelled targets", async () => {
  const scheduledTarget = makeSession(targetSessionId, { status: "scheduled" });
  const validClient = makeClient({
    sessions: new Map([
      [sourceSessionId, makeSession(sourceSessionId)],
      [targetSessionId, scheduledTarget],
    ]),
  });
  const validCoverage = await SyncProcessor.validateAdvanceCoverage(validClient, {
    centerId,
    coverage: {
      id: "scheduled-target-coverage",
      studentId,
      advanceSessionId: sourceSessionId,
      targetFutureSessionId: targetSessionId,
    },
  });
  assert.deepEqual(validCoverage, {
    id: "scheduled-target-coverage",
    studentId,
    advanceSessionId: sourceSessionId,
    targetSessionId,
  });

  for (const status of ["closed", "cancelled"]) {
    const client = makeClient({
      sessions: new Map([
        [sourceSessionId, makeSession(sourceSessionId)],
        [targetSessionId, makeSession(targetSessionId, { status })],
      ]),
    });
    await assert.rejects(
      SyncProcessor.validateAdvanceCoverage(client, {
        centerId,
        coverage: {
          id: `invalid-${status}-target-coverage`,
          studentId,
          advanceSessionId: sourceSessionId,
          targetFutureSessionId: targetSessionId,
        },
      }),
      /ADVANCE_COVERAGE_TARGET_INVALID/,
    );
  }
});

test("advance coverage does not allow an existing ID to change its session references", async () => {
  const client = makeClient({
    coverages: [
      {
        id: "stage-two-coverage",
        center_id: centerId,
        student_id: studentId,
        advance_session_id: sourceSessionId,
        target_future_session_id: targetSessionId,
      },
    ],
  });
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      client,
      mutationContext("advance_coverage", {
        id: "stage-two-coverage",
        studentId,
        advanceSessionId: sourceSessionId,
        targetFutureSessionId: "different-target",
      }),
    ),
    /ADVANCE_COVERAGE_ID_CONFLICT/,
  );
  assert.equal(
    client.state.statements.some(({ sql }) => /\bUPDATE\s+advance_coverages\b/i.test(sql)),
    false,
  );
});

test("absence notification creation rejects a stale report after attendance becomes present", async () => {
  const client = makeClient();
  client.state.attendance[0].status = "present";
  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      client,
      mutationContext(
        "notification_event",
        {
          eventId: "stage-two-notification",
          eventType: "absence",
          studentId,
          sessionId: sourceSessionId,
        },
        { entityId: "stage-two-notification" },
      ),
    ),
    /ABSENCE_NOTIFICATION_NO_LONGER_ABSENT/,
  );
  assert.equal(
    client.state.statements.some(({ sql }) => sql.includes("INSERT INTO notification_events")),
    false,
  );
});

test("absence delivery revalidates attendance immediately before queuing or sending", async () => {
  const client = makeClient({
    notificationEvents: new Map([
      [
        "stage-two-notification",
        {
          id: "stage-two-notification",
          event_type: "absence",
          student_id: studentId,
          session_id: sourceSessionId,
        },
      ],
    ]),
  });
  client.state.attendance[0].status = "present";

  await assert.rejects(
    SyncProcessor.applyDomainMutation(
      client,
      mutationContext(
        "notification_delivery",
        {
          delivery: {
            id: "stage-two-delivery",
            notificationEventId: "stage-two-notification",
            channel: "push",
            status: "pending",
          },
        },
        { entityId: "stage-two-delivery" },
      ),
    ),
    /ABSENCE_NOTIFICATION_NO_LONGER_ABSENT/,
  );
  assert.equal(
    client.state.statements.some(({ sql }) => sql.includes("INSERT INTO notification_deliveries")),
    false,
  );
});

test("absence notification dependency remains retryable when attendance has not arrived", async () => {
  const client = makeClient({ attendance: [] });
  await assert.rejects(
    SyncProcessor.validateExplicitAbsenceForNotification(client, {
      centerId,
      sessionId: sourceSessionId,
      studentId,
    }),
    /ABSENCE_NOTIFICATION_TARGET_NOT_FOUND/,
  );
});
