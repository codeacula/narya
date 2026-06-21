import React from 'react';
import { Icon } from './icons';
import { sendChatMessage } from '../services/dashboard';
import type { Viewer, ChatEntry, StreamEvent } from '../../shared/api';

/* ---------------- types ---------------- */

export type PanelCtx = {
  viewers: Record<string, Viewer>;
  chat: ChatEntry[];
  events: StreamEvent[];
  channel: string;
  openViewerPopout: (login: string) => void;
  loadOlderChat: () => Promise<boolean>;
};

export type ModuleEntry = {
  title: string;
  dot: boolean;
  footer?: boolean;
  count?: (ctx: PanelCtx) => React.ReactNode;
  render: (ctx: PanelCtx) => React.ReactNode;
};

/* ---------------- helpers ---------------- */

const ROLE_BADGE: Record<string, string> = {
  broadcaster: 'B',
  mod: '⚔',
  vip: '★',
  sub: '%',
};

function badgesFor(viewer: Viewer | undefined): string[] {
  if (!viewer) return [];
  const out: string[] = [];
  if (viewer.roles.includes('broadcaster')) out.push('broadcaster');
  if (viewer.roles.includes('mod')) out.push('mod');
  if (viewer.roles.includes('vip')) out.push('vip');
  if (viewer.roles.includes('sub')) out.push('sub');
  return out;
}

/* ---------------- Chat ---------------- */

