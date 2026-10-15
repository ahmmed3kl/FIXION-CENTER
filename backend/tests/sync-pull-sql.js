function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveSessionId(sessionId, aliases) {
  let resolved = String(sessionId || "");
  const visited = new Set();
  while (aliases.has(resolved)) {
    if (visited.has(resolved)) {
      throw new Error("Pulled session aliases contain a cycle.");
    }
    visited.add(resolved);
    resolved = aliases.get(resolved);
  }
  return resolved;
}

function buildSessionAliasPullSql(mappings, attendanceRows) {
  const aliases = new Map();
  for (const mapping of mappings || []) {
    const localSessionId = String(mapping?.localSessionId || "");
    const canonicalSessionId = String(mapping?.canonicalSessionId || "");
    if (!localSessionId || !canonicalSessionId) {
      throw new Error("Pulled session mapping is missing an identity.");
    }
    if (localSessionId === canonicalSessionId) continue;
    const currentMapping = aliases.get(localSessionId);
    if (currentMapping && currentMapping !== canonicalSessionId) {
      throw new Error("Pulled session alias maps to multiple canonical IDs.");
    }
    aliases.set(localSessionId, canonicalSessionId);
  }

  const projectedRows = new Map();
  const normalizedRows = [];
  for (const row of attendanceRows) {
    const sessionId = resolveSessionId(row.session_id, aliases);
    const naturalKey = JSON.stringify([sessionId, String(row.student_id)]);
    const existingId = projectedRows.get(naturalKey);
    if (existingId && existingId !== String(row.id)) {
      throw new Error(
        "Session alias mapping would combine historical attendance rows.",
      );
    }
    projectedRows.set(naturalKey, String(row.id));
    normalizedRows.push({ row, sessionId });
  }

  const statements = [];
  for (const { row, sessionId } of normalizedRows) {
    if (sessionId !== String(row.session_id)) {
      statements.push(
        `UPDATE attendance
            SET session_id=${sqlValue(sessionId)}
          WHERE id=${sqlValue(row.id)}
            AND session_id=${sqlValue(row.session_id)};`,
      );
      row.session_id = sessionId;
    }
  }

  return { aliases, statements };
}

function buildSessionPullSql(operation, centerId) {
  const payload = operation.payload || {};
  const session = payload.session || payload;
  const sessionAction = String(session.action || "").toLowerCase();
  const status =
    sessionAction === "close"
      ? "closed"
      : sessionAction === "reopen"
        ? "open"
        : session.status || "open";
  const sessionId =
    session.id ||
    session.sessionId ||
    session.session_id ||
    operation.entityId;

  return `INSERT INTO sessions
    (id, center_id, group_id, session_date, start_time, end_time, status,
     schedule_id, subject_id, teacher_id, session_price, late_after_minutes,
     created_at, updated_at)
    VALUES (${sqlValue(sessionId)}, ${sqlValue(session.center_id || centerId)},
      ${sqlValue(session.group_id || session.groupId)},
      ${sqlValue(session.session_date || session.sessionDate)},
      ${sqlValue(session.start_time || session.startTime)},
      ${sqlValue(session.end_time || session.endTime)},
      ${sqlValue(status)},
      ${sqlValue(session.schedule_id ?? session.scheduleId ?? null)},
      ${sqlValue(session.subject_id || session.subjectId || null)},
      ${sqlValue(session.teacher_id || session.teacherId || null)},
      ${Number(session.session_price ?? session.sessionPrice ?? 0)},
      ${Number(session.late_after_minutes ?? session.lateAfterMinutes ?? 15)},
      ${sqlValue(session.startedAt || session.started_at || session.created_at || session.createdAt || operation.createdAt || new Date().toISOString())},
      ${sqlValue(session.updated_at || session.updatedAt || operation.serverTimestamp || new Date().toISOString())})
    ON CONFLICT(id) DO UPDATE SET
      group_id=excluded.group_id,
      session_date=excluded.session_date,
      start_time=excluded.start_time,
      end_time=excluded.end_time,
      schedule_id=excluded.schedule_id,
      subject_id=excluded.subject_id,
      teacher_id=excluded.teacher_id,
      session_price=excluded.session_price,
      late_after_minutes=excluded.late_after_minutes,
      created_at=CASE
        WHEN sessions.created_at IS NULL
          OR (
            julianday(excluded.created_at) IS NOT NULL
            AND (
              julianday(sessions.created_at) IS NULL
              OR julianday(excluded.created_at) < julianday(sessions.created_at)
            )
          )
          THEN excluded.created_at
        ELSE sessions.created_at
      END,
      status=CASE
        WHEN sessions.status='cancelled' THEN 'cancelled'
        WHEN excluded.status='cancelled' THEN 'cancelled'
        WHEN sessions.status='closed' AND excluded.status NOT IN ('closed', 'cancelled')
          THEN 'closed'
        ELSE excluded.status
      END,
      updated_at=CASE
        WHEN sessions.status='cancelled' THEN sessions.updated_at
        ELSE excluded.updated_at
      END
    WHERE sessions.center_id=excluded.center_id;`;
}

