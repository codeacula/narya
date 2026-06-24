import type express from 'express';
import type { ChatMessage, LlmSettings, LlmSettingsUpdate } from '../shared/api';
import { db } from './db';
import { HttpRouteError, sendRouteError } from './http';

const LLM_SETTINGS_ID = 'default';
const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_PERSONALITY_PROMPT = [
  'You are a tiny, theatrical stream-side know-it-all who answers Twitch chat questions.',
  'Be silly, lightly snarky, and concise, but never cruel.',
  'Answer in one short chat-friendly message.',
  'Do not include an @mention; the app adds that for you.',
].join(' ');

type LlmSettingsRow = {
  id: string;
  enabled: number;
  baseUrl: string;
  model: string;
  apiKey: string;
  personalityPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedAt: string;
};

type ResponsesApiResponse = {
  output_text?: unknown;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  }>;
};

const getSettingsRow = db.prepare(`
  select
    id,
    enabled,
    base_url as baseUrl,
    model,
    api_key as apiKey,
    personality_prompt as personalityPrompt,
    temperature,
    max_output_tokens as maxOutputTokens,
    timeout_ms as timeoutMs,
    updated_at as updatedAt
  from llm_settings
  where id = ?
`);

const insertDefaultSettings = db.prepare(`
  insert or ignore into llm_settings
    (id, enabled, base_url, model, api_key, personality_prompt, temperature, max_output_tokens, timeout_ms, updated_at)
  values
    (?, 1, ?, '', '', ?, 0.7, 140, 15000, ?)
`);

