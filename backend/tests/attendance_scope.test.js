const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");

const centerId = "attendance-scope-center";
const sessionId = "attendance-scope-session";
const studentId = "attendance-scope-student";
const operationId = "attendance-scope-operation";

function makeClient({
  sessionExists = true,
  expected = false,
  hasSnapshot = false,
  hasEnrollment = false,
  hasLegacyCompensationEnrollment = false,
  hasSameLevelCompensationEnrollment = false,
  packageEligible = false,
} = {}) {
  const statements = [];
  let inserted = false;
  return {
    statements,
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM sessions s") && sql.includes("WHERE s.center_id = $1::varchar")) {
        return {
          rows: sessionExists
            ? [{
                session_date: "2026-10-11",
                group_id: "attendance-scope-group",
                validated_group_id: "attendance-scope-group",
                subject_id: "attendance-scope-subject",
                teacher_id: "attendance-scope-teacher",
                group_subject_id: "attendance-scope-subject",
                group_teacher_id: "attendance-scope-teacher",
                group_grade: "الصف الثالث الثانوي",
              }]
            : [],
        };
      }
      if (sql.includes("SELECT center_id FROM sessions WHERE id = $1::varchar")) {
        return { rows: sessionExists ? [{ center_id: centerId }] : [] };
      }
      if (sql.includes("WITH RECURSIVE session_ids(session_id)")) {
        return { rows: [{ session_id: sessionId }] };
      }
      if (sql.includes("FROM attendance a") && sql.includes("FOR UPDATE OF a")) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM attendance") &&
        sql.includes("session_id = ANY($2::varchar[])") &&
        sql.includes("student_id = $3")
      ) {
        return {
          rows: [{
            id: "attendance-scope-source-absence",
            session_id: "source-session",
            status: "absent",
            attendance_type: "present",
          }],
        };
      }
      if (
        sql.includes("FROM attendance") &&
        sql.includes("attendance_type = 'makeup'") &&
        sql.includes("original_absence_id = ANY")
      ) {
        return { rows: [] };
      }
      if (sql.includes("FROM session_id_aliases aliases")) {
        return { rows: [] };
      }
      if (sql.includes("FROM session_id_aliases") && sql.includes("canonical_session_id = $2")) {
        return { rows: [] };
      }
      if (sql.includes("FROM advance_coverages")) {
        return { rows: [] };
      }
      if (sql.includes("FROM students") && sql.includes("deleted_at IS NULL")) {
        return { rows: [{ center_id: centerId }] };
      }
      if (sql.includes("SELECT center_id FROM students WHERE id = $1::varchar")) {
        return { rows: [{ center_id: centerId }] };
      }
      if (
        sql.includes("FROM session_expected_students") &&
        sql.includes("student_id = $3") &&
        !sql.includes("FROM student_group_enrollments e")
      ) {
        return { rows: expected ? [{ "?column?": 1 }] : [] };
      }
      if (
        sql.includes("FROM session_expected_students") &&
        !sql.includes("FROM student_group_enrollments e")
      ) {
        return { rows: hasSnapshot ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("JOIN groups enrolled_group")) {
        return {
          rows: hasSameLevelCompensationEnrollment
            ? [{ "?column?": 1 }]
            : [],
        };
      }
      if (sql.includes("FROM student_group_enrollments e")) {
        return {
          rows: hasEnrollment && !hasLegacyCompensationEnrollment
            ? [{ "?column?": 1 }]
            : [],
        };
      }
      if (sql.includes("FROM student_group_enrollments")) {
        return { rows: hasEnrollment ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("FROM student_package_subscriptions")) {
        return { rows: packageEligible ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("SELECT id, operation_id, status, attendance_type") && sql.includes("FROM attendance")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO attendance")) {
        inserted = true;
        return { rows: [] };
      }
      if (sql.includes("SELECT operation_id FROM attendance")) {
        return { rows: inserted ? [{ operation_id: operationId }] : [] };
      }
      if (sql.includes("FROM attendance") && sql.includes("WHERE center_id = $1 AND id = $2")) {
        return { rows: inserted ? [{ id: "attendance-scope-row" }] : [] };
      }
      if (sql.includes("FROM sessions s") && sql.includes("FOR UPDATE OF s")) {
        const requestedSessionId = params[1];
        const isSourceSession = requestedSessionId === "source-session";
        return {
          rows: [{
            id: requestedSessionId,
            group_id: "attendance-scope-group",
            session_date: isSourceSession ? "2026-10-10" : "2026-10-11",
            start_time: isSourceSession ? "09:00" : "10:00",
            status: "open",
            validated_group_id: "attendance-scope-group",
            subject_id: "attendance-scope-subject",
            teacher_id: "attendance-scope-teacher",
            group_subject_id: "attendance-scope-subject",
            group_teacher_id: "attendance-scope-teacher",
            group_grade: "الصف الثالث الثانوي",
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function mutation(client, overrides = {}) {
  return SyncProcessor.applyDomainMutation(client, {
    centerId,
    userId: "attendance-scope-user",
    operationId,
    operationType: "CREATE",
    entityType: "attendance",
    entityId: "attendance-scope-row",
    payload: {
      id: "attendance-scope-row",
      centerId,
      sessionId,
      studentId,
      status: "present",
      attendanceType: "present",
      checkInTime: "2026-10-11T15:00:00.000Z",
      ...overrides,
    },
  });
}

test("normal attendance is rejected when the student is outside the session roster", async () => {
  const client = makeClient();

  await assert.rejects(
    mutation(client),
    /ATTENDANCE_NOT_EXPECTED/,
  );
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    false,
  );
});

test("normal attendance is accepted for an enrolled student in the server session roster", async () => {
  const client = makeClient({ expected: true, hasEnrollment: true });

  await mutation(client);
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    true,
  );
});

test("legacy sessions without a roster snapshot retain date-valid enrollment eligibility", async () => {
  const client = makeClient({ hasEnrollment: true });

  await mutation(client);
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    true,
  );
});

test("migration-created membership copied from a compensation roster is not normal eligibility", async () => {
  const client = makeClient({
    hasEnrollment: true,
    hasLegacyCompensationEnrollment: true,
  });
  const eligible = await SyncProcessor.isStudentEligibleForSessionGroup(client, {
    centerId,
    groupId: "attendance-scope-group",
    sessionDate: "2026-10-11",
    subjectId: "attendance-scope-subject",
    teacherId: "attendance-scope-teacher",
    groupGrade: "الصف الثالث الثانوي",
    studentId,
  });

  assert.equal(eligible, false);
});

test("legacy package students remain eligible when no roster snapshot exists", async () => {
  const client = makeClient({ packageEligible: true });

  await mutation(client);
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    true,
  );
});

test("makeup attendance retains its existing cross-group exception", async () => {
  const client = makeClient();

  await mutation(client, {
    attendanceType: "makeup",
    originalAbsenceId: "source-session",
  });
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("FROM session_expected_students")),
    false,
  );
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    true,
  );
});

