import React from 'react';
import type { Chatter, ViewerRosterEntry } from '../../shared/api';
import type { PanelCtx } from '../ui/panels';
import { ViewerDetailPane } from './ViewerDetailPage';
import {
  getChatters,
  getModerators,
  getViewerRoster,
  getVips,
} from '../services/dashboard';

type Segment = 'all' | 'live' | 'vips' | 'mods';

export type Person = {
  login: string;
  display: string;
  color: string;
  roles: Set<string>;
  isLive: boolean;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  note: string;
};

/** Runs a viewer action, re-syncs the roster, and reports the outcome. */
export type RunViewerAction = (action: () => Promise<{ message: string }>, label: string) => void;

export function relTime(iso: string): string {
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

export function ViewerOrb({ person, size }: { person: Person; size?: 'lg' }) {
  const ring = topRole(person.roles);
  const className = [
    'roster-orb',
    size === 'lg' ? 'roster-orb--lg' : '',
    ring ? `is-${ring}` : '',
    person.isLive ? 'is-live' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={className} style={{ ['--orb' as string]: person.color }}>
      <span>{initial(person.display)}</span>
    </div>
  );
}

export function RoleBadges({ roles }: { roles: Set<string> }) {
  return (
    <>
      {roles.has('mod') ? <span className="roster-badge is-mod">Mod</span> : null}
      {roles.has('vip') ? <span className="roster-badge is-vip">VIP</span> : null}
      {roles.has('sub') ? <span className="roster-badge is-sub">Sub</span> : null}
    </>
  );
}

/**
 * One viewer in the left list. Selecting a row is all a row does — every action on a
 * viewer lives in the detail pane, so there is a single place to act on someone and the
 * list stays legible in a narrow column.
 */
function RosterRow({
  person,
  selected,
  onSelect,
}: {
  person: Person;
  selected: boolean;
  onSelect: (login: string) => void;
}) {
  return (
    <button
      type="button"
      className={'roster-row' + (selected ? ' is-selected' : '')}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(person.login)}
    >
      <ViewerOrb person={person} />

      <div className="roster-identity">
        <div className="roster-nameline">
          <span className="roster-name">{person.display}</span>
          <RoleBadges roles={person.roles} />
        </div>
        <div className="roster-sub">@{person.login}{person.note ? <span className="roster-note"> · {person.note}</span> : null}</div>
      </div>

      <div className="roster-stats">
        <span className={'roster-stat-seen' + (person.isLive ? ' is-live' : '')}>
          {person.isLive ? 'live now' : relTime(person.lastSeenAt)}
        </span>
        <span className="roster-stat-msgs">{person.messageCount.toLocaleString()} msg{person.messageCount === 1 ? '' : 's'}</span>
      </div>
    </button>
  );
}

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'all', label: 'Everyone' },
  { id: 'live', label: 'Live now' },
  { id: 'vips', label: 'VIPs' },
  { id: 'mods', label: 'Mods' },
];

export function ViewersPage({
  ctx,
  selectedLogin,
  onSelectViewer,
}: {
  ctx: PanelCtx;
  /** The viewer whose page is open (/viewers/<login>), or null on the bare list. */
  selectedLogin: string | null;
  onSelectViewer: (login: string) => void;
}) {
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
        firstSeenAt: entry.firstSeenAt,
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
        firstSeenAt: '',
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

  // A login we can act on but have never seen chat: the search box's escape hatch, and
  // a /viewers/<login> URL for someone who has since fallen out of the roster.
  const strangerFor = React.useCallback((login: string): Person => ({
    login,
    display: login,
    color: 'var(--silver-400)',
    roles: new Set(
      vips.some(v => v.userLogin.toLowerCase() === login) ? ['vip']
        : mods.some(m => m.userLogin.toLowerCase() === login) ? ['mod']
          : [],
    ),
    isLive: liveLogins.has(login),
    messageCount: 0,
    firstSeenAt: '',
    lastSeenAt: '',
    note: '',
  }), [vips, mods, liveLogins]);

  const selected = selectedLogin?.toLowerCase() ?? null;
  const selectedPerson = selected
    ? people.find(person => person.login === selected) ?? strangerFor(selected)
    : null;

  const runAction: RunViewerAction = async (action, label) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    let outcome: { ok: boolean; text: string };
    try {
      const result = await action();
      outcome = { ok: true, text: result.message ?? `Done: ${label}.` };
    } catch (caught) {
      outcome = { ok: false, text: caught instanceof Error ? caught.message : `Could not ${label}.` };
    }
    // Re-sync the roster/role lists first, THEN surface the outcome — refresh() clears
    // `error` on entry, so setting it afterward keeps the action's feedback from being wiped.
    await refresh();
    if (outcome.ok) setMessage(outcome.text);
    else setError(outcome.text);
    setBusy(false);
  };

  return (
    <div className="split-shell viewers-shell">
      <aside className="split-list">
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

        {error ? <div className="viewers-status is-error" role="status">{error}</div> : null}
        {message ? <div className="viewers-status" role="status">{message}</div> : null}

        {loading ? (
          <div className="empty-state"><div className="es-orb" /><div className="es-title">Gathering your viewers…</div></div>
        ) : searchIsNew ? (
          <div className="roster-list">
            <div className="roster-hint">Not in your roster yet — open <b>@{searchLogin}</b> to act on them:</div>
            <RosterRow
              person={strangerFor(searchLogin)}
              selected={selected === searchLogin}
              onSelect={onSelectViewer}
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
              <RosterRow
                key={person.login}
                person={person}
                selected={selected === person.login}
                onSelect={onSelectViewer}
              />
            ))}
          </div>
        )}
      </aside>

      <section className="split-detail" aria-label="Viewer details">
        {selectedPerson ? (
          <ViewerDetailPane
            ctx={ctx}
            person={selectedPerson}
            busy={busy}
            onAction={runAction}
          />
        ) : (
          <div className="split-empty">
            <div className="es-orb" />
            <div className="es-title">No one in focus</div>
            <div className="es-sub">
              Pick a viewer on the left. Their profile, roles, chat history, and the actions you can
              take on them — VIP, mod, shout out, whisper, timeout, ban — all show up here.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
