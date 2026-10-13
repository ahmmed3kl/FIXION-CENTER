const assert = require("node:assert/strict");
const SyncProcessor = require("../src/services/SyncProcessor");

function makeClient() {
  const calls = [];
  const state = {
    deleted: false,
    groupStatus: "active",
    enrollments: [
      { id: "enrollment-1", center_id: "center-1", group_id: "group-1", status: "active" },
    ],
    cycles: [
      {
        id: "cycle-1",
        center_id: "center-1",
        enrollment_id: "enrollment-1",
        group_id: "group-1",
        cycle_type: "monthly",
        package_subscription_id: null,
        status: "pending",
        amount_due: 100,
      },
      {
        id: "cycle-other",
        center_id: "center-1",
        enrollment_id: "enrollment-other",
        group_id: "group-2",
        cycle_type: "monthly",
        package_subscription_id: null,
        status: "pending",
        amount_due: 90,
      },
      {
        id: "cycle-package",
        center_id: "center-1",
        enrollment_id: null,
        group_id: "group-1",
        cycle_type: "package",
        package_subscription_id: "package-subscription-1",
        status: "pending",
        amount_due: 250,
      },
    ],
    payments: [
      { id: "payment-1", debt_cycle_id: "cycle-1", amount: 40, is_reversed: false },
    ],
    schedules: [{ id: "schedule-1", center_id: "center-1", group_id: "group-1", day_of_week: 1 }],
    sessions: [
      { id: "future-session", group_id: "group-1", status: "scheduled" },
      { id: "historical-session", group_id: "group-1", status: "closed" },
    ],
    attendance: [{ id: "attendance-1", session_id: "historical-session" }],
  };

  const client = {
    calls,
    state,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*SELECT id FROM student_group_enrollments/.test(sql)) {
        const groupId = params[1];
        return {
          rows: state.enrollments
            .filter((row) => row.center_id === params[0] && row.group_id === groupId && row.status === "active")
            .map((row) => ({ id: row.id })),
        };
      }
      if (/SELECT id FROM debt_cycles/.test(sql)) {
        const groupId = params[1];
        const enrollmentIds = new Set(
          state.enrollments
            .filter((row) => row.center_id === params[0] && row.group_id === groupId)
            .map((row) => row.id),
        );
        return {
          rows: state.cycles
            .filter((cycle) =>
              cycle.center_id === params[0] &&
              ["pending", "partially_paid"].includes(cycle.status) &&
              cycle.cycle_type !== "package" &&
              cycle.package_subscription_id == null &&
              (cycle.group_id === groupId || enrollmentIds.has(cycle.enrollment_id)),
            )
            .map((cycle) => ({ id: cycle.id })),
        };
      }
      if (/SELECT COALESCE\(SUM\(amount\), 0\)::numeric AS amount/.test(sql)) {
        const amount = state.payments
          .filter((payment) => payment.debt_cycle_id === params[1] && !payment.is_reversed)
          .reduce((sum, payment) => sum + payment.amount, 0);
        return { rows: [{ amount: String(amount) }] };
      }
      if (/SELECT 1 AS deleted FROM server_sync_operations/.test(sql)) {
        return { rows: state.deleted ? [{ deleted: true }] : [] };
      }
      if (/SELECT name, teacher_id/.test(sql)) {
        return { rows: [{ name: "Group", teacher_id: "teacher-1" }] };
      }
      if (/UPDATE group_schedules/.test(sql)) {
        assert.fail("group_schedules has no status or updated_at columns in the PostgreSQL schema");
      }
      if (/UPDATE student_group_enrollments/.test(sql)) {
        const enrollment = state.enrollments.find((row) => row.id === params[1]);
        if (enrollment) enrollment.status = "withdrawn";
        return { rowCount: enrollment ? 1 : 0, rows: [] };
      }
      if (/UPDATE debt_cycles/.test(sql)) {
        const cycle = state.cycles.find((row) => row.id === params[1]);
        if (cycle) {
          cycle.amount_due = Number(params[2]);
          cycle.status = "cancelled";
        }
        return { rowCount: cycle ? 1 : 0, rows: [] };
      }
      if (/UPDATE sessions/.test(sql)) {
        const session = state.sessions.find((row) => row.id === "future-session");
        if (session) session.status = "cancelled";
        return { rowCount: session ? 1 : 0, rows: [] };
      }
      if (/UPDATE groups SET status = 'archived'/.test(sql)) {
        state.groupStatus = "archived";
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO groups/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in group deletion test: ${sql}`);
    },
  };
  return client;
}

async function run() {
  const client = makeClient();
  const deletion = {
    centerId: "center-1",
    entityId: "group-1",
    entityType: "group",
    operationType: "DELETE",
    payload: { id: "group-1" },
  };

  await SyncProcessor.applyDomainMutation(client, deletion);

  const cycleLookup = client.calls.find(({ sql }) => /SELECT id FROM debt_cycles/.test(sql));
  assert.ok(cycleLookup, "group removal selects its own active cycles");
  assert.match(cycleLookup.sql, /package_subscription_id IS NULL/);
  assert.match(cycleLookup.sql, /cycle_type <> 'package'/);
  assert.match(cycleLookup.sql, /enrollment_id IN/);
  const cycleUpdate = client.calls.find(({ sql }) => /UPDATE debt_cycles/.test(sql));
  assert.ok(
    cycleUpdate,
    `unpaid group debt is cancelled; statements: ${client.calls.map(({ sql }) => sql).join(" | ")}`,
  );
  assert.deepEqual(cycleUpdate.params, ["center-1", "cycle-1", 40]);
  assert.deepEqual(
    client.calls.filter(({ sql }) => /UPDATE group_schedules/.test(sql)),
    [],
    "deletion does not refer to non-existent schedule status or updated_at columns",
  );
  assert.equal(
    client.calls.some(({ sql }) => /student_subscriptions/.test(sql)),
    false,
    "the server schema has no legacy student_subscriptions table; obligations are debt_cycles",
  );
  assert.equal(client.state.groupStatus, "archived");
  assert.equal(client.state.enrollments[0].status, "withdrawn");
  assert.equal(client.state.cycles.find((cycle) => cycle.id === "cycle-1").amount_due, 40);
  assert.equal(client.state.cycles.find((cycle) => cycle.id === "cycle-other").status, "pending");
  assert.equal(client.state.cycles.find((cycle) => cycle.id === "cycle-package").status, "pending");
  assert.equal(client.state.payments[0].amount, 40);
  assert.equal(client.state.sessions.find((session) => session.id === "future-session").status, "cancelled");
  assert.equal(client.state.sessions.find((session) => session.id === "historical-session").status, "closed");
  assert.equal(client.state.attendance.length, 1);
  assert.equal(client.state.schedules.length, 1);
  assert.equal(
    client.calls.some(({ sql }) => /DELETE FROM (groups|sessions|attendance|payments|group_schedules)/.test(sql)),
    false,
    "group removal preserves all financial and attendance history",
  );

  const completedCycles = client.state.cycles.filter((cycle) => cycle.status === "cancelled").length;
  const completedPayments = JSON.stringify(client.state.payments);
  await SyncProcessor.applyDomainMutation(client, deletion);
  assert.equal(
    client.state.cycles.filter((cycle) => cycle.status === "cancelled").length,
    completedCycles,
    "retrying the same deletion does not repeat cycle cancellation",
  );
  assert.equal(JSON.stringify(client.state.payments), completedPayments, "retry preserves cash ledger entries");

  client.state.deleted = true;
  const callsBeforeStaleUpdate = client.calls.length;
  await SyncProcessor.applyDomainMutation(client, {
    ...deletion,
    operationType: "UPDATE",
    payload: { id: "group-1", status: "active", name: "Stale active group" },
  });
  const staleUpdateCalls = client.calls.slice(callsBeforeStaleUpdate);
  assert.equal(
    staleUpdateCalls.some(({ sql }) => /INSERT INTO groups/.test(sql)),
    false,
    "later stale updates do not recreate a deleted group",
  );
  assert.equal(
    staleUpdateCalls.some(({ sql }) => /UPDATE debt_cycles/.test(sql)),
    false,
    "stale updates cannot recreate or reactivate cancelled obligations",
  );

  console.log("group_delete: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
