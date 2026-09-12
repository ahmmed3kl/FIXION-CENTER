const express = require("express");
const db = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { deviceGuard } = require("../middleware/deviceGuard");
const { AppError } = require("../middleware/errorHandler");
const SyncProcessor = require("../services/SyncProcessor");

const router = express.Router();

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

      const [
        studentsRes,
        cardsRes,
        groupsRes,
        teachersRes,
        subjectsRes,
        teacherSubjectsRes,
        sessionsRes,
        enrollmentsRes,
        maxSeqRes,
      ] = await Promise.all([
        db.query("SELECT * FROM students WHERE center_id = $1", [centerId]),
        db.query("SELECT * FROM student_cards WHERE center_id = $1", [
          centerId,
        ]),
        db.query("SELECT * FROM groups WHERE center_id = $1", [centerId]),
        db.query("SELECT * FROM teachers WHERE center_id = $1", [centerId]),
        db.query("SELECT * FROM subjects WHERE center_id = $1", [centerId]),
        db.query("SELECT * FROM teacher_subjects WHERE center_id = $1", [
          centerId,
        ]),
        db.query("SELECT * FROM sessions WHERE center_id = $1", [centerId]),
        db.query(
          "SELECT * FROM student_group_enrollments WHERE center_id = $1",
          [centerId],
        ),
        db.query(
          "SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM server_sync_operations WHERE center_id = $1",
          [centerId],
        ),
      ]);

      return res.json({
        centerId,
        students: studentsRes.rows,
        cards: cardsRes.rows,
        groups: groupsRes.rows,
        teachers: teachersRes.rows,
        subjects: subjectsRes.rows,
        teacherSubjects: teacherSubjectsRes.rows,
        sessions: sessionsRes.rows,
        enrollments: enrollmentsRes.rows,
        latestServerSeq: parseInt(maxSeqRes.rows[0]?.max_seq || 0, 10),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

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

    // Query global server sync stream for the center
    const rowsRes = await db.query(
      `SELECT server_seq, entity_type, entity_id, operation_type, payload, applied_at
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
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.operation_type,
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
            `chk-${req.centerId}-${req.deviceId}`,
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
