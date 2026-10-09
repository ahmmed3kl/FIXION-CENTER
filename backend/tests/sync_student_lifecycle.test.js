const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");

const centerId = "lifecycle-center";
const studentId = "lifecycle-student";

test("a replayed student create preserves an existing archive and does not recreate its card", async () => {
  const statements = [];
  const deletedAt = "2026-10-01T00:00:00.000Z";
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM students WHERE id = $1")) {
        return {
          rows: [{
            center_id: centerId,
            student_code: "99101",
            card_code: "99202",
            status: "active",
            deleted_at: deletedAt,
            deleted_by: "archive-actor",
          }],
        };
      }
      if (sql.includes("FROM students") && sql.includes("student_code = $2")) return { rows: [] };
      if (sql.includes("UNION")) return { rows: [] };
      if (sql.includes("INSERT INTO students")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await SyncProcessor.applyDomainMutation(client, {
    centerId,
    userId: "replay-user",
    operationId: "old-create-operation",
    operationType: "CREATE",
    entityType: "student",
    entityId: studentId,
    payload: {
      id: studentId,
      student: {
        id: studentId,
        student_code: "99101",
        card_code: "99101",
        status: "active",
        deleted_at: null,
        deleted_by: null,
      },
      card: { id: `card-${studentId}`, card_code: "99101" },
    },
  });

  const studentWrite = statements.find(({ sql }) => sql.includes("INSERT INTO students"));
  assert.equal(studentWrite.params[4], "99202");
  assert.equal(studentWrite.params[11], deletedAt);
  assert.equal(studentWrite.params[12], "archive-actor");
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO student_cards")), false);
});

test("a card activation for an archived student is rejected on the server", async () => {
  let queryCount = 0;
  const client = {
    async query(sql) {
      queryCount += 1;
      assert.match(sql, /FROM students/);
      return { rows: [{ id: studentId, deleted_at: "2026-10-01T00:00:00.000Z" }] };
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      userId: "replay-user",
      operationId: "old-card-activation",
      operationType: "UPDATE",
      entityType: "student_card",
      entityId: "lifecycle-card",
      payload: { id: "lifecycle-card", studentId, cardCode: "99101", status: "active" },
    }),
    (error) => error.code === "STUDENT_ARCHIVED",
  );
  assert.equal(queryCount, 1);
});

test("student and card sync mutations cannot target an identity from another center", async () => {
  let queryCount = 0;
  const client = {
    async query(sql) {
      queryCount += 1;
      if (sql.includes("FROM students") && sql.includes("WHERE id = $1 AND center_id = $2")) {
        return { rows: [] };
      }
      if (sql.includes("FROM students")) {
        return { rows: [{ center_id: "different-center", deleted_at: null }] };
      }
      if (sql.includes("FROM card_ranges")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      userId: "foreign-user",
      operationId: "foreign-student-mutation",
      operationType: "CREATE",
      entityType: "student",
      entityId: studentId,
      payload: { id: studentId, student: { id: studentId, student_code: "99101" } },
    }),
    (error) => error.code === "STUDENT_BELONGS_TO_OTHER_CENTER",
  );
  assert.equal(queryCount, 1);

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      userId: "foreign-user",
      operationId: "foreign-card-mutation",
      operationType: "CREATE",
      entityType: "student_card",
      entityId: "foreign-card",
      payload: { id: "foreign-card", studentId, cardCode: "99101", status: "active" },
    }),
    /Student card owner is outside the authenticated center/,
  );
  assert.equal(queryCount, 2);
});
