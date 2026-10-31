import React from 'react';
import { Icon } from '../icons';
import {
  banViewer,
  runSlashCommand,
  sendChatMessage,
  timeoutViewer,
} from '../../services/dashboard';
import type { ChatEntry, Viewer, ChatSender } from '../../../shared/api';
import { renderContent, useEmotes } from '../../chat';
import { isMentionOf } from '../../chatText';
import { errorMessage } from '../../errors';
import {
  DEFAULT_TIMEOUT_MINUTES,
  timeoutLabel,
  timeoutSeconds,
} from '../../timeoutDuration';
import { belongsToCurrentSession, sessionBoundaryIndex, type PanelCtx } from './context';

/** How long an armed ban stays armed before reverting. Long enough to read the
 *  relabelled button and press it, short enough that walking away disarms it. */
const ARM_TIMEOUT_MS = 4_000;

/** What has already been handed out to this chatter, shown in place of the buttons. */
export type ChatRowModerationStatus = { kind: 'timeout' | 'ban'; label: string };

export type ChatRowModeration = {
  status?: ChatRowModerationStatus | null;
  busy?: boolean;
  onTimeout: (login: string) => void;
  onBan: (login: string) => void;
};

/**
 * Timeout and ban, inline on a chat row — the two actions worth removing the
 * click-name → popout-window → modal round trip for.
 *
 * The buttons fade rather than mount, and hold their box at opacity 0, so no row
 * reflows under the pointer as the operator moves down a moving list.
 *
 * Timeout fires on the first click because it expires on its own. Ban arms and
 * confirms in place — the same idiom as Flush on the viewer page — because there
 * is no unban route here and Twitch purges the messages the moment it lands, so
 * a misfire is not something this app can walk back.
 */
function ChatRowActions({ login, moderation }: { login: string; moderation: ChatRowModeration }) {
  const [armed, setArmed] = React.useState(false);

  // Disarm on a timer as well as on blur. Blur alone is enough with a mouse, but the
  // tablet is a touch surface where a tap does not reliably focus a button — so the
  // blur may simply never arrive, and a ban left armed under the operator's thumb is
  // the accident this confirmation exists to prevent.
  React.useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (moderation.status) {
    return (
      <span className={'msg-mod-status ' + moderation.status.kind}>{moderation.status.label}</span>
    );
  }

  return (
    <span className="msg-mod">
      <button
        type="button"
        className="msg-mod-btn"
        disabled={moderation.busy}
        title={`Time @${login} out for ${timeoutLabel(DEFAULT_TIMEOUT_MINUTES)}`}
        onClick={() => moderation.onTimeout(login)}
      >
        {timeoutLabel(DEFAULT_TIMEOUT_MINUTES)}
      </button>
      <button
        type="button"
        className={'msg-mod-btn danger' + (armed ? ' armed' : '')}
        disabled={moderation.busy}
        title={armed ? `Confirm ban for @${login}` : `Ban @${login}`}
        onClick={() => {
          if (!armed) { setArmed(true); return; }
          setArmed(false);
          moderation.onBan(login);
        }}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'sure?' : 'ban'}
      </button>
    </span>
  );
}

/**
 * A single chat row. Shared by the dashboard chat panel and the viewer detail
 * page's history so both read identically. `viewer` supplies the name colour and
 * role badges; pass `onUserClick` to make the name open a popout (the dashboard
 * does, the viewer page — already on that person — does not). `fromThisStream`
 * dims rows from an earlier session; leave it true where session dimming doesn't
 * apply. `moderation` adds the hover action pair; leave it off for read-only
 * surfaces.
 */
