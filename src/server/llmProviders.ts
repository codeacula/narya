import { createHash } from 'node:crypto';
import packageJson from '../../package.json';
import type { LlmApiFormat, LlmProviderId } from '../shared/api';

/**
 * The LLM providers the Settings dropdown offers. Each preset knows its own endpoint
 * layout and headers, so the operator only supplies a key and a model.
 *
 * OpenCode Go is not `base + /suffix` like an OpenAI-compatible server: each request
 * format lives under its own path, and the model list sits beside them. It also asks
 * clients to identify themselves and to send a stable session id per conversation
 * (https://opencode.ai/docs/console/go/), which is what `sendsOpencodeSession` drives.
 */
export type LlmProviderPreset = {
  id: LlmProviderId;
  label: string;
  defaultBaseUrl: string;
  defaultFormat: LlmApiFormat;
  requiresApiKey: boolean;
  paths: Record<LlmApiFormat | 'models', string>;
  sendsOpencodeSession: boolean;
};

const OPENAI_STYLE_PATHS = { responses: '/responses', chat_completions: '/chat/completions', models: '/models' };

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    defaultBaseUrl: 'https://opencode.ai/inference/go',
    defaultFormat: 'chat_completions',
    requiresApiKey: true,
    paths: { responses: '/openai/v1/responses', chat_completions: '/openai/v1/chat/completions', models: '/v1/models' },
    sendsOpencodeSession: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultFormat: 'responses',
    requiresApiKey: true,
    paths: OPENAI_STYLE_PATHS,
    sendsOpencodeSession: false,
  },
  {
    id: 'local',
    label: 'Local (LM Studio, etc.)',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultFormat: 'responses',
    requiresApiKey: false,
    paths: OPENAI_STYLE_PATHS,
    sendsOpencodeSession: false,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    defaultBaseUrl: '',
    defaultFormat: 'chat_completions',
    requiresApiKey: false,
    paths: OPENAI_STYLE_PATHS,
    sendsOpencodeSession: false,
  },
];

export const DEFAULT_LLM_PROVIDER: LlmProviderId = 'local';

const USER_AGENT = `narya/${packageJson.version}`;

export function getPreset(id: string): LlmProviderPreset | null {
  return LLM_PROVIDER_PRESETS.find(preset => preset.id === id) ?? null;
}

export function isLlmApiFormat(value: unknown): value is LlmApiFormat {
  return value === 'responses' || value === 'chat_completions';
}

export function endpointUrl(preset: LlmProviderPreset, baseUrl: string, kind: LlmApiFormat | 'models'): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${preset.paths[kind]}`;
}

export type LlmRequestInput = {
  model: string;
  instructions: string;
  input: string;
  temperature: number;
  maxOutputTokens: number;
};

export function buildRequestBody(format: LlmApiFormat, request: LlmRequestInput): Record<string, unknown> {
  const cap = request.maxOutputTokens > 0 ? request.maxOutputTokens : null;
  if (format === 'chat_completions') {
    return {
      model: request.model,
      messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: request.input },
      ],
      temperature: request.temperature,
      ...(cap ? { max_tokens: cap } : {}),
    };
  }
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    temperature: request.temperature,
    ...(cap ? { max_output_tokens: cap } : {}),
  };
}

/** A stable, non-reversible id per conversation (the viewer login, for a chat step). */
function sessionId(conversationKey: string): string {
  return createHash('sha256').update(`narya:${conversationKey}`).digest('hex').slice(0, 32);
}

export function buildHeaders(preset: LlmProviderPreset, apiKey: string, conversationKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (preset.sendsOpencodeSession) headers['x-opencode-session'] = sessionId(conversationKey);
  return headers;
}
