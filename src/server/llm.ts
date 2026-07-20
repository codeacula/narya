import type express from 'express';
import type { ChatMessage, LlmSettings, LlmSettingsUpdate } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import { clampFinite } from './numeric';

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

export type ResponsesApiResponse = {
  output_text?: unknown;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  }>;
  // Chat Completions fallback (some local servers return this even from /responses)
  choices?: Array<{
    message?: { content?: unknown };
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
    (?, 1, ?, '', '', ?, 0.7, 2048, 15000, ?)
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
  return clampFinite(numeric, min, max, fallback);
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
    maxOutputTokens: Math.round(clampNumber(value.maxOutputTokens, 2048, 0, 8192)),
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

function stripThinkingTokens(text: string): string {
  // Remove <think>...</think> blocks emitted by reasoning/thinking models
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function extractResponseText(data: ResponsesApiResponse): string {
  // Responses API: top-level output_text shortcut
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return stripThinkingTokens(data.output_text);
  }
  // Responses API: output array — handles both 'output_text' and 'text' content types
  // (thinking models often use type:'text' rather than type:'output_text')
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      const isText = part.type === 'output_text' || part.type === 'text';
      if (isText && typeof part.text === 'string' && part.text.trim()) {
        return stripThinkingTokens(part.text);
      }
    }
  }
  // Chat Completions fallback for local servers that return that format
  const choice = data.choices?.[0];
  if (typeof choice?.message?.content === 'string' && choice.message.content.trim()) {
    return stripThinkingTokens(choice.message.content);
  }
  return '';
}

async function callLlm(settings: LlmSettingsRow, instructions: string, userContent: string): Promise<string> {
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
        instructions,
        input: userContent,
        temperature: settings.temperature,
        ...(settings.maxOutputTokens > 0 ? { max_output_tokens: settings.maxOutputTokens } : {}),
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
    if (!answer) {
      console.error('LLM: no text extracted from response:', JSON.stringify(data).slice(0, 500));
      throw new Error('LLM response included no text content.');
    }
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

/** The personality prompt an llm_response step enhances or overrides. */
export function getPersonalityPrompt(): string {
  return getSettingsRowOrDefault().personalityPrompt;
}

/**
 * Runs an already-assembled request. Prompt construction lives in llmPrompt.ts, which
 * is pure; this function owns only settings, transport, and failure text.
 *
 * Throws on a disabled or unconfigured LLM so the calling step reports a real status
 * rather than publishing an apology to chat as though it were the model's answer —
 * which is what the `!ponder` helper this replaced used to do.
 */
export async function runLlmRequest(instructions: string, input: string): Promise<string> {
  const settings = getSettingsRowOrDefault();
  if (settings.enabled !== 1) throw new Error('The LLM is disabled in Settings.');
  if (!settings.baseUrl || !settings.model) throw new Error('The LLM needs a base URL and model in Settings.');
  return callLlm(settings, instructions, input);
}

export function registerLlmRoutes(app: express.Express) {
  ensureLlmSettings();

  app.get('/api/llm/settings', (_request, response) => {
    response.json(getLlmSettings());
  });

  app.put('/api/llm/settings', handle((request, response) => {
    response.json(saveLlmSettings(request.body));
  }));

  app.post('/api/llm/test', handle(async (request, response) => {
    const body = request.body as { question?: unknown };
    const question = typeof body.question === 'string' && body.question.trim()
      ? body.question.trim()
      : 'Give me one short stream-chat-safe test reply.';
    if (question.length > 500) throw new HttpRouteError(400, 'Test question must be 500 characters or fewer.');

    const settings = getSettingsRowOrDefault();
    if (!settings.enabled) throw new HttpRouteError(400, 'LLM is disabled in settings.');
    if (!settings.baseUrl || !settings.model) throw new HttpRouteError(400, 'LLM base URL and model are required.');

    // The test route keeps its own framing rather than borrowing an Action step's:
    // it is checking that the configured endpoint answers at all, so it must not
    // depend on any step's prompt, context, or targeting.
    let answer: string;
    try {
      answer = await callLlm(
        settings,
        settings.personalityPrompt,
        `A Twitch chatter asks: ${question}\nAnswer them in one concise chat message.`,
      );
    } catch (llmError) {
      const msg = llmError instanceof Error ? llmError.message : 'LLM request failed.';
      throw new HttpRouteError(502, msg);
    }
    response.json({ ok: true, reply: twitchMessage(answer, 500) });
  }));
}
