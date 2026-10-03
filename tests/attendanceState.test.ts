import { calculateSessionAttendanceCounts } from "../src/features/attendance/AttendanceCalculations";

describe("attendance state keeps makeup separate from the expected roster", () => {
  it("does not count makeup as regular present or let it reduce absence", () => {
    const result = calculateSessionAttendanceCounts(
      ["regular-student"],
      [
        { studentId: "regular-student", status: "present", attendanceType: "makeup" },
      ],
    );

    expect(result).toEqual({ expected: 1, present: 0, absent: 1, late: 0, makeup: 1 });
  });

  it("counts regular attendance immediately while keeping a makeup row separate", () => {
    const result = calculateSessionAttendanceCounts(
      ["regular-student"],
      [
        { studentId: "regular-student", status: "present", attendanceType: "present" },
        { studentId: "makeup-student", status: "present", attendanceType: "makeup" },
      ],
    );

    expect(result).toEqual({ expected: 1, present: 1, absent: 0, late: 0, makeup: 1 });
  });
});
