// Chat for the tablet control surface, with a toggle to flip the panel between the
// chat feed and the live chatters list. Both views reuse the dashboard's own
// components (Chat, ChattersPanel) via a shared PanelCtx so the surfaces can't
// drift apart. The data plumbing is the shared useChatFeed hook, so the tablet
// renders the same rows without the dashboard's wider viewer/attention machinery.
//
// The operator cannot *send* from here (no ChatInput footer) but can moderate: the
// tablet holds the same operator token as the dashboard, and it is the surface most
// likely to be within reach mid-stream. The row actions render differently here —
// always visible and finger-sized rather than hover-revealed — see the .tablet-shell
// overrides in panel.css.
import React from 'react';
import { Chat, ChattersPanel, type PanelCtx } from './ui/panels';
import { useChatFeed } from './chatFeed';
import { openViewerPopout } from './viewerPopout';
import { useSocket, useSocketReconnect } from './realtime';
import {
  getChatEntries,
  getDashboardStatus,
  getViewers,
} from './services/dashboard';
import type {
  Chatter,
  DashboardStatus,
  ViewerProfileUpdate,
} from '../shared/api';

type TabletChatData = {
  ctx: PanelCtx;
  chatters: Chatter[];
  chattersError: string | null;
  chattersLoaded: boolean;
};

function useTabletChatData(): TabletChatData {
  const feed = useChatFeed();
  const { setChat, setViewers, refreshChatters, feedSucceeded, feedFailed } = feed;
  const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(null);
  const channelRef = React.useRef('');
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // One load, then the socket keeps it current. Its outcome feeds the chat's
  // feedHealth so a failed load reads "Chat unavailable" with a Retry, not "No chat yet".
  const loadChat = React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers(), getDashboardStatus()])
      .then(([nextChat, nextViewers, status]) => {
        if (!mountedRef.current) return;
        setChat(nextChat);
        setViewers(nextViewers);
        setCurrentSessionId(status.streamSessionId);
        channelRef.current = status.channel.toLowerCase();
        feedSucceeded();
      })
      .catch((error: unknown) => {
        console.error('Failed to load tablet chat:', error);
        if (mountedRef.current) feedFailed();
      });
  }, [setChat, setViewers, feedSucceeded, feedFailed]);

  React.useEffect(() => { loadChat(); }, [loadChat]);

  // Presence can go stale while the socket is down, so re-sync on reconnect.
  useSocketReconnect(refreshChatters);

  useSocket<DashboardStatus>('dashboard:status', React.useCallback((status) => {
    setCurrentSessionId(status.streamSessionId);
  }, []));

  const ctx: PanelCtx = {
    viewers: feed.viewers,
    chat: feed.chat,
    events: [],
    channel: channelRef.current,
    currentSessionId,
    openViewerPopout,
    // Chat never edits profiles; satisfy the contract by echoing the input back.
    updateViewerProfile: async (_login: string, profile: ViewerProfileUpdate) => profile,
    loadOlderChat: feed.loadOlderChat,
    feedHealth: feed.feedHealth,
    onRetryFeed: loadChat,
  };

  return { ctx, chatters: feed.liveChatters, chattersError: feed.chattersError, chattersLoaded: feed.chattersLoaded };
}

type ChatView = 'chat' | 'chatters';

/**
 * Right-column panel for the tablet, toggling between the chat feed and the live
 * chatters list. The chat has no ChatInput footer — the tablet reads and moderates,
 * it does not compose.
 */
export function TabletChatPanel() {
  const { ctx, chatters, chattersError, chattersLoaded } = useTabletChatData();
  const [view, setView] = React.useState<ChatView>('chat');

  return (
    <section className="tablet-panel tablet-chat-panel">
      <div className="tablet-panel-header">
        <div>
          <p className="eyebrow">Twitch</p>
          <h2>{view === 'chat' ? 'Chat' : 'Chatters'}</h2>
        </div>
        <div className="tablet-chat-toggle" role="group" aria-label="Chat panel view">
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
      <div className="tablet-chat-body">
        {view === 'chat' ? (
          <Chat ctx={ctx} canModerate />
        ) : (
          <ChattersPanel
            chatters={chatters}
            viewers={ctx.viewers}
            error={chattersError}
            loaded={chattersLoaded}
            onOpenViewer={ctx.openViewerPopout}
          />
        )}
      </div>
    </section>
  );
}
