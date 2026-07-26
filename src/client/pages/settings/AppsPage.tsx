import React, { useCallback, useEffect, useState } from 'react';
import type { App, AppEvent } from '../../../shared/api';
import {
  createApp,
  declareAppEvent,
  getAppEvents,
  getApps,
  mintAppToken,
  removeAppEvent,
  revokeAppToken,
  setAppDisabled,
} from '../../services/dashboard';
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
              triggers referencing this event — the Automation page badges them inert
              once it's gone. */}
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
 * Per-app API token controls. `app.tokenConfigured` (has one / has none) comes from
 * the already-loaded apps list — no fetch of its own. Minting/rotating is the only
 * moment the plaintext ever exists on the client: it lives in `revealed`, this
 * component's own state, and nowhere else — never `localStorage`, `sessionStorage`,
 * a module-level variable, or a `console.log`. Dismissing the panel (or revoking)
 * clears `revealed`, and unmounting this row (app list reload, navigation) drops it
 * for free since it was never persisted anywhere to begin with.
 */
function AppTokenControls({
  app,
  disabled,
  onChanged,
}: {
  app: App;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabledOverall = disabled || busy;

  const handleMint = () => {
    // Rotate occupies the same coordinates as the harmless first Mint, and the server
    // rotates the hash before returning — one stray click kills a running app's
    // credential with no way back. Minting the first token destroys nothing, so it asks
    // for nothing.
    if (app.tokenConfigured
      && !window.confirm(`Rotate the token for "${app.name}"? The current one stops working immediately and cannot be recovered.`)) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    void mintAppToken(app.id)
      .then(result => {
        // FIRST, before anything that can fail. The server has already rotated the
        // hash, so the app's previous token is dead and this plaintext is the only
        // copy that will ever exist. Revealing it after an awaited reload meant one
        // failed refetch threw the token away while telling the operator nothing had
        // happened — leaving a live app whose every call 401s and no way to recover.
        setRevealed(result.token);
        // Cosmetic: re-reads tokenConfigured and the reward count. It gets its OWN
        // catch because by this point the token IS minted, and reporting "could not
        // mint a token" over a failed list refresh would say the opposite of the truth.
        return onChanged().catch(() => setError('Token minted, but the app list could not be refreshed — reload the page.'));
      })
      .catch(caught => setError(errorMessage(caught, 'Could not mint a token')))
      .finally(() => setBusy(false));
  };

  const handleRevoke = () => {
    if (!window.confirm(`Revoke the token for "${app.name}"? Every call it makes will 401 until a new token is minted and deployed.`)) return;
    setBusy(true);
    setError(null);
    // Revoking must drop any plaintext still on screen — a revoked token showing as
    // if it still worked would be actively misleading.
    setRevealed(null);
    setCopied(false);
    void revokeAppToken(app.id)
      .then(() => onChanged())
      .catch(caught => setError(errorMessage(caught, 'Could not revoke the token')))
      .finally(() => setBusy(false));
  };

  const handleCopy = () => {
    if (!revealed) return;
    void navigator.clipboard.writeText(revealed)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((copyError: unknown) => {
        // The error object from the Clipboard API never carries the token itself.
        console.error('Failed to copy the app token:', copyError);
      });
  };

  return (
    <div className="field">
      <span>API token</span>
      <div className="command-row-actions">
        <code className="counter-row-token">{app.tokenConfigured ? 'token configured' : 'no token'}</code>
        <small className="action-hint">
          {app.rewardCount} reward{app.rewardCount === 1 ? '' : 's'} via this app
        </small>
      </div>
      {app.tokenConfigured && !revealed && (
        <small className="action-hint">
          Rotating immediately invalidates the current token — the running app will break until it is
          updated with the new one.
        </small>
      )}
      <div className="command-row-actions">
        <button className="modbtn gold" type="button" disabled={disabledOverall} onClick={handleMint}>
          {app.tokenConfigured ? 'Rotate token' : 'Mint token'}
        </button>
        {app.tokenConfigured && (
          <button className="modbtn danger" type="button" disabled={disabledOverall} onClick={handleRevoke}>
            Revoke token
          </button>
        )}
      </div>
      {revealed && (
        <div className="counter-row">
          <div className="counter-row-main">
            <code className="counter-row-token">{revealed}</code>
            <div>
              <small className="action-hint">
                This is shown once and will not be shown again — copy it now and store it wherever
                this app reads its credentials.
              </small>
            </div>
          </div>
          <div className="counter-row-actions">
            <button className="modbtn" type="button" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="modbtn" type="button" onClick={() => { setRevealed(null); setCopied(false); }}>
              Dismiss
            </button>
          </div>
        </div>
      )}
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
              <AppTokenControls app={app} disabled={busyId === app.id} onChanged={load} />
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
