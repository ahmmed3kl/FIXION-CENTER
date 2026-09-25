const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { requirePermission } = require("../middleware/auth");
const { deviceGuard } = require("../middleware/deviceGuard");
const { AppError } = require("../middleware/errorHandler");
const SyncProcessor = require("../services/SyncProcessor");

const router = express.Router();
const { requireService } = require("../middleware/serviceGuard");
const { getServiceKeyForEntity } = require("../services/serviceCatalog");

/**
 * Full snapshot bootstrap for center
 * Supplies all authoritative domain tables directly from PostgreSQL
 */
router.get(
  "/bootstrap",
  authMiddleware,
  deviceGuard,
  async (req, res, next) => {
    try {
      const centerId = req.centerId;

      const snapshot = await db.withTransaction(async (client) => {
        // A repeatable-read snapshot makes the rows and max server sequence
        // describe one exact point in the stream.
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const [
          studentsRes,
          cardsRes,
          groupsRes,
          teachersRes,
          subjectsRes,
          teacherSubjectsRes,
          schedulesRes,
          sessionsRes,
          expectedStudentsRes,
          enrollmentsRes,
          attendanceRes,
          paymentsRes,
          paymentReversalsRes,
          debtAdjustmentsRes,
          packagesRes,
          packageSubjectsRes,
          packageSubscriptionsRes,
          overridesRes,
          advanceCoveragesRes,
          notificationTemplatesRes,
          debtCyclesRes,
          notificationEventsRes,
          notificationDeliveriesRes,
          sessionClosingsRes,
          dailyClosingsRes,
          gradeExamsRes,
          gradeScoresRes,
          resetStateRes,
          maxSeqRes,
        ] = await Promise.all([
          client.query("SELECT * FROM students WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM student_cards WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM groups WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM teachers WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM subjects WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM teacher_subjects WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM group_schedules WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM sessions WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM session_expected_students WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM student_group_enrollments WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM attendance WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM payments WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM payment_reversals WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM debt_adjustments WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM packages WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM package_subjects WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM student_package_subscriptions WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM package_subject_teacher_overrides WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM advance_coverages WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM notification_templates WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM debt_cycles WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM notification_events WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM notification_deliveries WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM session_closing_records WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM daily_closing_summaries WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM grade_exams WHERE center_id = $1", [centerId]),
          client.query("SELECT * FROM grade_scores WHERE center_id = $1", [centerId]),
          client.query("SELECT reset_generation, updated_at FROM center_data_state WHERE center_id = $1", [centerId]),
          client.query("SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM server_sync_operations WHERE center_id = $1", [centerId]),
        ]);

        return {
        centerId,
        students: studentsRes.rows,
        cards: cardsRes.rows,
        groups: groupsRes.rows,
        teachers: teachersRes.rows,
        subjects: subjectsRes.rows,
        teacherSubjects: teacherSubjectsRes.rows,
        schedules: schedulesRes.rows,
        sessions: sessionsRes.rows,
        expectedStudents: expectedStudentsRes.rows,
        enrollments: enrollmentsRes.rows,
        attendance: attendanceRes.rows,
        payments: paymentsRes.rows,
        paymentReversals: paymentReversalsRes.rows,
        debtAdjustments: debtAdjustmentsRes.rows,
        packages: packagesRes.rows,
        packageSubjects: packageSubjectsRes.rows,
        packageSubscriptions: packageSubscriptionsRes.rows,
        packageTeacherOverrides: overridesRes.rows,
        advanceCoverages: advanceCoveragesRes.rows,
        notificationTemplates: notificationTemplatesRes.rows,
        debtCycles: debtCyclesRes.rows,
        notificationEvents: notificationEventsRes.rows,
        notificationDeliveries: notificationDeliveriesRes.rows,
        sessionClosings: sessionClosingsRes.rows,
        dailyClosings: dailyClosingsRes.rows,
        gradeExams: gradeExamsRes.rows,
        gradeScores: gradeScoresRes.rows,
        resetGeneration: Number(resetStateRes.rows[0]?.reset_generation || 0),
        resetAt: resetStateRes.rows[0]?.updated_at || null,
        latestServerSeq: parseInt(maxSeqRes.rows[0]?.max_seq || 0, 10),
        timestamp: new Date().toISOString(),
        };
      });

      return res.json(snapshot);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Destructive center reset for a new term. The generation is incremented so
 * every online APK clears its local operational database on next bootstrap.
 */
router.post("/reset", authMiddleware, deviceGuard, requirePermission("center.reset"), async (req, res, next) => {
  try {
    const centerId = req.centerId;
    const result = await db.withTransaction(async (client) => {
      // Delete children before parents to remain compatible with strict FKs.
      const tables = [
        "session_closing_records", "daily_closing_summaries",
        "notification_deliveries", "notification_events", "notification_templates",
        "payment_reversals", "payments", "debt_adjustments", "advance_coverages",
        "attendance", "session_expected_students", "sessions", "debt_cycles",
        "package_subject_teacher_overrides", "student_package_subscriptions",
        "package_subjects", "packages", "student_group_enrollments",
        "student_cards", "students", "group_schedules", "groups",
        "teacher_subjects", "teachers", "subjects", "grade_scores", "grade_exams",
        "audit_logs", "server_sync_operations", "sync_checkpoints",
      ];
      for (const table of tables) await client.query(`DELETE FROM ${table} WHERE center_id = $1`, [centerId]);
      const state = await client.query(
        `INSERT INTO center_data_state (center_id, reset_generation, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (center_id) DO UPDATE SET reset_generation = center_data_state.reset_generation + 1, updated_at = NOW()
         RETURNING reset_generation`,
        [centerId],
      );
      return Number(state.rows[0].reset_generation);
    });
    res.json({ success: true, centerId, resetGeneration: result });
  } catch (error) { next(error); }
});

/**
 * Push offline operations to server
 */
router.post("/push", authMiddleware, deviceGuard, async (req, res, next) => {
  try {
    const { operations } = req.body;

    if (!Array.isArray(operations)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "operations must be an array.",
        "قائمة العمليات غير صحيحة.",
        400,
      );
    }

    for (const operation of operations) {
      const serviceKey = getServiceKeyForEntity(operation.entityType || operation.entity_type, operation.operationType || operation.operation_type, operation.payload);
      // SMS delivery is deliberately handled as an isolated operation. A
      // disabled/unconfigured SMS service must not block unrelated sync work;
      // SyncProcessor records the delivery as skipped/failed without calling
      // the provider.
      if (serviceKey && serviceKey !== "sms") await requireService(req.centerId, serviceKey);
    }

    const result = await SyncProcessor.processPush(
      req.centerId,
      req.user.id,
      req.deviceId,
      operations,
    );

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Pull server stream changes using monotonic sequence cursor
 */
router.get("/pull", authMiddleware, deviceGuard, async (req, res, next) => {
  try {
    const rawCursor = req.query.cursor || "0";
    const cursor = parseInt(rawCursor, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);

    // A database reset/reseed can make the client's cursor newer than the
    // server stream. Signal this explicitly so the client bootstraps again
    // instead of silently believing all old local rows are synchronized.
    const latestRes = await db.query(
      "SELECT COALESCE(MAX(server_seq), 0) AS max_seq FROM server_sync_operations WHERE center_id = $1",
      [req.centerId],
    );
    const resetStateRes = await db.query(
      "SELECT reset_generation FROM center_data_state WHERE center_id = $1",
      [req.centerId],
    );
    const latestServerSeq = parseInt(latestRes.rows[0]?.max_seq || 0, 10);
    const resetGeneration = Number(resetStateRes.rows[0]?.reset_generation || 0);
    if (cursor > latestServerSeq) {
      return res.json({
        changes: [],
        nextCursor: "0",
        hasMore: false,
        cursorReset: true,
        resetGeneration,
        latestServerSeq,
        serverTimestamp: new Date().toISOString(),
      });
    }

    // Query global server sync stream for the center
    const rowsRes = await db.query(
      `SELECT server_seq, operation_id, entity_type, entity_id, operation_type, payload, applied_at
       FROM server_sync_operations
       WHERE center_id = $1 AND server_seq > $2
       ORDER BY server_seq ASC
       LIMIT $3`,
      [req.centerId, cursor, limit + 1],
    );

    const hasMore = rowsRes.rows.length > limit;
    const returnedRows = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;

    let nextCursor = String(cursor);
    if (returnedRows.length > 0) {
      nextCursor = String(returnedRows[returnedRows.length - 1].server_seq);
    }

    // Format changes as ServerChangeRecord
    const changes = returnedRows.map((row) => ({
      sequenceNumber: parseInt(row.server_seq, 10),
      operationId: row.operation_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: String(row.operation_type || "update").toLowerCase(),
      data:
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      serverTimestamp: row.applied_at,
    }));

    // Update per-device checkpoint independently without modifying global server sequence
    if (returnedRows.length > 0) {
      try {
        await db.query(
          `INSERT INTO sync_checkpoints (id, center_id, device_id, last_pulled_seq, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (center_id, device_id) DO UPDATE SET
             last_pulled_seq = EXCLUDED.last_pulled_seq,
             updated_at = NOW();`,
          [
          `chk-${crypto.createHash("sha256").update(`${req.centerId}:${req.deviceId}`).digest("hex").slice(0, 48)}`,
            req.centerId,
            req.deviceId,
            parseInt(nextCursor, 10),
          ],
        );
      } catch (checkpointErr) {
        // Non-fatal: checkpoint update failed (e.g. device FK not yet registered).
        // The pull data is still valid and will be returned.
        console.warn(
          "sync_checkpoints upsert skipped:",
          checkpointErr?.message,
        );
      }
    }

    return res.json({
      changes,
      nextCursor,
      hasMore,
      serverTimestamp: new Date().toISOString(),
      resetGeneration,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
