import React from 'react';
import { ChatMessageRow, Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { ChatEntry, Viewer, ViewerDetails, ViewerRosterEntry } from '../../shared/api';
import { getViewerDetails, getViewerMessages, getViewerRoster } from '../services/dashboard';

const PAGE_SIZE = 80;

function minimalViewer(login: string): Viewer {
  return {
    login,
    display: login,
    color: 'var(--silver-400)',
    realName: '',
    tags: [],
    roles: [],
    followed: 'not available',
    subbed: 'not available',
    seen: 'not available',
    msgs: 0,
    accountAge: 'not available',
    note: '',
    recent: [],
  };
}

// Build a Viewer from a roster row for viewers who fell outside the recent-window
// map. Some fields (realName, tags) aren't in the roster, so they read as their
// unset defaults — the page still shows who the person is.
function rosterEntryToViewer(entry: ViewerRosterEntry): Viewer {
  let seen = 'not available';
  try {
    if (entry.firstSeenAt) seen = new Date(entry.firstSeenAt).toLocaleDateString();
  } catch { /* keep default */ }
  return {
    ...minimalViewer(entry.login),
    display: entry.display,
    color: entry.color,
    roles: entry.roles,
    seen,
    msgs: entry.messageCount,
    note: entry.note,
  };
}

export function ViewerDetailPage({
  ctx,
  login,
  onBack,
}: {
  ctx: PanelCtx;
  login: string;
  onBack: () => void;
}) {
  const normalized = login.toLowerCase();
  const inMap = Boolean(ctx.viewers[normalized]);
  const [fallback, setFallback] = React.useState<Viewer | null>(null);

  // If the viewer isn't in the recent-window map, synthesize a profile from the
  // roster so the page still renders instead of showing Spotlight's empty state.
  React.useEffect(() => {
    if (inMap) {
      setFallback(null);
      return;
    }
    let cancelled = false;
    getViewerRoster()
      .then(roster => {
        if (cancelled) return;
        const entry = roster.find(r => r.login.toLowerCase() === normalized);
        setFallback(entry ? rosterEntryToViewer(entry) : minimalViewer(normalized));
      })
      .catch(() => { if (!cancelled) setFallback(minimalViewer(normalized)); });
    return () => { cancelled = true; };
  }, [inMap, normalized]);

  // On-demand live Twitch facts (follow date, subscription, account age).
  const [details, setDetails] = React.useState<ViewerDetails | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setDetails(null);
    getViewerDetails(normalized)
      .then(next => { if (!cancelled) setDetails(next); })
      .catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [normalized]);

  const baseViewer = ctx.viewers[normalized] ?? fallback;
  const viewer = baseViewer && details ? { ...baseViewer, ...details } : baseViewer;
  const spotlightCtx: PanelCtx = viewer
    ? { ...ctx, viewers: { ...ctx.viewers, [normalized]: viewer } }
    : ctx;

  const display = viewer?.display ?? login;

  // Full chat history for this viewer, paged oldest-appended-on-top.
  const [messages, setMessages] = React.useState<ChatEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(true);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    setMessages([]);
    getViewerMessages(normalized)
      .then(rows => {
        if (cancelled) return;
        setMessages(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => { if (!cancelled) { setMessages([]); setHasMore(false); } })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [normalized]);

  const loadOlder = () => {
    const oldest = messages[0];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    getViewerMessages(normalized, oldest.id)
      .then(older => {
        setMessages(current => [...older, ...current]);
        setHasMore(older.length === PAGE_SIZE);
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="settings-page viewer-detail-page">
      <div className="settings-inner">
        <header className="viewers-head">
          <div>
            <div className="settings-eyebrow">viewer</div>
            <h2 className="viewers-title">{display}</h2>
            <p className="viewers-count">@{normalized}</p>
          </div>
          <button className="modbtn" type="button" onClick={onBack}>Back to viewers</button>
        </header>

        <Spotlight ctx={spotlightCtx} login={normalized} />

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
                <ChatMessageRow key={message.id} m={message} viewer={viewer ?? undefined} />
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
    </div>
  );
}
