export type LoadResult<T> =
  | { status: "success"; value: T }
  | { status: "error"; message: string };

export function captureLoad<T>(
  load: () => T,
  fallbackMessage: string,
): LoadResult<T> {
  try {
    return { status: "success", value: load() };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error && error.message ? error.message : fallbackMessage,
    };
  }
}

export function isCurrentLoadResult(loadedKey: string, currentKey: string): boolean {
  return loadedKey !== "" && loadedKey === currentKey;
}
