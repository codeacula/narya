import React from 'react';
import { OVERLAY_CHAT_EXPIRE_MS, OVERLAY_CHAT_FADE_MS } from '../shared/constants';
import { getRoleFromBadges, type Role } from '../shared/roles';
import type { ChatMessage, ChatModerationEvent } from '../shared/api';
import { isMentionOf, parseLinkToken } from './chatText';
import { useSocket, useSocketReconnect } from './realtime';
import { getEmotes, getHealth, getRecentChat } from './services/dashboard';

export type { ChatMessage, ChatModerationEvent } from '../shared/api';
export type { Role } from '../shared/roles';

export const overlayChatExpireMs = OVERLAY_CHAT_EXPIRE_MS;
export const overlayChatFadeMs = OVERLAY_CHAT_FADE_MS;

export function getRole(badges: Record<string, string> | null): Role {
  return getRoleFromBadges(badges);
}

export function renderWords(
  text: string,
  emoteMap: Record<string, string>,
  baseKey: number,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];

  text.split(/(\s+)/).forEach((part, i) => {
    const emote = emoteMap[part];
    if (emote) {
      nodes.push(<img key={`bttv-${baseKey}-${i}`} className="chat-emote" src={emote} alt={part} title={part} />);
      return;
    }

    // Emote codes win over URLs: a code is an exact whole-token match, so it can
    // only collide with a link if the operator has an emote literally named after
    // one, and in that case the emote is what chat meant.
    const link = parseLinkToken(part);
    if (link) {
      if (link.leading) nodes.push(link.leading);
      nodes.push(
        <a
          key={`url-${baseKey}-${i}`}
          className="chat-link"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          {link.label}
        </a>,
      );
      if (link.trailing) nodes.push(link.trailing);
      return;
    }

    nodes.push(part);
  });

  return nodes;
}

