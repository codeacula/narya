import React from 'react';
import { Icon } from './icons';
import {
  banViewer,
  getOverlayPlaceholders,
  runSlashCommand,
  sendChatMessage,
  sendViewerShoutout,
  sendViewerWhisper,
  timeoutViewer,
  updateOverlayPlaceholders,
} from '../services/dashboard';
import type { Viewer, ChatEntry, StreamEvent, SessionShoutout, ViewerProfileUpdate, ChatSender, DashboardStatus, Chatter, OverlayPlaceholders } from '../../shared/api';
import { formatAgo } from '../../shared/time';
import { useSocket } from '../realtime';
import { renderContent, useEmotes } from '../chat';
import { isMentionOf } from '../chatText';
import { QuickActionsPanel } from '../quickActions';
import { DEFAULT_ATTENTION_TAG, type AttentionItem, type AttentionSettings } from '../attention';
import { kindChip, kindTone } from '../eventKinds';
import { sceneLabel, switchableScenes } from '../scenes';
import { loadStoredJson, saveStoredJson } from '../storage';
import { useMediaMute } from '../mediaMute';
import { errorMessage } from '../errors';

/* ---------------- types ---------------- */

export type PanelCtx = {
  viewers: Record<string, Viewer>;
  chat: ChatEntry[];
  events: StreamEvent[];
  channel: string;
  currentSessionId: string | null;
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

/**
 * Whether a chat message or stream event belongs to the stream happening right
 * now. Off-stream rows (null session) and rows from an earlier session both read
 * as "past", and when nothing is live nothing is current.
 */
export function belongsToCurrentSession(sessionId: string | null | undefined, currentSessionId: string | null): boolean {
  if (currentSessionId === null) return false;
  return sessionId === currentSessionId;
}

/** A row that carries no session of its own can't mark where a session begins. */
export type SessionRow = { sessionId?: string | null; sessionless?: boolean };

/**
 * Index of the row where the session changes, or -1 when the list holds no
 * boundary to draw. One definition for both feeds, which read in opposite
 * directions: chat is oldest-first and marks where the current session begins,
 * the event feed is newest-first and marks where past streams begin.
 *
 * Rows flagged `sessionless` (whispers, which arrive live and carry no session)
 * are skipped when looking for a neighbour, so one landing mid-stream doesn't
 * read as a session change.
 *
 * `markListStart` decides whether a list that opens on the far side is itself a
 * boundary: the event feed heads a wholly-past list with "earlier streams", while
 * chat that opens in the current session has nothing above it to divide from.
 */
export function sessionBoundaryIndex(
  rows: SessionRow[],
  currentSessionId: string | null,
  options: { side: 'current' | 'past'; markListStart: boolean },
): number {
  if (currentSessionId === null) return -1;
  const wanted = options.side === 'current';
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.sessionless) continue;
    if (belongsToCurrentSession(row.sessionId, currentSessionId) !== wanted) continue;

    // Walk back past sessionless rows to the nearest neighbour that has a session.
    let previous = index - 1;
    while (previous >= 0 && rows[previous]?.sessionless) previous--;
    if (previous < 0) return options.markListStart ? index : -1;
    if (belongsToCurrentSession(rows[previous]?.sessionId, currentSessionId) === wanted) continue;
    return index;
  }
  return -1;
}

function badgesFor(viewer: Viewer | undefined): string[] {
  if (!viewer) return [];
  const out: string[] = [];
  if (viewer.roles.includes('broadcaster')) out.push('broadcaster');
  if (viewer.roles.includes('mod')) out.push('mod');
  if (viewer.roles.includes('vip')) out.push('vip');
  if (viewer.roles.includes('sub')) out.push('sub');
  return out;
}

/**
 * A single chat row. Shared by the dashboard chat panel and the viewer detail
 * page's history so both read identically. `viewer` supplies the name colour and
 * role badges; pass `onUserClick` to make the name open a popout (the dashboard
 * does, the viewer page — already on that person — does not). `fromThisStream`
 * dims rows from an earlier session; leave it true where session dimming doesn't
 * apply.
 */
