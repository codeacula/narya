import React, { useCallback, useEffect, useState } from 'react';
import type { Counter, CounterInput, CounterUpdate, CountersResponse } from '../../../shared/api';
import {
  adjustCounter,
  createCounter,
  deleteCounter,
  getCounters,
  updateCounter,
} from '../../services/dashboard';
import { useSocket } from '../../realtime';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';

/**
 * The draft holds the value as TEXT. Parsing on every keystroke made a negative
 * value unreachable from the keyboard: typing "-" produced Number('-') → NaN,
 * and `NaN || 0` rewrote the field to "0" before the digits arrived. Counters are
 * deliberately signed, so the editor has to let a partial "-" exist.
 */
type CounterDraft = {
  key: string;
  label: string;
  value: string;
  /** The value as it was when the editor opened, to tell an edit from an untouched field. */
  originalValue: string;
};

const EMPTY_DRAFT: CounterDraft = { key: '', label: '', value: '0', originalValue: '' };

/**
 * The body to PUT when saving an edit. `value` is omitted when the operator did not
 * touch it, because the form holds a snapshot from when the editor opened: sending
 * it back would overwrite anything automation or /counter wrote in the meantime,
 * silently losing a durable count while the operator was only renaming a label. The
 * server keeps the stored value when the field is absent.
 *
 * Returns null when the typed value is not a number, so the caller can say so.
 */
export function counterUpdateFromDraft(draft: CounterDraft): CounterUpdate | null {
  const base = { key: draft.key, label: draft.label };
  if (draft.value === draft.originalValue) return base;
  const value = parseCounterValue(draft.value);
  return value === null ? null : { ...base, value };
}

/** '' and a lone '-' are legal mid-typing states; both mean zero on submit. */
export function parseCounterValue(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '-') return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Mirrors normalizeCounterKey in src/server/counters.ts. Duplicated deliberately, for
 * the same reason the step validators are: it turns the server's 400 into a live
 * preview of the token the operator will actually type. The server stays the authority.
 */