const updateSettings = db.prepare(`
  update llm_settings
  set
    enabled = ?,
    base_url = ?,
    model = ?,
    api_key = ?,
    personality_prompt = ?,
    temperature = ?,
    max_output_tokens = ?,
    timeout_ms = ?,
    updated_at = ?
  where id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureLlmSettings() {
  insertDefaultSettings.run(LLM_SETTINGS_ID, DEFAULT_BASE_URL, DEFAULT_PERSONALITY_PROMPT, nowIso());
}

function rowToSettings(row: LlmSettingsRow): LlmSettings {
  return {
    enabled: row.enabled === 1,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyConfigured: Boolean(row.apiKey),
    personalityPrompt: row.personalityPrompt,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
    updatedAt: row.updatedAt,
  };
}

function getSettingsRowOrDefault(): LlmSettingsRow {
  ensureLlmSettings();
  return getSettingsRow.get(LLM_SETTINGS_ID) as LlmSettingsRow;
}

export function getLlmSettings(): LlmSettings {
  return rowToSettings(getSettingsRowOrDefault());
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeSettingsUpdate(body: unknown): LlmSettingsUpdate {
  const value = body as Partial<LlmSettingsUpdate>;
  const baseUrl = typeof value.baseUrl === 'string' ? normalizeUrl(value.baseUrl) : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const personalityPrompt = typeof value.personalityPrompt === 'string' ? value.personalityPrompt.trim() : '';

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      throw new HttpRouteError(400, 'LLM base URL must be a valid http(s) URL.');
    }
  }
  if (!personalityPrompt) throw new HttpRouteError(400, 'Personality prompt is required.');
  if (personalityPrompt.length > 2000) throw new HttpRouteError(400, 'Personality prompt must be 2000 characters or fewer.');
  if (model.length > 160) throw new HttpRouteError(400, 'Model must be 160 characters or fewer.');

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    baseUrl,
    model,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : undefined,
    clearApiKey: value.clearApiKey === true,
    personalityPrompt,
    temperature: clampNumber(value.temperature, 0.7, 0, 2),
    maxOutputTokens: Math.round(clampNumber(value.maxOutputTokens, 140, 32, 500)),
    timeoutMs: Math.round(clampNumber(value.timeoutMs, 15000, 1000, 60000)),
  };
}

export function saveLlmSettings(body: unknown): LlmSettings {
  const current = getSettingsRowOrDefault();
  const next = normalizeSettingsUpdate(body);
  const apiKey = next.clearApiKey ? '' : next.apiKey ? next.apiKey : current.apiKey;

  updateSettings.run(
    next.enabled ? 1 : 0,
    next.baseUrl,
    next.model,
    apiKey,
    next.personalityPrompt,
    next.temperature,
    next.maxOutputTokens,
    next.timeoutMs,
    nowIso(),
    LLM_SETTINGS_ID,
  );

  return getLlmSettings();
}

function responsesUrl(baseUrl: string): string {
  return `${normalizeUrl(baseUrl)}/responses`;
}

function extractResponseText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return '';
}

async function callLlm(settings: LlmSettingsRow, userContent: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    const response = await fetch(responsesUrl(settings.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        instructions: settings.personalityPrompt,
        input: userContent,
        temperature: settings.temperature,
        max_output_tokens: settings.maxOutputTokens,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
      } catch { /* ignore */ }
      throw new Error(`LLM request failed (${response.status}): ${detail}`);
    }

    const data = await response.json() as ResponsesApiResponse;
    const answer = extractResponseText(data);
    if (!answer) throw new Error('LLM response included no text content.');
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

function twitchMessage(value: string, maxLength = 500): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function mention(chatMessage: ChatMessage): string {
  return `@${chatMessage.displayName || chatMessage.username}`;
}

export function formatPonderReply(chatMessage: ChatMessage, text: string): string {
  const prefix = `${mention(chatMessage)} `;
  return twitchMessage(`${prefix}${text}`, 500);
}

function userContent(chatMessage: ChatMessage, question: string): string {
  return `A Twitch chatter named ${chatMessage.displayName || chatMessage.username} asks: ${question}\nAnswer them in one concise chat message.`;
}

export async function askPonderLlm(chatMessage: ChatMessage, question: string): Promise<string> {
  const settings = getSettingsRowOrDefault();
  if (settings.enabled !== 1) {
    return formatPonderReply(chatMessage, 'pondering is disabled. The tiny brain is in its drawer.');
  }
  if (!settings.baseUrl || !settings.model) {
    return formatPonderReply(chatMessage, '!ponder needs an LLM base URL and model in Settings first. Naturally, the void forgot its paperwork.');
  }
  try {
    const answer = await callLlm(settings, userContent(chatMessage, question));
    return formatPonderReply(chatMessage, answer);
  } catch (error) {
    console.error('LLM: ponder request failed:', error);
    return formatPonderReply(chatMessage, 'the thinking machine tripped over its own shoelaces. Try again in a bit.');
  }
}

export function registerLlmRoutes(app: express.Express) {
  ensureLlmSettings();

  app.get('/api/llm/settings', (_request, response) => {
    response.json(getLlmSettings());
  });

  app.put('/api/llm/settings', (request, response) => {
    try {
      response.json(saveLlmSettings(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/llm/test', async (request, response) => {
    try {
      const body = request.body as { question?: unknown };
      const question = typeof body.question === 'string' && body.question.trim()
        ? body.question.trim()
        : 'Give me one short stream-chat-safe test reply.';
      if (question.length > 500) throw new HttpRouteError(400, 'Test question must be 500 characters or fewer.');

      const settings = getSettingsRowOrDefault();
      if (!settings.enabled) throw new HttpRouteError(400, 'LLM is disabled in settings.');
      if (!settings.baseUrl || !settings.model) throw new HttpRouteError(400, 'LLM base URL and model are required.');

      const fakeChatMessage = {
        id: 'llm-settings-test',
        channel: 'settings',
        username: 'settings',
        displayName: 'Settings',
        color: null,
        message: `!ponder ${question}`,
        receivedAt: new Date().toISOString(),
        deletedAt: null,
        deletedReason: null,
        badges: null,
        emotes: null,
        isFirstTimer: false,
        isFirstThisSession: false,
        isFirstEver: false,
      };
      let answer: string;
      try {
        answer = await callLlm(settings, userContent(fakeChatMessage, question));
      } catch (llmError) {
        const msg = llmError instanceof Error ? llmError.message : 'LLM request failed.';
        throw new HttpRouteError(502, msg);
      }
      const reply = formatPonderReply(fakeChatMessage, answer);
      response.json({ ok: true, reply });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
