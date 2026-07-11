import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { AttentionDismissAll, AttentionPanel, ChatInput, ControlsPanel, ChattersPanel, ShoutoutsPanel, MODULES, PanelCtx } from '../ui/panels';
import { TweaksPanel, TweakSection } from '../ui/tweaks';
import { useAttention, useAttentionSettings } from '../attention';
import { playTone } from '../sounds';
import {
  disconnectTwitch,
  getViewers,
  getChatEntries,
  getChatEntriesBefore,
  getStreamEvents,
  getDashboardStatus,
  getObsStatus,
  getStreamInfo,
  updateStreamInfo,
  getStreamStatus,
  updateStreamStatus,
  runPrerollAds,
  updateViewerProfile,
  runGoLive,
  switchObsScene,
  getChatters,
  reconnectEventSub,
} from '../services/dashboard';
import { useSessionShoutouts } from '../shoutouts';
import { useSocket } from '../realtime';
import { chatHighlight } from '../../shared/roles';
import { DASHBOARD_FULL_REFRESH_MS } from '../../shared/constants';
import { SettingsShell } from './settings/SettingsShell';
import {
  dashboardRouteFromName,
  dashboardRouteFromPath,
  isSettingsRoute,
  pathForDashboardRoute,
  pathForViewer,
  viewerLoginFromPath,
  type DashboardRoute,
} from '../routing';
import { ViewersPage } from './ViewersPage';
import { StreamInfoModal, type StreamInfoForm } from './StreamInfoModal';
import { useAutomodQueue, AutomodPanel } from '../automod';
import type { Viewer, ChatEntry, StreamEvent, StreamEventUpdate, DashboardStatus, ChatMessage as LiveChatMessage, ChatModerationEvent, Chatter, WhisperMessage, ObsStatus } from '../../shared/api';

/* ---------------- constants ---------------- */

const POP_DEFAULTS: Record<string, { w: number; h: number }> = {
  chat:      { w: 380, h: 540 },
  attention: { w: 380, h: 360 },
  chatters:  { w: 360, h: 500 },
};

type RightTab = 'chatters' | 'activity' | 'shoutouts' | 'automod';

// The tab strip names the panel on screen; this titles the popped-out window.
const RIGHT_TAB_TITLE: Record<RightTab, string> = {
  chatters: 'viewers',
  activity: 'activity feed',
  shoutouts: 'shoutouts',
  automod: 'automod',
};

type PoppedState = { x: number; y: number; w: number; h: number };

const EMPTY_STATUS: DashboardStatus = {
  channel: '',
  chatConnection: 'UNKNOWN',
  obsConnected: false,
  eventSubConnected: false,
  eventSubError: null,
  eventSubFailedSubscriptions: [],
  twitchAuthenticated: false,
  twitchAuthSource: null,
  twitchTokenExpiresAt: null,
  twitchMissingScopes: [],
  twitchBotAuthenticated: false,
  twitchBotAuthSource: null,
  twitchBotTokenExpiresAt: null,
  twitchBotMissingScopes: [],
  streamActive: null,
  uptimeSeconds: null,
  streamStartedAt: null,
  uptimeSource: null,
  viewerCount: null,
  activeChatters: 0,
  sessionChatters: 0,
  knownChatters: 0,
  streamSessionId: null,
  streamSessionStartedAt: null,
  bitrateKbps: null,
  congestion: null,
  totalFrames: null,
  droppedFrames: null,
  laggedFrames: null,
  adBreakEndsAt: null,
  adScheduleStatus: 'not_configured',
  adScheduleError: null,
  nextAdAt: null,
  lastAdAt: null,
  adBreakDurationSeconds: null,
  prerollFreeTimeSeconds: null,
  snoozeCount: null,
  snoozeRefreshAt: null,
};

const EMPTY_OBS_STATUS: ObsStatus = {
  connected: false,
  scenes: [],
  scenePrefix: '',
  currentProgramScene: null,
  currentPreviewScene: null,
  studioMode: false,
  lastError: null,
  updatedAt: new Date(0).toISOString(),
};

/* ---------------- Dashboard page ---------------- */