export function previewCounterKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function CountersPage() {
  const [counters, setCounters] = useState<Counter[]>([]);
  const [draft, setDraft] = useState<CounterDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await getCounters();
    setCounters(response.counters);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load counters')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // An Action step or the /counter command can move a counter at any moment, so the
  // page follows the broadcast rather than only what this tab did. useCallback because
  // useSocket re-subscribes whenever the handler identity changes.
  const onCounters = useCallback((payload: CountersResponse) => {
    setCounters(payload.counters);
  }, []);
  useSocket<CountersResponse>('counters:updated', onCounters);

  const busy = loading || saving;

  const startCreate = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setMessage(null);
    setError(null);
  };

  const startEdit = (counter: Counter) => {
    setEditingId(counter.id);
    const value = String(counter.value);
    setDraft({ key: counter.key, label: counter.label, value, originalValue: value });
    setMessage(null);
    setError(null);
  };

  const cancel = () => {
    setDraft(null);
    setEditingId(null);
  };

  const finish = (request: Promise<unknown>, note: string) =>
    request
      .then(async () => {
        await load();
        setDraft(null);
        setEditingId(null);
        setMessage(note);
      })
      .catch(caught => setError(errorMessage(caught, 'Could not save the counter')))
      .finally(() => setSaving(false));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    if (editingId) {
      const update = counterUpdateFromDraft(draft);
      if (!update) {
        setSaving(false);
        setError('The value must be a whole number.');
        return;
      }
      void finish(updateCounter(editingId, update), 'Counter updated.');
      return;
    }

    const value = parseCounterValue(draft.value);
    if (value === null) {
      setSaving(false);
      setError('The value must be a whole number.');
      return;
    }
    const input: CounterInput = { key: draft.key, label: draft.label, value };
    const request = createCounter(input);
    void finish(request, 'Counter created.');
  };

  /**
   * The one-click adjustments, so a miscount is fixable without opening the editor.
   *
   * Sends a RELATIVE adjustment rather than `counter.value + by`: the rendered
   * value is a snapshot, and a chat command or Action firing between the render
   * and the click would be silently overwritten by an absolute write.
   */
  const bump = (counter: Counter, by: number) => {
    setBusyId(counter.id);
    setError(null);
    void adjustCounter(counter.id, by)
      .then(() => load())
      .catch(caught => setError(errorMessage(caught, 'Could not update the counter')))
      .finally(() => setBusyId(null));
  };

  const remove = (counter: Counter) => {
    setBusyId(counter.id);
    setMessage(null);
    setError(null);
    void deleteCounter(counter.id)
      .then(async () => {
        await load();
        setMessage(`Deleted ${counter.label}.`);
      })
      .catch(caught => setError(errorMessage(caught, 'Could not delete the counter')))
      .finally(() => setBusyId(null));
  };

  const keyPreview = draft ? previewCounterKey(draft.key) : '';

  return (
    <>
      <SettingsHeader
        section="counters"
        meta={<div className="set-sub">{counters.length} {counters.length === 1 ? 'counter' : 'counters'}</div>}
        actions={
          <button className="modbtn" type="button" disabled={busy || draft !== null} onClick={startCreate}>
            New counter
          </button>
        }
      />

      <SettingsStatus message={message} error={error} />

      {draft && (
        <form className="counter-editor" onSubmit={submit}>
          <div className="command-editor-head">
            <div>
              <div className="set-label">{editingId ? draft.label || 'Edit counter' : 'New counter'}</div>
              <div className="set-sub">
                A counter keeps its value until something changes it — an action step, the
                /counter command, or these buttons.
              </div>
            </div>
            <div className="command-row-actions">
              <button className="modbtn" type="button" disabled={saving} onClick={cancel}>Cancel</button>
            </div>
          </div>

          <div className="settings-mini-form">
            <label className="field">
              <span>Name</span>
              <input
                value={draft.label}
                disabled={saving}
                maxLength={120}
                placeholder="Zambie deaths"
                autoFocus
                onChange={event => setDraft({ ...draft, label: event.target.value })}
              />
            </label>

            <label className="field">
              <span>Value</span>
              <input
                type="text"
                inputMode="numeric"
                value={draft.value}
                disabled={saving}
                placeholder="0"
                onChange={event => setDraft({ ...draft, value: event.target.value })}
              />
              <small className="action-hint">Whole numbers, negatives allowed.</small>
            </label>

            <label className="field settings-wide-field">
              <span>Key</span>
              <input
                value={draft.key}
                disabled={saving}
                maxLength={60}
                placeholder="zambie-deaths"
                onChange={event => setDraft({ ...draft, key: event.target.value })}
              />
              <small className="action-hint">
                {keyPreview
                  ? <>Use <code>{`{counter:${keyPreview}}`}</code> in a template or your stream status.</>
                  : 'Letters, numbers, and hyphens. This is the token you type into a template.'}
              </small>
            </label>

            <div className="command-settings-actions">
              <button className="modbtn gold" type="submit" disabled={saving || !draft.label.trim() || !keyPreview}>
                {editingId ? 'Save counter' : 'Create counter'}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="counter-list">
        {counters.map(counter => (
          <div className="counter-row" key={counter.id}>
            <div className="counter-row-main">
              <div className="counter-row-label">{counter.label}</div>
              <code className="counter-row-token">{`{counter:${counter.key}}`}</code>
            </div>

            <div className="counter-row-value">{counter.value}</div>

            <div className="counter-row-actions">
              <button
                className="modbtn"
                type="button"
                disabled={busy || busyId === counter.id}
                onClick={() => bump(counter, -1)}
                aria-label={`Decrease ${counter.label}`}
              >
                −1
              </button>
              <button
                className="modbtn"
                type="button"
                disabled={busy || busyId === counter.id}
                onClick={() => bump(counter, 1)}
                aria-label={`Increase ${counter.label}`}
              >
                +1
              </button>
              <button
                className="modbtn"
                type="button"
                disabled={busy || busyId === counter.id}
                onClick={() => startEdit(counter)}
              >
                Edit
              </button>
              <button
                className="modbtn danger"
                type="button"
                disabled={busy || busyId === counter.id}
                onClick={() => remove(counter)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {!loading && counters.length === 0 && (
          <div className="command-empty">
            No counters yet. Create one, then add an “Adjust counter” step to an action.
          </div>
        )}
      </div>
    </>
  );
}
