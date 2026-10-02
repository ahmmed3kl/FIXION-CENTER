import { useSyncExternalStore } from "react";
import { LocalDataEvents } from "./localDataEvents";

/**
 * Re-renders a repository-driven screen whenever a local SQLite mutation is
 * committed. The caller decides which query to reload when the revision
 * changes; no polling or navigation remount is involved.
 */
export function useLocalDataRevision(): number {
  return useSyncExternalStore(LocalDataEvents.subscribe, LocalDataEvents.getRevision, LocalDataEvents.getRevision);
}
