import { LocalDataEvents } from "../src/core/database/localDataEvents";

describe("LocalDataEvents", () => {
  it("notifies active repository-driven screens and supports cleanup", () => {
    const changes: any[] = [];
    const unsubscribe = LocalDataEvents.subscribe((change) => changes.push(change));

    LocalDataEvents.emit({ centerId: "center-1", entityType: "student", entityId: "student-1" });
    expect(changes).toEqual([{ centerId: "center-1", entityType: "student", entityId: "student-1" }]);

    unsubscribe();
    LocalDataEvents.emit({ entityType: "group" });
    expect(changes).toHaveLength(1);
  });

  it("isolates listener errors", () => {
    const healthy = jest.fn();
    const removeBroken = LocalDataEvents.subscribe(() => { throw new Error("screen failed"); });
    const removeHealthy = LocalDataEvents.subscribe(healthy);
    LocalDataEvents.emit({ entityType: "exam" });
    expect(healthy).toHaveBeenCalledTimes(1);
    removeBroken();
    removeHealthy();
  });

  it("supports entity-specific revisions without waking unrelated repository screens", () => {
    const before = LocalDataEvents.getRevision(["student"]);
    LocalDataEvents.emit({ entityType: "payment" });
    expect(LocalDataEvents.getRevision(["student"])).toBe(before);
    LocalDataEvents.emit({ entityType: "student" });
    expect(LocalDataEvents.getRevision(["student"])).toBe(before + 1);
  });
});
