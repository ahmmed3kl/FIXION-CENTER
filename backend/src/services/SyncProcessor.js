const db = require("../db");
const { AppError } = require("../middleware/errorHandler");

class SyncProcessor {
  /**
   * Processes a batch of sync operations inside a true ACID transaction.
   */
  static async processPush(centerId, userId, deviceId, operations) {
    return db.withTransaction(async (client) => {
      const syncedOperationIds = [];
      const conflicts = [];
      let maxServerSeq = 0;

      // Get current highest server sequence for the center
      const currentSeqRes = await client.query(
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
        const existingOp = await client.query(
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

        try {
          // 3. Dispatch and apply domain mutation atomically
          await SyncProcessor.applyDomainMutation(client, {
            centerId,
            userId,
            deviceId,
            operationId,
            operationType,
            entityType,
            entityId,
            payload:
              typeof payload === "string" ? JSON.parse(payload) : payload,
            createdAt,
          });

          // 4. Ingest operation into monotonic server ledger
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
              entityId || operationId,
              JSON.stringify(payload || {}),
              createdAt || new Date().toISOString(),
            ],
          );

          const seq = parseInt(ingestRes.rows[0].server_seq, 10);
          if (seq > maxServerSeq) {
            maxServerSeq = seq;
          }

          // 5. Record Server-Side Audit Trail
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
              entityId || operationId,
              `${entityType || "entity"}.${operationType || "mutate"}`,
              JSON.stringify(payload || {}),
            ],
          );

          syncedOperationIds.push(operationId);
        } catch (opErr) {
          // If domain mutation failed with conflict or validation
          conflicts.push({
            operationId,
            entityType,
            entityId,
            reason: opErr.message,
            resolution: "server_wins",
          });
        }
      }

