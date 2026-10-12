import { Session } from "../../shared/types";

export function sortSessionsByActivation<
  T extends Pick<Session, "id" | "groupId" | "sessionDate" | "startTime"> &
    Partial<Pick<Session, "status" | "updatedAt">>,
>(
  sessions: T[],
  activationTimes: ReadonlyMap<string, string>,
): T[] {
  return [...sessions].sort((left, right) => {
    const leftActivatedAt = activationTimes.get(left.id) || (left.status === "open" ? left.updatedAt || "" : "");
    const rightActivatedAt = activationTimes.get(right.id) || (right.status === "open" ? right.updatedAt || "" : "");
    const activationOrder = rightActivatedAt.localeCompare(leftActivatedAt);
    if (activationOrder !== 0) return activationOrder;

    const dateOrder = right.sessionDate.localeCompare(left.sessionDate);
    if (dateOrder !== 0) return dateOrder;

    const timeOrder = right.startTime.localeCompare(left.startTime);
    if (timeOrder !== 0) return timeOrder;

    const groupOrder = left.groupId.localeCompare(right.groupId);
    return groupOrder || left.id.localeCompare(right.id);
  });
}
