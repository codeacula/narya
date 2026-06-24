import React from 'react';
import { Icon } from './icons';
import {
  banViewer,
  sendChatMessage,
  sendViewerShoutout,
  sendViewerWhisper,
  timeoutViewer,
} from '../services/dashboard';
import type { Viewer, ChatEntry, StreamEvent, ViewerProfileUpdate, ChatSender } from '../../shared/api';

/* ---------------- types ---------------- */

export type PanelCtx = {
  viewers: Record<string, Viewer>;
  chat: ChatEntry[];
  events: StreamEvent[];
  channel: string;
  openViewerPopout: (login: string) => void;
  updateViewerProfile: (login: string, profile: ViewerProfileUpdate) => Promise<ViewerProfileUpdate>;
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

const MAX_VIEWER_TAGS = 12;
type ViewerActionKind = 'whisper' | 'timeout' | 'ban';

function badgesFor(viewer: Viewer | undefined): string[] {
  if (!viewer) return [];
  const out: string[] = [];
  if (viewer.roles.includes('broadcaster')) out.push('broadcaster');
  if (viewer.roles.includes('mod')) out.push('mod');
  if (viewer.roles.includes('vip')) out.push('vip');
  if (viewer.roles.includes('sub')) out.push('sub');
  return out;
}

function normalizeProfileTag(value: string): string {
  return value.trim().replace(/^#/, '').slice(0, 32);
}

function addProfileTag(tags: string[], value: string): string[] {
  const tag = normalizeProfileTag(value);
  if (!tag || tags.length >= MAX_VIEWER_TAGS) return tags;
  const existing = new Set(tags.map(item => item.toLowerCase()));
  if (existing.has(tag.toLowerCase())) return tags;
  return [...tags, tag];
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
              {m.highlight === 'broadcaster' && <span className="hl-tag" title="broadcaster">♛</span>}
              {m.highlight === 'mod' && <span className="hl-tag" title="moderator">⚔</span>}
              {m.highlight === 'vip' && <span className="hl-tag" title="VIP">★</span>}
              {m.highlight === 'sub' && <span className="hl-tag">sub</span>}
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
  const [sender, setSender] = React.useState<ChatSender>('user');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const message = text.trim();

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    void sendChatMessage(message, sender)
      .then(() => setText(''))
      .catch(error => {
        setError(error instanceof Error ? error.message : 'Could not send chat message');
      })
      .finally(() => setSending(false));
  }, [message, sender, sending]);

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <select
        aria-label="Send chat as"
        className="chat-sender"
        value={sender}
        disabled={sending}
        onChange={event => setSender(event.target.value as ChatSender)}
      >
        <option value="user">user</option>
        <option value="bot">bot</option>
      </select>
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

function ViewerProfileModal({
  viewer,
  onSave,
  onClose,
}: {
  viewer: Viewer;
  onSave: (profile: ViewerProfileUpdate) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = React.useState<ViewerProfileUpdate>({
    realName: viewer.realName,
    tags: viewer.tags,
    note: viewer.note,
  });
  const [tagInput, setTagInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setForm({
      realName: viewer.realName,
      tags: viewer.tags,
      note: viewer.note,
    });
    setTagInput('');
    setError(null);
  }, [viewer.login, viewer.note, viewer.realName, viewer.tags]);

  const addTag = React.useCallback((value: string) => {
    setForm(current => ({ ...current, tags: addProfileTag(current.tags, value) }));
    setTagInput('');
  }, []);

  const removeTag = React.useCallback((tag: string) => {
    setForm(current => ({ ...current, tags: current.tags.filter(item => item !== tag) }));
  }, []);

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    const tags = tagInput ? addProfileTag(form.tags, tagInput) : form.tags;
    void onSave({
      realName: form.realName.trim(),
      tags: tags.map(normalizeProfileTag).filter(Boolean),
      note: form.note.trim(),
    })
      .then(onClose)
      .catch(saveError => {
        setError(saveError instanceof Error ? saveError.message : 'Could not save viewer profile');
      })
      .finally(() => setSaving(false));
  }, [form, onClose, onSave, saving, tagInput]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="stream-info-modal viewer-profile-modal" onSubmit={handleSubmit}>
        <div className="modal-head">
          <div>
            <h2>Viewer Profile</h2>
            <div className="viewer-profile-login">@{viewer.login}</div>
          </div>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <label className="field">
          <span>Real name</span>
          <input
            value={form.realName}
            maxLength={120}
            disabled={saving}
            onChange={event => setForm(current => ({ ...current, realName: event.target.value }))}
          />
          <small>{form.realName.length}/120</small>
        </label>

        <div className="field">
          <span>Tags</span>
          <div className="tag-chip-list">
            {form.tags.map(tag => (
              <span className="tag-chip" key={tag}>
                {tag}
                <button type="button" title={`Remove ${tag}`} disabled={saving} onClick={() => removeTag(tag)}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
          <input
            aria-label="Add viewer tag"
            value={tagInput}
            maxLength={32}
            disabled={saving || form.tags.length >= MAX_VIEWER_TAGS}
            placeholder={form.tags.length >= MAX_VIEWER_TAGS ? 'Tag limit reached' : 'Type a tag and press Enter'}
            onChange={event => setTagInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addTag(tagInput);
              }
            }}
          />
          <small>{form.tags.length}/12</small>
        </div>

        <label className="field">
          <span>Notes</span>
          <textarea
            value={form.note}
            maxLength={1000}
            rows={7}
            disabled={saving}
            onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
          />
          <small>{form.note.length}/1000</small>
        </label>

        {error && <div className="modal-status error">{error}</div>}

        <div className="modal-actions">
          <button className="modbtn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modbtn gold" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ViewerActionModal({
  viewer,
  action,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  viewer: Viewer;
  action: ViewerActionKind;
  busy: boolean;
  error: string | null;
  onSubmit: (payload: { message?: string; durationMinutes?: number; reason?: string }) => void;
  onClose: () => void;
}) {
  const [message, setMessage] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [durationMinutes, setDurationMinutes] = React.useState(10);
  const isWhisper = action === 'whisper';
  const isTimeout = action === 'timeout';
  const title = isWhisper ? 'Whisper' : isTimeout ? 'Timeout Viewer' : 'Ban Viewer';
  const submitLabel = busy ? 'Working...' : isWhisper ? 'Send whisper' : isTimeout ? 'Timeout' : 'Ban';

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      message,
      durationMinutes,
      reason,
    });
  }, [durationMinutes, message, onSubmit, reason]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="stream-info-modal viewer-action-modal" onSubmit={handleSubmit}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            <div className="viewer-profile-login">@{viewer.login}</div>
          </div>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        {isWhisper ? (
          <label className="field">
            <span>Message</span>
            <textarea
              value={message}
              maxLength={500}
              rows={5}
              disabled={busy}
              onChange={event => setMessage(event.target.value)}
            />
            <small>{message.length}/500</small>
          </label>
        ) : (
          <>
            {isTimeout && (
              <label className="field">
                <span>Duration minutes</span>
                <input
                  type="number"
                  min={1}
                  max={20_160}
                  value={durationMinutes}
                  disabled={busy}
                  onChange={event => setDurationMinutes(Number(event.target.value))}
                />
                <small>1 minute to 14 days</small>
              </label>
            )}
            <label className="field">
              <span>Reason</span>
              <textarea
                value={reason}
                maxLength={500}
                rows={4}
                disabled={busy}
                onChange={event => setReason(event.target.value)}
              />
              <small>{reason.length}/500</small>
            </label>
          </>
        )}

        {error && <div className="modal-status error">{error}</div>}

        <div className="modal-actions">
          <button className="modbtn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={'modbtn ' + (action === 'ban' ? 'danger' : 'gold')}
            type="submit"
            disabled={busy || (isWhisper && !message.trim())}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- Spotlight ---------------- */

