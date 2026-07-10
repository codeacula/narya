import React, { useEffect, useMemo, useState } from 'react';
import type { MediaFile, MediaKind } from '../../../shared/api';
import {
  createClipButton,
  createSoundButton,
  deleteClipButton,
  deleteSoundButton,
  getClipButtons,
  getMediaFiles,
  getSoundButtons,
  updateClipButton,
  updateSoundButton,
} from '../../services/dashboard';

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
};

type Form = { id: string | null; label: string; filename: string };
const EMPTY_FORM: Form = { id: null, label: '', filename: '' };

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
  listId,
}: {
  api: MediaButtonApi;
  copy: ManagerCopy;
  mediaFiles: MediaFile[];
  listId: string;
}) {
  const [items, setItems] = useState<MediaButtonItem[]>([]);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
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

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    const payload = { label: form.label, filename: form.filename };
    const request = form.id ? api.update(form.id, payload) : api.create(payload);

    void request
      .then(saved => {
        setItems(current => sortItems([...current.filter(item => item.id !== saved.id), saved]));
        setForm(formFrom(saved));
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
        if (form.id === id) setForm(EMPTY_FORM);
        setMessage(`${copy.noun[0].toUpperCase()}${copy.noun.slice(1)} deleted`);
      })
      .catch(caught => setError(caught instanceof Error ? caught.message : `Could not delete ${copy.noun}`))
      .finally(() => setSaving(false));
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
          onClick={() => {
            setForm(EMPTY_FORM);
            setMessage(null);
            setError(null);
          }}
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
              <button className="modbtn" type="button" disabled={saving} onClick={() => setForm(formFrom(item))}>
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
          <input
            value={form.filename}
            disabled={loading || saving}
            maxLength={240}
            list={listId}
            placeholder={copy.filePlaceholder}
            onChange={event => setForm(current => ({ ...current, filename: event.target.value }))}
          />
          <datalist id={listId}>
            {mediaFiles.map(file => (
              <option key={file.src} value={file.src}>{file.label}</option>
            ))}
          </datalist>
        </label>
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
      <div className="set-group-label">Tablet and overlay content</div>

      <MediaButtonManager
        api={SOUND_API}
        mediaFiles={soundFiles}
        listId="content-sound-files"
        copy={{
          noun: 'sound',
          heading: 'Sound buttons',
          sub: 'Buttons available on the tablet and in bot command sound actions.',
          labelPlaceholder: 'Quack 1',
          filePlaceholder: '/sounds/quacks/duck-quack.mp3',
        }}
      />

      <MediaButtonManager
        api={CLIP_API}
        mediaFiles={clipFiles}
        listId="content-clip-files"
        copy={{
          noun: 'clip',
          heading: 'Clip buttons',
          sub: 'Video clips on the tablet Media panel. Tapping one plays it on the stream overlay.',
          labelPlaceholder: 'Dinosaur',
          filePlaceholder: '/clips/dinosaur.mp4',
        }}
      />
    </div>
  );
}
