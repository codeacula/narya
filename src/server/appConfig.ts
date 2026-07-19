import type express from 'express';
import type { AppConfig, AppConfigUpdate } from '../shared/api';
import { db, runOnce } from './db';
import { HttpRouteError, sendRouteError } from './http';
import { getAuthenticatedTwitchLogin } from './twitchIdentity';

const APP_CONFIG_ID = 'default';

/**
 * What a brand-new install starts with, before the operator opens Settings. These
 * used to be read from the environment on first boot; nothing reads them from the
 * environment any more, because a value that is consulted exactly once and then
 * ignored forever is a config file lying about what it controls.
 */
const DEFAULTS = {
  twitchChannel: '',
  twitchClientId: '',
  twitchClientSecret: '',
  obsUrl: 'ws://127.0.0.1:4455',
  obsPassword: '',
  obsScenePrefix: 'Scene - ',
  discordClientId: '',
  discordBotToken: '',
  chatterboxBaseUrl: 'http://127.0.0.1:8008',
  musicPollIntervalMs: 2000,
  musicPlayerctlPlayer: 'strawberry',
  soundVolume: 0.2,
} as const;

// Internal shape with secrets resolved — for server-side consumers only.
export type AppConfigInternal = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecret: string;
  obsUrl: string;
  obsPassword: string;
  obsScenePrefix: string;
  discordClientId: string;
  discordBotToken: string;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  soundVolume: number;
  updatedAt: string;
};

type AppConfigRow = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecret: string;
  obsUrl: string;
  obsPassword: string;
  obsScenePrefix: string;
  discordClientId: string;
  discordBotToken: string;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  soundVolume: number;
  updatedAt: string;
};

const selectRow = db.prepare(`
  select
    twitch_channel as twitchChannel,
    twitch_client_id as twitchClientId,
    twitch_client_secret as twitchClientSecret,
    obs_url as obsUrl,
    obs_password as obsPassword,
    obs_scene_prefix as obsScenePrefix,
    discord_client_id as discordClientId,
    discord_bot_token as discordBotToken,
    chatterbox_base_url as chatterboxBaseUrl,
    music_poll_interval_ms as musicPollIntervalMs,
    music_playerctl_player as musicPlayerctlPlayer,
    sound_button_volume as soundVolume,
    updated_at as updatedAt
  from app_config
  where id = ?
`);

