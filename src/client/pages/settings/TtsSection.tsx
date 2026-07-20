import React, { useEffect, useState } from 'react';
import type { TtsSettings, TtsVoice } from '../../../shared/api';
import type { TtsStatus } from '../../services/dashboard';
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
import { SettingsStatus, SettingsToggleLabel, useSettingsForm } from './shared';

const DEFAULT_TENGWAR_URL = 'http://127.0.0.1:8008';

/**
 * Where Tengwar lives, and whether we can reach it. This is `app_config`, not TTS
 * settings — it saves through PUT /api/config like the rest of Connections did — but it
 * belongs next to the voice it serves: the URL, the reachability check, and the voice
 * list it supplies are one thing to the operator, and splitting them across two settings
 * pages meant a broken voice list gave no hint that the address was wrong.
 */
function TengwarService({
  status,
  enabled,
  onSaved,
}: {
  status: TtsStatus | null;
  /** Whether the TTS module is on. Off means nothing here has been probed. */
  enabled: boolean;
  /** Re-runs the reachability check and reloads the voice list from the new address. */
  onSaved: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_TENGWAR_URL);
  // Never populated from the server: the key is a secret, so the API reports only
  // whether one is set. Blank means "keep what's stored", matching every other
  // secret field in Settings.
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppConfig()
      .then(config => {
        if (cancelled) return;
        setBaseUrl(config.tengwarBaseUrl);
        setApiKeyConfigured(config.tengwarApiKeyConfigured);
      })
      .catch(caught => {
        if (!cancelled) setError(errorMessage(caught, 'Could not load the Tengwar URL'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    // Only the Tengwar keys are sent: every other key is left undefined, and the server
    // keeps its stored value for those. Sending the whole config from here would let a
    // stale form overwrite settings this page doesn't show.
    void updateAppConfig({ tengwarBaseUrl: baseUrl, ...(apiKey ? { tengwarApiKey: apiKey } : {}) })
      .then(config => {
        setBaseUrl(config.tengwarBaseUrl);
        setApiKeyConfigured(config.tengwarApiKeyConfigured);
        setApiKey('');
        setMessage(enabled ? 'Saved — rechecking the service.' : 'Saved.');
        onSaved();
      })
      .catch(caught => setError(errorMessage(caught, 'Could not save the Tengwar URL')))
      .finally(() => setSaving(false));
  };

  const handleClearApiKey = () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    void updateAppConfig({ clearTengwarApiKey: true })
      .then(config => {
        setApiKeyConfigured(config.tengwarApiKeyConfigured);
        setApiKey('');
        setMessage('API key cleared.');
      })
      .catch(caught => setError(errorMessage(caught, 'Could not clear the Tengwar API key')))
      .finally(() => setSaving(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Tengwar service</div>

      <form className="command-settings-form" onSubmit={handleSubmit}>
        {/* With TTS off there is no status to show, because nothing was probed —
            rendering "unavailable" would read as a fault rather than a choice. */}
        {!enabled ? (
          <div className="settings-alert settings-alert--info">
            <span className="settings-alert-icon">i</span>
            <span>Text-to-Speech is off — Tengwar is not being contacted. Enable it below to check the connection and load voices.</span>
          </div>
        ) : status && (
          <div className={'settings-alert ' + (status.ok ? 'settings-alert--info' : 'settings-alert--warn')}>
            <span className="settings-alert-icon">{status.ok ? 'i' : '!'}</span>
            <span>
              Tengwar {status.ok ? 'connected' : 'unavailable'}
              {status.baseUrl ? ` at ${status.baseUrl}` : ''}
              {!status.ok && status.error ? `: ${status.error}` : ''}
            </span>
          </div>
        )}

        <label className="field">
          <span>Tengwar URL</span>
          <input
            value={baseUrl}
            disabled={loading || saving}
            placeholder={DEFAULT_TENGWAR_URL}
            onChange={event => setBaseUrl(event.target.value)}
          />
          <small>Full address of the Tengwar speech service, port included — {DEFAULT_TENGWAR_URL}, or a Tailscale address. It supplies the voices below.</small>
        </label>

        <label className="field">
          <span>API key {apiKeyConfigured ? '(set)' : '(optional)'}</span>
          <input
            type="password"
            value={apiKey}
            disabled={loading || saving}
            placeholder={apiKeyConfigured ? 'Stored — leave blank to keep' : 'Leave blank if Tengwar has no key'}
            onChange={event => setApiKey(event.target.value)}
          />
          <small>Sent as X-Api-Key. Only needed if Tengwar was started with a key configured.</small>
        </label>

        <SettingsStatus message={message} error={error} />

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={loading || saving}>
            {saving ? 'Saving...' : 'Save service'}
          </button>
          {apiKeyConfigured && (
            <button className="modbtn" type="button" disabled={loading || saving} onClick={handleClearApiKey}>
              Clear API key
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function TtsSection() {
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestText, setTtsTestText] = useState('Hello, I am your stream assistant.');

  /**
   * Probes Tengwar and reloads its voice list. Both endpoints are gated server-side
   * too; the guards at each call site are what keep a disabled module from even
   * issuing the request.
   */
  const loadService = React.useCallback(async () => {
    const [voices, status] = await Promise.all([
      getTtsVoices().catch(() => [] as TtsVoice[]),
      getTtsStatus().catch(error => ({ ok: false, baseUrl: '', error: errorMessage(error, 'Could not reach Tengwar') } as TtsStatus)),
    ]);
    return { voices, status };
  }, []);

  const ttsForm = useSettingsForm<TtsSettings>({
    initial: {
      enabled: false,
      voiceProfileId: 'usFemale',
      languageId: 'en',
      volume: 0.8,
      updatedAt: null,
    },
    // Sequential, not Promise.all: the settings have to resolve first, because whether
    // we are allowed to touch Tengwar at all is one of the things they say. The old
    // parallel load fired the probe before `enabled` was known.
    load: async cancelled => {
      const settings = await getTtsSettings();
      if (cancelled()) return settings;
      if (!settings.enabled) {
        setTtsVoices([]);
        setTtsStatus(null);
        return settings;
      }
      const { voices, status } = await loadService();
      if (!cancelled()) {
        setTtsVoices(voices);
        setTtsStatus(status);
      }
      return settings;
    },
    loadError: 'Could not load TTS settings',
    save: settings => updateTtsSettings({
      enabled: settings.enabled,
      voiceProfileId: settings.voiceProfileId,
      languageId: settings.languageId,
      volume: settings.volume,
    }),
    saveError: 'Could not save TTS settings',
  });
  const ttsSettings = ttsForm.value;
  const setTtsSettings = ttsForm.setValue;
  const { loading: ttsLoading, saving: ttsSaving, message: ttsMessage, error: ttsError } = ttsForm;
  const ttsEnabled = ttsSettings.enabled;

  // Called after the service address changes. A no-op while TTS is off: saving the
  // URL must not become a back door to connecting.
  const refreshService = React.useCallback(() => {
    if (!ttsEnabled) {
      setTtsVoices([]);
      setTtsStatus(null);
      return;
    }
    void loadService().then(({ voices, status }) => {
      setTtsVoices(voices);
      setTtsStatus(status);
    });
  }, [ttsEnabled, loadService]);

  const handleTtsSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    ttsForm.submit(ttsSettings, 'TTS settings saved.');
  };

  const handleTtsEnabledToggle = (enabled: boolean) => {
    const next = { ...ttsForm.confirmed, enabled };
    setTtsSettings(next);
    ttsForm.submit(next, enabled ? 'Text-to-Speech enabled.' : 'Text-to-Speech disabled.');
    // Enabling is the moment the operator authorizes a connection, so this is where
    // the first probe belongs. Disabling drops what we knew, rather than leaving a
    // stale "connected" badge beside a switched-off module.
    if (enabled) {
      void loadService().then(({ voices, status }) => {
        setTtsVoices(voices);
        setTtsStatus(status);
      });
    } else {
      setTtsVoices([]);
      setTtsStatus(null);
    }
  };

  const handleTtsTest = () => {
    setTtsTesting(true);
    ttsForm.setMessage(null);
    ttsForm.setError(null);
    void testTtsSpeak(ttsTestText)
      .then(() => {
        ttsForm.setMessage('Sent — check the /overlay/sounds browser source for audio.');
      })
      .catch(error => {
        ttsForm.setError(errorMessage(error, 'TTS test failed'));
      })
      .finally(() => setTtsTesting(false));
  };

  return (
    <>
    <TengwarService status={ttsStatus} enabled={ttsEnabled} onSaved={refreshService} />

    <div className="set-group">
      <SettingsToggleLabel
        label="Text-to-Speech"
        toggleLabel="Enable Text-to-Speech"
        checked={ttsEnabled}
        disabled={ttsLoading || ttsSaving}
        onChange={handleTtsEnabledToggle}
      />

      {!ttsEnabled && (ttsMessage || ttsError) && (
        <div className="set-group-note">
          <SettingsStatus message={ttsMessage} error={ttsError} />
        </div>
      )}

      {ttsEnabled && (
      <form className="command-settings-form" onSubmit={handleTtsSubmit}>
        <label className="field">
          <span>Voice</span>
          {/* The list comes from Tengwar, so an empty one means the service is
              unreachable — not that the operator has no voices to choose from. */}
          {ttsVoices.length === 0 ? (
            <>
              <select value="" disabled>
                <option value="">No voices — Tengwar unreachable</option>
              </select>
              <small>Check the Tengwar URL above, then save to retry.</small>
            </>
          ) : (
            <select
              value={ttsSettings.voiceProfileId}
              disabled={ttsLoading || ttsSaving}
              onChange={event => setTtsSettings(current => ({ ...current, voiceProfileId: event.target.value }))}
            >
              {ttsVoices.map(voice => (
                <option key={voice.id} value={voice.id}>{voice.name}</option>
              ))}
            </select>
          )}
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
          Triggered via <code>!tts &lt;text&gt;</code> (broadcaster/mod/VIP) or per channel point reward. Audio plays through the <code>/overlay/sounds</code> browser source using the Tengwar service.
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

        <SettingsStatus message={ttsMessage} error={ttsError} />

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
