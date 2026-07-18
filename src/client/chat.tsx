import React from 'react';
import { OVERLAY_CHAT_EXPIRE_MS, OVERLAY_CHAT_FADE_MS } from '../shared/constants';
import { getRoleFromBadges, type Role } from '../shared/roles';
import type { ChatMessage, ChatModerationEvent } from '../shared/api';
import { isMentionOf, parseLinkToken } from './chatText';
import { useSocket } from './realtime';
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
      nodes.push(<img key={`bttv-${baseKey}-${i}`} className="chatEmote" src={emote} alt={part} title={part} />);
      return;
    }

    // Emote codes win over URLs: a code is an exact whole-token match, so it can
    // only collide with a link if the operator has an emote literally named after
    // one, and in that case the emote is what chat meant.
    const link = parseLinkToken(part);
    if (link) {
      nodes.push(
        <a
          key={`url-${baseKey}-${i}`}
          className="chatLink"
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
        const [start, end] = pos.split('-').map(Number);
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
      <img key={`t-${range.start}`} className="chatEmote" src={range.url} alt={range.name} title={range.name} />,
    );
    cursor = range.end + 1;
  }

  if (cursor < chars.length) nodes.push(...renderWords(chars.slice(cursor).join(''), emoteMap, cursor));

  return nodes;
}

export function useChat(expireAfterMs = 0) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  React.useEffect(() => {
    if (expireAfterMs > 0) return;
    getRecentChat()
      .then((data: ChatMessage[]) => setMessages(data.map(m => ({
        ...m,
        isFirstTimer: Boolean(m.isFirstEver),
        isFirstThisSession: Boolean(m.isFirstThisSession),
        isFirstEver: Boolean(m.isFirstEver),
      }))))
      .catch(() => setMessages([]));
  }, [expireAfterMs]);

  useSocket<ChatMessage>(
    'chat:message',
    React.useCallback(
      (message) => {
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
      setMessages(current =>
        current.map(message => {
          const matchesMessage = event.messageId && message.id === event.messageId;
          const matchesUser = event.username && message.username.toLowerCase() === event.username.toLowerCase();
          const matchesClear = event.type === 'chat.clear';
          if (!matchesMessage && !matchesUser && !matchesClear) return message;
          return { ...message, deletedAt: event.deletedAt, deletedReason: event.deletedReason };
        }),
      );
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
    <section className={compact ? 'chatPanel compact' : 'chatPanel'}>
      {visibleMessages.length === 0 && !compact ? (
        <p className="muted">Waiting for Twitch chat…</p>
      ) : null}
      {visibleMessages.map(message => {
        const role = getRole(message.badges);
        const isMention = isMentionOf(message.message, channel);
        const classes = [
          'chatMessage',
          message.deletedAt ? 'moderated' : '',
          message.isFirstTimer ? 'firstTime' : '',
          isMention ? 'mention' : '',
          message.isExiting ? 'exiting' : '',
        ].filter(Boolean).join(' ');

        return (
          <article className={classes} data-role={role} key={message.id}>
            <strong style={{ color: message.color ?? 'var(--gold-500)' }}>{message.displayName}</strong>
            <span>{renderContent(message.message, message.emotes, emoteMap)}</span>
            {message.deletedAt ? <em>{message.deletedReason ?? 'moderated'}</em> : null}
          </article>
        );
      })}
    </section>
  );
}
