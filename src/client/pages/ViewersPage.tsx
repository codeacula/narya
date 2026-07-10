import React from 'react';
import type { Chatter, ViewerRosterEntry } from '../../shared/api';
import {
  banViewer,
  getChatters,
  getModerators,
  getViewerRoster,
  getVips,
  grantModerator,
  grantVip,
  removeModerator,
  removeVip,
  sendViewerShoutout,
  timeoutViewer,
} from '../services/dashboard';

type Segment = 'all' | 'live' | 'vips' | 'mods';

type Person = {
  login: string;
  display: string;
  color: string;
  roles: Set<string>;
  isLive: boolean;
  messageCount: number;
  lastSeenAt: string;
  note: string;
};

function relTime(iso: string): string {
  if (!iso) return 'not in chat yet';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

function topRole(roles: Set<string>): 'mod' | 'vip' | 'sub' | null {
  if (roles.has('mod')) return 'mod';
  if (roles.has('vip')) return 'vip';
  if (roles.has('sub')) return 'sub';
  return null;
}

function StarRow({
  person,
  busy,
  onAction,
}: {
  person: Person;
  busy: boolean;
  onAction: (action: () => Promise<{ message: string }>, label: string) => void;
}) {
  const ring = topRole(person.roles);
  const orbClass = ['roster-orb', ring ? `is-${ring}` : '', person.isLive ? 'is-live' : ''].filter(Boolean).join(' ');
  const isVip = person.roles.has('vip');
  const isMod = person.roles.has('mod');

  return (
    <div className="roster-row">
      <div className={orbClass} style={{ ['--orb' as string]: person.color }}>
        <span>{initial(person.display)}</span>
      </div>

      <div className="roster-identity">
        <div className="roster-nameline">
          <span className="roster-name">{person.display}</span>
          {isMod ? <span className="roster-badge is-mod">Mod</span> : null}
          {isVip ? <span className="roster-badge is-vip">VIP</span> : null}
          {person.roles.has('sub') ? <span className="roster-badge is-sub">Sub</span> : null}
        </div>
        <div className="roster-sub">@{person.login}{person.note ? <span className="roster-note"> · {person.note}</span> : null}</div>
      </div>

      <div className="roster-stats">
        <span className={'roster-stat-seen' + (person.isLive ? ' is-live' : '')}>
          {person.isLive ? 'live now' : relTime(person.lastSeenAt)}
        </span>
        <span className="roster-stat-msgs">{person.messageCount.toLocaleString()} msg{person.messageCount === 1 ? '' : 's'}</span>
      </div>

      <div className="roster-actions">
        {isVip
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeVip(person.login), `remove VIP from @${person.login}`)}>Un-VIP</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantVip(person.login), `VIP @${person.login}`)}>VIP</button>}
        {isMod
          ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeModerator(person.login), `remove mod from @${person.login}`)}>Un-Mod</button>
          : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantModerator(person.login), `mod @${person.login}`)}>Mod</button>}
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => sendViewerShoutout(person.login), `shout out @${person.login}`)}>Shout out</button>
        <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => timeoutViewer(person.login, 600, ''), `time out @${person.login}`)}>Timeout</button>
        <button
          className="modbtn danger"
          type="button"
          disabled={busy}
          onClick={() => { if (window.confirm(`Ban @${person.login}?`)) onAction(() => banViewer(person.login, ''), `ban @${person.login}`); }}
        >
          Ban
        </button>
      </div>
    </div>
  );
}

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'all', label: 'Everyone' },
  { id: 'live', label: 'Live now' },
  { id: 'vips', label: 'VIPs' },
  { id: 'mods', label: 'Mods' },
];

