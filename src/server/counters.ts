import type express from 'express';
import type {
  AdjustCounterPayload,
  Counter,
  CounterAdjustMode,
  CounterInput,
  CountersResponse,
} from '../shared/api';
import { db, isUniqueConstraintError } from './db';
import { handle, HttpRouteError, parseJsonColumn } from './http';
import { clampFinite } from './numeric';
import { broadcast } from './realtime';

const MAX_KEY_LENGTH = 60;
const MAX_LABEL_LENGTH = 120;

/**
 * SQLite stores integers up to 64 bits, but JavaScript only reasons about
 * integers exactly up to 2^53-1. Clamping here means a counter can never reach a
 * value that silently stops incrementing correctly.
 */
export const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;
export const MIN_COUNTER_VALUE = Number.MIN_SAFE_INTEGER;

type CounterRow = {
  id: string;
  key: string;
  label: string;
  value: number;
  createdAt: string;
  updatedAt: string;
};

const COLUMNS = `
  id, key, label, value,
  created_at as createdAt, updated_at as updatedAt
`;

const selectAllCounters = db.prepare(`select ${COLUMNS} from counters`);
const selectCounter = db.prepare(`select ${COLUMNS} from counters where id = ?`);
const selectCounterByKey = db.prepare(`select ${COLUMNS} from counters where key = ?`);
const insertCounter = db.prepare(`
  insert into counters (id, key, label, value, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?)
`);
const updateCounterRow = db.prepare(`
  update counters set key = ?, label = ?, value = ?, updated_at = ? where id = ?
`);
const deleteCounterRow = db.prepare('delete from counters where id = ?');
const selectStatusRawText = db.prepare('select raw_text as rawText from stream_status');
/**
 * Every step with the Action that owns it. One query rather than three, because
 * the interesting predicate — does this payload reference this counter — lives in
 * JSON and cannot be expressed in SQL, so the filtering happens in JS either way.
 * A {counter:key} token can appear in ANY template field, not only the payload
 * shapes this module knows, so no step_type filter is applied here.
 */
const selectStepsWithActions = db.prepare(`
  select a.name as actionName, s.step_type as stepType, s.payload_json as payloadJson
  from action_steps s
  join actions a on a.id = s.action_id
`);

function toCounter(row: CounterRow): Counter {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Normalized on write rather than matched loosely on read, so the token the
 * operator types into a template is byte-for-byte the token that was stored.
 * Spaces and underscores become hyphens; everything outside [a-z0-9-] is dropped.
 */
export function normalizeCounterKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_LENGTH);
}

function clampValue(value: number): number {
  return clampFinite(Math.round(value), MIN_COUNTER_VALUE, MAX_COUNTER_VALUE, 0);
}

/**
 * The single rule for "how much to move a counter by", shared by every runtime
 * adjustment path: the adjust_counter step, the /counter command, and the REST
 * adjust route. Returns null for anything that must not reach a write.
 *
 * Rejecting rather than clamping is the whole point. An amount can be bound from
 * untrusted input — `!death {arg1}` puts a viewer's chat text here — and 1e308 is
 * finite, so a mere isFinite check let it through to clampValue, which silently
 * pinned the counter to MAX_SAFE_INTEGER. There is no counter history, so that
 * destroyed the tally unrecoverably. A skipped adjustment is always better.
 *
 * This lives here, next to the value it protects, because the same rule was
 * written once in actions.ts for literal amounts and then not carried to any of
 * the runtime boundaries.
 */
export function parseCounterAmount(value: unknown): number | null {
  let raw: number;
  if (typeof value === 'number') {
    raw = value;
  } else {
    // Number('') is 0, so an absent or empty amount would arrive as a silent
    // "add 0" rather than being rejected. Ruled out here so no caller has to
    // remember its own emptiness check.
    const text = String(value ?? '').trim();
    if (!text) return null;
    raw = Number(text);
  }
  if (!Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/** Absent fields fall back to the row being updated, so PUT accepts partial bodies. */
function normalize(body: unknown, current: CounterRow | null): CounterInput {
  const value = (body ?? {}) as Partial<CounterInput>;

  const key = value.key === undefined
    ? current?.key ?? ''
    : normalizeCounterKey(value.key);
  if (!key) {
    throw new HttpRouteError(400, 'A counter key is required, using letters, numbers, and hyphens.');
  }

  const rawLabel = value.label === undefined ? current?.label ?? '' : value.label;
  const label = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, MAX_LABEL_LENGTH) : '';
  if (!label) throw new HttpRouteError(400, 'A counter name is required.');

  // An absent value on update keeps the current count. A counter's value is the
  // one field automation writes constantly, so a partial PUT that renamed a
  // counter must not silently reset it.
  const rawValue = value.value === undefined
    ? current?.value ?? 0
    : value.value;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    throw new HttpRouteError(400, 'A counter value must be a number.');
  }

  return { key, label, value: clampValue(rawValue) };
}

