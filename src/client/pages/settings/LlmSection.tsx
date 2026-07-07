import React, { useEffect, useState } from 'react';
import type { LlmSettingsUpdate } from '../../../shared/api';
import { getLlmSettings, testLlm, updateLlmSettings } from '../../services/dashboard';

type LlmSettingsForm = LlmSettingsUpdate & {
  apiKeyConfigured: boolean;
};

const EMPTY_LLM_SETTINGS: LlmSettingsForm = {
  enabled: true,
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  apiKey: '',
  clearApiKey: false,
  apiKeyConfigured: false,
  personalityPrompt: '',
  temperature: 0.7,
  maxOutputTokens: 2048,
  timeoutMs: 15000,
};

export function LlmSection() {
  const [llmSettings, setLlmSettings] = useState<LlmSettingsForm>(EMPTY_LLM_SETTINGS);
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestQuestion, setLlmTestQuestion] = useState('why is CSS like this?');
  const [llmTestReply, setLlmTestReply] = useState<string | null>(null);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLlmLoading(true);
    void getLlmSettings()
      .then(settings => {
        if (!cancelled) {
          setLlmSettings({
            enabled: settings.enabled,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: '',
            clearApiKey: false,
            apiKeyConfigured: settings.apiKeyConfigured,
            personalityPrompt: settings.personalityPrompt,
            temperature: settings.temperature,
            maxOutputTokens: settings.maxOutputTokens,
            timeoutMs: settings.timeoutMs,
          });
          setLlmError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setLlmError(error instanceof Error ? error.message : 'Could not load LLM settings');
      })
      .finally(() => {
        if (!cancelled) setLlmLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLlmSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLlmSaving(true);
    setLlmMessage(null);
    setLlmError(null);
    void updateLlmSettings({
      enabled: llmSettings.enabled,
      baseUrl: llmSettings.baseUrl,
      model: llmSettings.model,
      apiKey: llmSettings.apiKey,
      clearApiKey: llmSettings.clearApiKey,
      personalityPrompt: llmSettings.personalityPrompt,
      temperature: llmSettings.temperature,
      maxOutputTokens: llmSettings.maxOutputTokens,
      timeoutMs: llmSettings.timeoutMs,
    })
      .then(settings => {
        setLlmSettings({
          enabled: settings.enabled,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: '',
          clearApiKey: false,
          apiKeyConfigured: settings.apiKeyConfigured,
          personalityPrompt: settings.personalityPrompt,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxOutputTokens,
          timeoutMs: settings.timeoutMs,
        });
        setLlmMessage('Saved');
      })
      .catch(error => {
        setLlmError(error instanceof Error ? error.message : 'Could not save LLM settings');
      })
      .finally(() => setLlmSaving(false));
  };

  const handleLlmTest = () => {
    setLlmTesting(true);
    setLlmMessage(null);
    setLlmError(null);
    setLlmTestReply(null);
    void testLlm(llmTestQuestion)
      .then(result => {
        setLlmTestReply(result.reply);
      })
      .catch(error => {
        setLlmError(error instanceof Error ? error.message : 'Could not test LLM');
      })
      .finally(() => setLlmTesting(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">LLM settings</div>
      <form className="command-settings-form" onSubmit={handleLlmSubmit}>
        <label className="command-enabled">
          <input
            type="checkbox"
            checked={llmSettings.enabled}
            disabled={llmLoading || llmSaving}
            onChange={event => setLlmSettings(current => ({ ...current, enabled: event.target.checked }))}
          />
          <span>Enabled</span>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={llmSettings.baseUrl}
            disabled={llmLoading || llmSaving}
            placeholder="http://localhost:1234/v1"
            onChange={event => setLlmSettings(current => ({ ...current, baseUrl: event.target.value }))}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            value={llmSettings.model}
            disabled={llmLoading || llmSaving}
            placeholder="Loaded LM Studio model identifier"
            onChange={event => setLlmSettings(current => ({ ...current, model: event.target.value }))}
          />
        </label>

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={llmSettings.apiKey ?? ''}
            disabled={llmLoading || llmSaving || llmSettings.clearApiKey}
            placeholder={llmSettings.apiKeyConfigured ? 'Configured - leave blank to keep' : 'Optional for LM Studio'}
            onChange={event => setLlmSettings(current => ({ ...current, apiKey: event.target.value, clearApiKey: false }))}
          />
        </label>

        <label className="command-enabled">
          <input
            type="checkbox"
            checked={llmSettings.clearApiKey === true}
            disabled={llmLoading || llmSaving || !llmSettings.apiKeyConfigured}
            onChange={event => setLlmSettings(current => ({ ...current, clearApiKey: event.target.checked, apiKey: '' }))}
          />
          <span>Clear stored API key</span>
        </label>

        <label className="field">
          <span>Personality prompt</span>
          <textarea
            value={llmSettings.personalityPrompt}
            disabled={llmLoading || llmSaving}
            maxLength={2000}
            rows={5}
            placeholder="Be silly, lightly snarky, concise, and stream-chat friendly."
            onChange={event => setLlmSettings(current => ({ ...current, personalityPrompt: event.target.value }))}
          />
          <small>{llmSettings.personalityPrompt.length}/2000</small>
        </label>

        <div className="llm-settings-grid">
          <label className="field">
            <span>Temperature</span>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={llmSettings.temperature}
              disabled={llmLoading || llmSaving}
              onChange={event => setLlmSettings(current => ({ ...current, temperature: Number(event.target.value) }))}
            />
          </label>

          <label className="field">
            <span>Max output tokens (0 = unlimited)</span>
            <input
              type="number"
              min="0"
              max="8192"
              step="1"
              value={llmSettings.maxOutputTokens}
              disabled={llmLoading || llmSaving}
              onChange={event => setLlmSettings(current => ({ ...current, maxOutputTokens: Number(event.target.value) }))}
            />
          </label>

          <label className="field">
            <span>Timeout ms</span>
            <input
              type="number"
              min="1000"
              max="60000"
              step="500"
              value={llmSettings.timeoutMs}
              disabled={llmLoading || llmSaving}
              onChange={event => setLlmSettings(current => ({ ...current, timeoutMs: Number(event.target.value) }))}
            />
          </label>
        </div>

        <div className="command-example">
          LM Studio default: <code>http://localhost:1234/v1</code>. Use <code>!ponder why is CSS like this?</code>
        </div>

        <div className="llm-test-panel">
          <label className="field">
            <span>Test question</span>
            <input
              value={llmTestQuestion}
              disabled={llmLoading || llmSaving || llmTesting}
              maxLength={500}
              onChange={event => setLlmTestQuestion(event.target.value)}
            />
          </label>
          <div className="command-settings-actions">
            <button
              className="modbtn"
              type="button"
              disabled={llmLoading || llmSaving || llmTesting}
              onClick={handleLlmTest}
            >
              {llmTesting ? 'Testing...' : 'Test LLM'}
            </button>
          </div>
          {llmTestReply && <div className="llm-test-reply">{llmTestReply}</div>}
        </div>

        {(llmMessage || llmError) && (
          <div className={'command-settings-status' + (llmError ? ' error' : '')}>
            {llmError ?? llmMessage}
          </div>
        )}

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={llmLoading || llmSaving}>
            {llmSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
