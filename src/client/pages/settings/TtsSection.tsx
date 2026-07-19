import React, { useEffect, useRef, useState } from 'react';
import type { TtsSettings, TtsVoice } from '../../../shared/api';
import { TTS_TONE_PRESETS } from '../../../shared/tts';
import {
  getAppConfig,
  getTtsSettings,
  getTtsStatus,
  getTtsVoices,
  testTtsSpeak,
  updateAppConfig,
  updateTtsSettings,
} from '../../services/dashboard';
import { errorMessage } from '../../errors';

type TtsStatus = {
  ok: boolean;
  baseUrl: string;
  error?: string;
};

const DEFAULT_CHATTERBOX_URL = 'http://127.0.0.1:8008';

/**
 * Where Chatterbox lives, and whether we can reach it. This is `app_config`, not TTS
 * settings — it saves through PUT /api/config like the rest of Connections did — but it
 * belongs next to the voice it serves: the URL, the reachability check, and the voice
 * list it supplies are one thing to the operator, and splitting them across two settings
 * pages meant a broken voice list gave no hint that the address was wrong.
 */
function ChatterboxService({
  status,
  onSaved,
}: {
  status: TtsStatus | null;
  /** Re-runs the reachability check and reloads the voice list from the new address. */
  onSaved: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CHATTERBOX_URL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppConfig()
      .then(config => { if (!cancelled) setBaseUrl(config.chatterboxBaseUrl); })
      .catch(caught => {
        if (!cancelled) setError(errorMessage(caught, 'Could not load the Chatterbox URL'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    // Only chatterboxBaseUrl is sent: every other key is left undefined, and the server
    // keeps its stored value for those. Sending the whole config from here would let a
    // stale form overwrite settings this page doesn't show.
    void updateAppConfig({ chatterboxBaseUrl: baseUrl })
      .then(config => {
        setBaseUrl(config.chatterboxBaseUrl);
        setMessage('Saved — rechecking the service.');
        onSaved();
      })
      .catch(caught => setError(errorMessage(caught, 'Could not save the Chatterbox URL')))
      .finally(() => setSaving(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Chatterbox service</div>

      <form className="command-settings-form" onSubmit={handleSubmit}>
        {status && (
          <div className={'settings-alert ' + (status.ok ? 'settings-alert--info' : 'settings-alert--warn')}>
            <span className="settings-alert-icon">{status.ok ? 'i' : '!'}</span>
            <span>
              Chatterbox {status.ok ? 'connected' : 'unavailable'}
              {status.baseUrl ? ` at ${status.baseUrl}` : ''}
              {!status.ok && status.error ? `: ${status.error}` : ''}
            </span>
          </div>
        )}

        <label className="field">
          <span>Chatterbox URL</span>
          <input
            value={baseUrl}
            disabled={loading || saving}
            placeholder={DEFAULT_CHATTERBOX_URL}
            onChange={event => setBaseUrl(event.target.value)}
          />
          <small>The Chatterbox server that renders every voice line. It supplies the voice profiles below.</small>
        </label>

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>
            {error ?? message}
          </div>
        )}

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={loading || saving}>
            {saving ? 'Saving...' : 'Save service'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TtsSection() {
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>({
    enabled: false,
    voiceProfileId: 'zombiechicken',
    languageId: 'en',
    tonePreset: 'neutral',
    exaggeration: 0.5,
    cfgWeight: 0.5,
    temperature: 0.8,
    volume: 0.8,
    updatedAt: null,
  });
  // Last settings the server confirmed; the enable toggle saves from this so it
  // never commits unsaved form edits.
  const savedTts = useRef<TtsSettings | null>(null);
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [ttsLoading, setTtsLoading] = useState(true);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestText, setTtsTestText] = useState('Hello, I am your stream assistant.');
  const [ttsMessage, setTtsMessage] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTtsLoading(true);
    void Promise.all([
      getTtsSettings(),
      getTtsVoices().catch(() => [] as TtsVoice[]),
      getTtsStatus().catch(error => ({ ok: false, baseUrl: '', error: errorMessage(error, 'Could not reach Chatterbox') })),
    ])
      .then(([settings, voices, status]) => {
        if (!cancelled) {
          savedTts.current = settings;
          setTtsSettings(settings);
          setTtsVoices(voices);
          setTtsStatus(status);
          setTtsError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setTtsError(errorMessage(error, 'Could not load TTS settings'));
      })
      .finally(() => {
        if (!cancelled) setTtsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Re-probe Chatterbox and reload its voice list — the address may have just changed.
  const refreshService = React.useCallback(() => {
    void Promise.all([
      getTtsVoices().catch(() => [] as TtsVoice[]),
      getTtsStatus().catch(error => ({ ok: false, baseUrl: '', error: errorMessage(error, 'Could not reach Chatterbox') })),
    ]).then(([voices, status]) => {
      setTtsVoices(voices);
      setTtsStatus(status);
    });
  }, []);

  const saveTtsSettings = (settings: TtsSettings, successMessage: string) => {
    setTtsSaving(true);
    setTtsMessage(null);
    setTtsError(null);
    void updateTtsSettings({
      enabled: settings.enabled,
      voiceProfileId: settings.voiceProfileId,
      languageId: settings.languageId,
      tonePreset: settings.tonePreset,
      exaggeration: settings.exaggeration,
      cfgWeight: settings.cfgWeight,
      temperature: settings.temperature,
      volume: settings.volume,
    })
      .then(saved => {
        savedTts.current = saved;
        setTtsSettings(saved);
        setTtsMessage(successMessage);
      })
      .catch(error => {
        setTtsSettings(ttsSettings);
        setTtsError(errorMessage(error, 'Could not save TTS settings'));
      })
      .finally(() => setTtsSaving(false));
  };

  const handleTtsSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveTtsSettings(ttsSettings, 'TTS settings saved.');
  };

  const handleTtsEnabledToggle = (enabled: boolean) => {
    const next = { ...(savedTts.current ?? ttsSettings), enabled };
    setTtsSettings(next);
    saveTtsSettings(next, enabled ? 'Text-to-Speech enabled.' : 'Text-to-Speech disabled.');
  };

  const handleTtsTest = () => {
    setTtsTesting(true);
    setTtsMessage(null);
    setTtsError(null);
    void testTtsSpeak(ttsTestText)
      .then(() => {
        setTtsMessage('Sent — check the /overlay/sounds browser source for audio.');
      })
      .catch(error => {
        setTtsError(errorMessage(error, 'TTS test failed'));
      })
      .finally(() => setTtsTesting(false));
  };

  return (
    <>
    <ChatterboxService status={ttsStatus} onSaved={refreshService} />

    <div className="set-group">
      <div className="set-group-label set-group-label--toggle">
        <span>Text-to-Speech</span>
        <input
          className="set-group-toggle"
          type="checkbox"
          aria-label="Enable Text-to-Speech"
          checked={ttsSettings.enabled}
          disabled={ttsLoading || ttsSaving}
          onChange={event => handleTtsEnabledToggle(event.target.checked)}
        />
      </div>

      {!ttsSettings.enabled && (ttsMessage || ttsError) && (
        <div className="set-group-note">
          <div className={'command-settings-status' + (ttsError ? ' error' : '')}>
            {ttsError ?? ttsMessage}
          </div>
        </div>
      )}

      {ttsSettings.enabled && (
      <form className="command-settings-form" onSubmit={handleTtsSubmit}>
        <label className="field">
          <span>Voice profile</span>
          <select
            value={ttsSettings.voiceProfileId}
            disabled={ttsLoading || ttsSaving || ttsVoices.length === 0}
            onChange={event => setTtsSettings(current => ({ ...current, voiceProfileId: event.target.value }))}
          >
            {ttsVoices.map(voice => (
              <option key={voice.id} value={voice.id}>{voice.name} ({voice.category})</option>
            ))}
          </select>
        </label>

        <div className="llm-settings-grid">
          <label className="field">
            <span>Language</span>
            <input
              value={ttsSettings.languageId}
              disabled={ttsLoading || ttsSaving}
              maxLength={12}
              onChange={event => setTtsSettings(current => ({ ...current, languageId: event.target.value }))}
            />
          </label>

          <label className="field">
            <span>Tone preset</span>
            <select
              value={ttsSettings.tonePreset}
              disabled={ttsLoading || ttsSaving}
              onChange={event => {
                const tonePreset = event.target.value as keyof typeof TTS_TONE_PRESETS;
                const preset = TTS_TONE_PRESETS[tonePreset] ?? TTS_TONE_PRESETS.neutral;
                setTtsSettings(current => ({ ...current, tonePreset, ...preset }));
              }}
            >
              <option value="neutral">Neutral</option>
              <option value="calm">Calm</option>
              <option value="expressive">Expressive</option>
              <option value="dramatic">Dramatic</option>
            </select>
          </label>
        </div>

        <div className="llm-settings-grid">
          <label className="field">
            <span>Exaggeration</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={ttsSettings.exaggeration}
              disabled={ttsLoading || ttsSaving}
              onChange={event => setTtsSettings(current => ({ ...current, exaggeration: Number(event.target.value) }))}
            />
          </label>

          <label className="field">
            <span>CFG weight</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={ttsSettings.cfgWeight}
              disabled={ttsLoading || ttsSaving}
              onChange={event => setTtsSettings(current => ({ ...current, cfgWeight: Number(event.target.value) }))}
            />
          </label>
        </div>

        <div className="llm-settings-grid">
          <label className="field">
            <span>Temperature</span>
            <input
              type="number"
              min="0.05"
              max="1.5"
              step="0.05"
              value={ttsSettings.temperature}
              disabled={ttsLoading || ttsSaving}
              onChange={event => setTtsSettings(current => ({ ...current, temperature: Number(event.target.value) }))}
            />
          </label>

          <label className="field">
            <span>Volume</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={ttsSettings.volume}
              disabled={ttsLoading || ttsSaving}
              onChange={event => setTtsSettings(current => ({ ...current, volume: Number(event.target.value) }))}
            />
          </label>
        </div>

        <div className="command-example">
          Triggered via <code>!tts &lt;text&gt;</code> (broadcaster/mod/VIP) or per channel point reward. Audio plays through the <code>/overlay/sounds</code> browser source using the Chatterbox service.
        </div>

        <div className="llm-test-panel">
          <label className="field">
            <span>Test phrase</span>
            <input
              value={ttsTestText}
              disabled={ttsLoading || ttsSaving || ttsTesting}
              maxLength={500}
              onChange={event => setTtsTestText(event.target.value)}
            />
          </label>
          <div className="command-settings-actions">
            <button
              className="modbtn"
              type="button"
              disabled={ttsLoading || ttsSaving || ttsTesting}
              onClick={handleTtsTest}
            >
              {ttsTesting ? 'Sending...' : 'Test TTS'}
            </button>
          </div>
        </div>

        {(ttsMessage || ttsError) && (
          <div className={'command-settings-status' + (ttsError ? ' error' : '')}>
            {ttsError ?? ttsMessage}
          </div>
        )}

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={ttsLoading || ttsSaving}>
            {ttsSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
      )}
    </div>
    </>
  );
}
