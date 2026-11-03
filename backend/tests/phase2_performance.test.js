const assert = require("assert");
const db = require("../src/db");
const zadxSmsProvider = require("../src/services/zadxSmsProvider");
const { requireService } = require("../src/middleware/serviceGuard");
const SyncProcessor = require("../src/services/SyncProcessor");

async function runPhase2Tests() {
  console.log("Running Phase 2 Backend Performance & Safety Tests...\n");

  const originalWithTransaction = db.withTransaction;
  const originalDbQuery = db.query;
  const originalIsConfigured = zadxSmsProvider.isConfigured;
  const originalSend = zadxSmsProvider.send;

  try {
    // =========================================================================
    // TEST 1: SMS Delivery Outside Transaction & Lock + Retry Idempotency
    // =========================================================================
    {
      const timeline = [];
      let inTransaction = false;
      let centerLockHeld = false;
      let smsSendCallCount = 0;

      const deliveriesTable = new Map();
      const ledgerTable = new Map();

      zadxSmsProvider.isConfigured = () => true;
      zadxSmsProvider.send = async ({ to, message, idempotencyKey }) => {
        smsSendCallCount += 1;
        timeline.push({
          step: "ZADX_SMS_SEND",
          inTransaction,
          centerLockHeld,
          deliveryStatusDuringSend: deliveriesTable.get("deliv-1")?.status,
          dispatchStateDuringSend:
            deliveriesTable.get("deliv-1")?.response_payload?.dispatchState,
          to,
          message,
          idempotencyKey,
        });
        return {
          accepted: true,
          httpStatus: 200,
          providerMessageId: "zadx-msg-101",
        };
      };

      const mockClient = {
        query: async (sql, params = []) => {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          if (normalizedSql.includes("INSERT INTO center_data_state")) {
            return { rows: [] };
          }
          if (
            normalizedSql.includes("FROM center_data_state") &&
            normalizedSql.includes("FOR UPDATE")
          ) {
            centerLockHeld = true;
            timeline.push({ step: "ACQUIRE_CENTER_LOCK", inTransaction });
            return { rows: [{ center_id: params[0] }] };
          }
          if (normalizedSql.includes("MAX(server_seq)")) {
            return { rows: [{ max_seq: ledgerTable.size }] };
          }
          if (
            normalizedSql.includes(
              "FROM server_sync_operations WHERE operation_id = ANY",
            )
          ) {
            const ids = params[0] || [];
            const rows = ids
              .map((id) => ledgerTable.get(id))
              .filter(Boolean);
            return { rows };
          }
          if (
            normalizedSql.startsWith("SAVEPOINT") ||
            normalizedSql.startsWith("RELEASE SAVEPOINT") ||
            normalizedSql.startsWith("ROLLBACK TO SAVEPOINT")
          ) {
            return { rows: [] };
          }
          if (normalizedSql.includes("FROM notification_events")) {
            return {
              rows: [
                {
                  id: params[1],
                  event_type: "attendance",
                  student_id: "stu-1",
                  session_id: "ses-1",
                  recipient_phone: "01012345678",
                },
              ],
            };
          }
          if (
            normalizedSql.includes("FROM notification_deliveries") &&
            normalizedSql.includes("FOR UPDATE")
          ) {
            const existing = deliveriesTable.get(params[0]);
            return { rows: existing ? [{ ...existing }] : [] };
          }
          if (normalizedSql.includes("FROM center_services")) {
            return { rows: [{ enabled: true }] };
          }
          if (normalizedSql.startsWith("INSERT INTO notification_deliveries")) {
            const [id, centerId, eventId, provider, retryCount, payloadJson] =
              params;
            const existing = deliveriesTable.get(id);
            const parsedPayload = JSON.parse(payloadJson);
            if (!existing) {
              deliveriesTable.set(id, {
                id,
                center_id: centerId,
                notification_event_id: eventId,
                provider,
                status: "queued",
                retry_count: retryCount,
                response_payload: parsedPayload,
                provider_message_id: null,
              });
            } else if (
              existing.status !== "sent" &&
              existing.status !== "delivered"
            ) {
              deliveriesTable.set(id, {
                ...existing,
                status: "queued",
                retry_count: Math.max(existing.retry_count, retryCount),
                response_payload: parsedPayload,
              });
            }
            timeline.push({
              step: "UPSERT_DELIVERY_IN_TX",
              inTransaction,
              centerLockHeld,
              status: deliveriesTable.get(id).status,
            });
            return { rowCount: 1, rows: [] };
          }
          if (
            normalizedSql.includes(
              "SELECT id, notification_event_id, provider, status, retry_count, provider_message_id FROM notification_deliveries",
            )
          ) {
            const row = deliveriesTable.get(params[1]);
            return { rows: row ? [{ ...row }] : [] };
          }
          if (normalizedSql.startsWith("INSERT INTO server_sync_operations")) {
            const [
              operationId,
              centerId,
              ,
              ,
              operationType,
              entityType,
              entityId,
              payloadJson,
            ] = params;
            const seq = ledgerTable.size + 1;
            ledgerTable.set(operationId, {
              operation_id: operationId,
              server_seq: seq,
              status: "applied",
              center_id: centerId,
              operation_type: operationType,
              entity_type: entityType,
              entity_id: entityId,
              payload: JSON.parse(payloadJson),
            });
            return { rows: [{ server_seq: seq }] };
          }
          if (
            normalizedSql.startsWith("INSERT INTO audit_logs") ||
            normalizedSql.startsWith("INSERT INTO sync_checkpoints")
          ) {
            return { rows: [] };
          }
          throw new Error(`Unexpected client SQL in Test 1: ${normalizedSql}`);
        },
      };

      db.withTransaction = async (cb) => {
        inTransaction = true;
        timeline.push({ step: "BEGIN_TX" });
        try {
          const res = await cb(mockClient);
          inTransaction = false;
          centerLockHeld = false;
          timeline.push({ step: "COMMIT_TX_AND_RELEASE_LOCK" });
          return res;
        } catch (err) {
          inTransaction = false;
          centerLockHeld = false;
          throw err;
        }
      };

      db.query = async (sql, params = []) => {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        if (
          normalizedSql.startsWith("SELECT id FROM notification_deliveries")
        ) {
          const centerId = params[0];
          const rows = [];
          for (const d of deliveriesTable.values()) {
            if (
              d.center_id === centerId &&
              d.provider === "sms" &&
              d.status === "queued" &&
              (d.response_payload?.dispatchState || "pending") === "pending"
            ) {
              rows.push({ id: d.id });
            }
          }
          return { rows };
        }
        if (
          normalizedSql.startsWith("UPDATE notification_deliveries") &&
          normalizedSql.includes("'sending'")
        ) {
          const [centerId, id] = params;
          const row = deliveriesTable.get(id);
          if (
            !row ||
            row.center_id !== centerId ||
            row.status !== "queued" ||
            (row.response_payload?.dispatchState || "pending") !== "pending"
          ) {
            return { rows: [] };
          }
          row.response_payload = {
            ...row.response_payload,
            dispatchState: "sending",
          };
          timeline.push({
            step: "ATOMIC_CLAIM_DELIVERY",
            inTransaction,
            centerLockHeld,
          });
          return { rows: [{ ...row }] };
        }
        if (normalizedSql.includes("FROM center_services")) {
          return { rows: [{ enabled: true }] };
        }
        if (
          normalizedSql.startsWith("UPDATE notification_deliveries") &&
          normalizedSql.includes("SET status = 'sent'")
        ) {
          const [providerMessageId, payloadJson, id, centerId] = params;
          const row = deliveriesTable.get(id);
          if (row && row.center_id === centerId) {
            row.status = "sent";
            row.provider_message_id = providerMessageId;
            row.response_payload = JSON.parse(payloadJson);
          }
          timeline.push({
            step: "MARK_DELIVERY_SENT",
            inTransaction,
            centerLockHeld,
          });
          return { rows: row ? [{ ...row }] : [] };
        }
        if (normalizedSql.startsWith("UPDATE server_sync_operations")) {
          const [payloadJson, centerId, entityId] = params;
          for (const entry of ledgerTable.values()) {
            if (
              entry.center_id === centerId &&
              entry.entity_type === "notification_delivery" &&
              entry.entity_id === entityId
            ) {
              entry.payload = JSON.parse(payloadJson);
            }
          }
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected pool SQL in Test 1: ${normalizedSql}`);
      };

      const smsOperation = {
        operationId: "op-sms-1",
        centerId: "center-1",
        entityType: "notification_delivery",
        entityId: "deliv-1",
        operationType: "create",
        payload: {
          id: "deliv-1",
          notification_event_id: "nev-1",
          channel: "sms",
          status: "pending",
          recipient: "01012345678",
          rendered_message: "تم تسجيل حضور الطالب",
        },
      };

      const pushRes1 = await SyncProcessor.processPush(
        "center-1",
        "usr-1",
        "dev-1",
        [smsOperation],
      );
      assert.strictEqual(pushRes1.success, true);
      assert.deepStrictEqual(pushRes1.syncedOperationIds, ["op-sms-1"]);
      assert.strictEqual(
        smsSendCallCount,
        1,
        "SMS provider must be called exactly once",
      );

      const commitIndex = timeline.findIndex(
        (e) => e.step === "COMMIT_TX_AND_RELEASE_LOCK",
      );
      const sendIndex = timeline.findIndex((e) => e.step === "ZADX_SMS_SEND");
      assert.ok(commitIndex >= 0 && sendIndex > commitIndex, "SMS send must happen strictly AFTER transaction COMMIT and lock release");

      const sendEvent = timeline[sendIndex];
      assert.strictEqual(
        sendEvent.inTransaction,
        false,
        "SMS send must not run inside a database transaction",
      );
      assert.strictEqual(
        sendEvent.centerLockHeld,
        false,
        "SMS send must not run while center advisory lock is held",
      );
      assert.strictEqual(
        sendEvent.deliveryStatusDuringSend,
        "queued",
        "Delivery status must remain queued (not sent) until provider confirms",
      );
      assert.strictEqual(
        deliveriesTable.get("deliv-1").status,
        "sent",
        "Delivery status must be updated to sent after provider confirmation",
      );
      assert.strictEqual(
        deliveriesTable.get("deliv-1").provider_message_id,
        "zadx-msg-101",
      );

      // Retry with same operationId AND retry with new operationId for the same deliveryId
      await SyncProcessor.processPush("center-1", "usr-1", "dev-1", [
        smsOperation,
      ]);
      await SyncProcessor.processPush("center-1", "usr-1", "dev-1", [
        { ...smsOperation, operationId: "op-sms-1-retry" },
      ]);
      await SyncProcessor.dispatchPendingSmsDeliveries("center-1", ["deliv-1"]);

      assert.strictEqual(
        smsSendCallCount,
        1,
        "Retrying sync or re-dispatching must NEVER send the same SMS twice",
      );
      console.log(
        "  ✔ PASS 1: SMS is sent strictly after COMMIT & lock release, and retries are idempotent",
      );
    }

    // =========================================================================
    // TEST 2: Sync Push Batched operation_id Lookup, Ordering & Savepoints
    // =========================================================================
    {
      let batchIdempotencyQueryCount = 0;
      let perOpIdempotencyQueryCount = 0;
      const appliedOrder = [];
      const ledgerTable = new Map([
        [
          "op-already-synced",
          {
            operation_id: "op-already-synced",
            server_seq: 10,
            status: "applied",
            center_id: "center-1",
          },
        ],
      ]);

      const mockClient = {
        query: async (sql, params = []) => {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          if (normalizedSql.includes("pg_advisory_xact_lock")) {
            return { rows: [] };
          }
          if (normalizedSql.includes("MAX(server_seq)")) {
            return { rows: [{ max_seq: 10 }] };
          }
          if (
            normalizedSql.includes(
              "FROM server_sync_operations WHERE operation_id = ANY",
            )
          ) {
            batchIdempotencyQueryCount += 1;
            const ids = params[0] || [];
            return {
              rows: ids.map((id) => ledgerTable.get(id)).filter(Boolean),
            };
          }
          if (
            normalizedSql.includes(
              "FROM server_sync_operations WHERE operation_id = $1",
            )
          ) {
            perOpIdempotencyQueryCount += 1;
            return { rows: [] };
          }
          if (normalizedSql.startsWith("SAVEPOINT")) {
            return { rows: [] };
          }
          if (normalizedSql.startsWith("RELEASE SAVEPOINT")) {
            return { rows: [] };
          }
          if (normalizedSql.startsWith("ROLLBACK TO SAVEPOINT")) {
            return { rows: [] };
          }
          if (normalizedSql.includes("FOR UPDATE")) {
            return { rows: [] };
          }
          if (
            normalizedSql.includes("SELECT updated_at::text AS updated_at")
          ) {
            return { rows: [{ updated_at: "2026-10-30T12:00:00.000Z" }] };
          }
          if (normalizedSql.startsWith("INSERT INTO server_sync_operations")) {
            const [operationId, centerId, , , , entityType, entityId] = params;
            const seq = 10 + ledgerTable.size + 1;
            ledgerTable.set(operationId, {
              operation_id: operationId,
              server_seq: seq,
              status: "applied",
              center_id: centerId,
              entity_type: entityType,
              entity_id: entityId,
            });
            return { rows: [{ server_seq: seq }] };
          }
          if (
            normalizedSql.startsWith("INSERT INTO audit_logs") ||
            normalizedSql.startsWith("INSERT INTO sync_checkpoints") ||
            normalizedSql.startsWith("SELECT * FROM")
          ) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const originalApplyDomainMutation = SyncProcessor.applyDomainMutation;
      SyncProcessor.applyDomainMutation = async (_client, context) => {
        if (context.operationId === "op-invalid") {
          throw new Error("Simulated domain validation error");
        }
        appliedOrder.push(`${context.entityType}:${context.entityId}`);
      };

      db.withTransaction = async (cb) => cb(mockClient);

      try {
        // Submit out-of-order dependencies + already-synced op + duplicate op in same batch + 1 invalid op
        const operations = [
          {
            operationId: "op-group-1",
            centerId: "center-1",
            entityType: "group",
            entityId: "grp-1",
            operationType: "create",
            payload: { id: "grp-1", name: "Group 1" },
          },
          {
            operationId: "op-teacher-1",
            centerId: "center-1",
            entityType: "teacher",
            entityId: "tch-1",
            operationType: "create",
            payload: { id: "tch-1", name: "Teacher 1" },
          },
          {
            operationId: "op-already-synced",
            centerId: "center-1",
            entityType: "student",
            entityId: "stu-existing",
            operationType: "create",
            payload: { id: "stu-existing", full_name: "Existing Student" },
          },
          {
            operationId: "op-teacher-1", // Duplicate operationId inside the same batch
            centerId: "center-1",
            entityType: "teacher",
            entityId: "tch-1",
            operationType: "create",
            payload: { id: "tch-1", name: "Teacher 1" },
          },
          {
            operationId: "op-invalid",
            centerId: "center-1",
            entityType: "student",
            entityId: "stu-bad",
            operationType: "create",
            payload: { id: "stu-bad" },
          },
        ];

        const pushRes = await SyncProcessor.processPush(
          "center-1",
          "usr-1",
          "dev-1",
          operations,
        );

        assert.strictEqual(pushRes.success, true);
        assert.strictEqual(
          batchIdempotencyQueryCount,
          1,
          "Must batch-query existing operation_ids in a single ANY($1::text[]) query",
        );
        assert.strictEqual(
          perOpIdempotencyQueryCount,
          0,
          "Must not run individual SELECT per operation_id",
        );
        // Teacher must be ordered and applied before Group, and duplicate op-teacher-1 must only apply once
        assert.deepStrictEqual(appliedOrder, ["teacher:tch-1", "group:grp-1"]);
        assert.deepStrictEqual(pushRes.syncedOperationIds, [
          "op-teacher-1",
          "op-group-1",
          "op-already-synced",
        ]);
        assert.strictEqual(pushRes.conflicts.length, 1);
        assert.strictEqual(pushRes.conflicts[0].operationId, "op-invalid");
        console.log(
          "  ✔ PASS 2: Sync Push batches operation_id lookup, preserves dependency ordering & savepoints, and prevents duplicates",
        );
      } finally {
        SyncProcessor.applyDomainMutation = originalApplyDomainMutation;
      }
    }

    // =========================================================================
    // TEST 3: Request-Scoped requireService Cache & Strict Center Isolation
    // =========================================================================
    {
      let dbServiceQueryCount = 0;
      db.query = async (sql, params = []) => {
        dbServiceQueryCount += 1;
        const [centerId, serviceKey] = params;
        // Enable 'attendance' for center-1, disable it for center-2
        if (centerId === "center-1" && serviceKey === "attendance") {
          return { rows: [{ enabled: true }] };
        }
        if (centerId === "center-2" && serviceKey === "attendance") {
          return { rows: [{ enabled: false }] };
        }
        return { rows: [{ enabled: true }] };
      };

      const reqCenter1Cache = new Map();
      for (let i = 0; i < 15; i += 1) {
        await requireService("center-1", "attendance", {
          cache: reqCenter1Cache,
          expectedCenterId: "center-1",
        });
      }
      assert.strictEqual(
        dbServiceQueryCount,
        1,
        "15 checks for the same (centerId, serviceKey) in one request must execute only 1 DB query",
      );

      // Cross-center check with mismatched expectedCenterId must be rejected immediately without querying DB
      let crossCenterBlocked = false;
      try {
        await requireService("center-2", "attendance", {
          cache: reqCenter1Cache,
          expectedCenterId: "center-1",
        });
      } catch (err) {
        crossCenterBlocked =
          err.code === "TENANT_MISMATCH" && err.statusCode === 403;
      }
      assert.strictEqual(
        crossCenterBlocked,
        true,
        "Cross-center check against center-1 request context must throw TENANT_MISMATCH (403)",
      );
      assert.strictEqual(
        dbServiceQueryCount,
        1,
        "Blocked cross-center check must not query the database",
      );

      // Even if the same cache Map is passed for center-2, center-1's cached 'true' must NEVER allow center-2
      let center2DisabledBlocked = false;
      try {
        await requireService("center-2", "attendance", {
          cache: reqCenter1Cache,
          expectedCenterId: "center-2",
        });
      } catch (err) {
        center2DisabledBlocked =
          err.code === "SERVICE_DISABLED" && err.statusCode === 403;
      }
      assert.strictEqual(
        center2DisabledBlocked,
        true,
        "Center-1 cache entry must never grant access to disabled service in center-2",
      );
      console.log(
        "  ✔ PASS 3: requireService cache deduplicates per-request queries and enforces strict center isolation",
      );
    }

    console.log("\nALL 3 PHASE 2 TESTS PASSED SUCCESSFULLY!");
  } finally {
    db.withTransaction = originalWithTransaction;
    db.query = originalDbQuery;
    zadxSmsProvider.isConfigured = originalIsConfigured;
    zadxSmsProvider.send = originalSend;
    await db.pool.end().catch(() => {});
  }
}

runPhase2Tests().catch((err) => {
  console.error("Phase 2 test failed:", err);
  process.exit(1);
});