export function ChatMessageRow({
  m,
  viewer,
  fromThisStream = true,
  onUserClick,
  emoteMap = {},
  channel = '',
}: {
  m: ChatEntry;
  viewer?: Viewer;
  fromThisStream?: boolean;
  onUserClick?: (login: string) => void;
  emoteMap?: Record<string, string>;
  /** Operator's login, so rows that ping them stand out. Empty disables the check. */
  channel?: string;
}) {
  const color = viewer?.color ?? '#d7dce2';
  const display = viewer?.display ?? m.user;
  const nameStyle = onUserClick ? { color } : { color, cursor: 'default' as const };
  const onNameClick = onUserClick ? () => onUserClick(m.user) : undefined;
  const body = renderContent(m.text, m.emotes ?? null, emoteMap);
  // Matches the ping cue in Dashboard's chat:message handler, self-messages included:
  // a highlight that fires where the sound doesn't would be worse than neither.
  const isMention = m.user.toLowerCase() !== channel.toLowerCase() && isMentionOf(m.text, channel);

  if (m.kind === 'whisper') {
    return (
      <div className="msg msg-whisper">
        <span className="msg-time">{m.time}</span>
        <span className="hl-tag whisper-tag">whisper</span>
        <span className="msg-user" style={nameStyle} onClick={onNameClick}>{display}</span>
        <span className="msg-text">{body}</span>
      </div>
    );
  }

  const hlClass = m.highlight ? ' hl-' + m.highlight : '';
  return (
    <div className={'msg' + hlClass + (fromThisStream ? '' : ' msg--past') + (isMention ? ' msg--mention' : '')}>
      <span className="msg-time">{m.time}</span>
      <span className="msg-user" style={nameStyle} onClick={onNameClick}>{display}</span>
      <span className="msg-text">{body}</span>
    </div>
  );
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

// Exported so the tablet can render the identical chat surface (read-only there —
// it omits the ChatInput footer). Keep it prop-driven via PanelCtx so the two
// surfaces can't drift apart.
export function Chat({ ctx }: { ctx: PanelCtx }) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);
  const lastIdRef = React.useRef(ctx.chat[ctx.chat.length - 1]?.id ?? '');
  const loadingRef = React.useRef(false);
  const exhaustedRef = React.useRef(false);
  // Tears down an in-flight "stick to bottom" hold (see scrollToBottom).
  const stickReleaseRef = React.useRef<null | (() => void)>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const [newCount, setNewCount] = React.useState(0);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [chatSearch, setChatSearch] = React.useState('');
  const emoteMap = useEmotes();

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
    if (chatSearch) return;
    const lastId = ctx.chat[ctx.chat.length - 1]?.id ?? '';
    if (lastId === lastIdRef.current) return;
    lastIdRef.current = lastId;

    if (!atBottomRef.current) {
      setNewCount(n => n + 1);
      return;
    }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [ctx.chat, chatSearch]);

  const displayedChat = React.useMemo(() => {
    if (!chatSearch.trim()) return ctx.chat;
    const q = chatSearch.toLowerCase();
    return ctx.chat.filter(m =>
      m.text.toLowerCase().includes(q) || m.user.toLowerCase().includes(q)
    );
  }, [ctx.chat, chatSearch]);

  const scrollToBottom = React.useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);

    const el = listRef.current;
    if (!el) return;

    // A touch fling keeps scrolling on the compositor after the finger lifts, and the
    // "latest" tap lands on the toolbar — not this list — so nothing cancels it. A
    // single scrollTop assignment loses to that momentum and drifts back off the
    // bottom. Rather than try to cancel the fling, re-pin to the bottom each frame so
    // the momentum can't move us, until it settles (a few still frames) or a safety
    // cap. Any real scroll gesture on the list releases the hold immediately.
    stickReleaseRef.current?.();

    const startedAt = performance.now();
    let stableFrames = 0;
    let raf = 0;

    const release = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
      el.removeEventListener('pointerdown', release);
      stickReleaseRef.current = null;
    };
    stickReleaseRef.current = release;

    const step = () => {
      const list = listRef.current;
      if (!list) { release(); return; }
      const drifted = list.scrollHeight - list.scrollTop - list.clientHeight > 1;
      list.scrollTop = list.scrollHeight;
      stableFrames = drifted ? 0 : stableFrames + 1;
      if (stableFrames < 4 && performance.now() - startedAt < 1500) {
        raf = requestAnimationFrame(step);
      } else {
        release();
      }
    };

    el.addEventListener('wheel', release, { passive: true });
    el.addEventListener('touchstart', release, { passive: true });
    el.addEventListener('pointerdown', release, { passive: true });
    raf = requestAnimationFrame(step);
  }, []);

  // Release any in-flight "stick to bottom" hold when the chat unmounts (e.g. the
  // tablet toggling to the chatters view).
  React.useEffect(() => () => stickReleaseRef.current?.(), []);

  // Chat is oldest-first, so the boundary is the first message of this stream.
  const currentSessionStart = React.useMemo(
    () => sessionBoundaryIndex(
      displayedChat.map(m => ({ sessionId: m.sessionId, sessionless: m.kind === 'whisper' })),
      ctx.currentSessionId,
      { side: 'current', markListStart: false },
    ),
    [displayedChat, ctx.currentSessionId],
  );

  return (
    <>
      <div className="chat-bar">
        <input
          className="chat-search"
          placeholder="search chat..."
          value={chatSearch}
          onChange={e => setChatSearch(e.target.value)}
        />
        <button className="chat-bar-scroll-btn" onClick={scrollToBottom}>
          <Icon name="chevron-down" size={12} />
          {newCount > 0 ? `${newCount} new` : 'latest'}
        </button>
      </div>
      <div className="chat-list" ref={listRef} onScroll={handleScroll}>
        {loadingOlder && <div className="chat-loading">loading…</div>}
        {displayedChat.map((m, index) => {
          // Whispers arrive live and carry no session, so they never read as past.
          const fromThisStream = m.kind === 'whisper' || belongsToCurrentSession(m.sessionId, ctx.currentSessionId);
          return (
            <React.Fragment key={m.id}>
              {index === currentSessionStart && <div className="chat-divider">this stream</div>}
              <ChatMessageRow
                m={m}
                viewer={ctx.viewers[m.user.toLowerCase()]}
                fromThisStream={fromThisStream}
                onUserClick={ctx.openViewerPopout}
                emoteMap={emoteMap}
                channel={ctx.channel}
              />
            </React.Fragment>
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
  const [notice, setNotice] = React.useState<string | null>(null);
  const message = text.trim();

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    setNotice(null);

    // Anything starting with "/" is an operator command and is resolved entirely by
    // the server, which owns the vocabulary (they are editable trigger rows, not
    // hard-coded here). It is never forwarded to Twitch: the parser this replaced
    // returned null for an unknown or malformed command and fell through to
    // sendChatMessage, so a typo like "/soutout bob" was published to chat.
    const task: Promise<unknown> = message.startsWith('/')
      ? runSlashCommand(message).then(result => {
        // A rejected command (unknown, cooling down, missing an argument) resolves
        // 200 with ok:false — surface it in the input, not as a thrown request.
        if (!result.ok) throw new Error(result.message);
        return result;
      })
      : sendChatMessage(message, sender);

    void task
      .then(result => {
        setText('');
        // A slash command can answer a question rather than just act — "/counter
        // deaths" reports a value — so a successful command's message is shown
        // instead of discarded. Chat sends have nothing to say and stay silent.
        const reply = (result as { message?: unknown } | null)?.message;
        if (typeof reply === 'string' && reply) setNotice(reply);
      })
      .catch(err => {
        setError(errorMessage(err, 'Could not send'));
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
          if (notice) setNotice(null);
        }}
      />
      <button className="chat-send" type="submit" disabled={!message || sending}>
        {sending ? 'Sending' : 'Chat'}
      </button>
      {error ? <div className="chat-input-error" title={error}>{error}</div> : null}
      {!error && notice ? <div className="chat-input-notice" title={notice}>{notice}</div> : null}
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
        setError(errorMessage(saveError, 'Could not save viewer profile'));
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

export function Spotlight({
  ctx,
  login,
  hideIdentity,
}: {
  ctx: PanelCtx;
  login?: string;
  /** Drop the avatar/name/roles block. The Viewers page's detail pane draws its own,
   *  larger one with the role controls in it; two of them read as a rendering bug. */
  hideIdentity?: boolean;
}) {
  const normalizedLogin = login?.toLowerCase();
  const viewer = normalizedLogin ? ctx.viewers[normalizedLogin] : null;
  const emoteMap = useEmotes();
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
      .catch(error => setActionError(errorMessage(error, 'Shoutout failed')))
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
      .catch(error => setActionError(errorMessage(error, 'Viewer action failed')))
      .finally(() => setBusyAction(null));
  };

  return (
    <>
      <div className="spot">
        {!hideIdentity && (
          <div className="spot-head">
            <div className="spot-avatar" style={{ background: viewer.color }}>
              {viewer.display[0].toUpperCase()}
            </div>
            <div className="spot-id">
              <div className="spot-name" style={{ color: viewer.color }}>{viewer.display}</div>
              {viewer.realName && <div className="spot-real-name">{viewer.realName}</div>}
              <div className="spot-meta">{viewer.accountAge}</div>
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
        )}

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
                <span className="body">{renderContent(r.t, r.emotes ?? null, emoteMap)}</span>
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
  ad_break: 'play',
  chat: 'chat',
};

const EVT_TONE_OVERRIDE: Partial<Record<string, string>> = {
  follow: 'note',
  raid: 'note',
};

const EVT_KIND_LABEL: Record<string, string> = {
  follow: 'Follows',
  sub: 'Subs',
  gift: 'Gifts',
  cheer: 'Cheers',
  raid: 'Raids',
  redeem: 'Redeems',
  ad_break: 'Ad Breaks',
};

const EVT_FILTER_KEY = 'eventFeedHiddenKinds';
const EVT_DEFAULT_HIDDEN = new Set(['ad_break']);

function loadHiddenKinds(): Set<string> {
  return loadStoredJson(EVT_FILTER_KEY, raw => new Set(raw as string[]), () => new Set(EVT_DEFAULT_HIDDEN));
}

function saveHiddenKinds(hidden: Set<string>): void {
  saveStoredJson(EVT_FILTER_KEY, [...hidden]);
}

/* ---------------- Session Shoutouts ---------------- */

export function ShoutoutsPanel({
  shoutouts,
  streamActive,
  onOpenViewer,
}: {
  shoutouts: SessionShoutout[];
  streamActive: boolean;
  onOpenViewer: (login: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copyNames = React.useCallback(() => {
    const names = shoutouts.map(s => s.actor).join(' ');
    void navigator.clipboard.writeText(names).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch((error: unknown) => {
      console.error('Failed to copy shoutout names:', error);
    });
  }, [shoutouts]);

  if (!streamActive) {
    return <div className="panel-empty">No stream session is active. Shoutouts collect once you go live.</div>;
  }
  if (shoutouts.length === 0) {
    return <div className="panel-empty">Nobody to shout out yet. Follows, subs, cheers, and raids collect here.</div>;
  }

  return (
    <div className="shout-feed">
      <div className="att-toolbar">
        <span className="att-hint">{shoutouts.length} to thank this stream</span>
        <button className="att-dismiss" type="button" onClick={copyNames}>
          {copied ? 'Copied' : 'Copy names'}
        </button>
      </div>
      <div className="shout-list">
        {shoutouts.map(s => (
          <button
            key={s.login ?? s.actor.toLowerCase()}
            type="button"
            className="shout-row"
            // `actor` is a display name, which for a localized name doesn't
            // lowercase to the login — use the login Twitch gave us.
            onClick={() => onOpenViewer(s.login ?? s.actor.toLowerCase())}
            title={`Open ${s.actor}`}
          >
            <span className="shout-actor">{s.actor}</span>
            <span className="shout-kinds">
              {s.kinds.map(kind => (
                <span key={kind} className={'shout-chip tone-' + kindTone(kind)}>
                  {kindChip(kind)}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Attention Feed ---------------- */

export function AttentionDismissAll({ disabled, onDismiss }: { disabled: boolean; onDismiss: () => void }) {
  return (
    <button
      className="att-dismiss"
      type="button"
      disabled={disabled}
      onClick={onDismiss}
      title="Clear every highlight"
    >
      Dismiss all
    </button>
  );
}

export function AttentionPanel({
  items,
  acked,
  settings,
  onAck,
  onSettingsChange,
}: {
  items: AttentionItem[];
  acked: Set<string>;
  settings: AttentionSettings;
  onAck: (id: string) => void;
  onSettingsChange: (patch: Partial<AttentionSettings>) => void;
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const settingsRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [settingsOpen]);

  return (
    <div className="att-feed">
      <div className="att-toolbar">
        <span className="att-hint">
          {items.length === 0 ? 'nothing waiting' : 'click an item to clear its highlight'}
        </span>
        <div className="evt-filter-anchor" ref={settingsRef}>
          <button
            className={'evt-filter-btn' + (settingsOpen ? ' open' : '')}
            onClick={() => setSettingsOpen(o => !o)}
            title="Attention feed settings"
            type="button"
          >
            Settings
          </button>
          {settingsOpen && (
            <div className="evt-filter-menu att-settings">
              <label className="att-settings-field">
                <span>Route chat from viewers tagged</span>
                <input
                  type="text"
                  value={settings.tag}
                  placeholder={DEFAULT_ATTENTION_TAG}
                  onChange={e => onSettingsChange({ tag: e.target.value })}
                />
              </label>
              <label className="evt-filter-item">
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={e => onSettingsChange({ soundEnabled: e.target.checked })}
                />
                Chime on new items
              </label>
              <label className="evt-filter-item">
                <input
                  type="checkbox"
                  checked={settings.mentionSoundEnabled}
                  onChange={e => onSettingsChange({ mentionSoundEnabled: e.target.checked })}
                />
                Sound when chat @mentions you
              </label>
            </div>
          )}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="panel-empty">Follows, subs, cheers, raids, and tagged chat land here.</div>
      ) : (
        <div className="att-list">
          {items.map(item => {
            const unacked = !acked.has(item.id);
            const tone = kindTone(item.kind);
            return (
              <button
                key={item.id}
                type="button"
                className={`att-row tone-${tone}${unacked ? ' att-row--unacked' : ''}`}
                onClick={() => onAck(item.id)}
                title={unacked ? 'Click to clear the highlight' : 'Cleared'}
              >
                <span className="evt-icon">
                  <Icon name={EVT_ICON[item.kind] ?? 'star'} />
                </span>
                <span className="evt-body">
                  <span className="evt-actor">{item.actor}</span>
                  <span className="evt-detail">{item.detail}</span>
                </span>
                <span className="evt-ago">{item.at ? formatAgo(item.at) : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EventFeed({ ctx }: { ctx: PanelCtx }) {
  const [hiddenKinds, setHiddenKinds] = React.useState<Set<string>>(() => loadHiddenKinds());
  const [evtSearch, setEvtSearch] = React.useState('');
  const [filterOpen, setFilterOpen] = React.useState(false);
  const filterRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilterOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [filterOpen]);

  const toggleKind = React.useCallback((kind: string) => {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      saveHiddenKinds(next);
      return next;
    });
  }, []);

  const knownKinds = React.useMemo(
    () => [...new Set(ctx.events.map(e => e.kind))],
    [ctx.events],
  );

  const hiddenCount = React.useMemo(
    () => knownKinds.filter(k => hiddenKinds.has(k)).length,
    [knownKinds, hiddenKinds],
  );

  const visibleEvents = React.useMemo(() => {
    const q = evtSearch.trim().toLowerCase();
    return ctx.events.filter(e => {
      if (hiddenKinds.has(e.kind)) return false;
      if (!q) return true;
      return (
        e.actor.toLowerCase().includes(q) ||
        (e.detail ?? '').toLowerCase().includes(q) ||
        (EVT_KIND_LABEL[e.kind] ?? e.kind).toLowerCase().includes(q)
      );
    });
  }, [ctx.events, hiddenKinds, evtSearch]);

  // Events are newest-first, so the boundary is the first row from a past stream.
  const pastSessionStart = React.useMemo(
    () => sessionBoundaryIndex(visibleEvents, ctx.currentSessionId, { side: 'past', markListStart: true }),
    [visibleEvents, ctx.currentSessionId],
  );

  return (
    <div className="evt-feed">
      <div className="evt-toolbar">
        <input
          className="evt-search"
          placeholder="search..."
          value={evtSearch}
          onChange={e => setEvtSearch(e.target.value)}
        />
        {knownKinds.length > 0 && (
          <div className="evt-filter-anchor" ref={filterRef}>
            <button
              className={'evt-filter-btn' + (filterOpen ? ' open' : '')}
              onClick={() => setFilterOpen(o => !o)}
              title="Toggle event filters"
            >
              Filters{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
            </button>
            {filterOpen && (
              <div className="evt-filter-menu">
                {knownKinds.map(kind => (
                  <label key={kind} className="evt-filter-item">
                    <input
                      type="checkbox"
                      checked={!hiddenKinds.has(kind)}
                      onChange={() => toggleKind(kind)}
                    />
                    {EVT_KIND_LABEL[kind] ?? kind}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="evt-list">
        {visibleEvents.map((e, index) => {
          const tone = EVT_TONE_OVERRIDE[e.kind] ?? e.tone;
          const fromThisStream = belongsToCurrentSession(e.sessionId, ctx.currentSessionId);
          return (
            <React.Fragment key={e.id}>
              {index === pastSessionStart && <div className="evt-divider">earlier streams</div>}
              <div className={'evt tone-' + tone + (fromThisStream ? '' : ' evt--past')}>
                <div className="evt-icon">
                  <Icon name={EVT_ICON[e.kind] ?? 'star'} />
                </div>
                <div className="evt-body">
                  <div className="evt-actor">
                    {e.actor} <span className="verb">{e.kind === 'follow' ? 'followed' : ''}</span>
                  </div>
                  {e.kind !== 'follow' && <div className="evt-detail">{e.detail}</div>}
                </div>
                <div className="evt-ago">{e.receivedAt ? formatAgo(e.receivedAt) : e.ago}</div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Controls Panel ---------------- */

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function ControlsPanel({
  status,
  scenes,
  scenePrefix,
  currentScene,
  onSwitchScene,
  sceneSwitching,
}: {
  status: DashboardStatus;
  scenes: string[];
  scenePrefix: string;
  currentScene: string | null;
  onSwitchScene: (sceneName: string) => void;
  sceneSwitching: boolean;
}) {
  const sceneOptions = switchableScenes(scenes, scenePrefix);
  // Lay scenes out in exactly two balanced rows so the buttons line up evenly
  // instead of wrapping raggedly into a single tall row.
  const sceneColumns = Math.max(1, Math.ceil(sceneOptions.length / 2));
  return (
    <div className="ctrl-panel">
      {status.obsConnected && sceneOptions.length > 0 && (
        <div className="ctrl-section ctrl-scene-section">
          <span className="ctrl-label">scene</span>
          <div
            className="ctrl-scene-grid"
            style={{ gridTemplateColumns: `repeat(${sceneColumns}, minmax(0, 1fr))` }}
            role="group"
            aria-label="Switch OBS scene"
          >
            {sceneOptions.map(sceneName => {
              const isActive = currentScene === sceneName;
              return (
                <button
                  className={`ctrl-scene-button${isActive ? ' active' : ''}`}
                  type="button"
                  aria-pressed={isActive}
                  disabled={sceneSwitching || isActive}
                  key={sceneName}
                  onClick={() => onSwitchScene(sceneName)}
                >
                  {sceneLabel(sceneName, scenePrefix)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <OverlayPlaceholderToggle />
      <MediaMuteToggle />
    </div>
  );
}

/**
 * Draws a labelled outline of every overlay browser source's bounds, so a source that
 * shows nothing until an alert fires can still be positioned in OBS.
 *
 * Loud while it is on, because it is drawing boxes over whatever OBS is composing. The
 * server keeps the flag in memory only, so a restart clears it — but a restart is not
 * something to rely on mid-session, hence the warning.
 */
function OverlayPlaceholderToggle() {
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    getOverlayPlaceholders()
      .then(state => setEnabled(state.enabled))
      .catch(() => setEnabled(false));
  }, []);

  // Another dashboard tab (or a reconnect) can flip this too.
  useSocket<OverlayPlaceholders>(
    'overlay:placeholders',
    React.useCallback((next: OverlayPlaceholders) => setEnabled(next.enabled), []),
  );

  const toggle = (next: boolean) => {
    setBusy(true);
    updateOverlayPlaceholders(next)
      .then(state => setEnabled(state.enabled))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="ctrl-section ctrl-overlay-section">
      <span className="ctrl-label">overlays</span>
      <label className="ctrl-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Show overlay bounds</span>
      </label>
      {enabled && (
        <p className="ctrl-overlay-warning" role="status">
          Outlines are visible in every overlay source — turn this off before going live.
        </p>
      )}
    </div>
  );
}

/**
 * The master "mute sound/video commands" switch. While engaged, the server skips
 * every Action flagged Quick Disable — spammed sound/video commands go quiet at
 * once, while unflagged redemptions keep working. Persisted, so a restart keeps it
 * lit until the operator turns it off.
 */
function MediaMuteToggle() {
  const { muted, busy, toggle } = useMediaMute();

  return (
    <div className="ctrl-section ctrl-mute-section">
      <span className="ctrl-label">commands</span>
      <label className={'ctrl-toggle' + (muted ? ' is-muted' : '')}>
        <input
          type="checkbox"
          checked={muted}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Mute sound/video commands</span>
      </label>
      {muted && (
        <p className="ctrl-overlay-warning" role="status">
          Quick-Disable actions are silenced. Redemptions on unflagged actions still play.
        </p>
      )}
    </div>
  );
}

/* ---------------- Chatters Panel ---------------- */

const ROLE_SORT_ORDER: Record<string, number> = { broadcaster: 0, mod: 1, vip: 2, sub: 3 };

/** A person who recently sent a chat message, stamped with when, for {@link mergeRecentChatters}. */
export type RecentChatter = { chatter: Chatter; at: number };

/**
 * Folds people who just chatted into Twitch's presence list. Twitch's `chat/chatters`
 * endpoint lags brand-new arrivals, but a chat message is proof someone is here, so
 * recent senders show immediately. When Twitch does list them its row wins (it carries
 * the real user id); senders quiet longer than `ttlMs` age out so leavers don't linger.
 */
export function mergeRecentChatters(
  present: Chatter[],
  recent: RecentChatter[],
  now: number,
  ttlMs: number,
): Chatter[] {
  const byLogin = new Map<string, Chatter>();
  for (const chatter of present) byLogin.set(chatter.userLogin.toLowerCase(), chatter);
  for (const { chatter, at } of recent) {
    if (now - at > ttlMs) continue;
    const login = chatter.userLogin.toLowerCase();
    if (!byLogin.has(login)) byLogin.set(login, chatter);
  }
  return [...byLogin.values()];
}

function chatterSortKey(chatter: Chatter, viewers: Record<string, Viewer>): number {
  const viewer = viewers[chatter.userLogin.toLowerCase()];
  if (!viewer) return 4;
  for (const role of ['broadcaster', 'mod', 'vip', 'sub']) {
    if (viewer.roles.includes(role)) return ROLE_SORT_ORDER[role] ?? 4;
  }
  return 4;
}

export function ChattersPanel({
  chatters,
  viewers,
  error,
  onOpenViewer,
}: {
  chatters: Chatter[];
  viewers: Record<string, Viewer>;
  error: string | null;
  onOpenViewer: (login: string) => void;
}) {
  if (error) {
    const isScopeError = error.toLowerCase().includes('scope') || error.toLowerCase().includes('moderator:read:chatters');
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">{isScopeError ? 'Permission needed' : 'Unavailable'}</div>
        <div className="es-sub">
          {isScopeError
            ? 'Reconnect Twitch and grant the moderator:read:chatters scope to view live chatters.'
            : error}
        </div>
      </div>
    );
  }

  if (chatters.length === 0) {
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">No chatters yet</div>
        <div className="es-sub">People in your chat room will appear here.</div>
      </div>
    );
  }

  const sorted = [...chatters].sort((a, b) => {
    const diff = chatterSortKey(a, viewers) - chatterSortKey(b, viewers);
    return diff !== 0 ? diff : a.userLogin.localeCompare(b.userLogin);
  });

  return (
    <div className="chatter-list">
      {sorted.map(chatter => {
        const viewer = viewers[chatter.userLogin.toLowerCase()];
        const badges = viewer ? badgesFor(viewer) : [];
        return (
          <div
            className="chatter-row"
            key={chatter.userId}
            onClick={() => onOpenViewer(chatter.userLogin)}
          >
            <span className="chatter-name" style={{ color: viewer?.color ?? 'var(--fg-1)' }}>
              {chatter.userName}
            </span>
            {badges.length > 0 && (
              <span className="chatter-badges">
                {badges.map(b => (
                  <span className={'cbadge ' + b} key={b} title={b}>{ROLE_BADGE[b]}</span>
                ))}
              </span>
            )}
          </div>
        );
      })}
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
  quickActions: {
    title: 'quick actions',
    dot: false,
    render: () => <QuickActionsPanel />,
  },
};