export function Spotlight({ ctx, login }: { ctx: PanelCtx; login?: string }) {
  const normalizedLogin = login?.toLowerCase();
  const viewer = normalizedLogin ? ctx.viewers[normalizedLogin] : null;
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [actionOpen, setActionOpen] = React.useState<ViewerActionKind | null>(null);
  const [busyAction, setBusyAction] = React.useState<ViewerActionKind | 'shoutout' | null>(null);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

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

  const hasProfile = Boolean(viewer.realName || viewer.tags.length > 0 || viewer.note);
  const saveProfile = async (profile: ViewerProfileUpdate) => {
    await ctx.updateViewerProfile(viewer.login, profile);
  };
  const openAction = (action: ViewerActionKind) => {
    setActionOpen(action);
    setActionError(null);
    setActionMessage(null);
  };
  const handleShoutout = () => {
    setBusyAction('shoutout');
    setActionError(null);
    setActionMessage(null);
    void sendViewerShoutout(viewer.login)
      .then(result => setActionMessage(result.message))
      .catch(error => setActionError(error instanceof Error ? error.message : 'Shoutout failed'))
      .finally(() => setBusyAction(null));
  };
  const handleActionSubmit = (payload: { message?: string; durationMinutes?: number; reason?: string }) => {
    if (!actionOpen) return;
    const action = actionOpen;
    setBusyAction(action);
    setActionError(null);
    setActionMessage(null);

    const request = action === 'whisper'
      ? sendViewerWhisper(viewer.login, payload.message ?? '')
      : action === 'timeout'
        ? timeoutViewer(
            viewer.login,
            Math.round(Math.min(Math.max(payload.durationMinutes ?? 10, 1), 20_160) * 60),
            payload.reason ?? '',
          )
        : banViewer(viewer.login, payload.reason ?? '');

    void request
      .then(result => {
        setActionMessage(result.message);
        setActionOpen(null);
      })
      .catch(error => setActionError(error instanceof Error ? error.message : 'Viewer action failed'))
      .finally(() => setBusyAction(null));
  };

  return (
    <>
      <div className="spot">
        <div className="spot-head">
          <div className="spot-avatar" style={{ background: viewer.color }}>
            {viewer.display[0].toUpperCase()}
          </div>
          <div className="spot-id">
            <div className="spot-name" style={{ color: viewer.color }}>{viewer.display}</div>
            {viewer.realName && <div className="spot-real-name">{viewer.realName}</div>}
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
              {viewer.tags.map(tag => (
                <span className="profile-tag" key={tag}>{tag}</span>
              ))}
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

        {(actionMessage || (!actionOpen && actionError)) && (
          <div className={'spot-action-status' + (actionError ? ' error' : '')}>
            {actionError ?? actionMessage}
          </div>
        )}

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
          <button className="modbtn gold" disabled={busyAction !== null} onClick={handleShoutout}>
            {busyAction === 'shoutout' ? 'sending...' : 'shout out'}
          </button>
          <button className="modbtn" disabled={busyAction !== null} onClick={() => openAction('whisper')}>whisper</button>
          <button className="modbtn" onClick={() => setProfileOpen(true)}>
            {hasProfile ? 'edit profile' : 'add note'}
          </button>
          <button className="modbtn" disabled={busyAction !== null} onClick={() => openAction('timeout')}>timeout</button>
          <button className="modbtn danger" disabled={busyAction !== null} onClick={() => openAction('ban')}>ban</button>
        </div>
      </div>

      {profileOpen && (
        <ViewerProfileModal
          viewer={viewer}
          onSave={saveProfile}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {actionOpen && (
        <ViewerActionModal
          viewer={viewer}
          action={actionOpen}
          busy={busyAction === actionOpen}
          error={actionError}
          onSubmit={handleActionSubmit}
          onClose={() => {
            setActionOpen(null);
            setActionError(null);
          }}
        />
      )}
    </>
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
