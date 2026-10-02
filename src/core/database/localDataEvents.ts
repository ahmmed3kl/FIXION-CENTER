export type LocalDataChange = {
  centerId?: string;
  entityType?: string;
  entityId?: string;
};

type Listener = (change: LocalDataChange) => void;

const listeners = new Set<Listener>();
let revision = 0;

/** Lightweight in-process invalidation channel for repository-driven screens. */
export const LocalDataEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getRevision(): number { return revision; },
  emit(change: LocalDataChange = {}): void {
    revision += 1;
    for (const listener of Array.from(listeners)) {
      try { listener(change); } catch { /* one screen must not break another */ }
    }
  },
};
