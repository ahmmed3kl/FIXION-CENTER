import { buildDefaultGroupName, isGroupScheduledForDay } from "../src/features/groups/groupScheduleUtils";

describe("group creation and weekly schedules", () => {
  it("builds a deterministic default name from level, subject, and teacher", () => {
    expect(buildDefaultGroupName("الصف الثالث", "الرياضيات", "أحمد")).toBe("الصف الثالث - الرياضيات - أحمد");
    expect(buildDefaultGroupName(" الصف الثالث ", undefined, "أحمد")).toBe("الصف الثالث - أحمد");
  });

  it("recognizes active schedules by JavaScript weekday", () => {
    const schedules = [
      { id: "sun", groupId: "g", dayOfWeek: 0, startTime: "17:00", endTime: "19:00", status: "active" as const },
      { id: "wed", groupId: "g", dayOfWeek: 3, startTime: "18:00", endTime: "20:00", status: "active" as const },
      { id: "fri", groupId: "g", dayOfWeek: 5, startTime: "18:00", endTime: "20:00", status: "inactive" as const },
    ];
    expect(isGroupScheduledForDay(schedules, 0)).toBe(true);
    expect(isGroupScheduledForDay(schedules, 3)).toBe(true);
    expect(isGroupScheduledForDay(schedules, 5)).toBe(false);
  });
});
