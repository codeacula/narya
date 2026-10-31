import { createHash, randomBytes } from 'crypto';
import type express from 'express';
import { catalogToDataKeys, mergeDataCatalog, parseDataCatalog } from './appEventCatalog';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import { rewardCountsBySource } from './rewardProvenance';
import type { App, AppEvent } from '../shared/api';

const RESERVED_SOURCES = new Set(['narya', 'manual']);

// The ROW shape from SQLite — distinct from App (the wire type). tokenHash never
// leaves this module: rowToApp derives tokenConfigured from it and omits it.
type AppRow = { id: string; name: string; createdAt: string; disabledAt: string | null; tokenHash: string | null };

const SELECT_COLUMNS = 'id, name, created_at as createdAt, disabled_at as disabledAt, token_hash as tokenHash';
const listAppsRow = db.prepare(`select ${SELECT_COLUMNS} from apps order by name`);
const getAppRow = db.prepare(`select ${SELECT_COLUMNS} from apps where id = ?`);
const getAppByName = db.prepare('select 1 as present from apps where name = ?');
const insertApp = db.prepare('insert into apps (id, name, created_at, disabled_at) values (?, ?, ?, null)');
const setDisabled = db.prepare('update apps set disabled_at = ? where id = ?');
const setTokenHash = db.prepare('update apps set token_hash = ? where id = ?');
const getAppByTokenHash = db.prepare(`select ${SELECT_COLUMNS} from apps where token_hash = ?`);

// Never spread ...row here — that would put tokenHash back on the wire the moment
// a new AppRow column is added and someone forgets this comment.
//
// rewardCounts defaults to a fresh rewardCountsBySource() call so every single-row
// caller (createApp, setAppDisabled, findAppByTokenHash) stays a one-liner; listApps
// below computes it once and threads it through the map instead, so listing N apps
// costs one reward_provenance scan, not N.
function rowToApp(row: AppRow, rewardCounts: Record<string, number> = rewardCountsBySource()): App {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    tokenConfigured: Boolean(row.tokenHash),
    rewardCount: rewardCounts[row.name] ?? 0,
  };
}

export function listApps(): App[] {
  const rewardCounts = rewardCountsBySource();
  return (listAppsRow.all() as AppRow[]).map(row => rowToApp(row, rewardCounts));
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    throw new HttpRouteError(400, 'App name must be 1-32 chars of a-z, 0-9, _ or -.');
  }
  if (RESERVED_SOURCES.has(name)) throw new HttpRouteError(400, `"${name}" is a reserved source name.`);
  return name;
}

export function createApp(rawName: string): App {
  const name = normalizeName(rawName);
  if (getAppByName.get(name)) throw new HttpRouteError(409, `An app named "${name}" already exists.`);
  const id = crypto.randomUUID();
  insertApp.run(id, name, new Date().toISOString());
  return rowToApp(getAppRow.get(id) as AppRow);
}

export function setAppDisabled(id: string, disabled: boolean): App | null {
  setDisabled.run(disabled ? new Date().toISOString() : null, id);
  const row = getAppRow.get(id) as AppRow | undefined;
  return row ? rowToApp(row) : null;
}

export function isKnownSource(source: string): boolean {
  if (RESERVED_SOURCES.has(source)) return true;
  return Boolean(getAppByName.get(source));
}

const TOKEN_PREFIX = 'narya_app_';

/** sha256 of the plaintext token. Only this is ever persisted. */
export function hashAppToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Mint (or rotate) an app's token. Returns the plaintext EXACTLY once — it is not
 *  stored and cannot be recovered. Rotating instantly invalidates the previous token. */
export function mintAppToken(appId: string): string {
  if (!appExistsById(appId)) throw new HttpRouteError(404, 'App not found.');
  const plaintext = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  setTokenHash.run(hashAppToken(plaintext), appId);
  return plaintext;
}

/** Existence-checked for the same reason mintAppToken is: an UPDATE against an id
 *  that does not exist is a silent no-op in SQLite, so a typo'd id would answer 204
 *  and leave the operator believing they had killed a credential that is still live. */
export function revokeAppToken(appId: string): void {
  if (!appExistsById(appId)) throw new HttpRouteError(404, 'App not found.');
  setTokenHash.run(null, appId);
}

/** Resolve a token HASH to its app. Callers hash first — never pass a plaintext. */
export function findAppByTokenHash(tokenHash: string): App | null {
  const row = getAppByTokenHash.get(tokenHash) as AppRow | undefined;
  return row ? rowToApp(row) : null;
}

export function listSelectableSources(): string[] {
  const enabled = (listAppsRow.all() as AppRow[]).filter(a => !a.disabledAt).map(a => a.name);
  return ['narya', 'manual', ...enabled];
}

// The ROW shape from SQLite — distinct from AppEvent (the wire type), which carries
// dataKeys instead of the raw dataSchemaJson column.
type AppEventRow = { appId: string; eventName: string; dataSchemaJson: string; createdAt: string };

function rowToAppEvent(row: AppEventRow): AppEvent {
  return {
    appId: row.appId,
    eventName: row.eventName,
    dataKeys: catalogToDataKeys(parseDataCatalog(row.dataSchemaJson)),
    // countTriggersForEvent is declared further down this file as a `function`
    // (hoisted), so this forward reference resolves fine — it's only ever
    // actually called at request time, long after the whole module has loaded.
    boundTriggerCount: countTriggersForEvent(row.appId, row.eventName),
    createdAt: row.createdAt,
  };
}

