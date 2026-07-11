import React from 'react';
import { ChatMessageRow, Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { ChatEntry, Viewer, ViewerDetails } from '../../shared/api';
import { useEmotes } from '../chat';
import { ViewerOrb, RoleBadges, type Person, type RunViewerAction } from './ViewersPage';
import {
  getViewerDetails,
  getViewerMessages,
  grantModerator,
  grantVip,
  removeModerator,
  removeVip,
} from '../services/dashboard';

const PAGE_SIZE = 80;

/**
 * A Viewer for someone outside the dashboard's recent-window map, built from the roster
 * row the list already has. Some fields (realName, tags) aren't in the roster, so they
 * read as their unset defaults — the pane still shows who the person is rather than
 * falling through to Spotlight's "no one in focus" empty state.
 */
function viewerFromPerson(person: Person): Viewer {
  let seen = 'not available';
  try {
    if (person.firstSeenAt) seen = new Date(person.firstSeenAt).toLocaleDateString();
  } catch { /* keep default */ }
  return {
    login: person.login,
    display: person.display,
    color: person.color,
    realName: '',
    tags: [],
    roles: [...person.roles],
    followed: 'not available',
    subbed: 'not available',
    seen,
    msgs: person.messageCount,
    accountAge: 'not available',
    note: person.note,
    recent: [],
  };
}

/**
 * The right-hand pane of the Viewers page: who this person is, the roles you can grant,
 * everything Spotlight shows, and their full chat history. Role grants live here rather
 * than on the list row so there is exactly one place to act on a viewer.
 */
export function ViewerDetailPane({
  ctx,
  person,
  busy,
  onAction,
}: {
  ctx: PanelCtx;
  person: Person;
  busy: boolean;
  onAction: RunViewerAction;
}) {
  const login = person.login;

  // On-demand live Twitch facts (follow date, subscription, account age).
  const [details, setDetails] = React.useState<ViewerDetails | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setDetails(null);
    getViewerDetails(login)
      .then(next => { if (!cancelled) setDetails(next); })
      .catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [login]);

  const baseViewer = ctx.viewers[login] ?? viewerFromPerson(person);
  const viewer = details ? { ...baseViewer, ...details } : baseViewer;
  const spotlightCtx: PanelCtx = { ...ctx, viewers: { ...ctx.viewers, [login]: viewer } };

  const emoteMap = useEmotes();

  // Full chat history for this viewer, paged oldest-appended-on-top.
  const [messages, setMessages] = React.useState<ChatEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(true);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    setMessages([]);
    getViewerMessages(login)
      .then(rows => {
        if (cancelled) return;
        setMessages(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => { if (!cancelled) { setMessages([]); setHasMore(false); } })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [login]);

  const loadOlder = () => {
    const oldest = messages[0];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    getViewerMessages(login, oldest.id)
      .then(older => {
        setMessages(current => [...older, ...current]);
        setHasMore(older.length === PAGE_SIZE);
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  };

  const isVip = person.roles.has('vip');
  const isMod = person.roles.has('mod');

  return (
    <div className="viewer-detail">
      <header className="viewer-detail-head">
        <ViewerOrb person={person} size="lg" />
        <div className="viewer-detail-id">
          <div className="viewer-detail-nameline">
            <h2 className="viewer-detail-name">{person.display}</h2>
            <RoleBadges roles={person.roles} />
            {viewer.tags.map(tag => <span className="profile-tag" key={tag}>{tag}</span>)}
          </div>
          <div className="roster-sub">
            @{login}
            {viewer.realName ? ` · ${viewer.realName}` : ''}
            {viewer.accountAge && viewer.accountAge !== 'not available' ? ` · ${viewer.accountAge}` : ''}
          </div>
        </div>
        <div className="viewer-detail-roles">
          {isVip
            ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeVip(login), `remove VIP from @${login}`)}>Un-VIP</button>
            : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantVip(login), `VIP @${login}`)}>VIP</button>}
          {isMod
            ? <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => removeModerator(login), `remove mod from @${login}`)}>Un-Mod</button>
            : <button className="modbtn" type="button" disabled={busy} onClick={() => onAction(() => grantModerator(login), `mod @${login}`)}>Mod</button>}
        </div>
      </header>

      <Spotlight ctx={spotlightCtx} login={login} hideIdentity />

      <section className="viewer-history">
        <div className="spot-section-label">Chat history</div>
        {loadingHistory ? (
          <div className="empty-state"><div className="es-orb" /><div className="es-title">Loading chat history…</div></div>
        ) : messages.length === 0 ? (
          <div className="viewer-history-empty">No chat messages recorded for this viewer yet.</div>
        ) : (
          <div className="viewer-history-chat">
            {/* Newest first: the array is oldest→newest, so render it reversed. */}
            {[...messages].reverse().map(message => (
              <ChatMessageRow key={message.id} m={message} viewer={viewer} emoteMap={emoteMap} />
            ))}
            {hasMore ? (
              <button className="modbtn viewer-history-more" type="button" disabled={loadingMore} onClick={loadOlder}>
                {loadingMore ? 'Loading…' : 'Load older'}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
