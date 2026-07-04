import type { TtsSettings, TtsSettingsUpdate, TtsVoice } from '../shared/api';
import { appConfig } from './appConfig';
import { db } from './db';
import { HttpRouteError, readResponseError } from './http';
import { broadcast } from './realtime';

const DEFAULT_VOICE_PROFILE_ID = 'zombiechicken';
const DEFAULT_LANGUAGE_ID = 'en';
const MAX_TEXT_LENGTH = 500;

const tonePresets: Record<string, Pick<TtsSettings, 'exaggeration' | 'cfgWeight' | 'temperature'>> = {
  neutral: { exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
  calm: { exaggeration: 0.35, cfgWeight: 0.65, temperature: 0.7 },
  expressive: { exaggeration: 0.7, cfgWeight: 0.35, temperature: 0.85 },
  dramatic: { exaggeration: 0.9, cfgWeight: 0.3, temperature: 0.95 },
};

const getTtsSettingsRow = db.prepare(`
  select
    enabled,
    voice_profile_id as voiceProfileId,
    language_id as languageId,
    tone_preset as tonePreset,
    exaggeration,
    cfg_weight as cfgWeight,
    temperature,
    volume,
    updated_at as updatedAt
  from tts_settings
  where id = 1
`);

const upsertTtsSettings = db.prepare(`
  insert into tts_settings (
    id, enabled, voice_profile_id, language_id, tone_preset, exaggeration, cfg_weight, temperature, volume, updated_at
  )
  values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    enabled = excluded.enabled,
    voice_profile_id = excluded.voice_profile_id,
    language_id = excluded.language_id,
    tone_preset = excluded.tone_preset,
    exaggeration = excluded.exaggeration,
    cfg_weight = excluded.cfg_weight,
    temperature = excluded.temperature,
    volume = excluded.volume,
    updated_at = excluded.updated_at
`);

const isTtsRewardEnabledRow = db.prepare('select 1 from tts_reward_enabled where reward_id = ?');
const insertTtsRewardEnabled = db.prepare('insert or ignore into tts_reward_enabled (reward_id) values (?)');
const deleteTtsRewardEnabled = db.prepare('delete from tts_reward_enabled where reward_id = ?');
const listTtsRewardEnabled = db.prepare('select reward_id from tts_reward_enabled');

type TtsSettingsRow = {
  enabled: number;
  voiceProfileId: string;
  languageId: string;
  tonePreset: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  volume: number;
  updatedAt: string;
};

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sanitizeLanguageId(value: string): string {
  const languageId = value.trim().toLowerCase() || DEFAULT_LANGUAGE_ID;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(languageId)) {
    throw new HttpRouteError(400, 'languageId must be a valid language tag.');
  }
  return languageId;
}

function rowToTtsSettings(row: TtsSettingsRow): TtsSettings {
  const preset = tonePresets[row.tonePreset] ? row.tonePreset : 'neutral';
  return {
    enabled: row.enabled === 1,
    voiceProfileId: !row.voiceProfileId || row.voiceProfileId === 'default' ? DEFAULT_VOICE_PROFILE_ID : row.voiceProfileId,
    languageId: row.languageId || DEFAULT_LANGUAGE_ID,
    tonePreset: preset,
    exaggeration: row.exaggeration,
    cfgWeight: row.cfgWeight,
    temperature: row.temperature,
    volume: row.volume,
    updatedAt: row.updatedAt || null,
  };
}

function defaultTtsSettings(): TtsSettings {
  return {
    enabled: false,
    voiceProfileId: DEFAULT_VOICE_PROFILE_ID,
    languageId: DEFAULT_LANGUAGE_ID,
    tonePreset: 'neutral',
    exaggeration: 0.5,
    cfgWeight: 0.5,
    temperature: 0.8,
    volume: 0.8,
    updatedAt: null,
  };
}

