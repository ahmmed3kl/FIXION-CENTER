import { GroupSchedule } from "../../shared/types";

export function buildDefaultGroupName(level: string, subject?: string, teacher?: string): string {
  return [level.trim(), subject?.trim(), teacher?.trim()].filter(Boolean).join(" - ");
}

export function isGroupScheduledForDay(schedules: GroupSchedule[], dayOfWeek: number): boolean {
  return schedules.some((schedule) => schedule.status !== "inactive" && schedule.dayOfWeek === dayOfWeek);
}