export function renderContent(
  text: string,
  twitchEmotes: Record<string, string[]> | null,
  emoteMap: Record<string, string>,
): React.ReactNode {
  type Range = { start: number; end: number; url: string; name: string };
  const ranges: Range[] = [];

  // Twitch emote positions are code-point indices, but JS string slicing works
  // on UTF-16 units — split into a code-point array so astral chars (emoji)
  // before an emote don't misalign the ranges.
  const chars = [...text];

  if (twitchEmotes) {
    for (const [emoteId, positions] of Object.entries(twitchEmotes)) {
      const url = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`;
      for (const pos of positions) {
        const [start = NaN, end = NaN] = pos.split('-').map(Number);
        ranges.push({ start, end, url, name: chars.slice(start, end + 1).join('') });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (cursor < range.start) nodes.push(...renderWords(chars.slice(cursor, range.start).join(''), emoteMap, cursor));
    nodes.push(
      <img key={`t-${range.start}`} className="chat-emote" src={range.url} alt={range.name} title={range.name} />,
    );
    cursor = range.end + 1;
  }

  if (cursor < chars.length) nodes.push(...renderWords(chars.slice(cursor).join(''), emoteMap, cursor));

  return nodes;
}

function normalizeRecent(data: ChatMessage[]): ChatMessage[] {
  return data.map(m => ({
    ...m,
    isFirstTimer: Boolean(m.isFirstEver),
    isFirstThisSession: Boolean(m.isFirstThisSession),
    isFirstEver: Boolean(m.isFirstEver),
  }));
}

export function applyModeration(messages: ChatMessage[], event: ChatModerationEvent): ChatMessage[] {
  return messages.map(message => {
    const matchesMessage = event.messageId && message.id === event.messageId;
    const matchesUser = event.username && message.username.toLowerCase() === event.username.toLowerCase();
    const matchesClear = event.type === 'chat.clear';
    if (!matchesMessage && !matchesUser && !matchesClear) return message;
    return { ...message, deletedAt: event.deletedAt, deletedReason: event.deletedReason };
  });
}

export function useChat(expireAfterMs = 0) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  // Messages and moderation that arrive over the socket while a (re)fetch is in flight,
  // replayed on top of its result so the response cannot erase them.
  const pendingRef = React.useRef<{ messages: ChatMessage[]; moderation: ChatModerationEvent[] } | null>(null);

  const loadRecent = React.useCallback((resetOnError: boolean) => {
    const pending = { messages: [] as ChatMessage[], moderation: [] as ChatModerationEvent[] };
    pendingRef.current = pending;
    getRecentChat()
      .then((data: ChatMessage[]) => {
        if (pendingRef.current !== pending) return;
        const fetched = normalizeRecent(data);
        const ids = new Set(fetched.map(m => m.id));
        const merged = [...fetched, ...pending.messages.filter(m => !ids.has(m.id))].slice(-40);
        setMessages(pending.moderation.reduce(applyModeration, merged));
      })
      .catch(() => {
        // A failed reconnect refetch keeps what is showing; only the first load resets.
        if (resetOnError) setMessages([]);
      })
      .finally(() => {
        if (pendingRef.current === pending) pendingRef.current = null;
      });
  }, []);

  React.useEffect(() => {
    if (expireAfterMs > 0) return;
    loadRecent(true);
  }, [expireAfterMs, loadRecent]);

  // Chat that never expires (the holding scenes) keeps a moderated row until told
  // otherwise, and the shared socket does not replay what it missed, so a
  // chat:moderated lost in a gap would leave removed chat on a live scene. Expiring
  // overlay chat clears itself and needs no correction.
  useSocketReconnect(React.useCallback(() => {
    if (expireAfterMs === 0) loadRecent(false);
  }, [expireAfterMs, loadRecent]));

  useSocket<ChatMessage>(
    'chat:message',
    React.useCallback(
      (message) => {
        pendingRef.current?.messages.push(message);
        setMessages(current => {
          // tmi reconnects can replay a message we've already appended.
          if (current.some(m => m.id === message.id)) return current;
          return [...current.slice(-39), message];
        });
        if (expireAfterMs > 0) {
          setTimeout(() => {
            setMessages(current => current.map(m => (m.id === message.id ? { ...m, isExiting: true } : m)));
          }, expireAfterMs);
          setTimeout(() => {
            setMessages(current => current.filter(m => m.id !== message.id));
          }, expireAfterMs + overlayChatFadeMs);
        }
      },
      [expireAfterMs],
    ),
  );

  useSocket<ChatModerationEvent>(
    'chat:moderated',
    React.useCallback((event) => {
      pendingRef.current?.moderation.push(event);
      setMessages(current => applyModeration(current, event));
    }, []),
  );

  return messages;
}

// Shared across every useEmotes() caller in a document so a page with multiple
// chat surfaces (dashboard chat + spotlight, or the viewer page's history +
// spotlight) issues one /api/emotes request instead of one per mount. Cleared on
// failure so a later mount can retry rather than reusing a rejected promise.
let emoteMapRequest: Promise<Record<string, string>> | null = null;

function loadEmoteMap(): Promise<Record<string, string>> {
  if (!emoteMapRequest) {
    emoteMapRequest = getEmotes().catch((error) => {
      emoteMapRequest = null;
      throw error;
    });
  }
  return emoteMapRequest;
}

export function useEmotes() {
  const [emoteMap, setEmoteMap] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let active = true;
    loadEmoteMap()
      .then(map => { if (active) setEmoteMap(map); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  return emoteMap;
}

// The configured Twitch channel login (lowercased), fetched once from
// /api/health. Used for @-mention highlighting without hardcoding the login.
export function useChannel(): string {
  const [channel, setChannel] = React.useState('');

  React.useEffect(() => {
    getHealth()
      .then((data) => setChannel((data.twitchChannel ?? '').toLowerCase()))
      .catch(() => {});
  }, []);

  return channel;
}

export function ChatPanel({ compact = false }: { compact?: boolean }) {
  const messages = useChat(compact ? overlayChatExpireMs : 0);
  const emoteMap = useEmotes();
  const channel = useChannel();
  const filtered = compact ? messages.filter(m => !m.deletedAt) : messages;
  const visibleMessages = compact ? [...filtered].reverse() : filtered;

  return (
    <section className={compact ? 'chat-panel compact' : 'chat-panel'}>
      {visibleMessages.length === 0 && !compact ? (
        <p className="muted">Waiting for Twitch chat…</p>
      ) : null}
      {visibleMessages.map(message => {
        const role = getRole(message.badges);
        const isMention = isMentionOf(message.message, channel);
        const classes = [
          'chat-message',
          message.deletedAt ? 'moderated' : '',
          message.isFirstTimer ? 'first-time' : '',
          isMention ? 'mention' : '',
          message.isExiting ? 'exiting' : '',
        ].filter(Boolean).join(' ');

        return (
          <article className={classes} data-role={role} key={message.id}>
            {/* Overlay rows colour the name by role (CSS), not by the viewer's Twitch colour. */}
            <strong style={compact ? undefined : { color: message.color ?? 'var(--gold-500)' }}>{message.displayName}</strong>
            <span>{renderContent(message.message, message.emotes, emoteMap)}</span>
            {message.deletedAt ? <em>{message.deletedReason ?? 'moderated'}</em> : null}
          </article>
        );
      })}
    </section>
  );
}
