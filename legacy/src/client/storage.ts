/**
 * localStorage that never throws. Reads tolerate corrupt JSON and a disabled
 * store; writes tolerate a full quota. Callers get their fallback instead.
 */
export function loadStoredJson<T>(key: string, parse: (raw: unknown) => T, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback();
    return parse(JSON.parse(raw));
  } catch {
    return fallback();
  }
}

export function saveStoredJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or unavailable store shouldn't break the feature that wrote to it.
  }
}
