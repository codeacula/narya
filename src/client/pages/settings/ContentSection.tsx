import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaAsset, MediaFile, MediaKind } from '../../../shared/api';
import {
  createClipButton,
  createMediaAsset,
  createSoundButton,
  deleteClipButton,
  deleteMediaAsset,
  deleteSoundButton,
  getClipButtons,
  getDiscoveredMedia,
  getMediaAssets,
  getMediaFiles,
  getSoundButtons,
  updateClipButton,
  updateMediaAsset,
  updateSoundButton,
} from '../../services/dashboard';

const DEFAULT_VOLUME = 0.8;

/** Everything that plays media references one of these by id. */
type AssetForm = {
  id: string;
  label: string;
  volume: number;
  enabled: boolean;
  src: string;
  kind: MediaKind;
};

type DiscoveredForm = { src: string; label: string };
type RemoteForm = { label: string; src: string; kind: MediaKind };

const EMPTY_DISCOVERED: DiscoveredForm = { src: '', label: '' };
const EMPTY_REMOTE: RemoteForm = { label: '', src: '', kind: 'audio' };

function formFromAsset(asset: MediaAsset): AssetForm {
  return {
    id: asset.id,
    label: asset.label,
    volume: asset.volume,
    enabled: asset.enabled,
    src: asset.src,
    kind: asset.kind,
  };
}

