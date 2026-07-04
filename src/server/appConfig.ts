import type express from 'express';
import type { AppConfig, AppConfigUpdate } from '../shared/api';
import { db } from './db';
import { HttpRouteError, sendRouteError } from './http';

const APP_CONFIG_ID = 'default';

// Internal shape with secrets resolved — for server-side consumers only.
export type AppConfigInternal = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecret: string;
  obsUrl: string;
  obsPassword: string;
  obsScenes: string[];
  discordClientId: string;
  discordBotToken: string;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  quackVolume: number;
  updatedAt: string;
};

type AppConfigRow = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecret: string;
  obsUrl: string;
  obsPassword: string;
  obsScenes: string;
  discordClientId: string;
  discordBotToken: string;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  quackVolume: number;
  updatedAt: string;
};

const selectRow = db.prepare(`
  select
    twitch_channel as twitchChannel,
    twitch_client_id as twitchClientId,
    twitch_client_secret as twitchClientSecret,
    obs_url as obsUrl,
    obs_password as obsPassword,
    obs_scenes as obsScenes,
    discord_client_id as discordClientId,
    discord_bot_token as discordBotToken,
    chatterbox_base_url as chatterboxBaseUrl,
    music_poll_interval_ms as musicPollIntervalMs,
    music_playerctl_player as musicPlayerctlPlayer,
    quack_volume as quackVolume,
    updated_at as updatedAt
  from app_config
  where id = ?
`);

