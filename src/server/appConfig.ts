import type express from 'express';
import type { AppConfig, AppConfigUpdate } from '../shared/api';
import { db, runOnce } from './db';
import { handle, HttpRouteError } from './http';
import { clampFinite } from './numeric';

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
  tengwarBaseUrl: 'http://127.0.0.1:8008',
  tengwarApiKey: '',
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
  tengwarBaseUrl: string;
  tengwarApiKey: string;
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
  tengwarBaseUrl: string;
  tengwarApiKey: string;
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
    tengwar_base_url as tengwarBaseUrl,
    tengwar_api_key as tengwarApiKey,
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
    tengwar_base_url = ?,
    tengwar_api_key = ?,
    music_poll_interval_ms = ?,
    music_playerctl_player = ?,
    sound_button_volume = ?,
    updated_at = ?
  where id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
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

/**
 * Speech moved from Chatterbox to Tengwar. The address is the same shape — one full
 * base URL with the port in it — so the operator's tuned value carries straight
 * across instead of making them retype it after an upgrade.
 *
 * The old column is dropped in the same transaction: keeping a second address around
 * that nothing reads is how a support question becomes "which one is live?". Guarded
 * on the column actually existing, because a fresh install never had it.
 */
function migrateChatterboxUrlToTengwar() {
  runOnce('2026-07-tengwar-base-url-from-chatterbox', () => {
    const columns = db.prepare('pragma table_info(app_config)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'chatterbox_base_url')) return;
    db.prepare("update app_config set tengwar_base_url = chatterbox_base_url where trim(coalesce(chatterbox_base_url, '')) <> ''").run();
    db.exec('alter table app_config drop column chatterbox_base_url');
  });
}

migrateChatterboxUrlToTengwar();

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
    tengwarBaseUrl: (row.tengwarBaseUrl || DEFAULTS.tengwarBaseUrl).replace(/\/+$/, ''),
    tengwarApiKey: row.tengwarApiKey || '',
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
//
// The resolved Twitch channel is deliberately absent: it depends on the signed-in
// login, and this store sits underneath the Twitch modules. `getTwitchChannel()` in
// the Twitch identity module is the one that resolves it.
export const appConfig = {
  get twitchClientId() { return current().twitchClientId; },
  get twitchClientSecret() { return current().twitchClientSecret; },
  get obsUrl() { return current().obsUrl; },
  get obsPassword() { return current().obsPassword; },
  get obsScenePrefix() { return current().obsScenePrefix; },
  get discordClientId() { return current().discordClientId; },
  get discordBotToken() { return current().discordBotToken; },
  get tengwarBaseUrl() { return current().tengwarBaseUrl; },
  get tengwarApiKey() { return current().tengwarApiKey; },
  get musicPollIntervalMs() { return current().musicPollIntervalMs; },
  get musicPlayerctlPlayer() { return current().musicPlayerctlPlayer; },
  get soundVolume() { return current().soundVolume; },
};

export function getAppConfigInternal(): AppConfigInternal {
  return current();
}

function toPublic(internal: AppConfigInternal, twitchChannelFromLogin: string): AppConfig {
  return {
    // The stored override, not the resolved channel — Settings has to render an empty
    // field as empty, or saving the form would freeze the derived login into an
    // override.
    twitchChannel: internal.twitchChannel,
    twitchChannelFromLogin,
    twitchClientId: internal.twitchClientId,
    twitchClientSecretConfigured: Boolean(internal.twitchClientSecret),
    obsUrl: internal.obsUrl,
    obsPasswordConfigured: Boolean(internal.obsPassword),
    obsScenePrefix: internal.obsScenePrefix,
    discordClientId: internal.discordClientId,
    discordBotTokenConfigured: Boolean(internal.discordBotToken),
    tengwarBaseUrl: internal.tengwarBaseUrl,
    tengwarApiKeyConfigured: Boolean(internal.tengwarApiKey),
    musicPollIntervalMs: internal.musicPollIntervalMs,
    musicPlayerctlPlayer: internal.musicPlayerctlPlayer,
    soundVolume: internal.soundVolume,
    updatedAt: internal.updatedAt || null,
  };
}

// The signed-in login is passed in rather than resolved here: it belongs to the
// Twitch identity module, which sits above this store.
export function getAppConfig(twitchChannelFromLogin = ''): AppConfig {
  return toPublic(current(), twitchChannelFromLogin);
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
  'updatedAt' | 'twitchClientSecret' | 'obsPassword' | 'discordBotToken' | 'tengwarApiKey'
> & {
  twitchClientSecret?: string;
  clearTwitchClientSecret: boolean;
  obsPassword?: string;
  clearObsPassword: boolean;
  discordBotToken?: string;
  clearDiscordBotToken: boolean;
  tengwarApiKey?: string;
  clearTengwarApiKey: boolean;
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
    ? Math.round(clampFinite(Number(value.musicPollIntervalMs ?? DEFAULTS.musicPollIntervalMs), 0, 60000, 0))
    : prev.musicPollIntervalMs;
  const soundVolume = value.soundVolume !== undefined
    ? clampFinite(Number(value.soundVolume ?? DEFAULTS.soundVolume), 0, 1, 0)
    : prev.soundVolume;

  // A typo here is otherwise invisible until a viewer redeems TTS and the fetch
  // fails with something unhelpful, so reject a non-http(s) URL at save time the way
  // the LLM base URL does.
  let tengwarBaseUrl = prev.tengwarBaseUrl;
  if (value.tengwarBaseUrl !== undefined) {
    tengwarBaseUrl = str(value.tengwarBaseUrl).replace(/\/+$/, '') || DEFAULTS.tengwarBaseUrl;
    let parsed: URL;
    try {
      parsed = new URL(tengwarBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      throw new HttpRouteError(400, 'Tengwar URL must be a valid http(s) URL including the port.');
    }
    // Endpoints are appended verbatim (`${baseUrl}/health`), so a stored path, query
    // or fragment silently corrupts every call — http://host:8008/api would probe
    // http://host:8008/api/health. Rejected here rather than debugged later. Checked
    // outside the try so this reports the actual problem instead of "not a valid URL".
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw new HttpRouteError(400, 'Tengwar URL must be a bare host and port, with no path, query or fragment.');
    }
  }

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
    tengwarBaseUrl,
    tengwarApiKey: typeof value.tengwarApiKey === 'string' ? value.tengwarApiKey.trim() : undefined,
    clearTengwarApiKey: value.clearTengwarApiKey === true,
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

export function saveAppConfig(
  body: unknown,
  twitchChannelFromLogin = '',
): { config: AppConfig; changes: Set<AppConfigChange> } {
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
    tengwarBaseUrl: update.tengwarBaseUrl,
    tengwarApiKey: resolveSecret(update.clearTengwarApiKey, update.tengwarApiKey, prev.tengwarApiKey),
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
    next.tengwarBaseUrl,
    next.tengwarApiKey,
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

  return { config: toPublic(next, twitchChannelFromLogin), changes };
}

export function registerAppConfigRoutes(
  app: express.Express,
  onSaved: (result: { config: AppConfig; changes: Set<AppConfigChange> }) => void,
  twitchChannelFromLogin: () => string,
) {
  reloadAppConfig();

  app.get('/api/config', (_request, response) => {
    response.json(getAppConfig(twitchChannelFromLogin()));
  });

  app.put('/api/config', handle((request, response) => {
    const result = saveAppConfig(request.body, twitchChannelFromLogin());
    onSaved(result);
    response.json(result.config);
  }));
}
