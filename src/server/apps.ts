import type express from 'express';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import type { App, AppEvent } from '../shared/api';

const RESERVED_SOURCES = new Set(['narya', 'manual']);

type AppRow = { id: string; name: string; createdAt: string; disabledAt: string | null };

const SELECT_COLUMNS = 'id, name, created_at as createdAt, disabled_at as disabledAt';
const listAppsRow = db.prepare(`select ${SELECT_COLUMNS} from apps order by name`);
const getAppRow = db.prepare(`select ${SELECT_COLUMNS} from apps where id = ?`);
const getAppByName = db.prepare('select 1 as present from apps where name = ?');
const insertApp = db.prepare('insert into apps (id, name, created_at, disabled_at) values (?, ?, ?, null)');
const setDisabled = db.prepare('update apps set disabled_at = ? where id = ?');

export function listApps(): App[] {
  return listAppsRow.all() as AppRow[];
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
  return getAppRow.get(id) as App;
}

export function setAppDisabled(id: string, disabled: boolean): App | null {
  setDisabled.run(disabled ? new Date().toISOString() : null, id);
  return (getAppRow.get(id) as App | undefined) ?? null;
}

export function isKnownSource(source: string): boolean {
  if (RESERVED_SOURCES.has(source)) return true;
  return Boolean(getAppByName.get(source));
}

export function listSelectableSources(): string[] {
  const enabled = (listAppsRow.all() as AppRow[]).filter(a => !a.disabledAt).map(a => a.name);
  return ['narya', 'manual', ...enabled];
}

const EVENT_COLUMNS = 'app_id as appId, event_name as eventName, data_schema_json as dataSchemaJson, created_at as createdAt';
const listEventsRow = db.prepare(`select ${EVENT_COLUMNS} from app_events where app_id = ? order by event_name`);
const getEventRow = db.prepare(`select ${EVENT_COLUMNS} from app_events where app_id = ? and event_name = ?`);
const insertEvent = db.prepare(`insert or ignore into app_events (app_id, event_name, data_schema_json, created_at) values (?, ?, '{}', ?)`);
const deleteEvent = db.prepare('delete from app_events where app_id = ? and event_name = ?');
const eventExists = db.prepare('select 1 as present from app_events where app_id = ? and event_name = ?');
const appById = db.prepare('select 1 as present from apps where id = ?');

export function appExistsById(appId: string): boolean {
  return Boolean(appById.get(appId));
}

export function listAppEvents(appId: string): AppEvent[] {
  return listEventsRow.all(appId) as AppEvent[];
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
  return getEventRow.get(appId, eventName) as AppEvent;
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
  app.patch('/api/apps/:id', handle(async (request, response) => {
    const body = request.body as { disabled?: unknown };
    const updated = setAppDisabled(request.params.id, body.disabled === true);
    if (!updated) throw new HttpRouteError(404, 'App not found.');
    response.json(updated);
  }));
  app.get('/api/apps/:id/events', handle(async (request, response) => {
    if (!appExistsById(request.params.id)) throw new HttpRouteError(404, 'App not found.');
    response.json(listAppEvents(request.params.id));
  }));
  app.post('/api/apps/:id/events', handle(async (request, response) => {
    const body = request.body as { eventName?: unknown };
    response.status(201).json(declareAppEvent(request.params.id, typeof body.eventName === 'string' ? body.eventName : ''));
  }));
  app.delete('/api/apps/:id/events/:name', handle(async (request, response) => {
    removeAppEvent(request.params.id, request.params.name);
    response.status(204).end();
  }));
}