      // 6. Update Per-Device Checkpoint (tracks device progress without modifying global server sequence)
      await client.query(
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
    });
  }

  /**
   * Applies specific entity domain logic in PostgreSQL.
   */
  static async applyDomainMutation(client, context) {
    const { centerId, userId, operationId, entityType, payload } = context;

    switch (entityType) {
      case "student":
      case "student_created": {
        const student = payload.student || payload;
        const cardCode = String(
          student.card_code || student.student_code || "",
        ).trim();
        const studentCode = cardCode; // Student Code = Card Code invariant

        if (!cardCode) {
          throw new Error("Card code / Student code is required.");
        }

        // Check duplicate card/student code in center
        const dupCheck = await client.query(
          `SELECT id FROM students WHERE center_id = $1 AND student_code = $2
           UNION
           SELECT student_id FROM student_cards WHERE center_id = $1 AND card_code = $2`,
          [centerId, cardCode],
        );

        if (dupCheck.rows.length > 0 && dupCheck.rows[0].id !== student.id) {
          throw new Error(
            `Student code / Card code '${cardCode}' is already registered in this center.`,
          );
        }

        // 1. Insert Student with exact leading zeros preserved
        await client.query(
          `INSERT INTO students 
           (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, student_type, notes, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             phone = EXCLUDED.phone,
             parent_phone = EXCLUDED.parent_phone,
             grade = EXCLUDED.grade,
             notes = EXCLUDED.notes,
             updated_at = NOW();`,
          [
            student.id,
            centerId,
            studentCode,
            student.full_name || student.fullName,
            cardCode,
            student.phone || "",
            student.parent_phone || student.parentPhone || "",
            student.grade || "",
            student.student_type || "registered",
            student.notes || null,
          ],
        );

        // 2. Insert Active Physical Card
        const cardId = payload.card?.id || `card-${student.id}`;
        await client.query(
          `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
           VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             card_code = EXCLUDED.card_code,
             status = 'active';`,
          [cardId, centerId, student.id, cardCode],
        );

        // 3. Insert Selected Group Enrollments atomically
        const enrollments =
          payload.enrollments || payload.groupEnrollments || [];
        for (const enr of enrollments) {
          await client.query(
            `INSERT INTO student_group_enrollments 
             (id, center_id, student_id, group_id, price_override, status, joined_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW(), NOW())
             ON CONFLICT (center_id, student_id, group_id) DO UPDATE SET
               price_override = EXCLUDED.price_override,
               status = 'active',
               updated_at = NOW();`,
            [
              enr.id ||
                `enr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              centerId,
              student.id,
              enr.group_id || enr.groupId,
              enr.price_override || enr.priceOverride || null,
            ],
          );
        }
        break;
      }

      case "attendance":
      case "attendance_marked": {
        const att = payload;
        // Enforce deduplication via UNIQUE(session_id, student_id)
        await client.query(
          `INSERT INTO attendance
           (id, center_id, session_id, student_id, check_in_time, status, is_late, attendance_type, original_absence_id, operation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (session_id, student_id) DO NOTHING;`,
          [
            att.id,
            centerId,
            att.session_id || att.sessionId,
            att.student_id || att.studentId,
            att.check_in_time || att.checkInTime || new Date().toISOString(),
            att.status || "present",
            att.is_late ? true : false,
            att.attendance_type || att.attendanceType || "present",
            att.original_absence_id || att.originalAbsenceId || null,
            operationId,
          ],
        );
        break;
      }

      case "payment":
      case "payment_collected": {
        const pay = payload;
        // Append-only ledger insert
        await client.query(
          `INSERT INTO payments 
           (id, operation_id, center_id, student_id, debt_cycle_id, session_id, subscription_id, amount, payment_method, is_reversed, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW(), $10)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            pay.id,
            operationId,
            centerId,
            pay.student_id || pay.studentId,
            pay.debt_cycle_id || pay.debtCycleId || null,
            pay.session_id || pay.sessionId || null,
            pay.subscription_id || pay.subscriptionId || null,
            parseFloat(pay.amount),
            pay.payment_method || pay.paymentMethod || "cash",
            userId,
          ],
        );
        break;
      }

      case "payment_reversal": {
        const rev = payload;
        await client.query(
          `INSERT INTO payment_reversals
           (id, operation_id, center_id, payment_id, reversed_amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            rev.id,
            operationId,
            centerId,
            rev.payment_id || rev.paymentId,
            parseFloat(rev.reversed_amount || rev.reversedAmount),
            rev.reason || "إلغاء إيصال الدفع",
            userId,
          ],
        );

        // Mark payment as reversed
        await client.query(
          "UPDATE payments SET is_reversed = true WHERE id = $1 AND center_id = $2",
          [rev.payment_id || rev.paymentId, centerId],
        );
        break;
      }

      case "debt_adjustment": {
        const adj = payload;
        await client.query(
          `INSERT INTO debt_adjustments
           (id, operation_id, center_id, debt_cycle_id, adjustment_type, amount, reason, created_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
           ON CONFLICT (operation_id) DO NOTHING;`,
          [
            adj.id,
            operationId,
            centerId,
            adj.debt_cycle_id || adj.debtCycleId,
            adj.adjustment_type || adj.adjustmentType || "discount",
            parseFloat(adj.amount),
            adj.reason || "تسوية/خصم معتمد",
            userId,
          ],
        );
        break;
      }

      case "session":
      case "session_created": {
        const sess = payload;
        await client.query(
          `INSERT INTO sessions (id, center_id, group_id, session_date, start_time, end_time, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             updated_at = NOW();`,
          [
            sess.id,
            centerId,
            sess.group_id || sess.groupId,
            sess.session_date || sess.sessionDate,
            sess.start_time || sess.startTime,
            sess.end_time || sess.endTime,
            sess.status || "open",
          ],
        );
        break;
      }

      default:
        // Other entity types can be added seamlessly
        break;
    }
  }
}

module.exports = SyncProcessor;
