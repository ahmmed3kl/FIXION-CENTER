import { DatabaseService } from "../src/core/database";
import { ConflictError, DuplicateAttendanceError, ForbiddenError } from "../src/core/errors";
import { Strings } from "../src/core/localization";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { recordScannedAttendanceIfEligible } from "../src/features/attendance/barcodeAttendance";
import { AuditService } from "../src/core/audit";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { SessionRepository } from "../src/features/sessions/SessionRepository";

describe("attendance duplicate protection", () => {
  beforeAll(async () => {
    DatabaseService.init();
    await useAuthStore.getState().login("01000000001", "123456");
    await useAuthStore.getState().selectCenter("center-1");

    const db = DatabaseService.getDb();
    const center = db.getFirstSync<{ id: string; name: string; code: string }>(
      "SELECT id, name, code FROM centers WHERE id = ?",
      ["center-1"],
    );
    if (!center) throw new Error("The local attendance test center was not seeded.");
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
      [center.id, center.name, center.code, "Africa/Cairo"],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["sess-duplicate-race", "center-1", "grp-1", "subj-1", "teach-1", "2099-10-01", "10:00", "12:00", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["exp-duplicate-race", "center-1", "sess-duplicate-race", "std-1", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["sess-duplicate-other", "center-1", "grp-1", "subj-1", "teach-1", "2099-10-15", "10:00", "12:00", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["exp-duplicate-other", "center-1", "sess-duplicate-other", "std-1", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["sess-duplicate-makeup", "center-1", "grp-1", "subj-1", "teach-1", "2099-10-22", "10:00", "12:00", "2026-09-20"],
    );
    await AttendanceRepository.recordAttendance({
      studentId: "std-2",
      sessionId: "sess-1",
      status: "present",
      isLate: false,
    });
  });

  it("shows the required warning text for a repeated attendance attempt", async () => {
    expect(Strings.duplicateScanWarning).toBe("تم تحضير الطالب مسبقًا");

    await AttendanceRepository.recordAttendance({
      studentId: "std-1",
      sessionId: "sess-duplicate-race",
      status: "present",
      isLate: false,
    });

    await expect(
      AttendanceRepository.recordAttendance({
        studentId: "std-1",
        sessionId: "sess-duplicate-race",
        status: "present",
        isLate: false,
      }),
    ).rejects.toBeInstanceOf(DuplicateAttendanceError);
  });

  it("allows only one concurrent submission and queues exactly one operation", async () => {
    const db = DatabaseService.getDb();
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["sess-duplicate-concurrent", "center-1", "grp-1", "subj-1", "teach-1", "2099-10-08", "10:00", "12:00", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["exp-duplicate-concurrent", "center-1", "sess-duplicate-concurrent", "std-1", "2026-09-20"],
    );

    const [attendanceBefore, operationsBefore] = [
      AttendanceRepository.getSessionAttendance("sess-duplicate-concurrent"),
      SyncRepository.getRecentOperations("center-1", 1000)
        .filter((operation) => operation.operationType === "attendance.create"),
    ];

    const attempts = await Promise.allSettled([
      AttendanceRepository.recordAttendance({
        studentId: "std-1",
        sessionId: "sess-duplicate-concurrent",
        status: "present",
        isLate: false,
      }),
      AttendanceRepository.recordAttendance({
        studentId: "std-1",
        sessionId: "sess-duplicate-concurrent",
        status: "present",
        isLate: false,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: expect.any(DuplicateAttendanceError),
    });

    const savedAttendance = AttendanceRepository.getSessionAttendance("sess-duplicate-concurrent")
      .filter((record) => record.studentId === "std-1");
    expect(savedAttendance).toHaveLength(attendanceBefore.length + 1);
    const newAttendanceId = savedAttendance[0].id;
    const newOperations = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.operationType === "attendance.create"
        && operation.entityId === newAttendanceId);
    expect(newOperations).toHaveLength(1);
    expect(SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.operationType === "attendance.create"))
      .toHaveLength(operationsBefore.length + 1);
  });

  it("persists an eligible regular scan locally and queues one operation while sync is offline", async () => {
    const db = DatabaseService.getDb();
    const sessionId = "sess-barcode-offline";
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, 'center-1', 'grp-1', 'subj-1', 'teach-1', '2099-10-08', '10:00', '12:00', 'open', '2026-09-20')`,
      [sessionId],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, 'center-1', ?, 'std-1', '2026-09-20')`,
      [`exp-${sessionId}`, sessionId],
    );
    const attendanceParams = {
      isBarcodeScan: true,
      isExpectedInSession: AttendanceSessionService.isExpected(sessionId, "std-1"),
      isMakeupEligible: false,
      isAlreadyAttended: AttendanceRepository.isAlreadyAttended(sessionId, "std-1"),
      isSessionOpen: true,
    };

    const syncOffline = jest.spyOn(SyncEngine, "syncCenterNow")
      .mockRejectedValue(new Error("offline"));
    try {
      let attendanceId = "";
      await recordScannedAttendanceIfEligible(attendanceParams, async () => {
        const attendance = await AttendanceRepository.recordAttendance({
          studentId: "std-1",
          sessionId,
          status: "present",
          isLate: false,
        });
        attendanceId = attendance.id;
      });
      expect(attendanceId).toBeTruthy();
      expect(AttendanceRepository.getStudentAttendanceInSession(sessionId, "std-1")?.id)
        .toBe(attendanceId);
      expect(SyncRepository.getRecentOperations("center-1", 1000).filter(
        (operation) => operation.operationType === "attendance.create"
          && operation.entityId === attendanceId,
      )).toHaveLength(1);
      expect(syncOffline).toHaveBeenCalledTimes(1);

      await recordScannedAttendanceIfEligible({
        ...attendanceParams,
        isAlreadyAttended: AttendanceRepository.isAlreadyAttended(sessionId, "std-1"),
      }, async () => {
        await AttendanceRepository.recordAttendance({
          studentId: "std-1",
          sessionId,
          status: "present",
          isLate: false,
        });
      });
      expect(SyncRepository.getRecentOperations("center-1", 1000).filter(
        (operation) => operation.operationType === "attendance.create"
          && operation.entityId === attendanceId,
      )).toHaveLength(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it("does not treat a previous attendance in another session as a duplicate", async () => {
    const attendance = await AttendanceRepository.recordAttendance({
      studentId: "std-1",
      sessionId: "sess-duplicate-other",
      status: "present",
      isLate: false,
    });

    expect(attendance.sessionId).toBe("sess-duplicate-other");
  });

  it("cancels only the selected session attendance and queues one audited update", async () => {
    const db = DatabaseService.getDb();
    const sessionId = "sess-cancel-attendance";
    db.runSync(
      `INSERT INTO sessions
       (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [sessionId, "center-1", "grp-1", "subj-1", "teach-1", "2099-11-01", "10:00", "12:00", "2026-09-20"],
    );
    db.runSync(
      `INSERT INTO session_expected_students
       (id, center_id, session_id, student_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`exp-${sessionId}`, "center-1", sessionId, "std-1", "2026-09-20"],
    );
    const attendance = await AttendanceRepository.recordAttendance({
      studentId: "std-1",
      sessionId,
      status: "present",
      isLate: true,
    });
    const attendanceOpsBefore = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance");
    const auditBefore = AuditService.getEntityLogs("center-1", attendance.id).length;

    const originalGetFirst = db.getFirstSync.bind(db);
    const originalRunSync = db.runSync.bind(db);
    let cancellationApplied = false;
    jest.spyOn(db, "getFirstSync").mockImplementation(((sql: string, params?: any[]) => {
      if (sql.includes("FROM attendance a") && sql.includes("ss.group_id as groupId")) {
        return {
          ...attendance,
          status: cancellationApplied ? "absent" : attendance.status,
          isLate: cancellationApplied ? false : attendance.isLate,
          centerId: "center-1",
          groupId: "grp-1",
          groupName: "مجموعة اختبار",
          sessionDate: "2099-11-01",
          startTime: "10:00",
          attendanceType: "present",
          originalAbsenceId: null,
          isExternal: false,
        } as any;
      }
      if (sql.includes("SELECT status FROM attendance") && params?.[1] === attendance.id) {
        return { status: cancellationApplied ? "absent" : attendance.status } as any;
      }
      return originalGetFirst(sql, params);
    }) as any);
    jest.spyOn(db, "runSync").mockImplementation(((sql: string, params?: any[]) => {
      if (sql.includes("UPDATE attendance SET status = 'absent'")) {
        expect(params).toEqual(["center-1", attendance.id, sessionId, "std-1"]);
        cancellationApplied = true;
        return { changes: 1 } as any;
      }
      return originalRunSync(sql, params);
    }) as any);

    let canceled;
    let repeatedCancellation;
    try {
      canceled = await AttendanceRepository.cancelAttendance(attendance.id);
      repeatedCancellation = await AttendanceRepository.cancelAttendance(attendance.id);
    } finally {
      jest.restoreAllMocks();
    }
    expect(canceled).toMatchObject({
      id: attendance.id,
      sessionId,
      studentId: "std-1",
      status: "absent",
      isLate: false,
      isDerivedAbsence: false,
    });

    const cancelOps = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance"
        && operation.entityId === attendance.id
        && operation.operationType === "UPDATE");
    expect(cancelOps).toHaveLength(1);
    expect(JSON.parse(cancelOps[0].payload)).toMatchObject({
      action: "attendance.cancel",
      status: "absent",
      sessionId,
      studentId: "std-1",
      previousStatus: "late",
      expectedOperationId: attendance.operationId,
    });
    const orderedAttendanceOps = SyncRepository.getPendingOperations("center-1")
      .filter((operation) => operation.entityType === "attendance" && operation.entityId === attendance.id)
      .map((operation) => operation.operationType);
    expect(orderedAttendanceOps).toEqual(["attendance.create", "UPDATE"]);
    expect(SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance"))
      .toHaveLength(attendanceOpsBefore.length + 1);
    const entityLogs = AuditService.getEntityLogs("center-1", attendance.id);
    console.log("ENTITY_LOGS", entityLogs.map((log) => ({ action: log.action, timestamp: log.timestamp, payload: log.payload })));
    expect(entityLogs)
      .toHaveLength(auditBefore + 1);
    expect(entityLogs[0].action)
      .toBe("attendance.cancel");

    expect(repeatedCancellation?.status).toBe("absent");
    expect(SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance"
        && operation.entityId === attendance.id
        && operation.operationType === "UPDATE"))
      .toHaveLength(1);
  });

  it("requires attendance.edit before changing attendance or queueing cancellation", async () => {
    const attendance = await AttendanceRepository.recordAttendance({
      studentId: "std-2",
      sessionId: "sess-duplicate-other",
      status: "present",
      isLate: false,
    });
    const user = useAuthStore.getState().currentUser!;
    const pendingBefore = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance");

    useAuthStore.setState({
      currentUser: { ...user, permissions: user.permissions.filter((permission) => permission !== "attendance.edit") },
    });
    try {
      await expect(AttendanceRepository.cancelAttendance(attendance.id))
        .rejects.toBeInstanceOf(ForbiddenError);
      expect(AttendanceRepository.getStudentAttendanceInSession("sess-duplicate-other", "std-2")?.status)
        .toBe("present");
      expect(SyncRepository.getRecentOperations("center-1", 1000)
        .filter((operation) => operation.entityType === "attendance"))
        .toEqual(pendingBefore);
    } finally {
      useAuthStore.setState({ currentUser: user });
    }
  });

  it("rejects a student outside the active session roster without changing attendance or sync queue", async () => {
    const db = DatabaseService.getDb();
    const attendanceBefore = AttendanceRepository.getSessionAttendance(
      "sess-duplicate-race",
    );
    const operationsBefore = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.entityType === "attendance");
    const expectedSpy = jest
      .spyOn(AttendanceSessionService, "isExpected")
      .mockReturnValue(false);
    try {
      await expect(
        AttendanceRepository.recordAttendance({
          studentId: "std-2",
          sessionId: "sess-duplicate-race",
          status: "present",
          isLate: false,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(
        AttendanceRepository.getSessionAttendance("sess-duplicate-race"),
      ).toEqual(attendanceBefore);
      expect(SyncRepository.getRecentOperations("center-1", 1000)
        .filter((operation) => operation.entityType === "attendance"))
        .toEqual(operationsBefore);
      expect(db.getFirstSync(
        `SELECT 1 FROM attendance
         WHERE center_id = ? AND session_id = ? AND student_id = ?`,
        ["center-1", "sess-duplicate-race", "std-2"],
      )).toBeFalsy();
    } finally {
      expectedSpy.mockRestore();
    }
  });

  it("keeps center scoping when checking for an existing attendance", async () => {
    await useAuthStore.getState().selectCenter("center-1");
    expect(AttendanceRepository.isAlreadyAttended("sess-1", "std-2")).toBe(true);
    await useAuthStore.getState().selectCenter("center-2");
    expect(AttendanceRepository.isAlreadyAttended("sess-1", "std-2")).toBe(false);
    await useAuthStore.getState().selectCenter("center-1");
  });

  it("keeps valid makeup attendance separate from ordinary duplicate detection", async () => {
    const makeupAttendance = await AttendanceRepository.recordAttendance({
      studentId: "std-1",
      sessionId: "sess-duplicate-makeup",
      status: "present",
      isLate: false,
      attendanceType: "makeup",
      originalAbsenceId: "legacy-absence-reference",
    });
    expect(makeupAttendance.attendanceType).toBe("makeup");
  });
});
