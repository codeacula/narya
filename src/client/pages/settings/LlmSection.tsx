import React, { useEffect, useRef, useState } from 'react';
import type { LlmApiFormat, LlmProviderId, LlmProviderProfile, LlmSettings, LlmSettingsUpdate } from '../../../shared/api';
import { getLlmProviderModels, getLlmSettings, testLlm, updateLlmSettings } from '../../services/dashboard';
import { errorMessage } from '../../errors';
import { SettingsAnnouncer, SettingsStatus, SettingsToggleLabel, useSettingsForm } from './shared';

/** One provider's editable fields. A stored key is never sent back; `apiKey` is a new one. */
type ProviderDraft = LlmProviderProfile & {
  apiKey: string;
  clearApiKey: boolean;
};

type LlmSettingsForm = {
  enabled: boolean;
  /** The provider the dropdown shows; Save makes it the active one. */
  selectedProvider: LlmProviderId;
  providers: ProviderDraft[];
  personalityPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedAt: string | null;
};

const EMPTY_LLM_SETTINGS: LlmSettingsForm = {
  enabled: false,
  selectedProvider: 'local',
  providers: [],
  personalityPrompt: '',
  temperature: 0.7,
  maxOutputTokens: 2048,
  timeoutMs: 15000,
  updatedAt: null,
};

const FORMAT_LABELS: Record<LlmApiFormat, string> = {
  responses: 'Responses',
  chat_completions: 'Chat Completions',
};

type ModelListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; models: string[] }
  | { status: 'failed'; error: string };

function toLlmForm(settings: LlmSettings): LlmSettingsForm {
  return {
    enabled: settings.enabled,
    selectedProvider: settings.activeProvider,
    providers: settings.providers.map(provider => ({ ...provider, apiKey: '', clearApiKey: false })),
    personalityPrompt: settings.personalityPrompt,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    updatedAt: settings.updatedAt,
  };
}

function findDraft(form: LlmSettingsForm, id: LlmProviderId): ProviderDraft | undefined {
  return form.providers.find(provider => provider.id === id);
}

/** The request a Save or a Test sends: the selected provider's draft plus the shared fields. */
function toSettingsUpdate(form: LlmSettingsForm): LlmSettingsUpdate | null {
  const draft = findDraft(form, form.selectedProvider);
  if (!draft) return null;
  return {
    enabled: form.enabled,
    activeProvider: form.selectedProvider,
    provider: {
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiFormat: draft.apiFormat,
      apiKey: draft.apiKey,
      clearApiKey: draft.clearApiKey,
    },
    personalityPrompt: form.personalityPrompt,
    temperature: form.temperature,
    maxOutputTokens: form.maxOutputTokens,
    timeoutMs: form.timeoutMs,
  };
}

/** The select's value for "the box holds a name the provider didn't list". */
const CUSTOM_MODEL = '__custom__';

/** Which select option matches the identifier box, so the two always agree. */
function modelSelectValue(model: string, models: string[]): string {
  if (!model) return '';
  return models.includes(model) ? model : CUSTOM_MODEL;
}

function apiKeyPlaceholder(draft: ProviderDraft): string {
  if (draft.apiKeyConfigured) return 'Configured - leave blank to keep';
  return draft.requiresApiKey ? 'Required' : 'Optional';
}

function idleModelHint(saved: ProviderDraft): string {
  if (!saved.baseUrl) return 'Save a base URL to load models.';
  return 'Save an API key to load models.';
}

