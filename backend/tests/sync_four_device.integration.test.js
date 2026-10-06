const assert = require("assert");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

if (process.env.FIXION_TEST_DATABASE_ACK !== "1") {
  throw new Error(
    "Refusing to write to PostgreSQL without FIXION_TEST_DATABASE_ACK=1.",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("A dedicated test DATABASE_URL must be configured.");
}

const app = require("../src/server");
const db = require("../src/db");
const config = require("../src/config");
const bcrypt = require("bcryptjs");
const SyncProcessor = require("../src/services/SyncProcessor");

const SQLITE_BIN = process.env.SQLITE3_BIN || "sqlite3";
const delayFunction = "fixion_test_delay_sync_insert";
const delayTrigger = "fixion_test_delay_sync_insert_trigger";
const delayOperationId = `slow-${crypto.randomUUID()}`;
const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const cardPrefix = String(Date.now()).slice(-8);
const centerId = `sync-it-${runId}`;
const tempDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), `fixion-four-device-${runId}-`),
);
let server;
let baseUrl;
let fixtureReady = false;

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlite(databasePath, sql, json = false) {
  const args = ["-batch"];
  if (json) args.push("-json");
  args.push(databasePath);
  const output = execFileSync(SQLITE_BIN, args, {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return json && output ? JSON.parse(output) : output;
}

function makeClientDatabase(deviceNumber) {
  const filename = path.join(tempDirectory, `device-${deviceNumber}.sqlite`);
  sqlite(
    filename,
    `
      PRAGMA journal_mode=WAL;
      CREATE TABLE sync_operations (
        operation_id TEXT PRIMARY KEY,
        center_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE sync_cursors (
        center_id TEXT PRIMARY KEY,
        server_cursor TEXT NOT NULL
      );
      CREATE TABLE applied_operations (
        operation_id TEXT PRIMARY KEY,
        sequence_number INTEGER NOT NULL
      );
      CREATE TABLE students (
        id TEXT PRIMARY KEY,
        student_code TEXT NOT NULL,
        card_code TEXT NOT NULL,
        full_name TEXT NOT NULL,
        grade TEXT NOT NULL,
        phone TEXT NOT NULL,
        parent_phone TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        grade TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE teachers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        notes TEXT,
        status TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE subjects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE packages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grade TEXT NOT NULL,
        total_price REAL NOT NULL,
        max_selections INTEGER NOT NULL,
        billing_cycle TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE attendance (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        UNIQUE (session_id, student_id)
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        student_id TEXT NOT NULL,
        amount REAL NOT NULL,
        is_reversed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE payment_reversals (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        payment_id TEXT NOT NULL UNIQUE,
        reversed_amount REAL NOT NULL
      );
      CREATE TABLE debt_cycles (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        group_id TEXT,
        cycle_number INTEGER,
        cycle_type TEXT,
        billing_mode TEXT,
        start_date TEXT,
        end_date TEXT,
        cycle_price REAL,
        status TEXT,
        updated_at TEXT,
        server_revision INTEGER NOT NULL DEFAULT 0
      );
    `,
  );

  return {
    filename,
    deviceId: `sync-it-device-${runId}-${deviceNumber}`,
    userId: `sync-it-user-${runId}-${deviceNumber}`,
    token: null,
    async enqueue(operation) {
      const row = {
        ...operation,
        centerId,
        userId: this.userId,
        deviceId: this.deviceId,
        createdAt: new Date().toISOString(),
      };
      this.applyLocal(row);
      sqlite(
        filename,
        `INSERT INTO sync_operations
           (operation_id, center_id, user_id, device_id, operation_type,
            entity_type, entity_id, payload, status)
         VALUES (
           ${sqlValue(row.operationId)}, ${sqlValue(centerId)},
           ${sqlValue(this.userId)}, ${sqlValue(this.deviceId)},
           ${sqlValue(row.operationType)}, ${sqlValue(row.entityType)},
           ${sqlValue(row.entityId)}, ${sqlValue(JSON.stringify(row.payload))},
           'pending'
         );`,
      );
      return row;
    },
    applyLocal(operation) {
      const payload = operation.payload || {};
      if (operation.entityType === "student") {
        const student = payload.student || payload;
        sqlite(
          filename,
          `INSERT INTO students
             (id, student_code, card_code, full_name, grade, phone, parent_phone, status)
           VALUES (
             ${sqlValue(student.id || operation.entityId)},
             ${sqlValue(student.student_code || student.studentCode || student.card_code || student.cardCode || "")},
             ${sqlValue(student.card_code || student.cardCode || student.student_code || student.studentCode || "")},
             ${sqlValue(student.full_name || student.fullName || "")},
             ${sqlValue(student.grade || "")}, ${sqlValue(student.phone || "")},
             ${sqlValue(student.parent_phone || student.parentPhone || "")},
             ${sqlValue(student.status || "active")}
           )
           ON CONFLICT(id) DO UPDATE SET
             student_code=excluded.student_code, card_code=excluded.card_code,
             full_name=excluded.full_name, grade=excluded.grade,
             phone=excluded.phone, parent_phone=excluded.parent_phone,
             status=excluded.status;`,
        );
      } else if (operation.entityType === "group") {
        const group = payload.group || payload;
        sqlite(
          filename,
          `INSERT INTO groups (id, name, teacher_id, subject_id, grade, status)
           VALUES (
             ${sqlValue(group.id || operation.entityId)}, ${sqlValue(group.name || "")},
             ${sqlValue(group.teacher_id || group.teacherId || "")},
             ${sqlValue(group.subject_id || group.subjectId || "")},
             ${sqlValue(group.grade || "")}, ${sqlValue(group.status || "active")}
           )
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, teacher_id=excluded.teacher_id,
             subject_id=excluded.subject_id, grade=excluded.grade,
             status=excluded.status;`,
        );
      } else if (
        operation.entityType === "teacher" ||
        operation.entityType === "subject" ||
        operation.entityType === "package"
      ) {
        sqlite(filename, this.localApplySql(operation));
      } else if (operation.entityType === "attendance") {
        const attendance = payload.attendance || payload;
        sqlite(
          filename,
          `INSERT INTO attendance
             (id, session_id, student_id, operation_id, status)
           VALUES (
             ${sqlValue(attendance.id || operation.entityId)},
             ${sqlValue(attendance.session_id || attendance.sessionId)},
             ${sqlValue(attendance.student_id || attendance.studentId)},
             ${sqlValue(operation.operationId)}, ${sqlValue(attendance.status || "present")}
           )
           ON CONFLICT(session_id, student_id) DO NOTHING;`,
        );
      } else if (operation.entityType === "payment") {
        const payment = payload.payment || payload;
        sqlite(
          filename,
          `INSERT INTO payments (id, operation_id, student_id, amount, is_reversed)
           VALUES (${sqlValue(payment.id || operation.entityId)},
             ${sqlValue(operation.operationId)}, ${sqlValue(payment.student_id || payment.studentId)},
             ${Number(payment.amount)}, 0)
           ON CONFLICT(id) DO NOTHING;`,
        );
      } else if (operation.entityType === "payment_reversal") {
        const reversal = payload.reversal || payload;
        const paymentId = reversal.payment_id || reversal.paymentId;
        sqlite(
          filename,
          `UPDATE payments SET is_reversed=1 WHERE id=${sqlValue(paymentId)};
           INSERT INTO payment_reversals (id, operation_id, payment_id, reversed_amount)
           VALUES (${sqlValue(reversal.id || operation.entityId)},
             ${sqlValue(operation.operationId)}, ${sqlValue(paymentId)},
             ${Number(reversal.reversed_amount || reversal.reversedAmount || 0)});`,
        );
      } else if (operation.entityType === "debt_cycle") {
        const cycle = payload.debtCycle || payload;
        const cycleId = cycle.id || operation.entityId;
        const localCycle = sqlite(
          filename,
          `SELECT server_revision FROM debt_cycles WHERE id=${sqlValue(cycleId)}`,
          true,
        )[0];
        const serverRevision = cycle.server_revision ?? cycle.serverRevision ?? localCycle?.server_revision ?? 0;
        sqlite(
          filename,
          `INSERT INTO debt_cycles
             (id, student_id, group_id, cycle_number, cycle_type, billing_mode,
              start_date, end_date, cycle_price, status, updated_at, server_revision)
           VALUES (${sqlValue(cycleId)},
             ${sqlValue(cycle.student_id || cycle.studentId)},
             ${sqlValue(cycle.group_id || cycle.groupId)},
             ${Number(cycle.cycle_number || cycle.cycleNumber || 1)},
             ${sqlValue(cycle.cycle_type || cycle.cycleType || "monthly")},
             ${sqlValue(cycle.billing_mode || cycle.billingMode || "monthly")},
             ${sqlValue(cycle.period_start || cycle.startDate || cycle.start_date)},
             ${sqlValue(cycle.period_end || cycle.endDate || cycle.end_date)},
             ${Number(cycle.amount_due ?? cycle.cyclePrice ?? cycle.cycle_price ?? 0)},
             ${sqlValue(cycle.status || "pending")},
             ${sqlValue(cycle.updated_at || cycle.updatedAt || new Date().toISOString())},
             ${Number(serverRevision)})
           ON CONFLICT(id) DO UPDATE SET
             group_id=excluded.group_id, cycle_price=excluded.cycle_price,
             status=excluded.status, updated_at=excluded.updated_at,
             server_revision=excluded.server_revision;`,
        );
      } else {
        throw new Error(`Unexpected integration entity: ${operation.entityType}`);
      }
    },
    async push({ loseResponse = false } = {}) {
      const pending = sqlite(
        filename,
        `SELECT * FROM sync_operations
         WHERE center_id=${sqlValue(centerId)} AND status='pending'
         ORDER BY rowid`,
        true,
      );
      if (!pending.length) return { syncedOperationIds: [], conflicts: [] };

      const response = await request("/v1/sync/push", {
        method: "POST",
        token: this.token,
        deviceId: this.deviceId,
        body: {
          centerId,
          deviceId: this.deviceId,
          clientVersion: "four-device-integration",
          operations: pending.map((row) => ({
            operationId: row.operation_id,
            centerId: row.center_id,
            userId: row.user_id,
            deviceId: row.device_id,
            operationType: row.operation_type,
            entityType: row.entity_type,
            entityId: row.entity_id,
            payload: JSON.parse(row.payload),
            createdAt: new Date().toISOString(),
          })),
        },
      });
      if (response.status !== 200) {
        throw new Error(`Push failed (${response.status}): ${JSON.stringify(response.body)}`);
      }
      if (loseResponse) {
        throw new Error("Simulated response loss after server commit");
      }

      const synced = new Set(response.body.syncedOperationIds || []);
      const conflicts = new Set(
        (response.body.conflicts || []).map((conflict) => conflict.operationId),
      );
      for (const row of pending) {
        const status = conflicts.has(row.operation_id)
          ? "conflict"
          : synced.has(row.operation_id)
            ? "synced"
            : "pending";
        sqlite(
          filename,
          `UPDATE sync_operations SET status=${sqlValue(status)}
           WHERE operation_id=${sqlValue(row.operation_id)};`,
        );
      }
      return response.body;
    },
    async pullAll(limit = 100) {
      const seen = [];
      for (;;) {
        const cursor = this.cursor();
        const response = await request(
          `/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
          { token: this.token, deviceId: this.deviceId },
        );
        if (response.status !== 200) {
          throw new Error(`Pull failed (${response.status}): ${JSON.stringify(response.body)}`);
        }
        const changes = response.body.changes || [];
        const nextCursor = String(response.body.nextCursor || cursor);
        if (
          nextCursor === cursor &&
          (response.body.hasMore || changes.length > 0)
        ) {
          throw new Error("Pull response made no cursor progress");
        }
        const statements = ["BEGIN IMMEDIATE;"];
        for (const change of changes) {
          const operation = {
            operationId: change.operationId,
            operationType: change.action,
            entityType: change.entityType,
            entityId: change.entityId,
            payload: change.data || {},
          };
          statements.push(this.localApplySql(operation));
          if (change.operationId) {
            statements.push(
              `INSERT OR IGNORE INTO applied_operations (operation_id, sequence_number)
               VALUES (${sqlValue(change.operationId)}, ${Number(change.sequenceNumber)});`,
            );
          }
          seen.push(change);
        }
        statements.push(
          `INSERT INTO sync_cursors (center_id, server_cursor)
           VALUES (${sqlValue(centerId)}, ${sqlValue(nextCursor)})
           ON CONFLICT(center_id) DO UPDATE SET server_cursor=excluded.server_cursor;`,
        );
        statements.push("COMMIT;");
        try {
          sqlite(filename, statements.join("\n"));
        } catch (error) {
          try {
            sqlite(filename, "ROLLBACK;");
          } catch {}
          throw error;
        }
        if (!response.body.hasMore) break;
      }
      return seen;
    },
    localApplySql(operation) {
      const payload = operation.payload || {};
      if (operation.entityType === "student" || operation.entityType === "student_created" || operation.entityType === "student_updated") {
        const student = payload.student || payload;
        const studentId = student.id || operation.entityId;
        const code = student.student_code || student.studentCode || student.card_code || student.cardCode || "";
        return `INSERT INTO students
          (id, student_code, card_code, full_name, grade, phone, parent_phone, status)
          VALUES (${sqlValue(studentId)}, ${sqlValue(code)},
            ${sqlValue(student.card_code || student.cardCode || code)},
            ${sqlValue(student.full_name || student.fullName || "")},
            ${sqlValue(student.grade || "")}, ${sqlValue(student.phone || "")},
            ${sqlValue(student.parent_phone || student.parentPhone || "")},
            ${sqlValue(student.status || "active")})
          ON CONFLICT(id) DO UPDATE SET
            student_code=excluded.student_code, card_code=excluded.card_code,
            full_name=excluded.full_name, grade=excluded.grade,
            phone=excluded.phone, parent_phone=excluded.parent_phone,
            status=excluded.status;`;
      }
      if (operation.entityType === "group" || operation.entityType === "group_updated") {
        const group = payload.group || payload;
        return `INSERT INTO groups (id, name, teacher_id, subject_id, grade, status)
          VALUES (${sqlValue(group.id || operation.entityId)}, ${sqlValue(group.name || "")},
            ${sqlValue(group.teacher_id || group.teacherId || "")},
            ${sqlValue(group.subject_id || group.subjectId || "")},
            ${sqlValue(group.grade || "")}, ${sqlValue(group.status || "active")})
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, teacher_id=excluded.teacher_id,
            subject_id=excluded.subject_id, grade=excluded.grade,
            status=excluded.status;`;
      }
      if (operation.entityType === "teacher") {
        const teacher = payload.teacher || payload;
        return `INSERT INTO teachers (id, name, phone, notes, status, updated_at)
          VALUES (${sqlValue(teacher.id || operation.entityId)},
            ${sqlValue(teacher.name || "")}, ${sqlValue(teacher.phone)},
            ${sqlValue(teacher.notes)}, ${sqlValue(teacher.status || "active")},
            ${sqlValue(teacher.updated_at || teacher.updatedAt || new Date().toISOString())})
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone,
            notes=excluded.notes, status=excluded.status, updated_at=excluded.updated_at;`;
      }
      if (operation.entityType === "subject") {
        const subject = payload.subject || payload;
        return `INSERT INTO subjects (id, name, code, status, updated_at)
          VALUES (${sqlValue(subject.id || operation.entityId)},
            ${sqlValue(subject.name || "")}, ${sqlValue(subject.code || "")},
            ${sqlValue(subject.status || "active")},
            ${sqlValue(subject.updated_at || subject.updatedAt || new Date().toISOString())})
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code,
            status=excluded.status, updated_at=excluded.updated_at;`;
      }
      if (operation.entityType === "package") {
        const item = payload.package || payload;
        return `INSERT INTO packages
          (id, name, grade, total_price, max_selections, billing_cycle, status, updated_at)
          VALUES (${sqlValue(item.id || operation.entityId)},
            ${sqlValue(item.name || "")}, ${sqlValue(item.grade || "all")},
            ${Number(item.total_price ?? item.totalPrice ?? item.price ?? 0)},
            ${Number(item.max_selections ?? item.maxSelections ?? 1)},
            ${sqlValue(item.billing_cycle || item.billingCycle || "monthly")},
            ${sqlValue(item.status || "active")},
            ${sqlValue(item.updated_at || item.updatedAt || new Date().toISOString())})
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, grade=excluded.grade,
            total_price=excluded.total_price, max_selections=excluded.max_selections,
            billing_cycle=excluded.billing_cycle, status=excluded.status,
            updated_at=excluded.updated_at;`;
      }
      if (operation.entityType === "attendance" || operation.entityType === "attendance_marked") {
        const attendance = payload.attendance || payload;
        return `INSERT INTO attendance (id, session_id, student_id, operation_id, status)
          VALUES (${sqlValue(attendance.id || operation.entityId)},
            ${sqlValue(attendance.session_id || attendance.sessionId)},
            ${sqlValue(attendance.student_id || attendance.studentId)},
            ${sqlValue(operation.operationId || `server-${operation.entityId}`)},
            ${sqlValue(attendance.status || "present")})
          ON CONFLICT(session_id, student_id) DO NOTHING;`;
      }
      if (operation.entityType === "payment") {
        const payment = payload.payment || payload;
        const paymentId = payment.id || operation.entityId;
        const statements = [`INSERT INTO payments (id, operation_id, student_id, amount, is_reversed)
          VALUES (${sqlValue(paymentId)},
            ${sqlValue(operation.operationId || payment.operation_id || payment.operationId || `srv-pay-${paymentId}`)},
            ${sqlValue(payment.student_id || payment.studentId)}, ${Number(payment.amount || 0)},
            ${payment.is_reversed || payment.isReversed ? 1 : 0})
          ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, is_reversed=excluded.is_reversed;`];
        if (payload.debtCycle) statements.push(this.localApplySql({
          entityType: "debt_cycle",
          entityId: payload.debtCycle.id,
          payload: payload.debtCycle,
        }));
        return statements.join("\n");
      }
      if (operation.entityType === "payment_reversal") {
        const reversal = payload.reversal || payload;
        const paymentId = reversal.payment_id || reversal.paymentId;
        return `UPDATE payments SET is_reversed=1 WHERE id=${sqlValue(paymentId)};
          DELETE FROM payment_reversals
           WHERE payment_id=${sqlValue(paymentId)}
             AND operation_id<>${sqlValue(operation.operationId || reversal.operation_id || reversal.operationId)};
          INSERT INTO payment_reversals (id, operation_id, payment_id, reversed_amount)
          VALUES (${sqlValue(reversal.id || operation.entityId)},
            ${sqlValue(operation.operationId || reversal.operation_id || reversal.operationId)},
            ${sqlValue(paymentId)},
            ${Number(reversal.reversed_amount ?? reversal.reversedAmount ?? 0)})
          ON CONFLICT(operation_id) DO NOTHING;`;
      }
      if (operation.entityType === "debt_cycle") {
        const cycle = payload.debtCycle || payload;
        return `INSERT INTO debt_cycles
          (id, student_id, group_id, cycle_number, cycle_type, billing_mode,
           start_date, end_date, cycle_price, status, updated_at, server_revision)
          VALUES (${sqlValue(cycle.id || operation.entityId)},
            ${sqlValue(cycle.student_id || cycle.studentId)},
            ${sqlValue(cycle.group_id || cycle.groupId)},
            ${Number(cycle.cycle_number || cycle.cycleNumber || 1)},
            ${sqlValue(cycle.cycle_type || cycle.cycleType || "monthly")},
            ${sqlValue(cycle.billing_mode || cycle.billingMode || "monthly")},
            ${sqlValue(cycle.period_start || cycle.startDate || cycle.start_date)},
            ${sqlValue(cycle.period_end || cycle.endDate || cycle.end_date)},
            ${Number(cycle.amount_due ?? cycle.cyclePrice ?? cycle.cycle_price ?? 0)},
            ${sqlValue(cycle.status || "pending")},
            ${sqlValue(cycle.updated_at || cycle.updatedAt || new Date().toISOString())},
            ${Number(cycle.server_revision ?? cycle.serverRevision ?? 0)})
          ON CONFLICT(id) DO UPDATE SET
            group_id=excluded.group_id, cycle_price=excluded.cycle_price,
            status=excluded.status, updated_at=excluded.updated_at,
            server_revision=excluded.server_revision;`;
      }
      throw new Error(`Unsupported pulled entity type: ${operation.entityType}`);
    },
    async bootstrap() {
      const response = await request("/v1/sync/bootstrap", {
        token: this.token,
        deviceId: this.deviceId,
      });
      if (response.status !== 200) {
        throw new Error(`Bootstrap failed (${response.status}): ${JSON.stringify(response.body)}`);
      }
      const data = response.body;
      const statements = ["BEGIN IMMEDIATE;"];
      for (const student of data.students || []) {
        statements.push(
          this.localApplySql({
            entityType: "student",
            entityId: student.id,
            payload: student,
          }),
        );
      }
      for (const group of data.groups || []) {
        statements.push(
          this.localApplySql({
            entityType: "group",
            entityId: group.id,
            payload: group,
          }),
        );
      }
      for (const attendance of data.attendance || []) {
        statements.push(
          this.localApplySql({
            entityType: "attendance",
            entityId: attendance.id,
            operationId: attendance.operation_id || attendance.operationId,
            payload: attendance,
          }),
        );
      }
      for (const cycle of data.debtCycles || []) {
        statements.push(this.localApplySql({
          entityType: "debt_cycle",
          entityId: cycle.id,
          payload: cycle,
        }));
      }
      for (const payment of data.payments || []) {
        statements.push(this.localApplySql({
          entityType: "payment",
          entityId: payment.id,
          operationId: payment.operation_id,
          payload: payment,
        }));
      }
      for (const reversal of data.paymentReversals || []) {
        statements.push(this.localApplySql({
          entityType: "payment_reversal",
          entityId: reversal.id,
          operationId: reversal.operation_id,
          payload: reversal,
        }));
      }
      statements.push(
        `INSERT INTO sync_cursors (center_id, server_cursor)
         VALUES (${sqlValue(centerId)}, ${sqlValue(String(data.latestServerSeq || 0))})
         ON CONFLICT(center_id) DO UPDATE SET server_cursor=excluded.server_cursor;`,
      );
      statements.push("COMMIT;");
      sqlite(filename, statements.join("\n"));
      return data;
    },
    cursor() {
      const rows = sqlite(
        filename,
        `SELECT server_cursor FROM sync_cursors WHERE center_id=${sqlValue(centerId)}`,
        true,
      );
      return rows[0]?.server_cursor || "0";
    },
    rows(table) {
      if (!["students", "groups", "attendance", "payments", "payment_reversals", "debt_cycles", "sync_operations", "applied_operations"].includes(table)) {
        throw new Error(`Invalid local table: ${table}`);
      }
      const orderBy = table === "applied_operations" ? " ORDER BY sequence_number" : "";
      return sqlite(filename, `SELECT * FROM ${table}${orderBy}`, true);
    },
  };
}

async function request(route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.deviceId) headers["X-Device-Id"] = options.deviceId;
  headers["X-Center-Id"] = centerId;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function uniqueOperation(prefix) {
  return `${prefix}-${crypto.randomUUID()}`.slice(0, 64);
}

function cardCode(index) {
  return `9${cardPrefix}${String(index).padStart(2, "0")}`;
}

function studentOperation(operationId, studentId, code, name, operationType = "create", baseUpdatedAt) {
  return {
    operationId,
    operationType,
    entityType: "student",
    entityId: studentId,
    payload: {
      id: studentId,
      student_code: code,
      card_code: code,
      full_name: name,
      grade: "test",
      phone: "",
      parent_phone: "",
      student_type: "registered",
      status: "active",
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    },
  };
}

function groupOperation(operationId, groupId, name, baseUpdatedAt) {
  return {
    operationId,
    operationType: "update",
    entityType: "group",
    entityId: groupId,
    payload: {
      id: groupId,
      name,
      teacher_id: `sync-it-teacher-${runId}`,
      subject_id: `sync-it-subject-${runId}`,
      grade: "test",
      default_fee: 0,
      session_price: 0,
      monthly_price: 0,
      session_duration_minutes: 60,
      late_after_minutes: 15,
      status: "active",
      baseUpdatedAt,
    },
  };
}

function paymentOperation(operationId, paymentId, studentId, amount = 125) {
  return {
    operationId,
    operationType: "create",
    entityType: "payment",
    entityId: paymentId,
    payload: {
      id: paymentId,
      studentId,
      amount,
      paymentType: "monthly",
      paymentMethod: "cash",
      paymentDate: new Date().toISOString().slice(0, 10),
    },
  };
}

function reversalOperation(operationId, paymentId, reversalId) {
  return {
    operationId,
    operationType: "payment.reverse",
    entityType: "payment_reversal",
    entityId: reversalId,
    payload: {
      id: reversalId,
      paymentId,
      reversedAmount: 1,
      reason: "Integration test reversal",
    },
  };
}

function debtCycleUpdate(operationId, revision, updates) {
  const cycleId = `sync-it-debt-cycle-${runId}`;
  return {
    operationId,
    operationType: "UPDATE",
    entityType: "debt_cycle",
    entityId: cycleId,
    payload: {
      id: cycleId,
      studentId: `sync-it-att-student-${runId}`,
      groupId: `sync-it-group-${runId}`,
      cycleNumber: 1,
      cycleType: "monthly",
      billingMode: "monthly",
      startDate: new Date().toISOString().slice(0, 10),
      endDate: new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10),
      cyclePrice: 500,
      status: "open",
      expectedRevision: revision,
      ...updates,
    },
  };
}

async function waitForSequenceAfter(previousValue, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await db.query(
      "SELECT last_value::text AS value FROM server_sync_operations_server_seq_seq",
    );
    const value = Number(result.rows[0].value);
    if (value > previousValue) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The delayed Push did not allocate a server sequence in time.");
}

async function maxCenterSequence() {
  const result = await db.query(
    "SELECT COALESCE(MAX(server_seq), 0)::text AS value FROM server_sync_operations WHERE center_id=$1",
    [centerId],
  );
  return Number(result.rows[0].value);
}

async function seedBacklog(prefix, count, userId, deviceId) {
  await db.withTransaction(async (client) => {
    await SyncProcessor.acquireCenterSyncLock(client, centerId);
    await client.query(
      `INSERT INTO students
         (id, center_id, student_code, full_name, card_code, phone,
          parent_phone, grade, student_type, status)
       SELECT $1 || i, $2, $3 || i, 'Backlog student ' || i, $4 || i,
              '', '', 'test', 'registered', 'active'
         FROM generate_series(1, $5) AS i`,
      [`${prefix}-student-`, centerId, `${prefix}-code-`, `${prefix}-card-`, count],
    );
    await client.query(
      `INSERT INTO server_sync_operations
         (operation_id, center_id, user_id, device_id, operation_type,
          entity_type, entity_id, payload, status)
       SELECT $1 || i, $2, $3, $4, 'create', 'student',
              $5 || i,
              jsonb_build_object(
                'id', $5 || i,
                'student_code', $6 || i,
                'card_code', $7 || i,
                'full_name', 'Backlog student ' || i,
                'grade', 'test',
                'phone', '',
                'parent_phone', '',
                'student_type', 'registered',
                'status', 'active'
              ),
              'applied'
         FROM generate_series(1, $8) AS i`,
      [
        `${prefix}-op-`,
        centerId,
        userId,
        deviceId,
        `${prefix}-student-`,
        `${prefix}-code-`,
        `${prefix}-card-`,
        count,
      ],
    );
  });
}

async function setupFixture() {
  await db.query(
    `INSERT INTO centers (id, name, code, status)
     VALUES ($1, $2, $3, 'active')`,
    [centerId, `Sync Integration ${runId}`, `SYNC-${runId}`],
  );
  fixtureReady = true;
  await db.query(
    "INSERT INTO center_data_state (center_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [centerId],
  );

  const passwordHash = await bcrypt.hash(`SyncTest-${runId}-Only`, 4);
  const devices = [];
  const managerSyncPermissions = [
    "students.create", "students.update",
    "teachers.create", "teachers.update",
    "subjects.create", "subjects.update",
    "groups.create", "groups.update",
    "attendance.create", "payments.create", "payments.reverse",
    "packages.manage",
  ];
  for (let index = 1; index <= 4; index += 1) {
    const userId = `sync-it-user-${runId}-${index}`;
    const deviceId = `sync-it-device-${runId}-${index}`;
    const email = `sync-it-${runId}-${index}@example.invalid`;
    await db.query(
      `INSERT INTO users (id, center_id, full_name, email, password_hash, role, permissions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active')`,
      [
        userId,
        centerId,
        `Sync Test User ${index}`,
        email,
        passwordHash,
        index === 1 ? "admin" : "manager",
        JSON.stringify(index === 1 ? {} : managerSyncPermissions),
      ],
    );
    await db.query(
      `INSERT INTO devices
         (id, center_id, user_id, device_name, platform, app_version, status)
       VALUES ($1, $2, $3, $4, 'test', 'integration', 'active')`,
      [deviceId, centerId, userId, `SQLite Device ${index}`],
    );
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: email,
        password: `SyncTest-${runId}-Only`,
      }),
    });
    const loginBody = await login.json();
    assert.strictEqual(login.status, 200, `Fixture user ${index} login failed`);
    devices.push({ userId, deviceId, token: loginBody.token });
  }

  await db.query(
    `INSERT INTO teachers (id, center_id, name, status)
     VALUES ($1, $2, 'Integration Teacher', 'active')`,
    [`sync-it-teacher-${runId}`, centerId],
  );
  await db.query(
    `INSERT INTO subjects (id, center_id, name, code, status)
     VALUES ($1, $2, 'Integration Subject', $3, 'active')`,
    [`sync-it-subject-${runId}`, centerId, `SUB-${runId}`],
  );
  await db.query(
    `INSERT INTO packages
       (id, center_id, name, grade, total_price, max_selections, billing_cycle, status)
     VALUES ($1, $2, 'Integration Package', 'test', 100, 1, 'monthly', 'active')`,
    [`sync-it-package-${runId}`, centerId],
  );
  await db.query(
    `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade)
     VALUES ($1, $2, 'Integration Group', $3, $4, 'test')`,
    [
      `sync-it-group-${runId}`,
      centerId,
      `sync-it-teacher-${runId}`,
      `sync-it-subject-${runId}`,
    ],
  );
  await db.query(
    `INSERT INTO students
       (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade)
     VALUES ($1, $2, $3, 'Attendance Test Student', $3, '', '', 'test')`,
    [`sync-it-att-student-${runId}`, centerId, cardCode(90)],
  );
  await db.query(
    `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status)
     VALUES ($1, $2, $3, CURRENT_DATE, '10:00', '11:00', 'open')`,
    [`sync-it-session-${runId}`, centerId, `sync-it-group-${runId}`],
  );
  await db.query(
    `INSERT INTO debt_cycles
       (id, center_id, student_id, group_id, cycle_number, cycle_type,
        billing_mode, period_start, period_end, amount_due, status, server_revision)
     VALUES ($1, $2, $3, $4, 1, 'monthly', 'monthly',
             CURRENT_DATE, CURRENT_DATE + 29, 500, 'pending', 1)`,
    [
      `sync-it-debt-cycle-${runId}`,
      centerId,
      `sync-it-att-student-${runId}`,
      `sync-it-group-${runId}`,
    ],
  );
  return devices;
}

async function cleanupFixture() {
  try {
    await db.query(`DROP TRIGGER IF EXISTS ${delayTrigger} ON server_sync_operations`);
    await db.query(`DROP FUNCTION IF EXISTS ${delayFunction}()`);
  } catch {}
  if (fixtureReady) {
    await db.query("DELETE FROM center_data_state WHERE center_id = $1", [centerId]);
    await db.query("DELETE FROM centers WHERE id = $1", [centerId]);
  }
}

async function runTests() {
  assert.ok(config.databaseUrl, "Test DATABASE_URL is required");
  await db.ensureSchemaCompatibility();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const records = await setupFixture();
  const clients = records.map((record, index) => {
    const client = makeClientDatabase(index + 1);
    client.userId = record.userId;
    client.deviceId = record.deviceId;
    client.token = record.token;
    return client;
  });

  try {
    console.log("1. Four separate SQLite databases and dedicated logins");
    assert.strictEqual(new Set(clients.map((client) => client.filename)).size, 4);
    assert.strictEqual(new Set(clients.map((client) => client.deviceId)).size, 4);
    assert.ok(clients.every((client) => fs.existsSync(client.filename)));
    console.log("   PASS: four independent SQLite files, users, and devices");

    console.log("2. Local-first work, concurrent Push, and cross-device Pull");
    const initialOperations = await Promise.all(clients.map((client, index) =>
      client.enqueue(
        studentOperation(
          uniqueOperation(`multi-${index}`),
          `sync-it-student-${runId}-${index}`,
          cardCode(index),
          `Device ${index} student`,
        ),
      ),
    ));
    assert.strictEqual(clients[0].rows("students").length, 1);
    const pushResponses = await Promise.all(clients.map((client) => client.push()));
    assert.ok(
      pushResponses.every((response) => response.syncedOperationIds.length === 1),
    );
    for (const client of clients) await client.pullAll();
    for (let index = 0; index < 4; index += 1) {
      const ids = new Set(clients[index].rows("students").map((student) => student.id));
      for (const operation of initialOperations) {
        assert.ok(ids.has(operation.entityId), `Device ${index + 1} missed ${operation.entityId}`);
      }
    }
    console.log("   PASS: concurrent Push and all four devices received all four records");

    console.log("3. Response loss after commit and idempotent retry");
    const retryOperationId = uniqueOperation("lost-response");
    await clients[0].enqueue(
      studentOperation(
        retryOperationId,
        `sync-it-retry-student-${runId}`,
        cardCode(20),
        "Response lost student",
      ),
    );
    await assert.rejects(
      clients[0].push({ loseResponse: true }),
      /Simulated response loss after server commit/,
    );
    assert.strictEqual(
      clients[0].rows("sync_operations").find((row) => row.operation_id === retryOperationId).status,
      "pending",
    );
    const retried = await clients[0].push();
    assert.ok(retried.syncedOperationIds.includes(retryOperationId));
    const ledgerRetryCount = await db.query(
      "SELECT COUNT(*)::int AS count FROM server_sync_operations WHERE center_id=$1 AND operation_id=$2",
      [centerId, retryOperationId],
    );
    const domainRetryCount = await db.query(
      "SELECT COUNT(*)::int AS count FROM students WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-retry-student-${runId}`],
    );
    assert.strictEqual(ledgerRetryCount.rows[0].count, 1);
    assert.strictEqual(domainRetryCount.rows[0].count, 1);
    console.log("   PASS: response-loss retry produced one ledger row and one student");

    console.log("4. Concurrent student/group updates and overlapping Pull");
    await Promise.all(clients.map((client) => client.pullAll()));
    const studentVersion = await db.query(
      "SELECT updated_at::text AS updated_at FROM students WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-student-${runId}-0`],
    );
    const groupVersion = await db.query(
      "SELECT updated_at::text AS updated_at FROM groups WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-group-${runId}`],
    );
    const updateOps = await Promise.all(clients.map((client, index) =>
      client.enqueue(
        studentOperation(
          uniqueOperation(`student-update-${index}`),
          `sync-it-student-${runId}-0`,
          cardCode(0),
          `Concurrent student update ${index}`,
          "update",
          studentVersion.rows[0].updated_at,
        ),
      ),
    ));
    const groupOps = await Promise.all(clients.map((client, index) =>
      client.enqueue(
        groupOperation(
          uniqueOperation(`group-update-${index}`),
          `sync-it-group-${runId}`,
          `Concurrent group update ${index}`,
          groupVersion.rows[0].updated_at,
        ),
      ),
    ));
    const overlappingPull = clients[2].pullAll();
    const concurrentPush = Promise.all(clients.map((client) => client.push()));
    const [pushResults] = await Promise.all([concurrentPush, overlappingPull]);
    const appliedUpdateCount = pushResults.reduce(
      (sum, response) => sum + response.syncedOperationIds.length,
      0,
    );
    const staleUpdateCount = pushResults.flatMap((response) => response.conflicts || [])
      .filter((conflict) => /STALE_UPDATE/.test(conflict.reason)).length;
    assert.strictEqual(appliedUpdateCount, 2);
    assert.strictEqual(staleUpdateCount, 6);
    const updateLedger = await db.query(
      `SELECT COUNT(*)::int AS count FROM server_sync_operations
       WHERE center_id=$1 AND operation_id = ANY($2::text[])`,
      [
        centerId,
        [...updateOps, ...groupOps].map((operation) => operation.operationId),
      ],
    );
    assert.strictEqual(updateLedger.rows[0].count, 2);
    const groupState = await db.query(
      "SELECT name FROM groups WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-group-${runId}`],
    );
    assert.match(groupState.rows[0].name, /^Concurrent group update [0-3]$/);
    console.log("   PASS: one version won per mutable row, six stale writes conflicted; overlapping Pull completed");
    await clients[2].pullAll();
    const refreshedStudent = await db.query(
      "SELECT updated_at::text AS updated_at FROM students WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-student-${runId}-0`],
    );
    const refreshedUpdate = await clients[2].enqueue(
      studentOperation(
        uniqueOperation("student-refresh-retry"),
        `sync-it-student-${runId}-0`,
        cardCode(0),
        "Updated after refresh",
        "update",
        refreshedStudent.rows[0].updated_at,
      ),
    );
    const refreshedUpdateResponse = await clients[2].push();
    assert.ok(refreshedUpdateResponse.syncedOperationIds.includes(refreshedUpdate.operationId));
    console.log("   PASS: refreshing the server token allows an intentional student retry");

    console.log("4a. Teacher, subject, and package updates reject stale base versions");
    const mutableFixtures = [
      {
        entityType: "teacher",
        entityId: `sync-it-teacher-${runId}`,
        table: "teachers",
        payload: { name: "Updated Integration Teacher", phone: null, notes: null, status: "active" },
      },
      {
        entityType: "subject",
        entityId: `sync-it-subject-${runId}`,
        table: "subjects",
        payload: { name: "Updated Integration Subject", code: `SUB-${runId}-V2`, status: "active" },
      },
      {
        entityType: "package",
        entityId: `sync-it-package-${runId}`,
        table: "packages",
        payload: { name: "Updated Integration Package", grade: "test", price: 125, maxSelections: 1, billingCycle: "monthly", status: "active" },
      },
    ];
    for (const fixture of mutableFixtures) {
      const version = await db.query(
        `SELECT updated_at::text AS updated_at FROM ${fixture.table}
          WHERE center_id=$1 AND id=$2`,
        [centerId, fixture.entityId],
      );
      const token = version.rows[0].updated_at;
      const accepted = await clients[0].enqueue({
        operationId: uniqueOperation(`${fixture.entityType}-accepted`),
        operationType: "UPDATE",
        entityType: fixture.entityType,
        entityId: fixture.entityId,
        payload: { ...fixture.payload, id: fixture.entityId, baseUpdatedAt: token },
      });
      assert.ok((await clients[0].push()).syncedOperationIds.includes(accepted.operationId));
      const stale = await clients[3].enqueue({
        operationId: uniqueOperation(`${fixture.entityType}-stale`),
        operationType: "UPDATE",
        entityType: fixture.entityType,
        entityId: fixture.entityId,
        payload: { ...fixture.payload, id: fixture.entityId, baseUpdatedAt: token },
      });
      const staleResponse = await clients[3].push();
      assert.ok(staleResponse.conflicts.some(
        (conflict) => conflict.operationId === stale.operationId && /STALE_UPDATE/.test(conflict.reason),
      ), `${fixture.entityType} stale update was not rejected`);
    }
    console.log("   PASS: teacher, subject, and package metadata/config updates use server-issued stale-write tokens");

    console.log("5. Duplicate attendance from two independent devices");
    const attendanceOps = await Promise.all([clients[0], clients[1]].map((client, index) =>
      client.enqueue({
        operationId: uniqueOperation(`attendance-dup-${index}`),
        operationType: "mark",
        entityType: "attendance",
        entityId: `sync-it-attendance-${runId}-${index}`,
        payload: {
          id: `sync-it-attendance-${runId}-${index}`,
          session_id: `sync-it-session-${runId}`,
          student_id: `sync-it-att-student-${runId}`,
          status: "present",
        },
      }),
    ));
    const attendancePushes = await Promise.all([
      clients[0].push(),
      clients[1].push(),
    ]);
    assert.strictEqual(
      attendancePushes.filter((response) => response.syncedOperationIds.includes(attendanceOps[0].operationId) || response.syncedOperationIds.includes(attendanceOps[1].operationId)).length,
      1,
    );
    assert.strictEqual(
      attendancePushes.flatMap((response) => response.conflicts || []).filter((item) => /ATTENDANCE_ALREADY_RECORDED/.test(item.reason)).length,
      1,
    );
    const attendanceRows = await db.query(
      `SELECT COUNT(*)::int AS count FROM attendance
       WHERE center_id=$1 AND session_id=$2 AND student_id=$3`,
      [centerId, `sync-it-session-${runId}`, `sync-it-att-student-${runId}`],
    );
    assert.strictEqual(attendanceRows.rows[0].count, 1);
    console.log("   PASS: one attendance row; competing operation returned a conflict");

    console.log("6. Lower-sequence Push delayed before commit; higher Push and Bootstrap/Pull overlap");
    const sequenceBefore = await db.query(
      "SELECT last_value::text AS value FROM server_sync_operations_server_seq_seq",
    );
    await db.query(`
      CREATE OR REPLACE FUNCTION ${delayFunction}() RETURNS trigger AS $$
      BEGIN
        IF NEW.operation_id = '${delayOperationId}' THEN
          PERFORM pg_sleep(5);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${delayTrigger}
      AFTER INSERT ON server_sync_operations
      FOR EACH ROW EXECUTE FUNCTION ${delayFunction}();
    `);
    const slowOp = await clients[0].enqueue(
      studentOperation(
        delayOperationId,
        `sync-it-slow-student-${runId}`,
        cardCode(30),
        "Delayed lower-sequence student",
      ),
    );
    const fastOp = await clients[1].enqueue(
      studentOperation(
        uniqueOperation("higher-sequence"),
        `sync-it-fast-student-${runId}`,
        cardCode(31),
        "Following higher-sequence student",
      ),
    );
    const lowerPush = clients[0].push();
    const allocatedLowerSequence = await Promise.race([
      waitForSequenceAfter(Number(sequenceBefore.rows[0].value)),
      lowerPush.then(() => {
        throw new Error("The delayed Push completed before its sequence was observed.");
      }),
    ]);
    const higherPush = clients[1].push();
    const deviceC = clients[2];
    const bootstrap = deviceC.bootstrap();
    const pullDuringUncommitted = await deviceC.pullAll();
    assert.ok(
      !pullDuringUncommitted.some((change) => change.operationId === slowOp.operationId),
      "Pull must not observe an uncommitted ledger row",
    );

    const observedDuringDelay = await db.query(
      "SELECT last_value::text AS value FROM server_sync_operations_server_seq_seq",
    );
    assert.strictEqual(
      Number(observedDuringDelay.rows[0].value),
      allocatedLowerSequence,
      "A higher Push must not allocate a sequence while the lower Push holds the center lock",
    );

    const [, , bootstrapData] = await Promise.all([
      lowerPush,
      higherPush,
      bootstrap,
    ]);
    const lowerAndHigherSequences = await db.query(
      `SELECT operation_id, server_seq::text AS server_seq
       FROM server_sync_operations
       WHERE center_id=$1 AND operation_id = ANY($2::text[])`,
      [centerId, [slowOp.operationId, fastOp.operationId]],
    );
    const sequenceByOperation = new Map(
      lowerAndHigherSequences.rows.map((row) => [row.operation_id, Number(row.server_seq)]),
    );
    assert.ok(
      sequenceByOperation.get(slowOp.operationId) < sequenceByOperation.get(fastOp.operationId),
      "The higher Push must allocate only after the lower Push commits",
    );
    assert.ok(bootstrapData.latestServerSeq <= sequenceByOperation.get(fastOp.operationId));
    const afterBootstrapPull = await deviceC.pullAll();
    const deviceCStudents = new Set(deviceC.rows("students").map((row) => row.id));
    assert.ok(deviceCStudents.has(slowOp.entityId));
    assert.ok(deviceCStudents.has(fastOp.entityId));
    assert.ok(afterBootstrapPull.some((change) => change.operationId === slowOp.operationId) ||
      bootstrapData.students.some((student) => student.id === slowOp.entityId));
    assert.ok(afterBootstrapPull.some((change) => change.operationId === fastOp.operationId) ||
      bootstrapData.students.some((student) => student.id === fastOp.entityId));
    console.log("   PASS: no higher sequence allocated before lower commit; Bootstrap/Pull converged on both");

    console.log("7. Offline outbox then reconnect");
    const offlineOp = await clients[3].enqueue(
      studentOperation(
        uniqueOperation("offline-reconnect"),
        `sync-it-offline-student-${runId}`,
        cardCode(40),
        "Offline-first student",
      ),
    );
    assert.strictEqual(clients[3].rows("sync_operations").find((row) => row.operation_id === offlineOp.operationId).status, "pending");
    assert.ok(clients[3].rows("students").some((row) => row.id === offlineOp.entityId));
    const reconnectResponse = await clients[3].push();
    assert.ok(reconnectResponse.syncedOperationIds.includes(offlineOp.operationId));
    console.log("   PASS: local row/outbox existed before reconnect; later Push acknowledged it");

    console.log("8. Pull backlog of 501, 1000, and 1518 operations");
    const backlogDevice501 = makeClientDatabase("backlog-501");
    backlogDevice501.userId = clients[0].userId;
    backlogDevice501.deviceId = clients[0].deviceId;
    backlogDevice501.token = clients[0].token;
    const start501 = await maxCenterSequence();
    sqlite(backlogDevice501.filename, `INSERT INTO sync_cursors (center_id, server_cursor) VALUES (${sqlValue(centerId)}, ${sqlValue(String(start501))});`);
    await seedBacklog(`b501-${runId}`, 501, clients[0].userId, clients[0].deviceId);
    const changes501 = await backlogDevice501.pullAll(100);
    assert.strictEqual(changes501.length, 501);
    assert.strictEqual(backlogDevice501.rows("students").length, 501);
    assert.strictEqual(backlogDevice501.cursor(), String(await maxCenterSequence()));
    assert.strictEqual(backlogDevice501.rows("applied_operations").length, 501);

    const backlogDevice1000 = makeClientDatabase("backlog-1000");
    backlogDevice1000.userId = clients[1].userId;
    backlogDevice1000.deviceId = clients[1].deviceId;
    backlogDevice1000.token = clients[1].token;
    const start1000 = await maxCenterSequence();
    sqlite(backlogDevice1000.filename, `INSERT INTO sync_cursors (center_id, server_cursor) VALUES (${sqlValue(centerId)}, ${sqlValue(String(start1000))});`);
    await seedBacklog(`b1000-${runId}`, 1000, clients[1].userId, clients[1].deviceId);
    const changes1000 = await backlogDevice1000.pullAll(100);
    assert.strictEqual(changes1000.length, 1000);
    assert.strictEqual(backlogDevice1000.rows("students").length, 1000);
    assert.strictEqual(backlogDevice1000.cursor(), String(await maxCenterSequence()));
    assert.strictEqual(backlogDevice1000.rows("applied_operations").length, 1000);
    const replay = await backlogDevice1000.pullAll(100);
    assert.strictEqual(replay.length, 0);
    assert.strictEqual(backlogDevice1000.rows("applied_operations").length, 1000);
    const cursorAfterBacklog1000 = backlogDevice1000.cursor();

    const backlogDevice1518 = makeClientDatabase("backlog-1518");
    backlogDevice1518.userId = clients[2].userId;
    backlogDevice1518.deviceId = clients[2].deviceId;
    backlogDevice1518.token = clients[2].token;
    const start1518 = await maxCenterSequence();
    sqlite(backlogDevice1518.filename, `INSERT INTO sync_cursors (center_id, server_cursor) VALUES (${sqlValue(centerId)}, ${sqlValue(String(start1518))});`);
    await seedBacklog(`b1518-${runId}`, 1518, clients[2].userId, clients[2].deviceId);
    const changes1518 = await backlogDevice1518.pullAll(100);
    assert.strictEqual(changes1518.length, 1518);
    assert.strictEqual(backlogDevice1518.rows("students").length, 1518);
    assert.strictEqual(backlogDevice1518.cursor(), String(await maxCenterSequence()));
    assert.strictEqual(backlogDevice1518.rows("applied_operations").length, 1518);
    const replay1518 = await backlogDevice1518.pullAll(100);
    assert.strictEqual(replay1518.length, 0);
    assert.strictEqual(backlogDevice1518.rows("applied_operations").length, 1518);
    console.log("   PASS: 501, 1000, and 1518 changes fully applied with exact cursors and no replay duplicates");

    console.log("9. Payment reversal integrity: offline duplicates, races, and lost response retry");
    const paymentId = `sync-it-payment-${runId}`;
    const paymentCreate = await clients[0].enqueue(
      paymentOperation(uniqueOperation("payment-create"), paymentId, `sync-it-att-student-${runId}`),
    );
    const paymentCreateResponse = await clients[0].push();
    assert.ok(paymentCreateResponse.syncedOperationIds.includes(paymentCreate.operationId));
    await Promise.all(clients.map((client) => client.pullAll()));

    const duplicateReversals = await Promise.all([clients[0], clients[1]].map((client, index) =>
      client.enqueue(reversalOperation(
        uniqueOperation(`offline-reversal-${index}`),
        paymentId,
        `sync-it-reversal-${runId}-${index}`,
      )),
    ));
    const reversalResponses = await Promise.all([clients[0].push(), clients[1].push()]);
    assert.strictEqual(
      reversalResponses.reduce((count, result) => count + result.syncedOperationIds.length, 0),
      1,
      "Exactly one concurrent offline reversal may be accepted",
    );
    assert.strictEqual(
      reversalResponses.flatMap((result) => result.conflicts || [])
        .filter((item) => /PAYMENT_ALREADY_REVERSED/.test(item.reason)).length,
      1,
    );
    const firstReversalRows = await db.query(
      "SELECT COUNT(*)::int AS count FROM payment_reversals WHERE center_id=$1 AND payment_id=$2",
      [centerId, paymentId],
    );
    assert.strictEqual(firstReversalRows.rows[0].count, 1);

    const sequentialDuplicate = await clients[2].enqueue(
      reversalOperation(uniqueOperation("sequential-reversal"), paymentId, `sync-it-reversal-seq-${runId}`),
    );
    const sequentialDuplicateResponse = await clients[2].push();
    assert.ok(sequentialDuplicateResponse.conflicts.some(
      (item) => item.operationId === sequentialDuplicate.operationId && /PAYMENT_ALREADY_REVERSED/.test(item.reason),
    ));
    const reversalAfterSequentialRetry = await db.query(
      "SELECT COUNT(*)::int AS count FROM payment_reversals WHERE center_id=$1 AND payment_id=$2",
      [centerId, paymentId],
    );
    assert.strictEqual(reversalAfterSequentialRetry.rows[0].count, 1);

    const secondPaymentId = `sync-it-payment-loss-${runId}`;
    const secondPayment = await clients[3].enqueue(
      paymentOperation(uniqueOperation("payment-loss-create"), secondPaymentId, `sync-it-att-student-${runId}`),
    );
    assert.ok((await clients[3].push()).syncedOperationIds.includes(secondPayment.operationId));
    await Promise.all(clients.map((client) => client.pullAll()));
    const lostReversal = await clients[2].enqueue(
      reversalOperation(uniqueOperation("reversal-loss"), secondPaymentId, `sync-it-reversal-loss-${runId}`),
    );
    await assert.rejects(clients[2].push({ loseResponse: true }), /Simulated response loss after server commit/);
    assert.strictEqual(
      clients[2].rows("sync_operations").find((row) => row.operation_id === lostReversal.operationId).status,
      "pending",
    );
    assert.ok((await clients[2].push()).syncedOperationIds.includes(lostReversal.operationId));
    const lostRetryRows = await db.query(
      "SELECT COUNT(*)::int AS count FROM payment_reversals WHERE center_id=$1 AND payment_id=$2",
      [centerId, secondPaymentId],
    );
    assert.strictEqual(lostRetryRows.rows[0].count, 1);
    const reversalIndex = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname='public' AND indexname='uq_payment_reversals_payment'`,
    );
    assert.match(reversalIndex.rows[0].indexdef, /UNIQUE.*payment_id/i);
    assert.strictEqual(duplicateReversals.length, 2);
    console.log("   PASS: sequential/concurrent/different-ID/offline reversals and response-loss retry leave one row per payment");

    console.log("10. Debt-cycle revision CAS: stale conflict then refresh-and-retry");
    const beforeCycleUpdate = await clients[0].bootstrap();
    const beforeCycleUpdateB = await clients[1].bootstrap();
    const serverCycle = beforeCycleUpdate.debtCycles.find((cycle) => cycle.id === `sync-it-debt-cycle-${runId}`);
    const serverCycleB = beforeCycleUpdateB.debtCycles.find((cycle) => cycle.id === `sync-it-debt-cycle-${runId}`);
    assert.ok(serverCycle && serverCycleB);
    assert.strictEqual(Number(serverCycle.server_revision), Number(serverCycleB.server_revision));
    const baseRevision = Number(serverCycle.server_revision);
    const cycleA = await clients[0].enqueue(
      debtCycleUpdate(uniqueOperation("debt-cycle-device-a"), baseRevision, { status: "cancelled" }),
    );
    const cycleB = await clients[1].enqueue(
      debtCycleUpdate(uniqueOperation("debt-cycle-device-b"), baseRevision, { status: "waived", cyclePrice: 0 }),
    );
    assert.ok((await clients[0].push()).syncedOperationIds.includes(cycleA.operationId));
    const staleCycleResponse = await clients[1].push();
    assert.ok(staleCycleResponse.conflicts.some(
      (item) => item.operationId === cycleB.operationId && /STALE_UPDATE/.test(item.reason),
    ));
    await clients[1].pullAll();
    const refreshedCycle = clients[1].rows("debt_cycles").find((cycle) => cycle.id === `sync-it-debt-cycle-${runId}`);
    assert.strictEqual(Number(refreshedCycle.server_revision), baseRevision + 1);
    const cycleRetry = await clients[1].enqueue(
      debtCycleUpdate(
        uniqueOperation("debt-cycle-refresh-retry"),
        Number(refreshedCycle.server_revision),
        { status: "waived", cyclePrice: 0 },
      ),
    );
    assert.ok((await clients[1].push()).syncedOperationIds.includes(cycleRetry.operationId));
    const finalCycle = await db.query(
      "SELECT status, server_revision FROM debt_cycles WHERE center_id=$1 AND id=$2",
      [centerId, `sync-it-debt-cycle-${runId}`],
    );
    assert.strictEqual(finalCycle.rows[0].status, "waived");
    assert.strictEqual(Number(finalCycle.rows[0].server_revision), baseRevision + 2);
    console.log("   PASS: stale debt-cycle revision conflicts; pull refresh and new revision retry succeed");

    console.log("11. Final committed ledger visibility and cursor invariants");
    for (const client of clients.slice(0, 4)) {
      const applied = client.rows("applied_operations");
      const sequences = applied.map((row) => Number(row.sequence_number));
      assert.strictEqual(new Set(sequences).size, sequences.length);
    }
    const finalMax = await maxCenterSequence();
    assert.strictEqual(
      backlogDevice1000.cursor(),
      cursorAfterBacklog1000,
      "Later financial operations must not rewrite the backlog device's persisted pull cursor",
    );
    const ledgerRows = await db.query(
      `SELECT operation_id, server_seq::text AS server_seq
       FROM server_sync_operations
       WHERE center_id=$1
       ORDER BY server_sync_operations.server_seq ASC`,
      [centerId],
    );
    const observer = makeClientDatabase("final-ledger-observer");
    observer.userId = clients[0].userId;
    observer.deviceId = clients[0].deviceId;
    observer.token = clients[0].token;
    sqlite(
      observer.filename,
      `INSERT INTO sync_cursors (center_id, server_cursor)
       VALUES (${sqlValue(centerId)}, '0');`,
    );
    const fullyObserved = await observer.pullAll(100);
    const observedLedger = observer.rows("applied_operations");
    assert.strictEqual(fullyObserved.length, ledgerRows.rows.length);
    assert.strictEqual(observedLedger.length, ledgerRows.rows.length);
    for (let index = 0; index < ledgerRows.rows.length; index += 1) {
      assert.strictEqual(
        observedLedger[index].operation_id,
        ledgerRows.rows[index].operation_id,
      );
      assert.strictEqual(
        Number(observedLedger[index].sequence_number),
        Number(ledgerRows.rows[index].server_seq),
      );
    }
    assert.strictEqual(Number(observer.cursor()), finalMax);
    console.log(
      `   PASS: observer applied ${ledgerRows.rows.length} committed ledger rows exactly once through sequence ${finalMax}`,
    );
  } finally {
    await cleanupFixture();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

runTests().catch(async (error) => {
  console.error("FOUR-DEVICE SYNC INTEGRATION FAILED:", error);
  try {
    await cleanupFixture();
  } catch {}
  if (server) {
    try {
      await new Promise((resolve) => server.close(resolve));
    } catch {}
  }
  try {
    await db.pool.end();
  } catch {}
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
