import React, { useEffect, useState } from 'react';
import type { RunItem, SoundButton, TickerItem } from '../../../shared/api';
import {
  createRunsheetItem,
  createSoundButton,
  createTickerItem,
  deleteRunsheetItem,
  deleteSoundButton,
  deleteTickerItem,
  getRunsheet,
  getSoundButtons,
  getTicker,
  updateRunsheetItem,
  updateSoundButton,
  updateTickerItem,
} from '../../services/dashboard';

type SoundForm = {
  id: string | null;
  label: string;
  filename: string;
};

type RunsheetForm = {
  id: string | null;
  text: string;
  done: boolean;
};

type TickerForm = {
  id: string | null;
  text: string;
};

const EMPTY_SOUND_FORM: SoundForm = {
  id: null,
  label: '',
  filename: '',
};

const EMPTY_RUNSHEET_FORM: RunsheetForm = {
  id: null,
  text: '',
  done: false,
};

const EMPTY_TICKER_FORM: TickerForm = {
  id: null,
  text: '',
};

function sortSoundButtons(items: SoundButton[]): SoundButton[] {
  return [...items].sort((a, b) => a.label.localeCompare(b.label));
}

function sortByPosition<T extends { position: number; text: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.text.localeCompare(b.text));
}

function formFromSound(sound: SoundButton): SoundForm {
  return {
    id: sound.id,
    label: sound.label,
    filename: sound.filename,
  };
}

function formFromRunsheet(item: RunItem): RunsheetForm {
  return {
    id: item.id,
    text: item.text,
    done: item.done,
  };
}

function formFromTicker(item: TickerItem): TickerForm {
  return {
    id: item.id,
    text: item.text,
  };
}

