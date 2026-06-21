import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { ChatInput, MODULES, PanelCtx } from '../ui/panels';
import { TweaksPanel, TweakSection } from '../ui/tweaks';
import {
  disconnectTwitch,
  getViewers,
  getChatEntries,
  getChatEntriesBefore,
  getStreamEvents,
  getDashboardStatus,
  getStreamInfo,
  updateStreamInfo,
  runPrerollAds,
} from '../services/dashboard';
import { useSocket } from '../realtime';
import { DASHBOARD_FULL_REFRESH_MS, DASHBOARD_STATUS_REFRESH_MS } from '../../shared/constants';
import { SettingsPage } from './SettingsPage';
import { StreamInfoModal, type StreamInfoForm } from './StreamInfoModal';
import type { Viewer, ChatEntry, StreamEvent, DashboardStatus, ChatMessage as LiveChatMessage, ChatModerationEvent } from '../../shared/api';

/* ---------------- constants ---------------- */

const POP_DEFAULTS: Record<string, { w: number; h: number }> = {
  chat:      { w: 380, h: 540 },
  events:    { w: 360, h: 460 },
};

type PoppedState = { x: number; y: number; w: number; h: number };

const EMPTY_STATUS: DashboardStatus = {
  channel: '',
  chatConnection: 'UNKNOWN',
  obsConnected: false,
  eventSubConnected: false,
  twitchAuthenticated: false,
  twitchAuthSource: null,
  twitchTokenExpiresAt: null,
  twitchMissingScopes: [],
  streamActive: null,
  uptimeSeconds: null,
  streamStartedAt: null,
  uptimeSource: null,
  activeChatters: 0,
  sessionChatters: 0,
  knownChatters: 0,
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

/* ---------------- Dashboard page ---------------- */

export function DashboardPage() {
  const [page, setPage] = useState('dashboard');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [popped, setPopped] = useState<Record<string, PoppedState>>({});
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<DashboardStatus>(EMPTY_STATUS);
  const [streamInfoOpen, setStreamInfoOpen] = useState(false);
  const [streamInfoForm, setStreamInfoForm] = useState<StreamInfoForm>({ title: '', category: '', tags: [] });
  const [streamInfoLoading, setStreamInfoLoading] = useState(false);
  const [streamInfoSaving, setStreamInfoSaving] = useState(false);
  const [streamInfoMessage, setStreamInfoMessage] = useState<string | null>(null);
  const [streamInfoError, setStreamInfoError] = useState<string | null>(null);
  const [prerollBusy, setPrerollBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refreshAll = async () => {
      try {
        const [nextViewers, nextChat, nextEvents, nextStatus] = await Promise.all([
          getViewers(),
          getChatEntries(),
          getStreamEvents(),
          getDashboardStatus(),
        ]);
        if (cancelled) return;
        setViewers(nextViewers);
        setChat(nextChat);
        setEvents(nextEvents);
        setStatus(nextStatus);
      } catch (error) {
        console.error('Failed to refresh dashboard data:', error);
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    const refreshStatus = async () => {
      try {
        const nextStatus = await getDashboardStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        console.error('Failed to refresh dashboard status:', error);
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    void refreshAll();
    const fullRefresh = setInterval(refreshAll, DASHBOARD_FULL_REFRESH_MS);
    const statusRefresh = setInterval(refreshStatus, DASHBOARD_STATUS_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(fullRefresh);
      clearInterval(statusRefresh);
    };
  }, []);

  // Real Twitch EventSub events from the backend
  useSocket<StreamEvent>('stream:event', React.useCallback((evt) => {
    setEvents(evs => evs.some(existing => existing.id === evt.id) ? evs : [evt, ...evs.slice(0, 49)]);
  }, []));

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
    const login = message.username.toLowerCase();
    const nextEntry: ChatEntry = {
      id: message.id,
      user: login,
      text: message.message,
      time: new Date(message.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      highlight: message.isFirstTimer ? 'first' : message.badges?.subscriber ? 'sub' : undefined,
    };

    setChat(current => current.some(entry => entry.id === nextEntry.id) ? current : [...current, nextEntry]);
    void getViewers().then(setViewers).catch((error: unknown) => {
      console.error('Failed to refresh viewers after chat message:', error);
    });
    void getDashboardStatus().then(setStatus).catch((error: unknown) => {
      console.error('Failed to refresh status after chat message:', error);
    });
  }, []));

  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch((error: unknown) => {
      console.error('Failed to refresh chat after moderation event:', error);
    });
  }, []));

  useSocket<DashboardStatus>('dashboard:status', React.useCallback((nextStatus) => {
    setStatus(nextStatus);
  }, []));

  const handleTwitchLogout = React.useCallback(() => {
    void disconnectTwitch()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Failed to disconnect Twitch:', error);
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

  const handleOpenStreamInfo = React.useCallback(() => {
    setStreamInfoOpen(true);
    setStreamInfoLoading(true);
    setStreamInfoMessage(null);
    setStreamInfoError(null);
    void getStreamInfo()
      .then(info => {
        setStreamInfoForm({
          title: info.title,
          category: info.category,
          tags: info.tags,
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
    void updateStreamInfo({
      title: streamInfoForm.title,
      category: streamInfoForm.category,
      tags: streamInfoForm.tags,
    })
      .then(() => {
        setStreamInfoMessage('Saved');
        setActionMessage('Stream info saved');
        refreshDashboardStatus();
      })
      .catch(error => {
        setStreamInfoError(error instanceof Error ? error.message : 'Could not save stream info');
      })
      .finally(() => setStreamInfoSaving(false));
  }, [refreshDashboardStatus, streamInfoForm]);

  const ctx: PanelCtx = {
    viewers,
    chat,
    events,
    channel: status.channel,
    openViewerPopout: login => {
      const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
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

  const dashboardLayout = (
    <div className="stage stage--cockpit">
      {slot('chat')}
      <div className="col-stack">
        {slot('events')}
      </div>
    </div>
  );

  return (
    <div className="cockpit">
      <NavBar
        page={page}
        setPage={setPage}
        tweaksOpen={tweaksOpen}
        onTweaksToggle={() => setTweaksOpen(o => !o)}
        channel={status.channel}
      />
      <StatBar
        clock24={false}
        starfield={true}
        onRunPreroll={handleRunPreroll}
        onOpenStreamInfo={handleOpenStreamInfo}
        prerollBusy={prerollBusy}
        actionMessage={actionMessage}
        twitchMissingScopes={status.twitchMissingScopes}
        streamActive={status.streamActive}
        uptimeSeconds={status.uptimeSeconds}
        uptimeSource={status.uptimeSource}
        activeChatters={status.activeChatters}
        sessionChatters={status.sessionChatters}
        knownChatters={status.knownChatters}
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
      />
      {page === 'dashboard' ? dashboardLayout : (
        <SettingsPage status={status} onTwitchLogout={handleTwitchLogout} />
      )}

      <div className="popout-layer">
        {Object.keys(popped).map(id => {
          const m = MODULES[id];
          return (
            <PopWindow
              key={id}
              id={id}
              title={m.title}
              initial={popped[id]}
              onClose={x => handlePop(x, false)}
              footer={m.footer ? <ChatInput channel={status.channel} /> : undefined}
            >
              {m.render(ctx)}
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