const insertSeedRow = db.prepare(`
  insert or ignore into app_config
    (id, twitch_channel, twitch_client_id, twitch_client_secret, obs_url, obs_password,
    obs_scenes, discord_client_id, discord_bot_token, elevenlabs_api_key,
     music_poll_interval_ms, music_playerctl_player, quack_volume, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateRow = db.prepare(`
  update app_config set
    twitch_channel = ?,
    twitch_client_id = ?,
    twitch_client_secret = ?,
    obs_url = ?,
    obs_password = ?,
    obs_scenes = ?,
    discord_client_id = ?,
    discord_bot_token = ?,
    elevenlabs_api_key = ?,
    chatterbox_base_url = ?,
    music_poll_interval_ms = ?,
    music_playerctl_player = ?,
    quack_volume = ?,
    updated_at = ?
  where id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

function parseScenes(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// One-time seed: migrate any existing .env values into the database on first boot so
// current operators keep working. After the row exists, env vars are ignored.
function seedFromEnv() {
  const envScenes = process.env.OBS_SCENES ?? 'Coding,BRB,Starting Soon,Ending';
  const envInterval = Number(process.env.MUSIC_POLL_INTERVAL_MS ?? 2000);
  const envVolume = Number(process.env.QUACK_VOLUME ?? 0.2);
  insertSeedRow.run(
    APP_CONFIG_ID,
    process.env.TWITCH_CHANNEL ?? 'codeacula',
    process.env.TWITCH_CLIENT_ID ?? '',
    process.env.TWITCH_CLIENT_SECRET ?? '',
    process.env.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455',
    process.env.OBS_WEBSOCKET_PASSWORD ?? '',
    parseScenes(envScenes).join(','),
    process.env.DISCORD_CLIENT_ID ?? '',
    process.env.DISCORD_BOT_TOKEN ?? '',
    '',
    Number.isFinite(envInterval) ? envInterval : 2000,
    process.env.MUSIC_PLAYERCTL_PLAYER?.trim() || 'strawberry',
    Number.isFinite(envVolume) ? clampNumber(envVolume, 0, 1) : 0.2,
    nowIso(),
  );
  // Backfill chatterbox_base_url from env if the column was just added (value still default).
  db.prepare(`
    update app_config set chatterbox_base_url = ?
    where id = ? and chatterbox_base_url = 'http://127.0.0.1:8008' and ? != 'http://127.0.0.1:8008'
  `).run(
    (process.env.CHATTERBOX_BASE_URL ?? 'http://127.0.0.1:8008').replace(/\/+$/, ''),
    APP_CONFIG_ID,
    (process.env.CHATTERBOX_BASE_URL ?? 'http://127.0.0.1:8008').replace(/\/+$/, ''),
  );
}

let cache: AppConfigInternal | null = null;

function loadRow(): AppConfigInternal {
  seedFromEnv();
  const row = selectRow.get(APP_CONFIG_ID) as AppConfigRow;
  return {
    twitchChannel: row.twitchChannel,
    twitchClientId: row.twitchClientId,
    twitchClientSecret: row.twitchClientSecret,
    obsUrl: row.obsUrl,
    obsPassword: row.obsPassword,
    obsScenes: parseScenes(row.obsScenes),
    discordClientId: row.discordClientId,
    discordBotToken: row.discordBotToken,
    chatterboxBaseUrl: (row.chatterboxBaseUrl || 'http://127.0.0.1:8008').replace(/\/+$/, ''),
    musicPollIntervalMs: row.musicPollIntervalMs,
    musicPlayerctlPlayer: row.musicPlayerctlPlayer,
    quackVolume: row.quackVolume,
    updatedAt: row.updatedAt,
  };
}

export function reloadAppConfig(): AppConfigInternal {
  cache = loadRow();
  return cache;
}

function current(): AppConfigInternal {
  if (!cache) cache = loadRow();
  return cache;
}

// Live accessor object: properties read the latest cached values, so consumers that
// swapped `config.X` for `appConfig.X` automatically pick up changes after a save.
export const appConfig = {
  get twitchChannel() { return current().twitchChannel; },
  get twitchClientId() { return current().twitchClientId; },
  get twitchClientSecret() { return current().twitchClientSecret; },
  get obsUrl() { return current().obsUrl; },
  get obsPassword() { return current().obsPassword; },
  get obsScenes() { return current().obsScenes; },
  get discordClientId() { return current().discordClientId; },
  get discordBotToken() { return current().discordBotToken; },
  get chatterboxBaseUrl() { return current().chatterboxBaseUrl; },
  get musicPollIntervalMs() { return current().musicPollIntervalMs; },
  get musicPlayerctlPlayer() { return current().musicPlayerctlPlayer; },
  get quackVolume() { return current().quackVolume; },
};

export function getAppConfigInternal(): AppConfigInternal {
  return current();
}

function toPublic(internal: AppConfigInternal): AppConfig {
  return {
    twitchChannel: internal.twitchChannel,
    twitchClientId: internal.twitchClientId,
    twitchClientSecretConfigured: Boolean(internal.twitchClientSecret),
    obsUrl: internal.obsUrl,
    obsPasswordConfigured: Boolean(internal.obsPassword),
    obsScenes: internal.obsScenes,
    discordClientId: internal.discordClientId,
    discordBotTokenConfigured: Boolean(internal.discordBotToken),
    chatterboxBaseUrl: internal.chatterboxBaseUrl,
    musicPollIntervalMs: internal.musicPollIntervalMs,
    musicPlayerctlPlayer: internal.musicPlayerctlPlayer,
    quackVolume: internal.quackVolume,
    updatedAt: internal.updatedAt || null,
  };
}

export function getAppConfig(): AppConfig {
  return toPublic(current());
}

// Config keys whose change requires a service to reconnect/restart.
export type AppConfigChange =
  | 'twitchChannel'
  | 'twitchCredentials'
  | 'obs'
  | 'music'
  | 'discord';

function normalizeUpdate(body: unknown): AppConfigUpdate {
  const value = (body ?? {}) as Partial<AppConfigUpdate>;
  const str = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');

  const twitchChannel = str(value.twitchChannel).toLowerCase();
  if (twitchChannel && !/^[a-z0-9_]{1,25}$/.test(twitchChannel)) {
    throw new HttpRouteError(400, 'Twitch channel must be 1-25 letters, numbers, or underscores.');
  }

  const obsUrl = str(value.obsUrl);
  if (obsUrl && !/^wss?:\/\//i.test(obsUrl)) {
    throw new HttpRouteError(400, 'OBS WebSocket URL must start with ws:// or wss://.');
  }

  const scenes = Array.isArray(value.obsScenes)
    ? value.obsScenes.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : [];

  const interval = Math.round(clampNumber(Number(value.musicPollIntervalMs ?? 2000), 0, 60000));
  const volume = clampNumber(Number(value.quackVolume ?? 0.2), 0, 1);

  const chatterboxBaseUrl = str(value.chatterboxBaseUrl).replace(/\/+$/, '') || 'http://127.0.0.1:8008';

  return {
    twitchChannel,
    twitchClientId: str(value.twitchClientId),
    twitchClientSecret: typeof value.twitchClientSecret === 'string' ? value.twitchClientSecret.trim() : undefined,
    clearTwitchClientSecret: value.clearTwitchClientSecret === true,
    obsUrl,
    obsPassword: typeof value.obsPassword === 'string' ? value.obsPassword : undefined,
    clearObsPassword: value.clearObsPassword === true,
    obsScenes: scenes,
    discordClientId: str(value.discordClientId),
    discordBotToken: typeof value.discordBotToken === 'string' ? value.discordBotToken.trim() : undefined,
    clearDiscordBotToken: value.clearDiscordBotToken === true,
    chatterboxBaseUrl,
    musicPollIntervalMs: interval,
    musicPlayerctlPlayer: str(value.musicPlayerctlPlayer),
    quackVolume: volume,
  };
}

function resolveSecret(clear: boolean | undefined, next: string | undefined, existing: string): string {
  if (clear) return '';
  if (next !== undefined && next !== '') return next;
  return existing;
}

export function saveAppConfig(body: unknown): { config: AppConfig; changes: Set<AppConfigChange> } {
  const prev = current();
  const update = normalizeUpdate(body);

  const next: AppConfigInternal = {
    twitchChannel: update.twitchChannel,
    twitchClientId: update.twitchClientId,
    twitchClientSecret: resolveSecret(update.clearTwitchClientSecret, update.twitchClientSecret, prev.twitchClientSecret),
    obsUrl: update.obsUrl,
    obsPassword: resolveSecret(update.clearObsPassword, update.obsPassword, prev.obsPassword),
    obsScenes: update.obsScenes,
    discordClientId: update.discordClientId,
    discordBotToken: resolveSecret(update.clearDiscordBotToken, update.discordBotToken, prev.discordBotToken),
    chatterboxBaseUrl: update.chatterboxBaseUrl,
    musicPollIntervalMs: update.musicPollIntervalMs,
    musicPlayerctlPlayer: update.musicPlayerctlPlayer,
    quackVolume: update.quackVolume,
    updatedAt: nowIso(),
  };

  updateRow.run(
    next.twitchChannel,
    next.twitchClientId,
    next.twitchClientSecret,
    next.obsUrl,
    next.obsPassword,
    next.obsScenes.join(','),
    next.discordClientId,
    next.discordBotToken,
    '',
    next.chatterboxBaseUrl,
    next.musicPollIntervalMs,
    next.musicPlayerctlPlayer,
    next.quackVolume,
    next.updatedAt,
    APP_CONFIG_ID,
  );

  cache = next;

  const changes = new Set<AppConfigChange>();
  if (next.twitchChannel !== prev.twitchChannel) changes.add('twitchChannel');
  if (next.twitchClientId !== prev.twitchClientId || next.twitchClientSecret !== prev.twitchClientSecret) {
    changes.add('twitchCredentials');
  }
  if (next.obsUrl !== prev.obsUrl || next.obsPassword !== prev.obsPassword) changes.add('obs');
  if (
    next.musicPollIntervalMs !== prev.musicPollIntervalMs ||
    next.musicPlayerctlPlayer !== prev.musicPlayerctlPlayer
  ) {
    changes.add('music');
  }
  if (next.discordClientId !== prev.discordClientId || next.discordBotToken !== prev.discordBotToken) {
    changes.add('discord');
  }

  return { config: toPublic(next), changes };
}

export function registerAppConfigRoutes(
  app: express.Express,
  onSaved: (result: { config: AppConfig; changes: Set<AppConfigChange> }) => void,
) {
  reloadAppConfig();

  app.get('/api/config', (_request, response) => {
    response.json(getAppConfig());
  });

  app.put('/api/config', (request, response) => {
    try {
      const result = saveAppConfig(request.body);
      onSaved(result);
      response.json(result.config);
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