function requireRow(id: string): CounterRow {
  const row = selectCounter.get(id) as CounterRow | null;
  if (!row) throw new HttpRouteError(404, 'Unknown counter.');
  return row;
}

/**
 * The `key` column carries the unique constraint, so let the database enforce it and
 * translate the failure. A select-then-insert pre-check would let two concurrent
 * creates both pass and surface the loser as a raw 500. Updating a row to the key it
 * already holds is not a violation, so this needs no self-exclusion.
 */
function withUniqueKey<T>(key: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new HttpRouteError(409, `Another counter already uses the key "${key}".`);
    }
    throw error;
  }
}

function emitCounters(): void {
  const body: CountersResponse = { counters: listCounters() };
  broadcast('counters:updated', body);
}

export function listCounters(): Counter[] {
  const rows = selectAllCounters.all() as CounterRow[];
  return rows.map(toCounter).sort((a, b) => a.label.localeCompare(b.label));
}

export function findCounter(id: string): Counter | null {
  const row = selectCounter.get(id) as CounterRow | null;
  return row ? toCounter(row) : null;
}

/**
 * The template resolver. Returns undefined — not 0 — for an unknown key, because
 * the renderer distinguishes "no such counter" (render the token literally, so an
 * operator's typo stays visible) from a counter that genuinely sits at zero.
 */
export function getCounterValue(key: string): number | undefined {
  const row = selectCounterByKey.get(key) as CounterRow | null;
  return row ? row.value : undefined;
}

export function createCounter(body: unknown): Counter {
  const input = normalize(body, null);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  withUniqueKey(input.key, () => insertCounter.run(id, input.key, input.label, input.value, now, now));
  emitCounters();
  // Creating a counter can CHANGE a rendered status: a status already reading
  // "Deaths: {counter:deaths}" was showing that literal, and now resolves. Overlays
  // seed status once and then follow status:updated, so without this they keep
  // displaying the literal token until something else happens to move the status.
  onCounterChanged();
  return toCounter({ ...input, id, createdAt: now, updatedAt: now });
}

export function updateCounter(id: string, body: unknown): Counter {
  const current = requireRow(id);
  const input = normalize(body, current);
  assertRenameIsSafe(current, input.key);
  const now = new Date().toISOString();
  withUniqueKey(input.key, () => updateCounterRow.run(input.key, input.label, input.value, now, id));
  const updated = toCounter({ ...current, ...input, updatedAt: now });
  emitCounters();
  onCounterChanged();
  return updated;
}

/**
 * Applies an Action step. Returns null when the counter no longer exists, which
 * the step reports as a skip rather than a failure — the same shape play_media
 * uses for an asset that has gone away.
 */
export function adjustCounter(id: string, mode: CounterAdjustMode, amount: number): Counter | null {
  const row = selectCounter.get(id) as CounterRow | null;
  if (!row) return null;
  const next = clampValue(mode === 'add' ? row.value + amount : amount);
  const now = new Date().toISOString();
  updateCounterRow.run(row.key, row.label, next, now, id);
  const updated = toCounter({ ...row, value: next, updatedAt: now });
  emitCounters();
  onCounterChanged();
  return updated;
}

/** Adjust by key — the path the `/counter` dashboard command uses. */
export function adjustCounterByKey(key: string, mode: CounterAdjustMode, amount: number): Counter | null {
  const row = selectCounterByKey.get(key) as CounterRow | null;
  return row ? adjustCounter(row.id, mode, amount) : null;
}

export function findCounterByKey(key: string): Counter | null {
  const row = selectCounterByKey.get(key) as CounterRow | null;
  return row ? toCounter(row) : null;
}

/**
 * Two ways an Action can depend on a counter, and deleting under either one
 * breaks something the operator cannot see from the Counters page:
 *
 *  - an adjust_counter step names its id, which would then resolve to nothing;
 *  - ANY step template may interpolate {counter:key}, and an unknown key renders
 *    literally — so a delete would put a raw "{counter:zambie-deaths}" on the
 *    live stream. That is exactly what the render-absent-tokens-empty rule
 *    elsewhere exists to prevent, so it is blocked here instead.
 *
 * The stream status line is checked for the same reason.
 */
/**
 * References split by what they actually bind to, because the two kinds survive
 * different edits:
 *
 *  - `byId` — an adjust_counter step naming this counter's id. Survives a rename,
 *    breaks on delete.
 *  - `byKey` — a {counter:key} token in any step template or in the stream status.
 *    Breaks on BOTH, because the token is matched by key.
 *
 * Collapsing them would block renames that are perfectly safe.
 */