function sortAssets(assets: MediaAsset[]): MediaAsset[] {
  return [...assets].sort((a, b) => a.label.localeCompare(b.label));
}

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function volumePercent(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

function MediaLibrary() {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [discovered, setDiscovered] = useState<MediaFile[]>([]);
  const [configuredSrcs, setConfiguredSrcs] = useState<string[]>([]);
  const [edit, setEdit] = useState<AssetForm | null>(null);
  const [discoveredForm, setDiscoveredForm] = useState<DiscoveredForm>(EMPTY_DISCOVERED);
  const [remoteForm, setRemoteForm] = useState<RemoteForm>(EMPTY_REMOTE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextAssets, nextDiscovered] = await Promise.all([getMediaAssets(), getDiscoveredMedia()]);
    setAssets(sortAssets(nextAssets));
    setDiscovered(nextDiscovered.files);
    setConfiguredSrcs(nextDiscovered.configuredSrcs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorText(caught, 'Could not load the media library')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  const claimed = useMemo(() => new Set(configuredSrcs), [configuredSrcs]);
  const busy = loading || saving;

  // A src the catalog already claims can still be added again (a second asset can
  // wrap the same file at a different volume), so the picker marks rather than hides.
  const pickedFile = discovered.find(file => file.src === discoveredForm.src) ?? null;

  const run = (work: Promise<unknown>, done: string, failed: string) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    void work
      .then(() => load())
      .then(() => setMessage(done))
      .catch(caught => setError(errorText(caught, failed)))
      .finally(() => setSaving(false));
  };

  const handleAddDiscovered = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pickedFile) return;
    run(
      createMediaAsset({
        label: discoveredForm.label.trim() || pickedFile.label,
        kind: pickedFile.kind,
        sourceType: 'local',
        src: pickedFile.src,
        volume: DEFAULT_VOLUME,
        enabled: true,
      }).then(() => setDiscoveredForm(EMPTY_DISCOVERED)),
      'Asset added',
      'Could not add the asset',
    );
  };

  const handleAddRemote = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(
      createMediaAsset({
        label: remoteForm.label.trim(),
        kind: remoteForm.kind,
        sourceType: 'remote',
        src: remoteForm.src.trim(),
        volume: DEFAULT_VOLUME,
        enabled: true,
      }).then(() => setRemoteForm(EMPTY_REMOTE)),
      'Asset added',
      'Could not add the asset',
    );
  };

  const handleSaveEdit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!edit) return;
    run(
      updateMediaAsset(edit.id, {
        label: edit.label,
        volume: edit.volume,
        enabled: edit.enabled,
        src: edit.src,
        kind: edit.kind,
      }).then(saved => setEdit(formFromAsset(saved))),
      'Asset saved',
      'Could not save the asset',
    );
  };

  const handleToggle = (asset: MediaAsset) => {
    run(
      updateMediaAsset(asset.id, { enabled: !asset.enabled }),
      asset.enabled ? 'Asset disabled' : 'Asset enabled',
      'Could not update the asset',
    );
  };

  // A referenced asset comes back 409; the message tells the operator to disable it.
  const handleDelete = (asset: MediaAsset) => {
    if (!window.confirm(`Delete ${asset.label}?`)) return;
    run(
      deleteMediaAsset(asset.id).then(() => setEdit(current => (current?.id === asset.id ? null : current))),
      'Asset deleted',
      'Could not delete the asset',
    );
  };

  /** Repair targets for a broken local asset: the files actually on disk. */
  const repairOptions = discovered.filter(file => edit !== null && file.kind === edit.kind);
  const editing = assets.find(asset => asset.id === edit?.id) ?? null;

  return (
    <>
      <div className="settings-editor-section">
        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>
            {error ?? message}
          </div>
        )}

        <div className="command-editor-head">
          <div>
            <div className="set-label">Media library</div>
            <div className="set-sub">
              Configured assets. Rewards, alerts, Actions, commands, and the tablet play these by name —
              nothing plays a file straight off disk.
            </div>
          </div>
        </div>

        <div className="settings-mini-list">
          {loading ? (
            <div className="command-empty">Loading media library...</div>
          ) : assets.length === 0 ? (
            <div className="command-empty">No media assets configured. Add a discovered file below.</div>
          ) : assets.map(asset => (
            <div className="settings-item-row" key={asset.id}>
              <div className="settings-item-main">
                <b>{asset.label}</b>
                <span>{asset.src}</span>
                <div className="media-asset-tags">
                  <span className="media-asset-tag">{asset.kind}</span>
                  <span className="media-asset-tag">{asset.sourceType}</span>
                  <span className="media-asset-tag">{volumePercent(asset.volume)}</span>
                  {!asset.enabled && <span className="media-asset-tag media-asset-tag--off">disabled</span>}
                  {!asset.available && (
                    <span className="media-asset-tag media-asset-tag--broken">file missing</span>
                  )}
                </div>
              </div>
              <div className="command-row-actions">
                <button
                  className="modbtn"
                  type="button"
                  disabled={busy}
                  onClick={() => { setEdit(formFromAsset(asset)); setMessage(null); setError(null); }}
                >
                  Edit
                </button>
                <button className="modbtn" type="button" disabled={busy} onClick={() => handleToggle(asset)}>
                  {asset.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="modbtn danger" type="button" disabled={busy} onClick={() => handleDelete(asset)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {edit && (
        <div className="settings-editor-section">
          <div className="command-editor-head">
            <div>
              <div className="set-label">Edit {edit.label}</div>
              <div className="set-sub">
                {editing && !editing.available
                  ? 'This asset’s file is missing. Point it at a file that exists, or disable it.'
                  : 'Rename, re-point, or set the playback volume.'}
              </div>
            </div>
            <button className="modbtn" type="button" disabled={saving} onClick={() => setEdit(null)}>
              Close
            </button>
          </div>

          <form className="settings-mini-form" onSubmit={handleSaveEdit}>
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={edit.enabled}
                disabled={busy}
                onChange={event => setEdit(current => (current ? { ...current, enabled: event.target.checked } : current))}
              />
              <span>Enabled</span>
            </label>

            <label className="field">
              <span>Label</span>
              <input
                value={edit.label}
                disabled={busy}
                maxLength={60}
                onChange={event => setEdit(current => (current ? { ...current, label: event.target.value } : current))}
              />
            </label>

            <label className="field">
              <span>{editing?.sourceType === 'remote' ? 'URL' : 'File'}</span>
              {editing?.sourceType === 'remote' ? (
                <input
                  value={edit.src}
                  disabled={busy}
                  maxLength={500}
                  placeholder="https://cdn.example/horn.mp3"
                  onChange={event => setEdit(current => (current ? { ...current, src: event.target.value } : current))}
                />
              ) : (
                <select
                  value={edit.src}
                  disabled={busy}
                  onChange={event => setEdit(current => (current ? { ...current, src: event.target.value } : current))}
                >
                  {/* Keep the missing src selected so saving other fields doesn't silently re-point it. */}
                  {!repairOptions.some(file => file.src === edit.src) && (
                    <option value={edit.src}>{edit.src} (missing)</option>
                  )}
                  {repairOptions.map(file => (
                    <option key={file.src} value={file.src}>{file.label}</option>
                  ))}
                </select>
              )}
            </label>

            <label className="field">
              <span>Volume ({volumePercent(edit.volume)})</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={edit.volume}
                disabled={busy}
                onChange={event => setEdit(current => (current ? { ...current, volume: Number(event.target.value) } : current))}
              />
            </label>

            <div className="command-settings-actions">
              <button className="modbtn gold" type="submit" disabled={busy}>
                {saving ? 'Saving...' : 'Save asset'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="settings-editor-section">
        <div className="set-label">Add discovered file</div>
        <div className="set-sub">
          The only place raw files from public/clips and public/sounds appear. Adding one puts it in the library.
        </div>

        <form className="settings-mini-form" onSubmit={handleAddDiscovered}>
          <label className="field">
            <span>File</span>
            <select
              value={discoveredForm.src}
              disabled={busy || discovered.length === 0}
              onChange={event => setDiscoveredForm({ src: event.target.value, label: '' })}
            >
              <option value="">
                {discovered.length === 0 ? 'No files found under public/' : 'Select a file…'}
              </option>
              {discovered.map(file => (
                <option key={file.src} value={file.src}>
                  {file.label} ({file.kind}){claimed.has(file.src) ? ' — already in library' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Label</span>
            <input
              value={discoveredForm.label}
              disabled={busy || !pickedFile}
              maxLength={60}
              placeholder={pickedFile ? pickedFile.label : 'Pick a file first'}
              onChange={event => setDiscoveredForm(current => ({ ...current, label: event.target.value }))}
            />
          </label>
          <div className="command-settings-actions">
            <button className="modbtn gold" type="submit" disabled={busy || !pickedFile}>
              Add to library
            </button>
          </div>
        </form>
      </div>

      <div className="settings-editor-section">
        <div className="set-label">Add remote URL</div>
        <div className="set-sub">An http(s) URL hosted elsewhere. Nothing else is accepted.</div>

        <form className="settings-mini-form" onSubmit={handleAddRemote}>
          <label className="field">
            <span>Label</span>
            <input
              value={remoteForm.label}
              disabled={busy}
              maxLength={60}
              placeholder="Air horn"
              onChange={event => setRemoteForm(current => ({ ...current, label: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>URL</span>
            <input
              value={remoteForm.src}
              disabled={busy}
              maxLength={500}
              placeholder="https://cdn.example/horn.mp3"
              onChange={event => setRemoteForm(current => ({ ...current, src: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Kind</span>
            <select
              value={remoteForm.kind}
              disabled={busy}
              onChange={event => setRemoteForm(current => ({ ...current, kind: event.target.value as MediaKind }))}
            >
              <option value="audio">Audio</option>
              <option value="video">Video</option>
            </select>
          </label>
          <div className="command-settings-actions">
            <button
              className="modbtn gold"
              type="submit"
              disabled={busy || !remoteForm.label.trim() || !remoteForm.src.trim()}
            >
              Add to library
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

/** Sound and clip buttons share this shape, so one manager drives both. */
type MediaButtonItem = { id: string; label: string; filename: string };
type MediaButtonInput = { label: string; filename: string };

type MediaButtonApi = {
  list: () => Promise<MediaButtonItem[]>;
  create: (body: MediaButtonInput) => Promise<MediaButtonItem>;
  update: (id: string, body: MediaButtonInput) => Promise<MediaButtonItem>;
  remove: (id: string) => Promise<void>;
};

type ManagerCopy = {
  noun: string;           // "sound" — used in messages
  heading: string;        // "Sound buttons"
  sub: string;            // helper text under the heading
  labelPlaceholder: string;
  filePlaceholder: string;
  /** Sounds allow a custom path or URL (the server permits http(s):// and
   *  unscanned paths); clips are catalog-only. */
  allowCustomPath: boolean;
};

type Form = { id: string | null; label: string; filename: string };
const EMPTY_FORM: Form = { id: null, label: '', filename: '' };

/** Sentinel select value that reveals the free-text path/URL field. */
const CUSTOM_VALUE = '__custom__';

function sortItems(items: MediaButtonItem[]): MediaButtonItem[] {
  return [...items].sort((a, b) => a.label.localeCompare(b.label));
}

function formFrom(item: MediaButtonItem): Form {
  return { id: item.id, label: item.label, filename: item.filename };
}

function MediaButtonManager({
  api,
  copy,
  mediaFiles,
}: {
  api: MediaButtonApi;
  copy: ManagerCopy;
  mediaFiles: MediaFile[];
}) {
  const [items, setItems] = useState<MediaButtonItem[]>([]);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  // True once the operator picks "Custom…" so the text field shows even before
  // they type anything. Editing an existing off-catalog value shows it anyway.
  const [customMode, setCustomMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.list()
      .then(next => {
        if (!cancelled) {
          setItems(sortItems(next));
          setError(null);
        }
      })
      .catch(caught => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : `Could not load ${copy.noun}s`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, copy.noun]);

  const loadForm = (next: Form) => {
    setForm(next);
    setCustomMode(false);
    setMessage(null);
    setError(null);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    const isCreate = !form.id;
    const payload = { label: form.label, filename: form.filename };
    const request = form.id ? api.update(form.id, payload) : api.create(payload);

    void request
      .then(saved => {
        setItems(current => sortItems([...current.filter(item => item.id !== saved.id), saved]));
        // After creating, clear the form so the next Save adds another rather than
        // overwriting the one just made. After editing, keep it loaded.
        setForm(isCreate ? EMPTY_FORM : formFrom(saved));
        setCustomMode(false);
        setMessage(`${copy.noun[0].toUpperCase()}${copy.noun.slice(1)} saved`);
      })
      .catch(caught => setError(caught instanceof Error ? caught.message : `Could not save ${copy.noun}`))
      .finally(() => setSaving(false));
  };

  const handleDelete = (id: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || !window.confirm(`Delete ${item.label}?`)) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    void api.remove(id)
      .then(() => {
        setItems(current => current.filter(entry => entry.id !== id));
        if (form.id === id) loadForm(EMPTY_FORM);
        setMessage(`${copy.noun[0].toUpperCase()}${copy.noun.slice(1)} deleted`);
      })
      .catch(caught => setError(caught instanceof Error ? caught.message : `Could not delete ${copy.noun}`))
      .finally(() => setSaving(false));
  };

  const inCatalog = mediaFiles.some(file => file.src === form.filename);
  // Off-catalog values (a custom URL, or a file deleted from public/) still need
  // to show. Sounds reveal the text field; clips just flag the value as missing.
  const offCatalog = form.filename !== '' && !inCatalog;
  const showCustomInput = copy.allowCustomPath && (customMode || offCatalog);
  const selectValue = showCustomInput ? CUSTOM_VALUE : form.filename;

  const onSelectFile = (value: string) => {
    if (value === CUSTOM_VALUE) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    setForm(current => ({ ...current, filename: value }));
  };

  return (
    <div className="settings-editor-section">
      {(message || error) && (
        <div className={'command-settings-status' + (error ? ' error' : '')}>
          {error ?? message}
        </div>
      )}

      <div className="command-editor-head">
        <div>
          <div className="set-label">{copy.heading}</div>
          <div className="set-sub">{copy.sub}</div>
        </div>
        <button
          className="modbtn"
          type="button"
          disabled={saving}
          onClick={() => loadForm(EMPTY_FORM)}
        >
          New
        </button>
      </div>

      <div className="settings-mini-list">
        {loading ? (
          <div className="command-empty">Loading {copy.noun}s...</div>
        ) : items.length === 0 ? (
          <div className="command-empty">No {copy.noun} buttons configured.</div>
        ) : items.map(item => (
          <div className="settings-item-row" key={item.id}>
            <div className="settings-item-main">
              <b>{item.label}</b>
              <span>{item.filename}</span>
            </div>
            <div className="command-row-actions">
              <button className="modbtn" type="button" disabled={saving} onClick={() => loadForm(formFrom(item))}>
                Edit
              </button>
              <button className="modbtn danger" type="button" disabled={saving} onClick={() => handleDelete(item.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <form className="settings-mini-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Label</span>
          <input
            value={form.label}
            disabled={loading || saving}
            maxLength={60}
            placeholder={copy.labelPlaceholder}
            onChange={event => setForm(current => ({ ...current, label: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>File</span>
          <select
            value={selectValue}
            disabled={loading || saving || (mediaFiles.length === 0 && !copy.allowCustomPath && !offCatalog)}
            onChange={event => onSelectFile(event.target.value)}
          >
            <option value="">Select a file…</option>
            {/* Keep a deleted/off-catalog binding visible for catalog-only managers. */}
            {!copy.allowCustomPath && offCatalog && (
              <option value={form.filename}>{form.filename} (missing)</option>
            )}
            {mediaFiles.map(file => (
              <option key={file.src} value={file.src}>{file.label}</option>
            ))}
            {copy.allowCustomPath && <option value={CUSTOM_VALUE}>Custom path or URL…</option>}
          </select>
        </label>
        {showCustomInput && (
          <label className="field">
            <span>Custom path or URL</span>
            <input
              value={form.filename}
              disabled={loading || saving}
              maxLength={240}
              placeholder={copy.filePlaceholder}
              onChange={event => setForm(current => ({ ...current, filename: event.target.value }))}
            />
          </label>
        )}
        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={loading || saving}>
            {saving ? 'Saving...' : `Save ${copy.noun}`}
          </button>
        </div>
      </form>
    </div>
  );
}

const SOUND_API: MediaButtonApi = {
  list: getSoundButtons,
  create: createSoundButton,
  update: updateSoundButton,
  remove: deleteSoundButton,
};

const CLIP_API: MediaButtonApi = {
  list: getClipButtons,
  create: createClipButton,
  update: updateClipButton,
  remove: deleteClipButton,
};

export function ContentSection() {
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);

  useEffect(() => {
    void getMediaFiles().then(setMediaFiles).catch(() => setMediaFiles([]));
  }, []);

  const byKind = (kind: MediaKind) => mediaFiles.filter(file => file.kind === kind);
  const soundFiles = useMemo(() => byKind('audio'), [mediaFiles]);
  const clipFiles = useMemo(() => byKind('video'), [mediaFiles]);

  return (
    <div className="set-group">
      <div className="set-group-label">Media library</div>

      <MediaLibrary />

      <div className="set-group-label">Tablet and overlay content</div>

      {/* Legacy: these still store a raw src rather than an asset id. They move to
          asset ids when the tablet migrates to Actions. */}
      <MediaButtonManager
        api={SOUND_API}
        mediaFiles={soundFiles}
        copy={{
          noun: 'sound',
          heading: 'Sound buttons',
          sub: 'Buttons available on the tablet and in bot command sound actions.',
          labelPlaceholder: 'Quack 1',
          filePlaceholder: '/sounds/quacks/duck-quack.mp3',
          allowCustomPath: true,
        }}
      />

      <MediaButtonManager
        api={CLIP_API}
        mediaFiles={clipFiles}
        copy={{
          noun: 'clip',
          heading: 'Clip buttons',
          sub: 'Video clips on the tablet Media panel. Tapping one plays it on the stream overlay.',
          labelPlaceholder: 'Dinosaur',
          filePlaceholder: '/clips/dinosaur.mp4',
          allowCustomPath: false,
        }}
      />
    </div>
  );
}