const EVENT_COLUMNS = 'app_id as appId, event_name as eventName, data_schema_json as dataSchemaJson, created_at as createdAt';
const listEventsRow = db.prepare(`select ${EVENT_COLUMNS} from app_events where app_id = ? order by event_name`);
const getEventRow = db.prepare(`select ${EVENT_COLUMNS} from app_events where app_id = ? and event_name = ?`);
const insertEvent = db.prepare(`insert or ignore into app_events (app_id, event_name, data_schema_json, created_at) values (?, ?, '{}', ?)`);
const deleteEvent = db.prepare('delete from app_events where app_id = ? and event_name = ?');
const eventExists = db.prepare('select 1 as present from app_events where app_id = ? and event_name = ?');
const appById = db.prepare('select 1 as present from apps where id = ?');
const updateEventSchema = db.prepare('update app_events set data_schema_json = ? where app_id = ? and event_name = ?');
// Raw config_json, compared in JS. Two deliberate choices:
//  - NO json_extract: the codebase uses SQLite's JSON1 nowhere else; parsing in JS
//    keeps this query portable and matches how rowToTrigger already reads config.
//  - NO import from automationTriggers.ts: that module imports THIS one
//    (appExistsById/isDeclaredEvent), so reaching back would close an import
//    cycle between two modules that both prepare statements at load time.
// The redis_event trigger count is tiny, so scanning them is free.
const selectRedisTriggerConfigs = db.prepare(`select config_json as configJson from automation_triggers where kind = 'redis_event'`);

export function appExistsById(appId: string): boolean {
  return Boolean(appById.get(appId));
}

export function listAppEvents(appId: string): AppEvent[] {
  return (listEventsRow.all(appId) as AppEventRow[]).map(rowToAppEvent);
}

/**
 * Record the top-level keys of one observed payload into the event's catalog.
 * Returns true iff it wrote. Cumulative and changed-gated, so a converged schema
 * costs a read and nothing else. An undeclared (app, event) writes nothing — only
 * a dispatched, declared event learns.
 */
export function recordDataKeys(appId: string, eventName: string, data: Record<string, unknown>): boolean {
  const row = getEventRow.get(appId, eventName) as AppEventRow | undefined;
  if (!row) return false;
  const { catalog, changed } = mergeDataCatalog(parseDataCatalog(row.dataSchemaJson), data);
  if (!changed) return false;
  updateEventSchema.run(JSON.stringify(catalog), appId, eventName);
  return true;
}

/** How many redis_event triggers are bound to this (app, event) — drives the
 *  AppsPage "N triggers reference this" hint before a de-registration. Total: a
 *  trigger whose config_json is unreadable is simply not counted. */
export function countTriggersForEvent(appId: string, eventName: string): number {
  const rows = selectRedisTriggerConfigs.all() as { configJson: string }[];
  let n = 0;
  for (const row of rows) {
    try {
      const config = JSON.parse(row.configJson) as { appId?: unknown; eventName?: unknown };
      if (config.appId === appId && config.eventName === eventName) n += 1;
    } catch {
      // A trigger with unreadable config cannot be shown to reference this event.
    }
  }
  return n;
}

export function isDeclaredEvent(appId: string, eventName: string): boolean {
  return Boolean(eventExists.get(appId, eventName));
}

function normalizeEventName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[a-z0-9_.-]{1,64}$/i.test(name)) {
    throw new HttpRouteError(400, 'Event name must be 1-64 chars of a-z, 0-9, _ . or -.');
  }
  return name;
}

export function declareAppEvent(appId: string, rawName: string): AppEvent {
  if (!appExistsById(appId)) throw new HttpRouteError(404, 'App not found.');
  const eventName = normalizeEventName(rawName);
  insertEvent.run(appId, eventName, new Date().toISOString());
  return rowToAppEvent(getEventRow.get(appId, eventName) as AppEventRow);
}

export function removeAppEvent(appId: string, eventName: string): void {
  deleteEvent.run(appId, eventName);
}

export function registerAppsRoutes(app: express.Express) {
  app.get('/api/apps', handle(async (_request, response) => {
    response.json(listApps());
  }));
  app.post('/api/apps', handle(async (request, response) => {
    const body = request.body as { name?: unknown };
    response.status(201).json(createApp(typeof body.name === 'string' ? body.name : ''));
  }));
  app.patch('/api/apps/:id', handle<{ id: string }>(async (request, response) => {
    const body = request.body as { disabled?: unknown };
    const updated = setAppDisabled(request.params.id, body.disabled === true);
    if (!updated) throw new HttpRouteError(404, 'App not found.');
    response.json(updated);
  }));
  app.get('/api/apps/:id/events', handle<{ id: string }>(async (request, response) => {
    if (!appExistsById(request.params.id)) throw new HttpRouteError(404, 'App not found.');
    response.json(listAppEvents(request.params.id));
  }));
  app.post('/api/apps/:id/events', handle<{ id: string }>(async (request, response) => {
    const body = request.body as { eventName?: unknown };
    response.status(201).json(declareAppEvent(request.params.id, typeof body.eventName === 'string' ? body.eventName : ''));
  }));
  app.delete('/api/apps/:id/events/:name', handle<{ id: string; name: string }>(async (request, response) => {
    removeAppEvent(request.params.id, request.params.name);
    response.status(204).end();
  }));
  // Operator-only (this is /api/apps/, not /api/ext/, the token-authenticated
  // surface). Mint returns the plaintext once; it is never shown again.
  app.post('/api/apps/:id/token', handle<{ id: string }>(async (request, response) => {
    response.status(201).json({ token: mintAppToken(request.params.id) });
  }));
  app.delete('/api/apps/:id/token', handle<{ id: string }>(async (request, response) => {
    revokeAppToken(request.params.id);
    response.status(204).end();
  }));
}
