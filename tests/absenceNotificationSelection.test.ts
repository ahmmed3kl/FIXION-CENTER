import {
  absenceNotificationOperationPrefix,
  beginAbsenceRecipientSelection,
  hasValidNotificationContact,
  toggleAbsenceRecipientSelection,
} from "../src/features/notifications/absenceNotificationSelection";

describe("absence notification recipient selection", () => {
  it("starts selection with one student, adds others, and allows deselection", () => {
    let selected = beginAbsenceRecipientSelection("student-1");
    expect(Array.from(selected)).toEqual(["student-1"]);

    selected = toggleAbsenceRecipientSelection(selected, "student-2");
    selected = toggleAbsenceRecipientSelection(selected, "student-3");
    expect(Array.from(selected).sort()).toEqual(["student-1", "student-2", "student-3"]);

    selected = toggleAbsenceRecipientSelection(selected, "student-2");
    expect(Array.from(selected).sort()).toEqual(["student-1", "student-3"]);
  });

  it("requires a plausible contact and creates a stable compact idempotency prefix", () => {
    expect(hasValidNotificationContact("", "not a phone")).toBe(false);
    expect(hasValidNotificationContact("010 1234 5678")).toBe(true);
    expect(hasValidNotificationContact("1234567")).toBe(true);
    expect(hasValidNotificationContact("123456")).toBe(false);
    expect(hasValidNotificationContact("1234567890123456")).toBe(false);

    const prefix = absenceNotificationOperationPrefix("session-a", "student-a");
    expect(prefix).toBe(absenceNotificationOperationPrefix("session-a", "student-a"));
    expect(prefix).not.toBe(absenceNotificationOperationPrefix("session-a", "student-b"));
    expect(prefix.length).toBeLessThan(64);
  });
});
