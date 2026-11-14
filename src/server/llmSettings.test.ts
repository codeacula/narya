import { beforeEach, describe, expect, test } from 'bun:test';
import type { LlmSettingsUpdate } from '../shared/api';
import { db } from './db';
import { HttpRouteError } from './http';
import { getLlmSettings, saveLlmSettings } from './llm';

const GO_BASE = 'https://opencode.ai/inference/go';

function update(overrides: Partial<Omit<LlmSettingsUpdate, 'provider'>> & { provider?: Partial<LlmSettingsUpdate['provider']> } = {}): LlmSettingsUpdate {
  const { provider, ...rest } = overrides;
  return {
    enabled: true,
    activeProvider: 'opencode-go',
    personalityPrompt: 'Be nice.',
    temperature: 0.7,
    maxOutputTokens: 2048,
    timeoutMs: 15000,
    ...rest,
    provider: { baseUrl: GO_BASE, model: 'kimi-k3', apiFormat: 'chat_completions', ...provider },
  };
}

function expectRouteError(run: () => unknown, status: number) {
  try {
    run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(HttpRouteError);
    expect((caught as HttpRouteError).status).toBe(status);
    return;
  }
  throw new Error('expected an HttpRouteError');
}

beforeEach(() => {
  db.run('delete from llm_providers');
  db.run('delete from llm_settings');
});

describe('LLM provider profiles', () => {
  test('a fresh install defaults to the local provider with every preset listed', () => {
    const settings = getLlmSettings();
    expect(settings.activeProvider).toBe('local');
    expect(settings.providers.map(provider => provider.id)).toEqual(['opencode-go', 'openai', 'local', 'custom']);
    const go = settings.providers.find(provider => provider.id === 'opencode-go')!;
    expect(go.baseUrl).toBe(GO_BASE);
    expect(go.apiFormat).toBe('chat_completions');
    expect(go.requiresApiKey).toBe(true);
    expect(settings.providers.every(provider => !provider.apiKeyConfigured)).toBe(true);
  });

  test('saving activates the provider and never echoes its key', () => {
    const settings = saveLlmSettings(update({ provider: { apiKey: 'sk-go-secret' } }));
    expect(settings.activeProvider).toBe('opencode-go');
    expect(settings.providers.find(provider => provider.id === 'opencode-go')!.apiKeyConfigured).toBe(true);
    expect(settings.providers.find(provider => provider.id === 'local')!.apiKeyConfigured).toBe(false);
    expect(JSON.stringify(settings)).not.toContain('sk-go-secret');
    expect(JSON.stringify(getLlmSettings())).not.toContain('sk-go-secret');
  });

  test('switching away and back keeps each provider\'s own key and model', () => {
    saveLlmSettings(update({ provider: { apiKey: 'sk-go-secret' } }));
    saveLlmSettings(update({ activeProvider: 'local', provider: { baseUrl: 'http://localhost:1234/v1', model: 'qwen', apiFormat: 'responses' } }));
    const local = getLlmSettings().providers.find(provider => provider.id === 'local')!;
    expect(local.apiKeyConfigured).toBe(false);
    expect(local.model).toBe('qwen');

    const back = saveLlmSettings(update());
    const go = back.providers.find(provider => provider.id === 'opencode-go')!;
    expect(back.activeProvider).toBe('opencode-go');
    expect(go.apiKeyConfigured).toBe(true);
    expect(go.model).toBe('kimi-k3');
  });

  test('clearing the key removes it', () => {
    saveLlmSettings(update({ provider: { apiKey: 'sk-go-secret' } }));
    const cleared = saveLlmSettings(update({ provider: { clearApiKey: true } }));
    expect(cleared.providers.find(provider => provider.id === 'opencode-go')!.apiKeyConfigured).toBe(false);
  });

  test('rejects an unknown provider, an unknown format, and a non-http base URL', () => {
    expectRouteError(() => saveLlmSettings({ ...update(), activeProvider: 'nope' as never }), 400);
    expectRouteError(() => saveLlmSettings(update({ provider: { apiFormat: 'anthropic' as never } })), 400);
    expectRouteError(() => saveLlmSettings(update({ provider: { baseUrl: 'ftp://example.com' } })), 400);
    const count = db.prepare("select count(*) as n from llm_providers where id = 'nope'").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
