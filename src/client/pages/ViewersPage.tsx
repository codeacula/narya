import React from 'react';
import type { Chatter } from '../../shared/api';
import {
  banViewer,
  getChatters,
  getModerators,
  getVips,
  grantModerator,
  grantVip,
  removeModerator,
  removeVip,
  sendViewerShoutout,
  timeoutViewer,
} from '../services/dashboard';

type Role = 'vip' | 'mod' | null;

function roleFor(login: string, vips: Set<string>, mods: Set<string>): Role {
  if (mods.has(login)) return 'mod';
  if (vips.has(login)) return 'vip';
  return null;
}

function ViewerRow({
  login,
  name,
  role,
  busy,
  onAction,
}: {
  login: string;
  name: string;
  role: Role;
  busy: boolean;
  onAction: (action: () => Promise<{ message: string }>, label: string) => void;
}) {
  return (
    <div className="viewer-row">
      <div className="viewer-row-main">
        <b>{name || login}</b>
        {role === 'mod' ? <span className="reward-state on">Mod</span> : null}
        {role === 'vip' ? <span className="reward-state auto">VIP</span> : null}
      </div>
      <div className="viewer-row-actions">
        {role === 'vip'
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeVip(login), `remove VIP from @${login}`)}>Un-VIP</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantVip(login), `VIP @${login}`)}>VIP</button>}
        {role === 'mod'
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeModerator(login), `remove mod from @${login}`)}>Un-Mod</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantModerator(login), `mod @${login}`)}>Mod</button>}
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => sendViewerShoutout(login), `shout out @${login}`)}>Shoutout</button>
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => timeoutViewer(login, 600, ''), `time out @${login}`)}>Timeout</button>
        <button
          className="modbtn danger"
          type="button"
          disabled={busy}
          onClick={() => { if (window.confirm(`Ban @${login}?`)) onAction(() => banViewer(login, ''), `ban @${login}`); }}
        >
          Ban
        </button>
      </div>
    </div>
  );
}

export function ViewersPage() {
  const [chatters, setChatters] = React.useState<Chatter[]>([]);
  const [vips, setVips] = React.useState<Chatter[]>([]);
  const [mods, setMods] = React.useState<Chatter[]>([]);
  const [search, setSearch] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    const results = await Promise.allSettled([getChatters(), getVips(), getModerators()]);
    if (results[0].status === 'fulfilled') setChatters(results[0].value.chatters);
    if (results[1].status === 'fulfilled') setVips(results[1].value);
    if (results[2].status === 'fulfilled') setMods(results[2].value);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failure) setError(failure.reason instanceof Error ? failure.reason.message : 'Some viewer data failed to load. Reconnect Twitch if VIP/mod lists are empty.');
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const vipSet = new Set(vips.map(v => v.userLogin.toLowerCase()));
  const modSet = new Set(mods.map(m => m.userLogin.toLowerCase()));

  const runAction = (action: () => Promise<{ message: string }>, label: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void action()
      .then(result => setMessage(result.message ?? `Done: ${label}.`))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : `Could not ${label}.`))
      .finally(() => { setBusy(false); void refresh(); });
  };

  // Merge chatters with anyone who is a VIP/mod but not currently in chat, so the
  // list always shows your whole roster of privileged users.
  const byLogin = new Map<string, Chatter>();
  for (const person of [...chatters, ...vips, ...mods]) byLogin.set(person.userLogin.toLowerCase(), person);
  const term = search.trim().toLowerCase();
  const people = [...byLogin.values()]
    .filter(person => !term || person.userLogin.toLowerCase().includes(term) || person.userName.toLowerCase().includes(term))
    .sort((a, b) => a.userName.localeCompare(b.userName));

  const searchLogin = term.replace(/^@/, '');
  const searchIsNew = searchLogin.length > 0 && !byLogin.has(searchLogin);

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">viewers</div>
            <h2 className="settings-title">Viewers</h2>
            <p className="set-intro">Grant VIP or moderator, or moderate any viewer. Current chatters, VIPs, and mods are listed. Search a username to act on someone who is not in chat.</p>
          </div>
          <button className="modbtn" type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>

        {error ? <div className="set-status error">{error}</div> : null}
        {message ? <div className="set-status">{message}</div> : null}

        <div className="set-group">
          <label className="field">
            <span>Search or enter a username</span>
            <input
              value={search}
              placeholder="username"
              disabled={busy}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          {searchIsNew && (
            <ViewerRow
              login={searchLogin}
              name={searchLogin}
              role={roleFor(searchLogin, vipSet, modSet)}
              busy={busy}
              onAction={runAction}
            />
          )}
        </div>

        <div className="set-group">
          <div className="set-group-label">People ({people.length})</div>
          {people.length === 0 ? (
            <div className="reward-empty">No viewers to show yet.</div>
          ) : people.map(person => (
            <ViewerRow
              key={person.userLogin}
              login={person.userLogin}
              name={person.userName}
              role={roleFor(person.userLogin.toLowerCase(), vipSet, modSet)}
              busy={busy}
              onAction={runAction}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
