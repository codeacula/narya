import type express from 'express';
import type { GoLiveResult, GoLiveSettings, GoLiveSettingsUpdate, ObsStatus } from '../shared/api';
import { config } from './config';
import { db } from './db';
import { clearDiscordStatusCache, sendDiscordMessage } from './discord';
import { HttpRouteError, sendRouteError } from './http';
import { startObsStream, switchObsScene } from './obs';
import type { RuntimeState } from './runtime';
import {
  attachDiscordAnnouncementToSession,
  getOrStartStreamSession,
} from './streamSession';
import { fetchCurrentTwitchStream, getEventSubCredentials } from './twitch/api';

const SETTINGS_ID = 'default';

let goLiveRunning = false;

const getGoLiveSettingsRow = db.prepare(`
  select
    obs_scene_name as obsSceneName,
    discord_guild_id as discordGuildId,
    discord_guild_name as discordGuildName,
    discord_channel_id as discordChannelId,
    discord_channel_name as discordChannelName,
    discord_message as discordMessage,
    updated_at as updatedAt
  from go_live_settings
  where id = ?
`);

const upsertGoLiveSettingsRow = db.prepare(`
  insert into go_live_settings (
    id,
    obs_scene_name,
    discord_guild_id,
    discord_guild_name,
    discord_channel_id,
    discord_channel_name,
    discord_message,
    updated_at
  )
  values (?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    obs_scene_name = excluded.obs_scene_name,
    discord_guild_id = excluded.discord_guild_id,
    discord_guild_name = excluded.discord_guild_name,
    discord_channel_id = excluded.discord_channel_id,
    discord_channel_name = excluded.discord_channel_name,
    discord_message = excluded.discord_message,
    updated_at = excluded.updated_at
`);

function defaultGoLiveScene(): string {
  return config.obsScenes.find(scene => scene.toLowerCase().includes('start')) ?? config.obsScenes[0] ?? '';
}

function defaultDiscordMessage(): string {
  return `I'm live now: https://twitch.tv/${config.twitchChannel}`;
}

