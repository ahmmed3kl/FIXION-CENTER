const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  buildAttendancePullSql,
  buildPaymentReversalPullSql,
  buildSessionAliasPullSql,
  buildSessionPullSql,
  pullAllClients,
  sqlValue,
} = require("./sync-pull-sql");

const sqliteBinary = process.env.SQLITE3_BIN || "sqlite3";

function withDatabase(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixion-sync-pull-apply-"),
  );
  const database = path.join(directory, "pull.sqlite");
  try {
    execute(database, `
      CREATE TABLE attendance (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        UNIQUE (session_id, student_id)
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        center_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        session_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT NOT NULL,
        schedule_id TEXT,
        subject_id TEXT,
        teacher_id TEXT,
        session_price REAL NOT NULL,
        late_after_minutes INTEGER NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        is_reversed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE payment_reversals (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        payment_id TEXT NOT NULL UNIQUE,
        reversed_amount REAL NOT NULL
      );
      CREATE TABLE sync_operations (
        operation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    return run(database);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function execute(database, statement, json = false) {
  const args = ["-batch"];
  if (json) args.push("-json");
  args.push(database);
  const output = execFileSync(sqliteBinary, args, {
    encoding: "utf8",
    input: statement,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  if (!json) return output;
  return output ? JSON.parse(output) : [];
}

test("SQLite JSON queries return an empty array when no rows match", () => {
  withDatabase((database) => {
    assert.deepStrictEqual(
      execute(database, "SELECT id FROM attendance", true),
      [],
    );
  });
});

test("Pull keeps the earliest session start when device updates arrive out of order", () => {
  withDatabase((database) => {
    const laterStart = "2026-10-14T23:38:16.741Z";
    const earliestStart = "2026-10-14T23:37:16.741Z";
    const laterOperation = {
      operationType: "CREATE",
      entityId: "canonical-session",
      payload: {
        id: "canonical-session",
        groupId: "group-a",
        scheduleId: "schedule-a",
        sessionDate: "2026-10-15",
        startTime: "10:00",
        endTime: "11:00",
        status: "open",
        startedAt: laterStart,
        updatedAt: laterStart,
      },
    };
    const earlierOperation = {
      ...laterOperation,
      operationType: "UPDATE",
      payload: {
        ...laterOperation.payload,
        startedAt: earliestStart,
        updatedAt: earliestStart,
      },
    };

    execute(database, buildSessionPullSql(laterOperation, "center-a"));
    execute(database, buildSessionPullSql(earlierOperation, "center-a"));
    execute(database, buildSessionPullSql(laterOperation, "center-a"));

    const rows = execute(
      database,
      `SELECT id, center_id, created_at, status FROM sessions`,
      true,
    );
    assert.deepStrictEqual(rows, [
      {
        id: "canonical-session",
        center_id: "center-a",
        created_at: earliestStart,
        status: "open",
      },
    ]);
  });
});

test("Pull reconciles aliased and repeated attendance operations without losing rows", () => {
  withDatabase((database) => {
    execute(
      database,
      `INSERT INTO attendance
         (id, session_id, student_id, operation_id, status)
       VALUES
         ('server-present', 'session-local', 'student-shared', 'op-present', 'present'),
         ('server-student-b', 'session-local', 'student-b', 'op-student-b', 'present');`,
    );
    const attendanceRows = execute(
      database,
      `SELECT id, session_id, student_id, operation_id, status FROM attendance`,
      true,
    );
    const sessionAliasPlan = buildSessionAliasPullSql(
      [
        {
          localSessionId: "session-local",
          canonicalSessionId: "session-canonical",
        },
      ],
      attendanceRows,
    );
    execute(database, sessionAliasPlan.statements.join("\n"));

    const changes = [
      {
        operationId: "op-absent",
        entityId: "server-absent",
        payload: {
          id: "server-absent",
          session_id: "session-canonical",
          student_id: "student-shared",
          status: "absent",
        },
      },
      {
        operationId: "op-present",
        entityId: "server-present",
        payload: {
          id: "server-present",
          session_id: "session-canonical",
          student_id: "student-shared",
          status: "present",
        },
      },
      {
        operationId: "op-student-a",
        entityId: "server-student-a",
        payload: {
          id: "server-student-a",
          session_id: "session-canonical",
          student_id: "student-a",
          status: "present",
        },
      },
      {
        operationId: "op-student-b",
        entityId: "server-student-b",
        payload: {
          id: "server-student-b",
          session_id: "session-canonical",
          student_id: "student-b",
          status: "present",
        },
      },
    ];

    for (const change of changes) {
      execute(
        database,
        buildAttendancePullSql(
          change,
          attendanceRows,
          sessionAliasPlan.aliases,
        ),
      );
    }
    for (const change of changes) {
      execute(
        database,
        buildAttendancePullSql(
          change,
          attendanceRows,
          sessionAliasPlan.aliases,
        ),
      );
    }

    const rows = execute(
      database,
      `SELECT id, session_id, student_id, operation_id, status
         FROM attendance ORDER BY student_id`,
      true,
    );
    assert.deepStrictEqual(rows, [
      {
        id: "server-student-a",
        session_id: "session-canonical",
        student_id: "student-a",
        operation_id: "op-student-a",
        status: "present",
      },
      {
        id: "server-student-b",
        session_id: "session-canonical",
        student_id: "student-b",
        operation_id: "op-student-b",
        status: "present",
      },
      {
        id: "server-present",
        session_id: "session-canonical",
        student_id: "student-shared",
        operation_id: "op-present",
        status: "present",
      },
    ]);
  });
});

test("Pull rejects attendance IDs and operation IDs reused by a different record", () => {
  const attendanceRows = [
    {
      id: "existing-id",
      session_id: "session-a",
      student_id: "student-a",
      operation_id: "existing-operation",
      status: "present",
    },
  ];
  const conflictingId = {
    operationId: "new-operation",
    entityId: "existing-id",
    payload: {
      id: "existing-id",
      session_id: "session-b",
      student_id: "student-b",
      status: "present",
    },
  };
  const conflictingOperation = {
    operationId: "existing-operation",
    entityId: "new-id",
    payload: {
      id: "new-id",
      session_id: "session-b",
      student_id: "student-b",
      status: "present",
    },
  };

  assert.throws(
    () => buildAttendancePullSql(conflictingId, attendanceRows),
    /attendance ID is already used by another record/,
  );
  assert.throws(
    () => buildAttendancePullSql(conflictingOperation, attendanceRows),
    /attendance operation ID is already used by another record/,
  );
  assert.deepStrictEqual(attendanceRows, [
    {
      id: "existing-id",
      session_id: "session-a",
      student_id: "student-a",
      operation_id: "existing-operation",
      status: "present",
    },
  ]);
});

test("Session alias reconciliation refuses to merge historical attendance rows", () => {
  const attendanceRows = [
    {
      id: "alias-attendance",
      session_id: "session-alias",
      student_id: "student-a",
      operation_id: "alias-operation",
      status: "absent",
    },
    {
      id: "canonical-attendance",
      session_id: "session-canonical",
      student_id: "student-a",
      operation_id: "canonical-operation",
      status: "present",
    },
  ];
  const originalRows = attendanceRows.map((row) => ({ ...row }));

  assert.throws(
    () =>
      buildSessionAliasPullSql(
        [
          {
            localSessionId: "session-alias",
            canonicalSessionId: "session-canonical",
          },
        ],
        attendanceRows,
      ),
    /would combine historical attendance rows/,
  );
  assert.deepStrictEqual(attendanceRows, originalRows);
});

test("Pull converges competing payment reversals without deleting the losing outbox operation", () => {
  withDatabase((database) => {
    execute(
      database,
      `INSERT INTO payments (id, is_reversed) VALUES ('payment-a', 1), ('payment-b', 1);
       INSERT INTO payment_reversals
         (id, operation_id, payment_id, reversed_amount)
       VALUES ('offline-loser', 'op-loser', 'payment-a', 125);
       INSERT INTO sync_operations (operation_id, status)
       VALUES ('op-loser', 'conflict');`,
    );

    const acceptedReversal = {
      operationId: "op-winner",
      entityId: "server-winner",
      payload: {
        id: "server-winner",
        payment_id: "payment-a",
        reversed_amount: 125,
      },
    };
    const newReversal = {
      operationId: "op-payment-b",
      entityId: "reversal-payment-b",
      payload: {
        id: "reversal-payment-b",
        payment_id: "payment-b",
        reversed_amount: 75,
      },
    };

    execute(database, buildPaymentReversalPullSql(acceptedReversal));
    execute(database, buildPaymentReversalPullSql(acceptedReversal));
    execute(database, buildPaymentReversalPullSql(newReversal));
    execute(database, buildPaymentReversalPullSql(newReversal));

    const reversals = execute(
      database,
      `SELECT id, operation_id, payment_id, reversed_amount
         FROM payment_reversals ORDER BY payment_id`,
      true,
    );
    assert.deepStrictEqual(reversals, [
      {
        id: "server-winner",
        operation_id: "op-winner",
        payment_id: "payment-a",
        reversed_amount: 125,
      },
      {
        id: "reversal-payment-b",
        operation_id: "op-payment-b",
        payment_id: "payment-b",
        reversed_amount: 75,
      },
    ]);
    assert.deepStrictEqual(
      execute(database, "SELECT * FROM sync_operations", true),
      [{ operation_id: "op-loser", status: "conflict" }],
    );
  });
});

test("parallel Pull failures are reported only after every device request settles", async () => {
  const pullError = new Error("simulated local apply failure");
  let otherPullSettled = false;
  const clients = [
    { pullAll: async () => { throw pullError; } },
    {
      pullAll: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        otherPullSettled = true;
        return [];
      },
    },
  ];

  await assert.rejects(pullAllClients(clients), (error) => error === pullError);
  assert.strictEqual(otherPullSettled, true);
});

assert.strictEqual(sqlValue("quoted'value"), "'quoted''value'");
