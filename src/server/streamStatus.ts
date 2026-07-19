import type express from 'express';
import type { StreamStatus, StreamStatusRaw } from '../shared/api';
import { renderCounterTokens } from './actionTemplates';
import { getCounterValue, setCounterChangeListener } from './counters';
import { db } from './db';
import { handle } from './http';
import { broadcast } from './realtime';

const STATUS_ID = 'default';
const MAX_STATUS_LENGTH = 280;

/**
 * `raw_text` is the source of truth: the operator's text with its {counter:key}
 * tokens intact. `text` holds the rendered snapshot as of the last save, written
 * only so anything reading this table directly sees the intended display string —
 * no code path reads it back, because a counter that moved since the last save
 * would make it stale. Always render from `raw_text`.
 */
const getStreamStatusRow = db.prepare(`
  select text, raw_text as rawText, updated_at as updatedAt
  from stream_status
  where id = ?
`);

const upsertStreamStatusRow = db.prepare(`
  insert into stream_status (id, text, raw_text, updated_at)
  values (?, ?, ?, ?)
  on conflict(id) do update set
    text = excluded.text,
    raw_text = excluded.raw_text,
    updated_at = excluded.updated_at
`);

type StatusRow = { text: string; rawText: string; updatedAt: string };

/**
 * Counter tokens ONLY. The status line is freeform operator text, not an Action
 * template — it has no invocation behind it, so running it through the Action
 * renderer would resolve {actor} and {amount} against an empty context and delete
 * them, silently rewriting a status the operator typed on purpose.
 */
function renderStatus(rawText: string): string {
  return renderCounterTokens(rawText, getCounterValue);
}

function readRow(): StatusRow {
  const row = getStreamStatusRow.get(STATUS_ID) as StatusRow | null;
  return row ?? { text: '', rawText: '', updatedAt: '' };
}

/**
 * The shape both overlay-reachable surfaces get: GET /api/stream-status (on
 * OVERLAY_PATHS) and the `status:updated` broadcast (on OVERLAY_EVENTS).
 *
 * Redaction is positional and total — the object is built field by field rather
 * than spread from the row — so a column added later cannot auto-propagate to a
 * browser source. Broadcasts are filtered by event name only; there is no
 * per-field filtering anywhere downstream to catch a mistake here.
 */
export function getStreamStatus(): StreamStatus {
  const row = readRow();
  return { text: renderStatus(row.rawText), updatedAt: row.updatedAt };
}

/** Operator-only. Carries the unrendered text so the editor can round-trip it. */
export function getStreamStatusRaw(): StreamStatusRaw {
  const row = readRow();
  return { text: renderStatus(row.rawText), rawText: row.rawText, updatedAt: row.updatedAt };
}

// Freeform text — trimmed and capped, but otherwise arbitrary so the streamer
// or an external system can put anything there. The cap applies to the RAW text,
// matching the character counter in the Stream Info modal; a rendered counter may
// push the result past it rather than truncating a status line mid-number.
function normalizeStatusText(body: unknown): string {
  const value = (body as { text?: unknown } | null)?.text;
  return typeof value === 'string' ? value.trim().slice(0, MAX_STATUS_LENGTH) : '';
}

export function saveStreamStatus(body: unknown): StreamStatus {
  const rawText = normalizeStatusText(body);
  const updatedAt = new Date().toISOString();
  upsertStreamStatusRow.run(STATUS_ID, renderStatus(rawText), rawText, updatedAt);
  const status = getStreamStatus();
  broadcast('status:updated', status);
  return status;
}

/**
 * A counter moved, so a status line that interpolates one is now out of date.
 *
 * Gated on the raw text actually containing a token: without this, every
 * increment would push a status event to every connected overlay for a string
 * that did not change.
 */
function onCounterChanged(): void {
  const row = readRow();
  if (!row.rawText.includes('{counter:')) return;
  broadcast('status:updated', getStreamStatus());
}

export function registerStreamStatusRoutes(app: express.Express) {
  app.get('/api/stream-status', (_request, response) => {
    response.json(getStreamStatus());
  });

  // Deliberately NOT added to OVERLAY_PATHS in auth.ts. The overlay token lives in
  // an OBS browser-source URL and is treated as effectively public, and rawText is
  // operator configuration.
  app.get('/api/stream-status/raw', (_request, response) => {
    response.json(getStreamStatusRaw());
  });

  app.put('/api/stream-status', handle((request, response) => {
    response.json(saveStreamStatus(request.body));
  }));

  setCounterChangeListener(onCounterChanged);
}
