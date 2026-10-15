import { formatTimeArabic } from "../src/core/localization";
import { getAttendanceHistoryPresentation } from "../src/features/attendance/attendanceHistoryPresentation";
import { formatLocalDate } from "../src/shared/utils/date";
import { toArabicDigits } from "../src/shared/utils/arabicNumerals";
import type { StudentAttendanceHistoryRecord } from "../src/features/attendance/AttendanceRepository";

const makeRecord = (
  overrides: Partial<
    Pick<
      StudentAttendanceHistoryRecord,
      "status" | "sessionDate" | "checkInTime" | "startTime"
    >
  > = {},
): Pick<
  StudentAttendanceHistoryRecord,
  "status" | "sessionDate" | "checkInTime" | "startTime"
> => ({
  status: "present",
  sessionDate: "2026-10-12",
  checkInTime: "2026-10-12T13:35:00.000Z",
  startTime: "12:00",
  ...overrides,
});

describe("attendance history presentation", () => {
  it("formats the date with its Arabic weekday, full year, and Arabic numerals", () => {
    expect(formatLocalDate("2026-10-12")).toBe("الاثنين ٢٠٢٦/١٠/١٢");
  });

  it("preserves the stored session day when a date-only value arrives as an ISO timestamp", () => {
    expect(formatLocalDate("2026-10-03T23:45:00-08:00"))
      .toBe("السبت ٢٠٢٦/١٠/٣");
  });

  it("does not invent a date when the stored value is missing or invalid", () => {
    expect(formatLocalDate(null)).toBe("تاريخ غير متاح");
    expect(formatLocalDate("2026-02-30T00:00:00.000Z"))
      .toBe("تاريخ غير متاح");
  });

  it("formats legacy local times and ISO check-in instants using Arabic digits", () => {
    expect(formatTimeArabic("04:35:00")).toBe("٠٤:٣٥ ص");
    expect(formatTimeArabic("16:35")).toBe("٠٤:٣٥ م");

    const checkInTime = "2026-10-12T10:35:00.000Z";
    const localDate = new Date(checkInTime);
    const hour12 = localDate.getHours() % 12 || 12;
    const period = localDate.getHours() >= 12 ? "م" : "ص";
    const expected = `${toArabicDigits(String(hour12).padStart(2, "0"))}:${toArabicDigits(
      String(localDate.getMinutes()).padStart(2, "0"),
    )} ${period}`;
    expect(formatTimeArabic(checkInTime)).toBe(expected);
  });

  it("shows recorded attendance time separately from session start time", () => {
    const record = makeRecord();
    const presentation = getAttendanceHistoryPresentation(record);

    expect(presentation.sessionDateLabel).toBe("الاثنين ٢٠٢٦/١٠/١٢");
    expect(presentation.checkInTimeLabel)
      .toBe(`وقت تسجيل الحضور: ${formatTimeArabic(record.checkInTime)}`);
    expect(presentation.sessionStartTimeLabel)
      .toBe(`بداية الجلسة: ${formatTimeArabic(record.startTime)}`);
    expect(presentation.checkInTimeLabel).not.toBe(presentation.sessionStartTimeLabel);
  });

  it.each(["absent", "excused"] as const)(
    "shows no attendance or session time for %s history",
    (status) => {
      const presentation = getAttendanceHistoryPresentation(makeRecord({ status }));

      expect(presentation.sessionDateLabel).toBe("الاثنين ٢٠٢٦/١٠/١٢");
      expect(presentation.checkInTimeLabel).toBeNull();
      expect(presentation.sessionStartTimeLabel).toBeNull();
    },
  );

  it("keeps missing legacy check-in time unavailable instead of substituting session start", () => {
    const presentation = getAttendanceHistoryPresentation(
      makeRecord({ sessionDate: null, checkInTime: null }),
    );

    expect(presentation.sessionDateLabel).toBe("تاريخ غير متاح");
    expect(presentation.checkInTimeLabel).toBe("وقت تسجيل الحضور غير متاح");
    expect(presentation.sessionStartTimeLabel).toBe("بداية الجلسة: ١٢:٠٠ م");
  });
});
