import React, { useCallback, useEffect, useState } from 'react';
import type { App, AppEvent } from '../../../shared/api';
import { createApp, declareAppEvent, getAppEvents, getApps, removeAppEvent, setAppDisabled } from '../../services/dashboard';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';

/**
 * An app's declared inbound event names: what a redis_event trigger's event picker
 * offers for this app (see AutomationPage's RedisEventConfigFields). Loads its own
 * list independently per app row, and add/remove save immediately — mirrors
 * TriggerOverridesSection's per-row idiom on the Automation page rather than the
 * outer form's draft/save cycle, so one app's event list can never be lost to
 * another row's unsaved edit.
 */
function AppEventsList({ app, disabled }: { app: App; disabled: boolean }) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setEvents(await getAppEvents(app.id)), [app.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load events')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Include `loading`: Add must stay disabled during the mount fetch, or a fast add before
  // the mount GET resolves lets that stale snapshot overwrite the just-added row.
  const disabledOverall = disabled || busy || loading;

  const handleAdd = () => {
    const eventName = newName.trim();
    if (!eventName) return;
    setBusy(true);
    setError(null);
    void declareAppEvent(app.id, eventName)
      .then(async () => {
        await load();
        setNewName('');
      })
      .catch(caught => setError(errorMessage(caught, 'Could not declare event')))
      .finally(() => setBusy(false));
  };

  const handleRemove = (eventName: string) => {
    setBusy(true);
    setError(null);
    void removeAppEvent(app.id, eventName)
      .then(() => load())
      .catch(caught => setError(errorMessage(caught, 'Could not remove event')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="field">
      <span>Declared events</span>
      {loading ? (
        <div className="command-empty">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="command-empty">
          No events declared yet. Declare the names this app publishes so a redis_event
          trigger can bind to one.
        </div>
      ) : events.map(event => (
        <div className="command-row-actions" key={event.eventName}>
          <code>{event.eventName}</code>
          {/* Non-blocking warning, not a gate: removal stays allowed even with bound
              triggers referencing this event (Task 6 badges them inert once it's gone). */}
          {event.boundTriggerCount > 0 && (
            <small className="action-hint">
              {event.boundTriggerCount} trigger(s) reference this
            </small>
          )}
          <button
            className="modbtn danger"
            type="button"
            disabled={disabledOverall}
            onClick={() => handleRemove(event.eventName)}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="command-row-actions">
        <input
          type="text"
          value={newName}
          maxLength={64}
          placeholder="event name"
          disabled={disabledOverall}
          onChange={event => setNewName(event.target.value)}
        />
        <button className="modbtn" type="button" disabled={disabledOverall || !newName.trim()} onClick={handleAdd}>
          Add
        </button>
      </div>
      {error && <small className="action-hint">{error}</small>}
    </div>
  );
}

/**
 * Minimal registry editor: register a name, then flip it on or off. Renaming and
 * deleting are deliberately not exposed here — the server only supports create and
 * disable (see apps.ts), so a disabled app's redeems still carry its name in history
 * rather than losing provenance.
 */
export function AppsPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setApps(await getApps()), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load apps')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setMessage(null);
    setError(null);
    void createApp(name.trim())
      .then(async created => {
        await load();
        setName('');
        setMessage(`"${created.name}" registered.`);
      })
      .catch(caught => setError(errorMessage(caught, 'Could not register app')))
      .finally(() => setCreating(false));
  };

  const toggleDisabled = (app: App) => {
    setBusyId(app.id);
    setMessage(null);
    setError(null);
    const nextDisabled = !app.disabledAt;
    void setAppDisabled(app.id, nextDisabled)
      .then(async () => {
        await load();
        setMessage(nextDisabled ? `"${app.name}" disabled.` : `"${app.name}" re-enabled.`);
      })
      .catch(caught => setError(errorMessage(caught, 'Could not update the app')))
      .finally(() => setBusyId(null));
  };

  const disabledOverall = loading || creating;

  return (
    <div>
      <SettingsHeader
        section="apps"
        meta={<div className="set-sub">{apps.length} {apps.length === 1 ? 'app' : 'apps'} registered</div>}
      />

      <SettingsStatus message={message} error={error} />

      <form className="counter-editor" onSubmit={handleCreate}>
        <label className="field settings-wide-field">
          <span>App name</span>
          <input
            value={name}
            disabled={disabledOverall}
            maxLength={32}
            placeholder="pztmi"
            onChange={event => setName(event.target.value)}
          />
          <small className="action-hint">
            Lowercase letters, numbers, underscores, or hyphens. This is the exact <code>source</code>
            value the app publishes under on the Redis bus, and the value you pick per reward on the
            Viewer rewards page.
          </small>
        </label>
        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={disabledOverall || !name.trim()}>
            Register app
          </button>
        </div>
      </form>

      <div className="counter-list">
        {loading && <div className="command-empty">Loading apps…</div>}
        {!loading && apps.length === 0 && (
          <div className="command-empty">
            No apps registered yet. Register one above, then tag a reward with it on the Viewer
            rewards page.
          </div>
        )}
        {!loading && apps.map(app => (
          <div className="counter-row" key={app.id}>
            <div className="counter-row-main">
              <div className="counter-row-label">{app.name}</div>
              <code className="counter-row-token">{app.disabledAt ? `disabled ${app.disabledAt}` : 'enabled'}</code>
              <AppEventsList app={app} disabled={busyId === app.id} />
            </div>
            <div className="counter-row-actions">
              <button
                className={'modbtn' + (app.disabledAt ? ' gold' : '')}
                type="button"
                disabled={busyId === app.id}
                onClick={() => toggleDisabled(app)}
              >
                {app.disabledAt ? 'Enable' : 'Disable'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
