import React, { useEffect, useState } from 'react';
import type { TtsSettings, TtsVoice } from '../../../shared/api';
import { TTS_TONE_PRESETS } from '../../../shared/tts';
import {
  getTtsSettings,
  getTtsStatus,
  getTtsVoices,
  testTtsSpeak,
  updateTtsSettings,
} from '../../services/dashboard';

type TtsStatus = {
  ok: boolean;
  baseUrl: string;
  error?: string;
};

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
      getTtsStatus().catch(error => ({ ok: false, baseUrl: '', error: error instanceof Error ? error.message : 'Could not reach Chatterbox' })),
    ])
      .then(([settings, voices, status]) => {
        if (!cancelled) {
          setTtsSettings(settings);
          setTtsVoices(voices);
          setTtsStatus(status);
          setTtsError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setTtsError(error instanceof Error ? error.message : 'Could not load TTS settings');
      })
      .finally(() => {
        if (!cancelled) setTtsLoading(false);
      });
    return () => { cancelled = true; };
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
        setTtsSettings(saved);
        setTtsMessage(successMessage);
      })
      .catch(error => {
        setTtsSettings(ttsSettings);
        setTtsError(error instanceof Error ? error.message : 'Could not save TTS settings');
      })
      .finally(() => setTtsSaving(false));
  };

  const handleTtsSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveTtsSettings(ttsSettings, 'TTS settings saved.');
  };

  const handleTtsEnabledToggle = (enabled: boolean) => {
    const next = { ...ttsSettings, enabled };
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
        setTtsError(error instanceof Error ? error.message : 'TTS test failed');
      })
      .finally(() => setTtsTesting(false));
  };

  return (
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
        {ttsStatus && (
          <div className={'settings-alert ' + (ttsStatus.ok ? 'settings-alert--info' : 'settings-alert--warn')}>
            <span className="settings-alert-icon">{ttsStatus.ok ? 'i' : '!'}</span>
            <span>
              Chatterbox service {ttsStatus.ok ? 'connected' : 'unavailable'}
              {ttsStatus.baseUrl ? ` at ${ttsStatus.baseUrl}` : ''}
              {!ttsStatus.ok && ttsStatus.error ? `: ${ttsStatus.error}` : ''}
            </span>
          </div>
        )}

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
  );
}
