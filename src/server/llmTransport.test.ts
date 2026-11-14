import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LlmSettingsUpdate } from '../shared/api';
import { db } from './db';
import { listProviderModels, runLlmRequest, saveLlmSettings } from './llm';

type Captured = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;
let captured: Captured[] = [];

function stubFetch(respond: () => Response | Promise<Response>) {
  captured = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function activate(activeProvider: LlmSettingsUpdate['activeProvider'], provider: LlmSettingsUpdate['provider']) {
  saveLlmSettings({
    enabled: true,
    activeProvider,
    provider,
    personalityPrompt: 'Be nice.',
    temperature: 0.7,
    maxOutputTokens: 2048,
    timeoutMs: 15000,
  });
}

beforeEach(() => {
  db.run('delete from llm_providers');
  db.run('delete from llm_settings');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('runLlmRequest', () => {
  test('OpenCode Go uses chat completions with its session header', async () => {
    activate('opencode-go', { baseUrl: 'https://opencode.ai/inference/go', model: 'kimi-k3', apiFormat: 'chat_completions', apiKey: 'sk-go' });
    stubFetch(() => json({ choices: [{ message: { content: 'hi' } }] }));

    expect(await runLlmRequest('I', 'U', 'alice')).toBe('hi');
    expect(captured[0]!.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    const body = JSON.parse(String(captured[0]!.init.body));
    expect(body.messages).toEqual([{ role: 'system', content: 'I' }, { role: 'user', content: 'U' }]);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-go');
    expect(headers['x-opencode-session']).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a local Responses profile keeps the Responses shape', async () => {
    activate('local', { baseUrl: 'http://localhost:1234/v1', model: 'qwen', apiFormat: 'responses' });
    stubFetch(() => json({ output_text: 'local reply' }));

    expect(await runLlmRequest('I', 'U')).toBe('local reply');
    expect(captured[0]!.url).toBe('http://localhost:1234/v1/responses');
    expect(JSON.parse(String(captured[0]!.init.body)).instructions).toBe('I');
  });
});

describe('listProviderModels', () => {
  beforeEach(() => {
    activate('opencode-go', { baseUrl: 'https://opencode.ai/inference/go', model: '', apiFormat: 'chat_completions', apiKey: 'sk-go' });
  });

  test('returns sorted unique model ids from the models endpoint', async () => {
    stubFetch(() => json({ data: [{ id: 'kimi-k3' }, { id: 'glm-5.3' }, { id: 'kimi-k3' }] }));
    expect(await listProviderModels('opencode-go')).toEqual({ ok: true, models: ['glm-5.3', 'kimi-k3'] });
    expect(captured[0]!.url).toBe('https://opencode.ai/inference/go/v1/models');
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-go');
  });

  test('an unreachable provider is ok:false, not a throw', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED'); });
    const result = await listProviderModels('opencode-go');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ECONNREFUSED');
  });

  test('an HTTP error reports its status', async () => {
    stubFetch(() => json({ error: { message: 'bad key' } }, 401));
    const result = await listProviderModels('opencode-go');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('401');
  });

  test('a non-JSON or data-less body is ok:false', async () => {
    stubFetch(() => new Response('<html>', { status: 200 }));
    expect((await listProviderModels('opencode-go')).ok).toBe(false);
    stubFetch(() => json({}));
    expect((await listProviderModels('opencode-go')).ok).toBe(false);
  });
});

describe('listProviderModels with an unknown provider', () => {
  test('is ok:false and makes no request', async () => {
    stubFetch(() => json({ data: [] }));
    expect((await listProviderModels('nope' as never)).ok).toBe(false);
    expect(captured).toHaveLength(0);
    const count = db.prepare("select count(*) as n from llm_providers where id = 'nope'").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
