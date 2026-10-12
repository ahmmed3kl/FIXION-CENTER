import {
  recordScannedAttendanceIfEligible,
  shouldAutomaticallyRecordScannedAttendance,
} from "../src/features/attendance/barcodeAttendance";
import { AttendanceRepository } from "../src/features/attendance/AttendanceRepository";
import { AttendanceSessionService } from "../src/features/attendance/AttendanceSessionService";
import { MakeupService } from "../src/features/attendance/MakeupService";
import { Attendance } from "../src/shared/types";

describe("automatic regular barcode attendance", () => {
  const eligibleScan = {
    isBarcodeScan: true,
    isExpectedInSession: true,
    isMakeupEligible: false,
    isAlreadyAttended: false,
    isSessionOpen: true,
  };

  it("auto-records an eligible regular student scanned in the active session", () => {
    expect(shouldAutomaticallyRecordScannedAttendance(eligibleScan)).toBe(true);
  });

  it("invokes the existing attendance recorder only for an eligible scan", async () => {
    const recordAttendance = jest.fn().mockResolvedValue(undefined);
    await recordScannedAttendanceIfEligible(eligibleScan, recordAttendance);
    expect(recordAttendance).toHaveBeenCalledTimes(1);

    await recordScannedAttendanceIfEligible({
      ...eligibleScan,
      isMakeupEligible: true,
    }, recordAttendance);
    expect(recordAttendance).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a name or manual lookup", { isBarcodeScan: false }],
    ["a student outside the session roster", { isExpectedInSession: false }],
    ["a makeup-eligible student", { isMakeupEligible: true }],
    ["a student already attended", { isAlreadyAttended: true }],
    ["a closed session", { isSessionOpen: false }],
  ])("does not auto-record %s", (_caseName, overrides) => {
    expect(shouldAutomaticallyRecordScannedAttendance({
      ...eligibleScan,
      ...overrides,
    })).toBe(false);
  });

  it("keeps eligible makeup attendance on its existing explicit makeup service path", async () => {
    const sourceSessionId = "makeup-source-for-barcode-test";
    const targetSessionId = "makeup-target-for-barcode-test";
    const attendance: Attendance = {
      id: "makeup-attendance-for-barcode-test",
      centerId: "center-1",
      studentId: "student-for-barcode-test",
      sessionId: targetSessionId,
      checkInTime: "2099-10-08T10:00:00.000Z",
      status: "present",
      isLate: false,
      attendanceType: "makeup",
      originalAbsenceId: sourceSessionId,
      isExternal: false,
      operationId: "makeup-operation-for-barcode-test",
    };
    const existingAttendance = jest.spyOn(AttendanceRepository, "getStudentAttendanceInSession")
      .mockReturnValue(null);
    jest.spyOn(AttendanceSessionService, "getMakeupEligibility").mockReturnValue({
      eligible: true,
      originalAbsenceId: sourceSessionId,
    });
    const recordMakeup = jest.spyOn(AttendanceRepository, "recordAttendance")
      .mockResolvedValue(attendance);
    try {
      expect(shouldAutomaticallyRecordScannedAttendance({
        isBarcodeScan: true,
        isExpectedInSession: false,
        isMakeupEligible: true,
        isAlreadyAttended: false,
        isSessionOpen: true,
      })).toBe(false);

      const result = await MakeupService.recordMakeupAttendance({
        studentId: attendance.studentId,
        sessionId: targetSessionId,
        originalAbsenceId: sourceSessionId,
      });
      expect(result).toEqual(attendance);
      expect(existingAttendance).toHaveBeenCalledWith(targetSessionId, attendance.studentId);
      expect(recordMakeup).toHaveBeenCalledWith({
        studentId: attendance.studentId,
        sessionId: targetSessionId,
        status: "present",
        isLate: false,
        attendanceType: "makeup",
        originalAbsenceId: sourceSessionId,
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
});
