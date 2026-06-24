import React from 'react';
import { OVERLAY_CHAT_EXPIRE_MS, OVERLAY_CHAT_FADE_MS } from '../shared/constants';
import { getRoleFromBadges, type Role } from '../shared/roles';
import type { ChatMessage, ChatModerationEvent } from '../shared/api';
import { useSocket } from './realtime';

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
  return text.split(/(\s+)/).map((part, i) =>
    emoteMap[part] ? (
      <img key={`bttv-${baseKey}-${i}`} className="chatEmote" src={emoteMap[part]} alt={part} title={part} />
    ) : (
      part
    ),
  );
}

export function renderContent(
  text: string,
  twitchEmotes: Record<string, string[]> | null,
  emoteMap: Record<string, string>,
): React.ReactNode {
  type Range = { start: number; end: number; url: string; name: string };
  const ranges: Range[] = [];

  if (twitchEmotes) {
    for (const [emoteId, positions] of Object.entries(twitchEmotes)) {
      const url = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`;
      for (const pos of positions) {
        const [start, end] = pos.split('-').map(Number);
        ranges.push({ start, end, url, name: text.slice(start, end + 1) });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (cursor < range.start) nodes.push(...renderWords(text.slice(cursor, range.start), emoteMap, cursor));
    nodes.push(
      <img key={`t-${range.start}`} className="chatEmote" src={range.url} alt={range.name} title={range.name} />,
    );
    cursor = range.end + 1;
  }

  if (cursor < text.length) nodes.push(...renderWords(text.slice(cursor), emoteMap, cursor));

  return nodes;
}

export function useChat(expireAfterMs = 0) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  React.useEffect(() => {
    if (expireAfterMs > 0) return;
    fetch('/api/chat/recent')
      .then(r => r.json())
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
        setMessages(current => [...current.slice(-39), message]);
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

export function useEmotes() {
  const [emoteMap, setEmoteMap] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    fetch('/api/emotes')
      .then(r => r.json())
      .then(setEmoteMap)
      .catch(() => {});
  }, []);

  return emoteMap;
}

export function ChatPanel({ compact = false }: { compact?: boolean }) {
  const messages = useChat(compact ? overlayChatExpireMs : 0);
  const emoteMap = useEmotes();
  const filtered = compact ? messages.filter(m => !m.deletedAt) : messages;
  const visibleMessages = compact ? [...filtered].reverse() : filtered;

  return (
    <section className={compact ? 'chatPanel compact' : 'chatPanel'}>
      {visibleMessages.length === 0 && !compact ? (
        <p className="muted">Waiting for Twitch chat…</p>
      ) : null}
      {visibleMessages.map(message => {
        const role = getRole(message.badges);
        const isMention = message.message.toLowerCase().includes('codeacula');
        const classes = [
          'chatMessage',
          message.deletedAt ? 'moderated' : '',
          message.isFirstTimer ? 'firstTime' : '',
          isMention ? 'mention' : '',
          message.isExiting ? 'exiting' : '',
        ].filter(Boolean).join(' ');

        return (
          <article className={classes} data-role={role} key={message.id}>
            <strong style={{ color: message.color ?? 'var(--gold)' }}>{message.displayName}</strong>
            <span>{renderContent(message.message, message.emotes, emoteMap)}</span>
            {message.deletedAt ? <em>{message.deletedReason ?? 'moderated'}</em> : null}
          </article>
        );
      })}
    </section>
  );
}
