import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TtsSettings, TtsSettingsUpdate, TtsVoice } from '../shared/api';
import { config } from './config';
import { db } from './db';
import { HttpRouteError, readResponseError } from './http';
import { broadcast } from './realtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', '..', 'data');
const voiceDir = path.join(dataDir, 'tts', 'voices');

const DEFAULT_VOICE_PROFILE_ID = 'default';
const DEFAULT_LANGUAGE_ID = 'en';
const DEFAULT_MODEL = 'multilingual-v3';
const MAX_TEXT_LENGTH = 500;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;

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

const listVoiceRows = db.prepare(`
  select id, name, reference_path as referencePath, model, language_id as languageId, created_at as createdAt, updated_at as updatedAt
  from tts_voice_profiles
  order by name collate nocase
`);
const getVoiceRow = db.prepare(`
  select id, name, reference_path as referencePath, model, language_id as languageId, created_at as createdAt, updated_at as updatedAt
  from tts_voice_profiles
  where id = ?
`);
const insertVoiceRow = db.prepare(`
  insert into tts_voice_profiles (id, name, reference_path, model, language_id, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?)
`);
const deleteVoiceRow = db.prepare('delete from tts_voice_profiles where id = ?');

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

type VoiceRow = {
  id: string;
  name: string;
  referencePath: string;
  model: string;
  languageId: string;
  createdAt: string;
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

function sanitizeVoiceName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpRouteError(400, 'Voice name is required.');
  if (name.length > 80) throw new HttpRouteError(400, 'Voice name must be 80 characters or fewer.');
  return name;
}

function rowToTtsSettings(row: TtsSettingsRow): TtsSettings {
  const preset = tonePresets[row.tonePreset] ? row.tonePreset : 'neutral';
  return {
    enabled: row.enabled === 1,
    voiceProfileId: row.voiceProfileId || DEFAULT_VOICE_PROFILE_ID,
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

function rowToVoice(row: VoiceRow): TtsVoice {
  return {
    id: row.id,
    name: row.name,
    category: 'local',
    languageId: row.languageId,
    createdAt: row.createdAt || null,
  };
}

function getVoiceProfile(id: string): VoiceRow | null {
  if (!id || id === DEFAULT_VOICE_PROFILE_ID) return null;
  return getVoiceRow.get(id) as VoiceRow | null;
}

async function postChatterbox(pathname: string, body: unknown): Promise<Response> {
  const response = await fetch(`${config.chatterboxBaseUrl}${pathname}`, {
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
    const response = await fetch(`${config.chatterboxBaseUrl}/health`);
    if (!response.ok) {
      return { ok: false, baseUrl: config.chatterboxBaseUrl, error: `${response.status} ${response.statusText}` };
    }
    return { ok: true, baseUrl: config.chatterboxBaseUrl };
  } catch (error) {
    return { ok: false, baseUrl: config.chatterboxBaseUrl, error: error instanceof Error ? error.message : 'Unavailable' };
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
  if (voiceProfileId !== DEFAULT_VOICE_PROFILE_ID && !getVoiceProfile(voiceProfileId)) {
    throw new HttpRouteError(400, 'Voice profile not found.');
  }
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

export function getTtsVoices(): TtsVoice[] {
  const rows = listVoiceRows.all() as VoiceRow[];
  return [
    { id: DEFAULT_VOICE_PROFILE_ID, name: 'Chatterbox default', category: 'built-in', languageId: DEFAULT_LANGUAGE_ID, createdAt: null },
    ...rows.map(rowToVoice),
  ];
}

export async function createTtsVoiceProfile(nameInput: string, languageInput: string, audio: Buffer): Promise<TtsVoice> {
  const name = sanitizeVoiceName(nameInput);
  const languageId = sanitizeLanguageId(languageInput);
  if (audio.byteLength === 0) throw new HttpRouteError(400, 'Voice reference audio is required.');
  if (audio.byteLength > MAX_VOICE_BYTES) throw new HttpRouteError(400, 'Voice reference audio must be 25 MB or smaller.');

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const profileDir = path.join(voiceDir, id);
  const referencePath = path.join(profileDir, 'reference.wav');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(referencePath, audio);

  try {
    await postChatterbox('/prepare-voice', {
      voiceId: id,
      referencePath,
      referenceAudioBase64: audio.toString('base64'),
      model: DEFAULT_MODEL,
      languageId,
    });
  } catch (error) {
    try {
      unlinkSync(referencePath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }

  insertVoiceRow.run(id, name, referencePath, DEFAULT_MODEL, languageId, createdAt, createdAt);
  const row = getVoiceRow.get(id) as VoiceRow;
  return rowToVoice(row);
}

export function deleteTtsVoiceProfile(id: string): void {
  if (!id || id === DEFAULT_VOICE_PROFILE_ID) throw new HttpRouteError(400, 'The default voice cannot be deleted.');
  const row = getVoiceProfile(id);
  if (!row) throw new HttpRouteError(404, 'Voice profile not found.');
  deleteVoiceRow.run(id);
  try {
    unlinkSync(row.referencePath);
  } catch {
    // Missing files should not leave the profile stuck in the database.
  }
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
  const voice = getVoiceProfile(settings.voiceProfileId);
  const response = await postChatterbox('/synthesize', {
    text,
    voiceId: voice?.id ?? DEFAULT_VOICE_PROFILE_ID,
    referencePath: voice?.referencePath ?? null,
    referenceAudioBase64: voice ? readFileSync(voice.referencePath).toString('base64') : null,
    model: voice?.model ?? DEFAULT_MODEL,
    languageId: settings.languageId || voice?.languageId || DEFAULT_LANGUAGE_ID,
    exaggeration: settings.exaggeration,
    cfgWeight: settings.cfgWeight,
    temperature: settings.temperature,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function speakText(text: string): Promise<void> {
  const settings = getTtsSettings();
  if (!settings.enabled) return;
  if (!text.trim()) return;

  const sanitized = text.trim().slice(0, MAX_TEXT_LENGTH);
  const audioBuffer = await synthesizeSpeech(sanitized, settings);
  const audioBase64 = audioBuffer.toString('base64');
  broadcast('tts:speak', { audioBase64, mimeType: 'audio/wav', volume: settings.volume });
}
