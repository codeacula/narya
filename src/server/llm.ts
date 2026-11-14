import type express from 'express';
import type { LlmApiFormat, LlmModelList, LlmProviderId, LlmProviderProfile, LlmSettings, LlmSettingsUpdate } from '../shared/api';
import { db, runOnce } from './db';
import { handle, HttpRouteError } from './http';
import { buildHeaders, buildRequestBody, DEFAULT_LLM_PROVIDER, endpointUrl, normalizeBaseUrl, getPreset, isLlmApiFormat, LLM_PROVIDER_PRESETS, type LlmProviderPreset } from './llmProviders';
import { clampFinite } from './numeric';

const LLM_SETTINGS_ID = 'default';
const DEFAULT_PERSONALITY_PROMPT = [
  'You are a tiny, theatrical stream-side know-it-all who answers Twitch chat questions.',
  'Be silly, lightly snarky, and concise, but never cruel.',
  'Answer in one short chat-friendly message.',
  'Do not include an @mention; the app adds that for you.',
].join(' ');

/** The bot-behaviour fields every provider shares. */
type LlmSettingsRow = {
  id: string;
  enabled: number;
  activeProvider: string;
  personalityPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedAt: string;
};

type LlmProviderRow = {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: string;
  updatedAt: string;
};

/** A provider profile resolved against its preset, with the key — server-side only. */
export type ResolvedLlmProvider = {
  preset: LlmProviderPreset;
  baseUrl: string;
  model: string;
  apiFormat: LlmApiFormat;
  apiKey: string;
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
  // Chat Completions shape (the chat_completions format, and some local servers' /responses)
  choices?: Array<{
    message?: { content?: unknown };
  }>;
};

const getSettingsRow = db.prepare(`
  select
    id,
    enabled,
    active_provider as activeProvider,
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
    (id, enabled, personality_prompt, temperature, max_output_tokens, timeout_ms, updated_at, active_provider)
  values
    (?, 1, ?, 0.7, 2048, 15000, ?, ?)
`);

const updateSettings = db.prepare(`
  update llm_settings
  set
    enabled = ?,
    active_provider = ?,
    personality_prompt = ?,
    temperature = ?,
    max_output_tokens = ?,
    timeout_ms = ?,
    updated_at = ?
  where id = ?
`);

const getProviderRowStatement = db.prepare(`
  select id, base_url as baseUrl, api_key as apiKey, model, api_format as apiFormat, updated_at as updatedAt
  from llm_providers
  where id = ?
`);

const insertDefaultProvider = db.prepare(`
  insert or ignore into llm_providers (id, base_url, api_key, model, api_format, updated_at)
  values (?, ?, '', '', ?, ?)
`);

