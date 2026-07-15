// Read-only chat for the tablet control surface. Renders the dashboard's own Chat
// component (search, load-older, session dividers, emotes, name colours) but omits
// the send box — the tablet mirrors chat rather than driving it. The data plumbing
// is a trimmed version of the dashboard's: the tablet needs no recent-chatter folding
// or per-message viewer debounce, only enough to render the same rows.
import React from 'react';
import { Chat, type PanelCtx } from './ui/panels';
import { useSocket } from './realtime';
import { chatHighlight } from '../shared/roles';
import {
  getChatEntries,
  getChatEntriesBefore,
  getDashboardStatus,
  getViewers,
} from './services/dashboard';
import type {
  ChatEntry,
  ChatMessage as LiveChatMessage,
  ChatModerationEvent,
  DashboardStatus,
  Viewer,
  ViewerProfileUpdate,
} from '../shared/api';

// A full older-chat page; a short page means we've reached the beginning.
const OLDER_CHAT_PAGE = 80;

function useTabletChat(): PanelCtx {
  const [chat, setChat] = React.useState<ChatEntry[]>([]);
  const [viewers, setViewers] = React.useState<Record<string, Viewer>>({});
  const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(null);
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

  React.useEffect(() => {
    viewerLoginsRef.current = new Set(Object.keys(viewers));
  }, [viewers]);

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
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

  return {
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
}

/** Right-column chat panel for the tablet. Read-only: no ChatInput footer. */
export function TabletChatPanel() {
  const ctx = useTabletChat();
  return (
    <section className="tabletPanel tabletChatPanel">
      <div className="tabletPanelHeader">
        <div>
          <p className="eyebrow">Twitch</p>
          <h2>Chat</h2>
        </div>
      </div>
      <div className="tabletChatBody">
        <Chat ctx={ctx} />
      </div>
    </section>
  );
}