export function DashboardPage({ initialPage = 'dashboard' }: { initialPage?: DashboardRoute }) {
  const [page, setPage] = useState(initialPage);
  const [viewerLogin, setViewerLogin] = useState<string | null>(() => viewerLoginFromPath(window.location.pathname));
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [popped, setPopped] = useState<Record<string, PoppedState>>({});
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<DashboardStatus>(EMPTY_STATUS);
  const [streamInfoOpen, setStreamInfoOpen] = useState(false);
  const [streamInfoForm, setStreamInfoForm] = useState<StreamInfoForm>({ title: '', category: '', tags: [], status: '' });
  const [streamInfoLoading, setStreamInfoLoading] = useState(false);
  const [streamInfoSaving, setStreamInfoSaving] = useState(false);
  const [streamInfoMessage, setStreamInfoMessage] = useState<string | null>(null);
  const [streamInfoError, setStreamInfoError] = useState<string | null>(null);
  const [prerollBusy, setPrerollBusy] = useState(false);
  const [goLiveBusy, setGoLiveBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [obsStatus, setObsStatus] = useState<ObsStatus>(EMPTY_OBS_STATUS);
  const [sceneSwitching, setSceneSwitching] = useState(false);
  const [chatters, setChatters] = useState<Chatter[]>([]);
  const [chattersError, setChattersError] = useState<string | null>(null);
  const automodQueue = useAutomodQueue();
  const [rightTab, setRightTab] = useState<RightTab>('chatters');
  // False until the first REST refresh lands, so the attention feed can tell the
  // backlog apart from activity that arrived while you were watching.
  const [seeded, setSeeded] = useState(false);
  const { settings: attentionSettings, update: updateAttentionSettings } = useAttentionSettings();
  const shoutouts = useSessionShoutouts(status.streamSessionId);
  const lastChatAt = React.useRef<number>(0);
  // Mirror the channel into a ref so the stable chat:message handler can read
  // the current login without hardcoding it or re-subscribing.
  const channelRef = React.useRef('');
  // Known viewer logins + a trailing refresh timer so the chat handler avoids a
  // getViewers() request per message.
  const viewerLoginsRef = React.useRef<Set<string>>(new Set());
  const viewersDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const changePage = React.useCallback((nextPage: string) => {
    const route = dashboardRouteFromName(nextPage);
    const path = pathForDashboardRoute(route);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setPage(route);
  }, []);

  // Navigate to a single viewer's page (/viewers/<login>). Kept separate from
  // changePage because the destination carries a per-viewer path segment.
  const navigateToViewer = React.useCallback((login: string) => {
    const path = pathForViewer(login);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setViewerLogin(login.toLowerCase());
    setPage('viewer');
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = dashboardRouteFromPath(window.location.pathname);
      setPage(nextRoute);
      setViewerLogin(nextRoute === 'viewer' ? viewerLoginFromPath(window.location.pathname) : null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    channelRef.current = status.channel.toLowerCase();
  }, [status.channel]);

  useEffect(() => {
    viewerLoginsRef.current = new Set(Object.keys(viewers));
  }, [viewers]);

  useEffect(() => () => {
    if (viewersDebounceRef.current) clearTimeout(viewersDebounceRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshAll = async () => {
      try {
        const [nextViewers, nextChat, nextEvents, nextStatus, nextObsStatus] = await Promise.all([
          getViewers(),
          getChatEntries(),
          getStreamEvents(),
          getDashboardStatus(),
          getObsStatus().catch(() => null),
        ]);
        if (cancelled) return;
        setViewers(nextViewers);
        setChat(nextChat);
        setEvents(nextEvents);
        setStatus(nextStatus);
        if (nextObsStatus) setObsStatus(nextObsStatus);
      } catch (error) {
        console.error('Failed to refresh dashboard data:', error);
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      } finally {
        // Even a failed seed ends the quiet period; otherwise one bad fetch would
        // mute the attention chime for the rest of the session.
        if (!cancelled) setSeeded(true);
      }
    };

    const refreshChatters = async () => {
      try {
        const result = await getChatters();
        if (!cancelled) {
          setChatters(result.chatters);
          setChattersError(null);
        }
      } catch (error) {
        if (!cancelled) setChattersError(error instanceof Error ? error.message : 'Could not load chatters');
      }
    };

    void refreshAll();
    void refreshChatters();
    // No 5s status poll — the dashboard:status WS heartbeat keeps status fresh.
    const fullRefresh = setInterval(refreshAll, DASHBOARD_FULL_REFRESH_MS);
    const chattersRefresh = setInterval(refreshChatters, 30_000);

    return () => {
      cancelled = true;
      clearInterval(fullRefresh);
      clearInterval(chattersRefresh);
    };
  }, []);

  // Real Twitch EventSub events from the backend
  useSocket<StreamEvent>('stream:event', React.useCallback((evt) => {
    setEvents(evs => evs.some(existing => existing.id === evt.id) ? evs : [evt, ...evs.slice(0, 49)]);
  }, []));

  // A resub's second EventSub notification rewrites the row already on screen
  // rather than adding a duplicate. See emitStreamEvent/updateStreamEvent.
  useSocket<StreamEventUpdate>('stream:event:update', React.useCallback((update) => {
    setEvents(evs => evs.some(e => e.id === update.id)
      ? evs.map(e => e.id === update.id ? { ...e, detail: update.detail, tone: update.tone } : e)
      : evs);
  }, []));

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
    const now = Date.now();
    if (lastChatAt.current > 0 && now - lastChatAt.current > 5 * 60 * 1000) {
      playTone(880, 180, 0.15);
    }
    lastChatAt.current = now;

    const channel = channelRef.current;
    const isMention = channel ? message.message.toLowerCase().includes(channel) : false;
    if (isMention) {
      playTone(660, 80, 0.3);
      setTimeout(() => playTone(880, 120, 0.25), 90);
    }

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

    // Cap live-append so long streams don't grow render cost forever.
    // loadOlderChat prepends older pages, so only the live tail is capped here.
    setChat(current => current.some(entry => entry.id === nextEntry.id) ? current : [...current, nextEntry].slice(-400));

    // Status arrives via the dashboard:status WS heartbeat, so no per-message
    // status refetch. Only refetch viewers immediately for a login we don't yet
    // know about; otherwise coalesce updates into a trailing 15s refresh to pick
    // up message counts without a request per message.
    const refreshViewers = () => {
      void getViewers().then(setViewers).catch((error: unknown) => {
        console.error('Failed to refresh viewers after chat message:', error);
      });
    };
    if (!viewerLoginsRef.current.has(login)) {
      viewerLoginsRef.current.add(login);
      refreshViewers();
    }
    if (viewersDebounceRef.current) clearTimeout(viewersDebounceRef.current);
    viewersDebounceRef.current = setTimeout(refreshViewers, 15_000);
  }, []));

  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch((error: unknown) => {
      console.error('Failed to refresh chat after moderation event:', error);
    });
  }, []));

  useSocket<WhisperMessage>('whisper:message', React.useCallback((msg) => {
    playTone(520, 80, 0.2);
    setTimeout(() => playTone(660, 100, 0.15), 90);
    const entry: ChatEntry = {
      id: msg.id,
      user: msg.fromLogin,
      text: msg.text,
      time: new Date(msg.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      kind: 'whisper',
    };
    setChat(current => current.some(e => e.id === entry.id) ? current : [...current, entry]);
  }, []));

  useSocket<DashboardStatus>('dashboard:status', React.useCallback((nextStatus) => {
    setStatus(nextStatus);
  }, []));

  useSocket<ObsStatus>('obs:status', React.useCallback((nextStatus) => {
    setObsStatus(nextStatus);
  }, []));

  const handleTwitchLogout = React.useCallback(() => {
    void disconnectTwitch()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Failed to disconnect Twitch:', error);
      });
  }, []);

  const handleTwitchBotLogout = React.useCallback(() => {
    void disconnectTwitch('bot')
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Failed to disconnect Twitch bot:', error);
      });
  }, []);

  const handleReconnectEventSub = React.useCallback(() => {
    void reconnectEventSub()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Failed to reconnect EventSub:', error);
      });
  }, []);

  const refreshDashboardStatus = React.useCallback(() => {
    void getDashboardStatus().then(setStatus).catch((error: unknown) => {
      console.error('Failed to refresh dashboard status:', error);
    });
  }, []);

  useEffect(() => {
    const timeUntil = (value: string | null) => {
      if (!value) return null;
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) return null;
      const remaining = timestamp - Date.now();
      return remaining > 0 ? remaining : 250;
    };

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const adBreakMs = timeUntil(status.adBreakEndsAt);
    if (adBreakMs !== null) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(adBreakMs + 500, 2_147_483_647)));
    }
    if (status.prerollFreeTimeSeconds !== null && status.prerollFreeTimeSeconds > 0) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(status.prerollFreeTimeSeconds * 1000 + 500, 2_147_483_647)));
    }
    const nextAdMs = timeUntil(status.nextAdAt);
    if (nextAdMs !== null) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(nextAdMs + 500, 2_147_483_647)));
    }

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [refreshDashboardStatus, status.adBreakEndsAt, status.nextAdAt, status.prerollFreeTimeSeconds]);

  const handleRunPreroll = React.useCallback(() => {
    setPrerollBusy(true);
    setActionMessage(null);
    void runPrerollAds()
      .then(result => {
        const minutes = Math.round(result.durationSeconds / 60);
        setActionMessage(`${minutes}m ads started`);
        refreshDashboardStatus();
      })
      .catch(error => {
        setActionMessage(error instanceof Error ? error.message : 'Ad request failed');
      })
      .finally(() => setPrerollBusy(false));
  }, [refreshDashboardStatus]);

  const handleGoLive = React.useCallback(() => {
    setGoLiveBusy(true);
    setActionMessage(null);
    void runGoLive()
      .then(() => {
        setActionMessage('OBS stream started · Discord will announce when Twitch confirms you are live');
        refreshDashboardStatus();
      })
      .catch(error => {
        setActionMessage(error instanceof Error ? error.message : 'Go Live failed');
      })
      .finally(() => setGoLiveBusy(false));
  }, [refreshDashboardStatus]);

  const handleSwitchScene = React.useCallback((sceneName: string) => {
    setSceneSwitching(true);
    void switchObsScene(sceneName)
      .then(result => {
        if (result.obsStatus) setObsStatus(result.obsStatus);
      })
      .catch(error => {
        console.error('Failed to switch OBS scene:', error);
      })
      .finally(() => setSceneSwitching(false));
  }, []);

  const handleOpenStreamInfo = React.useCallback(() => {
    setStreamInfoOpen(true);
    setStreamInfoLoading(true);
    setStreamInfoMessage(null);
    setStreamInfoError(null);
    void Promise.all([getStreamInfo(), getStreamStatus()])
      .then(([info, status]) => {
        setStreamInfoForm({
          title: info.title,
          category: info.category,
          categoryId: info.categoryId || undefined,
          tags: info.tags,
          status: status.text,
        });
      })
      .catch(error => {
        setStreamInfoError(error instanceof Error ? error.message : 'Could not load stream info');
      })
      .finally(() => setStreamInfoLoading(false));
  }, []);

  const handleStreamInfoSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStreamInfoSaving(true);
    setStreamInfoMessage(null);
    setStreamInfoError(null);
    void Promise.all([
      updateStreamInfo({
        title: streamInfoForm.title,
        category: streamInfoForm.category,
        categoryId: streamInfoForm.categoryId,
        tags: streamInfoForm.tags,
      }),
      updateStreamStatus(streamInfoForm.status),
    ])
      .then(() => {
        // A save that worked is done with the modal. The confirmation lands in the
        // StatBar behind it, so closing loses nothing — leaving it open just made the
        // operator hunt for a Cancel button to dismiss a form they had finished with.
        setStreamInfoOpen(false);
        setStreamInfoMessage(null);
        setActionMessage('Stream info saved');
        refreshDashboardStatus();
      })
      .catch(error => {
        setStreamInfoError(error instanceof Error ? error.message : 'Could not save stream info');
      })
      .finally(() => setStreamInfoSaving(false));
  }, [refreshDashboardStatus, streamInfoForm]);

  const attention = useAttention({
    events,
    chat,
    viewers,
    tag: attentionSettings.tag,
    soundEnabled: attentionSettings.soundEnabled,
    currentSessionId: status.streamSessionId,
    seeded,
  });

  const ctx: PanelCtx = {
    viewers,
    chat,
    events,
    channel: status.channel,
    currentSessionId: status.streamSessionId,
    openViewerPopout: login => {
      const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
    },
    updateViewerProfile: async (login, profile) => {
      const updated = await updateViewerProfile(login, profile);
      setViewers(current => {
        const key = login.toLowerCase();
        const viewer = current[key];
        if (!viewer) return current;
        return {
          ...current,
          [key]: {
            ...viewer,
            ...updated,
          },
        };
      });
      return updated;
    },
    loadOlderChat: async () => {
      const oldest = chat[0];
      if (!oldest) return false;
      const older = await getChatEntriesBefore(oldest.id);
      if (older.length === 0) return false;
      setChat(current => [...older, ...current]);
      return older.length === 80; // still more if a full page came back
    },
  };

  const handlePop = (id: string, on: boolean) => {
    setPopped(p => {
      const next = { ...p };
      if (on) {
        const n = Object.keys(p).length;
        const d = POP_DEFAULTS[id] ?? { w: 360, h: 440 };
        next[id] = { x: 160 + n * 34, y: 150 + n * 34, ...d };
      } else {
        delete next[id];
      }
      return next;
    });
  };

  function slot(id: string, className = '') {
    const m = MODULES[id];
    const footer = m.footer ? <ChatInput channel={status.channel} /> : undefined;
    return (
      <Panel
        id={id}
        title={m.title}
        dot={m.dot}
        count={m.count ? m.count(ctx) : undefined}
        popped={!!popped[id]}
        onPop={handlePop}
        className={className}
        footer={footer}
        bodyClass={id === 'chat' ? 'no-pad' : ''}
      >
        {m.render(ctx)}
      </Panel>
    );
  }

  function renderRightTab(tab: RightTab) {
    if (tab === 'chatters') {
      return <ChattersPanel chatters={chatters} viewers={viewers} error={chattersError} onOpenViewer={ctx.openViewerPopout} />;
    }
    if (tab === 'activity') return MODULES.events.render(ctx);
    if (tab === 'shoutouts') {
      return <ShoutoutsPanel shoutouts={shoutouts} streamActive={status.streamSessionId !== null} onOpenViewer={ctx.openViewerPopout} />;
    }
    return <AutomodPanel queue={automodQueue} subscriptionInactive={status.twitchMissingScopes.includes('moderator:manage:automod')} />;
  }

  // Rendered in both the docked panel and its popped-out window, so the two can't
  // drift apart as props are added.
  const attentionBody = (
    <AttentionPanel
      items={attention.items}
      acked={attention.acked}
      settings={attentionSettings}
      onAck={attention.ack}
      onSettingsChange={updateAttentionSettings}
    />
  );

  // Poppable panels that aren't MODULES entries render their own body here.
  function popoutContent(id: string): { title: string; body: React.ReactNode; footer?: React.ReactNode } | null {
    if (id === 'attention') {
      return { title: 'attention', body: attentionBody };
    }
    // The popped-out window follows whichever tab is active.
    if (id === 'chatters') {
      return { title: RIGHT_TAB_TITLE[rightTab], body: renderRightTab(rightTab) };
    }
    const m = MODULES[id];
    if (!m) return null;
    return {
      title: m.title,
      body: m.render(ctx),
      footer: m.footer ? <ChatInput channel={status.channel} /> : undefined,
    };
  }

  const showControls = status.obsConnected;

  const attentionPanel = (
    <Panel
      id="attention"
      title="attention"
      dot={true}
      count={attention.unackedCount || undefined}
      popped={!!popped['attention']}
      onPop={handlePop}
      className="panel--attention"
      bodyClass="no-pad"
      headerActions={
        <AttentionDismissAll disabled={attention.unackedCount === 0} onDismiss={attention.dismissAll} />
      }
    >
      {attentionBody}
    </Panel>
  );

  const dashboardLayout = (
    <div className="stage stage--cockpit">
      {slot('chat')}
      <div className={`col-stack attention-stack${showControls ? ' with-controls' : ''}`}>
        {showControls && (
          <Panel
            id="controls"
            title="stream controls"
            dot={false}
            popped={false}
            onPop={() => undefined}
          >
            <ControlsPanel
              status={status}
              scenes={obsStatus.scenes}
              scenePrefix={obsStatus.scenePrefix}
              currentScene={obsStatus.currentProgramScene}
              onSwitchScene={handleSwitchScene}
              sceneSwitching={sceneSwitching}
            />
          </Panel>
        )}
        {attentionPanel}
        <Panel
          id="chatters"
          title={RIGHT_TAB_TITLE[rightTab]}
          titleHidden
          dot={true}
          popped={!!popped['chatters']}
          onPop={handlePop}
          tabs={[
            { id: 'chatters', label: 'Viewers', badge: chatters.length },
            { id: 'activity', label: 'Activity', badge: events.length },
            { id: 'shoutouts', label: 'Shoutouts', badge: shoutouts.length },
            { id: 'automod', label: 'AutoMod', badge: automodQueue.pending.length },
          ]}
          activeTab={rightTab}
          onTabChange={id => setRightTab(id as RightTab)}
        >
          {renderRightTab(rightTab)}
        </Panel>
      </div>
    </div>
  );

  return (
    <div className="cockpit">
      <NavBar
        page={page}
        setPage={changePage}
        tweaksOpen={tweaksOpen}
        onTweaksToggle={() => setTweaksOpen(o => !o)}
        channel={status.channel}
        alert={automodQueue.pending.length > 0 ? (
          <button
            className="nav-automod-alert"
            title="Held messages awaiting review"
            onClick={() => {
              changePage('dashboard');
              // The AutoMod queue lives in the tabbed right panel; re-dock it so
              // the tab switch below lands somewhere the operator can see.
              handlePop('chatters', false);
              setRightTab('automod');
            }}
          >
            <span className="nav-automod-dot" aria-hidden="true" />
            {automodQueue.pending.length} held
          </button>
        ) : undefined}
      />
      <StatBar
        clock24={false}
        starfield={true}
        onGoLive={handleGoLive}
        onRunPreroll={handleRunPreroll}
        onOpenStreamInfo={handleOpenStreamInfo}
        goLiveBusy={goLiveBusy}
        prerollBusy={prerollBusy}
        actionMessage={actionMessage}
        twitchMissingScopes={status.twitchMissingScopes}
        streamActive={status.streamActive}
        uptimeSeconds={status.uptimeSeconds}
        uptimeSource={status.uptimeSource}
        viewerCount={status.viewerCount}
        bitrateKbps={status.bitrateKbps}
        congestion={status.congestion}
        totalFrames={status.totalFrames}
        droppedFrames={status.droppedFrames}
        laggedFrames={status.laggedFrames}
        adBreakEndsAt={status.adBreakEndsAt}
        adScheduleStatus={status.adScheduleStatus}
        adScheduleError={status.adScheduleError}
        nextAdAt={status.nextAdAt}
        adBreakDurationSeconds={status.adBreakDurationSeconds}
        prerollFreeTimeSeconds={status.prerollFreeTimeSeconds}
        snoozeCount={status.snoozeCount}
        chatConnection={status.chatConnection}
        obsConnected={status.obsConnected}
        eventSubConnected={status.eventSubConnected}
        eventSubError={status.eventSubError}
        onReconnectEventSub={handleReconnectEventSub}
      />
      {page === 'viewers' || page === 'viewer' ? (
        // One page, two panes. /viewers is the list with nothing selected; /viewers/<login>
        // is the same list with that viewer open on the right, so the URL stays linkable
        // and Back walks the selections.
        <ViewersPage
          ctx={ctx}
          selectedLogin={page === 'viewer' ? viewerLogin : null}
          onSelectViewer={navigateToViewer}
        />
      ) : isSettingsRoute(page) ? (
        <SettingsShell
          route={page}
          status={status}
          onNavigate={changePage}
          onTwitchLogout={handleTwitchLogout}
          onTwitchBotLogout={handleTwitchBotLogout}
        />
      ) : (
        dashboardLayout
      )}

      <div className="popout-layer">
        {Object.keys(popped).map(id => {
          const pop = popoutContent(id);
          if (!pop) return null;
          return (
            <PopWindow
              key={id}
              id={id}
              title={pop.title}
              initial={popped[id]}
              onClose={x => handlePop(x, false)}
              footer={pop.footer}
            >
              {pop.body}
            </PopWindow>
          );
        })}
      </div>

      {streamInfoOpen && (
        <StreamInfoModal
          form={streamInfoForm}
          loading={streamInfoLoading}
          saving={streamInfoSaving}
          message={streamInfoMessage}
          error={streamInfoError}
          setForm={setStreamInfoForm}
          onSubmit={handleStreamInfoSubmit}
          onClose={() => setStreamInfoOpen(false)}
        />
      )}

      <TweaksPanel title="Display" open={tweaksOpen} onClose={() => setTweaksOpen(false)}>
        <TweakSection label="Live Data" />
        <div className="live-data-list">
          <div><span>Channel</span><b>{status.channel || 'unavailable'}</b></div>
          <div><span>Chat</span><b>{status.chatConnection.toLowerCase()}</b></div>
          <div><span>EventSub</span><b>{status.eventSubConnected ? 'open' : 'closed'}</b></div>
          <div><span>OBS</span><b>{status.obsConnected ? 'connected' : 'unavailable'}</b></div>
        </div>
      </TweaksPanel>
    </div>
  );
}
