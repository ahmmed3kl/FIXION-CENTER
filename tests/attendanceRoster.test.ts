import {
  calculateSessionAttendanceCounts,
  excludeCompensationVisitorsFromExpectedRoster,
  filterExpectedStudentIdsByEligibility,
  getSessionExpectedStudentIds,
} from "../src/features/attendance/AttendanceCalculations";

describe("session attendance roster", () => {
  const sessionId = "destination-session";

  it("does not count a compensation-only visitor as an expected student or absent", () => {
    const expectedIds = getSessionExpectedStudentIds(sessionId, [
      { id: `exp-${sessionId}-member-1`, studentId: "member-1" },
      { id: `exp-${sessionId}-member-2`, studentId: "member-2" },
      { id: `exp-comp-${sessionId}-visitor`, studentId: "visitor" },
    ]);
    const attendance = [{
      studentId: "visitor",
      status: "present" as const,
      attendanceType: "makeup" as const,
      originalAbsenceId: "source-session",
      originalAbsenceValid: true,
    }];
    const eligibleExpectedIds = excludeCompensationVisitorsFromExpectedRoster(
      expectedIds,
      attendance,
      ["member-1", "member-2"],
    );

    expect(eligibleExpectedIds).toEqual(["member-1", "member-2"]);
    expect(calculateSessionAttendanceCounts(eligibleExpectedIds, attendance)).toEqual({
      expected: 2,
      present: 0,
      absent: 2,
      late: 0,
      makeup: 1,
    });
  });

  it("preserves a student's independent membership in each of multiple groups", () => {
    const attendance = [{
      studentId: "shared-student",
      status: "present" as const,
      attendanceType: "makeup" as const,
      originalAbsenceId: "source-session",
      originalAbsenceValid: true,
    }];
    const groupOneRoster = excludeCompensationVisitorsFromExpectedRoster(
      ["shared-student"],
      attendance,
      ["shared-student"],
    );
    const groupTwoRoster = excludeCompensationVisitorsFromExpectedRoster(
      ["shared-student"],
      attendance,
      ["shared-student"],
    );
    const unrelatedGroupRoster = excludeCompensationVisitorsFromExpectedRoster(
      ["shared-student"],
      attendance,
      [],
    );

    expect(groupOneRoster).toEqual(["shared-student"]);
    expect(groupTwoRoster).toEqual(["shared-student"]);
    expect(unrelatedGroupRoster).toEqual([]);
  });

  it("does not treat failed or unlinked makeup rows as successful roster compensation", () => {
    expect(excludeCompensationVisitorsFromExpectedRoster(
      ["visitor"],
      [{
        studentId: "visitor",
        status: "absent",
        attendanceType: "makeup",
        originalAbsenceId: "source-session",
        originalAbsenceValid: true,
      }],
      [],
    )).toEqual(["visitor"]);

    expect(excludeCompensationVisitorsFromExpectedRoster(
      ["visitor"],
      [{
        studentId: "visitor",
        status: "present",
        attendanceType: "makeup",
        originalAbsenceId: undefined,
        originalAbsenceValid: true,
      }],
      [],
    )).toEqual(["visitor"]);

    expect(excludeCompensationVisitorsFromExpectedRoster(
      ["visitor"],
      [{
        studentId: "visitor",
        status: "present",
        attendanceType: "makeup",
        originalAbsenceId: "missing-source-session",
        originalAbsenceValid: false,
      }],
      [],
    )).toEqual(["visitor"]);
  });

  it("filters three legacy compensation snapshot rows against actual session eligibility", () => {
    const compensationVisitors = ["visitor-1", "visitor-2", "visitor-3"];
    const legacySnapshot = compensationVisitors.map((studentId) => studentId);
    const eligibleStudentIds: string[] = [];
    const filtered = filterExpectedStudentIdsByEligibility(
      legacySnapshot,
      eligibleStudentIds,
    );

    expect(filtered).toEqual([]);
    expect(calculateSessionAttendanceCounts(filtered, [])).toEqual({
      expected: 0,
      present: 0,
      absent: 0,
      late: 0,
      makeup: 0,
    });
  });

  it("retains an eligible group member even when their history includes compensation", () => {
    const filtered = filterExpectedStudentIdsByEligibility(
      ["member", "visitor"],
      ["member"],
    );

    expect(filtered).toEqual(["member"]);
    expect(calculateSessionAttendanceCounts(filtered, [])).toMatchObject({
      expected: 1,
      absent: 1,
    });
  });

  it("keeps stale visitors out after a sync-style snapshot replay and reload", () => {
    const snapshotAfterReplay = ["visitor-1", "visitor-2", "visitor-3"];
    const eligibleStudentIds = ["real-member"];
    const firstLoad = filterExpectedStudentIdsByEligibility(
      snapshotAfterReplay,
      eligibleStudentIds,
    );
    const reloadedFromPersistedSnapshot = filterExpectedStudentIdsByEligibility(
      snapshotAfterReplay,
      eligibleStudentIds,
    );

    expect(firstLoad).toEqual([]);
    expect(reloadedFromPersistedSnapshot).toEqual([]);
  });
});
