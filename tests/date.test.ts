import { formatLocalDate, formatLocalDateTime } from "../src/shared/utils/date";

describe("Arabic date formatting", () => {
  it("uses the shared Arabic weekday and compact day/month/two-digit year format", () => {
    expect(formatLocalDate("2026-09-30")).toBe("الأربعاء 30/9/26");
  });

  it("keeps local attendance time beside the date with an Arabic period", () => {
    expect(formatLocalDateTime(new Date(2026, 8, 30, 17, 42))).toBe("الأربعاء 30/9/26 — 05:42 م");
  });
});