function referenceReasons(row: CounterRow): { byId: string[]; byKey: string[] } {
  const idReasons: string[] = [];
  const keyReasons: string[] = [];
  const token = `{counter:${row.key}}`;
  const steps = selectStepsWithActions.all() as Array<{
    actionName: string;
    stepType: string;
    payloadJson: string;
  }>;

  // Named per reason, and only the Actions that actually reference THIS counter.
  // Listing every Action that merely happens to contain an adjust_counter step
  // would send the operator to edit Actions that have nothing to do with it.
  const byId = new Set<string>();
  const byToken = new Set<string>();

  for (const step of steps) {
    if (step.stepType === 'adjust_counter') {
      const payload = parseJsonColumn<AdjustCounterPayload>(step.payloadJson);
      if (payload?.counterId === row.id) byId.add(step.actionName);
    }
    if ((step.payloadJson ?? '').includes(token)) byToken.add(step.actionName);
  }

  if (byId.size > 0) idReasons.push(`an Action step (${[...byId].sort().join(', ')})`);
  if (byToken.size > 0) keyReasons.push(`an Action template (${[...byToken].sort().join(', ')})`);

  const status = selectStatusRawText.all() as Array<{ rawText: string }>;
  if (status.some(entry => (entry.rawText ?? '').includes(token))) {
    keyReasons.push('the stream status line');
  }

  return { byId: idReasons, byKey: keyReasons };
}

/**
 * Renaming a key is a delete for every {counter:key} that names the old one: the
 * token stops resolving and starts rendering literally, and updateCounter's own
 * re-broadcast pushes that literal to every overlay in the same request. Blocking
 * it here is what makes the "an unknown key renders literally" rule in
 * actionTemplates.ts safe to rely on — the delete guard alone left this way in.
 */
function assertRenameIsSafe(current: CounterRow, nextKey: string): void {
  if (nextKey === current.key) return;
  // Only key-bound references. An adjust_counter step binds the id and rides a
  // rename through untouched, so blocking on it would refuse a safe edit.
  const { byKey } = referenceReasons(current);
  if (byKey.length === 0) return;
  // Phrased to avoid subject-verb agreement with a list of one or many.
  throw new HttpRouteError(
    409,
    `Renaming this key would break {counter:${current.key}}, still referenced by `
    + `${byKey.join(' and ')}. Update those references first.`,
  );
}

export function deleteCounter(id: string): void {
  const row = requireRow(id);
  // Deleting breaks both kinds, so both count here.
  const { byId, byKey } = referenceReasons(row);
  const reasons = [...byId, ...byKey];
  if (reasons.length > 0) {
    throw new HttpRouteError(
      409,
      `This counter is still used by ${reasons.join(' and ')}. Remove those references before deleting it.`,
    );
  }
  deleteCounterRow.run(id);
  emitCounters();
}

/**
 * Set by streamStatus.ts at wiring time rather than imported, because the status
 * module already imports this one to render its tokens. Importing back would be a
 * cycle, and this direction keeps counters unaware of what displays them.
 */
let onCounterChanged: () => void = () => {};

export function setCounterChangeListener(listener: () => void): void {
  onCounterChanged = listener;
}

export function registerCounterRoutes(app: express.Express) {
  app.get('/api/counters', handle((_req, res) => {
    const body: CountersResponse = { counters: listCounters() };
    res.json(body);
  }));

  app.post('/api/counters', handle((req, res) => {
    res.status(201).json(createCounter(req.body));
  }));

  app.put('/api/counters/:id', handle((req, res) => {
    res.json(updateCounter(req.params.id, req.body));
  }));

  /**
   * A RELATIVE adjustment, so the dashboard's ±1 buttons cannot lose a concurrent
   * write. PUT takes an absolute value, which means a client computing
   * `rendered value + 1` silently discards anything automation wrote between the
   * render and the click. The add is applied server-side against the stored row.
   */
  app.post('/api/counters/:id/adjust', handle((req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown; amount?: unknown };
    const mode: CounterAdjustMode = body.mode === 'set' ? 'set' : 'add';
    const amount = parseCounterAmount(body.amount);
    if (amount === null) {
      throw new HttpRouteError(400, 'An adjustment amount must be a whole number.');
    }
    const updated = adjustCounter(req.params.id, mode, amount);
    if (!updated) throw new HttpRouteError(404, 'Unknown counter.');
    res.json(updated);
  }));

  app.delete('/api/counters/:id', handle((req, res) => {
    deleteCounter(req.params.id);
    res.status(204).end();
  }));
}
