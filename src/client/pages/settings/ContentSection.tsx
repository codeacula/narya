import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaAsset, MediaFile, MediaKind } from '../../../shared/api';
import { useToast } from '../../ui/notifications';
import { errorMessage } from '../../errors';
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

/** What the right-hand pane is showing: nothing, a new asset, or an existing one. */
type Selection =
  | { mode: 'none' }
  | { mode: 'new' }
  | { mode: 'edit'; id: string };

/** The new-asset form. A local asset picks a discovered file; a remote one is a URL. */
type NewForm = { sourceType: 'local' | 'remote'; src: string; label: string; kind: MediaKind };

const EMPTY_NEW: NewForm = { sourceType: 'local', src: '', label: '', kind: 'audio' };

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

function volumePercent(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

function MediaLibrary() {
  const { pushToast } = useToast();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [discovered, setDiscovered] = useState<MediaFile[]>([]);
  const [configuredSrcs, setConfiguredSrcs] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>({ mode: 'none' });
  const [edit, setEdit] = useState<AssetForm | null>(null);
  const [newForm, setNewForm] = useState<NewForm>(EMPTY_NEW);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load the media library')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  const claimed = useMemo(() => new Set(configuredSrcs), [configuredSrcs]);
  const busy = loading || saving;

  // A src the catalog already claims can still be added again (a second asset can
  // wrap the same file at a different volume), so the picker marks rather than hides.
  const pickedFile = discovered.find(file => file.src === newForm.src) ?? null;

  /**
   * Every write goes through here, so every write reports itself the same way: a toast
   * that outlives the re-render, and the error kept in the pane you were working in. The
   * old inline-only "Asset saved" line sat above a list you had already scrolled past.
   */
  const run = <T,>(work: Promise<T>, done: string, failed: string): Promise<T> => {
    setSaving(true);
    setError(null);
    return work
      .then(async result => {
        await load();
        pushToast({ kind: 'success', title: done });
        return result;
      })
      .catch(caught => {
        const message = errorMessage(caught, failed);
        setError(message);
        pushToast({ kind: 'error', title: failed, message });
        throw caught;
      })
      .finally(() => setSaving(false));
  };

  const openNew = () => {
    setSelection({ mode: 'new' });
    setNewForm(EMPTY_NEW);
    setEdit(null);
    setError(null);
  };

  const openAsset = (asset: MediaAsset) => {
    setSelection({ mode: 'edit', id: asset.id });
    setEdit(formFromAsset(asset));
    setError(null);
  };

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const local = newForm.sourceType === 'local';
    if (local && !pickedFile) return;
    void run(
      createMediaAsset({
        label: (local ? newForm.label.trim() || pickedFile!.label : newForm.label.trim()),
        kind: local ? pickedFile!.kind : newForm.kind,
        sourceType: newForm.sourceType,
        src: local ? pickedFile!.src : newForm.src.trim(),
        volume: DEFAULT_VOLUME,
        enabled: true,
      }),
      'Asset added',
      'Could not add the asset',
    ).then(asset => {
      // Land on the asset just made: it is what the operator wants to tune next, and it
      // is the clearest possible signal that the Add actually did something.
      setSelection({ mode: 'edit', id: asset.id });
      setEdit(formFromAsset(asset));
      setNewForm(EMPTY_NEW);
    }).catch(() => undefined);
  };

  const handleSaveEdit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!edit) return;
    void run(
      updateMediaAsset(edit.id, {
        label: edit.label,
        volume: edit.volume,
        enabled: edit.enabled,
        src: edit.src,
        kind: edit.kind,
      }),
      'Asset saved',
      'Could not save the asset',
    ).then(saved => setEdit(formFromAsset(saved))).catch(() => undefined);
  };

  const handleToggle = (asset: MediaAsset) => {
    void run(
      updateMediaAsset(asset.id, { enabled: !asset.enabled }),
      asset.enabled ? 'Asset disabled' : 'Asset enabled',
      'Could not update the asset',
    ).then(saved => setEdit(formFromAsset(saved))).catch(() => undefined);
  };

  // A referenced asset comes back 409; the message tells the operator to disable it.
  const handleDelete = (asset: MediaAsset) => {
    if (!window.confirm(`Delete ${asset.label}?`)) return;
    void run(deleteMediaAsset(asset.id), 'Asset deleted', 'Could not delete the asset')
      .then(() => {
        setSelection({ mode: 'none' });
        setEdit(null);
      })
      .catch(() => undefined);
  };

  const editing = selection.mode === 'edit' ? assets.find(asset => asset.id === selection.id) ?? null : null;
  /** Repair targets for a broken local asset: the files actually on disk. */
  const repairOptions = discovered.filter(file => edit !== null && file.kind === edit.kind);

  return (
    <div className="set-group">
      <div className="set-group-label">Media library</div>

      <div className="settings-split">
        <div className="settings-split-list">
          <div className="split-list-head">
            <div>
              <div className="set-label">Assets</div>
              <div className="set-sub">
                Rewards, alerts, Actions, commands, and the tablet play these by name — nothing plays
                a file straight off disk.
              </div>
            </div>
            <button className="modbtn gold" type="button" disabled={busy} onClick={openNew}>New</button>
          </div>

          <div className="settings-mini-list">
            {loading ? (
              <div className="command-empty">Loading media library...</div>
            ) : assets.length === 0 ? (
              <div className="command-empty">No media assets configured. Add one with New.</div>
            ) : assets.map(asset => (
              <button
                type="button"
                className={'settings-item-row' + (selection.mode === 'edit' && selection.id === asset.id ? ' is-selected' : '')}
                key={asset.id}
                aria-current={selection.mode === 'edit' && selection.id === asset.id ? 'true' : undefined}
                onClick={() => openAsset(asset)}
              >
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
              </button>
            ))}
          </div>
        </div>

        <div className="settings-split-detail">
          {selection.mode === 'none' ? (
            <div className="split-empty">
              <div className="es-orb" />
              <div className="es-title">Nothing selected</div>
              <div className="es-sub">
                Pick an asset to rename it, re-point it, or set its playback volume. New adds a file
                from public/clips and public/sounds, or a remote URL.
              </div>
            </div>
          ) : selection.mode === 'new' ? (
            <>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">New asset</div>
                  <div className="set-sub">
                    {newForm.sourceType === 'local'
                      ? 'The only place raw files from public/clips and public/sounds appear.'
                      : 'An http(s) URL hosted elsewhere. Nothing else is accepted.'}
                  </div>
                </div>
                <button className="modbtn" type="button" disabled={saving} onClick={() => setSelection({ mode: 'none' })}>
                  Cancel
                </button>
              </div>

              {error && <div className="command-settings-status error">{error}</div>}

              <form className="settings-mini-form" onSubmit={handleCreate}>
                <label className="field">
                  <span>Source</span>
                  <select
                    value={newForm.sourceType}
                    disabled={busy}
                    onChange={event => setNewForm({ ...EMPTY_NEW, sourceType: event.target.value as 'local' | 'remote' })}
                  >
                    <option value="local">A file in public/</option>
                    <option value="remote">A remote URL</option>
                  </select>
                </label>

                {newForm.sourceType === 'local' ? (
                  <label className="field">
                    <span>File</span>
                    <select
                      value={newForm.src}
                      disabled={busy || discovered.length === 0}
                      onChange={event => setNewForm(current => ({ ...current, src: event.target.value, label: '' }))}
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
                ) : (
                  <>
                    <label className="field">
                      <span>URL</span>
                      <input
                        value={newForm.src}
                        disabled={busy}
                        maxLength={500}
                        placeholder="https://cdn.example/horn.mp3"
                        onChange={event => setNewForm(current => ({ ...current, src: event.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span>Kind</span>
                      <select
                        value={newForm.kind}
                        disabled={busy}
                        onChange={event => setNewForm(current => ({ ...current, kind: event.target.value as MediaKind }))}
                      >
                        <option value="audio">Audio</option>
                        <option value="video">Video</option>
                      </select>
                    </label>
                  </>
                )}

                <label className="field">
                  <span>Label</span>
                  <input
                    value={newForm.label}
                    disabled={busy || (newForm.sourceType === 'local' && !pickedFile)}
                    maxLength={60}
                    placeholder={newForm.sourceType === 'local'
                      ? (pickedFile ? pickedFile.label : 'Pick a file first')
                      : 'Air horn'}
                    onChange={event => setNewForm(current => ({ ...current, label: event.target.value }))}
                  />
                </label>

                <div className="command-settings-actions">
                  <button
                    className="modbtn gold"
                    type="submit"
                    disabled={busy || (newForm.sourceType === 'local'
                      ? !pickedFile
                      : !newForm.label.trim() || !newForm.src.trim())}
                  >
                    {saving ? 'Adding...' : 'Add to library'}
                  </button>
                </div>
              </form>
            </>
          ) : !edit ? null : (
            <>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">{edit.label || 'Asset'}</div>
                  <div className="set-sub">
                    {editing && !editing.available
                      ? 'This asset’s file is missing. Point it at a file that exists, or disable it.'
                      : 'Rename, re-point, or set the playback volume.'}
                  </div>
                </div>
                <div className="command-row-actions">
                  {editing && (
                    <button className="modbtn" type="button" disabled={busy} onClick={() => handleToggle(editing)}>
                      {editing.enabled ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  {editing && (
                    <button className="modbtn danger" type="button" disabled={busy} onClick={() => handleDelete(editing)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {error && <div className="command-settings-status error">{error}</div>}

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
            </>
          )}
        </div>
      </div>
    </div>
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
  const { pushToast } = useToast();
  const [items, setItems] = useState<MediaButtonItem[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  // True once the operator picks "Custom…" so the text field shows even before
  // they type anything. Editing an existing off-catalog value shows it anyway.
  const [customMode, setCustomMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
        if (!cancelled) setError(errorMessage(caught, `Could not load ${copy.noun}s`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, copy.noun]);

  const noun = `${copy.noun[0].toUpperCase()}${copy.noun.slice(1)}`;

  const loadForm = (next: Form | null) => {
    setForm(next);
    setCustomMode(false);
    setError(null);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    const payload = { label: form.label, filename: form.filename };
    const request = form.id ? api.update(form.id, payload) : api.create(payload);

    void request
      .then(saved => {
        setItems(current => sortItems([...current.filter(item => item.id !== saved.id), saved]));
        // Stay on what was just saved — including a brand-new one, so the next Save
        // edits it rather than silently adding a second copy.
        setForm(formFrom(saved));
        setCustomMode(false);
        pushToast({ kind: 'success', title: `${noun} saved` });
      })
      .catch(caught => {
        const message = errorMessage(caught, `Could not save ${copy.noun}`);
        setError(message);
        pushToast({ kind: 'error', title: `Could not save ${copy.noun}`, message });
      })
      .finally(() => setSaving(false));
  };

  const handleDelete = (id: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || !window.confirm(`Delete ${item.label}?`)) return;
    setSaving(true);
    setError(null);
    void api.remove(id)
      .then(() => {
        setItems(current => current.filter(entry => entry.id !== id));
        loadForm(null);
        pushToast({ kind: 'success', title: `${noun} deleted` });
      })
      .catch(caught => {
        const message = errorMessage(caught, `Could not delete ${copy.noun}`);
        setError(message);
        pushToast({ kind: 'error', title: `Could not delete ${copy.noun}`, message });
      })
      .finally(() => setSaving(false));
  };

  const inCatalog = form !== null && mediaFiles.some(file => file.src === form.filename);
  // Off-catalog values (a custom URL, or a file deleted from public/) still need
  // to show. Sounds reveal the text field; clips just flag the value as missing.
  const offCatalog = form !== null && form.filename !== '' && !inCatalog;
  const showCustomInput = copy.allowCustomPath && (customMode || offCatalog);
  const selectValue = showCustomInput ? CUSTOM_VALUE : form?.filename ?? '';

  const onSelectFile = (value: string) => {
    if (value === CUSTOM_VALUE) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    setForm(current => (current ? { ...current, filename: value } : current));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">{copy.heading}</div>

      <div className="settings-split">
        <div className="settings-split-list">
          <div className="split-list-head">
            <div className="set-sub">{copy.sub}</div>
            <button className="modbtn gold" type="button" disabled={saving} onClick={() => loadForm(EMPTY_FORM)}>
              New
            </button>
          </div>

          <div className="settings-mini-list">
            {loading ? (
              <div className="command-empty">Loading {copy.noun}s...</div>
            ) : items.length === 0 ? (
              <div className="command-empty">No {copy.noun} buttons configured.</div>
            ) : items.map(item => (
              <button
                type="button"
                className={'settings-item-row' + (form?.id === item.id ? ' is-selected' : '')}
                key={item.id}
                aria-current={form?.id === item.id ? 'true' : undefined}
                onClick={() => loadForm(formFrom(item))}
              >
                <div className="settings-item-main">
                  <b>{item.label}</b>
                  <span>{item.filename}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-split-detail">
          {!form ? (
            <div className="split-empty">
              <div className="es-orb" />
              <div className="es-title">Nothing selected</div>
              <div className="es-sub">
                Pick a {copy.noun} button to rename it or re-point it, or hit New to add one.
              </div>
            </div>
          ) : (
            <>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">{form.id ? (form.label || noun) : `New ${copy.noun} button`}</div>
                  <div className="set-sub">{copy.sub}</div>
                </div>
                <div className="command-row-actions">
                  {form.id && (
                    <button className="modbtn danger" type="button" disabled={saving} onClick={() => handleDelete(form.id!)}>
                      Delete
                    </button>
                  )}
                  <button className="modbtn" type="button" disabled={saving} onClick={() => loadForm(null)}>
                    Close
                  </button>
                </div>
              </div>

              {error && <div className="command-settings-status error">{error}</div>}

              <form className="settings-mini-form" onSubmit={handleSubmit}>
                <label className="field">
                  <span>Label</span>
                  <input
                    value={form.label}
                    disabled={loading || saving}
                    maxLength={60}
                    placeholder={copy.labelPlaceholder}
                    onChange={event => setForm(current => (current ? { ...current, label: event.target.value } : current))}
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
                      onChange={event => setForm(current => (current ? { ...current, filename: event.target.value } : current))}
                    />
                  </label>
                )}
                <div className="command-settings-actions">
                  <button className="modbtn gold" type="submit" disabled={loading || saving}>
                    {saving ? 'Saving...' : `Save ${copy.noun}`}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
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
    <>
      <MediaLibrary />

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
    </>
  );
}
