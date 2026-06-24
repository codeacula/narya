import type express from 'express';
import { getTwitchRoomId } from './chat';
import { config } from './config';
import { db } from './db';
import { getEmoteMap } from './emotes';
import { HttpRouteError, sendRouteError } from './http';
import { clearManualMusic, getCurrentMusic, setManualMusic } from './music';
import { getObsStatus, isObsConnected, switchObsScene, triggerObsTransition } from './obs';
import type { RuntimeState } from './runtime';
import {
  createSoundButton,
  deleteSoundButton,
  getSoundButtons,
  triggerQuackSound,
  triggerSoundButton,
  updateSoundButton,
} from './sounds';

const listRunsheetItems = db.prepare(`
  select id, text, done, position
  from runsheet_items
  order by position asc, text collate nocase
`);

const listTickerItems = db.prepare(`
  select id, text, position
  from ticker_items
  order by position asc, text collate nocase
`);

const createRunsheetItemRow = db.prepare(`
  insert into runsheet_items (id, text, done, position)
  values (?, ?, ?, ?)
`);
const updateRunsheetItemRow = db.prepare(`
  update runsheet_items
  set text = ?, done = ?
  where id = ?
`);
const deleteRunsheetItemRow = db.prepare('delete from runsheet_items where id = ?');
const getRunsheetItemRow = db.prepare('select id, text, done, position from runsheet_items where id = ?');
const createTickerItemRow = db.prepare(`
  insert into ticker_items (id, text, position)
  values (?, ?, ?)
`);
const updateTickerItemRow = db.prepare(`
  update ticker_items
  set text = ?
  where id = ?
`);
const deleteTickerItemRow = db.prepare('delete from ticker_items where id = ?');
const getTickerItemRow = db.prepare('select id, text, position from ticker_items where id = ?');
const getMaxRunsheetPosition = db.prepare('select coalesce(max(position), -1) as position from runsheet_items');
const getMaxTickerPosition = db.prepare('select coalesce(max(position), -1) as position from ticker_items');

function normalizeRunsheetBody(body: unknown) {
  const value = body as { text?: unknown; done?: unknown };
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text) throw new HttpRouteError(400, 'Runsheet item text is required.');
  if (text.length > 240) throw new HttpRouteError(400, 'Runsheet item text must be 240 characters or fewer.');
  return {
    text,
    done: typeof value.done === 'boolean' ? value.done : false,
  };
}

function normalizeTickerBody(body: unknown) {
  const value = body as { text?: unknown };
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text) throw new HttpRouteError(400, 'Ticker item text is required.');
  if (text.length > 160) throw new HttpRouteError(400, 'Ticker item text must be 160 characters or fewer.');
  return { text };
}

function rowToRunItem(row: { id: string; text: string; done: number; position: number }) {
  return {
    id: row.id,
    text: row.text,
    done: row.done === 1,
    position: row.position,
  };
}