export function LlmSection() {
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestQuestion, setLlmTestQuestion] = useState('why is CSS like this?');
  const [llmTestReply, setLlmTestReply] = useState<string | null>(null);
  const [modelList, setModelList] = useState<ModelListState>({ status: 'idle' });
  const modelInputRef = useRef<HTMLInputElement>(null);

  const llmForm = useSettingsForm<LlmSettingsForm>({
    initial: EMPTY_LLM_SETTINGS,
    load: () => getLlmSettings().then(toLlmForm),
    loadError: 'Could not load LLM settings',
    save: form => {
      const update = toSettingsUpdate(form);
      if (!update) return Promise.reject(new Error('Choose a provider first.'));
      return updateLlmSettings(update).then(toLlmForm);
    },
    saveError: 'Could not save LLM settings',
    unsavedLabel: 'the AI settings',
  });
  const llmSettings = llmForm.value;
  const setLlmSettings = llmForm.setValue;
  const { loading: llmLoading, saving: llmSaving, message: llmMessage, error: llmError } = llmForm;
  const busy = llmLoading || llmSaving;
  // Whether there is anything to reset — the same comparison the unsaved-edit guard uses.
  const dirty = llmForm.dirty;

  const draft = findDraft(llmSettings, llmSettings.selectedProvider);
  // Model loading follows what the server has stored, not unsaved typing: the server
  // fetches the list with the saved URL and key, so a half-typed URL must not trigger it.
  const saved = findDraft(llmForm.confirmed, llmSettings.selectedProvider);
  const canLoadModels = Boolean(saved && saved.baseUrl && (!saved.requiresApiKey || saved.apiKeyConfigured));
  const savedId = saved?.id;

  useEffect(() => {
    if (!llmSettings.enabled || !savedId || !canLoadModels) {
      setModelList({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setModelList({ status: 'loading' });
    getLlmProviderModels(savedId)
      .then(result => {
        if (cancelled) return;
        setModelList(result.ok ? { status: 'loaded', models: result.models } : { status: 'failed', error: result.error });
      })
      .catch(caught => {
        if (!cancelled) setModelList({ status: 'failed', error: errorMessage(caught, 'request failed') });
      });
    return () => { cancelled = true; };
  // Re-runs on a provider switch and after every successful save (updatedAt moves).
  }, [llmSettings.enabled, savedId, canLoadModels, llmForm.confirmed.updatedAt]);

  const updateDraft = (changes: Partial<ProviderDraft>) => {
    setLlmSettings(current => ({
      ...current,
      providers: current.providers.map(provider => (
        provider.id === current.selectedProvider ? { ...provider, ...changes } : provider
      )),
    }));
  };

  const handleLlmSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    llmForm.submit(llmSettings, 'Saved');
  };

  // The toggle saves from the confirmed value, which replaces the form — so unsaved
  // edits would vanish with it. Ask first, as leaving the section would.
  const handleLlmEnabledToggle = (enabled: boolean) => llmForm.discardThen(() => {
    const next = { ...llmForm.confirmed, enabled };
    setLlmSettings(next);
    llmForm.submit(next, enabled ? 'LLM enabled.' : 'LLM disabled.');
  });

  const handleLlmReset = () => {
    setLlmSettings(llmForm.confirmed);
    llmForm.setMessage(null);
    llmForm.setError(null);
    setLlmTestReply(null);
  };

  const handleLlmTest = () => {
    setLlmTesting(true);
    llmForm.setMessage(null);
    llmForm.setError(null);
    setLlmTestReply(null);
    const settings = toSettingsUpdate(llmSettings) ?? undefined;
    void testLlm({ question: llmTestQuestion, settings })
      .then(result => {
        setLlmTestReply(result.reply);
      })
      .catch(error => {
        llmForm.setError(errorMessage(error, 'Could not test LLM'));
      })
      .finally(() => setLlmTesting(false));
  };

  return (
    <div className="set-group">
      <SettingsToggleLabel
        label="LLM settings"
        toggleLabel="Enable LLM"
        checked={llmSettings.enabled}
        disabled={busy}
        onChange={handleLlmEnabledToggle}
      />

      {/* The switch swaps the form below in and out, so neither branch can hold the
          live regions: "disabled." would arrive with the region that announces it.
          One announcer sits outside both, and each branch only draws its line. */}
      <SettingsAnnouncer message={llmMessage} error={llmError} />

      {!llmSettings.enabled && (llmMessage || llmError) && (
        <div className="set-group-note">
          <SettingsStatus message={llmMessage} error={llmError} announce={false} />
        </div>
      )}

      {llmSettings.enabled && (
      <form className="command-settings-form" onSubmit={handleLlmSubmit}>
        <label className="field">
          <span>Provider</span>
          <select
            value={llmSettings.selectedProvider}
            disabled={busy}
            onChange={event => setLlmSettings(current => ({ ...current, selectedProvider: event.target.value as LlmProviderId }))}
          >
            {llmSettings.providers.map(provider => (
              <option key={provider.id} value={provider.id}>{provider.label}</option>
            ))}
          </select>
          {llmForm.confirmed.selectedProvider !== llmSettings.selectedProvider && (
            <small>Save to switch to this provider.</small>
          )}
        </label>

        {draft && (
          <>
            <label className="field">
              <span>Base URL</span>
              <input
                value={draft.baseUrl}
                disabled={busy}
                placeholder="https://example.com/v1"
                onChange={event => updateDraft({ baseUrl: event.target.value })}
              />
            </label>

            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={draft.apiKey}
                disabled={busy || draft.clearApiKey}
                placeholder={apiKeyPlaceholder(draft)}
                onChange={event => updateDraft({ apiKey: event.target.value, clearApiKey: false })}
              />
            </label>

            <label className="command-enabled">
              <input
                type="checkbox"
                checked={draft.clearApiKey}
                disabled={busy || !draft.apiKeyConfigured}
                onChange={event => updateDraft({ clearApiKey: event.target.checked, apiKey: '' })}
              />
              <span>Clear stored API key</span>
            </label>

            <label className="field">
              <span>API format</span>
              <select
                value={draft.apiFormat}
                disabled={busy}
                onChange={event => updateDraft({ apiFormat: event.target.value as LlmApiFormat })}
              >
                {(Object.keys(FORMAT_LABELS) as LlmApiFormat[]).map(format => (
                  <option key={format} value={format}>{FORMAT_LABELS[format]}</option>
                ))}
              </select>
            </label>

            {/* A div, not a label: it holds two controls, and a label would only focus the first. */}
            <div className="field">
              <span id="llm-model-label">Model</span>
              {modelList.status === 'loaded' && modelList.models.length > 0 && (
                <select
                  aria-labelledby="llm-model-label"
                  value={modelSelectValue(draft.model, modelList.models)}
                  disabled={busy}
                  onChange={event => {
                    if (event.target.value === CUSTOM_MODEL) {
                      // The select mirrors the box, so a listed name in the box would snap
                      // it straight back: clear that one. An already-custom name is kept.
                      if (modelList.models.includes(draft.model)) updateDraft({ model: '' });
                      modelInputRef.current?.focus();
                      return;
                    }
                    updateDraft({ model: event.target.value });
                  }}
                >
                  <option value="" disabled>Choose a model…</option>
                  {modelList.models.map(model => <option key={model} value={model}>{model}</option>)}
                  <option value={CUSTOM_MODEL}>Custom model…</option>
                </select>
              )}
              <input
                ref={modelInputRef}
                aria-label="Model identifier"
                value={draft.model}
                disabled={busy}
                placeholder="Model identifier"
                onChange={event => updateDraft({ model: event.target.value })}
              />
              <small>
                {modelList.status === 'loading' && 'Loading models…'}
                {modelList.status === 'loaded' && `${modelList.models.length} models loaded`}
                {modelList.status === 'failed' && `Couldn't load models: ${modelList.error}`}
                {modelList.status === 'idle' && saved && !canLoadModels && idleModelHint(saved)}
              </small>
            </div>
          </>
        )}

        <label className="field">
          <span>Personality prompt</span>
          <textarea
            value={llmSettings.personalityPrompt}
            disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
              onChange={event => setLlmSettings(current => ({ ...current, timeoutMs: Number(event.target.value) }))}
            />
          </label>
        </div>

        <div className="command-example">
          Used by <code>llm_response</code> Action steps. Test LLM tries the form as shown without saving; Save makes the selected provider active.
        </div>

        <div className="llm-test-panel">
          <label className="field">
            <span>Test question</span>
            <input
              value={llmTestQuestion}
              disabled={busy || llmTesting}
              maxLength={500}
              onChange={event => setLlmTestQuestion(event.target.value)}
            />
          </label>
          <div className="command-settings-actions">
            <button
              className="modbtn"
              type="button"
              disabled={busy || llmTesting}
              onClick={handleLlmTest}
            >
              {llmTesting ? 'Testing...' : 'Test LLM'}
            </button>
          </div>
          {llmTestReply && <div className="llm-test-reply">{llmTestReply}</div>}
        </div>

        <SettingsStatus message={llmMessage} error={llmError} announce={false} />

        <div className="command-settings-actions">
          <button className="modbtn" type="button" disabled={busy || !dirty} onClick={handleLlmReset}>
            Reset
          </button>
          <button className="modbtn gold" type="submit" disabled={busy}>
            {llmSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
