export function shouldAutomaticallyRecordScannedAttendance(params: {
  isBarcodeScan: boolean;
  isExpectedInSession: boolean;
  isMakeupEligible: boolean;
  isAlreadyAttended: boolean;
  isSessionOpen: boolean;
}): boolean {
  return params.isBarcodeScan
    && params.isExpectedInSession
    && !params.isMakeupEligible
    && !params.isAlreadyAttended
    && params.isSessionOpen;
}

export async function recordScannedAttendanceIfEligible(
  params: Parameters<typeof shouldAutomaticallyRecordScannedAttendance>[0],
  recordAttendance: () => Promise<unknown>,
): Promise<void> {
  if (shouldAutomaticallyRecordScannedAttendance(params)) {
    await recordAttendance();
  }
}
