import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getActiveProviderRow, getLlmSettings, migrateLegacyLlmSettings } from './llm';

const MIGRATION_ID = '2026-11-llm-provider-profiles-from-legacy';
const LEGACY_COLUMNS = ['base_url', 'model', 'api_key'];

function llmSettingsColumns(): string[] {
  return (db.prepare("pragma table_info('llm_settings')").all() as Array<{ name: string }>).map(row => row.name);
}

/** Recreates the pre-profile llm_settings shape and row, as an old install has it. */
function seedLegacy(baseUrl: string, model: string, apiKey: string) {
  for (const column of LEGACY_COLUMNS) {
    if (!llmSettingsColumns().includes(column)) db.run(`alter table llm_settings add column ${column} text not null default ''`);
  }
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

  test('drops the legacy columns, so no plaintext key copy survives', () => {
    seedLegacy('https://opencode.ai/inference/go/openai/v1', 'glm-5.3-flash', 'sk-go');
    migrateLegacyLlmSettings();
    expect(llmSettingsColumns()).not.toContain('base_url');
    expect(llmSettingsColumns()).not.toContain('model');
    expect(llmSettingsColumns()).not.toContain('api_key');
    expect(getLlmSettings().personalityPrompt).toBe('Be nice.');
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

  test('a non-OpenAI Go path or a lookalike host prefix is kept verbatim under custom', () => {
    seedLegacy('https://opencode.ai/inference/gofoo/v1', 'm', '');
    migrateLegacyLlmSettings();
    const active = getActiveProviderRow();
    expect(active.preset.id).toBe('custom');
    expect(active.baseUrl).toBe('https://opencode.ai/inference/gofoo/v1');
  });

  test('a row with no model leaves the default local profile active', () => {
    seedLegacy('http://localhost:1234/v1', '', '');
    migrateLegacyLlmSettings();
    expect(getActiveProviderRow().preset.id).toBe('local');
  });

  test('is a no-op on a schema that never had the legacy columns', () => {
    migrateLegacyLlmSettings();
    migrateLegacyLlmSettings();
    expect(getActiveProviderRow().preset.id).toBe('local');
  });
});
