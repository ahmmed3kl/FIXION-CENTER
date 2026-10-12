export const requiresAttendanceConfirmation = (
  makeup: boolean,
  isExternal: boolean,
): boolean => makeup || isExternal;