export function ChatMessageRow({
  m,
  viewer,
  fromThisStream = true,
  onUserClick,
  emoteMap = {},
  channel = '',
  moderation,
}: {
  m: ChatEntry;
  viewer?: Viewer;
  fromThisStream?: boolean;
  onUserClick?: (login: string) => void;
  emoteMap?: Record<string, string>;
  /** Operator's login, so rows that ping them stand out. Empty disables the check. */
  channel?: string;
  moderation?: ChatRowModeration;
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
  // Twitch refuses to time out or ban a broadcaster or moderator, so offering the
  // buttons there would only ever produce an error toast.
  const moderatable = moderation
    && !viewer?.roles.includes('broadcaster')
    && !viewer?.roles.includes('mod')
    && m.user.toLowerCase() !== channel.toLowerCase();
  const status = moderatable ? moderation.status : null;
  return (
    <div
      className={'msg' + hlClass + (fromThisStream ? '' : ' msg--past') + (isMention ? ' msg--mention' : '')
        + (status ? ' msg--moderated' : '')}
    >
      <span className="msg-time">{m.time}</span>
      <span className="msg-user" style={nameStyle} onClick={onNameClick}>{display}</span>
      <span className="msg-text">{body}</span>
      {/* Last in the row: the dashboard positions this absolutely, so DOM order does
          not affect where it lands there, while the tablet renders it in flow on its
          own line below the message — which only reads correctly from here. */}
      {moderatable && <ChatRowActions login={m.user} moderation={moderation} />}
    </div>
  );
}

// Exported so the tablet can render the identical chat surface (read-only there —
// it omits the ChatInput footer). Keep it prop-driven via PanelCtx so the two
// surfaces can't drift apart.
//
// `canModerate` is opt-in. Both operator surfaces (dashboard and tablet) pass it;
// they hold the same token, so the difference is presentation, not authority. The
// row actions are hover-revealed on the dashboard and always visible + finger-sized
// on the tablet, because a touch surface has no hover and the first tap would
// otherwise both reveal and press — see the `.tablet-shell` overrides in panel.css.
export function Chat({ ctx, canModerate = false }: { ctx: PanelCtx; canModerate?: boolean }) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);
  const lastIdRef = React.useRef(ctx.chat[ctx.chat.length - 1]?.id ?? '');
  const loadingRef = React.useRef(false);
  const exhaustedRef = React.useRef(false);
  // Tears down an in-flight "stick to bottom" hold (see scrollToBottom).
  const stickReleaseRef = React.useRef<null | (() => void)>(null);
  const [, setAtBottom] = React.useState(true);
  const [newCount, setNewCount] = React.useState(0);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [chatSearch, setChatSearch] = React.useState('');
  // Keyed by login, not by message id: a ban is handed to the person, so every
  // row of theirs on screen should say so, not just the one that was clicked.
  const [modStatus, setModStatus] = React.useState<Record<string, ChatRowModerationStatus>>({});
  const [modBusy, setModBusy] = React.useState<string | null>(null);
  const [modError, setModError] = React.useState<string | null>(null);
  const emoteMap = useEmotes();

  const moderate = React.useCallback((login: string, kind: 'timeout' | 'ban') => {
    const key = login.toLowerCase();
    setModBusy(key);
    setModError(null);

    // No reason field on a row action — the whole point is that it lands in one
    // click. The modal is still there when the moment warrants an explanation.
    const request = kind === 'timeout'
      ? timeoutViewer(login, timeoutSeconds(DEFAULT_TIMEOUT_MINUTES), '')
      : banViewer(login, '');

    void request
      // Marked only after Twitch confirms. An optimistic chip would tell the
      // operator someone is gone while they carry on typing in chat.
      .then(() => setModStatus(previous => ({
        ...previous,
        [key]: kind === 'timeout'
          ? { kind, label: `timed out · ${timeoutLabel(DEFAULT_TIMEOUT_MINUTES)}` }
          : { kind, label: 'banned' },
      })))
      .catch(caught => setModError(errorMessage(caught, kind === 'ban' ? 'Ban failed' : 'Timeout failed')))
      .finally(() => setModBusy(current => (current === key ? null : current)));
  }, []);

  const onRowTimeout = React.useCallback((login: string) => moderate(login, 'timeout'), [moderate]);
  const onRowBan = React.useCallback((login: string) => moderate(login, 'ban'), [moderate]);

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
      {modError && <div className="chat-mod-error" role="status">{modError}</div>}
      <div className="chat-list" ref={listRef} onScroll={handleScroll}>
        {loadingOlder && <div className="chat-loading">loading…</div>}
        {displayedChat.map((m, index) => {
          // Whispers arrive live and carry no session, so they never read as past.
          const fromThisStream = m.kind === 'whisper' || belongsToCurrentSession(m.sessionId, ctx.currentSessionId);
          const login = m.user.toLowerCase();
          return (
            <React.Fragment key={m.id}>
              {index === currentSessionStart && <div className="chat-divider">this stream</div>}
              <ChatMessageRow
                m={m}
                viewer={ctx.viewers[login]}
                fromThisStream={fromThisStream}
                onUserClick={ctx.openViewerPopout}
                emoteMap={emoteMap}
                channel={ctx.channel}
                moderation={canModerate ? {
                  status: modStatus[login] ?? null,
                  busy: modBusy === login,
                  onTimeout: onRowTimeout,
                  onBan: onRowBan,
                } : undefined}
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
