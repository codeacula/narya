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
 * How many keys one event's catalog may accumulate across ALL payloads. The inbound
 * consumer already bounds a single payload (16 KB of `data`, 100 fields); without this
 * nothing bounds the accumulation, so an app whose keys embed an id or timestamp
 * (`run_1_score`, `player_8f2a_hp`) makes `changed` true for every entry forever — a
 * JSON parse + stringify + row rewrite of an ever-growing blob on the inbound consumer
 * thread (O(n²) overall), and an editor picker that renders every key ever observed.
 * Mirrors the inbound consumer's per-payload field cap.
 */
export const MAX_CATALOG_KEYS = 100;

/** Longest key NAME that may be recorded, mirroring the 1-64 char event-name limit in
 *  apps.ts. Without it a single key name could be ~16 KB and still sit inside the
 *  inbound consumer's per-payload byte cap. */
export const MAX_KEY_NAME_LENGTH = 64;

/**
 * The exact alphabet three consumers already agree on — keep them in sync:
 *   - DATA_CONDITION_FIELD (src/server/automationTriggers.ts), the server's validator
 *   - DATA_CONDITION_FIELD_PATTERN (src/client/pages/settings/automation.ts), the client's
 *   - DATA_TOKEN_PATTERN (src/server/actionTemplates.ts), the {data.*} renderer
 * A key outside it (`boss name`) is unusable in both a condition and a template, so
 * cataloguing it only sets a trap: the editor offers `data.boss name`, validateConditions
 * then rejects it, and Save stays disabled until the operator deletes the row.
 */
const RECORDABLE_KEY = /^[A-Za-z0-9_.-]+$/;

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
 *
 * Both caps and the alphabet are RECORD-time filters on NEW keys only. Nothing already
 * in the catalog is ever evicted or rewritten by them (the catalog is cumulative by
 * design, and parseDataCatalog stays total), so an existing key that predates a cap
 * still gets its type updated; it just cannot be joined by new ones once the catalog
 * is full.
 */
export function mergeDataCatalog(stored: DataCatalog, data: Record<string, unknown>): { catalog: DataCatalog; changed: boolean } {
  const catalog: DataCatalog = { ...stored };
  let size = Object.keys(catalog).length;
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const type = inferKeyType(value);
    if (!type) continue;
    // `__proto__` passes RECORDABLE_KEY but can never become an own key: the assignment
    // below is a silent no-op for a string value, so the key reads as still-missing on
    // EVERY payload and forces a row rewrite forever — the same unbounded write the caps
    // exist to stop, and one the caps cannot catch (it never occupies a slot).
    if (key === '__proto__') continue;
    const known = Object.prototype.hasOwnProperty.call(catalog, key);
    if (!known) {
      if (size >= MAX_CATALOG_KEYS) continue;
      if (key.length > MAX_KEY_NAME_LENGTH) continue;
      if (!RECORDABLE_KEY.test(key)) continue;
    }
    if (catalog[key] !== type) {
      catalog[key] = type;
      if (!known) size += 1;
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
