import {
  isEgyptianPhone,
  isNumericCode,
  isValidIsoDate,
  isValidMoney,
  isValidName,
  isValidTime,
  sanitizeInput,
} from "../src/shared/utils/validation";

describe("global validation", () => {
  it.each(["01012345678", "01112345678", "01212345678", "01512345678"])("accepts Egyptian phone %s", (phone) => {
    expect(isEgyptianPhone(phone)).toBe(true);
  });

  it.each(["010123", "010123456789", "01612345678", "0101234567a"])("rejects invalid phone %s", (phone) => {
    expect(isEgyptianPhone(phone)).toBe(false);
  });

  it("preserves leading zeros and strips pasted invalid characters from numeric input", () => {
    expect(sanitizeInput("00126abc", "cardCode")).toBe("00126");
    expect(isNumericCode("00126")).toBe(true);
    expect(isNumericCode("0012A")).toBe(false);
  });

  it("validates names, money, dates, and times", () => {
    expect(isValidName("أحمد محمد")).toBe(true);
    expect(isValidName("Ahmed Mohamed")).toBe(true);
    expect(isValidName("12345")).toBe(false);
    expect(isValidName("   ")).toBe(false);
    expect(isValidMoney(100.5)).toBe(true);
    expect(isValidMoney(-100)).toBe(false);
    expect(isValidMoney(Number.NaN)).toBe(false);
    expect(isValidTime("09:30")).toBe(true);
    expect(isValidTime("25:90")).toBe(false);
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });
});