async function postChatterbox(pathname: string, body: unknown): Promise<Response> {
  const response = await fetch(`${appConfig.chatterboxBaseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await readResponseError(response, `Chatterbox service error: ${response.status}`);
    throw new Error(message);
  }
  return response;
}

export async function getTtsEngineStatus(): Promise<{ ok: boolean; baseUrl: string; error?: string }> {
  try {
    const response = await fetch(`${appConfig.chatterboxBaseUrl}/voices`);
    if (!response.ok) {
      return { ok: false, baseUrl: appConfig.chatterboxBaseUrl, error: `${response.status} ${response.statusText}` };
    }
    return { ok: true, baseUrl: appConfig.chatterboxBaseUrl };
  } catch (error) {
    return { ok: false, baseUrl: appConfig.chatterboxBaseUrl, error: error instanceof Error ? error.message : 'Unavailable' };
  }
}

export function getTtsSettings(): TtsSettings {
  const row = getTtsSettingsRow.get() as TtsSettingsRow | null;
  return row ? rowToTtsSettings(row) : defaultTtsSettings();
}

export function updateTtsSettings(update: TtsSettingsUpdate): TtsSettings {
  const updatedAt = new Date().toISOString();
  const preset = tonePresets[update.tonePreset] ? update.tonePreset : 'neutral';
  const presetValues = tonePresets[preset];
  const voiceProfileId = update.voiceProfileId.trim() || DEFAULT_VOICE_PROFILE_ID;
  const languageId = sanitizeLanguageId(update.languageId);
  const exaggeration = clampNumber(Number(update.exaggeration), 0, 1.2, presetValues.exaggeration);
  const cfgWeight = clampNumber(Number(update.cfgWeight), 0, 1, presetValues.cfgWeight);
  const temperature = clampNumber(Number(update.temperature), 0.05, 1.5, presetValues.temperature);
  const volume = clampNumber(Number(update.volume), 0, 1, 0.8);
  upsertTtsSettings.run(
    update.enabled ? 1 : 0,
    voiceProfileId,
    languageId,
    preset,
    exaggeration,
    cfgWeight,
    temperature,
    volume,
    updatedAt,
  );
  return getTtsSettings();
}

export async function getTtsVoices(): Promise<TtsVoice[]> {
  const response = await fetch(`${appConfig.chatterboxBaseUrl}/voices`);
  if (!response.ok) {
    const message = await readResponseError(response, `Chatterbox service error: ${response.status}`);
    throw new Error(message);
  }
  const body = await response.json() as { voices?: unknown };
  if (!Array.isArray(body.voices) || !body.voices.every(voice => typeof voice === 'string')) {
    throw new Error('Chatterbox returned an invalid voices response.');
  }
  return body.voices.map(id => ({
    id,
    name: id,
    category: 'registered',
    languageId: DEFAULT_LANGUAGE_ID,
    createdAt: null,
  }));
}

export function isTtsRewardEnabled(rewardId: string): boolean {
  return Boolean(isTtsRewardEnabledRow.get(rewardId));
}

export function setTtsRewardEnabled(rewardId: string, enabled: boolean): void {
  if (enabled) {
    insertTtsRewardEnabled.run(rewardId);
  } else {
    deleteTtsRewardEnabled.run(rewardId);
  }
}

export function getTtsEnabledRewardIds(): string[] {
  const rows = listTtsRewardEnabled.all() as Array<{ reward_id: string }>;
  return rows.map(r => r.reward_id);
}

async function synthesizeSpeech(text: string, settings: TtsSettings): Promise<Buffer> {
  const response = await postChatterbox('/synthesize', {
    text,
    voiceId: settings.voiceProfileId || DEFAULT_VOICE_PROFILE_ID,
    exaggeration: settings.exaggeration,
    cfgWeight: settings.cfgWeight,
    temperature: settings.temperature,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function speakText(text: string, force = false): Promise<void> {
  const settings = getTtsSettings();
  if (!force && !settings.enabled) return;
  if (!text.trim()) return;

  const sanitized = text.trim().slice(0, MAX_TEXT_LENGTH);
  const audioBuffer = await synthesizeSpeech(sanitized, settings);
  const audioBase64 = audioBuffer.toString('base64');
  broadcast('tts:speak', { audioBase64, mimeType: 'audio/wav', volume: settings.volume });
}
