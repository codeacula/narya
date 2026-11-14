import { describe, expect, test } from 'bun:test';
import { buildHeaders, buildRequestBody, endpointUrl, getPreset, isLlmApiFormat, LLM_PROVIDER_PRESETS } from './llmProviders';

const go = getPreset('opencode-go')!;
const local = getPreset('local')!;

describe('LLM provider presets', () => {
  test('lists presets in dropdown order', () => {
    expect(LLM_PROVIDER_PRESETS.map(preset => preset.id)).toEqual(['opencode-go', 'openai', 'local', 'custom']);
  });

  test('unknown ids and formats are rejected', () => {
    expect(getPreset('nope')).toBeNull();
    expect(isLlmApiFormat('anthropic')).toBe(false);
    expect(isLlmApiFormat('chat_completions')).toBe(true);
  });
});

describe('endpointUrl', () => {
  test('OpenCode Go uses its own per-format paths', () => {
    expect(endpointUrl(go, 'https://opencode.ai/inference/go/', 'chat_completions'))
      .toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(endpointUrl(go, 'https://opencode.ai/inference/go', 'responses'))
      .toBe('https://opencode.ai/inference/go/openai/v1/responses');
    expect(endpointUrl(go, 'https://opencode.ai/inference/go', 'models'))
      .toBe('https://opencode.ai/inference/go/v1/models');
  });

  test('OpenAI-style providers are relative to the base URL without doubling slashes', () => {
    expect(endpointUrl(local, 'http://localhost:1234/v1', 'responses')).toBe('http://localhost:1234/v1/responses');
    expect(endpointUrl(local, 'http://localhost:1234/v1//', 'models')).toBe('http://localhost:1234/v1/models');
  });
});

describe('buildRequestBody', () => {
  const base = { model: 'm', instructions: 'I', input: 'U', temperature: 0.5, maxOutputTokens: 100 };

  test('chat completions puts instructions in a system message', () => {
    expect(buildRequestBody('chat_completions', base)).toEqual({
      model: 'm',
      messages: [{ role: 'system', content: 'I' }, { role: 'user', content: 'U' }],
      temperature: 0.5,
      max_tokens: 100,
    });
  });

  test('responses keeps the instructions/input shape', () => {
    expect(buildRequestBody('responses', base)).toEqual({
      model: 'm', instructions: 'I', input: 'U', temperature: 0.5, max_output_tokens: 100,
    });
  });

  test('zero max tokens sends no cap in either format', () => {
    const unlimited = { ...base, maxOutputTokens: 0 };
    expect(buildRequestBody('chat_completions', unlimited)).not.toHaveProperty('max_tokens');
    expect(buildRequestBody('responses', unlimited)).not.toHaveProperty('max_output_tokens');
  });
});

describe('buildHeaders', () => {
  test('OpenCode Go identifies Narya and sends a stable per-conversation session', () => {
    const alice = buildHeaders(go, 'k', 'alice');
    expect(alice.Authorization).toBe('Bearer k');
    expect(alice['User-Agent']).toMatch(/^narya\/\d/);
    expect(alice['x-opencode-session']).toMatch(/^[0-9a-f]{32}$/);
    expect(buildHeaders(go, 'k', 'alice')['x-opencode-session']).toBe(alice['x-opencode-session']);
    expect(buildHeaders(go, 'k', 'bob')['x-opencode-session']).not.toBe(alice['x-opencode-session']);
  });

  test('a keyless local provider gets no auth or session header', () => {
    const headers = buildHeaders(local, '', 'alice');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('x-opencode-session');
    expect(headers['Content-Type']).toBe('application/json');
  });
});