export function registerCoreRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      twitchChannel: config.twitchChannel,
      obsConnected: isObsConnected(),
      twitchRoomId: getTwitchRoomId(),
      eventSubConnected: state.eventSubConnected,
    });
  });

  app.get('/api/control/config', (_request, response) => {
    const obsStatus = getObsStatus();
    response.json({ scenes: obsStatus.scenes.length > 0 ? obsStatus.scenes : config.obsScenes });
  });

  app.get('/api/obs/status', (_request, response) => {
    const obsStatus = getObsStatus();
    response.json({
      ...obsStatus,
      scenes: obsStatus.scenes.length > 0 ? obsStatus.scenes : config.obsScenes,
    });
  });

  app.get('/api/runsheet', (_request, response) => {
    const rows = listRunsheetItems.all() as Array<{ id: string; text: string; done: number; position: number }>;
    response.json(rows.map(rowToRunItem));
  });

  app.post('/api/runsheet', (request, response) => {
    try {
      const item = normalizeRunsheetBody(request.body);
      const id = crypto.randomUUID();
      const maxPosition = getMaxRunsheetPosition.get() as { position: number };
      createRunsheetItemRow.run(id, item.text, item.done ? 1 : 0, maxPosition.position + 1);
      const row = getRunsheetItemRow.get(id) as { id: string; text: string; done: number; position: number };
      response.status(201).json(rowToRunItem(row));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/runsheet/:id', (request, response) => {
    try {
      const existing = getRunsheetItemRow.get(request.params.id) as { id: string; text: string; done: number; position: number } | null;
      if (!existing) throw new HttpRouteError(404, 'Runsheet item not found.');
      const item = normalizeRunsheetBody(request.body);
      updateRunsheetItemRow.run(item.text, item.done ? 1 : 0, request.params.id);
      const row = getRunsheetItemRow.get(request.params.id) as { id: string; text: string; done: number; position: number };
      response.json(rowToRunItem(row));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/runsheet/:id', (request, response) => {
    try {
      const existing = getRunsheetItemRow.get(request.params.id);
      if (!existing) throw new HttpRouteError(404, 'Runsheet item not found.');
      deleteRunsheetItemRow.run(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/ticker', (_request, response) => {
    response.json(listTickerItems.all());
  });

  app.post('/api/ticker', (request, response) => {
    try {
      const item = normalizeTickerBody(request.body);
      const id = crypto.randomUUID();
      const maxPosition = getMaxTickerPosition.get() as { position: number };
      createTickerItemRow.run(id, item.text, maxPosition.position + 1);
      response.status(201).json(getTickerItemRow.get(id));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/ticker/:id', (request, response) => {
    try {
      const existing = getTickerItemRow.get(request.params.id);
      if (!existing) throw new HttpRouteError(404, 'Ticker item not found.');
      const item = normalizeTickerBody(request.body);
      updateTickerItemRow.run(item.text, request.params.id);
      response.json(getTickerItemRow.get(request.params.id));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/ticker/:id', (request, response) => {
    try {
      const existing = getTickerItemRow.get(request.params.id);
      if (!existing) throw new HttpRouteError(404, 'Ticker item not found.');
      deleteTickerItemRow.run(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/music/current', (_request, response) => {
    response.json(getCurrentMusic());
  });

  app.put('/api/music/current', (request, response) => {
    const music = setManualMusic(request.body);
    if (!music) {
      response.status(400).json({ error: 'status must be playing, paused, or stopped' });
      return;
    }

    response.json(music);
  });

  app.delete('/api/music/current', async (_request, response) => {
    response.json(await clearManualMusic());
  });

  app.get('/api/chat/recent', (_request, response) => {
    const rows = db
      .prepare(`
        select
          id,
          channel,
          username,
          display_name as displayName,
          color,
          message,
          received_at as receivedAt,
          deleted_at as deletedAt,
          deleted_reason as deletedReason,
          badges_json as badgesJson,
          emotes_json as emotesJson,
          is_first_in_session as isFirstThisSession,
          is_first_ever as isFirstEver
        from chat_messages
        order by received_at desc
        limit 40
      `)
      .all()
      .reverse()
      .map((row) => {
        const r = row as Record<string, unknown> & { badgesJson: string | null; emotesJson: string | null };
        const { badgesJson, emotesJson, ...rest } = r;
        return {
          ...rest,
          badges: badgesJson ? JSON.parse(badgesJson) : null,
          emotes: emotesJson ? JSON.parse(emotesJson) : null,
          isFirstTimer: Boolean(r.isFirstEver),
          isFirstThisSession: Boolean(r.isFirstThisSession),
          isFirstEver: Boolean(r.isFirstEver),
        };
      });

    response.json(rows);
  });

  app.get('/api/chat/events/recent', (_request, response) => {
    const rows = db
      .prepare(`
        select
          id,
          type,
          channel,
          message_id as messageId,
          username,
          payload_json as payloadJson,
          occurred_at as occurredAt
        from chat_events
        order by occurred_at desc
        limit 100
      `)
      .all()
      .reverse()
      .map((row) => {
        const event = row as Record<string, unknown> & { payloadJson: string };
        const { payloadJson, ...rest } = event;
        return { ...rest, payload: JSON.parse(payloadJson) };
      });

    response.json(rows);
  });

  app.post('/api/obs/scenes/:sceneName', async (request, response) => {
    try {
      const obsStatus = await switchObsScene(request.params.sceneName);
      response.json({ ok: true, obsStatus });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OBS scene switch failed';
      response.status(message.includes('was not found') ? 400 : 502).json({ error: message });
    }
  });

  app.post('/api/obs/transition', async (_request, response) => {
    try {
      const obsStatus = await triggerObsTransition();
      response.json({ ok: true, obsStatus });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'OBS transition failed' });
    }
  });

  app.post('/api/sounds/quack', (_request, response) => {
    response.json(triggerQuackSound());
  });

  app.get('/api/sounds', (_request, response) => {
    response.json(getSoundButtons());
  });

  app.post('/api/sounds', (request, response) => {
    try {
      response.status(201).json(createSoundButton(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/sounds/:id', (request, response) => {
    try {
      response.json(updateSoundButton(request.params.id, request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/sounds/:id', (request, response) => {
    try {
      deleteSoundButton(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/sounds/:id/play', (request, response) => {
    const playback = triggerSoundButton(request.params.id);
    if (!playback) {
      response.status(404).json({ error: 'Sound button not found' });
      return;
    }
    response.json(playback);
  });

  app.get('/api/emotes', async (_request, response) => {
    response.json(await getEmoteMap(getTwitchRoomId()));
  });
}
