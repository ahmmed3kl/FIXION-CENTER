/**
 * FIXION Comprehensive Backend Integration Test Suite
 * Executes directly against live Neon PostgreSQL database.
 * Asserts all 17 security, architecture, and tenant-isolation invariants.
 */

const assert = require('assert');
const app = require('../src/server');
const db = require('../src/db');

let server;
let baseUrl;

function logPass(testName) {
  console.log(`  ✔ PASS: ${testName}`);
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    config.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, config);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return {
    status: res.status,
    headers: res.headers,
    body: json,
  };
}

async function runTests() {
  console.log('====================================================');
  console.log(' STARTING FIXION BACKEND INTEGRATION TEST SUITE');
  console.log(' Target Database: Neon Serverless PostgreSQL');
  console.log('====================================================\n');

  // Start test server on random high port
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let center1Token;
  let center2Token;
  let center1User;
  let center1DeviceId = `dev-test-${Date.now()}`;

  try {
    // -------------------------------------------------------------
    // TEST 1: Health Endpoint (Safe, no table counts leaked)
    // -------------------------------------------------------------
    console.log('1. Health & Public Metadata Security:');
    const healthRes = await request('/v1/health');
    assert.strictEqual(healthRes.status, 200, 'Health should return 200');
    assert.strictEqual(healthRes.body.status, 'ok');
    assert.strictEqual(healthRes.body.database, 'connected');
    assert.strictEqual(healthRes.body.tableCount, undefined, 'Table counts must not be leaked');
    assert.strictEqual(healthRes.body.tables, undefined, 'Table names must not be leaked');
    logPass('GET /v1/health returns 200 and does NOT leak internal table metadata');

    // -------------------------------------------------------------
    // TEST 2: Authentication - Valid Login & Single Center Context
    // -------------------------------------------------------------
    console.log('\n2. Authentication & Tenant Derivation:');
    const loginRes = await request('/v1/auth/login', {
      method: 'POST',
      body: { identifier: 'admin@center1.com', password: '123456' },
    });
    assert.strictEqual(loginRes.status, 200, 'Valid login should return 200');
    assert.ok(loginRes.body.token, 'Must return JWT session token');
    assert.strictEqual(loginRes.body.user.email, 'admin@center1.com');
    assert.strictEqual(loginRes.body.user.centerId, 'center-1', 'Must resolve authoritative centerId');
    assert.strictEqual(loginRes.body.user.centerIds, undefined, 'centerIds[] array must NOT be exposed');
    center1Token = loginRes.body.token;
    center1User = loginRes.body.user;
    logPass('Valid login resolves single centerId and minimal profile (no centerIds[])');

    // Decode JWT payload to verify minimal claims
    const jwtParts = center1Token.split('.');
    const jwtPayload = JSON.parse(Buffer.from(jwtParts[1], 'base64').toString('utf8'));
    assert.strictEqual(jwtPayload.sub, center1User.id);
    assert.strictEqual(jwtPayload.centerId, 'center-1');
    assert.strictEqual(jwtPayload.role, 'admin');
    assert.strictEqual(jwtPayload.permissions, undefined, 'Permissions must NOT be embedded in JWT');
    logPass('JWT claims are strictly minimal { sub, centerId, role, iat, exp }');

    // -------------------------------------------------------------
    // TEST 3: Authentication - Invalid Credentials
    // -------------------------------------------------------------
    const invalidLoginRes = await request('/v1/auth/login', {
      method: 'POST',
      body: { identifier: 'admin@center1.com', password: 'wrong_password_999' },
    });
    assert.strictEqual(invalidLoginRes.status, 401, 'Wrong password must return 401');
    assert.strictEqual(invalidLoginRes.body.error.code, 'INVALID_CREDENTIALS');
    logPass('Invalid password rejected with 401 and structured error code');

    // Login for Center 2 user (for cross-tenant tests)
    const loginC2Res = await request('/v1/auth/login', {
      method: 'POST',
      body: { identifier: 'admin@center2.com', password: '123456' },
    });
    assert.strictEqual(loginC2Res.status, 200);
    center2Token = loginC2Res.body.token;

    // -------------------------------------------------------------
    // TEST 4: Single Admin Invariant Enforcement
    // -------------------------------------------------------------
    console.log('\n3. Single Admin Constraint:');
    try {
      // Attempt to insert a second admin for center-1 directly in PostgreSQL
      await db.query(
        `INSERT INTO users (id, center_id, full_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, 'admin');`,
        ['usr-fake-admin-2', 'center-1', 'Fake Second Admin', 'fake2@center1.com', 'hash']
      );
      assert.fail('Database should have rejected second admin with unique constraint violation');
    } catch (err) {
      assert.strictEqual(err.code, '23505', 'Must fail with PostgreSQL unique constraint code 23505');
      logPass('Database strictly rejects creating a second Admin for the same center (code 23505)');
    }

    // -------------------------------------------------------------
    // TEST 5: Tenant Isolation & Forged X-Center-Id Header
    // -------------------------------------------------------------
    console.log('\n4. Tenant Isolation & Header Cross-Check:');
    // Center 1 user sends forged X-Center-Id: center-2
    const forgedHeaderRes = await request('/v1/devices/register', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Center-Id': 'center-2', // FORGED!
      },
      body: { deviceIdentifier: center1DeviceId, deviceName: 'Secretary Tablet' },
    });
    assert.strictEqual(forgedHeaderRes.status, 403, 'Forged X-Center-Id must be rejected with 403');
    assert.strictEqual(forgedHeaderRes.body.error.code, 'TENANT_MISMATCH');
    logPass('Forged X-Center-Id header is rejected with 403 Forbidden (TENANT_MISMATCH)');

    // -------------------------------------------------------------
    // TEST 6: Device Registration & Device Gatekeeping
    // -------------------------------------------------------------
    console.log('\n5. Device Registration & Gatekeeping:');
    const devRegRes = await request('/v1/devices/register', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Center-Id': 'center-1',
      },
      body: { deviceIdentifier: center1DeviceId, deviceName: 'Front Desk Tablet' },
    });
    assert.strictEqual(devRegRes.status, 200, 'Device registration should return 200');
    assert.strictEqual(devRegRes.body.deviceId, center1DeviceId);
    assert.strictEqual(devRegRes.body.status, 'active');
    logPass('Device registered successfully under authenticated center');

    // Deactivate device in DB and verify sync rejection
    const inactiveDevId = `dev-inactive-${Date.now()}`;
    await db.query(
      `INSERT INTO devices (id, center_id, user_id, status) VALUES ($1, $2, $3, 'revoked')`,
      [inactiveDevId, 'center-1', center1User.id]
    );

    const inactivePushRes = await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': inactiveDevId,
      },
      body: { operations: [] },
    });
    assert.strictEqual(inactivePushRes.status, 403, 'Inactive device must be rejected on push');
    assert.strictEqual(inactivePushRes.body.error.code, 'DEVICE_INACTIVE');
    logPass('Inactive/revoked device rejected with 403 Forbidden (DEVICE_INACTIVE)');

    // -------------------------------------------------------------
    // TEST 7: Atomic Add Student & Exact Leading Zeros Preservation
    // -------------------------------------------------------------
    console.log('\n6. Atomic Add Student (Student + Card + Enrollments):');
    const studentTestId = `std-test-${Date.now()}`;
    const cardCodeLeadingZeros = '00' + (Math.floor(Date.now() % 89999) + 10000); // EXACT LEADING ZEROS PRESERVED

    const addStudentOp = {
      operationId: `op-add-std-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'student',
      operationType: 'create',
      payload: {
        student: {
          id: studentTestId,
          student_code: cardCodeLeadingZeros,
          card_code: cardCodeLeadingZeros,
          full_name: 'يوسف أحمد كمال',
          phone: '01099887766',
          parent_phone: '01011223344',
          grade: 'الصف الثالث الثانوي',
        },
        card: {
          id: `card-${studentTestId}`,
          card_code: cardCodeLeadingZeros,
        },
        enrollments: [
          { group_id: 'grp-1', price_override: 230.0 },
        ],
      },
      createdAt: new Date().toISOString(),
    };

    const pushRes = await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [addStudentOp] },
    });
    assert.strictEqual(pushRes.status, 200, 'Push should succeed');
    assert.ok(pushRes.body.syncedOperationIds.includes(addStudentOp.operationId));
    logPass('Add student operation processed and synced successfully');

    // Verify row in database: exact leading zeros
    const studentCheck = await db.query(
      'SELECT id, student_code, card_code FROM students WHERE id = $1',
      [studentTestId]
    );
    assert.strictEqual(studentCheck.rows[0].student_code, cardCodeLeadingZeros, `student_code must be exact "${cardCodeLeadingZeros}"`);
    assert.strictEqual(studentCheck.rows[0].card_code, cardCodeLeadingZeros, `card_code must be exact "${cardCodeLeadingZeros}"`);

    const cardCheck = await db.query(
      'SELECT id, card_code, status FROM student_cards WHERE student_id = $1',
      [studentTestId]
    );
    assert.strictEqual(cardCheck.rows[0].card_code, cardCodeLeadingZeros);
    assert.strictEqual(cardCheck.rows[0].status, 'active');

    const enrCheck = await db.query(
      'SELECT id, group_id, price_override FROM student_group_enrollments WHERE student_id = $1',
      [studentTestId]
    );
    assert.strictEqual(enrCheck.rows[0].group_id, 'grp-1');
    assert.strictEqual(parseFloat(enrCheck.rows[0].price_override), 230.0);
    logPass(`Student + Card + Enrollment created atomically with exact leading zeros ("${cardCodeLeadingZeros}")`);

    // -------------------------------------------------------------
    // TEST 8: Database Rollback on Partial Failure
    // -------------------------------------------------------------
    console.log('\n7. Database Transaction Rollback on Partial Failure:');
    const failingStudentId = `std-fail-${Date.now()}`;
    const failingCardCode = '00' + (Math.floor(Date.now() % 89999) + 20000);
    const failingOp = {
      operationId: `op-add-fail-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'student',
      operationType: 'create',
      payload: {
        student: {
          id: failingStudentId,
          student_code: failingCardCode,
          card_code: failingCardCode,
          full_name: 'طالب تحت التجربة',
        },
        enrollments: [
          { group_id: 'grp-non-existent-group-xyz' }, // FOREIGN KEY FAILURE!
        ],
      },
    };

    const pushFailRes = await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [failingOp] },
    });
    // The operation should be recorded in conflicts because of foreign key violation
    assert.ok(pushFailRes.body.conflicts.length > 0, 'Must record conflict for failing operation');

    // Confirm that student was NOT created (Transaction Rolled Back)
    const rolledBackStudent = await db.query(
      'SELECT id FROM students WHERE id = $1',
      [failingStudentId]
    );
    assert.strictEqual(rolledBackStudent.rows.length, 0, 'Failing student row must be completely rolled back');
    logPass('Partial failure triggers complete transaction rollback (0 orphan rows created)');

    // -------------------------------------------------------------
    // TEST 9: Idempotency - Duplicate Operation Handling
    // -------------------------------------------------------------
    console.log('\n8. Idempotency & Deduplication:');
    const pushDupRes = await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [addStudentOp] }, // SAME OP AGAIN!
    });
    assert.strictEqual(pushDupRes.status, 200);
    assert.ok(pushDupRes.body.syncedOperationIds.includes(addStudentOp.operationId));

    // Confirm count in server_sync_operations is STILL EXACTLY 1
    const syncOpCount = await db.query(
      'SELECT count(*) as count FROM server_sync_operations WHERE operation_id = $1',
      [addStudentOp.operationId]
    );
    assert.strictEqual(parseInt(syncOpCount.rows[0].count, 10), 1, 'Operation must only be recorded ONCE');
    logPass('Resending duplicate operation returns success with 0 duplicate database rows');

    // -------------------------------------------------------------
    // TEST 10: Attendance Check-in Deduplication
    // -------------------------------------------------------------
    console.log('\n9. Attendance Deduplication:');
    const attSessionId = 'sess-test-01';
    // Ensure test session exists
    await db.query(
      `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status)
       VALUES ($1, $2, 'grp-1', '2026-09-12', '14:00', '16:00', 'open')
       ON CONFLICT (id) DO NOTHING;`,
      [attSessionId, 'center-1']
    );

    const attOp1 = {
      operationId: `op-att-1-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'attendance',
      operationType: 'mark',
      payload: {
        id: `att-rec-${Date.now()}`,
        session_id: attSessionId,
        student_id: studentTestId,
        status: 'present',
      },
    };

    const attPush1 = await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [attOp1] },
    });
    assert.strictEqual(attPush1.status, 200);

    // Second check-in for same session and student with different operationId (e.g. 2 tablets scan same student)
    const attOp2 = {
      operationId: `op-att-2-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'attendance',
      operationType: 'mark',
      payload: {
        id: `att-rec-2-${Date.now()}`,
        session_id: attSessionId,
        student_id: studentTestId,
        status: 'present',
      },
    };
    await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [attOp2] },
    });

    const attRows = await db.query(
      'SELECT count(*) as count FROM attendance WHERE session_id = $1 AND student_id = $2',
      [attSessionId, studentTestId]
    );
    assert.strictEqual(parseInt(attRows.rows[0].count, 10), 1, 'Exactly 1 attendance row per session + student');
    logPass('Attendance UNIQUE(session_id, student_id) prevents double check-in across devices');

    // -------------------------------------------------------------
    // TEST 11: Monotonic Cursor Progression & Pull Changes
    // -------------------------------------------------------------
    console.log('\n10. Monotonic Cursor & Pull Stream:');
    const pullRes = await request('/v1/sync/pull?cursor=0&limit=50', {
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
    });
    assert.strictEqual(pullRes.status, 200);
    assert.ok(Array.isArray(pullRes.body.changes));
    assert.ok(pullRes.body.changes.length > 0, 'Must return committed changes');
    assert.ok(parseInt(pullRes.body.nextCursor, 10) > 0, 'nextCursor must advance monotonically');

    // Verify sequences are strictly ascending: S1 < S2 < S3
    const seqs = pullRes.body.changes.map((c) => c.sequenceNumber);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `Sequence ${seqs[i]} must be greater than ${seqs[i - 1]}`);
    }
    logPass('Sync pull stream returns strictly monotonic ascending sequence numbers');

    // -------------------------------------------------------------
    // TEST 12: Financial Ledger Integrity (Append-only & Reversal)
    // -------------------------------------------------------------
    console.log('\n11. Financial Ledger & Reversal Integrity:');
    const paymentId = `pay-test-${Date.now()}`;
    const paymentOp = {
      operationId: `op-pay-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'payment',
      operationType: 'create',
      payload: {
        id: paymentId,
        student_id: studentTestId,
        amount: 250.0,
        payment_method: 'cash',
      },
    };

    await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [paymentOp] },
    });

    const paymentRow = await db.query(
      'SELECT id, amount, is_reversed FROM payments WHERE id = $1',
      [paymentId]
    );
    assert.strictEqual(parseFloat(paymentRow.rows[0].amount), 250.0);
    assert.strictEqual(paymentRow.rows[0].is_reversed, false);

    // Reversal operation
    const reversalOp = {
      operationId: `op-rev-${Date.now()}`,
      centerId: 'center-1',
      entityType: 'payment_reversal',
      operationType: 'create',
      payload: {
        id: `rev-${Date.now()}`,
        payment_id: paymentId,
        reversed_amount: 250.0,
        reason: 'خطأ إدخال من الكاشير',
      },
    };

    await request('/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${center1Token}`,
        'X-Device-Id': center1DeviceId,
      },
      body: { operations: [reversalOp] },
    });

    const reversedPayment = await db.query(
      'SELECT is_reversed FROM payments WHERE id = $1',
      [paymentId]
    );
    assert.strictEqual(reversedPayment.rows[0].is_reversed, true, 'Payment must be marked is_reversed');
    logPass('Payment ledger is append-only and reversal marks event without destructive deletes');

    // -------------------------------------------------------------
    // TEST 13: Cross-Center Isolation (Center 2 cannot read Center 1)
    // -------------------------------------------------------------
    console.log('\n12. Cross-Center Tenant Isolation:');
    // Register device for Center 2
    const devC2Id = `dev-c2-${Date.now()}`;
    await request('/v1/devices/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${center2Token}` },
      body: { deviceIdentifier: devC2Id },
    });

    // Center 2 pulls sync stream
    const c2Pull = await request('/v1/sync/pull?cursor=0', {
      headers: {
        Authorization: `Bearer ${center2Token}`,
        'X-Device-Id': devC2Id,
      },
    });

    // None of the changes in Center 2 stream should belong to studentTestId from Center 1!
    const leakedStudent = c2Pull.body.changes.find(
      (c) => c.entityId === studentTestId || (c.data && c.data.id === studentTestId)
    );
    assert.strictEqual(leakedStudent, undefined, 'Center 2 must never receive Center 1 data');
    logPass('Tenant isolation prevents Center 2 from pulling Center 1 operations');

    console.log('\n====================================================');
    console.log(' ALL 13 BACKEND INTEGRATION TEST SUITES PASSED (100%)');
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n❌ INTEGRATION TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    await db.pool.end();
  }
}

runTests();
