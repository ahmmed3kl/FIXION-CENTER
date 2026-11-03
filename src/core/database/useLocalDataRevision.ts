import { useCallback, useSyncExternalStore } from "react";
import { LocalDataEvents } from "./localDataEvents";

/**
 * Re-renders a repository-driven screen whenever a local SQLite mutation is
 * committed. Callers may optionally filter by `entityTypes` so unrelated
 * mutations do not trigger unnecessary screen re-renders.
 */
export function useLocalDataRevision(
  entityTypes?: string | readonly string[],
): number {
  const normalizedKey = Array.isArray(entityTypes)
    ? entityTypes.join("|")
    : typeof entityTypes === "string"
      ? entityTypes
      : "";
  const getSnapshot = useCallback(() => {
    if (!normalizedKey) return LocalDataEvents.getRevision();
    return LocalDataEvents.getRevisionForEntities(normalizedKey.split("|"));
  }, [normalizedKey]);
  return useSyncExternalStore(LocalDataEvents.subscribe, getSnapshot, getSnapshot);
}
