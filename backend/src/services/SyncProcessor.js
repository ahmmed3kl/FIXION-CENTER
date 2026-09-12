const db = require("../db");
const { AppError } = require("../middleware/errorHandler");

class SyncProcessor {
  /**
   * Processes a batch of sync operations.
   * Each operation executes within its own ACID transaction so partial failure in one operation
   * rolls back only that operation without aborting other operations.
   */
  static async processPush(centerId, userId, deviceId, operations) {
    const syncedOperationIds = [];
    const conflicts = [];
    let maxServerSeq = 0;

    // Ensure device exists in devices table to satisfy foreign key constraints
    await db.query(
      `INSERT INTO devices (id, center_id, user_id, device_name, status, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'Mobile Device', 'active', NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = NOW();`,
      [deviceId, centerId, userId],
    );

    // Get current highest server sequence for the center
    const currentSeqRes = await db.query(
      "SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM server_sync_operations WHERE center_id = $1",
      [centerId],
    );
    maxServerSeq = parseInt(currentSeqRes.rows[0].max_seq, 10);

    for (const op of operations) {
      const {
        operationId,
        operationType,
        entityType,
        entityId,
        payload,
        createdAt,
      } = op;

      if (!operationId) {
        continue;
      }

      // 1. Check if operation was already processed (Database-level Idempotency)
      const existingOp = await db.query(
        "SELECT server_seq, status FROM server_sync_operations WHERE operation_id = $1",
        [operationId],
      );

      if (existingOp.rows.length > 0) {
        syncedOperationIds.push(operationId);
        const existingSeq = parseInt(existingOp.rows[0].server_seq, 10);
        if (existingSeq > maxServerSeq) {
          maxServerSeq = existingSeq;
        }
        continue;
      }

      // 2. Tenant isolation assertion: Operation center MUST match authenticated session center
      if (op.centerId && op.centerId !== centerId) {
        conflicts.push({
          operationId,
          entityType,
          entityId,
          reason: `Tenant mismatch: operation belongs to '${op.centerId}', authenticated center is '${centerId}'.`,
          resolution: "server_wins",
        });
        continue;
      }

      // 3. Execute domain mutation in its own atomic transaction
      try {
        const seq = await db.withTransaction(async (client) => {
          const parsedPayload =
            typeof payload === "string" ? JSON.parse(payload) : payload || {};

          // Apply domain mutation (student+card+enrollments / attendance / payment)
          const resolvedEntityId = await SyncProcessor.applyDomainMutation(
            client,
            {
              centerId,
              userId,
              deviceId,
              operationId,
              operationType,
              entityType,
              entityId,
              payload: parsedPayload,
              createdAt,
            },
          );

          const finalEntityId = resolvedEntityId || entityId || operationId;

          // Ingest operation into monotonic server ledger
          const ingestRes = await client.query(
            `INSERT INTO server_sync_operations 
             (operation_id, center_id, user_id, device_id, operation_type, entity_type, entity_id, payload, status, created_at, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', $9, NOW())
             RETURNING server_seq;`,
            [
              operationId,
              centerId,
              userId,
              deviceId,
              operationType || entityType || "mutation",
              entityType || "unknown",
              finalEntityId,
              JSON.stringify(parsedPayload),
              createdAt || new Date().toISOString(),
            ],
          );

          // Record Server-Side Audit Trail
          await client.query(
            `INSERT INTO audit_logs
             (id, operation_id, center_id, user_id, device_id, entity_type, entity_id, action, timestamp, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9);`,
            [
              `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              operationId,
              centerId,
              userId,
              deviceId,
              entityType || "unknown",
              finalEntityId,
              `${entityType || "entity"}.${operationType || "mutate"}`,
              JSON.stringify(parsedPayload),
            ],
          );

          return parseInt(ingestRes.rows[0].server_seq, 10);
        });

        if (seq > maxServerSeq) {
          maxServerSeq = seq;
        }
        syncedOperationIds.push(operationId);
      } catch (opErr) {
        console.error(`Mutation error for operation ${operationId}:`, opErr);
        conflicts.push({
          operationId,
          entityType,
          entityId,
          reason: opErr.message,
          resolution: "server_wins",
        });
      }
    }

    // 4. Update Per-Device Checkpoint independently
    await db.query(
      `INSERT INTO sync_checkpoints (id, center_id, device_id, last_pulled_seq, last_pushed_operation_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (center_id, device_id) DO UPDATE SET
         last_pushed_operation_id = EXCLUDED.last_pushed_operation_id,
         updated_at = NOW();`,
      [
        `chk-${centerId}-${deviceId}`,
        centerId,
        deviceId,
        maxServerSeq,
        syncedOperationIds[syncedOperationIds.length - 1] || null,
      ],
    );

    return {
      success: true,
      syncedOperationIds,
      conflicts,
      serverCursor: String(maxServerSeq),
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * Applies specific entity domain logic in PostgreSQL.
   * Returns the canonical entityId.
   */
  static async applyDomainMutation(client, context) {
    const {
      centerId,
      userId,
      operationId,
      operationType,
      entityType,
      payload,
    } = context;

    switch (entityType) {
      case "student":
      case "student_created": {
        const student = payload.student || payload;
        const studentId = student.id || context.entityId;
        const cardCode = String(
          student.card_code ||
            student.cardCode ||
            student.student_code ||
            student.studentCode ||
            "",
        ).trim();
        const studentCode = String(
          student.student_code || student.studentCode || cardCode,
        ).trim();

        if (!cardCode && !studentCode) {
          throw new Error("Card code / Student code is required.");
        }

        const fullName = student.full_name || student.fullName || "";
        const phone = student.phone || "";
        const parentPhone = student.parent_phone || student.parentPhone || "";
        const grade = student.grade || "";
        const studentType =
          student.student_type || student.studentType || "registered";
        const notes = student.notes || null;
        const status = student.status || "active";

        // 1. Insert/Update Student with exact leading zeros preserved
        await client.query(
          `INSERT INTO students 
           (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, student_type, notes, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             student_code = COALESCE(EXCLUDED.student_code, students.student_code),
             full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), students.full_name),
             card_code = COALESCE(NULLIF(EXCLUDED.card_code, ''), students.card_code),
             phone = COALESCE(NULLIF(EXCLUDED.phone, ''), students.phone),
             parent_phone = COALESCE(NULLIF(EXCLUDED.parent_phone, ''), students.parent_phone),
             grade = COALESCE(NULLIF(EXCLUDED.grade, ''), students.grade),
             student_type = COALESCE(EXCLUDED.student_type, students.student_type),
             notes = COALESCE(EXCLUDED.notes, students.notes),
             status = COALESCE(EXCLUDED.status, students.status),
             updated_at = NOW();`,
          [
            studentId,
            centerId,
            studentCode,
            fullName,
            cardCode,
            phone,
            parentPhone,
            grade,
            studentType,
            notes,
            status,
          ],
        );

        // 2. Insert/Update Active Physical Card
        if (cardCode) {
          const cardId = payload.card?.id || `card-${studentId}`;
          const cardStatus = status === "inactive" ? "inactive" : "active";
          await client.query(
            `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             ON CONFLICT (id) DO UPDATE SET
               card_code = EXCLUDED.card_code,
               status = EXCLUDED.status;`,
            [cardId, centerId, studentId, cardCode, cardStatus],
          );
        }

        // 3. Insert Selected Group Enrollments atomically
        const enrollments =
          payload.enrollments ||
          payload.groupEnrollments ||
          payload.groupIds ||
          [];
        for (const item of enrollments) {
          const groupId =
            typeof item === "string" ? item : item.group_id || item.groupId;
          const priceOverride =
            typeof item === "object"
              ? item.price_override || item.priceOverride || null
              : null;
          if (groupId) {
            await client.query(
              `INSERT INTO student_group_enrollments 
               (id, center_id, student_id, group_id, price_override, status, joined_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW(), NOW())
               ON CONFLICT (center_id, student_id, group_id) DO UPDATE SET
                 price_override = COALESCE(EXCLUDED.price_override, student_group_enrollments.price_override),
                 status = 'active',
                 updated_at = NOW();`,
              [
                `enr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                centerId,
                studentId,
                groupId,
                priceOverride,
              ],
            );
          }
        }
        return studentId;
      }

      case "attendance":
      case "attendance_marked":
      case "attendance.create": {
        const att = payload;
        const attId = att.id || context.entityId;
        const sessionId = att.session_id || att.sessionId;
        const studentId = att.student_id || att.studentId;

        await client.query(
          `INSERT INTO attendance
           (id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type, original_absence_id, operation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (session_id, student_id) DO UPDATE SET
             status = EXCLUDED.status,
             is_late = EXCLUDED.is_late,
             check_in_time = EXCLUDED.check_in_time;`,
          [
            attId,
            centerId,
            sessionId,
            studentId,
            att.check_in_time || att.checkInTime || new Date().toISOString(),
            att.status || "present",
            att.is_late || att.isLate ? true : false,
            att.attendance_type || att.attendanceType || "present",
            att.original_absence_id || att.originalAbsenceId || null,
            operationId,
          ],
        );
        return attId;
      }

      case "payment":
      case "payment_collected":
      case "payment.create": {
        const pay = payload;
        const payId = pay.id || context.entityId;
        await client.query(
          `INSERT INTO payments 
           (id, operation_id, center_id, student_id, debt_cycle_id, session_id, subscription_id, amount, payment_method, is_reversed, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW(), $10)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            payId,
            operationId,
            centerId,
            pay.student_id || pay.studentId,
            pay.debt_cycle_id || pay.debtCycleId || null,
            pay.session_id || pay.sessionId || null,
            pay.subscription_id || pay.subscriptionId || null,
            parseFloat(pay.amount || 0),
            pay.payment_method || pay.paymentMethod || "cash",
            userId,
          ],
        );
        return payId;
      }

      case "payment_reversal":
      case "payment_reversal.create": {
        const rev = payload;
        const revId = rev.id || context.entityId;
        const paymentId = rev.payment_id || rev.paymentId;
        const reversedAmount = parseFloat(
          rev.reversed_amount || rev.reversedAmount || 0,
        );

        await client.query(
          `INSERT INTO payment_reversals
           (id, operation_id, center_id, payment_id, reversed_amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            revId,
            operationId,
            centerId,
            paymentId,
            reversedAmount,
            rev.reason || "إلغاء إيصال الدفع",
            userId,
          ],
        );

        if (paymentId) {
          await client.query(
            "UPDATE payments SET is_reversed = true WHERE id = $1 AND center_id = $2",
            [paymentId, centerId],
          );
        }
        return revId;
      }

      case "debt_adjustment": {
        const adj = payload;
        const adjId = adj.id || context.entityId;
        await client.query(
          `INSERT INTO debt_adjustments
           (id, operation_id, center_id, debt_cycle_id, adjustment_type, amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            adjId,
            operationId,
            centerId,
            adj.debt_cycle_id || adj.debtCycleId,
            adj.adjustment_type || adj.adjustmentType || "discount",
            parseFloat(adj.amount || 0),
            adj.reason || "تسوية/خصم معتمد",
            userId,
          ],
        );
        return adjId;
      }

      case "session":
      case "session_created": {
        const sess = payload;
        const sessId = sess.id || context.entityId;
        await client.query(
          `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            sessId,
            centerId,
            sess.group_id || sess.groupId,
            sess.session_date || sess.sessionDate,
            sess.start_time || sess.startTime,
            sess.end_time || sess.endTime,
            sess.status || "open",
          ],
        );
        return sessId;
      }

      default:
        return context.entityId;
    }
  }
}

module.exports = SyncProcessor;
