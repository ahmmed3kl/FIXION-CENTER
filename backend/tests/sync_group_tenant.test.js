const assert = require("node:assert/strict");
const SyncProcessor = require("../src/services/SyncProcessor");

async function verifyGroupUpdateCannotCrossCenters() {
  const centerId = "center-authenticated";
  const conflictingGroupId = "group-owned-by-another-center";
  let insertQuery = "";
  const client = {
    async query(sql, params) {
      if (sql.includes("SELECT name, teacher_id, subject_id")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO groups")) {
        insertQuery = sql;
        assert.equal(params[0], conflictingGroupId);
        assert.equal(params[1], centerId);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      operationId: "op-group-update-tenant-test",
      operationType: "UPDATE",
      entityType: "group",
      entityId: conflictingGroupId,
      payload: {
        id: conflictingGroupId,
        name: "must-not-overwrite",
        teacherId: "teacher-1",
        subjectId: "subject-1",
        grade: "grade-1",
      },
    }),
    (error) => error.code === "GROUP_BELONGS_TO_OTHER_CENTER",
  );
  assert.match(insertQuery, /WHERE groups\.center_id = EXCLUDED\.center_id/i);
}

verifyGroupUpdateCannotCrossCenters()
  .then(() => console.log("PASS group update is scoped to the authenticated center"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
