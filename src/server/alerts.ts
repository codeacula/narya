import type {
  AlertConfig,
  AlertEventKind,
  AlertPlayback,
  AlertSettings,
  AlertSettingsUpdate,
  MediaKind,
  RewardMedia,
} from '../shared/api';
import { db } from './db';
import { HttpRouteError } from './http';
import { broadcast } from './realtime';
import { normalizeRewardMedia } from './rewardMedia';

/** `sub` covers new subs and resubs; the five keys mirror AlertEventKind. */
export const ALERT_KINDS: readonly AlertEventKind[] = ['sub', 'gift', 'cheer', 'raid', 'follow'];

const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60_000;
const DEFAULT_DURATION_MS = 6000;
const MAX_TEMPLATE_LENGTH = 300;

/**
 * Tone drives overlay styling and mirrors the tones emitStreamEvent uses in
 * eventsub.ts, so an alert reads the same colour as its dashboard event.
 */
const ALERT_TONES: Record<AlertEventKind, string> = {
  sub: 'warning',
  gift: 'warning',
  cheer: 'info',
  raid: 'note',
  follow: 'silver',
};

/** Shipped defaults; a kind with no saved row falls back to these (disabled). */
export const DEFAULT_ALERT_CONFIG: Record<AlertEventKind, AlertConfig> = {
  sub: { enabled: false, template: '{user} just subscribed! ({tier})', durationMs: DEFAULT_DURATION_MS, media: null },
  gift: { enabled: false, template: '{user} gifted {amount} subs!', durationMs: DEFAULT_DURATION_MS, media: null },
  cheer: { enabled: false, template: '{user} cheered {amount} bits!', durationMs: DEFAULT_DURATION_MS, media: null },
  raid: { enabled: false, template: '{user} raided with {amount} viewers!', durationMs: DEFAULT_DURATION_MS, media: null },
  follow: { enabled: false, template: '{user} just followed!', durationMs: DEFAULT_DURATION_MS, media: null },
};

/** Sample substitutions for the "Test" button so the operator can position the overlay. */
const SAMPLE_VARS: Record<AlertEventKind, Record<string, string | number>> = {
  sub: { user: 'TestViewer', tier: 'Tier 1', months: 3 },
  gift: { user: 'TestViewer', amount: 5 },
  cheer: { user: 'TestViewer', amount: 500 },
  raid: { user: 'TestViewer', amount: 42 },
  follow: { user: 'TestViewer' },
};

type AlertRow = {
  kind: AlertEventKind;
  enabled: number;
  template: string;
  durationMs: number;
  mediaKind: string | null;
  mediaSrc: string | null;
  mediaVolume: number | null;
  updatedAt: string;
};

const selectAllAlertRows = db.prepare(`
  select
    kind,
    enabled,
    template,
    duration_ms as durationMs,
    media_kind as mediaKind,
    media_src as mediaSrc,
    media_volume as mediaVolume,
    updated_at as updatedAt
  from alert_settings
`);

const upsertAlertRow = db.prepare(`
  insert into alert_settings (kind, enabled, template, duration_ms, media_kind, media_src, media_volume, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(kind) do update set
    enabled = excluded.enabled,
    template = excluded.template,
    duration_ms = excluded.duration_ms,
    media_kind = excluded.media_kind,
    media_src = excluded.media_src,
    media_volume = excluded.media_volume,
    updated_at = excluded.updated_at
`);

export function isAlertEventKind(value: unknown): value is AlertEventKind {
  return typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);
}

function rowMedia(row: AlertRow): RewardMedia | null {
  if (!row.mediaSrc) return null;
  const kind: MediaKind = row.mediaKind === 'video' ? 'video' : 'audio';
  return { kind, src: row.mediaSrc, volume: typeof row.mediaVolume === 'number' ? row.mediaVolume : 0.8 };
}

function rowToConfig(row: AlertRow): AlertConfig {
  return {
    enabled: row.enabled === 1,
    template: row.template || DEFAULT_ALERT_CONFIG[row.kind].template,
    durationMs: row.durationMs,
    media: rowMedia(row),
  };
}

export function getAlertSettings(): AlertSettings {
  const rows = selectAllAlertRows.all() as AlertRow[];
  const byKind = new Map(rows.map(row => [row.kind, row]));
  const settings = { updatedAt: null as string | null } as AlertSettings;
  let latest: string | null = null;
  for (const kind of ALERT_KINDS) {
    const row = byKind.get(kind);
    settings[kind] = row ? rowToConfig(row) : { ...DEFAULT_ALERT_CONFIG[kind] };
    if (row?.updatedAt && (!latest || row.updatedAt > latest)) latest = row.updatedAt;
  }
  settings.updatedAt = latest;
  return settings;
}

function validateTemplate(value: unknown): string {
  const template = typeof value === 'string' ? value.trim() : '';
  if (!template) throw new HttpRouteError(400, 'Alert template cannot be empty.');
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new HttpRouteError(400, `Alert template must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`);
  }
  return template;
}

function clampDuration(value: unknown): number {
  const durationMs = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DURATION_MS;
  return Math.round(Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, durationMs)));
}

export function saveAlertSettings(update: AlertSettingsUpdate): AlertSettings {
  const current = getAlertSettings();
  const now = new Date().toISOString();
  for (const kind of ALERT_KINDS) {
    const patch = update[kind];
    if (!patch) continue;
    const prev = current[kind];
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : prev.enabled;
    const template = patch.template !== undefined ? validateTemplate(patch.template) : prev.template;
    const durationMs = patch.durationMs !== undefined ? clampDuration(patch.durationMs) : prev.durationMs;
    // media absent → keep; null → clear; object → validate against the served catalog,
    // allowing the current binding through even if its file was deleted (keepMissing).
    const media = patch.media === undefined
      ? prev.media
      : patch.media === null
        ? null
        : normalizeRewardMedia(patch.media, { keepMissing: prev.media });
    upsertAlertRow.run(
      kind,
      enabled ? 1 : 0,
      template,
      durationMs,
      media?.kind ?? null,
      media?.src ?? null,
      media?.volume ?? null,
      now,
    );
  }
  return getAlertSettings();
}

/** Substitute {token}s present in `vars`; unknown tokens are left intact for visibility. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function broadcastAlert(kind: AlertEventKind, config: AlertConfig, vars: Record<string, string | number>): void {
  const payload: AlertPlayback = {
    id: crypto.randomUUID(),
    kind,
    text: renderTemplate(config.template, vars),
    tone: ALERT_TONES[kind],
    media: config.media,
    durationMs: config.durationMs,
  };
  broadcast('alert:show', payload);
}

/** Fire an alert for a live Twitch event, honouring the per-kind enabled toggle. */
export function fireAlert(kind: AlertEventKind, vars: Record<string, string | number>): void {
  const config = getAlertSettings()[kind];
  if (!config.enabled) return;
  broadcastAlert(kind, config, vars);
}

/** Fire a sample alert regardless of the enabled toggle (Settings preview). */
export function testAlert(kind: AlertEventKind): void {
  broadcastAlert(kind, getAlertSettings()[kind], SAMPLE_VARS[kind]);
}
