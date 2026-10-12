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
  hasSameLevelCompensationEnrollment = false,
  packageEligible = false,
} = {}) {
  const statements = [];
  let inserted = false;
  return {
    statements,
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM sessions s") && sql.includes("JOIN students st")) {
        return {
          rows: sessionExists
            ? [{
                session_date: "2026-10-11",
                group_id: "attendance-scope-group",
                subject_id: "attendance-scope-subject",
                teacher_id: "attendance-scope-teacher",
                group_subject_id: "attendance-scope-subject",
                group_teacher_id: "attendance-scope-teacher",
                group_grade: "الصف الثالث الثانوي",
              }]
            : [],
        };
      }
      if (
        sql.includes("FROM session_expected_students") &&
        sql.includes("student_id = $3")
      ) {
        return { rows: expected ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("FROM session_expected_students")) {
        return { rows: hasSnapshot ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("JOIN groups enrolled_group")) {
        return {
          rows: hasSameLevelCompensationEnrollment
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
      if (sql.includes("INSERT INTO attendance")) {
        inserted = true;
        return { rows: [] };
      }
      if (sql.includes("SELECT operation_id FROM attendance")) {
        return { rows: inserted ? [{ operation_id: operationId }] : [] };
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
    /ATTENDANCE_TARGET_NOT_FOUND/,
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
