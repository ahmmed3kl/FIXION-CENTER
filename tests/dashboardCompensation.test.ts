import { calculateSessionAttendanceCounts } from "../src/features/attendance/AttendanceCalculations";
import { getRegularExpectedStudentIds } from "../src/features/dashboard/DashboardService";

describe("dashboard expected counts with compensation attendance", () => {
  const regularIds = ["regular-1", "regular-2", "regular-3", "regular-4"];
  const normalAttendance = regularIds.map((studentId) => ({
    studentId,
    status: "present" as const,
    attendanceType: "present" as const,
  }));

  it("keeps expected at four while a makeup visitor raises present to five", () => {
    const expectedWithRegularAttendance = getRegularExpectedStudentIds(
      regularIds,
      regularIds,
      [],
      true,
    );
    const beforeCompensation = calculateSessionAttendanceCounts(
      expectedWithRegularAttendance,
      normalAttendance,
    );
    expect(beforeCompensation.expected).toBe(4);
    expect(beforeCompensation.present).toBe(4);
    expect(beforeCompensation.makeup).toBe(0);

    const expectedWithCompensation = getRegularExpectedStudentIds(
      [...regularIds, "makeup-visitor"],
      regularIds,
      ["makeup-visitor"],
      true,
    );
    const afterCompensation = calculateSessionAttendanceCounts(
      expectedWithCompensation,
      [
        ...normalAttendance,
        {
          studentId: "makeup-visitor",
          status: "present",
          attendanceType: "makeup",
        },
      ],
    );

    expect(afterCompensation.expected).toBe(4);
    expect(afterCompensation.present + afterCompensation.makeup).toBe(5);
    expect(afterCompensation.makeup).toBe(1);
  });

  it("keeps makeup attendance from removing a genuine roster member from expected", () => {
    const expectedIds = getRegularExpectedStudentIds(
      regularIds,
      regularIds,
      ["regular-1"],
      false,
    );
    expect(expectedIds).toEqual(regularIds);
  });
});
