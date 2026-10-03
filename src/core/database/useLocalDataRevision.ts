import { useCallback, useMemo, useSyncExternalStore } from "react";
import { LocalDataEvents } from "./localDataEvents";

/**
 * Re-renders a repository-driven screen whenever a local SQLite mutation is
 * committed. The caller decides which query to reload when the revision
 * changes; no polling or navigation remount is involved.
 */
export function useLocalDataRevision(entityTypes?: readonly string[]): number {
  const entityKey = entityTypes?.map((value) => value.trim().toLowerCase()).filter(Boolean).sort().join("|") || "*";
  const normalizedEntityTypes = useMemo(
    () => entityKey === "*" ? undefined : entityKey.split("|"),
    [entityKey],
  );
  const subscribe = useCallback((listener: () => void) => LocalDataEvents.subscribe((change) => {
    if (!normalizedEntityTypes || !change.entityType || normalizedEntityTypes.includes(change.entityType.trim().toLowerCase())) {
      listener();
    }
  }), [normalizedEntityTypes]);
  const getSnapshot = useCallback(() => LocalDataEvents.getRevision(normalizedEntityTypes), [normalizedEntityTypes]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