const updateProvider = db.prepare(`
  update llm_providers
  set base_url = ?, api_key = ?, model = ?, api_format = ?, updated_at = ?
  where id = ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureLlmSettings() {
  insertDefaultSettings.run(LLM_SETTINGS_ID, DEFAULT_PERSONALITY_PROMPT, nowIso(), DEFAULT_LLM_PROVIDER);
}

function getSettingsRowOrDefault(): LlmSettingsRow {
  ensureLlmSettings();
  return getSettingsRow.get(LLM_SETTINGS_ID) as LlmSettingsRow;
}

function getProviderRowOrDefault(preset: LlmProviderPreset): LlmProviderRow {
  insertDefaultProvider.run(preset.id, preset.defaultBaseUrl, preset.defaultFormat, nowIso());
  return getProviderRowStatement.get(preset.id) as LlmProviderRow;
}

function resolveProvider(preset: LlmProviderPreset): ResolvedLlmProvider {
  const row = getProviderRowOrDefault(preset);
  return {
    preset,
    baseUrl: row.baseUrl,
    model: row.model,
    apiFormat: isLlmApiFormat(row.apiFormat) ? row.apiFormat : preset.defaultFormat,
    apiKey: row.apiKey,
  };
}

/** The stored profile for one provider; null for an id no preset defines. */
export function getProviderRow(id: string): ResolvedLlmProvider | null {
  const preset = getPreset(id);
  return preset ? resolveProvider(preset) : null;
}

/** The active provider's profile. A stored id no preset knows falls back to the default. */
export function getActiveProviderRow(): ResolvedLlmProvider {
  const settings = getSettingsRowOrDefault();
  return getProviderRow(settings.activeProvider) ?? resolveProvider(getPreset(DEFAULT_LLM_PROVIDER)!);
}

const LEGACY_LLM_COLUMNS = ['base_url', 'model', 'api_key'] as const;

function hasLegacyLlmColumns(): boolean {
  const columns = db.prepare("pragma table_info('llm_settings')").all() as Array<{ name: string }>;
  return columns.some(column => column.name === 'base_url');
}

/**
 * Carries the pre-profile single-endpoint config (llm_settings.base_url/model/api_key)
 * into a provider profile, then drops those columns. Before profiles every request
 * went to `{base_url}/responses`, so the migrated profile keeps the Responses format:
 * the endpoint a working install was hitting is exactly the endpoint it keeps hitting.
 * An OpenCode Go URL lands on the opencode-go preset (same URL, plus Go's session
 * headers); anything else lands on custom. A row with no model was never usable and
 * leaves the default provider active.
 *
 * Must run before ensureLlmSettings: the legacy columns are NOT NULL with no default,
 * so the default-row insert (which no longer names them) is skipped until they are
 * gone. Keyed on the columns' presence rather than a ledger id alone, so a database
 * that ran the copy before the drop existed still gets the drop. A fresh install never
 * has the columns, and this is a no-op.
 */
export function migrateLegacyLlmSettings() {
  if (!hasLegacyLlmColumns()) return;
  runOnce('2026-11-llm-provider-profiles-from-legacy', () => {
    const legacy = db.prepare('select base_url as baseUrl, model, api_key as apiKey from llm_settings where id = ?')
      .get(LLM_SETTINGS_ID) as { baseUrl: string; model: string; apiKey: string } | null;
    if (!legacy || !legacy.baseUrl.trim() || !legacy.model.trim()) return;

    const go = getPreset('opencode-go')!;
    const isGo = normalizeBaseUrl(go, legacy.baseUrl) === go.defaultBaseUrl;
    const preset = isGo ? go : getPreset('custom')!;
    const baseUrl = isGo ? go.defaultBaseUrl : normalizeUrl(legacy.baseUrl);
    getProviderRowOrDefault(preset);
    updateProvider.run(baseUrl, legacy.apiKey, legacy.model.trim(), 'responses', nowIso(), preset.id);
    db.prepare('update llm_settings set active_provider = ? where id = ?').run(preset.id, LLM_SETTINGS_ID);
  });
  db.transaction(() => {
    for (const column of LEGACY_LLM_COLUMNS) db.run(`alter table llm_settings drop column ${column}`);
  })();
}

function toProfile(provider: ResolvedLlmProvider): LlmProviderProfile {
  return {
    id: provider.preset.id,
    label: provider.preset.label,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiFormat: provider.apiFormat,
    apiKeyConfigured: Boolean(provider.apiKey),
    requiresApiKey: provider.preset.requiresApiKey,
  };
}

export function getLlmSettings(): LlmSettings {
  const row = getSettingsRowOrDefault();
  return {
    enabled: row.enabled === 1,
    activeProvider: getActiveProviderRow().preset.id,
    providers: LLM_PROVIDER_PRESETS.map(preset => toProfile(resolveProvider(preset))),
    personalityPrompt: row.personalityPrompt,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
    updatedAt: row.updatedAt,
  };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return clampFinite(numeric, min, max, fallback);
}

function normalizeSettingsUpdate(body: unknown): LlmSettingsUpdate {
  const value = (body ?? {}) as Partial<LlmSettingsUpdate>;
  const provider = (value.provider ?? {}) as Partial<LlmSettingsUpdate['provider']>;
  const preset = typeof value.activeProvider === 'string' ? getPreset(value.activeProvider) : null;
  if (!preset) throw new HttpRouteError(400, 'Unknown LLM provider.');
  if (!isLlmApiFormat(provider.apiFormat)) throw new HttpRouteError(400, 'Unknown LLM API format.');

  const baseUrl = typeof provider.baseUrl === 'string' ? normalizeBaseUrl(preset, provider.baseUrl) : '';
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
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
    activeProvider: preset.id,
    provider: {
      baseUrl,
      model,
      apiFormat: provider.apiFormat,
      apiKey: typeof provider.apiKey === 'string' ? provider.apiKey.trim() : undefined,
      clearApiKey: provider.clearApiKey === true,
    },
    personalityPrompt,
    temperature: clampNumber(value.temperature, 0.7, 0, 2),
    maxOutputTokens: Math.round(clampNumber(value.maxOutputTokens, 2048, 0, 8192)),
    timeoutMs: Math.round(clampNumber(value.timeoutMs, 15000, 1000, 60000)),
  };
}

export function saveLlmSettings(body: unknown): LlmSettings {
  getSettingsRowOrDefault();
  const next = normalizeSettingsUpdate(body);
  const current = getProviderRow(next.activeProvider)!;
  const apiKey = next.provider.clearApiKey ? '' : next.provider.apiKey ? next.provider.apiKey : current.apiKey;
  const now = nowIso();

  db.transaction(() => {
    updateProvider.run(next.provider.baseUrl, apiKey, next.provider.model, next.provider.apiFormat, now, next.activeProvider);
    updateSettings.run(
      next.enabled ? 1 : 0,
      next.activeProvider,
      next.personalityPrompt,
      next.temperature,
      next.maxOutputTokens,
      next.timeoutMs,
      now,
      LLM_SETTINGS_ID,
    );
  })();

  return getLlmSettings();
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

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
  } catch { /* ignore */ }
  return detail;
}

async function callLlm(
  settings: LlmSettingsRow,
  provider: ResolvedLlmProvider,
  instructions: string,
  userContent: string,
  conversationKey: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetch(endpointUrl(provider.preset, provider.baseUrl, provider.apiFormat), {
      method: 'POST',
      headers: buildHeaders(provider.preset, provider.apiKey, conversationKey),
      signal: controller.signal,
      body: JSON.stringify(buildRequestBody(provider.apiFormat, {
        model: provider.model,
        instructions,
        input: userContent,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
      })),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status}): ${await readErrorDetail(response)}`);
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

