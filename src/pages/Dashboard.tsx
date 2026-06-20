import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { ChatInput, MODULES, PanelCtx } from '../ui/panels';
import { useTweaks, TweaksPanel, TweakSection } from '../ui/tweaks';
import { disconnectTwitch, getViewers, getChatEntries, getChatEntriesBefore, getStreamEvents, getDashboardStatus } from '../services/dashboard';
import { useSocket, type ChatMessage as LiveChatMessage, type ChatModerationEvent } from '../legacy';
import type { Viewer, ChatEntry, StreamEvent, DashboardStatus } from '../types';

/* ---------------- constants ---------------- */

type Tweaks = {
  layout: string;
  density: string;
  clock: string;
  accent: string;
  starfield: boolean;
};

const TWEAK_DEFAULTS: Tweaks = {
  layout: 'cockpit',
  density: 'dense',
  clock: '12h',
  accent: '#ffb86c',
  starfield: true,
};

const ACCENTS: Record<string, { fg: string; soft: string; border: string }> = {
  '#ffb86c': { fg: '#ffc488', soft: 'rgba(255,184,108,0.12)', border: 'rgba(255,184,108,0.45)' },
  '#9e82e8': { fg: '#bca6f0', soft: 'rgba(158,130,232,0.14)', border: 'rgba(158,130,232,0.45)' },
  '#6aa8d4': { fg: '#9ccae8', soft: 'rgba(106,168,212,0.14)', border: 'rgba(106,168,212,0.45)' },
};

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

/* ---------------- Settings page ---------------- */

function Settings({
  t,
  setTweak,
  status,
  onTwitchLogout,
}: {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  status: DashboardStatus;
  onTwitchLogout: () => void;
}) {
  const missingTwitchScopes = status.twitchMissingScopes.length > 0
    ? status.twitchMissingScopes.join(', ')
    : null;
  const twitchLoginSub = missingTwitchScopes
    ? `Reconnect to grant missing scopes: ${missingTwitchScopes}`
    : status.twitchAuthenticated
      ? `Credentials cached on backend${status.twitchAuthSource ? ` via ${status.twitchAuthSource}` : ''}`
      : 'Login to cache credentials for EventSub, Twitch uptime, and ad schedule data';

  const Row = ({
    label,
    sub,
    children,
  }: {
    label: string;
    sub?: string;
    children: React.ReactNode;
  }) => (
    <div className="set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="eyebrow" style={{ marginBottom: '6px' }}>settings</div>
        <h2 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 500 }}>
          Control room
        </h2>
        <p className="set-intro">
          Panel preferences — everything here also lives in the Tweaks drawer.
        </p>

        <div className="set-group">
          <div className="set-group-label">Appearance</div>
          <Row label="Layout arrangement" sub="How the dashboard columns are organized">
            <div className="seg">
              {(['cockpit', 'mission', 'modular'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.layout === o ? ' on' : '')}
                  onClick={() => setTweak('layout', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Density" sub="Tighten the rows for a true cockpit feel">
            <div className="seg">
              {(['dense', 'comfy'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.density === o ? ' on' : '')}
                  onClick={() => setTweak('density', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Status accent" sub="Tint for live, focus, and highlights">
            <div className="seg">
              {([['#ffb86c', 'gold'], ['#9e82e8', 'arcane'], ['#6aa8d4', 'celestial']] as const).map(
                ([c, n]) => (
                  <button
                    key={c}
                    className={'seg-b' + (t.accent === c ? ' on' : '')}
                    onClick={() => setTweak('accent', c)}
                  >
                    <span className="swatch" style={{ background: c }} />
                    {n}
                  </button>
                ),
              )}
            </div>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Top bar</div>
          <Row label="Clock format">
            <div className="seg">
              {(['12h', '24h'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.clock === o ? ' on' : '')}
                  onClick={() => setTweak('clock', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Starfield behind stats" sub="A faint drift of stars under the gauges">
            <button
              className={'toggle' + (t.starfield ? ' on' : '')}
              onClick={() => setTweak('starfield', !t.starfield)}
            >
              <span className="knob" />
            </button>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Twitch connection</div>
          <Row
            label="Twitch login"
            sub={twitchLoginSub}
          >
            {missingTwitchScopes ? (
              <a className="btn-primary" href="/api/auth/twitch?force=1">Reconnect</a>
            ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchLogout}>Disconnect</button>
            ) : status.twitchAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href="/api/auth/twitch">
                Login with Twitch
              </a>
            )}
          </Row>
          <Row
            label="EventSub"
            sub={status.eventSubConnected ? 'Receiving channel events' : 'Not connected — login to enable follows, subs, and alerts'}
          >
            {status.eventSubConnected ? (
              <span className="set-badge set-badge--ok">Connected</span>
            ) : (
              <span className="set-badge">Disconnected</span>
            )}
          </Row>
        </div>

        <p className="set-foot">
          More to come — alerts, hotkeys, OBS scenes. The greatest orbs to ponder are the stars above.
        </p>
      </div>
    </div>
  );
}
/* ---------------- Dashboard page ---------------- */

export function DashboardPage() {
  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);
  const [page, setPage] = useState('dashboard');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [popped, setPopped] = useState<Record<string, PoppedState>>({});
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<DashboardStatus>(EMPTY_STATUS);

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
      } catch {
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    const refreshStatus = async () => {
      try {
        const nextStatus = await getDashboardStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch {
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    void refreshAll();
    const fullRefresh = setInterval(refreshAll, 30_000);
    const statusRefresh = setInterval(refreshStatus, 5_000);

    return () => {
      cancelled = true;
      clearInterval(fullRefresh);
      clearInterval(statusRefresh);
    };
  }, []);

  useEffect(() => {
    const a = ACCENTS[t.accent] ?? ACCENTS['#ffb86c'];
    const s = document.documentElement.style;
    s.setProperty('--accent', t.accent);
    s.setProperty('--accent-fg', a.fg);
    s.setProperty('--accent-soft', a.soft);
    s.setProperty('--border-3', a.border);
  }, [t.accent]);

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
    void getViewers().then(setViewers).catch(() => {});
    void getDashboardStatus().then(setStatus).catch(() => {});
  }, []));

  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch(() => {});
  }, []));

  const handleTwitchLogout = React.useCallback(() => {
    void disconnectTwitch()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch(() => {});
  }, []);

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

  const layouts: Record<string, React.ReactNode> = {
    cockpit: (
      <div className="stage stage--cockpit">
        {slot('chat')}
        <div className="col-stack">
          {slot('events')}
        </div>
      </div>
    ),
    mission: (
      <div className="stage stage--mission">
        {slot('events', 'area-events-rail')}
        {slot('chat')}
      </div>
    ),
    modular: (
      <div className="stage stage--modular">
        {slot('chat')}
        <div className="modgrid">
          <div className="area-events" style={{ display: 'grid', minHeight: 0 }}>
            {slot('events')}
          </div>
        </div>
      </div>
    ),
  };

  return (
    <div className={'cockpit' + (t.density === 'comfy' ? ' comfy' : '')}>
      <NavBar
        page={page}
        setPage={setPage}
        tweaksOpen={tweaksOpen}
        onTweaksToggle={() => setTweaksOpen(o => !o)}
        channel={status.channel}
      />
      <StatBar
        clock24={t.clock === '24h'}
        starfield={t.starfield}
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
      {page === 'dashboard' ? (layouts[t.layout] ?? layouts['cockpit']) : (
        <Settings t={t} setTweak={setTweak} status={status} onTwitchLogout={handleTwitchLogout} />
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
