import type { AppEventDataKey, AppEventDataKeyType } from '../shared/api';

/**
 * The data-key catalog for one declared inbound event: a flat map of top-level
 * payload key -> coarse type, auto-learned by the inbound consumer. It is ADVISORY
 * — the editor uses it to offer keys and steer ops, but a condition on a key that
 * has not been observed yet is still valid (learning lags a newly-emitted key).
 */
export type DataCatalog = Record<string, AppEventDataKeyType>;

const VALID_TYPES = new Set<string>(['string', 'number', 'boolean']);

/**
 * The coarse type to record for an observed value, or null to skip it.
 * A non-scalar is recorded as 'string' because that is how {data.*} renders it
 * (a capped JSON string), so the editor's hint matches the actual render.
 */
export function inferKeyType(value: unknown): AppEventDataKeyType | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null;
  if (typeof value === 'boolean') return 'boolean';
  if (value === null || value === undefined) return null;
  return 'string';
}

/**
 * Merge one observed payload into the stored catalog. Cumulative: a key absent from
 * THIS payload is retained (an event that sometimes omits a key must not lose it).
 * Last-observed type wins on a conflict. `changed` is true only when a key was added
 * or its type changed — the caller skips the write otherwise, so a converged schema
 * costs no writes.
 */
export function mergeDataCatalog(stored: DataCatalog, data: Record<string, unknown>): { catalog: DataCatalog; changed: boolean } {
  const catalog: DataCatalog = { ...stored };
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const type = inferKeyType(value);
    if (!type) continue;
    if (catalog[key] !== type) {
      catalog[key] = type;
      changed = true;
    }
  }
  return { catalog, changed };
}

/** Read a stored data_schema_json. Total: malformed/non-object JSON and entries with
 *  an unrecognized type read as absent rather than throwing. */
export function parseDataCatalog(json: string): DataCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const catalog: DataCatalog = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_TYPES.has(value)) catalog[key] = value as AppEventDataKeyType;
  }
  return catalog;
}

/** The wire view: name-sorted so the editor's picker order is stable. */
export function catalogToDataKeys(catalog: DataCatalog): AppEventDataKey[] {
  return Object.entries(catalog)
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