test("attendance cannot target a student outside the authenticated center", async () => {
  const client = makeClient({ sessionExists: false, expected: true });

  await assert.rejects(
    mutation(client),
    /ATTENDANCE_SESSION_NOT_FOUND/,
  );
  assert.equal(
    client.statements.some(({ sql }) => sql.includes("INSERT INTO attendance")),
    false,
  );
});

test("same-teacher compensation is eligible only within the active group's level", async () => {
  const sameLevelClient = makeClient({
    hasSameLevelCompensationEnrollment: true,
  });
  const eligible = await SyncProcessor.isStudentEligibleForSessionGroup(
    sameLevelClient,
    {
      centerId,
      groupId: "attendance-scope-group",
      sessionDate: "2026-10-11",
      subjectId: "attendance-scope-subject",
      teacherId: "attendance-scope-teacher",
      groupGrade: "الصف الثالث الثانوي",
      studentId,
      allowSameTeacherCompensation: true,
    },
  );
  assert.equal(eligible, true);

  const otherLevelClient = makeClient();
  const ineligible = await SyncProcessor.isStudentEligibleForSessionGroup(
    otherLevelClient,
    {
      centerId,
      groupId: "attendance-scope-group",
      sessionDate: "2026-10-11",
      subjectId: "attendance-scope-subject",
      teacherId: "attendance-scope-teacher",
      groupGrade: "الصف الثالث الثانوي",
      studentId,
      allowSameTeacherCompensation: true,
    },
  );
  assert.equal(ineligible, false);
});

test("same-teacher compensation cannot be added to a session's expected roster", async () => {
  const client = makeClient({
    hasSameLevelCompensationEnrollment: true,
  });
  const expectedForGroup = await SyncProcessor.isStudentEligibleForSessionGroup(
    client,
    {
      centerId,
      groupId: "attendance-scope-group",
      sessionDate: "2026-10-11",
      subjectId: "attendance-scope-subject",
      teacherId: "attendance-scope-teacher",
      groupGrade: "الصف الثالث الثانوي",
      studentId,
    },
  );
  assert.equal(expectedForGroup, false);
});
