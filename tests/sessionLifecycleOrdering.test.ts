import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { AbsenceReportsService } from "../src/features/attendance/AbsenceReportsService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { DashboardService } from "../src/features/dashboard/DashboardService";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import {
  CenterTimeZoneConfigurationError,
  SessionDateService,
} from "../src/features/sessions/SessionDateService";
import { SessionGenerationService } from "../src/features/sessions/SessionGenerationService";
import { ScannerService } from "../src/features/scanner/ScannerService";
import { sortSessionsByActivation } from "../src/features/sessions/sessionOrdering";
import { getDateOnlyInTimeZone } from "../src/shared/utils/date";
import { stableSessionId } from "../src/shared/utils/stableIds";

jest.mock("expo-device", () => ({ modelName: "Test Device" }));

const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const setCenterTimeZone = (timeZone: string | null) => {
  const db = DatabaseService.getDb();
  const center = db.getFirstSync<{ id: string; name: string; code: string }>(
    "SELECT id, name, code FROM centers WHERE id = ?",
    ["center-1"],
  );
  if (!center) throw new Error("The local session test center was not seeded.");
  db.runSync(
    `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
    [center.id, center.name, center.code, timeZone],
  );
};

describe("attendance session lifecycle and ordering", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
    setCenterTimeZone("Africa/Cairo");
  });

  it("uses the center's date and month across midnight when device dates differ", () => {
    const instant = new Date("2026-10-31T22:30:00.000Z");
    const honoluluDate = getDateOnlyInTimeZone(instant, "Pacific/Honolulu");
    const tokyoDate = getDateOnlyInTimeZone(instant, "Asia/Tokyo");

    expect(honoluluDate).toBe("2026-10-31");
    expect(tokyoDate).toBe("2026-11-01");
    expect(SessionDateService.getCurrentSessionDate("center-1", instant)).toBe("2026-11-01");
    expect(SessionDateService.getCurrentSessionMonth("center-1", instant)).toBe("2026-11");
  });

  it("uses the center-local date in dashboard and scanner default queries", () => {
    const centerDate = "2030-05-06";
    const sessionDateSpy = jest
      .spyOn(SessionDateService, "getCurrentSessionDate")
      .mockReturnValue(centerDate);
    const db = DatabaseService.getDb();
    const reads = jest.spyOn(db, "getAllSync");

    try {
      DashboardService.getTodaySummary();
      ScannerService.getEligibleSessionsForStudent("date-consumer-student");

      expect(sessionDateSpy).toHaveBeenCalledWith("center-1");
      const queryCalls = reads.mock.calls as unknown as Array<[string, unknown[]]>;
      expect(queryCalls.some(([sql, params]) =>
        sql.includes("FROM sessions WHERE center_id = ?") &&
        params.includes(centerDate),
      )).toBe(true);
      expect(queryCalls.some(([sql, params]) =>
        sql.includes("FROM sessions s") &&
        params[1] === "center-1" &&
        params[2] === centerDate,
      )).toBe(true);
    } finally {
      reads.mockRestore();
      sessionDateSpy.mockRestore();
    }
  });

  it("blocks new scheduled sessions when the center time zone is missing or invalid", () => {
    const db = DatabaseService.getDb();
    const date = localDate();
    const scheduleId = `missing-time-zone-${Date.now()}`;
    const day = new Date(`${date}T12:00:00`).getDay();
    db.runSync(
      `INSERT INTO group_schedules
         (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', ?, '10:00', '11:00', 'active', ?)`,
      [scheduleId, day, new Date().toISOString()],
    );

    setCenterTimeZone(null);
    expect(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date, scheduleId))
      .toThrow("has no configured IANA time zone");
    let missingTimeZoneError: unknown;
    try {
      SessionDateService.getCenterTimeZone("center-1");
    } catch (error) {
      missingTimeZoneError = error;
    }
    expect(missingTimeZoneError).toBeInstanceOf(CenterTimeZoneConfigurationError);
    expect(missingTimeZoneError).toMatchObject({ issue: "missing" });
    expect(() => SessionGenerationService.generateSessionsForRange(date, date))
      .toThrow("has no configured IANA time zone");
    setCenterTimeZone("Invalid/Zone");
    expect(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date, scheduleId))
      .toThrow("invalid IANA time zone");
    let invalidTimeZoneError: unknown;
    try {
      SessionDateService.getCenterTimeZone("center-1");
    } catch (error) {
      invalidTimeZoneError = error;
    }
    expect(invalidTimeZoneError).toBeInstanceOf(CenterTimeZoneConfigurationError);
    expect(invalidTimeZoneError).toMatchObject({ issue: "invalid" });
    expect(db.getFirstSync(
      "SELECT id FROM sessions WHERE center_id = ? AND id = ?",
      ["center-1", stableSessionId("center-1", "grp-1", scheduleId, date)],
    )).toBeNull();
    setCenterTimeZone("Africa/Cairo");
  });

  it("does not rewrite historical session IDs or dates when a center time zone is configured", () => {
    const db = DatabaseService.getDb();
    const historicalSessionId = `historical-zone-session-${Date.now()}`;
    db.runSync(
      `INSERT INTO sessions
         (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', NULL, '2019-03-31', '10:00', '11:00', 'closed', ?)`,
      [historicalSessionId, new Date().toISOString()],
    );
    const before = db.getFirstSync<{ id: string; session_date: string }>(
      "SELECT id, session_date FROM sessions WHERE center_id = ? AND id = ?",
      ["center-1", historicalSessionId],
    );

    setCenterTimeZone("Africa/Cairo");

    const after = db.getFirstSync<{ id: string; session_date: string }>(
      "SELECT id, session_date FROM sessions WHERE center_id = ? AND id = ?",
      ["center-1", historicalSessionId],
    );
    expect(after).toEqual(before);
  });

  it("sorts latest activations first with a stable tie-breaker", () => {
    const sessions = [
      { id: "session-b", groupId: "group-b", sessionDate: "2026-10-11", startTime: "10:00" },
      { id: "session-a", groupId: "group-a", sessionDate: "2026-10-11", startTime: "10:00" },
      { id: "session-old", groupId: "group-c", sessionDate: "2026-10-10", startTime: "10:00" },
    ];
    const activationTimes = new Map([
      ["session-a", "2026-10-11T10:00:00.000Z"],
      ["session-b", "2026-10-11T10:00:00.000Z"],
      ["session-old", "2026-10-10T10:00:00.000Z"],
    ]);

    expect(sortSessionsByActivation(sessions, activationTimes).map(({ id }) => id))
      .toEqual(["session-a", "session-b", "session-old"]);
  });

  it("activates a scheduled session with one durable, retryable activation operation", () => {
    const db = DatabaseService.getDb();
    const sessionId = `activation-session-${Date.now()}`;
    const sessionDate = "2034-06-01";
    db.runSync(
      `INSERT INTO sessions
         (id, center_id, group_id, schedule_id, session_date, start_time,
          end_time, status, created_at, updated_at)
       VALUES (?, 'center-1', 'grp-1', ?, ?, '10:00', '11:00',
               'scheduled', ?, ?)`,
      [
        sessionId,
        `activation-schedule-${Date.now()}`,
        sessionDate,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const operationId = `op-session-activate-${sessionId}`;
    const expectedStudents = jest
      .spyOn(AttendanceSessionService, "getExpectedStudentIdsForGroup")
      .mockReturnValue([]);
    const eligibleStudents = jest
      .spyOn(SessionRepository, "getEligibleStudentIdsForSession")
      .mockReturnValue([]);
    const audit = jest.spyOn(AuditService, "recordEvent");
    const sync = jest.spyOn(SyncEngine, "syncCenterNow").mockResolvedValue({
      syncedCount: 0,
      errors: 0,
      conflicts: 0,
      state: "offline",
      arabicMessage: "",
    });

    try {
      AttendanceSessionService.activate(sessionId);
      expect(SessionRepository.findById(sessionId)?.status).toBe("open");

      const activationOperation = SyncRepository.getByOperationId(operationId);
      expect(activationOperation).toMatchObject({
        entityType: "session",
        entityId: sessionId,
        operationType: "UPDATE",
      });
      expect(JSON.parse(String(activationOperation?.payload))).toMatchObject({
        action: "activate",
        status: "open",
      });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        operationId,
        entityId: sessionId,
        action: "session.activated",
      }));

      AttendanceSessionService.activate(sessionId);
      expect(SyncRepository.getByOperationId(operationId)?.operationId).toBe(operationId);
      expect(db.getAllSync(
        `SELECT id FROM sync_operations WHERE operation_id = ?`,
        [operationId],
      )).toHaveLength(1);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(SyncRepository.resolvePulledSessionStatus("scheduled", "open", "activate")).toBe("open");
      expect(SyncRepository.resolvePulledSessionStatus("cancelled", "open", "activate")).toBe("cancelled");
      expect(SyncRepository.resolvePulledSessionStatus("closed", "open", "activate")).toBe("closed");
      expect(SyncRepository.resolvePulledSessionStatus("completed", "open", "activate")).toBe("completed");
    } finally {
      expectedStudents.mockRestore();
      eligibleStudents.mockRestore();
      audit.mockRestore();
      sync.mockRestore();
    }
  });

  it("creates deterministic session IDs with enough key space for independent devices", () => {
    const first = stableSessionId("center", "group", "schedule-a", "2026-10-12");
    expect(first).toBe(stableSessionId("center", "group", "schedule-a", "2026-10-12"));
    expect(first).toBe(stableSessionId(
      " center ",
      "group",
      " schedule-a ",
      "2026-10-12T23:30:00.000Z",
    ));
    expect(first).not.toBe(stableSessionId("center", "group", "schedule-b", "2026-10-12"));
    expect(first).toHaveLength(21);
    expect(() => stableSessionId("center", "group", "", "2026-10-12"))
      .toThrow("A scheduled session identity requires center, group, schedule, and date.");
  });

  it("keeps same-day unscheduled sessions separate and requires an explicit legacy session ID", async () => {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const date = localDate();
    const groupId = `unscheduled-group-${Date.now()}`;
    const groupTemplate = db.getFirstSync<{
      teacherId: string;
      subjectId: string;
      grade: string;
    }>(
      `SELECT teacher_id as teacherId, subject_id as subjectId, grade
         FROM groups
        WHERE center_id = ? AND status = 'active'
        LIMIT 1`,
      ["center-1"],
    );
    expect(groupTemplate).toBeTruthy();
    db.runSync(
      `INSERT INTO groups
         (id, center_id, name, teacher_id, subject_id, grade, default_fee,
          session_price, monthly_price, status, created_at, updated_at)
       VALUES (?, 'center-1', 'Unscheduled identity test', ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
      [
        groupId,
        groupTemplate!.teacherId,
        groupTemplate!.subjectId,
        groupTemplate!.grade,
        now,
        now,
      ],
    );
    const scheduleId = `unscheduled-group-schedule-${Date.now()}`;
    const day = new Date(`${date}T12:00:00`).getDay();
    db.runSync(
      `INSERT INTO group_schedules
         (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', ?, ?, '10:00', '11:00', 'active', ?)`,
      [scheduleId, groupId, day, now],
    );

    const firstSessionId = `offline-unscheduled-a-${Date.now()}`;
    const secondSessionId = `offline-unscheduled-b-${Date.now()}`;
    for (const sessionId of [firstSessionId, secondSessionId]) {
      db.runSync(
        `INSERT INTO sessions
           (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, 'center-1', ?, NULL, ?, '10:00', '11:00', 'open', ?)`,
        [sessionId, groupId, date, now],
      );
    }

    expect(() => AttendanceSessionService.ensureSessionForGroup(groupId, date))
      .toThrow("لا يمكن اختيار جلسة قديمة بلا موعد اعتمادًا على المجموعة والتاريخ فقط");
    expect(AttendanceSessionService.ensureSessionForGroup(groupId, date, undefined, firstSessionId).id)
      .toBe(firstSessionId);
    expect(AttendanceSessionService.ensureSessionForGroup(groupId, date, undefined, secondSessionId).id)
      .toBe(secondSessionId);
    const scheduled = AttendanceSessionService.ensureSessionForGroup(
      groupId,
      date,
      scheduleId,
    );
    expect(
      AttendanceSessionService.ensureSessionForGroup(groupId, date, scheduleId).id,
    ).toBe(scheduled.id);
    expect([firstSessionId, secondSessionId]).not.toContain(scheduled.id);

    SyncRepository.recordSessionMappings("center-1", [{
      localSessionId: firstSessionId,
      canonicalSessionId: secondSessionId,
    }]);
    expect(SyncRepository.resolveSessionAlias("center-1", firstSessionId))
      .toBe(firstSessionId);
  });

  it("uses synced update time only as a fallback for a still-open session", () => {
    const sessions = [
      { id: "closed-session", groupId: "group-a", sessionDate: "2026-10-11", startTime: "10:00", status: "closed" as const, updatedAt: "2026-10-11T12:00:00.000Z" },
      { id: "open-session", groupId: "group-b", sessionDate: "2026-10-10", startTime: "10:00", status: "open" as const, updatedAt: "2026-10-11T11:00:00.000Z" },
    ];

    expect(sortSessionsByActivation(sessions, new Map()).map(({ id }) => id))
      .toEqual(["open-session", "closed-session"]);
  });

  it("reuses each local session and report on re-entry, orders the newest activation first, and preserves attendance", async () => {
    const db = DatabaseService.getDb();
    const date = localDate();
    const day = new Date(`${date}T12:00:00`).getDay();
    const reportMonth = date.slice(0, 7);
    const reportsBefore = new Set(
      AbsenceReportsService.getSessionsForMonth(reportMonth).map(({ session }) => session.id),
    );
    const scheduleOne = `lifecycle-sched-1-${Date.now()}`;
    const scheduleTwo = `lifecycle-sched-2-${Date.now()}`;
    const operationUser = useAuthStore.getState().currentUser!;
    const deviceId = "session-lifecycle-test-device";

    db.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', ?, '08:00', '09:00', 'active', ?)`,
      [scheduleOne, day, new Date().toISOString()],
    );
    db.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-2', ?, '09:00', '10:00', 'active', ?)`,
      [scheduleTwo, day, new Date().toISOString()],
    );
    const secondSlotForGroupOne = `lifecycle-sched-1-second-${Date.now()}`;
    db.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', ?, '10:00', '11:00', 'active', ?)`,
      [secondSlotForGroupOne, day, new Date().toISOString()],
    );

    expect(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date))
      .toThrow("للمجموعة أكثر من موعد اليوم");
    const first = AttendanceSessionService.ensureSessionForGroup("grp-1", date, scheduleOne);
    const firstExpected = SessionRepository.getExpectedStudents(first.id);
    const studentId = firstExpected[0]?.id || "std-1";
    db.runSync(
      `INSERT OR IGNORE INTO session_expected_students (id, center_id, session_id, student_id, created_at)
       VALUES (?, 'center-1', ?, ?, ?)`,
      [`expected-${first.id}-${studentId}`, first.id, studentId, new Date().toISOString()],
    );
    db.runSync(
      `INSERT OR IGNORE INTO attendance (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
       VALUES (?, 'center-1', ?, ?, ?, 'present', 0, 'present', ?)`,
      [`attendance-${first.id}-${studentId}`, studentId, first.id, new Date().toISOString(), `attendance-op-${first.id}-${studentId}`],
    );
    const attendanceBefore = db.getAllSync(
      "SELECT id, student_id, session_id, status, operation_id FROM attendance WHERE center_id = ? AND session_id = ?",
      ["center-1", first.id],
    );

    const rapidReopens = await Promise.all([
      Promise.resolve().then(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date, scheduleOne)),
      Promise.resolve().then(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date, scheduleOne)),
    ]);
    expect(rapidReopens.map((session) => session.id)).toEqual([first.id, first.id]);
    expect(rapidReopens[0].status).toBe("open");
    expect(SessionRepository.getSessionsForDate(date).filter(
      (session) => session.centerId === "center-1" && session.groupId === "grp-1" && session.scheduleId === scheduleOne,
    )).toHaveLength(1);
    expect(db.getAllSync(
      "SELECT id, student_id, session_id, status, operation_id FROM attendance WHERE center_id = ? AND session_id = ?",
      ["center-1", first.id],
    )).toEqual(attendanceBefore);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = AttendanceSessionService.ensureSessionForGroup("grp-2", date, scheduleTwo);
    const secondAgain = AttendanceSessionService.ensureSessionForGroup("grp-2", date, scheduleTwo);
    expect(secondAgain.id).toBe(second.id);

    const activationTimes = SessionRepository.getActivationTimestamps([first.id, second.id]);
    expect(activationTimes.get(second.id)).toBeTruthy();
    expect(activationTimes.get(second.id)!.localeCompare(activationTimes.get(first.id)!)).toBeGreaterThan(0);

    const reports = AbsenceReportsService.getSessionsForMonth(reportMonth);
    expect(reports.filter(({ session }) => session.id === first.id)).toHaveLength(1);
    expect(reports.filter(({ session }) => session.id === second.id)).toHaveLength(1);
    expect(reports[0].session.id).toBe(second.id);
    for (const previousId of reportsBefore) {
      expect(reports.some(({ session }) => session.id === previousId)).toBe(true);
    }
    expect(SessionRepository.getSessionsForDate(date).filter(
      (session) => session.centerId === "center-1" && [first.id, second.id].includes(session.id),
    )).toHaveLength(2);

    AuditService.recordEvent({
      operationId: `foreign-center-${Date.now()}`,
      centerId: "center-2",
      userId: operationUser!.id,
      deviceId,
      entityType: "session",
      entityId: "center-2-session",
      action: "session.activated",
      payload: {},
    });
    expect(SessionRepository.getActivationTimestamps([first.id, "center-2-session"]).has("center-2-session")).toBe(false);

    db.runSync(
      `INSERT INTO sessions (id, center_id, group_id, schedule_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', ?, ?, '07:00', '08:00', 'closed', ?)`,
      [`closed-session-${Date.now()}`, `closed-schedule-${Date.now()}`, date, new Date().toISOString()],
    );
    const closedSession = SessionRepository.getSessionsForDate(date).find((session) => session.status === "closed");
    expect(closedSession).toBeTruthy();
    expect(() => AttendanceSessionService.activate(closedSession!.id)).toThrow("لا يمكن بدء جلسة مغلقة أو ملغاة.");
    expect(SessionRepository.findById(closedSession!.id)?.status).toBe("closed");

    const cancelledSchedule = `cancelled-schedule-${Date.now()}`;
    db.runSync(
      `INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', ?, '12:00', '13:00', 'active', ?)`,
      [cancelledSchedule, day, new Date().toISOString()],
    );
    const cancelled = AttendanceSessionService.ensureSessionForGroup("grp-1", date, cancelledSchedule);
    db.runSync(
      "UPDATE sessions SET status = 'cancelled' WHERE center_id = ? AND id = ?",
      ["center-1", cancelled.id],
    );
    expect(() => AttendanceSessionService.ensureSessionForGroup("grp-1", date, cancelledSchedule))
      .toThrow("الجلسة ملغاة ولا يمكن إعادة تفعيلها.");
    expect(SessionRepository.findById(cancelled.id)?.status).toBe("cancelled");
  });
});
