import type express from 'express';
import type { TriggerOverride } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';

/**
 * Per-viewer Action substitution. The dispatcher calls resolveOverrideActionId at its
 * invoke() choke point; everything else here is the operator-facing CRUD.
 *
 * Leaf module over db.ts on purpose: both triggerDispatcher.ts and viewerIdentity.ts
 * import it, and neither may drag route or dispatcher machinery in with it.
 */

const MAX_NOTE_LENGTH = 200;
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Kinds where a real viewer arrives on the signal. */
const OVERRIDABLE_TRIGGER_KINDS = new Set(['reward', 'twitch_event', 'chat_phrase', 'viewer_command']);

type OverrideRow = {
  id: string;
  triggerId: string;
  login: string;
  actionId: string;
  enabled: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

const OVERRIDE_COLUMNS = `
  id,
  trigger_id as triggerId,
  login,
  action_id as actionId,
  enabled,
  note,
  created_at as createdAt,
  updated_at as updatedAt
`;

const listRows = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides order by created_at asc`);
const getRowById = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides where id = ?`);
const getRowByTriggerAndLogin = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides where trigger_id = ? and login = ?`);
// The join IS the pre-flight fallback: a disabled override or a disabled/deleted
// override Action resolves to nothing, and the trigger's own Action runs.
const resolveRow = db.prepare(`
  select o.action_id as actionId from trigger_overrides o
  join actions a on a.id = o.action_id
  where o.trigger_id = ? and o.login = ? and o.enabled = 1 and a.enabled = 1
`);
// on conflict, not check-then-insert: two concurrent saves must not race the
// unique (trigger_id, login) constraint into a 500.
const upsertRow = db.prepare(`
  insert into trigger_overrides (id, trigger_id, login, action_id, enabled, note, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)
  on conflict (trigger_id, login) do update set
    action_id = excluded.action_id,
    enabled = excluded.enabled,
    note = excluded.note,
    updated_at = excluded.updated_at
`);
const deleteRowById = db.prepare('delete from trigger_overrides where id = ?');
const deleteRowsForLogin = db.prepare('delete from trigger_overrides where login = ?');
const triggerKindById = db.prepare('select kind from automation_triggers where id = ?');
const actionById = db.prepare('select 1 as present from actions where id = ?');
const ignoredByLogin = db.prepare('select 1 as present from ignored_logins where login = ?');

function rowToOverride(row: OverrideRow): TriggerOverride {
  return {
    id: row.id,
    triggerId: row.triggerId,
    login: row.login,
    actionId: row.actionId,
    enabled: row.enabled === 1,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeOverrideLogin(value: unknown): string {
  const login = typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : '';
  if (!LOGIN_PATTERN.test(login)) {
    throw new HttpRouteError(400, 'Overrides need a Twitch login: letters, numbers, or underscores.');
  }
  return login;
}

export function listTriggerOverrides(): TriggerOverride[] {
  return (listRows.all() as OverrideRow[]).map(rowToOverride);
}

/** The dispatcher's point query. Empty login (anonymous gift/cheer) never matches. */
export function resolveOverrideActionId(triggerId: string, login: string): string | null {
  if (!login) return null;
  const row = resolveRow.get(triggerId, login) as { actionId: string } | null;
  return row?.actionId ?? null;
}

export function upsertTriggerOverride(triggerId: string, body: unknown): TriggerOverride {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};

  const trigger = triggerKindById.get(triggerId) as { kind: string } | null;
  if (!trigger) throw new HttpRouteError(404, 'Trigger not found.');
  if (!OVERRIDABLE_TRIGGER_KINDS.has(trigger.kind)) {
    throw new HttpRouteError(400, 'Only reward, Twitch event, chat phrase, and viewer command triggers carry a viewer to override on.');
  }

  const login = normalizeOverrideLogin(value.login);
  // A flushed viewer must stay flushed: an override row would silently reintroduce
  // the login into operator config, which is exactly what the ignore list prevents.
  if (ignoredByLogin.get(login)) {
    throw new HttpRouteError(400, `${login} is on the ignored list. Unflush them first.`);
  }

  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  if (!actionId || !actionById.get(actionId)) throw new HttpRouteError(400, 'Action not found.');

  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true;
  const note = typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE_LENGTH) : '';

  const now = new Date().toISOString();
  upsertRow.run(crypto.randomUUID(), triggerId, login, actionId, enabled ? 1 : 0, note, now, now);

  const saved = getRowByTriggerAndLogin.get(triggerId, login) as OverrideRow | null;
  if (!saved) throw new HttpRouteError(500, 'Override was not saved.');
  return rowToOverride(saved);
}

export function deleteTriggerOverride(id: string): void {
  if (!getRowById.get(id)) throw new HttpRouteError(404, 'Override not found.');
  deleteRowById.run(id);
}

/** Called from flushViewer's transaction. Returns the number removed, for the flush report. */
export function deleteOverridesForLogin(login: string): number {
  return (deleteRowsForLogin.run(login.trim().toLowerCase()) as { changes: number }).changes;
}

/** Operator-only: requireDashboardToken already gates /api. */
export function registerTriggerOverrideRoutes(app: express.Express) {
  app.get('/api/automation/overrides', (_request, response) => {
    response.json(listTriggerOverrides());
  });

  app.put('/api/automation/triggers/:id/overrides', handle((request, response) => {
    response.json(upsertTriggerOverride(request.params.id, request.body));
  }));

  app.delete('/api/automation/overrides/:id', handle((request, response) => {
    deleteTriggerOverride(request.params.id);
    response.status(204).end();
  }));
}
