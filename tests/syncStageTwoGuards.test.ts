import { isRetryableDependencyConflict, SyncRepository } from "../src/core/sync";
import type { SqlDatabase } from "../src/core/database";

const centerId = "coverage-center";

describe("stage two sync guards", () => {
  it("keeps an existing advance coverage identity immutable during Pull", () => {
    const historicalCoverage = {
      id: "coverage-1",
      center_id: centerId,
      student_id: "student-1",
      advance_session_id: "historical-advance",
      target_future_session_id: "historical-target",
    };
    const db = {
      getFirstSync: jest.fn((sql: string, params: any[]) =>
        sql.includes("WHERE id = ?") && params[0] === historicalCoverage.id
          ? historicalCoverage
          : null,
      ),
      runSync: jest.fn(),
    } as unknown as SqlDatabase;

    SyncRepository.upsertPulledAdvanceCoverage(db, centerId, {
      ...historicalCoverage,
      target_future_session_id: "new-target",
    });

    expect(db.runSync).not.toHaveBeenCalled();
    expect(historicalCoverage.target_future_session_id).toBe("historical-target");
  });

  it("preserves historical coverage session references without alias rewriting", () => {
    const storedRows: Array<Record<string, any>> = [];
    const db = {
      getFirstSync: jest.fn((sql: string, params: any[]) => {
        if (sql.includes("WHERE id = ?")) {
          return storedRows.find((row) => row.id === params[0]) || null;
        }
        if (sql.includes("target_future_session_id = ?")) {
          return storedRows.find(
            (row) =>
              row.center_id === params[0] &&
              row.student_id === params[1] &&
              row.target_future_session_id === params[2],
          ) || null;
        }
        if (sql.includes("advance_session_id = ?")) {
          return storedRows.find(
            (row) =>
              row.center_id === params[0] &&
              row.student_id === params[1] &&
              row.advance_session_id === params[2],
          ) || null;
        }
        return null;
      }),
      runSync: jest.fn((_sql: string, params: any[]) => {
        storedRows.push({
          id: params[0],
          operation_id: params[1],
          center_id: params[2],
          student_id: params[3],
          advance_session_id: params[4],
          target_future_session_id: params[5],
          created_by: params[6],
          created_at: params[7],
        });
      }),
    } as unknown as SqlDatabase;

    SyncRepository.upsertPulledAdvanceCoverage(db, centerId, {
      id: "coverage-legacy",
      student_id: "student-1",
      advance_session_id: "device-local-advance",
      target_future_session_id: "device-local-target",
      created_at: "2026-10-01T10:00:00.000Z",
    });

    expect(storedRows[0]).toMatchObject({
      advance_session_id: "device-local-advance",
      target_future_session_id: "device-local-target",
    });
  });

  it("does not create a second coverage for an already-used advance session", () => {
    const existing = {
      id: "coverage-existing",
      center_id: centerId,
      student_id: "student-1",
      advance_session_id: "advance-1",
      target_future_session_id: "target-1",
    };
    const db = {
      getFirstSync: jest.fn((sql: string, params: any[]) =>
        sql.includes("advance_session_id = ?") &&
        params[0] === centerId &&
        params[2] === "advance-1"
          ? existing
          : null,
      ),
      runSync: jest.fn(),
    } as unknown as SqlDatabase;

    SyncRepository.upsertPulledAdvanceCoverage(db, centerId, {
      id: "coverage-new",
      student_id: "student-1",
      advance_session_id: "advance-1",
      target_future_session_id: "target-2",
    });

    expect(db.runSync).not.toHaveBeenCalled();
  });

  it("maps new makeup source references for sending without mutating the queued payload", () => {
    const resolveAlias = jest
      .spyOn(SyncRepository, "resolveSessionAlias")
      .mockImplementation((_centerId, sessionId) => `canonical-${sessionId}`);
    const operation = {
      centerId,
      operationId: "makeup-operation",
      operationType: "create",
      entityType: "attendance",
      entityId: "makeup-attendance",
      payload: {
        sessionId: "local-target-session",
        originalAbsenceId: "local-source-session",
        attendanceType: "makeup",
      },
    };

    try {
      const prepared = SyncRepository.prepareOperationForPush(operation as any);

      expect(prepared.payload).toMatchObject({
        sessionId: "canonical-local-target-session",
        originalAbsenceId: "canonical-local-source-session",
      });
      expect(operation.payload).toMatchObject({
        sessionId: "local-target-session",
        originalAbsenceId: "local-source-session",
      });
      expect(resolveAlias).toHaveBeenCalledTimes(2);
    } finally {
      resolveAlias.mockRestore();
    }
  });

  it("classifies missing makeup and coverage parents as retryable but center mismatches as final", () => {
    expect(isRetryableDependencyConflict("SESSION_ACTIVATION_TARGET_NOT_FOUND")).toBe(true);
    expect(isRetryableDependencyConflict("ATTENDANCE_TARGET_NOT_FOUND")).toBe(true);
    expect(isRetryableDependencyConflict("ATTENDANCE_CANCEL_TARGET_NOT_FOUND")).toBe(true);
    expect(isRetryableDependencyConflict("ADVANCE_COVERAGE_SESSION_NOT_FOUND")).toBe(true);
    expect(isRetryableDependencyConflict("ABSENCE_NOTIFICATION_TARGET_NOT_FOUND")).toBe(true);
    expect(isRetryableDependencyConflict("ATTENDANCE_CANCEL_CENTER_MISMATCH")).toBe(false);
    expect(isRetryableDependencyConflict("ATTENDANCE_CANCEL_TARGET_MISMATCH")).toBe(false);
    expect(isRetryableDependencyConflict("MAKEUP_ORIGINAL_ABSENCE_CENTER_MISMATCH")).toBe(false);
  });
});
