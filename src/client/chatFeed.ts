// The chat/presence plumbing the dashboard and the tablet both need: the live chat
// tail, viewer records, Twitch presence, and the recently-chatted overlay on top of
// it. Surface-specific wiring (the dashboard's mention sound, attention feed and
// full refresh; the tablet's session tracking) stays with the caller.
import React from 'react';
import { mergeRecentChatters, type RecentChatter } from './ui/panels';
import { useSocket } from './realtime';
import { chatHighlight } from '../shared/roles';
import { CHAT_PRESENCE_TTL_MS } from '../shared/constants';
import {
  getChatEntries,
  getChatEntriesBefore,
  getChatters,
  getViewers,
} from './services/dashboard';
import type {
  Chatter,
  ChatEntry,
  ChatMessage as LiveChatMessage,
  ChatModerationEvent,
  Viewer,
} from '../shared/api';
import { errorMessage } from './errors';

// A full older-chat page; a short page means we've reached the beginning.
const OLDER_CHAT_PAGE = 80;
// Twitch's chatter presence lags, so re-poll it while the surface is open.
const CHATTERS_POLL_MS = 30_000;
// Cap the live tail so long streams don't grow render cost forever. loadOlderChat
// prepends older pages, so only the live tail is capped.
const LIVE_CHAT_CAP = 400;

export type ChatFeedHelpers = {
  refreshViewers: () => void;
};

export type ChatFeed = {
  chat: ChatEntry[];
  setChat: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  viewers: Record<string, Viewer>;
  setViewers: React.Dispatch<React.SetStateAction<Record<string, Viewer>>>;
  refreshViewers: () => void;
  chatters: Chatter[];
  liveChatters: Chatter[];
  chattersError: string | null;
  refreshChatters: () => void;
  loadOlderChat: () => Promise<boolean>;
};

export function useChatFeed(
  options: { onChatMessage?: (message: LiveChatMessage, helpers: ChatFeedHelpers) => void } = {},
): ChatFeed {
  const [chat, setChat] = React.useState<ChatEntry[]>([]);
  const [viewers, setViewers] = React.useState<Record<string, Viewer>>({});
  const [chatters, setChatters] = React.useState<Chatter[]>([]);
  // People who just chatted, folded into the presence list so they show at once
  // instead of waiting on Twitch's laggy poll. See mergeRecentChatters.
  const [recentChatters, setRecentChatters] = React.useState<RecentChatter[]>([]);
  const [chattersError, setChattersError] = React.useState<string | null>(null);
  // Logins we already have a viewer record for, so a brand-new chatter triggers a
  // single viewer refetch (for their colour/badges) rather than one per message.
  const viewerLoginsRef = React.useRef<Set<string>>(new Set());
  const mountedRef = React.useRef(true);
  const onChatMessageRef = React.useRef(options.onChatMessage);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    onChatMessageRef.current = options.onChatMessage;
  }, [options.onChatMessage]);

  React.useEffect(() => {
    viewerLoginsRef.current = new Set(Object.keys(viewers));
  }, [viewers]);

  const refreshViewers = React.useCallback(() => {
    void getViewers().then(nextViewers => {
      if (mountedRef.current) setViewers(nextViewers);
    }).catch((error: unknown) => {
      console.error('Failed to refresh viewers after chat message:', error);
    });
  }, []);

  // Chatter presence is fetched on its own so a missing moderator:read:chatters
  // scope surfaces in the list (ChattersPanel shows a permission notice) without
  // breaking the chat feed.
  const refreshChatters = React.useCallback(() => {
    getChatters()
      .then(result => {
        if (!mountedRef.current) return;
        setChatters(result.chatters);
        setChattersError(null);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setChattersError(errorMessage(error, 'Could not load chatters'));
      });
  }, []);

  React.useEffect(() => {
    refreshChatters();
    const timer = setInterval(refreshChatters, CHATTERS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshChatters]);

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
    const now = Date.now();
    onChatMessageRef.current?.(message, { refreshViewers });

    const login = message.username.toLowerCase();
    const nextEntry: ChatEntry = {
      id: message.id,
      user: login,
      text: message.message,
      time: new Date(message.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      at: message.receivedAt,
      sessionId: message.sessionId ?? null,
      highlight: chatHighlight(message.badges, Boolean(message.isFirstEver), Boolean(message.isFirstThisSession)),
      emotes: message.emotes,
    };
    // tmi reconnects can replay a message; dedupe before appending.
    setChat(current => current.some(entry => entry.id === nextEntry.id) ? current : [...current, nextEntry].slice(-LIVE_CHAT_CAP));

    // A message proves the sender is here before Twitch's presence poll lists them;
    // fold them in and drop anyone whose last message has aged past the TTL so
    // people who left don't linger.
    setRecentChatters(current => {
      const cutoff = now - CHAT_PRESENCE_TTL_MS;
      const kept = current.filter(entry => entry.at >= cutoff && entry.chatter.userLogin.toLowerCase() !== login);
      const chatter: Chatter = { userId: 'chat:' + login, userLogin: message.username, userName: message.displayName || message.username };
      return [...kept, { chatter, at: now }];
    });

    if (!viewerLoginsRef.current.has(login)) {
      viewerLoginsRef.current.add(login);
      refreshViewers();
    }
  }, [refreshViewers]));

  // A moderated message flips to its deleted state on the server; refetch so every
  // surface shows the same soft-deleted rows.
  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      if (!mountedRef.current) return;
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch((error: unknown) => {
      console.error('Failed to refresh chat after moderation event:', error);
    });
  }, []));

  const loadOlderChat = React.useCallback(async () => {
    const oldest = chat[0];
    if (!oldest) return false;
    const older = await getChatEntriesBefore(oldest.id);
    if (older.length === 0) return false;
    setChat(current => [...older, ...current]);
    return older.length === OLDER_CHAT_PAGE;
  }, [chat]);

  // Twitch presence plus anyone who chatted recently, recomputed on each change so
  // aged-out senders fall away.
  const liveChatters = React.useMemo(
    () => mergeRecentChatters(chatters, recentChatters, Date.now(), CHAT_PRESENCE_TTL_MS),
    [chatters, recentChatters],
  );

  return {
    chat,
    setChat,
    viewers,
    setViewers,
    refreshViewers,
    chatters,
    liveChatters,
    chattersError,
    refreshChatters,
    loadOlderChat,
  };
}
