const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");

const centerId = "absence-note-center";
const sessionId = "absence-note-session";
const studentId = "absence-note-student";

function makeClient({
  sessionExists = true,
  attendanceRows = [],
  advanceCoverage = false,
} = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM sessions s")) {
        return {
          rows: sessionExists ? [{ id: sessionId, status: "closed" }] : [],
        };
      }
      if (sql.includes("FROM attendance")) return { rows: attendanceRows };
      if (sql.includes("FROM advance_coverages")) {
        return { rows: advanceCoverage ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("INSERT INTO absence_notes")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function mutation(client, overrides = {}) {
  return SyncProcessor.applyDomainMutation(client, {
    centerId,
    userId: "absence-note-user",
    operationId: "absence-note-operation",
    operationType: "UPDATE",
    entityType: "absence_note",
    entityId: "absence-note-row",
    payload: {
      id: "absence-note-row",
      centerId: "untrusted-payload-center",
      sessionId,
      studentId,
      text: "ظرف عائلي",
      createdBy: "absence-note-user",
      ...overrides,
    },
  });
}

test("absence notes are upserted under the authenticated center and session/student key", async () => {
  const client = makeClient();

  await mutation(client);

  const upsert = client.statements.find(({ sql }) => sql.includes("INSERT INTO absence_notes"));
  assert.ok(upsert, "the validated note is inserted");
  assert.equal(upsert.params[1], centerId, "the authenticated center overrides payload center");
  assert.equal(upsert.params[2], sessionId);
  assert.equal(upsert.params[3], studentId);
  assert.equal(upsert.params[4], "ظرف عائلي");
  assert.match(upsert.sql, /ON CONFLICT \(center_id, session_id, student_id\)/);
});

test("absence notes reject out-of-center targets, present attendance, and advance coverage", async () => {
  const missingSession = makeClient({ sessionExists: false });
  await assert.rejects(mutation(missingSession), /ABSENCE_NOTE_TARGET_NOT_FOUND/);
  assert.equal(
    missingSession.statements.some(({ sql }) => sql.includes("INSERT INTO absence_notes")),
    false,
  );

  const present = makeClient({ attendanceRows: [{ status: "present", attendance_type: "present" }] });
  await assert.rejects(mutation(present), /ABSENCE_NOTE_STUDENT_PRESENT/);
  assert.equal(
    present.statements.some(({ sql }) => sql.includes("INSERT INTO absence_notes")),
    false,
  );

  const advanced = makeClient({ advanceCoverage: true });
  await assert.rejects(mutation(advanced), /ABSENCE_NOTE_ADVANCE_COVERAGE/);
  assert.equal(
    advanced.statements.some(({ sql }) => sql.includes("INSERT INTO absence_notes")),
    false,
  );
});
