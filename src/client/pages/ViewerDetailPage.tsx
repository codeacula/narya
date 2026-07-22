import React from 'react';
import { ChatMessageRow, Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { ChatEntry, Viewer, ViewerDetails } from '../../shared/api';
import { useEmotes } from '../chat';
import { ViewerOrb, RoleBadges, type Person, type RunViewerAction } from './ViewersPage';
import {
  flushViewer as flushViewerRecord,
  getViewerDetails,
  getViewerMessages,
  grantModerator,
  grantVip,
  refreshViewer,
  removeModerator,
  removeVip,
} from '../services/dashboard';
import { errorMessage } from '../errors';

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
 * Refresh and Flush: the two actions that operate on Narya's *record* of a viewer
 * rather than on their standing in the channel.
 *
 * Flush is destructive and confirms in place rather than through a dialog — the second
 * click is on a button that has already relabelled itself to say what it will do, so
 * the confirmation cannot be dismissed without reading it. It reverts on blur so a
 * half-pressed Flush does not sit armed.
 */
function ViewerRecordActions({
  login,
  onRefreshed,
  onFlushed,
}: {
  login: string;
  /** Profile re-synced. The roster may have changed; the chat history has not. */
  onRefreshed?: () => void;
  /** Messages were deleted, so anything rendering them is now stale. */
  onFlushed?: (login: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [armed, setArmed] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => { setArmed(false); setNote(null); }, [login]);

  const refresh = () => {
    setBusy(true);
    setNote(null);
    refreshViewer(login)
      .then(result => {
        if (!result.found) setNote('Twitch no longer has this account.');
        else if (result.renamedTo) setNote(`Now known as @${result.renamedTo}.`);
        else setNote('Profile updated.');
        onRefreshed?.();
      })
      .catch(caught => setNote(errorMessage(caught, 'Refresh failed')))
      .finally(() => setBusy(false));
  };

  const flush = () => {
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    setArmed(false);
    flushViewerRecord(login)
      .then(result => {
        const quotes = result.quotesAnonymized > 0
          ? `, ${result.quotesAnonymized} quote(s) anonymized`
          : '';
        const overrides = result.overridesRemoved > 0
          ? `, ${result.overridesRemoved} trigger override(s) removed`
          : '';
        setNote(`Flushed — ${result.messagesRemoved} message(s) removed${quotes}${overrides}.`);
        onFlushed?.(login);
      })
      .catch(caught => setNote(errorMessage(caught, 'Flush failed')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="viewer-record-actions">
      <button className="modbtn" type="button" disabled={busy} onClick={refresh}>
        {busy ? '…' : 'Refresh'}
      </button>
      <button
        className={'modbtn' + (armed ? ' danger-button' : '')}
        type="button"
        disabled={busy}
        onClick={flush}
        onBlur={() => setArmed(false)}
        title="Remove this viewer from the roster and ignore them in future"
      >
        {armed ? 'Confirm flush' : 'Flush'}
      </button>
      {note && <span className="viewer-record-note" role="status">{note}</span>}
    </div>
  );
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
  onFlushed,
}: {
  ctx: PanelCtx;
  person: Person;
  busy: boolean;
  onAction: RunViewerAction;
  /** Reload the roster after a flush — the viewer this pane is showing is now gone. */
  onFlushed?: (login: string) => void;
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
  // Bumped when a flush deletes this viewer's messages. The effect below keys on the
  // login, which does not change across a flush, so without this the pane keeps
  // rendering rows the server has already deleted — directly contradicting its own
  // "messages removed" notice until the operator navigates away.
  const [historyNonce, setHistoryNonce] = React.useState(0);
  // The pagination callback closes over its own render's nonce, so it needs a live
  // read of the current one to tell "still valid" from "superseded by a flush".
  const historyNonceRef = React.useRef(0);
  historyNonceRef.current = historyNonce;
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
  }, [login, historyNonce]);

  const loadOlder = () => {
    const oldest = messages[0];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    // Stamped with the generation in flight when the request went out. A flush
    // during pagination bumps the nonce, and without this the in-flight page
    // resolves afterward and appends messages the server has already deleted —
    // the same staleness the nonce fixes for the main history effect.
    const generation = historyNonce;
    getViewerMessages(login, oldest.id)
      .then(older => {
        if (generation !== historyNonceRef.current) return;
        setMessages(current => [...older, ...current]);
        setHasMore(older.length === PAGE_SIZE);
      })
      .catch(() => { if (generation === historyNonceRef.current) setHasMore(false); })
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
          <ViewerRecordActions
            login={login}
            onRefreshed={() => onFlushed?.(login)}
            onFlushed={(flushedLogin: string) => {
              setHistoryNonce(nonce => nonce + 1);
              onFlushed?.(flushedLogin);
            }}
          />
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