function Chat({ ctx }: { ctx: PanelCtx }) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);
  const lastIdRef = React.useRef(ctx.chat[ctx.chat.length - 1]?.id ?? '');
  const loadingRef = React.useRef(false);
  const exhaustedRef = React.useRef(false);
  const [atBottom, setAtBottom] = React.useState(true);
  const [newCount, setNewCount] = React.useState(0);
  const [loadingOlder, setLoadingOlder] = React.useState(false);

  React.useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      setNewCount(0);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleScroll = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setNewCount(0);

    // Load older messages when scrolled near the top
    if (el.scrollTop < 120 && !loadingRef.current && !exhaustedRef.current) {
      loadingRef.current = true;
      setLoadingOlder(true);
      const prevHeight = el.scrollHeight;
      ctx.loadOlderChat().then((hasMore) => {
        exhaustedRef.current = !hasMore;
        // After React re-renders with new items prepended, restore scroll position
        requestAnimationFrame(() => {
          if (listRef.current) {
            listRef.current.scrollTop += listRef.current.scrollHeight - prevHeight;
          }
          loadingRef.current = false;
          setLoadingOlder(false);
        });
      }).catch(() => {
        loadingRef.current = false;
        setLoadingOlder(false);
      });
    }
  }, [ctx]);

  React.useEffect(() => {
    const lastId = ctx.chat[ctx.chat.length - 1]?.id ?? '';
    if (lastId === lastIdRef.current) return;
    lastIdRef.current = lastId;

    if (!atBottomRef.current) {
      setNewCount(n => n + 1);
      return;
    }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [ctx.chat]);

  const scrollToBottom = React.useCallback(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, []);

  return (
    <>
      <div className="chat-bar">
        {!atBottom && (
          <button className="chat-bar-scroll-btn" onClick={scrollToBottom}>
            <Icon name="chevron-down" size={12} />
            {newCount > 0 ? `${newCount} new` : 'latest'}
          </button>
        )}
      </div>
      <div className="chat-list" ref={listRef} onScroll={handleScroll}>
        {loadingOlder && <div className="chat-loading">loading…</div>}
        {ctx.chat.map((m) => {
          const login = m.user.toLowerCase();
          const viewer = ctx.viewers[login];
          const color = viewer?.color ?? '#d7dce2';
          const display = viewer?.display ?? m.user;
          const hlClass = m.highlight ? ' hl-' + m.highlight : '';
          return (
            <div className={'msg' + hlClass} key={m.id}>
              <span className="msg-time">{m.time}</span>
              {m.highlight === 'first' && <span className="hl-tag">first time</span>}
              {m.highlight === 'sub' && <span className="hl-tag">new sub</span>}
              <span className="badges">
                {badgesFor(viewer).map(b => (
                  <span className={'cbadge ' + b} key={b} title={b}>{ROLE_BADGE[b]}</span>
                ))}
              </span>
              <span className="msg-user" style={{ color }} onClick={() => ctx.openViewerPopout(m.user)}>
                {display}
              </span>
              <span className="msg-text">{m.text}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ChatInput({ channel }: { channel: string }) {
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const message = text.trim();

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    void sendChatMessage(message)
      .then(() => setText(''))
      .catch(error => {
        setError(error instanceof Error ? error.message : 'Could not send chat message');
      })
      .finally(() => setSending(false));
  }, [message, sending]);

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <input
        aria-label="Send Twitch chat message"
        value={text}
        maxLength={500}
        disabled={sending}
        placeholder={channel ? `Send a message to ${channel}...` : 'Send a message...'}
        onChange={event => {
          setText(event.target.value);
          if (error) setError(null);
        }}
      />
      <button className="chat-send" type="submit" disabled={!message || sending}>
        {sending ? 'Sending' : 'Chat'}
      </button>
      {error ? <div className="chat-input-error" title={error}>{error}</div> : null}
    </form>
  );
}

/* ---------------- Spotlight ---------------- */

export function Spotlight({ ctx, login }: { ctx: PanelCtx; login?: string }) {
  const viewer = login ? ctx.viewers[login] : null;

  if (!viewer) {
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">No one in focus</div>
        <div className="es-sub">
          Click any name in chat to pull up their history, roles, and recent messages here.
        </div>
      </div>
    );
  }

  return (
    <div className="spot">
      <div className="spot-head">
        <div className="spot-avatar" style={{ background: viewer.color }}>
          {viewer.display[0].toUpperCase()}
        </div>
        <div className="spot-id">
          <div className="spot-name" style={{ color: viewer.color }}>{viewer.display}</div>
          <div className="spot-pronouns">{viewer.pronouns} · {viewer.accountAge}</div>
          <div className="spot-roles">
            {viewer.roles.includes('mod') && <span className="rolepill mod">moderator</span>}
            {viewer.roles.includes('vip') && <span className="rolepill vip">vip</span>}
            {viewer.roles.includes('sub') && <span className="rolepill sub">subscriber</span>}
            {viewer.roles.length === 0 && (
              <span className="rolepill" style={{ color: 'var(--fg-3)', borderColor: 'var(--border-1)' }}>
                viewer
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="spot-stats">
        <div className="stat">
          <div className="k">Following</div><div className="v">{viewer.followed}</div>
        </div>
        <div className="stat">
          <div className="k">Subscription</div><div className="v">{viewer.subbed}</div>
        </div>
        <div className="stat">
          <div className="k">Messages</div><div className="v">{viewer.msgs.toLocaleString()} all-time</div>
        </div>
        <div className="stat">
          <div className="k">First seen</div><div className="v">{viewer.seen}</div>
        </div>
      </div>

      {viewer.note && <div className="spot-note">{viewer.note}</div>}

      <div>
        <div className="spot-section-label" style={{ marginBottom: '9px' }}>Recent in chat</div>
        <div className="spot-recent">
          {viewer.recent.map((r, i) => (
            <div className={'rmsg' + (r.kind ? ' ' + r.kind : '')} key={i}>
              <span className="ago">{r.ago}</span>
              <span className="body">{r.t}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="spot-actions">
        <button className="modbtn gold">shout out</button>
        <button className="modbtn">whisper</button>
        <button className="modbtn">add note</button>
        <button className="modbtn">timeout</button>
        <button className="modbtn danger">ban</button>
      </div>
    </div>
  );
}

/* ---------------- Event Feed ---------------- */

const EVT_ICON: Record<string, string> = {
  follow: 'heart',
  sub: 'star',
  gift: 'gift',
  cheer: 'bits',
  raid: 'swords',
  redeem: 'star',
};

function EventFeed({ ctx }: { ctx: PanelCtx }) {
  return (
    <div className="evt-list">
      {ctx.events.map((e) => (
        <div className={'evt tone-' + e.tone} key={e.id}>
          <div className="evt-icon">
            <Icon name={EVT_ICON[e.kind] ?? 'star'} />
          </div>
          <div className="evt-body">
            <div className="evt-actor">
              {e.actor} <span className="verb">{e.kind === 'follow' ? 'followed' : ''}</span>
            </div>
            {e.kind !== 'follow' && <div className="evt-detail">{e.detail}</div>}
          </div>
          <div className="evt-ago">{e.ago}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- MODULES registry ---------------- */

export const MODULES: Record<string, ModuleEntry> = {
  chat: {
    title: 'chat',
    dot: true,
    footer: true,
    count: ctx => ctx.chat.length,
    render: ctx => <Chat ctx={ctx} />,
  },
  events: {
    title: 'activity feed',
    dot: true,
    count: ctx => ctx.events.length,
    render: ctx => <EventFeed ctx={ctx} />,
  },
};