const insertSeedRow = db.prepare(`
  insert or ignore into app_config
    (id, twitch_channel, twitch_client_id, twitch_client_secret, obs_url, obs_password,
     obs_scene_prefix, discord_client_id, discord_bot_token,
     music_poll_interval_ms, music_playerctl_player, sound_button_volume, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateRow = db.prepare(`
  update app_config set
    twitch_channel = ?,
    twitch_client_id = ?,
    twitch_client_secret = ?,
    obs_url = ?,
    obs_password = ?,
    obs_scene_prefix = ?,
    discord_client_id = ?,
    discord_bot_token = ?,
    chatterbox_base_url = ?,
    music_poll_interval_ms = ?,
    music_playerctl_player = ?,
    sound_button_volume = ?,
    updated_at = ?
  where id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function seedDefaultsIfMissing() {
  insertSeedRow.run(
    APP_CONFIG_ID,
    DEFAULTS.twitchChannel,
    DEFAULTS.twitchClientId,
    DEFAULTS.twitchClientSecret,
    DEFAULTS.obsUrl,
    DEFAULTS.obsPassword,
    DEFAULTS.obsScenePrefix,
    DEFAULTS.discordClientId,
    DEFAULTS.discordBotToken,
    DEFAULTS.musicPollIntervalMs,
    DEFAULTS.musicPlayerctlPlayer,
    DEFAULTS.soundVolume,
    nowIso(),
  );
}

/**
 * quack_volume was never about quacks — it was the default volume for every sound
 * button. Carry the operator's tuned value across to the honestly-named column.
 *
 * runOnce, not an unconditional copy: re-running it on a later boot would undo a
 * volume the operator had since changed in Settings. The legacy column is left in
 * place rather than dropped, so a bad copy stays inspectable.
 */
function migrateQuackVolumeToSoundVolume() {
  runOnce('2026-07-sound-button-volume-from-quack-volume', () => {
    db.prepare('update app_config set sound_button_volume = quack_volume').run();
  });
}

migrateQuackVolumeToSoundVolume();

let cache: AppConfigInternal | null = null;

function loadRow(): AppConfigInternal {
  seedDefaultsIfMissing();
  const row = selectRow.get(APP_CONFIG_ID) as AppConfigRow;
  return {
    twitchChannel: row.twitchChannel,
    twitchClientId: row.twitchClientId,
    twitchClientSecret: row.twitchClientSecret,
    obsUrl: row.obsUrl,
    obsPassword: row.obsPassword,
    obsScenePrefix: row.obsScenePrefix,
    discordClientId: row.discordClientId,
    discordBotToken: row.discordBotToken,
    chatterboxBaseUrl: (row.chatterboxBaseUrl || DEFAULTS.chatterboxBaseUrl).replace(/\/+$/, ''),
    musicPollIntervalMs: row.musicPollIntervalMs,
    musicPlayerctlPlayer: row.musicPlayerctlPlayer,
    soundVolume: row.soundVolume,
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
  /**
   * The channel every service actually operates on: the stored override if the
   * operator typed one, otherwise the login they signed in with. Nobody runs a
   * dashboard for a channel they aren't logged into, so making them type their own
   * name was a required field that could only ever be wrong.
   *
   * `AppConfigInternal.twitchChannel` stays the *stored* value — Settings has to
   * render an empty field as empty, or saving the form would silently freeze the
   * derived login into an override.
   */
  get twitchChannel() { return current().twitchChannel || getAuthenticatedTwitchLogin(); },
  get twitchClientId() { return current().twitchClientId; },
  get twitchClientSecret() { return current().twitchClientSecret; },
  get obsUrl() { return current().obsUrl; },
  get obsPassword() { return current().obsPassword; },
  get obsScenePrefix() { return current().obsScenePrefix; },
  get discordClientId() { return current().discordClientId; },
  get discordBotToken() { return current().discordBotToken; },
  get chatterboxBaseUrl() { return current().chatterboxBaseUrl; },
  get musicPollIntervalMs() { return current().musicPollIntervalMs; },
  get musicPlayerctlPlayer() { return current().musicPlayerctlPlayer; },
  get soundVolume() { return current().soundVolume; },
};

export function getAppConfigInternal(): AppConfigInternal {
  return current();
}

function toPublic(internal: AppConfigInternal): AppConfig {
  return {
    // The stored override, not the resolved channel — see appConfig.twitchChannel.
    twitchChannel: internal.twitchChannel,
    twitchChannelFromLogin: getAuthenticatedTwitchLogin(),
    twitchClientId: internal.twitchClientId,
    twitchClientSecretConfigured: Boolean(internal.twitchClientSecret),
    obsUrl: internal.obsUrl,
    obsPasswordConfigured: Boolean(internal.obsPassword),
    obsScenePrefix: internal.obsScenePrefix,
    discordClientId: internal.discordClientId,
    discordBotTokenConfigured: Boolean(internal.discordBotToken),
    chatterboxBaseUrl: internal.chatterboxBaseUrl,
    musicPollIntervalMs: internal.musicPollIntervalMs,
    musicPlayerctlPlayer: internal.musicPlayerctlPlayer,
    soundVolume: internal.soundVolume,
    updatedAt: internal.updatedAt || null,
  };
}

export function getAppConfig(): AppConfig {
  return toPublic(current());
}

// Config keys whose change requires a service to reconnect/restart.
//
// `obsScenePrefix` is deliberately NOT part of `obs`: it changes nothing about the
// connection, only how the dashboard and tablet label and filter scene buttons.
// Folding it into `obs` would drop and re-establish a live OBS session mid-stream
// to apply a display change.
export type AppConfigChange =
  | 'twitchChannel'
  | 'twitchCredentials'
  | 'obs'
  | 'obsScenePrefix'
  | 'music'
  | 'discord';

// Non-secret fields fully resolved (absent-means-keep already applied) plus the
// secret directives that saveAppConfig feeds to resolveSecret.
type NormalizedConfigUpdate = Omit<
  AppConfigInternal,
  'updatedAt' | 'twitchClientSecret' | 'obsPassword' | 'discordBotToken'
> & {
  twitchClientSecret?: string;
  clearTwitchClientSecret: boolean;
  obsPassword?: string;
  clearObsPassword: boolean;
  discordBotToken?: string;
  clearDiscordBotToken: boolean;
};

function normalizeUpdate(body: unknown, prev: AppConfigInternal): NormalizedConfigUpdate {
  const value = (body ?? {}) as Partial<AppConfigUpdate>;
  const str = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');

  let twitchChannel = prev.twitchChannel;
  if (value.twitchChannel !== undefined) {
    twitchChannel = str(value.twitchChannel).toLowerCase();
    if (twitchChannel && !/^[a-z0-9_]{1,25}$/.test(twitchChannel)) {
      throw new HttpRouteError(400, 'Twitch channel must be 1-25 letters, numbers, or underscores.');
    }
  }

  let obsUrl = prev.obsUrl;
  if (value.obsUrl !== undefined) {
    obsUrl = str(value.obsUrl);
    if (obsUrl && !/^wss?:\/\//i.test(obsUrl)) {
      throw new HttpRouteError(400, 'OBS WebSocket URL must start with ws:// or wss://.');
    }
  }

  // Deliberately NOT trimmed: the default "Scene - " ends in a space, and that space
  // is load-bearing — it is what separates the convention from the scene's real name
  // when the label is stripped. An empty prefix means "no convention": every scene is
  // a switch target and keeps its full name.
  const obsScenePrefix = typeof value.obsScenePrefix === 'string'
    ? value.obsScenePrefix.slice(0, 60)
    : prev.obsScenePrefix;

  const musicPollIntervalMs = value.musicPollIntervalMs !== undefined
    ? Math.round(clampNumber(Number(value.musicPollIntervalMs ?? DEFAULTS.musicPollIntervalMs), 0, 60000))
    : prev.musicPollIntervalMs;
  const soundVolume = value.soundVolume !== undefined
    ? clampNumber(Number(value.soundVolume ?? DEFAULTS.soundVolume), 0, 1)
    : prev.soundVolume;

  const chatterboxBaseUrl = value.chatterboxBaseUrl !== undefined
    ? (str(value.chatterboxBaseUrl).replace(/\/+$/, '') || DEFAULTS.chatterboxBaseUrl)
    : prev.chatterboxBaseUrl;

  return {
    twitchChannel,
    twitchClientId: value.twitchClientId !== undefined ? str(value.twitchClientId) : prev.twitchClientId,
    twitchClientSecret: typeof value.twitchClientSecret === 'string' ? value.twitchClientSecret.trim() : undefined,
    clearTwitchClientSecret: value.clearTwitchClientSecret === true,
    obsUrl,
    obsPassword: typeof value.obsPassword === 'string' ? value.obsPassword : undefined,
    clearObsPassword: value.clearObsPassword === true,
    obsScenePrefix,
    discordClientId: value.discordClientId !== undefined ? str(value.discordClientId) : prev.discordClientId,
    discordBotToken: typeof value.discordBotToken === 'string' ? value.discordBotToken.trim() : undefined,
    clearDiscordBotToken: value.clearDiscordBotToken === true,
    chatterboxBaseUrl,
    musicPollIntervalMs,
    musicPlayerctlPlayer: value.musicPlayerctlPlayer !== undefined ? str(value.musicPlayerctlPlayer) : prev.musicPlayerctlPlayer,
    soundVolume,
  };
}

function resolveSecret(clear: boolean | undefined, next: string | undefined, existing: string): string {
  if (clear) return '';
  if (next !== undefined && next !== '') return next;
  return existing;
}

export function saveAppConfig(body: unknown): { config: AppConfig; changes: Set<AppConfigChange> } {
  const prev = current();
  const update = normalizeUpdate(body, prev);

  const next: AppConfigInternal = {
    twitchChannel: update.twitchChannel,
    twitchClientId: update.twitchClientId,
    twitchClientSecret: resolveSecret(update.clearTwitchClientSecret, update.twitchClientSecret, prev.twitchClientSecret),
    obsUrl: update.obsUrl,
    obsPassword: resolveSecret(update.clearObsPassword, update.obsPassword, prev.obsPassword),
    obsScenePrefix: update.obsScenePrefix,
    discordClientId: update.discordClientId,
    discordBotToken: resolveSecret(update.clearDiscordBotToken, update.discordBotToken, prev.discordBotToken),
    chatterboxBaseUrl: update.chatterboxBaseUrl,
    musicPollIntervalMs: update.musicPollIntervalMs,
    musicPlayerctlPlayer: update.musicPlayerctlPlayer,
    soundVolume: update.soundVolume,
    updatedAt: nowIso(),
  };

  updateRow.run(
    next.twitchChannel,
    next.twitchClientId,
    next.twitchClientSecret,
    next.obsUrl,
    next.obsPassword,
    next.obsScenePrefix,
    next.discordClientId,
    next.discordBotToken,
    next.chatterboxBaseUrl,
    next.musicPollIntervalMs,
    next.musicPlayerctlPlayer,
    next.soundVolume,
    next.updatedAt,
    APP_CONFIG_ID,
  );

  cache = next;

  const changes = new Set<AppConfigChange>();
  if (next.twitchChannel !== prev.twitchChannel) changes.add('twitchChannel');
  if (next.twitchClientId !== prev.twitchClientId || next.twitchClientSecret !== prev.twitchClientSecret) {
    changes.add('twitchCredentials');
  }
  if (next.obsUrl !== prev.obsUrl || next.obsPassword !== prev.obsPassword) {
    changes.add('obs');
  }
  if (next.obsScenePrefix !== prev.obsScenePrefix) {
    changes.add('obsScenePrefix');
  }
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
