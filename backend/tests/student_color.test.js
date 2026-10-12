const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");
const {
  assertSyncPermission,
  canReadSyncEntity,
  requiredPermission,
} = require("../src/services/syncPermissionPolicy");

const centerId = "student-color-center";
const studentId = "student-color-student";

function makeClient({ ownerExists = true, deletedAt = null } = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("SELECT id, deleted_at FROM students")) {
        return { rows: ownerExists ? [{ id: studentId, deleted_at: deletedAt }] : [] };
      }
      if (sql.includes("UPDATE students SET student_color")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function mutation(client, studentColor, action = "student.color.update") {
  return SyncProcessor.applyDomainMutation(client, {
    centerId,
    operationType: "UPDATE",
    entityType: "student_color",
    entityId: studentId,
    payload: {
      centerId: "untrusted-center",
      studentId,
      studentColor,
      action,
    },
  });
}

test("student color sync updates only the authenticated center's student color", async () => {
  const client = makeClient();
  await mutation(client, "lavender");
  const update = client.statements.find(({ sql }) => sql.includes("UPDATE students SET student_color"));
  assert.ok(update);
  assert.deepEqual(update.params, ["lavender", centerId, studentId]);
  assert.doesNotMatch(update.sql, /full_name|grade|group|attendance/i);

  const resetClient = makeClient();
  await mutation(resetClient, null, "student.color.reset");
  assert.deepEqual(
    resetClient.statements.find(({ sql }) => sql.includes("UPDATE students SET student_color")).params,
    [null, centerId, studentId],
  );
});

test("student color sync rejects invalid colors, missing students, and archived students", async () => {
  const invalid = makeClient();
  await assert.rejects(
    mutation(invalid, "#ff00ff"),
    (error) => error.code === "INVALID_STUDENT_COLOR",
  );
  assert.equal(invalid.statements.some(({ sql }) => sql.includes("UPDATE students SET student_color")), false);

  await assert.rejects(
    mutation(makeClient({ ownerExists: false }), "lavender"),
    (error) => error.code === "STUDENT_NOT_FOUND",
  );
  await assert.rejects(
    mutation(makeClient({ deletedAt: "2026-10-01T00:00:00Z" }), "lavender"),
    (error) => error.code === "STUDENT_ARCHIVED",
  );
});

test("student color sync uses students.update permission and remains readable with student data", () => {
  const operation = { entityType: "student_color", operationType: "UPDATE", payload: { studentColor: "lavender" } };
  assert.equal(requiredPermission(operation), "students.update");
  assert.throws(
    () => assertSyncPermission({ user: { role: "assistant", permissions: [] } }, operation),
    /Missing required permission: students.update/,
  );
  assert.doesNotThrow(() =>
    assertSyncPermission({ user: { role: "assistant", permissions: ["students.update"] } }, operation),
  );
  assert.equal(canReadSyncEntity("student_color", { role: "assistant", permissions: ["students.view"] }), true);
});
