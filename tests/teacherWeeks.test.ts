import {
  DEFAULT_TEACHER_WEEK_START_DAY,
  getSystemWeekBounds,
  getTeacherWeekBounds,
  isWithinTeacherWeekCycle,
} from "../src/shared/utils/teacherWeeks";

describe("teacher teaching-week cycles", () => {
  it("uses the standard Saturday-to-Friday week when no teacher setting exists", () => {
    expect(DEFAULT_TEACHER_WEEK_START_DAY).toBe(6);
    expect(getSystemWeekBounds("2026-10-08")).toEqual({
      startDate: "2026-10-03",
      endDate: "2026-10-09",
    });
  });

  it("uses the selected teacher start day and expires the source cycle at its boundary", () => {
    expect(getTeacherWeekBounds("2026-10-06", 3)).toEqual({
      startDate: "2026-09-30",
      endDate: "2026-10-06",
    });
    expect(isWithinTeacherWeekCycle("2026-10-01", "2026-10-06", 3)).toBe(true);
    expect(isWithinTeacherWeekCycle("2026-10-06", "2026-10-07", 3)).toBe(false);
  });

  it("normalizes persisted numeric settings and SQL timestamps without shifting the session day", () => {
    expect(getTeacherWeekBounds("2026-10-06T00:00:00.000Z", "3")).toEqual({
      startDate: "2026-09-30",
      endDate: "2026-10-06",
    });
    expect(getTeacherWeekBounds("2026-10-06 00:00:00", 3)).toEqual({
      startDate: "2026-09-30",
      endDate: "2026-10-06",
    });
  });

  it("rejects malformed dates and invalid start-day values", () => {
    expect(() => getTeacherWeekBounds("2026-02-30", 6)).toThrow(RangeError);
    expect(() => getTeacherWeekBounds("2026-10-06", 7)).toThrow(RangeError);
    expect(() => getTeacherWeekBounds("2026-10-06", "monday")).toThrow(RangeError);
    expect(() => getTeacherWeekBounds("not-a-date", 6)).toThrow(RangeError);
  });
});
