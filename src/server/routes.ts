import express, { type Express } from 'express';
import type { AlertConfigUpdate } from '../shared/api';
import { getAlertSettings, isAlertEventKind, saveAlertSettings, testAlert } from './alerts';
import { getTwitchRoomId } from './chat';
import { appConfig } from './appConfig';
import { getAutomodHold, getAutomodQueue, resolveAutomodHold } from './automod';
import { db } from './db';
import { getEmoteMap } from './emotes';
import { HttpRouteError, parseJsonColumn, sendRouteError } from './http';
import {
  createClipButton,
  deleteClipButton,
  getClipButtons,
  triggerClipButton,
  updateClipButton,
} from './clips';
import { clearManualMusic, getCurrentMusic, setManualMusic } from './music';
import { getObsStatus, isObsConnected, switchObsScene, triggerObsTransition } from './obs';
import { listMediaFiles } from './media';
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

  app.get('/api/media', (_request, response) => {
    response.json(listMediaFiles());
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

  app.get('/api/clips', (_request, response) => {
    response.json(getClipButtons());
  });

  app.post('/api/clips', (request, response) => {
    try {
      response.status(201).json(createClipButton(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/clips/:id', (request, response) => {
    try {
      response.json(updateClipButton(request.params.id, request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/clips/:id', (request, response) => {
    try {
      deleteClipButton(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/clips/:id/play', (request, response) => {
    const playback = triggerClipButton(request.params.id);
    if (!playback) {
      response.status(404).json({ error: 'Clip button not found' });
      return;
    }
    response.json(playback);
  });

  app.get('/api/automod/queue', (_request, response) => {
    response.json(getAutomodQueue());
  });

  const automodActions = [
    { path: 'allow', action: 'ALLOW', resolution: 'allowed' },
    { path: 'deny', action: 'DENY', resolution: 'denied' },
  ] as const;
  for (const { path, action, resolution } of automodActions) {
    app.post(`/api/automod/:id/${path}`, async (request, response) => {
      try {
        const id = request.params.id;
        // Check locally first so an unknown id 404s without any Twitch side
        // effect, and an already-resolved hold (EventSub won the race) returns
        // idempotently instead of erroring.
        const existing = getAutomodHold(id);
        if (!existing) throw new HttpRouteError(404, 'AutoMod hold not found.');
        if (existing.resolvedAt) {
          response.json(existing);
          return;
        }
        const result = await resolveAutomodMessage(state, id, action);
        // 'gone' is a guess — Twitch no longer knows the hold, so we assume it aged
        // out. A later automod.message.update carrying the real verdict replaces it.
        const hold = result.outcome === 'gone'
          ? resolveAutomodHold(id, 'expired', null)
          : resolveAutomodHold(id, resolution, result.moderatorLogin, { authoritative: true });
        response.json(hold ?? existing);
      } catch (error) {
        sendRouteError(response, error);
      }
    });
  }

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

  app.get('/api/alerts/settings', (_request, response) => {
    response.json(getAlertSettings());
  });

  app.put('/api/alerts/settings', (request, response) => {
    try {
      response.json(saveAlertSettings(request.body ?? {}));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/alerts/:kind/test', (request, response) => {
    try {
      const kind = request.params.kind;
      if (!isAlertEventKind(kind)) throw new HttpRouteError(400, `Unknown alert kind: ${kind}`);
      // Preview the unsaved form config when the client sends it; fall back to
      // saved settings for a bodyless request (e.g. a curl smoke test).
      const body = request.body as AlertConfigUpdate | undefined;
      const override = body && typeof body === 'object' && Object.keys(body).length > 0 ? body : undefined;
      testAlert(kind, override);
      response.json({ ok: true });
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
