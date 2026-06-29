import type { TtsSettings, TtsSettingsUpdate, TtsVoice } from '../shared/api';
import { appConfig } from './appConfig';
import { db } from './db';
import { broadcast } from './realtime';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

const getTtsSettingsRow = db.prepare(`
  select enabled, voice_id, speed, volume, updated_at from tts_settings where id = 1
`);

const upsertTtsSettings = db.prepare(`
  insert into tts_settings (id, enabled, voice_id, speed, volume, updated_at)
  values (1, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    enabled = excluded.enabled,
    voice_id = excluded.voice_id,
    speed = excluded.speed,
    volume = excluded.volume,
    updated_at = excluded.updated_at
`);

const isTtsRewardEnabledRow = db.prepare(`select 1 from tts_reward_enabled where reward_id = ?`);
const insertTtsRewardEnabled = db.prepare(`insert or ignore into tts_reward_enabled (reward_id) values (?)`);
const deleteTtsRewardEnabled = db.prepare(`delete from tts_reward_enabled where reward_id = ?`);
const listTtsRewardEnabled = db.prepare(`select reward_id from tts_reward_enabled`);

function rowToTtsSettings(row: { enabled: number; voice_id: string; speed: number; volume: number; updated_at: string }): TtsSettings {
  return {
    enabled: row.enabled === 1,
    voiceId: row.voice_id || DEFAULT_VOICE_ID,
    speed: row.speed,
    volume: row.volume,
    updatedAt: row.updated_at || null,
  };
}

export function getTtsSettings(): TtsSettings {
  const row = getTtsSettingsRow.get() as { enabled: number; voice_id: string; speed: number; volume: number; updated_at: string } | null;
  if (!row) {
    return { enabled: false, voiceId: DEFAULT_VOICE_ID, speed: 1.0, volume: 0.8, updatedAt: null };
  }
  return rowToTtsSettings(row);
}

export function updateTtsSettings(update: TtsSettingsUpdate): TtsSettings {
  const updatedAt = new Date().toISOString();
  const speed = Math.max(0.7, Math.min(1.2, update.speed));
  const volume = Math.max(0, Math.min(1, update.volume));
  const voiceId = update.voiceId.trim() || DEFAULT_VOICE_ID;
  upsertTtsSettings.run(update.enabled ? 1 : 0, voiceId, speed, volume, updatedAt);
  return getTtsSettings();
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

export async function fetchElevenLabsVoices(): Promise<TtsVoice[]> {
  const apiKey = appConfig.elevenLabsApiKey;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not configured.');

  const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices API error: ${res.status}`);

  const data = await res.json() as { voices: Array<{ voice_id: string; name: string; category: string }> };
  return data.voices.map(v => ({ id: v.voice_id, name: v.name, category: v.category ?? 'premade' }));
}

async function synthesizeSpeech(text: string, settings: TtsSettings): Promise<Buffer> {
  const apiKey = appConfig.elevenLabsApiKey;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not configured.');

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(settings.voiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: settings.speed,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function speakText(text: string): Promise<void> {
  const settings = getTtsSettings();
  if (!settings.enabled) return;
  if (!text.trim()) return;

  const sanitized = text.trim().slice(0, 500);
  const audioBuffer = await synthesizeSpeech(sanitized, settings);
  const audioBase64 = audioBuffer.toString('base64');
  broadcast('tts:speak', { audioBase64 });
}
