const assert = require("node:assert/strict");
const test = require("node:test");
const SyncProcessor = require("../src/services/SyncProcessor");

const centerId = "alias-test-center";
const aliasId = "local-cycle-id";
const canonicalId = "server-cycle-id";
const studentId = "alias-test-student";
const enrollmentId = "alias-test-enrollment";

function makeCyclePayload(id = aliasId) {
  return {
    id,
    studentId,
    enrollmentId,
    cycleNumber: 3,
    cycleType: "monthly",
    billingMode: "monthly",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    cyclePrice: 500,
    status: "open",
  };
}

test("reset repair maps a duplicate local debt-cycle id to the existing canonical cycle", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM students")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM student_group_enrollments")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM debt_cycles") && sql.includes("COALESCE(enrollment_id")) {
        return { rows: [{ id: canonicalId, student_id: studentId }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const context = {
    centerId,
    userId: "alias-test-user",
    operationId: "alias-test-operation",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    entityType: "debt_cycle",
    entityId: aliasId,
    payload: makeCyclePayload(),
  };

  await SyncProcessor.applyDomainMutation(client, context);

  assert.equal(context.canonicalEntityId, canonicalId);
  assert.equal(context.aliasedDebtCycleId, aliasId);
  assert.equal(context.payload.id, canonicalId);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO debt_cycles")), false);
});

test("a duplicate debt-cycle create is not silently treated as a reset repair", async () => {
  const client = {
    async query(sql) {
      if (sql.includes("FROM students")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM student_group_enrollments")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM debt_cycles") && sql.includes("COALESCE(enrollment_id")) {
        return { rows: [{ id: canonicalId, student_id: studentId }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    SyncProcessor.applyDomainMutation(client, {
      centerId,
      userId: "alias-test-user",
      operationId: "alias-test-create",
      operationType: "debt_cycle.create",
      entityType: "debt_cycle",
      entityId: aliasId,
      payload: makeCyclePayload(),
    }),
    /DEBT_CYCLE_NATURAL_KEY_CONFLICT/,
  );
});

test("an explicit pending billing mode wins over a legacy per-session cycle type", async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM students")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM student_group_enrollments")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM debt_cycles") && sql.includes("COALESCE(enrollment_id")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO debt_cycles")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await SyncProcessor.applyDomainMutation(client, {
    centerId,
    userId: "alias-test-user",
    operationId: "alias-test-pending-cycle",
    operationType: "debt_cycle.create",
    entityType: "debt_cycle",
    entityId: aliasId,
    payload: {
      ...makeCyclePayload(),
      cycleType: "per_session",
      billingMode: "pending",
    },
  });

  const insert = statements.find(({ sql }) => sql.includes("INSERT INTO debt_cycles"));
  assert.ok(insert);
  assert.equal(insert.params[8], "per_session");
  assert.equal(insert.params[9], "pending");
});

test("payment alias resolution returns only a canonical id recorded for this center", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM debt_cycles")) return { rows: [] };
      if (sql.includes("FROM server_sync_operations")) {
        return { rows: [{ canonical_id: canonicalId }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  assert.equal(
    await SyncProcessor.resolveDebtCycleAlias(client, centerId, aliasId),
    canonicalId,
  );
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].params, [centerId, aliasId]);
});

test("a per-session payment push preserves its billing type and linked debt cycle", async () => {
  const statements = [];
  const paymentId = "session-payment-id";
  const paymentOperationId = "session-payment-operation";
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("SELECT 1 FROM debt_cycles")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("SELECT status, amount_due, enrollment_id, package_subscription_id")) {
        return {
          rows: [{
            status: "open",
            amount_due: 300,
            enrollment_id: enrollmentId,
            package_subscription_id: null,
          }],
        };
      }
      if (sql.includes("INSERT INTO payments")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await SyncProcessor.applyDomainMutation(client, {
    centerId,
    userId: "alias-test-user",
    operationId: paymentOperationId,
    operationType: "payment.create",
    entityType: "payment",
    entityId: paymentId,
    payload: {
      id: paymentId,
      studentId,
      debtCycleId: canonicalId,
      amount: 125,
      paymentType: "session",
      paymentMethod: "cash",
      paymentDate: "2026-10-15",
    },
  });

  const insert = statements.find(({ sql }) => sql.includes("INSERT INTO payments"));
  assert.ok(insert);
  assert.equal(insert.params[1], paymentOperationId);
  assert.equal(insert.params[4], canonicalId);
  assert.equal(insert.params[7], 125);
  assert.equal(insert.params[9], "session");
});

test("unknown debt-cycle ids are not converted to an unrelated cycle", async () => {
  const client = {
    async query() {
      return { rows: [] };
    },
  };

  assert.equal(
    await SyncProcessor.resolveDebtCycleAlias(client, centerId, "unknown-cycle"),
    null,
  );
});