export function ViewersPage() {
  const [roster, setRoster] = React.useState<ViewerRosterEntry[]>([]);
  const [liveLogins, setLiveLogins] = React.useState<Set<string>>(new Set());
  const [vips, setVips] = React.useState<Chatter[]>([]);
  const [mods, setMods] = React.useState<Chatter[]>([]);
  const [segment, setSegment] = React.useState<Segment>('all');
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    const [rosterRes, chattersRes, vipsRes, modsRes] = await Promise.allSettled([
      getViewerRoster(), getChatters(), getVips(), getModerators(),
    ]);
    if (rosterRes.status === 'fulfilled') setRoster(rosterRes.value);
    if (chattersRes.status === 'fulfilled') setLiveLogins(new Set(chattersRes.value.chatters.map(c => c.userLogin.toLowerCase())));
    if (vipsRes.status === 'fulfilled') setVips(vipsRes.value);
    if (modsRes.status === 'fulfilled') setMods(modsRes.value);
    // The roster loads without Twitch; only the VIP/mod lists need the new scopes.
    if (vipsRes.status === 'rejected' || modsRes.status === 'rejected') {
      const reason = (vipsRes.status === 'rejected' ? vipsRes.reason : (modsRes as PromiseRejectedResult).reason);
      setError(reason instanceof Error ? reason.message : 'Reconnect Twitch to manage VIPs and moderators.');
    } else if (rosterRes.status === 'rejected') {
      setError(rosterRes.reason instanceof Error ? rosterRes.reason.message : 'Could not load your viewer roster.');
    }
  }, []);

  React.useEffect(() => { void refresh().finally(() => setLoading(false)); }, [refresh]);

  const people = React.useMemo(() => {
    const vipSet = new Set(vips.map(v => v.userLogin.toLowerCase()));
    const modSet = new Set(mods.map(m => m.userLogin.toLowerCase()));
    const byLogin = new Map<string, Person>();

    const rolesFor = (login: string, badgeRoles: string[]): Set<string> => {
      const roles = new Set<string>();
      if (badgeRoles.includes('broadcaster')) roles.add('broadcaster');
      if (badgeRoles.includes('sub')) roles.add('sub');
      // VIP/mod come from the live Twitch lists, not stale message badges.
      if (vipSet.has(login)) roles.add('vip');
      if (modSet.has(login)) roles.add('mod');
      return roles;
    };

    for (const entry of roster) {
      const login = entry.login.toLowerCase();
      byLogin.set(login, {
        login,
        display: entry.display || login,
        color: entry.color || 'var(--silver-400)',
        roles: rolesFor(login, entry.roles),
        isLive: liveLogins.has(login),
        messageCount: entry.messageCount,
        lastSeenAt: entry.lastSeenAt,
        note: entry.note,
      });
    }

    // VIPs/mods who have never chatted still belong in the roster so you can manage them.
    for (const person of [...vips, ...mods]) {
      const login = person.userLogin.toLowerCase();
      if (byLogin.has(login)) continue;
      byLogin.set(login, {
        login,
        display: person.userName || login,
        color: 'var(--silver-400)',
        roles: rolesFor(login, []),
        isLive: liveLogins.has(login),
        messageCount: 0,
        lastSeenAt: '',
        note: '',
      });
    }

    // Alphabetical by username so the roster reads like a directory.
    return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
  }, [roster, vips, mods, liveLogins]);

  const counts = React.useMemo(() => ({
    all: people.length,
    live: people.filter(p => p.isLive).length,
    vips: people.filter(p => p.roles.has('vip')).length,
    mods: people.filter(p => p.roles.has('mod')).length,
  }), [people]);

  const term = search.trim().toLowerCase();
  const shown = people.filter(person => {
    if (segment === 'live' && !person.isLive) return false;
    if (segment === 'vips' && !person.roles.has('vip')) return false;
    if (segment === 'mods' && !person.roles.has('mod')) return false;
    if (term && !person.login.includes(term) && !person.display.toLowerCase().includes(term)) return false;
    return true;
  });

  const searchLogin = term.replace(/^@/, '');
  const searchIsNew = searchLogin.length > 0 && !people.some(p => p.login === searchLogin);

  const runAction = (action: () => Promise<{ message: string }>, label: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void action()
      .then(result => setMessage(result.message ?? `Done: ${label}.`))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : `Could not ${label}.`))
      .finally(() => { setBusy(false); void refresh(); });
  };

  return (
    <div className="settings-page viewers-page">
      <div className="settings-inner">
        <header className="viewers-head">
          <div>
            <div className="settings-eyebrow">viewers</div>
            <h2 className="viewers-title">Everyone in your orbit</h2>
            <p className="viewers-count">
              <b>{counts.all.toLocaleString()}</b> seen
              <span className="viewers-count-dot" />
              <b>{counts.live}</b> live now
            </p>
          </div>
          <button className="modbtn" type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh</button>
        </header>

        {error ? <div className="set-status error">{error}</div> : null}
        {message ? <div className="set-status">{message}</div> : null}

        <div className="viewers-toolbar">
          <div className="viewers-segments" role="tablist" aria-label="Filter viewers">
            {SEGMENTS.map(seg => (
              <button
                key={seg.id}
                role="tab"
                aria-selected={segment === seg.id}
                className={'viewers-chip' + (segment === seg.id ? ' is-active' : '')}
                onClick={() => setSegment(seg.id)}
              >
                {seg.label}<span className="viewers-chip-n">{counts[seg.id]}</span>
              </button>
            ))}
          </div>
          <input
            className="viewers-search"
            value={search}
            placeholder="Search a name…"
            aria-label="Search viewers"
            disabled={loading}
            onChange={event => setSearch(event.target.value)}
          />
        </div>

        {loading ? (
          <div className="empty-state"><div className="es-orb" /><div className="es-title">Gathering your viewers…</div></div>
        ) : searchIsNew ? (
          <div className="roster-list">
            <div className="roster-hint">Not in your roster yet — act on <b>@{searchLogin}</b> directly:</div>
            <StarRow
              person={{ login: searchLogin, display: searchLogin, color: 'var(--silver-400)', roles: new Set(vips.some(v => v.userLogin.toLowerCase() === searchLogin) ? ['vip'] : mods.some(m => m.userLogin.toLowerCase() === searchLogin) ? ['mod'] : []), isLive: liveLogins.has(searchLogin), messageCount: 0, lastSeenAt: '', note: '' }}
              busy={busy}
              onAction={runAction}
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <div className="es-orb" />
            <div className="es-title">{people.length === 0 ? 'No one’s come by yet' : 'No one here'}</div>
            <div className="es-sub">{people.length === 0 ? 'Viewers you meet in chat will gather here as stars.' : 'Try a different filter or search.'}</div>
          </div>
        ) : (
          <div className="roster-list">
            {shown.map(person => (
              <StarRow key={person.login} person={person} busy={busy} onAction={runAction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
