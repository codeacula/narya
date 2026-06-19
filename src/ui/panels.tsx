import React from 'react';
import { Icon } from './icons';
import type { Viewer, ChatEntry, StreamEvent } from '../types';

/* ---------------- types ---------------- */

export type PanelCtx = {
  viewers: Record<string, Viewer>;
  chat: ChatEntry[];
  events: StreamEvent[];
  openViewerPopout: (login: string) => void;
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
  if (viewer.login === 'codeacula') out.push('broadcaster');
  if (viewer.roles.includes('mod')) out.push('mod');
  if (viewer.roles.includes('vip')) out.push('vip');
  if (viewer.roles.includes('sub')) out.push('sub');
  return out;
}

/* ---------------- Chat ---------------- */

function Chat({ ctx }: { ctx: PanelCtx }) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, []);

  return (
    <div className="chat-list" ref={listRef}>
      {ctx.chat.map((m, i) => {
        const viewer = ctx.viewers[m.user];
        const color = viewer?.color ?? '#d7dce2';
        const display = viewer?.display ?? m.user;
        const hlClass = m.highlight ? ' hl-' + m.highlight : '';
        return (
          <div className={'msg' + hlClass} key={i}>
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
  );
}

export function ChatInput() {
  return (
    <div className="chat-input">
      <input placeholder="Send a message as codeacula…" />
      <button className="chat-send">Chat</button>
    </div>
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
      {ctx.events.map((e, i) => (
        <div className={'evt tone-' + e.tone} key={i}>
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
