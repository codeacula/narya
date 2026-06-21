import type express from 'express';
import { getTwitchRoomId } from './chat';
import { config } from './config';
import { db } from './db';
import { getEmoteMap } from './emotes';
import { clearManualMusic, getCurrentMusic, setManualMusic } from './music';
import { isObsConnected, switchObsScene, triggerObsTransition } from './obs';
import type { RuntimeState } from './runtime';
import { getSoundButtons, triggerQuackSound, triggerSoundButton } from './sounds';

const listRunsheetItems = db.prepare(`
  select text, done
  from runsheet_items
  order by position asc, text collate nocase
`);

const listTickerItems = db.prepare(`
  select text
  from ticker_items
  order by position asc, text collate nocase
`);

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
    response.json({ scenes: config.obsScenes });
  });

  app.get('/api/runsheet', (_request, response) => {
    const rows = listRunsheetItems.all() as Array<{ text: string; done: number }>;
    response.json(rows.map(row => ({ text: row.text, done: row.done === 1 })));
  });

  app.get('/api/ticker', (_request, response) => {
    const rows = listTickerItems.all() as Array<{ text: string }>;
    response.json(rows.map(row => row.text));
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
          emotes_json as emotesJson
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
      await switchObsScene(request.params.sceneName);
      response.json({ ok: true });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'OBS scene switch failed' });
    }
  });

  app.post('/api/obs/transition', async (_request, response) => {
    try {
      await triggerObsTransition();
      response.json({ ok: true });
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
