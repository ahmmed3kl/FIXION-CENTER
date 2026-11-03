import { DatabaseService } from "../src/core/database";
import { LocalDataEvents } from "../src/core/database/localDataEvents";
import { DuplicateAttendanceError } from "../src/core/errors";
import { RolePermissions } from "../src/core/permissions";
import { SyncEngine, SyncRepository } from "../src/core/sync";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { recordScannedAttendanceIfEligible } from "../src/features/attendance/barcodeAttendance";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { EnrollmentRepository } from "../src/features/enrollments/EnrollmentRepository";
import { GroupRepository } from "../src/features/groups/GroupRepository";
import { GroupScheduleRepository } from "../src/features/groups/GroupScheduleRepository";
import { DebtCycleRepository } from "../src/features/payments/DebtCycleRepository";
import { FinancialCalculationService } from "../src/features/payments/FinancialCalculationService";
import { StudentCardRepository } from "../src/features/students/StudentCardRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("Phase 1 Performance Optimizations", () => {
  const centerId = "center-perf-phase1";
  const userId = "user-admin-perf1";

  beforeAll(() => {
    DatabaseService.init();
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();

    db.runSync(
      `INSERT INTO centers (id, name, slug, status, time_zone, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'Africa/Cairo', ?, ?)`,
      [centerId, "مركز الأداء", "perf-center", now, now],
    );
    db.runSync(
      `INSERT INTO users (id, center_id, full_name, username, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
      [userId, centerId, "مدير النظام", "admin_perf", now, now],
    );
    db.runSync(
      `INSERT INTO subjects (id, center_id, name, status, created_at, updated_at)
       VALUES ('subj-perf-1', ?, 'الرياضيات', 'active', ?, ?)`,
      [centerId, now, now],
    );
    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, created_at, updated_at)
       VALUES ('teach-perf-1', ?, 'أ. أحمد', '01000000001', 'active', ?, ?)`,
      [centerId, now, now],
    );
    db.runSync(
      `INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at)
       VALUES ('ts-perf-1', ?, 'teach-perf-1', 'subj-perf-1', ?)`,
      [centerId, now],
    );

    useAuthStore.setState({
      isAuthenticated: true,
      activeCenterId: centerId,
      currentUser: {
        id: userId,
        centerId,
        fullName: "مدير النظام",
        username: "admin_perf",
        role: "admin",
        status: "active",
        permissions: RolePermissions.admin,
      } as any,
    });
  });

  beforeEach(() => {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    db.runSync("DELETE FROM card_ranges WHERE center_id = ?", [centerId]);
    db.runSync(
      `INSERT INTO card_ranges (id, center_id, start_code, end_code, status, created_at, updated_at)
       VALUES ('cr-perf-1', ?, '00001', '09999', 'active', ?, ?)`,
      [centerId, now, now],
    );
  });

  it("1. Students & Cards: returns identical student and card data without N+1 per-student queries", () => {
    const s1 = StudentRepository.createStudent({
      fullName: "طالب أول",
      phone: "01011111111",
      parentPhone: "01022222221",
      grade: "الصف الأول الثانوي",
      cardCode: "00901",
    });
    const s2 = StudentRepository.createStudent({
      fullName: "طالب ثاني",
      phone: "01011111112",
      parentPhone: "01022222222",
      grade: "الصف الأول الثانوي",
      cardCode: "00902",
    });
    const s3 = StudentRepository.createStudent({
      fullName: "طالب ثالث محذوف",
      phone: "01011111113",
      parentPhone: "01022222223",
      grade: "الصف الأول الثانوي",
      cardCode: "00903",
    });

    // Replace s1 card and delete s3 to exercise all card resolution paths
    StudentCardRepository.replaceCard(s1.id, "00911");
    StudentRepository.deleteStudent(s3.id);

    const db = DatabaseService.getDb();
    const getFirstSyncSpy = jest.spyOn(db, "getFirstSync");
    const getAllSyncSpy = jest.spyOn(db, "getAllSync");

    try {
      const allStudents = StudentRepository.getAll(true);
      const attendanceStudents = StudentRepository.getAllForAttendance();
      const deletedStudents = StudentRepository.getDeletedStudents();

      // Zero per-row getFirstSync calls during list fetches (no N+1)
      expect(getFirstSyncSpy).toHaveBeenCalledTimes(0);
      // Batch queries only
      expect(getAllSyncSpy.mock.calls.length).toBeLessThanOrEqual(7);

      const loadedS1 = allStudents.find((item) => item.id === s1.id);
      const loadedS2 = allStudents.find((item) => item.id === s2.id);
      const loadedS3InAll = allStudents.find((item) => item.id === s3.id);
      expect(loadedS1?.cardCode).toBe("00911");
      expect(loadedS2?.cardCode).toBe("00902");
      expect(loadedS3InAll).toBeUndefined();

      expect(attendanceStudents.some((item) => item.id === s1.id)).toBe(true);
      expect(attendanceStudents.some((item) => item.id === s3.id)).toBe(false);

      const deletedS3 = deletedStudents.find((item) => item.id === s3.id);
      expect(deletedS3).toBeDefined();
      expect(deletedS3?.cardCode).toBe("00903");
      expect(deletedS3?.deletedByName).toBe("مدير النظام");
    } finally {
      getFirstSyncSpy.mockRestore();
      getAllSyncSpy.mockRestore();
    }
  });

  it("2. Attendance & Barcode: records attendance once, prevents duplicate attendance, and reuses financial calculations", async () => {
    const group = GroupRepository.createGroup({
      name: "مجموعة الأداء",
      grade: "الصف الأول الثانوي",
      subjectId: "subj-perf-1",
      teacherId: "teach-perf-1",
      defaultFee: 200,
      monthlyPrice: 200,
      sessionPrice: 50,
    });
    const student = StudentRepository.createStudent({
      fullName: "طالب الباركود",
      phone: "01033333333",
      parentPhone: "01044444444",
      grade: "الصف الأول الثانوي",
      cardCode: "00950",
    });

    const sessionDate = AttendanceSessionService.getCurrentSessionDate();
    const dayOfWeek = new Date(`${sessionDate}T00:00:00Z`).getUTCDay();
    const schedule = GroupScheduleRepository.createSchedule({
      groupId: group.id,
      dayOfWeek,
      startTime: "10:00",
      endTime: "12:00",
    });
    const enrollment = EnrollmentRepository.enrollStudent({
      studentId: student.id,
      groupId: group.id,
      startDate: sessionDate,
    });

    const session = AttendanceSessionService.ensureSessionForGroup(
      group.id,
      sessionDate,
      schedule.id,
    );
    AttendanceSessionService.activate(session.id);

    const fullStatusSpy = jest.spyOn(
      FinancialCalculationService,
      "getStudentFinancialStatus",
    );
    const cyclesFetchSpy = jest.spyOn(
      DebtCycleRepository,
      "getCyclesForEnrollment",
    );

    try {
      let recordedCount = 0;
      await recordScannedAttendanceIfEligible(
        {
          isBarcodeScan: true,
          isExpectedInSession: true,
          isMakeupEligible: false,
          isAlreadyAttended: AttendanceRepository.isAlreadyAttended(session.id, student.id),
          isSessionOpen: true,
        },
        async () => {
          await AttendanceRepository.recordAttendance({
            studentId: student.id,
            sessionId: session.id,
            status: "present",
            isLate: false,
            attendanceType: "present",
          });
          recordedCount += 1;
        },
      );

      expect(recordedCount).toBe(1);
      expect(AttendanceRepository.isAlreadyAttended(session.id, student.id)).toBe(true);

      // Compute full status once and pass it to group-scoped calculation
      fullStatusSpy.mockClear();
      cyclesFetchSpy.mockClear();

      const fullStatus = FinancialCalculationService.getStudentFinancialStatus(student.id);
      const scopedWithPrecomputed =
        FinancialCalculationService.getStudentFinancialStatusForGroup(
          student.id,
          group.id,
          undefined,
          fullStatus,
        );

      // getStudentFinancialStatus was called only once (not re-executed by getStudentFinancialStatusForGroup)
      expect(fullStatusSpy).toHaveBeenCalledTimes(1);
      // DebtCycleRepository did not perform a second redundant getCyclesForEnrollment when no new cycles were generated
      expect(cyclesFetchSpy).toHaveBeenCalledTimes(1);

      const scopedWithoutPrecomputed =
        FinancialCalculationService.getStudentFinancialStatusForGroup(
          student.id,
          group.id,
        );
      expect(scopedWithPrecomputed).toEqual(scopedWithoutPrecomputed);
      expect(enrollment.id).toBeTruthy();

      // Scanning a second time must not record duplicate attendance
      await expect(
        AttendanceRepository.recordAttendance({
          studentId: student.id,
          sessionId: session.id,
          status: "present",
          isLate: false,
          attendanceType: "present",
        }),
      ).rejects.toThrow(DuplicateAttendanceError);

      const sessionRecords = AttendanceRepository.getSessionAttendance(session.id).filter(
        (r) => r.studentId === student.id,
      );
      expect(sessionRecords).toHaveLength(1);
    } finally {
      fullStatusSpy.mockRestore();
      cyclesFetchSpy.mockRestore();
    }
  });

  it("3. Sync & Screen Updates: coalesces transaction events into a single notification while preserving all pending sync operations", () => {
    const db = DatabaseService.getDb();
    const beforeStats = SyncRepository.getStats(centerId);
    const receivedEvents: any[] = [];
    const unsubscribe = LocalDataEvents.subscribe((change) => {
      receivedEvents.push(change);
    });

    const studentRevBefore = LocalDataEvents.getRevisionForEntities(["student"]);
    const homeworkRevBefore = LocalDataEvents.getRevisionForEntities([
      "session_homework_evaluation",
    ]);

    try {
      DatabaseService.runInTransaction(() => {
        SyncRepository.enqueueOperation({
          centerId,
          userId,
          deviceId: "dev-perf-1",
          operationType: "UPDATE",
          entityType: "student",
          entityId: "st-batch-1",
          payload: { id: "st-batch-1" },
          operationId: "op-perf-batch-1",
        });
        SyncRepository.enqueueOperation({
          centerId,
          userId,
          deviceId: "dev-perf-1",
          operationType: "CREATE",
          entityType: "student_card",
          entityId: "card-batch-1",
          payload: { id: "card-batch-1" },
          operationId: "op-perf-batch-2",
        });
        SyncRepository.enqueueOperation({
          centerId,
          userId,
          deviceId: "dev-perf-1",
          operationType: "CREATE",
          entityType: "attendance",
          entityId: "att-batch-1",
          payload: { id: "att-batch-1" },
          operationId: "op-perf-batch-3",
        });
      });

      // Exactly 1 coalesced UI notification emitted for the 3 queued operations in the transaction
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].entityTypes).toEqual(
        expect.arrayContaining(["student", "student_card", "attendance"]),
      );

      // Scoped entity revision increments for "student" but NOT for unrelated "session_homework_evaluation"
      expect(LocalDataEvents.getRevisionForEntities(["student"])).toBe(
        studentRevBefore + 1,
      );
      expect(
        LocalDataEvents.getRevisionForEntities(["session_homework_evaluation"]),
      ).toBe(homeworkRevBefore);

      // All 3 sync operations are safely persisted in sync_operations
      const afterStats = SyncRepository.getStats(centerId);
      expect(afterStats.pending).toBe(beforeStats.pending + 3);

      const savedOps = db.getAllSync<{ operation_id: string }>(
        `SELECT operation_id FROM sync_operations WHERE center_id = ?`,
        [centerId],
      );
      const opIds = new Set(savedOps.map((row) => row.operation_id));
      expect(opIds.has("op-perf-batch-1")).toBe(true);
      expect(opIds.has("op-perf-batch-2")).toBe(true);
      expect(opIds.has("op-perf-batch-3")).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