function buildAttendancePullSql(
  operation,
  attendanceRows,
  sessionAliases = new Map(),
) {
  const payload = operation.payload?.attendance || operation.payload || {};
  const attendanceId = payload.id || operation.entityId;
  const sessionId = resolveSessionId(
    payload.session_id || payload.sessionId,
    sessionAliases,
  );
  const studentId = payload.student_id || payload.studentId;
  const operationId =
    operation.operationId ||
    payload.operation_id ||
    payload.operationId ||
    `server-${operation.entityId}`;
  const status = String(payload.status || "present").toLowerCase();

  if (!attendanceId || !sessionId || !studentId || !operationId) {
    throw new Error("Pulled attendance is missing an identity.");
  }

  const existingById = attendanceRows.find(
    (row) => String(row.id) === String(attendanceId),
  );
  const sameLogicalSessionRows = attendanceRows.filter(
    (row) =>
      String(row.student_id) === String(studentId) &&
      resolveSessionId(row.session_id, sessionAliases) === sessionId,
  );
  if (sameLogicalSessionRows.length > 1) {
    throw new Error(
      "Pulled attendance conflicts with multiple historical rows for this session and student.",
    );
  }

  const naturalMatch = sameLogicalSessionRows[0] || null;
  if (
    existingById &&
    naturalMatch &&
    String(existingById.id) !== String(naturalMatch.id)
  ) {
    throw new Error(
      "Pulled attendance ID conflicts with another row for this session and student.",
    );
  }
  if (
    existingById &&
    (String(existingById.student_id) !== String(studentId) ||
      resolveSessionId(existingById.session_id, sessionAliases) !== sessionId)
  ) {
    throw new Error("Pulled attendance ID is already used by another record.");
  }

  const existingByOperation = attendanceRows.find(
    (row) => String(row.operation_id) === String(operationId),
  );
  if (
    existingByOperation &&
    (String(existingByOperation.student_id) !== String(studentId) ||
      resolveSessionId(existingByOperation.session_id, sessionAliases) !==
        sessionId)
  ) {
    throw new Error(
      "Pulled attendance operation ID is already used by another record.",
    );
  }

  const existing = existingById || naturalMatch || existingByOperation;
  if (!existing) {
    attendanceRows.push({
      id: String(attendanceId),
      session_id: sessionId,
      student_id: String(studentId),
      operation_id: String(operationId),
      status,
    });
    return `INSERT INTO attendance
      (id, session_id, student_id, operation_id, status)
      VALUES (${sqlValue(attendanceId)}, ${sqlValue(sessionId)},
        ${sqlValue(studentId)}, ${sqlValue(operationId)}, ${sqlValue(status)});`;
  }

  const existingStatus = String(existing.status || "present").toLowerCase();
  const existingOutcome =
    existingStatus === "late" ? "present" : existingStatus;
  const incomingOutcome = status === "late" ? "present" : status;
  const isExplicitCancellation =
    String(
      payload.action ||
        payload.last_operation_action ||
        operation.operationType ||
        "",
    ).toLowerCase() === "attendance.cancel";
  const incomingWins =
    (existingOutcome === "absent" && incomingOutcome === "present") ||
    (isExplicitCancellation && incomingOutcome === "absent");
  const existingWins =
    !isExplicitCancellation &&
    existingOutcome === "present" &&
    incomingOutcome === "absent";
  const sameOutcome = existingOutcome === incomingOutcome;

  if (
    !incomingWins &&
    !existingWins &&
    !sameOutcome &&
    String(existing.id) !== String(attendanceId)
  ) {
    throw new Error(
      "Pulled attendance has conflicting statuses for the same session and student.",
    );
  }
  if (existingWins) return "SELECT 1;";

  const nextStatus =
    incomingWins ||
    (!sameOutcome && String(existing.id) === String(attendanceId))
      ? status
      : existing.status;
  const nextOperationId = String(operationId);
  existing.status = nextStatus;
  existing.operation_id = nextOperationId;

  return `UPDATE attendance
     SET status=${sqlValue(nextStatus)},
         operation_id=${sqlValue(nextOperationId)}
   WHERE id=${sqlValue(existing.id)};`;
}

function buildPaymentReversalPullSql(operation) {
  const payload = operation.payload || {};
  const reversal = payload.reversal || payload;
  const reversalId = reversal.id || operation.entityId;
  const operationId =
    operation.operationId ||
    reversal.operation_id ||
    reversal.operationId;
  const paymentId = reversal.payment_id || reversal.paymentId;
  const reversedAmount = Number(
    reversal.reversed_amount ?? reversal.reversedAmount ?? 0,
  );

  if (!reversalId || !operationId || !paymentId) {
    throw new Error("Pulled payment reversal is missing an identity.");
  }
  if (!Number.isFinite(reversedAmount)) {
    throw new Error("Pulled payment reversal has an invalid amount.");
  }

  return `UPDATE payments SET is_reversed=1 WHERE id=${sqlValue(paymentId)};
    UPDATE payment_reversals
       SET id=${sqlValue(reversalId)},
           operation_id=${sqlValue(operationId)},
           reversed_amount=${reversedAmount}
     WHERE payment_id=${sqlValue(paymentId)};
    INSERT INTO payment_reversals (id, operation_id, payment_id, reversed_amount)
    SELECT ${sqlValue(reversalId)}, ${sqlValue(operationId)},
           ${sqlValue(paymentId)}, ${reversedAmount}
     WHERE changes()=0;`;
}

async function pullAllClients(clients) {
  const results = await Promise.allSettled(
    clients.map((client) => client.pullAll()),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple device Pulls failed.");
  }
  return results.map((result) => result.value);
}

module.exports = {
  buildAttendancePullSql,
  buildPaymentReversalPullSql,
  buildSessionAliasPullSql,
  buildSessionPullSql,
  pullAllClients,
  sqlValue,
};
