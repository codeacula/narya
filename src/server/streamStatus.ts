import type express from 'express';
import type { StreamStatus } from '../shared/api';
import { db } from './db';
import { handle } from './http';
import { broadcast } from './realtime';

const STATUS_ID = 'default';
const MAX_STATUS_LENGTH = 280;

const getStreamStatusRow = db.prepare(`
  select text, updated_at as updatedAt
  from stream_status
  where id = ?
`);

const upsertStreamStatusRow = db.prepare(`
  insert into stream_status (id, text, updated_at)
  values (?, ?, ?)
  on conflict(id) do update set
    text = excluded.text,
    updated_at = excluded.updated_at
`);

export function getStreamStatus(): StreamStatus {
  const row = getStreamStatusRow.get(STATUS_ID) as StreamStatus | null;
  return row ?? { text: '', updatedAt: '' };
}

// Freeform text — trimmed and capped, but otherwise arbitrary so the streamer
// or an external system can put anything there.
function normalizeStatusText(body: unknown): string {
  const value = (body as { text?: unknown } | null)?.text;
  return typeof value === 'string' ? value.trim().slice(0, MAX_STATUS_LENGTH) : '';
}

export function saveStreamStatus(body: unknown): StreamStatus {
  const text = normalizeStatusText(body);
  const updatedAt = new Date().toISOString();
  upsertStreamStatusRow.run(STATUS_ID, text, updatedAt);
  const status = getStreamStatus();
  broadcast('status:updated', status);
  return status;
}

export function registerStreamStatusRoutes(app: express.Express) {
  app.get('/api/stream-status', (_request, response) => {
    response.json(getStreamStatus());
  });

  app.put('/api/stream-status', handle((request, response) => {
    response.json(saveStreamStatus(request.body));
  }));
}
