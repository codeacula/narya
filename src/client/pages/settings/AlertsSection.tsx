import React, { useEffect, useState } from 'react';
import type {
  AlertConfig,
  AlertEventKind,
  AlertSettings,
  AlertSettingsUpdate,
  MediaFile,
  MediaKind,
  RewardMedia,
} from '../../../shared/api';
import {
  getAlertSettings,
  getMediaFiles,
  testAlert,
  updateAlertSettings,
} from '../../services/dashboard';

const DEFAULT_MEDIA_VOLUME = 0.8;

const ALERT_KIND_META: Array<{ kind: AlertEventKind; label: string; vars: string }> = [
  { kind: 'sub', label: 'Subscriptions (new & resub)', vars: '{user}, {tier}, {months}' },
  { kind: 'gift', label: 'Gift subs', vars: '{user}, {amount}' },
  { kind: 'cheer', label: 'Cheers (bits)', vars: '{user}, {amount}' },
  { kind: 'raid', label: 'Raids', vars: '{user}, {amount}' },
  { kind: 'follow', label: 'Follows', vars: '{user}' },
];

const EMPTY_CONFIG: AlertConfig = { enabled: false, template: '', durationMs: 6000, sound: null, clip: null };

function emptySettings(): AlertSettings {
  return {
    sub: { ...EMPTY_CONFIG },
    gift: { ...EMPTY_CONFIG },
    cheer: { ...EMPTY_CONFIG },
    raid: { ...EMPTY_CONFIG },
    follow: { ...EMPTY_CONFIG },
    updatedAt: null,
  };
}

/**
 * One effect slot (sound or clip). The kind is fixed, so the picker is just a
 * file select filtered to that kind plus a volume — a sound and a clip are two
 * independent slots so an alert can play both together.
 */
function AlertEffectPicker({
  label,
  kind,
  effect,
  mediaFiles,
  busy,
  onChange,
}: {
  label: string;
  kind: MediaKind;
  effect: RewardMedia | null;
  mediaFiles: MediaFile[];
  busy: boolean;
  onChange: (effect: RewardMedia | null) => void;
}) {
  const files = mediaFiles.filter(file => file.kind === kind);
  const boundFileMissing = Boolean(effect) && !mediaFiles.some(file => file.src === effect?.src);

  return (
    <div className="llm-settings-grid">
      <label className="field">
        <span>{label}</span>
        <select
          disabled={busy || (files.length === 0 && !effect)}
          value={effect?.src ?? ''}
          onChange={event => {
            const src = event.target.value;
            if (!src) { onChange(null); return; }
            onChange({ kind, src, volume: effect?.volume ?? DEFAULT_MEDIA_VOLUME });
          }}
        >
          <option value="">None</option>
          {boundFileMissing && effect && <option value={effect.src}>{effect.src} (missing)</option>}
          {files.map(file => <option key={file.src} value={file.src}>{file.label}</option>)}
        </select>
      </label>
      {effect && (
        <label className="field">
          <span>{label} volume — {Math.round(effect.volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            disabled={busy}
            value={effect.volume}
            onChange={event => onChange({ ...effect, volume: Number(event.target.value) })}
          />
        </label>
      )}
    </div>
  );
}

export function AlertsSection() {
  const [settings, setSettings] = useState<AlertSettings>(emptySettings);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingKind, setTestingKind] = useState<AlertEventKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([getAlertSettings(), getMediaFiles().catch(() => [] as MediaFile[])])
      .then(([loaded, files]) => {
        if (cancelled) return;
        setSettings(loaded);
        setMediaFiles(files);
        setError(null);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load alert settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const busy = loading || saving;

  const updateKind = (kind: AlertEventKind, patch: Partial<AlertConfig>) => {
    setSettings(current => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    const update: AlertSettingsUpdate = {};
    for (const { kind } of ALERT_KIND_META) {
      const config = settings[kind];
      update[kind] = {
        enabled: config.enabled,
        template: config.template,
        durationMs: config.durationMs,
        sound: config.sound,
        clip: config.clip,
      };
    }
    void updateAlertSettings(update)
      .then(saved => {
        setSettings(saved);
        setMessage('Alert settings saved.');
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not save alert settings'))
      .finally(() => setSaving(false));
  };

  const handleTest = (kind: AlertEventKind) => {
    setTestingKind(kind);
    setMessage(null);
    setError(null);
    // Preview the current form state, so Test works before saving.
    const config = settings[kind];
    void testAlert(kind, {
      template: config.template,
      durationMs: config.durationMs,
      sound: config.sound,
      clip: config.clip,
    })
      .then(() => setMessage(`Sent a test ${kind} alert — check the /overlay/alerts browser source.`))
      .catch(err => setError(err instanceof Error ? err.message : 'Test failed'))
      .finally(() => setTestingKind(null));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Alerts</div>

      <form className="command-settings-form" onSubmit={handleSubmit}>
        <div className="command-example">
          On-stream alerts for Twitch events, shown on the dedicated <code>/overlay/alerts</code> browser
          source — add it as its own OBS source so you can position it independently. Each type can play a
          sound and a clip together from <code>public/sounds</code> / <code>public/clips</code>.
          {' '}Audio plays automatically in OBS; a plain browser tab won't play sound until you click the
          page once (browser autoplay policy).
        </div>

        {ALERT_KIND_META.map(({ kind, label, vars }) => {
          const config = settings[kind];
          return (
            <fieldset className="alert-kind" key={kind}>
              <legend className="alert-kind-legend">
                <label className="alert-kind-toggle">
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    disabled={busy}
                    onChange={event => updateKind(kind, { enabled: event.target.checked })}
                  />
                  <span>{label}</span>
                </label>
              </legend>

              <div className="llm-settings-grid">
                <label className="field">
                  <span>Message</span>
                  <input
                    value={config.template}
                    disabled={busy}
                    maxLength={300}
                    onChange={event => updateKind(kind, { template: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Duration (seconds)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    step={0.5}
                    disabled={busy}
                    value={config.durationMs / 1000}
                    onChange={event => updateKind(kind, { durationMs: Math.round(Number(event.target.value) * 1000) })}
                  />
                </label>
              </div>

              <div className="set-sub">Variables: <code>{vars}</code></div>

              <AlertEffectPicker
                label="Sound"
                kind="audio"
                effect={config.sound}
                mediaFiles={mediaFiles}
                busy={busy}
                onChange={sound => updateKind(kind, { sound })}
              />
              <AlertEffectPicker
                label="Clip"
                kind="video"
                effect={config.clip}
                mediaFiles={mediaFiles}
                busy={busy}
                onChange={clip => updateKind(kind, { clip })}
              />

              <div className="command-settings-actions">
                <button
                  className="modbtn"
                  type="button"
                  disabled={busy || testingKind === kind}
                  onClick={() => handleTest(kind)}
                >
                  {testingKind === kind ? 'Testing…' : 'Test'}
                </button>
              </div>
            </fieldset>
          );
        })}

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>
            {error ?? message}
          </div>
        )}

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={busy}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