export function getGoLiveSettings(): GoLiveSettings {
  const row = getGoLiveSettingsRow.get(SETTINGS_ID) as GoLiveSettings | null;
  return row ?? {
    obsSceneName: defaultGoLiveScene(),
    discordGuildId: '',
    discordGuildName: '',
    discordChannelId: '',
    discordChannelName: '',
    discordMessage: defaultDiscordMessage(),
    updatedAt: null,
  };
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeSnowflake(value: unknown, label: string): string {
  const text = normalizeText(value, 32);
  if (text && !/^\d{5,32}$/.test(text)) {
    throw new HttpRouteError(400, `${label} must be a Discord ID.`);
  }
  return text;
}

function normalizeGoLiveSettings(body: unknown): GoLiveSettingsUpdate {
  const value = body as Partial<GoLiveSettingsUpdate>;
  const obsSceneName = normalizeText(value.obsSceneName, 160);
  const discordGuildId = normalizeSnowflake(value.discordGuildId, 'Discord server');
  const discordChannelId = normalizeSnowflake(value.discordChannelId, 'Discord channel');
  const discordMessage = typeof value.discordMessage === 'string' ? value.discordMessage.trim() : '';

  if (!obsSceneName) throw new HttpRouteError(400, 'OBS starting scene is required.');
  if (!discordMessage) throw new HttpRouteError(400, 'Discord announcement message is required.');
  if (discordMessage.length > 2000) throw new HttpRouteError(400, 'Discord announcement message must be 2000 characters or fewer.');

  return {
    obsSceneName,
    discordGuildId,
    discordGuildName: normalizeText(value.discordGuildName, 160),
    discordChannelId,
    discordChannelName: normalizeText(value.discordChannelName, 160),
    discordMessage,
  };
}

export function saveGoLiveSettings(body: unknown): GoLiveSettings {
  const settings = normalizeGoLiveSettings(body);
  const updatedAt = new Date().toISOString();
  upsertGoLiveSettingsRow.run(
    SETTINGS_ID,
    settings.obsSceneName,
    settings.discordGuildId,
    settings.discordGuildName,
    settings.discordChannelId,
    settings.discordChannelName,
    settings.discordMessage,
    updatedAt,
  );
  return getGoLiveSettings();
}

function renderDiscordMessage(template: string, vars: { title: string; category: string }): string {
  const twitchUrl = `https://twitch.tv/${config.twitchChannel}`;
  return template
    .replaceAll('{channel}', config.twitchChannel)
    .replaceAll('{url}', twitchUrl)
    .replaceAll('{twitchUrl}', twitchUrl)
    .replaceAll('{title}', vars.title)
    .replaceAll('{category}', vars.category);
}

const twitchAnnouncementTasks = new Map<string, Promise<void>>();

export async function announceTwitchStreamOnline(streamId: string, startedAt: string, state: RuntimeState): Promise<void> {
  const normalizedStreamId = streamId.trim();
  if (!normalizedStreamId) throw new Error('Twitch stream ID is required for a live announcement.');

  const activeTask = twitchAnnouncementTasks.get(normalizedStreamId);
  if (activeTask) return activeTask;

  const task = (async () => {
    const session = getOrStartStreamSession(`twitch:${normalizedStreamId}`, startedAt);
    if (session.discordMessageId) return;

    const settings = getGoLiveSettings();
    if (!settings.discordChannelId) {
      console.warn('Discord: Twitch went live, but no announcement channel is configured.');
      return;
    }

    let title = '';
    let category = '';
    const creds = await getEventSubCredentials(state);
    if (creds) {
      const stream = await fetchCurrentTwitchStream(creds.clientId, creds.userToken);
      if (stream) {
        title = stream.title;
        category = stream.category;
      }
    }

    const message = await sendDiscordMessage(
      settings.discordChannelId,
      renderDiscordMessage(settings.discordMessage, { title, category }),
    );
    attachDiscordAnnouncementToSession(session.id, message.channelId, message.id);
    console.log(`Discord: announced Twitch stream ${normalizedStreamId} in channel ${message.channelId}`);
  })();

  twitchAnnouncementTasks.set(normalizedStreamId, task);
  try {
    await task;
  } finally {
    twitchAnnouncementTasks.delete(normalizedStreamId);
  }
}

async function runGoLiveStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpRouteError) {
      throw new HttpRouteError(error.status, `Go Live failed during ${label}: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new HttpRouteError(502, `Go Live failed during ${label}: ${message}`);
  }
}

export async function runGoLive(): Promise<GoLiveResult> {
  if (goLiveRunning) throw new HttpRouteError(409, 'Go Live is already running.');

  const settings = getGoLiveSettings();
  if (!settings.obsSceneName) throw new HttpRouteError(400, 'Configure an OBS starting scene before going live.');
  goLiveRunning = true;
  try {
    await runGoLiveStep('OBS scene switch', () => switchObsScene(settings.obsSceneName));
    const obsStatus = await runGoLiveStep<ObsStatus>('OBS stream start', () => startObsStream());

    return {
      ok: true,
      obsStatus,
    };
  } finally {
    goLiveRunning = false;
  }
}

const clearDiscordGoLiveSettingsRow = db.prepare(`
  update go_live_settings
  set discord_guild_id = '', discord_guild_name = '', discord_channel_id = '', discord_channel_name = '',
      updated_at = ?
  where id = ?
`);

export function clearDiscordGoLiveSettings(): GoLiveSettings {
  clearDiscordGoLiveSettingsRow.run(new Date().toISOString(), SETTINGS_ID);
  clearDiscordStatusCache();
  return getGoLiveSettings();
}

export function registerGoLiveRoutes(app: express.Express) {
  app.get('/api/go-live/settings', (_request, response) => {
    response.json(getGoLiveSettings());
  });

  app.put('/api/go-live/settings', (request, response) => {
    try {
      response.json(saveGoLiveSettings(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/go-live/settings/discord', (_request, response) => {
    response.json(clearDiscordGoLiveSettings());
  });

  app.post('/api/go-live', async (_request, response) => {
    try {
      response.json(await runGoLive());
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