/**
 * The provider's model list, fetched server-side so the stored key never reaches the
 * browser. Every failure is a value, not a throw: Settings calls this automatically,
 * and an unreachable provider is an ordinary state there, not an error page.
 */
export async function listProviderModels(id: LlmProviderId): Promise<LlmModelList> {
  const provider = getProviderRow(id);
  if (!provider) return { ok: false, error: 'Unknown LLM provider.' };
  if (!provider.baseUrl) return { ok: false, error: 'No base URL configured.' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getSettingsRowOrDefault().timeoutMs);
  try {
    const response = await fetch(endpointUrl(provider.preset, provider.baseUrl, 'models'), {
      headers: buildHeaders(provider.preset, provider.apiKey, 'models'),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Model list request failed (${response.status}): ${await readErrorDetail(response)}` };
    }
    const data = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!data || !Array.isArray(data.data)) return { ok: false, error: 'The provider returned no model list.' };
    const ids = data.data
      .map(entry => (entry as { id?: unknown } | null)?.id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    return { ok: true, models: [...new Set(ids)].sort() };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : 'Model list request failed.' };
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
export async function runLlmRequest(instructions: string, input: string, conversationKey = 'anonymous'): Promise<string> {
  const settings = getSettingsRowOrDefault();
  const provider = getActiveProviderRow();
  if (settings.enabled !== 1) throw new Error('The LLM is disabled in Settings.');
  if (!provider.baseUrl || !provider.model) throw new Error('The LLM needs a base URL and model in Settings.');
  return callLlm(settings, provider, instructions, input, conversationKey);
}

/**
 * The Settings "Test LLM" call. With a draft (the form as it stands, unsaved), it
 * tests exactly what is on screen — the selected provider, model, format, prompt, and
 * temperature — and stores nothing. A blank key falls back to the one stored for
 * that provider, so a provider can be tried before switching to it. The draft goes
 * through the same validation as a save. Without a draft it tests the saved config.
 *
 * Validation and configuration problems throw HttpRouteError (400); a failed LLM call
 * throws a plain Error, which the route reports as 502.
 */
export async function runLlmTest(question: string, draft?: unknown): Promise<string> {
  const saved = getSettingsRowOrDefault();
  if (!saved.enabled) throw new HttpRouteError(400, 'LLM is disabled in settings.');

  let settings: LlmSettingsRow = saved;
  let provider = getActiveProviderRow();
  if (draft !== undefined) {
    const next = normalizeSettingsUpdate(draft);
    const stored = getProviderRow(next.activeProvider)!;
    provider = {
      preset: stored.preset,
      baseUrl: next.provider.baseUrl,
      model: next.provider.model,
      apiFormat: next.provider.apiFormat,
      apiKey: next.provider.clearApiKey ? '' : next.provider.apiKey || stored.apiKey,
    };
    settings = {
      ...saved,
      personalityPrompt: next.personalityPrompt,
      temperature: next.temperature,
      maxOutputTokens: next.maxOutputTokens,
      timeoutMs: next.timeoutMs,
    };
  }
  if (!provider.baseUrl || !provider.model) throw new HttpRouteError(400, 'LLM base URL and model are required.');

  // The test keeps its own framing rather than borrowing an Action step's: it checks
  // that the configured endpoint answers at all, so it must not depend on any step's
  // prompt, context, or targeting.
  return callLlm(
    settings,
    provider,
    settings.personalityPrompt,
    `A Twitch chatter asks: ${question}\nAnswer them in one concise chat message.`,
    'settings-test',
  );
}

export function registerLlmRoutes(app: express.Express) {
  migrateLegacyLlmSettings();
  ensureLlmSettings();

  app.get('/api/llm/settings', (_request, response) => {
    response.json(getLlmSettings());
  });

  app.put('/api/llm/settings', handle((request, response) => {
    response.json(saveLlmSettings(request.body));
  }));

  app.get('/api/llm/providers/:id/models', handle(async (request, response) => {
    const id = String(request.params.id);
    if (!getPreset(id)) throw new HttpRouteError(404, 'Unknown LLM provider.');
    response.json(await listProviderModels(id as LlmProviderId));
  }));

  app.post('/api/llm/test', handle(async (request, response) => {
    const body = (request.body ?? {}) as { question?: unknown; settings?: unknown };
    const question = typeof body.question === 'string' && body.question.trim()
      ? body.question.trim()
      : 'Give me one short stream-chat-safe test reply.';
    if (question.length > 500) throw new HttpRouteError(400, 'Test question must be 500 characters or fewer.');

    let answer: string;
    try {
      answer = await runLlmTest(question, body.settings === undefined ? undefined : body.settings);
    } catch (llmError) {
      if (llmError instanceof HttpRouteError) throw llmError;
      const msg = llmError instanceof Error ? llmError.message : 'LLM request failed.';
      throw new HttpRouteError(502, msg);
    }
    response.json({ ok: true, reply: twitchMessage(answer, 500) });
  }));
}
