import type { TtsSettings, TtsSettingsUpdate, TtsVoice } from '../shared/api';
import { appConfig } from './appConfig';
import { db, runOnce } from './db';
import { HttpRouteError, readResponseError } from './http';
import { clampFinite } from './numeric';
import { broadcast } from './realtime';

/**
 * A Tengwar speaker id. The service ships a fixed set (usMale/usFemale/ukMale/
 * ukFemale) and 400s on anything else, so the fallback has to be one of them —
 * 'zombiechicken', the Chatterbox-era default, would fail every synthesis.
 */
const DEFAULT_VOICE_PROFILE_ID = 'usFemale';
const DEFAULT_LANGUAGE_ID = 'en';
const MAX_TEXT_LENGTH = 500;

/** Reachability and voice-list calls sit on the operator's path through Settings. */
const PROBE_TIMEOUT_MS = 4000;
/** Synthesis runs a model; a cold GPU load is slow but not broken. */
const SYNTHESIZE_TIMEOUT_MS = 30000;

/**
 * Tengwar has no per-request tuning knobs, so the Chatterbox-era tone_preset,
 * exaggeration, cfg_weight and temperature columns describe nothing the engine can
 * act on. Dropped rather than left behind, so the table matches TtsSettings exactly.
 *
 * Runs before the prepared statements below so they never compile against a shape
 * that is about to change.
 */
runOnce('2026-07-drop-chatterbox-tts-tuning-columns', () => {
  const columns = new Set(
    (db.prepare('pragma table_info(tts_settings)').all() as Array<{ name: string }>).map(column => column.name),
  );
  for (const column of ['tone_preset', 'exaggeration', 'cfg_weight', 'temperature']) {
    if (columns.has(column)) db.exec(`alter table tts_settings drop column ${column}`);
  }
});

const getTtsSettingsRow = db.prepare(`
  select
    enabled,
    voice_profile_id as voiceProfileId,
    language_id as languageId,
    volume,
    updated_at as updatedAt
  from tts_settings
  where id = 1
`);

const upsertTtsSettings = db.prepare(`
  insert into tts_settings (
    id, enabled, voice_profile_id, language_id, volume, updated_at
  )
  values (1, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    enabled = excluded.enabled,
    voice_profile_id = excluded.voice_profile_id,
    language_id = excluded.language_id,
    volume = excluded.volume,
    updated_at = excluded.updated_at
`);

type TtsSettingsRow = {
  enabled: number;
  voiceProfileId: string;
  languageId: string;
  volume: number;
  updatedAt: string;
};

export type TtsEngineStatus = {
  ok: boolean;
  baseUrl: string;
  /** True when TTS is switched off — the service was deliberately not contacted. */
  disabled?: boolean;
  error?: string;
};

function sanitizeLanguageId(value: string): string {
  const languageId = value.trim().toLowerCase() || DEFAULT_LANGUAGE_ID;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(languageId)) {
    throw new HttpRouteError(400, 'languageId must be a valid language tag.');
  }
  return languageId;
}

/**
 * Rows written before the move to Tengwar hold Chatterbox voice ids that Tengwar
 * rejects. Remapped on read rather than rewritten in a migration, so a settings row
 * the operator never revisits still speaks instead of 400ing.
 */
function resolveVoiceProfileId(stored: string): string {
  if (!stored || stored === 'default' || stored === 'zombiechicken') return DEFAULT_VOICE_PROFILE_ID;
  return stored;
}

function rowToTtsSettings(row: TtsSettingsRow): TtsSettings {
  return {
    enabled: row.enabled === 1,
    voiceProfileId: resolveVoiceProfileId(row.voiceProfileId),
    languageId: row.languageId || DEFAULT_LANGUAGE_ID,
    volume: row.volume,
    updatedAt: row.updatedAt || null,
  };
}

function defaultTtsSettings(): TtsSettings {
  return {
    enabled: false,
    voiceProfileId: DEFAULT_VOICE_PROFILE_ID,
    languageId: DEFAULT_LANGUAGE_ID,
    volume: 0.8,
    updatedAt: null,
  };
}

/**
 * Tengwar authenticates with X-Api-Key, and only when a key is configured on its
 * side — an unkeyed instance accepts requests without the header, so sending an
 * empty one would be worse than sending none.
 */
function tengwarHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const apiKey = appConfig.tengwarApiKey;
  if (apiKey) headers['X-Api-Key'] = apiKey;
  return headers;
}

/**
 * Every call is bounded. Without a timeout an unreachable-but-not-refusing address
 * (a Tailscale peer that went to sleep, say) hangs the Settings page or a redemption
 * indefinitely instead of reporting that the service is down.
 */
async function tengwarFetch(pathname: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const response = await fetch(`${appConfig.tengwarBaseUrl}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const message = await readResponseError(response, `Tengwar service error: ${response.status}`);
    throw new Error(message);
  }
  return response;
}

export function getTtsSettings(): TtsSettings {
  const row = getTtsSettingsRow.get() as TtsSettingsRow | null;
  return row ? rowToTtsSettings(row) : defaultTtsSettings();
}

/**
 * The reachability probe. /health is the one endpoint Tengwar leaves unauthenticated,
 * which makes it the honest answer to "is the service up?" — probing /voices instead
 * would report a misconfigured API key as an unreachable service.
 */
export async function getTtsEngineStatus(): Promise<TtsEngineStatus> {
  // Switched off means switched off: no probe, no connection, nothing in Tengwar's
  // log. An operator who disabled TTS should not leave narya quietly polling it.
  if (!getTtsSettings().enabled) {
    return { ok: false, disabled: true, baseUrl: appConfig.tengwarBaseUrl };
  }
  try {
    const response = await fetch(`${appConfig.tengwarBaseUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, baseUrl: appConfig.tengwarBaseUrl, error: `${response.status} ${response.statusText}` };
    }
    return { ok: true, baseUrl: appConfig.tengwarBaseUrl };
  } catch (error) {
    return { ok: false, baseUrl: appConfig.tengwarBaseUrl, error: error instanceof Error ? error.message : 'Unavailable' };
  }
}

export function updateTtsSettings(update: TtsSettingsUpdate): TtsSettings {
  const updatedAt = new Date().toISOString();
  const voiceProfileId = resolveVoiceProfileId(update.voiceProfileId.trim());
  const languageId = sanitizeLanguageId(update.languageId);
  const volume = clampFinite(Number(update.volume), 0, 1, 0.8);
  upsertTtsSettings.run(
    update.enabled ? 1 : 0,
    voiceProfileId,
    languageId,
    volume,
    updatedAt,
  );
  return getTtsSettings();
}

/**
 * Tengwar's speaker list. Its shape is {voices:[{id,name}]}; the remaining TtsVoice
 * fields are narya's own, and Tengwar has nothing to say about them, so they carry
 * neutral values rather than invented ones.
 */
export async function getTtsVoices(): Promise<TtsVoice[]> {
  if (!getTtsSettings().enabled) return [];
  const response = await tengwarFetch('/voices', { headers: tengwarHeaders() }, PROBE_TIMEOUT_MS);
  const body = await response.json() as { voices?: unknown };
  if (!Array.isArray(body.voices)) throw new Error('Tengwar returned an invalid voices response.');
  return body.voices.map(voice => {
    const entry = (voice ?? {}) as { id?: unknown; name?: unknown };
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new Error('Tengwar returned an invalid voices response.');
    }
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      category: 'tengwar',
      languageId: DEFAULT_LANGUAGE_ID,
      createdAt: null,
    };
  });
}

async function synthesizeSpeech(text: string, settings: TtsSettings): Promise<Buffer> {
  const response = await tengwarFetch(
    '/synthesize',
    {
      method: 'POST',
      headers: tengwarHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        text,
        speakerId: settings.voiceProfileId || DEFAULT_VOICE_PROFILE_ID,
      }),
    },
    SYNTHESIZE_TIMEOUT_MS,
  );
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * No `force` escape hatch: the Test button used to pass one, which meant a disabled
 * module still opened a connection to the speech service. Disabled now means every
 * caller stops here.
 */
export async function speakText(text: string): Promise<void> {
  const settings = getTtsSettings();
  if (!settings.enabled) return;
  if (!text.trim()) return;

  const sanitized = text.trim().slice(0, MAX_TEXT_LENGTH);
  const audioBuffer = await synthesizeSpeech(sanitized, settings);
  const audioBase64 = audioBuffer.toString('base64');
  broadcast('tts:speak', { audioBase64, mimeType: 'audio/wav', volume: settings.volume });
}
