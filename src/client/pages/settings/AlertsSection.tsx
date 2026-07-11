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

const EMPTY_CONFIG: AlertConfig = { enabled: false, template: '', durationMs: 6000, media: null };

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

/** Sound/clip picker lifted from the reward editor: kind → filtered file → volume. */
function AlertMediaPicker({
  media,
  mediaFiles,
  busy,
  onChange,
}: {
  media: RewardMedia | null;
  mediaFiles: MediaFile[];
  busy: boolean;
  onChange: (media: RewardMedia | null) => void;
}) {
  const mediaKind = media?.kind ?? 'none';
  const filesForKind = mediaFiles.filter(file => file.kind === mediaKind);
  const boundFileMissing = Boolean(media) && !mediaFiles.some(file => file.src === media?.src);

  // Switching kind picks the first file of that kind, so the binding's src never
  // mismatches its kind (the server would reject it).
  const applyMediaKind = (kind: 'none' | MediaKind) => {
    if (kind === 'none') {
      onChange(null);
      return;
    }
    const first = mediaFiles.find(file => file.kind === kind);
    if (!first) return;
    onChange({ kind, src: first.src, volume: media?.volume ?? DEFAULT_MEDIA_VOLUME });
  };

  return (
    <>
      <div className="llm-settings-grid">
        <label className="field">
          <span>Sound / clip</span>
          <select
            disabled={busy}
            value={mediaKind}
            onChange={event => applyMediaKind(event.target.value as 'none' | MediaKind)}
          >
            <option value="none">Nothing</option>
            <option value="video" disabled={!mediaFiles.some(f => f.kind === 'video')}>Video clip</option>
            <option value="audio" disabled={!mediaFiles.some(f => f.kind === 'audio')}>Sound</option>
          </select>
        </label>
        {media && (
          <>
            <label className="field">
              <span>File</span>
              <select
                disabled={busy}
                value={media.src}
                onChange={event => onChange({ ...media, src: event.target.value })}
              >
                {boundFileMissing && <option value={media.src}>{media.src} (missing)</option>}
                {filesForKind.map(file => <option key={file.src} value={file.src}>{file.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Volume — {Math.round(media.volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={busy}
                value={media.volume}
                onChange={event => onChange({ ...media, volume: Number(event.target.value) })}
              />
            </label>
          </>
        )}
      </div>
      {boundFileMissing && media && (
        <div className="set-sub">
          <code>{media.src}</code> is no longer in <code>public/</code>, so this alert plays no media. Pick another file or restore it.
        </div>
      )}
    </>
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
        media: config.media,
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
    void testAlert(kind)
      .then(() => setMessage(`Sent a test ${kind} alert — check the /overlay/alerts browser source. (Uses saved settings.)`))
      .catch(err => setError(err instanceof Error ? err.message : 'Test failed'))
      .finally(() => setTestingKind(null));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Alerts</div>

      <form className="command-settings-form" onSubmit={handleSubmit}>
        <div className="command-example">
          On-stream alerts for Twitch events, shown on the dedicated <code>/overlay/alerts</code> browser
          source — add it as its own OBS source so you can position it independently. Each type can play an
          optional sound or clip from <code>public/sounds</code> / <code>public/clips</code>.
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

              <AlertMediaPicker
                media={config.media}
                mediaFiles={mediaFiles}
                busy={busy}
                onChange={media => updateKind(kind, { media })}
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
