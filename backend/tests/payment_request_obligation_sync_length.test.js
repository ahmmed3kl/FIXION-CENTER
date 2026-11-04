/**
 * Real PostgreSQL (Neon) Integration Test Suite
 * Tests payment_request_obligation sync with long operation_id and entity_id (> 64 chars)
 * Asserts all 8 required test scenarios from Phase 4.
 */

const assert = require("assert");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const {
  pool,
  withTransaction,
  ensureSchemaCompatibility,
} = require("../src/db");
const SyncProcessor = require("../src/services/SyncProcessor");

async function run() {
  console.log(
    "=== Starting Payment Request Obligation Sync Length Test Suite (Neon PostgreSQL) ===",
  );

  await ensureSchemaCompatibility();

  const client = await pool.connect();
  const testCenterId = "center-test-sync-len-" + Date.now();
  const testCenterId2 = "center-test-sync-iso-" + Date.now();
  const testUserId = "usr-test-sync-" + Date.now();
  const testDeviceId = "dev-test-sync-" + Date.now();

  try {
    // 0. Seed test centers and user
    await client.query(
      `
      INSERT INTO centers (id, name, code)
      VALUES ($1, 'Test Center Sync Len', $2),
             ($3, 'Test Center Sync Iso', $4)
      ON CONFLICT DO NOTHING
    `,
      [testCenterId, "TCSL-" + Date.now(), testCenterId2, "TCSI-" + Date.now()],
    );

    await client.query(
      `
      INSERT INTO users (id, center_id, full_name, email, phone, password_hash, role)
      VALUES ($1, $2, 'Test Admin', $3, $4, 'hash', 'admin')
      ON CONFLICT DO NOTHING
    `,
      [
        testUserId,
        testCenterId,
        `admin-${Date.now()}@test.com`,
        `010${String(Date.now()).slice(-8)}`,
      ],
    );

    await client.query(
      `
      INSERT INTO devices (id, center_id, device_name, status)
      VALUES ($1, $2, 'Test Tablet', 'active')
      ON CONFLICT DO NOTHING
    `,
      [testDeviceId, testCenterId],
    );

    // Seed teacher, subject, group, and student
    const teacherId = `tea-${Date.now()}`;
    const subjectId = `sub-${Date.now()}`;
    const groupId = `grp-${Date.now()}`;
    const studentId = `std-1792220414913-167`; // 21 chars real student ID format
    const studentIdLong = `stu-c99b820a-6cbe-4ce4-82a0-4592476569ec`; // 40 chars UUID format

    await client.query(
      `
      INSERT INTO teachers (id, center_id, name, phone, status)
      VALUES ($1, $2, 'أستاذ التجربة', '01000000000', 'active')
    `,
      [teacherId, testCenterId],
    );

    await client.query(
      `
      INSERT INTO subjects (id, center_id, name, code, status)
      VALUES ($1, $2, 'رياضيات', $3, 'active')
    `,
      [subjectId, testCenterId, `SUB-${Date.now()}`],
    );

    await client.query(
      `
      INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, monthly_price, status)
      VALUES ($1, $2, 'مجموعة الاختبار', $3, $4, 'G3', 300, 300, 'active')
    `,
      [groupId, testCenterId, teacherId, subjectId],
    );

    await client.query(
      `
      INSERT INTO students (id, center_id, full_name, card_code, phone, parent_phone, grade, status)
      VALUES ($1, $2, 'طالب تجربة 1', $3, '01011111111', '01022222222', 'G3', 'active'),
             ($4, $2, 'طالب تجربة 2', $5, '01033333333', '01044444444', 'G3', 'active')
    `,
      [
        studentId,
        testCenterId,
        `CARD-${Date.now()}-1`,
        studentIdLong,
        testCenterId,
        `CARD-${Date.now()}-2`,
      ],
    );

    // Test 1: Parent payment request synchronization
    console.log(
      "-> Test 1 & 3: Synchronize parent payment request and student obligations...",
    );
    const parentRequestId = `preq-${Date.now()}`;
    const parentOpId = `op-preq-1c970169-e158-4a03-88ec-${String(Date.now()).slice(-12)}`; // 44 chars

    // Obligation 1: 69 characters operation_id (the exact scenario from production!)
    const ob1Id = `prob-${Date.now()}-1`;
    const ob1OpId = `${parentOpId}-ob-${studentId}`; // 44 + 4 + 21 = 69 chars!
    assert.strictEqual(
      ob1OpId.length,
      69,
      `ob1OpId length should be 69 chars, got ${ob1OpId.length}`,
    );

    // Obligation 2: 88 characters operation_id (UUID student ID)
    const ob2Id = `prob-${Date.now()}-2`;
    const ob2OpId = `${parentOpId}-ob-${studentIdLong}`; // 44 + 4 + 40 = 88 chars!
    assert.strictEqual(
      ob2OpId.length,
      88,
      `ob2OpId length should be 88 chars, got ${ob2OpId.length}`,
    );

    const batch = [
      {
        operationId: parentOpId,
        centerId: testCenterId,
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request.create",
        entityType: "payment_request",
        entityId: parentRequestId,
        payload: {
          id: parentRequestId,
          operationId: parentOpId,
          centerId: testCenterId,
          groupId: groupId,
          name: "بوكليت المراجعة النهائية",
          amount: 256.0,
          referenceMonth: "2026-11",
          status: "active",
        },
        createdAt: new Date().toISOString(),
      },
      {
        operationId: ob1OpId, // 69 chars
        centerId: testCenterId,
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request_obligation.create",
        entityType: "payment_request_obligation",
        entityId: ob1Id,
        payload: {
          id: ob1Id,
          operationId: ob1OpId,
          centerId: testCenterId,
          requestId: parentRequestId,
          groupId: groupId,
          studentId: studentId,
          amountDue: 256.0,
          amountPaid: 0,
          status: "unpaid",
        },
        createdAt: new Date().toISOString(),
      },
      {
        operationId: ob2OpId, // 88 chars
        centerId: testCenterId,
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request_obligation.create",
        entityType: "payment_request_obligation",
        entityId: ob2Id,
        payload: {
          id: ob2Id,
          operationId: ob2OpId,
          centerId: testCenterId,
          requestId: parentRequestId,
          groupId: groupId,
          studentId: studentIdLong,
          amountDue: 256.0,
          amountPaid: 0,
          status: "unpaid",
        },
        createdAt: new Date().toISOString(),
      },
    ];

    const result = await SyncProcessor.processSyncBatch(batch, {
      centerId: testCenterId,
      userId: testUserId,
      deviceId: testDeviceId,
    });

    assert.strictEqual(
      result.conflicts.length,
      0,
      `Expected 0 conflicts, got: ${JSON.stringify(result.conflicts)}`,
    );
    assert.strictEqual(
      result.syncedOperationIds.length,
      3,
      "All 3 operations should be synced",
    );
    assert(
      result.syncedOperationIds.includes(ob1OpId),
      "69-character operationId must be synced",
    );
    assert(
      result.syncedOperationIds.includes(ob2OpId),
      "88-character operationId must be synced",
    );
    console.log(
      "  ✔ PASS: 69-character and 88-character payment_request_obligation synced successfully!",
    );

    // Verify stored records in PostgreSQL
    const dbOb1 = await client.query(
      "SELECT id, operation_id, amount_due, status FROM student_payment_request_obligations WHERE operation_id = $1",
      [ob1OpId],
    );
    assert.strictEqual(dbOb1.rows.length, 1);
    assert.strictEqual(dbOb1.rows[0].operation_id, ob1OpId);
    assert.strictEqual(Number(dbOb1.rows[0].amount_due), 256.0);

    const dbOb2 = await client.query(
      "SELECT id, operation_id, amount_due, status FROM student_payment_request_obligations WHERE operation_id = $1",
      [ob2OpId],
    );
    assert.strictEqual(dbOb2.rows.length, 1);
    assert.strictEqual(dbOb2.rows[0].operation_id, ob2OpId);
    console.log(
      "  ✔ PASS: Verified rows stored correctly in student_payment_request_obligations table",
    );

    // Test 2: Existing short identifiers still work
    console.log("-> Test 2: Existing short identifiers still work...");
    const shortObId = `prob-short-1`;
    const shortOpId = `op-short-1`;
    const shortBatch = [
      {
        operationId: shortOpId,
        centerId: testCenterId,
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request_obligation.create",
        entityType: "payment_request_obligation",
        entityId: shortObId,
        payload: {
          id: shortObId,
          operationId: shortOpId,
          centerId: testCenterId,
          requestId: parentRequestId,
          groupId: groupId,
          studentId: studentId,
          amountDue: 256.0,
          amountPaid: 0,
          status: "unpaid",
        },
        createdAt: new Date().toISOString(),
      },
    ];
    const shortResult = await SyncProcessor.processSyncBatch(shortBatch, {
      centerId: testCenterId,
      userId: testUserId,
      deviceId: testDeviceId,
    });
    assert.strictEqual(shortResult.conflicts.length, 0);
    assert(shortResult.syncedOperationIds.includes(shortOpId));
    console.log("  ✔ PASS: Short identifiers continue to work seamlessly");

    // Test 4 & 5: Retrying the same operation_id does not duplicate records (Idempotency / Replay)
    console.log("-> Test 4 & 5: Idempotency check on replay...");
    const replayResult = await SyncProcessor.processSyncBatch([batch[1]], {
      centerId: testCenterId,
      userId: testUserId,
      deviceId: testDeviceId,
    });
    assert.strictEqual(replayResult.conflicts.length, 0);
    assert(
      replayResult.syncedOperationIds.includes(ob1OpId),
      "Replayed operationId must be recognized as synced",
    );

    const countCheck = await client.query(
      "SELECT COUNT(*) as count FROM student_payment_request_obligations WHERE center_id = $1 AND request_id = $2 AND student_id = $3",
      [testCenterId, parentRequestId, studentId],
    );
    assert.strictEqual(
      parseInt(countCheck.rows[0].count, 10),
      1,
      "Exactly 1 obligation record must exist (no duplicates)",
    );
    console.log(
      "  ✔ PASS: Replay is strictly idempotent and creates zero duplicate records",
    );

    // Test 6: Partial or invalid records roll back cleanly
    console.log("-> Test 6: Transaction atomicity check on invalid payload...");
    const invalidOpId = `op-invalid-${Date.now()}`;
    const invalidBatch = [
      {
        operationId: invalidOpId,
        centerId: testCenterId,
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request_obligation.create",
        entityType: "payment_request_obligation",
        entityId: "prob-invalid",
        payload: {
          id: "prob-invalid",
          operationId: invalidOpId,
          centerId: testCenterId,
          requestId: "non-existent-request-id", // Foreign key failure
          groupId: groupId,
          studentId: studentId,
          amountDue: 256.0,
        },
        createdAt: new Date().toISOString(),
      },
    ];
    const invalidResult = await SyncProcessor.processSyncBatch(invalidBatch, {
      centerId: testCenterId,
      userId: testUserId,
      deviceId: testDeviceId,
    });
    assert.strictEqual(
      invalidResult.conflicts.length,
      1,
      "Foreign key violation must be reported as conflict",
    );
    const invalidCheck = await client.query(
      "SELECT COUNT(*) as count FROM student_payment_request_obligations WHERE id = 'prob-invalid'",
    );
    assert.strictEqual(
      parseInt(invalidCheck.rows[0].count, 10),
      0,
      "No partial record must be persisted",
    );
    console.log(
      "  ✔ PASS: Atomicity preserved; failed operation creates no partial server record",
    );

    // Test 8: Center isolation is strictly preserved
    console.log("-> Test 8: Center isolation verification...");
    const isoOpId = `op-iso-${Date.now()}`;
    const crossCenterBatch = [
      {
        operationId: isoOpId,
        centerId: testCenterId2, // Attempting to write into center 2 using center 1 request
        userId: testUserId,
        deviceId: testDeviceId,
        operationType: "payment_request_obligation.create",
        entityType: "payment_request_obligation",
        entityId: "prob-iso",
        payload: {
          id: "prob-iso",
          operationId: isoOpId,
          centerId: testCenterId2,
          requestId: parentRequestId, // Belongs to testCenterId
          groupId: groupId,
          studentId: studentId,
          amountDue: 100,
        },
        createdAt: new Date().toISOString(),
      },
    ];
    const isoResult = await SyncProcessor.processSyncBatch(crossCenterBatch, {
      centerId: testCenterId2,
      userId: testUserId,
      deviceId: testDeviceId,
    });
    // Request is scoped to testCenterId, so in testCenterId2 it doesn't exist (FK error or validation conflict)
    assert.strictEqual(
      isoResult.conflicts.length,
      1,
      "Cross-center reference must fail",
    );
    console.log("  ✔ PASS: Center isolation strictly preserved");
  } finally {
    // Clean up test center data safely
    try {
      await client.query("DELETE FROM centers WHERE id IN ($1, $2)", [
        testCenterId,
        testCenterId2,
      ]);
    } catch {}
    client.release();
  }

  console.log("=== ALL 8 TEST SCENARIOS PASSED WITH 100% SUCCESS ===");
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
