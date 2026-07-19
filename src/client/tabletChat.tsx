// Read-only chat for the tablet control surface, with a toggle to flip the panel
// between the chat feed and the live chatters list. Both views reuse the dashboard's
// own components (Chat, ChattersPanel) via a shared PanelCtx so the surfaces can't
// drift apart. The data plumbing is a trimmed version of the dashboard's: enough to
// render the same rows, without the dashboard's wider viewer/attention machinery.
import React from 'react';
import { Chat, ChattersPanel, mergeRecentChatters, type PanelCtx, type RecentChatter } from './ui/panels';
import { useSocket, useSocketReconnect } from './realtime';
import { chatHighlight } from '../shared/roles';
import { CHAT_PRESENCE_TTL_MS } from '../shared/constants';
import {
  getChatEntries,
  getChatEntriesBefore,
  getChatters,
  getDashboardStatus,
  getViewers,
} from './services/dashboard';
import type {
  Chatter,
  ChatEntry,
  ChatMessage as LiveChatMessage,
  ChatModerationEvent,
  DashboardStatus,
  Viewer,
  ViewerProfileUpdate,
} from '../shared/api';
import { errorMessage } from './errors';

// A full older-chat page; a short page means we've reached the beginning.
const OLDER_CHAT_PAGE = 80;
// Twitch's chatter presence lags, so re-poll it while the tab is open.
const CHATTERS_POLL_MS = 30_000;

type TabletChatData = {
  ctx: PanelCtx;
  chatters: Chatter[];
  chattersError: string | null;
};

function useTabletChatData(): TabletChatData {
  const [chat, setChat] = React.useState<ChatEntry[]>([]);
  const [viewers, setViewers] = React.useState<Record<string, Viewer>>({});
  const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(null);
  const [chatters, setChatters] = React.useState<Chatter[]>([]);
  // People who just chatted, folded into the presence list so they show at once
  // instead of waiting on Twitch's laggy poll. See mergeRecentChatters.
  const [recentChatters, setRecentChatters] = React.useState<RecentChatter[]>([]);
  const [chattersError, setChattersError] = React.useState<string | null>(null);
  const channelRef = React.useRef('');
  // Logins we already have a viewer record for, so a brand-new chatter triggers a
  // single viewer refetch (for their colour/badges) rather than one per message.
  const viewerLoginsRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([getChatEntries(), getViewers(), getDashboardStatus()])
      .then(([nextChat, nextViewers, status]) => {
        if (cancelled) return;
        setChat(nextChat);
        setViewers(nextViewers);
        setCurrentSessionId(status.streamSessionId);
        channelRef.current = status.channel.toLowerCase();
      })
      .catch((error: unknown) => {
        console.error('Failed to load tablet chat:', error);
      });
    return () => { cancelled = true; };
  }, []);

  // Chatter presence is fetched on its own so a missing moderator:read:chatters
  // scope surfaces in the list (ChattersPanel shows a permission notice) without
  // breaking the chat feed. Re-poll while open and refetch on socket reconnect.
  const refreshChatters = React.useCallback(() => {
    getChatters()
      .then(result => {
        setChatters(result.chatters);
        setChattersError(null);
      })
      .catch((error: unknown) => {
        setChattersError(errorMessage(error, 'Could not load chatters'));
      });
  }, []);

  React.useEffect(() => {
    refreshChatters();
    const timer = setInterval(refreshChatters, CHATTERS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshChatters]);

  useSocketReconnect(refreshChatters);

  React.useEffect(() => {
    viewerLoginsRef.current = new Set(Object.keys(viewers));
  }, [viewers]);

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
    const now = Date.now();
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
    // tmi reconnects can replay a message; dedupe and cap the live tail so a long
    // stream doesn't grow render cost without bound.
    setChat(current => current.some(entry => entry.id === nextEntry.id) ? current : [...current, nextEntry].slice(-400));

    // A message proves the sender is here before Twitch's presence poll lists them;
    // fold them into the chatters list and drop anyone aged past the TTL.
    setRecentChatters(current => {
      const cutoff = now - CHAT_PRESENCE_TTL_MS;
      const kept = current.filter(entry => entry.at >= cutoff && entry.chatter.userLogin.toLowerCase() !== login);
      const chatter: Chatter = { userId: 'chat:' + login, userLogin: message.username, userName: message.displayName || message.username };
      return [...kept, { chatter, at: now }];
    });

    if (!viewerLoginsRef.current.has(login)) {
      viewerLoginsRef.current.add(login);
      void getViewers().then(setViewers).catch((error: unknown) => {
        console.error('Failed to refresh viewers after chat message:', error);
      });
    }
  }, []));

  // A moderated message flips to its deleted state on the server; refetch so the
  // tablet shows the same soft-deleted rows the dashboard does.
  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch((error: unknown) => {
      console.error('Failed to refresh chat after moderation event:', error);
    });
  }, []));

  useSocket<DashboardStatus>('dashboard:status', React.useCallback((status) => {
    setCurrentSessionId(status.streamSessionId);
  }, []));

  const loadOlderChat = React.useCallback(async () => {
    const oldest = chat[0];
    if (!oldest) return false;
    const older = await getChatEntriesBefore(oldest.id);
    if (older.length === 0) return false;
    setChat(current => [...older, ...current]);
    return older.length === OLDER_CHAT_PAGE;
  }, [chat]);

  const openViewerPopout = React.useCallback((login: string) => {
    const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
  }, []);

  // Twitch presence plus anyone who chatted recently, recomputed on each change so
  // aged-out senders fall away.
  const liveChatters = React.useMemo(
    () => mergeRecentChatters(chatters, recentChatters, Date.now(), CHAT_PRESENCE_TTL_MS),
    [chatters, recentChatters],
  );

  const ctx: PanelCtx = {
    viewers,
    chat,
    events: [],
    channel: channelRef.current,
    currentSessionId,
    openViewerPopout,
    // Chat never edits profiles; satisfy the contract by echoing the input back.
    updateViewerProfile: async (_login: string, profile: ViewerProfileUpdate) => profile,
    loadOlderChat,
  };

  return { ctx, chatters: liveChatters, chattersError };
}

type ChatView = 'chat' | 'chatters';

/**
 * Right-column panel for the tablet, toggling between the read-only chat feed and
 * the live chatters list. Read-only: the chat has no ChatInput footer.
 */
export function TabletChatPanel() {
  const { ctx, chatters, chattersError } = useTabletChatData();
  const [view, setView] = React.useState<ChatView>('chat');

  return (
    <section className="tabletPanel tabletChatPanel">
      <div className="tabletPanelHeader">
        <div>
          <p className="eyebrow">Twitch</p>
          <h2>{view === 'chat' ? 'Chat' : 'Chatters'}</h2>
        </div>
        <div className="tabletChatToggle" role="group" aria-label="Chat panel view">
          <button
            type="button"
            className={view === 'chat' ? 'active' : undefined}
            aria-pressed={view === 'chat'}
            onClick={() => setView('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={view === 'chatters' ? 'active' : undefined}
            aria-pressed={view === 'chatters'}
            onClick={() => setView('chatters')}
          >
            Chatters
          </button>
        </div>
      </div>
      <div className="tabletChatBody">
        {view === 'chat' ? (
          <Chat ctx={ctx} />
        ) : (
          <ChattersPanel
            chatters={chatters}
            viewers={ctx.viewers}
            error={chattersError}
            onOpenViewer={ctx.openViewerPopout}
          />
        )}
      </div>
    </section>
  );
}
