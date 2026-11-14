import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LlmSettingsUpdate } from '../shared/api';
import { db } from './db';
import { HttpRouteError } from './http';
import { getLlmSettings, runLlmTest, saveLlmSettings } from './llm';

const realFetch = globalThis.fetch;
let captured: Array<{ url: string; init: RequestInit }> = [];

function stubReply(text: string) {
  captured = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  }) as typeof fetch;
}

function draft(provider: Partial<LlmSettingsUpdate['provider']> = {}, rest: Partial<Omit<LlmSettingsUpdate, 'provider'>> = {}): LlmSettingsUpdate {
  return {
    enabled: true,
    activeProvider: 'opencode-go',
    personalityPrompt: 'Draft persona.',
    temperature: 0.3,
    maxOutputTokens: 100,
    timeoutMs: 15000,
    ...rest,
    provider: { baseUrl: 'https://opencode.ai/inference/go', model: 'kimi-k3', apiFormat: 'chat_completions', ...provider },
  };
}

beforeEach(() => {
  db.run('delete from llm_providers');
  db.run('delete from llm_settings');
  // Store a Go key while local stays active, as an operator would before switching.
  saveLlmSettings(draft({ apiKey: 'sk-stored' }));
  saveLlmSettings(draft({ baseUrl: 'http://localhost:1234/v1', model: 'qwen', apiFormat: 'responses' }, { activeProvider: 'local', personalityPrompt: 'Saved persona.' }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('runLlmTest with an unsaved draft', () => {
  test('tests the selected provider with its stored key and saves nothing', async () => {
    stubReply('draft reply');
    expect(await runLlmTest('hello?', draft())).toBe('draft reply');

    expect(captured[0]!.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-stored');
    const body = JSON.parse(String(captured[0]!.init.body));
    expect(body.model).toBe('kimi-k3');
    expect(body.temperature).toBe(0.3);
    expect(body.messages[0].content).toBe('Draft persona.');

    const settings = getLlmSettings();
    expect(settings.activeProvider).toBe('local');
    expect(settings.personalityPrompt).toBe('Saved persona.');
    expect(settings.providers.find(provider => provider.id === 'opencode-go')!.model).toBe('kimi-k3');
  });

  test('a typed key is used for the test but not stored', async () => {
    stubReply('ok');
    await runLlmTest('hello?', draft({ apiKey: 'sk-typed' }));
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-typed');
    stubReply('ok');
    await runLlmTest('hello?', draft());
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-stored');
  });

  test('a ticked "clear key" tests without a key', async () => {
    stubReply('ok');
    await runLlmTest('hello?', draft({ clearApiKey: true }));
    expect(captured[0]!.init.headers as Record<string, string>).not.toHaveProperty('Authorization');
  });

  test('without a draft it still tests the saved active provider', async () => {
    stubReply('ok');
    await runLlmTest('hello?');
    expect(captured[0]!.url).toBe('http://localhost:1234/v1/responses');
  });

  test('a draft is validated like a save', async () => {
    stubReply('ok');
    for (const bad of [draft({}, { activeProvider: 'nope' as never }), draft({ baseUrl: 'ftp://x' }), draft({ model: '' })]) {
      let caught: unknown = null;
      try { await runLlmTest('hello?', bad); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(HttpRouteError);
      expect((caught as HttpRouteError).status).toBe(400);
    }
    expect(captured).toHaveLength(0);
  });
});
