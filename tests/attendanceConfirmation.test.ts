import { requiresAttendanceConfirmation } from "../src/features/attendance/attendanceConfirmation";

describe("attendance confirmation", () => {
  it("does not require confirmation for ordinary attendance", () => {
    expect(requiresAttendanceConfirmation(false, false)).toBe(false);
  });

  it("keeps confirmation for makeup and external attendance", () => {
    expect(requiresAttendanceConfirmation(true, false)).toBe(true);
    expect(requiresAttendanceConfirmation(false, true)).toBe(true);
  });
});
