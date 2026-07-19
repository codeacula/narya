import React, { useCallback, useEffect, useState } from 'react';
import type { Counter, CounterInput, CountersResponse } from '../../../shared/api';
import {
  createCounter,
  deleteCounter,
  getCounters,
  updateCounter,
} from '../../services/dashboard';
import { useSocket } from '../../realtime';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';

const EMPTY_DRAFT: CounterInput = { key: '', label: '', value: 0 };

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
  const [draft, setDraft] = useState<CounterInput | null>(null);
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
    setDraft({ key: counter.key, label: counter.label, value: counter.value });
    setMessage(null);
    setError(null);
  };

  const cancel = () => {
    setDraft(null);
    setEditingId(null);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    const request = editingId
      ? updateCounter(editingId, draft)
      : createCounter(draft);
    void request
      .then(async () => {
        await load();
        setDraft(null);
        setEditingId(null);
        setMessage(editingId ? 'Counter updated.' : 'Counter created.');
      })
      .catch(caught => setError(errorMessage(caught, 'Could not save the counter')))
      .finally(() => setSaving(false));
  };

  /** The one-click adjustments, so a miscount is fixable without opening the editor. */
  const bump = (counter: Counter, by: number) => {
    setBusyId(counter.id);
    setError(null);
    void updateCounter(counter.id, { value: counter.value + by })
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
        meta={<div className="set-meta">{counters.length} {counters.length === 1 ? 'counter' : 'counters'}</div>}
        actions={
          <button className="modbtn" type="button" disabled={busy || draft !== null} onClick={startCreate}>
            New counter
          </button>
        }
      />

      <SettingsStatus message={message} error={error} />

      {draft && (
        <form className="command-form" onSubmit={submit}>
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

          <label className="field">
            <span>Value</span>
            <input
              type="number"
              value={draft.value}
              disabled={saving}
              onChange={event => setDraft({ ...draft, value: Math.round(Number(event.target.value)) || 0 })}
            />
          </label>

          <div className="command-form-actions">
            <button className="modbtn primary" type="submit" disabled={saving || !draft.label.trim() || !keyPreview}>
              {editingId ? 'Save counter' : 'Create counter'}
            </button>
            <button className="modbtn" type="button" disabled={saving} onClick={cancel}>Cancel</button>
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
