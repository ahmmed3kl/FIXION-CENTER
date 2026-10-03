export type LocalDataChange = {
  centerId?: string;
  entityType?: string;
  entityId?: string;
};

type Listener = (change: LocalDataChange) => void;

const listeners = new Set<Listener>();
let revision = 0;
let untypedRevision = 0;
const entityRevisions = new Map<string, number>();

/** Lightweight in-process invalidation channel for repository-driven screens. */
export const LocalDataEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getRevision(entityTypes?: readonly string[]): number {
    if (!entityTypes?.length) return revision;
    return untypedRevision + entityTypes.reduce(
      (total, entityType) => total + (entityRevisions.get(entityType.trim().toLowerCase()) || 0),
      0,
    );
  },
  emit(change: LocalDataChange = {}): void {
    revision += 1;
    const entityType = change.entityType?.trim().toLowerCase();
    if (entityType) entityRevisions.set(entityType, (entityRevisions.get(entityType) || 0) + 1);
    else untypedRevision += 1;
    for (const listener of Array.from(listeners)) {
      try { listener(change); } catch { /* one screen must not break another */ }
    }
  },
};
