import React, { useCallback, useEffect, useState } from 'react';
import type { App } from '../../../shared/api';
import { createApp, getApps, setAppDisabled } from '../../services/dashboard';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';

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
