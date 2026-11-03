export type LocalDataChange = {
  centerId?: string;
  entityType?: string;
  entityId?: string;
  entityTypes?: string[];
};

type Listener = (change: LocalDataChange) => void;

const listeners = new Set<Listener>();
let revision = 0;
let lastChange: LocalDataChange = {};
const entityRevisions = new Map<string, number>();

function bumpEntityTypes(types: Iterable<string>): void {
  const seen = new Set<string>();
  for (const rawType of types) {
    const normalized = String(rawType || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    entityRevisions.set(normalized, (entityRevisions.get(normalized) || 0) + 1);
  }
}

/** Lightweight in-process invalidation channel for repository-driven screens. */
export const LocalDataEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getRevision(): number {
    return revision;
  },
  getLastChange(): LocalDataChange {
    return lastChange;
  },
  getRevisionForEntities(entityTypes?: readonly string[]): number {
    if (!entityTypes || entityTypes.length === 0) return revision;
    let sum = 0;
    for (const rawType of entityTypes) {
      const normalized = String(rawType || "").trim();
      if (!normalized) continue;
      sum += entityRevisions.get(normalized) || 0;
    }
    return sum;
  },
  emit(change: LocalDataChange = {}): void {
    revision += 1;
    const types: string[] = [];
    if (change.entityType) types.push(change.entityType);
    if (Array.isArray(change.entityTypes)) types.push(...change.entityTypes);
    if (types.length > 0) {
      bumpEntityTypes(types);
    } else {
      for (const key of entityRevisions.keys()) {
        entityRevisions.set(key, (entityRevisions.get(key) || 0) + 1);
      }
    }
    const normalizedChange: LocalDataChange =
      types.length > 0 && !change.entityTypes
        ? { ...change, entityTypes: Array.from(new Set(types)) }
        : change;
    lastChange = normalizedChange;
    for (const listener of Array.from(listeners)) {
      try {
        listener(normalizedChange);
      } catch {
        /* one screen must not break another */
      }
    }
  },
  emitBatch(changes: LocalDataChange[]): void {
    if (!Array.isArray(changes) || changes.length === 0) return;
    if (changes.length === 1) {
      this.emit(changes[0]);
      return;
    }
    revision += 1;
    const entityTypes = Array.from(
      new Set(
        changes
          .flatMap((c) => [
            ...(c.entityType ? [c.entityType] : []),
            ...(Array.isArray(c.entityTypes) ? c.entityTypes : []),
          ])
          .map((t) => String(t || "").trim())
          .filter(Boolean),
      ),
    );
    if (entityTypes.length > 0) {
      bumpEntityTypes(entityTypes);
    } else {
      for (const key of entityRevisions.keys()) {
        entityRevisions.set(key, (entityRevisions.get(key) || 0) + 1);
      }
    }
    const last = changes[changes.length - 1] || {};
    const mergedChange: LocalDataChange = {
      centerId: last.centerId,
      entityType: entityTypes.length === 1 ? entityTypes[0] : last.entityType,
      entityId: changes.length === 1 ? last.entityId : undefined,
      entityTypes,
    };
    lastChange = mergedChange;
    for (const listener of Array.from(listeners)) {
      try {
        listener(mergedChange);
      } catch {
        /* one screen must not break another */
      }
    }
  },
};
