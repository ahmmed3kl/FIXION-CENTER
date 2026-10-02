export type LocalDataChange = {
  centerId?: string;
  entityType?: string;
  entityId?: string;
};

type Listener = (change: LocalDataChange) => void;

const listeners = new Set<Listener>();

/** Lightweight in-process invalidation channel for repository-driven screens. */
export const LocalDataEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(change: LocalDataChange = {}): void {
    for (const listener of Array.from(listeners)) {
      try { listener(change); } catch { /* one screen must not break another */ }
    }
  },
};
