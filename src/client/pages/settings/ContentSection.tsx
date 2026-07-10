import React, { useEffect, useState } from 'react';
import type { SoundButton } from '../../../shared/api';
import {
  createSoundButton,
  deleteSoundButton,
  getSoundButtons,
  updateSoundButton,
} from '../../services/dashboard';

type SoundForm = {
  id: string | null;
  label: string;
  filename: string;
};

const EMPTY_SOUND_FORM: SoundForm = {
  id: null,
  label: '',
  filename: '',
};

function sortSoundButtons(items: SoundButton[]): SoundButton[] {
  return [...items].sort((a, b) => a.label.localeCompare(b.label));
}

function formFromSound(sound: SoundButton): SoundForm {
  return {
    id: sound.id,
    label: sound.label,
    filename: sound.filename,
  };
}

export function ContentSection() {
  const [soundButtons, setSoundButtons] = useState<SoundButton[]>([]);
  const [soundForm, setSoundForm] = useState<SoundForm>(EMPTY_SOUND_FORM);
  const [contentLoading, setContentLoading] = useState(true);
  const [contentSaving, setContentSaving] = useState(false);
  const [contentMessage, setContentMessage] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContentLoading(true);
    void getSoundButtons()
      .then(nextSoundButtons => {
        if (!cancelled) {
          setSoundButtons(sortSoundButtons(nextSoundButtons));
          setContentError(null);
        }
      })
      .catch(error => {
        if (!cancelled) setContentError(error instanceof Error ? error.message : 'Could not load stream content');
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSoundSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { label: soundForm.label, filename: soundForm.filename };
    const request = soundForm.id ? updateSoundButton(soundForm.id, payload) : createSoundButton(payload);

    void request
      .then(saved => {
        setSoundButtons(current => sortSoundButtons([...current.filter(item => item.id !== saved.id), saved]));
        setSoundForm(formFromSound(saved));
        setContentMessage('Sound saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save sound'))
      .finally(() => setContentSaving(false));
  };

  const handleSoundDelete = (id: string) => {
    const sound = soundButtons.find(item => item.id === id);
    if (!sound || !window.confirm(`Delete ${sound.label}?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteSoundButton(id)
      .then(() => {
        setSoundButtons(current => current.filter(item => item.id !== id));
        if (soundForm.id === id) setSoundForm(EMPTY_SOUND_FORM);
        setContentMessage('Sound deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete sound'))
      .finally(() => setContentSaving(false));
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Tablet and overlay content</div>
      {(contentMessage || contentError) && (
        <div className={'command-settings-status settings-inline-status' + (contentError ? ' error' : '')}>
          {contentError ?? contentMessage}
        </div>
      )}

      <div className="settings-editor-section">
        <div className="command-editor-head">
          <div>
            <div className="set-label">Sound buttons</div>
            <div className="set-sub">Buttons available on the tablet and in bot command sound actions.</div>
          </div>
          <button
            className="modbtn"
            type="button"
            disabled={contentSaving}
            onClick={() => {
              setSoundForm(EMPTY_SOUND_FORM);
              setContentMessage(null);
              setContentError(null);
            }}
          >
            New
          </button>
        </div>

        <div className="settings-mini-list">
          {contentLoading ? (
            <div className="command-empty">Loading sounds...</div>
          ) : soundButtons.length === 0 ? (
            <div className="command-empty">No sound buttons configured.</div>
          ) : soundButtons.map(sound => (
            <div className="settings-item-row" key={sound.id}>
              <div className="settings-item-main">
                <b>{sound.label}</b>
                <span>{sound.filename}</span>
              </div>
              <div className="command-row-actions">
                <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setSoundForm(formFromSound(sound))}>
                  Edit
                </button>
                <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleSoundDelete(sound.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        <form className="settings-mini-form" onSubmit={handleSoundSubmit}>
          <label className="field">
            <span>Label</span>
            <input
              value={soundForm.label}
              disabled={contentLoading || contentSaving}
              maxLength={60}
              placeholder="Quack 1"
              onChange={event => setSoundForm(current => ({ ...current, label: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>File path</span>
            <input
              value={soundForm.filename}
              disabled={contentLoading || contentSaving}
              maxLength={240}
              placeholder="/sounds/quacks/duck-quack.mp3"
              onChange={event => setSoundForm(current => ({ ...current, filename: event.target.value }))}
            />
          </label>
          <div className="command-settings-actions">
            <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
              {contentSaving ? 'Saving...' : 'Save Sound'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
