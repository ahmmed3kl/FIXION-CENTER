import { DatabaseService } from "../src/core/database";
import { ConflictError, DuplicateAttendanceError, ForbiddenError, getUserErrorMessage } from "../src/core/errors";
import { Strings } from "../src/core/localization";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { recordScannedAttendanceIfEligible } from "../src/features/attendance/barcodeAttendance";
import { AuditService } from "../src/core/audit";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { SessionRepository } from "../src/features/sessions/SessionRepository";
import { SessionDateService } from "../src/features/sessions/SessionDateService";

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
      if (sql.includes("UPDATE attendance") && sql.includes("status = 'absent'")) {
        expect(params?.slice(1)).toEqual(["center-1", attendance.id, sessionId, "std-1"]);
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

  it("rejects makeup attendance when its source session cannot be resolved", async () => {
    const sessionId = "sess-duplicate-makeup";
    const attendanceBefore = AttendanceRepository.getSessionAttendance(sessionId)
      .filter((record) => record.studentId === "std-1");
    const operationsBefore = SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.operationType === "attendance.create").length;

    await expect(AttendanceRepository.recordAttendance({
      studentId: "std-1",
      sessionId,
      status: "present",
      isLate: false,
      attendanceType: "makeup",
      originalAbsenceId: "missing-source-session",
    })).rejects.toBeInstanceOf(ConflictError);

    expect(AttendanceRepository.getSessionAttendance(sessionId)
      .filter((record) => record.studentId === "std-1")).toEqual(attendanceBefore);
    expect(SyncRepository.getRecentOperations("center-1", 1000)
      .filter((operation) => operation.operationType === "attendance.create"))
      .toHaveLength(operationsBefore);
  });

  describe("makeup attendance duplicate detection regression", () => {
    const centerId = "center-1";
    const sourceGroupId = "grp-makeup-dup-source";
    const hostGroupId = "grp-makeup-dup-host";
    const otherHostGroupId = "grp-makeup-dup-other-host";
    const sourceSessionId = "sess-makeup-dup-source";
    const hostSessionId = "sess-makeup-dup-host";
    const secondHostSessionId = "sess-makeup-dup-host-2";
    const advanceHostSessionId = "sess-makeup-dup-advance-host";
    const advanceSecondHostSessionId = "sess-makeup-dup-advance-host-2";
    const regularHostSessionId = "sess-makeup-dup-regular-host";
    const makeupStudentId = "std-makeup-dup-1";
    const advanceStudentId = "std-makeup-dup-advance";
    const regularStudentId = "std-makeup-dup-regular";

    beforeAll(() => {
      const db = DatabaseService.getDb();
      db.runSync(
        `INSERT INTO groups
         (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
         VALUES (?, ?, ?, 'teach-1', 'subj-1', 'الصف الأول الثانوي', 200, 50, 200, 'active', '2026-09-01', '2026-09-01')`,
        [sourceGroupId, centerId, "مجموعة الأصل للتعويض"],
      );
      db.runSync(
        `INSERT INTO groups
         (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
         VALUES (?, ?, ?, 'teach-1', 'subj-1', 'الصف الأول الثانوي', 200, 50, 200, 'active', '2026-09-01', '2026-09-01')`,
        [hostGroupId, centerId, "مجموعة الاستضافة للتعويض"],
      );
      db.runSync(
        `INSERT INTO groups
         (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, status, created_at, updated_at)
         VALUES (?, ?, ?, 'teach-1', 'subj-1', 'الصف الأول الثانوي', 200, 50, 200, 'active', '2026-09-01', '2026-09-01')`,
        [otherHostGroupId, centerId, "مجموعة استضافة ثانية"],
      );

      for (const [id, code, name] of [
        [makeupStudentId, "880101", "طالب تعويض غياب"],
        [advanceStudentId, "880102", "طالب تعويض مسبق"],
        [regularStudentId, "880103", "طالب حضور عادي"],
      ]) {
        db.runSync(
          `INSERT INTO students
           (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, created_at)
           VALUES (?, ?, ?, ?, ?, '01000008801', '01100008801', 'الصف الأول الثانوي', 'active', '2026-09-01')`,
          [id, centerId, code, name, code],
        );
      }

      // Enroll makeupStudentId & advanceStudentId ONLY in sourceGroupId (NOT in hostGroupId)
      db.runSync(
        `INSERT INTO student_group_enrollments
         (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, '2026-09-01', 'active', '2026-09-01')`,
        ["enr-makeup-dup-1", centerId, makeupStudentId, sourceGroupId],
      );
      db.runSync(
        `INSERT INTO student_group_enrollments
         (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, '2026-09-01', 'active', '2026-09-01')`,
        ["enr-makeup-dup-adv", centerId, advanceStudentId, sourceGroupId],
      );
      // Enroll regularStudentId in hostGroupId
      db.runSync(
        `INSERT INTO student_group_enrollments
         (id, center_id, student_id, group_id, start_date, status, created_at)
         VALUES (?, ?, ?, ?, '2026-09-01', 'active', '2026-09-01')`,
        ["enr-makeup-dup-reg", centerId, regularStudentId, hostGroupId],
      );

      // Source session (closed, with explicit absence for makeupStudentId)
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-12', '10:00', '12:00', 'closed', '2026-10-12')`,
        [sourceSessionId, centerId, sourceGroupId],
      );
      db.runSync(
        `INSERT INTO session_expected_students
         (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, '2026-10-12')`,
        ["exp-makeup-dup-source", centerId, sourceSessionId, makeupStudentId],
      );
      db.runSync(
        `INSERT INTO attendance
         (id, center_id, student_id, session_id, check_in_time, status, is_late, attendance_type, operation_id)
         VALUES (?, ?, ?, ?, '2026-10-12T10:00:00.000Z', 'absent', 0, 'present', ?)`,
        ["att-makeup-dup-source-abs", centerId, makeupStudentId, sourceSessionId, "op-makeup-dup-source-abs"],
      );

      // Host sessions in the same teacher cycle
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-13', '12:00', '14:00', 'open', '2026-10-13')`,
        [hostSessionId, centerId, hostGroupId],
      );
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-14', '12:00', '14:00', 'open', '2026-10-14')`,
        [secondHostSessionId, centerId, otherHostGroupId],
      );
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-13', '15:00', '17:00', 'open', '2026-10-13')`,
        [advanceHostSessionId, centerId, hostGroupId],
      );
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-14', '15:00', '17:00', 'open', '2026-10-14')`,
        [advanceSecondHostSessionId, centerId, otherHostGroupId],
      );
      db.runSync(
        `INSERT INTO sessions
         (id, center_id, group_id, subject_id, teacher_id, session_date, start_time, end_time, status, created_at)
         VALUES (?, ?, ?, 'subj-1', 'teach-1', '2026-10-15', '12:00', '14:00', 'open', '2026-10-15')`,
        [regularHostSessionId, centerId, hostGroupId],
      );
      db.runSync(
        `INSERT INTO session_expected_students
         (id, center_id, session_id, student_id, created_at)
         VALUES (?, ?, ?, ?, '2026-10-15')`,
        ["exp-makeup-dup-reg", centerId, regularHostSessionId, regularStudentId],
      );
    });

    it("1 & 2 & 3 & 6 & 7: first makeup registration succeeds, repeated registration in same host session returns makeup duplicate even when not enrolled in host group, preserves original session attendance, and does not consume entitlement twice", async () => {
      const dateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-13");
      try {
        // Verify student is NOT enrolled/expected in host group
        expect(AttendanceSessionService.isExpected(hostSessionId, makeupStudentId)).toBe(false);

        // 1. First makeup registration: eligible and succeeds
        const eligibilityBefore = MakeupService.getEligibilityForSession(hostSessionId, makeupStudentId);
        expect(eligibilityBefore).toMatchObject({
          eligible: true,
          originalAbsenceId: sourceSessionId,
        });

        const firstRecord = await MakeupService.recordMakeupAttendance({
          studentId: makeupStudentId,
          sessionId: hostSessionId,
          originalAbsenceId: sourceSessionId,
          checkInTime: "2026-10-13T12:10:00.000Z",
        });
        expect(firstRecord).toMatchObject({
          studentId: makeupStudentId,
          sessionId: hostSessionId,
          status: "present",
          attendanceType: "makeup",
          originalAbsenceId: sourceSessionId,
        });

        // 2 & 3. Repeated registration in the SAME host session:
        // Eligibility check recognizes existing makeup registration (alreadyRegistered: true)
        // even though the student is not enrolled in the host group
        expect(AttendanceSessionService.isExpected(hostSessionId, makeupStudentId)).toBe(false);
        expect(AttendanceRepository.isAlreadyAttended(hostSessionId, makeupStudentId)).toBe(true);
        expect(AttendanceRepository.isAlreadyRegisteredAsMakeup(hostSessionId, makeupStudentId)).toBe(true);
        expect(MakeupService.getEligibilityForSession(hostSessionId, makeupStudentId)).toMatchObject({
          eligible: false,
          alreadyRegistered: true,
          originalAbsenceId: sourceSessionId,
        });
        expect(AttendanceSessionService.getMakeupEligibility(hostSessionId, makeupStudentId)).toMatchObject({
          eligible: false,
          alreadyRegistered: true,
          originalAbsenceId: sourceSessionId,
        });

        // Repeated call via MakeupService.recordMakeupAttendance returns DuplicateAttendanceError with Arabic makeup duplicate message
        let duplicateError: unknown;
        try {
          await MakeupService.recordMakeupAttendance({
            studentId: makeupStudentId,
            sessionId: hostSessionId,
            originalAbsenceId: sourceSessionId,
          });
        } catch (err) {
          duplicateError = err;
        }
        expect(duplicateError).toBeInstanceOf(DuplicateAttendanceError);
        expect(getUserErrorMessage(duplicateError)).toBe(Strings.duplicateMakeupScanWarning);

        // Repeated call via AttendanceRepository.recordAttendance (even without makeup params) returns DuplicateAttendanceError
        await expect(
          AttendanceRepository.recordAttendance({
            studentId: makeupStudentId,
            sessionId: hostSessionId,
            status: "present",
            isLate: false,
          }),
        ).rejects.toThrow(DuplicateAttendanceError);

        await expect(
          AttendanceRepository.recordAttendance({
            studentId: makeupStudentId,
            sessionId: hostSessionId,
            status: "present",
            isLate: false,
            attendanceType: "makeup",
            originalAbsenceId: sourceSessionId,
          }),
        ).rejects.toThrow(Strings.duplicateMakeupScanWarning);

        // 6. Existing makeup attendance does not alter the original session attendance
        const originalSessionAttendance = AttendanceRepository.getStudentAttendanceInSession(
          sourceSessionId,
          makeupStudentId,
        );
        expect(originalSessionAttendance).toMatchObject({
          id: "att-makeup-dup-source-abs",
          status: "absent",
          attendanceType: "present",
        });

        // 7. Repeated scans do not create duplicate attendance rows or consume entitlement twice
        const db = DatabaseService.getDb();
        const makeupRows = db.getAllSync<{ id: string }>(
          `SELECT id FROM attendance WHERE center_id = ? AND student_id = ? AND attendance_type = 'makeup'`,
          [centerId, makeupStudentId],
        );
        expect(makeupRows).toHaveLength(1);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("4 & 7: registration in a different host session is not treated as a same-session duplicate and does not consume makeup entitlement twice (including advance makeup)", async () => {
      const dateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-13");
      try {
        // In a different host session (secondHostSessionId), makeupStudentId is NOT marked as alreadyRegistered
        expect(AttendanceRepository.isAlreadyAttended(secondHostSessionId, makeupStudentId)).toBe(false);
        expect(AttendanceRepository.isAlreadyRegisteredAsMakeup(secondHostSessionId, makeupStudentId)).toBe(false);
        const differentHostEligibility = MakeupService.getEligibilityForSession(secondHostSessionId, makeupStudentId);
        expect(differentHostEligibility.eligible).toBe(false);
        expect(differentHostEligibility.alreadyRegistered).toBeUndefined();

        // Attempting to reuse the consumed originalAbsenceId in secondHostSessionId fails with entitlement conflict, NOT DuplicateAttendanceError
        let secondSessionErr: unknown;
        try {
          await AttendanceRepository.recordAttendance({
            studentId: makeupStudentId,
            sessionId: secondHostSessionId,
            status: "present",
            isLate: false,
            attendanceType: "makeup",
            originalAbsenceId: sourceSessionId,
          });
        } catch (err) {
          secondSessionErr = err;
        }
        expect(secondSessionErr).toBeInstanceOf(ConflictError);
        expect(secondSessionErr).not.toBeInstanceOf(DuplicateAttendanceError);

        // Advance makeup without prior absence:
        const advEligibility = MakeupService.getEligibilityForSession(advanceHostSessionId, advanceStudentId);
        expect(advEligibility).toMatchObject({
          eligible: true,
          isAdvanceMakeup: true,
        });
        const advRecord = await AttendanceRepository.recordAttendance({
          studentId: advanceStudentId,
          sessionId: advanceHostSessionId,
          status: "present",
          isLate: false,
          attendanceType: "makeup",
          checkInTime: "2026-10-13T15:10:00.000Z",
        });
        expect(advRecord.attendanceType).toBe("makeup");

        // Same advanceHostSessionId -> recognized as makeup duplicate
        expect(MakeupService.getEligibilityForSession(advanceHostSessionId, advanceStudentId)).toMatchObject({
          eligible: false,
          alreadyRegistered: true,
        });
        await expect(
          AttendanceRepository.recordAttendance({
            studentId: advanceStudentId,
            sessionId: advanceHostSessionId,
            status: "present",
            isLate: false,
            attendanceType: "makeup",
          }),
        ).rejects.toThrow(DuplicateAttendanceError);

        // Different host session in same teacher cycle -> NOT a duplicate, and blocked from consuming advance makeup twice
        expect(MakeupService.getEligibilityForSession(advanceSecondHostSessionId, advanceStudentId)).toEqual({
          eligible: false,
        });
        let advSecondErr: unknown;
        try {
          await AttendanceRepository.recordAttendance({
            studentId: advanceStudentId,
            sessionId: advanceSecondHostSessionId,
            status: "present",
            isLate: false,
            attendanceType: "makeup",
          });
        } catch (err) {
          advSecondErr = err;
        }
        expect(advSecondErr).toBeInstanceOf(ConflictError);
        expect(advSecondErr).not.toBeInstanceOf(DuplicateAttendanceError);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("5: a regular attendance record does not incorrectly become a makeup duplicate", async () => {
      const dateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-15");
      try {
        const regularRecord = await AttendanceRepository.recordAttendance({
          studentId: regularStudentId,
          sessionId: regularHostSessionId,
          status: "present",
          isLate: false,
          checkInTime: "2026-10-15T12:05:00.000Z",
        });
        expect(regularRecord.attendanceType).toBe("present");
        expect(AttendanceRepository.isAlreadyAttended(regularHostSessionId, regularStudentId)).toBe(true);
        expect(AttendanceRepository.isAlreadyRegisteredAsMakeup(regularHostSessionId, regularStudentId)).toBe(false);
        expect(MakeupService.getEligibilityForSession(regularHostSessionId, regularStudentId).alreadyRegistered).toBeUndefined();
        expect(AttendanceSessionService.getMakeupEligibility(regularHostSessionId, regularStudentId).alreadyRegistered).toBeUndefined();

        let errRegularDup: unknown;
        try {
          await AttendanceRepository.recordAttendance({
            studentId: regularStudentId,
            sessionId: regularHostSessionId,
            status: "present",
            isLate: false,
          });
        } catch (err) {
          errRegularDup = err;
        }
        expect(errRegularDup).toBeInstanceOf(DuplicateAttendanceError);
        expect(getUserErrorMessage(errRegularDup)).toBe(Strings.duplicateScanWarning);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("8 & 9: center isolation is preserved and offline retry with the same operation_id does not create duplicate attendance", async () => {
      const dateSpy = jest.spyOn(SessionDateService, "getCurrentSessionDate").mockReturnValue("2026-10-13");
      try {
        // 8. Center isolation
        await useAuthStore.getState().selectCenter("center-2");
        expect(AttendanceRepository.isAlreadyAttended(hostSessionId, makeupStudentId)).toBe(false);
        expect(AttendanceRepository.isAlreadyRegisteredAsMakeup(hostSessionId, makeupStudentId)).toBe(false);
        expect(MakeupService.getEligibilityForSession(hostSessionId, makeupStudentId)).toEqual({
          eligible: false,
        });
        await useAuthStore.getState().selectCenter("center-1");
        expect(AttendanceRepository.isAlreadyRegisteredAsMakeup(hostSessionId, makeupStudentId)).toBe(true);

        // 9. Offline retry with the same operation_id does not create duplicate attendance or outbox rows
        const existingMakeup = AttendanceRepository.getStudentAttendanceInSession(
          hostSessionId,
          makeupStudentId,
        );
        expect(existingMakeup).toBeTruthy();
        const opsBefore = SyncRepository.getRecentOperations(centerId, 1000)
          .filter((op) => op.entityType === "attendance" && op.entityId === existingMakeup!.id);

        const retriedViaRepo = await AttendanceRepository.recordAttendance({
          studentId: makeupStudentId,
          sessionId: hostSessionId,
          status: "present",
          isLate: false,
          attendanceType: "makeup",
          originalAbsenceId: sourceSessionId,
          operationId: existingMakeup!.operationId,
        });
        expect(retriedViaRepo.id).toBe(existingMakeup!.id);
        expect(retriedViaRepo.operationId).toBe(existingMakeup!.operationId);

        const retriedViaService = await MakeupService.recordMakeupAttendance({
          studentId: makeupStudentId,
          sessionId: hostSessionId,
          originalAbsenceId: sourceSessionId,
          operationId: existingMakeup!.operationId,
        });
        expect(retriedViaService.id).toBe(existingMakeup!.id);

        const opsAfter = SyncRepository.getRecentOperations(centerId, 1000)
          .filter((op) => op.entityType === "attendance" && op.entityId === existingMakeup!.id);
        expect(opsAfter).toHaveLength(opsBefore.length);
      } finally {
        await useAuthStore.getState().selectCenter("center-1");
        dateSpy.mockRestore();
      }
    });
  });
});
