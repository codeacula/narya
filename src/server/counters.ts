import type express from 'express';
import type {
  AdjustCounterPayload,
  Counter,
  CounterAdjustMode,
  CounterInput,
  CountersResponse,
} from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError, parseJsonColumn } from './http';
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
const selectAdjustCounterSteps = db.prepare(
  "select payload_json as payloadJson from action_steps where step_type = 'adjust_counter'",
);
// Every step payload, whatever its type: a {counter:key} token can appear in any
// template field, not just the ones this module knows the shape of.
const selectAllStepPayloads = db.prepare('select payload_json as payloadJson from action_steps');
const selectActionNamesForSteps = db.prepare(`
  select distinct a.name as name
  from action_steps s
  join actions a on a.id = s.action_id
  where s.step_type = 'adjust_counter'
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
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), MIN_COUNTER_VALUE), MAX_COUNTER_VALUE);
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

/** `key` is unique in the schema; this turns the constraint into a 409 with a reason. */
function assertKeyAvailable(key: string, exceptId: string | null): void {
  const existing = selectCounterByKey.get(key) as CounterRow | null;
  if (existing && existing.id !== exceptId) {
    throw new HttpRouteError(409, `Another counter already uses the key "${key}".`);
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
  assertKeyAvailable(input.key, null);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertCounter.run(id, input.key, input.label, input.value, now, now);
  emitCounters();
  return toCounter({ ...input, id, createdAt: now, updatedAt: now });
}

export function updateCounter(id: string, body: unknown): Counter {
  const current = requireRow(id);
  const input = normalize(body, current);
  assertKeyAvailable(input.key, id);
  const now = new Date().toISOString();
  updateCounterRow.run(input.key, input.label, input.value, now, id);
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
function referenceReasons(row: CounterRow): string[] {
  const reasons: string[] = [];

  const idRows = selectAdjustCounterSteps.all() as Array<{ payloadJson: string }>;
  const referencedById = idRows.some(step => {
    const payload = parseJsonColumn<AdjustCounterPayload>(step.payloadJson);
    return payload?.counterId === row.id;
  });
  if (referencedById) {
    const names = (selectActionNamesForSteps.all() as Array<{ name: string }>).map(r => r.name);
    reasons.push(names.length ? `an Action step (${names.join(', ')})` : 'an Action step');
  }

  const token = `{counter:${row.key}}`;
  const payloadRows = selectAllStepPayloads.all() as Array<{ payloadJson: string }>;
  if (payloadRows.some(step => (step.payloadJson ?? '').includes(token))) {
    reasons.push('an Action template');
  }

  const status = db.prepare('select raw_text as rawText from stream_status').all() as Array<{ rawText: string }>;
  if (status.some(entry => (entry.rawText ?? '').includes(token))) {
    reasons.push('the stream status line');
  }

  return reasons;
}

export function deleteCounter(id: string): void {
  const row = requireRow(id);
  const reasons = referenceReasons(row);
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

  app.delete('/api/counters/:id', handle((req, res) => {
    deleteCounter(req.params.id);
    res.status(204).end();
  }));
}