export function ContentSection() {
  const [soundButtons, setSoundButtons] = useState<SoundButton[]>([]);
  const [runsheetItems, setRunsheetItems] = useState<RunItem[]>([]);
  const [tickerItems, setTickerItems] = useState<TickerItem[]>([]);
  const [soundForm, setSoundForm] = useState<SoundForm>(EMPTY_SOUND_FORM);
  const [runsheetForm, setRunsheetForm] = useState<RunsheetForm>(EMPTY_RUNSHEET_FORM);
  const [tickerForm, setTickerForm] = useState<TickerForm>(EMPTY_TICKER_FORM);
  const [contentLoading, setContentLoading] = useState(true);
  const [contentSaving, setContentSaving] = useState(false);
  const [contentMessage, setContentMessage] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContentLoading(true);
    void Promise.all([getSoundButtons(), getRunsheet(), getTicker()])
      .then(([nextSoundButtons, nextRunsheetItems, nextTickerItems]) => {
        if (!cancelled) {
          setSoundButtons(sortSoundButtons(nextSoundButtons));
          setRunsheetItems(sortByPosition(nextRunsheetItems));
          setTickerItems(sortByPosition(nextTickerItems));
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

  const handleRunsheetSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { text: runsheetForm.text, done: runsheetForm.done };
    const request = runsheetForm.id ? updateRunsheetItem(runsheetForm.id, payload) : createRunsheetItem(payload);

    void request
      .then(saved => {
        setRunsheetItems(current => sortByPosition([...current.filter(item => item.id !== saved.id), saved]));
        setRunsheetForm(formFromRunsheet(saved));
        setContentMessage('Runsheet saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save runsheet item'))
      .finally(() => setContentSaving(false));
  };

  const handleRunsheetDelete = (id: string) => {
    const item = runsheetItems.find(row => row.id === id);
    if (!item || !window.confirm(`Delete "${item.text}"?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteRunsheetItem(id)
      .then(() => {
        setRunsheetItems(current => current.filter(row => row.id !== id));
        if (runsheetForm.id === id) setRunsheetForm(EMPTY_RUNSHEET_FORM);
        setContentMessage('Runsheet item deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete runsheet item'))
      .finally(() => setContentSaving(false));
  };

  const handleTickerSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    const payload = { text: tickerForm.text };
    const request = tickerForm.id ? updateTickerItem(tickerForm.id, payload) : createTickerItem(payload);

    void request
      .then(saved => {
        setTickerItems(current => sortByPosition([...current.filter(item => item.id !== saved.id), saved]));
        setTickerForm(formFromTicker(saved));
        setContentMessage('Ticker saved');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not save ticker item'))
      .finally(() => setContentSaving(false));
  };

  const handleTickerDelete = (id: string) => {
    const item = tickerItems.find(row => row.id === id);
    if (!item || !window.confirm(`Delete "${item.text}"?`)) return;
    setContentSaving(true);
    setContentMessage(null);
    setContentError(null);
    void deleteTickerItem(id)
      .then(() => {
        setTickerItems(current => current.filter(row => row.id !== id));
        if (tickerForm.id === id) setTickerForm(EMPTY_TICKER_FORM);
        setContentMessage('Ticker item deleted');
      })
      .catch(error => setContentError(error instanceof Error ? error.message : 'Could not delete ticker item'))
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

      <div className="settings-editor-section">
        <div className="command-editor-head">
          <div>
            <div className="set-label">Runsheet</div>
            <div className="set-sub">Checklist items for stream preparation and live reminders.</div>
          </div>
          <button
            className="modbtn"
            type="button"
            disabled={contentSaving}
            onClick={() => {
              setRunsheetForm(EMPTY_RUNSHEET_FORM);
              setContentMessage(null);
              setContentError(null);
            }}
          >
            New
          </button>
        </div>

        <div className="settings-mini-list">
          {contentLoading ? (
            <div className="command-empty">Loading runsheet...</div>
          ) : runsheetItems.length === 0 ? (
            <div className="command-empty">No runsheet items configured.</div>
          ) : runsheetItems.map(item => (
            <div className="settings-item-row" key={item.id}>
              <div className="settings-item-main">
                <b>{item.text}</b>
                <span>{item.done ? 'Done' : 'Open'}</span>
              </div>
              <div className="command-row-actions">
                <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setRunsheetForm(formFromRunsheet(item))}>
                  Edit
                </button>
                <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleRunsheetDelete(item.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        <form className="settings-mini-form" onSubmit={handleRunsheetSubmit}>
          <label className="field settings-wide-field">
            <span>Item</span>
            <input
              value={runsheetForm.text}
              disabled={contentLoading || contentSaving}
              maxLength={240}
              placeholder="Check scenes and audio"
              onChange={event => setRunsheetForm(current => ({ ...current, text: event.target.value }))}
            />
          </label>
          <label className="command-enabled settings-checkbox-field">
            <input
              type="checkbox"
              checked={runsheetForm.done}
              disabled={contentLoading || contentSaving}
              onChange={event => setRunsheetForm(current => ({ ...current, done: event.target.checked }))}
            />
            <span>Done</span>
          </label>
          <div className="command-settings-actions">
            <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
              {contentSaving ? 'Saving...' : 'Save Item'}
            </button>
          </div>
        </form>
      </div>

      <div className="settings-editor-section">
        <div className="command-editor-head">
          <div>
            <div className="set-label">Ticker</div>
            <div className="set-sub">Short text items for overlay or dashboard ticker surfaces.</div>
          </div>
          <button
            className="modbtn"
            type="button"
            disabled={contentSaving}
            onClick={() => {
              setTickerForm(EMPTY_TICKER_FORM);
              setContentMessage(null);
              setContentError(null);
            }}
          >
            New
          </button>
        </div>

        <div className="settings-mini-list">
          {contentLoading ? (
            <div className="command-empty">Loading ticker...</div>
          ) : tickerItems.length === 0 ? (
            <div className="command-empty">No ticker items configured.</div>
          ) : tickerItems.map(item => (
            <div className="settings-item-row" key={item.id}>
              <div className="settings-item-main">
                <b>{item.text}</b>
              </div>
              <div className="command-row-actions">
                <button className="modbtn" type="button" disabled={contentSaving} onClick={() => setTickerForm(formFromTicker(item))}>
                  Edit
                </button>
                <button className="modbtn danger" type="button" disabled={contentSaving} onClick={() => handleTickerDelete(item.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        <form className="settings-mini-form" onSubmit={handleTickerSubmit}>
          <label className="field settings-wide-field">
            <span>Text</span>
            <input
              value={tickerForm.text}
              disabled={contentLoading || contentSaving}
              maxLength={160}
              placeholder="Follow for more local nonsense"
              onChange={event => setTickerForm(current => ({ ...current, text: event.target.value }))}
            />
          </label>
          <div className="command-settings-actions">
            <button className="modbtn gold" type="submit" disabled={contentLoading || contentSaving}>
              {contentSaving ? 'Saving...' : 'Save Ticker'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
