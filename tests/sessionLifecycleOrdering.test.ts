import { AuditService } from "../src/core/audit";
import { DatabaseService } from "../src/core/database";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { AbsenceReportsService } from "../src/features/attendance/AbsenceReportsService";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { sortSessionsByActivation } from "../src/features/sessions/sessionOrdering";

jest.mock("expo-device", () => ({ modelName: "Test Device" }));

const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

describe("attendance session lifecycle and ordering", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");
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
  });
});
