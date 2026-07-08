import express, { type Express } from 'express';
import { getTwitchRoomId } from './chat';
import { appConfig } from './appConfig';
import { getAutomodQueue, resolveAutomodHold } from './automod';
import { db } from './db';
import { getEmoteMap } from './emotes';
import { HttpRouteError, parseJsonColumn, sendRouteError } from './http';
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
import { resolveAutomodMessage } from './twitch/api';
import {
  getTtsEnabledRewardIds,
  getTtsEngineStatus,
  getTtsSettings,
  getTtsVoices,
  isTtsRewardEnabled,
  setTtsRewardEnabled,
  speakText,
  updateTtsSettings,
} from './tts';

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

export function registerCoreRoutes(app: Express, state: RuntimeState) {
  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      twitchChannel: appConfig.twitchChannel,
      obsConnected: isObsConnected(),
      twitchRoomId: getTwitchRoomId(),
      eventSubConnected: state.eventSubConnected,
    });
  });

  app.get('/api/control/config', (_request, response) => {
    const obsStatus = getObsStatus();
    response.json({ scenes: obsStatus.scenes.length > 0 ? obsStatus.scenes : appConfig.obsScenes });
  });

  app.get('/api/obs/status', (_request, response) => {
    const obsStatus = getObsStatus();
    response.json({
      ...obsStatus,
      scenes: obsStatus.scenes.length > 0 ? obsStatus.scenes : appConfig.obsScenes,
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
          badges: parseJsonColumn<Record<string, string>>(badgesJson),
          emotes: parseJsonColumn<Record<string, string[]>>(emotesJson),
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
        return { ...rest, payload: parseJsonColumn<Record<string, unknown>>(payloadJson) };
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

  app.get('/api/automod/queue', (_request, response) => {
    response.json(getAutomodQueue());
  });

  app.post('/api/automod/:id/allow', async (request, response) => {
    try {
      await resolveAutomodMessage(state, request.params.id, 'ALLOW');
      response.json(resolveAutomodHold(request.params.id, 'allowed', 'You'));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/automod/:id/deny', async (request, response) => {
    try {
      await resolveAutomodMessage(state, request.params.id, 'DENY');
      response.json(resolveAutomodHold(request.params.id, 'denied', 'You'));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/emotes', async (_request, response) => {
    response.json(await getEmoteMap(getTwitchRoomId()));
  });

  app.get('/api/tts/settings', (_request, response) => {
    response.json(getTtsSettings());
  });

  app.put('/api/tts/settings', (request, response) => {
    try {
      const body = request.body as {
        enabled?: unknown;
        voiceProfileId?: unknown;
        languageId?: unknown;
        tonePreset?: unknown;
        exaggeration?: unknown;
        cfgWeight?: unknown;
        temperature?: unknown;
        volume?: unknown;
      };
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : false;
      const voiceProfileId = typeof body.voiceProfileId === 'string' ? body.voiceProfileId.trim() : 'zombiechicken';
      const languageId = typeof body.languageId === 'string' ? body.languageId.trim() : 'en';
      const tonePreset = typeof body.tonePreset === 'string' ? body.tonePreset.trim() : 'neutral';
      const exaggeration = typeof body.exaggeration === 'number' ? body.exaggeration : 0.5;
      const cfgWeight = typeof body.cfgWeight === 'number' ? body.cfgWeight : 0.5;
      const temperature = typeof body.temperature === 'number' ? body.temperature : 0.8;
      const volume = typeof body.volume === 'number' ? body.volume : 0.8;
      response.json(updateTtsSettings({
        enabled,
        voiceProfileId,
        languageId,
        tonePreset,
        exaggeration,
        cfgWeight,
        temperature,
        volume,
      }));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/tts/status', async (_request, response) => {
    response.json(await getTtsEngineStatus());
  });

  app.get('/api/tts/voices', async (_request, response) => {
    try {
      response.json(await getTtsVoices());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/tts/speak', async (request, response) => {
    try {
      const body = request.body as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw new HttpRouteError(400, 'text is required.');
      await speakText(text, true);
      response.json({ ok: true });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/tts/rewards', (_request, response) => {
    response.json(getTtsEnabledRewardIds());
  });

  app.get('/api/tts/reward/:rewardId', (request, response) => {
    response.json({ enabled: isTtsRewardEnabled(request.params.rewardId) });
  });

  app.put('/api/tts/reward/:rewardId', (request, response) => {
    try {
      const body = request.body as { enabled?: unknown };
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : false;
      setTtsRewardEnabled(request.params.rewardId, enabled);
      response.json({ enabled });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
