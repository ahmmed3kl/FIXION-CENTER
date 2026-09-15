import { DatabaseService } from "./index";

/** Wraps repository mutation entry points without duplicating transaction
 * boilerplate in every method. Read-only methods are never passed here. */
export function wrapAtomicMethods(target: any, names: string[]): void {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function" || original.__atomicWrapped) continue;
    // Entry-point methods are wrapped at call time so existing nested
    // repository calls use savepoints and remain composable.
    target[name] = function (this: any, ...args: any[]) {
      return DatabaseService.runInTransaction(() => original.apply(this, args));
    };
    target[name].__atomicWrapped = true;
  }
}

export function wrapAsyncAtomicMethods(target: any, names: string[]): void {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function" || original.__atomicWrapped) continue;
    target[name] = function (this: any, ...args: any[]) {
      return DatabaseService.runInTransactionAsync(() => original.apply(this, args));
    };
    target[name].__atomicWrapped = true;
  }
}
