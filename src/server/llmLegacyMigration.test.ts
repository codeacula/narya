import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getActiveProviderRow, migrateLegacyLlmSettings } from './llm';

const MIGRATION_ID = '2026-11-llm-provider-profiles-from-legacy';

function seedLegacy(baseUrl: string, model: string, apiKey: string) {
  db.run(
    `insert into llm_settings (id, enabled, base_url, model, api_key, personality_prompt, temperature, max_output_tokens, timeout_ms, updated_at)
     values ('default', 1, ?, ?, ?, 'Be nice.', 0.7, 2048, 15000, '2026-01-01T00:00:00.000Z')`,
    [baseUrl, model, apiKey],
  );
}

beforeEach(() => {
  db.run('delete from llm_providers');
  db.run('delete from llm_settings');
  db.run('delete from schema_migrations where id = ?', [MIGRATION_ID]);
});

describe('migrateLegacyLlmSettings', () => {
  test('an OpenCode Go URL becomes the opencode-go profile on the same endpoint', () => {
    seedLegacy('https://opencode.ai/inference/go/openai/v1', 'glm-5.3-flash', 'sk-go');
    migrateLegacyLlmSettings();
    const active = getActiveProviderRow();
    expect(active.preset.id).toBe('opencode-go');
    expect(active.baseUrl).toBe('https://opencode.ai/inference/go');
    expect(active.apiFormat).toBe('responses');
    expect(active.model).toBe('glm-5.3-flash');
    expect(active.apiKey).toBe('sk-go');
  });

  test('any other URL becomes the custom profile with the Responses format it used', () => {
    seedLegacy('http://10.0.0.5:8080/v1', 'llama', '');
    migrateLegacyLlmSettings();
    const active = getActiveProviderRow();
    expect(active.preset.id).toBe('custom');
    expect(active.baseUrl).toBe('http://10.0.0.5:8080/v1');
    expect(active.apiFormat).toBe('responses');
    expect(active.model).toBe('llama');
  });

  test('a row with no model leaves the default local profile active', () => {
    seedLegacy('http://localhost:1234/v1', '', '');
    migrateLegacyLlmSettings();
    expect(getActiveProviderRow().preset.id).toBe('local');
  });

  test('runs once: a later edit is not overwritten by the legacy columns', () => {
    seedLegacy('https://opencode.ai/inference/go/openai/v1', 'glm-5.3-flash', 'sk-go');
    migrateLegacyLlmSettings();
    db.run("update llm_providers set model = 'kimi-k3' where id = 'opencode-go'");
    migrateLegacyLlmSettings();
    expect(getActiveProviderRow().model).toBe('kimi-k3');
  });
});
