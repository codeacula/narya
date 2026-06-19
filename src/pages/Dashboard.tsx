import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { ChatInput, MODULES, PanelCtx } from '../ui/panels';
import { useTweaks, TweaksPanel, TweakSection, TweakToggle } from '../ui/tweaks';
import { getViewers, getChatEntries, getStreamEvents } from '../services/dashboard';
import { useSocket } from '../legacy';
import type { Viewer, ChatEntry, StreamEvent } from '../types';

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

/* ---------------- Settings page ---------------- */

function Settings({ t, setTweak }: { t: Tweaks; setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void }) {
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

  // Simulation telemetry state
  const [isLive, setIsLive] = useState(true);
  const [uptime, setUptime] = useState(8077);
  const [viewersCount, setViewersCount] = useState(342);
  const [peakViewers, setPeakViewers] = useState(401);
  const [avgViewers, setAvgViewers] = useState(318);
  const [bitrate, setBitrate] = useState(6000);
  const [totalFrames, setTotalFrames] = useState(482910);
  const [droppedFrames, setDroppedFrames] = useState(124);
  const [laggedFrames, setLaggedFrames] = useState(42);
  const [nextAd, setNextAd] = useState(381);
  const [autoSimulate, setAutoSimulate] = useState(false);

  useEffect(() => {
    Promise.all([
      getViewers().then(setViewers),
      getChatEntries().then(setChat),
      getStreamEvents().then(setEvents),
    ]);
  }, []);

  useEffect(() => {
    const a = ACCENTS[t.accent] ?? ACCENTS['#ffb86c'];
    const s = document.documentElement.style;
    s.setProperty('--accent', t.accent);
    s.setProperty('--accent-fg', a.fg);
    s.setProperty('--accent-soft', a.soft);
    s.setProperty('--border-3', a.border);
  }, [t.accent]);

  // Stream ticking (uptime, ad countdown, and frames)
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setUptime(u => u + 1);
      setTotalFrames(f => f + 60);
      setNextAd(a => (a > 0 ? a - 1 : 600)); // Reset ad countdown every 10 min
    }, 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  // Telemetry fluctuation
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setViewersCount(v => {
        const delta = Math.floor(Math.random() * 9) - 4; // -4 to +4
        const next = Math.max(10, v + delta);
        setPeakViewers(p => Math.max(p, next));
        return next;
      });
      setBitrate(b => {
        const delta = Math.floor(Math.random() * 201) - 100; // -100 to +100
        const nextB = Math.max(2000, Math.min(8000, b + delta));
        if (nextB < 4000) {
          setDroppedFrames(d => d + Math.floor(Math.random() * 30) + 10);
        }
        return nextB;
      });
      // Occasionally drop frames or lag frames randomly
      if (Math.random() > 0.85) {
        setDroppedFrames(d => d + Math.floor(Math.random() * 5));
      }
      if (Math.random() > 0.92) {
        setLaggedFrames(l => l + Math.floor(Math.random() * 3));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isLive]);

  // Real Twitch EventSub events from the backend
  useSocket<StreamEvent>('stream:event', React.useCallback((evt) => {
    setEvents(evs => [evt, ...evs.slice(0, 49)]);
  }, []));

  // Handle local simulation events (which mock websocket messages)
  useEffect(() => {
    const handleMock = (e: Event) => {
      const customEvt = e as CustomEvent<{ event: string; payload: any }>;
      const { event, payload } = customEvt.detail;

      if (event === 'chat:message') {
        const newEntry: ChatEntry = {
          user: payload.displayName || payload.username,
          text: payload.message,
          time: new Date(payload.receivedAt).toTimeString().slice(0, 5),
          highlight: payload.isFirstTimer ? 'first' : undefined,
        };
        setChat(c => [...c, newEntry]);

        setViewers(v => {
          const userKey = payload.username.toLowerCase();
          if (v[userKey]) {
            return {
              ...v,
              [userKey]: {
                ...v[userKey],
                msgs: v[userKey].msgs + 1,
                recent: [
                  { t: payload.message, ago: '0:00' },
                  ...v[userKey].recent.slice(0, 4)
                ]
              }
            };
          } else {
            return {
              ...v,
              [userKey]: {
                login: payload.username,
                display: payload.displayName || payload.username,
                color: payload.color || '#a0a0a0',
                pronouns: 'they/them',
                roles: [],
                followed: 'followed just now',
                subbed: 'not subscribed',
                seen: 'first seen just now',
                msgs: 1,
                accountAge: 'brand new',
                note: 'Simulated viewer',
                recent: [{ t: payload.message, ago: '0:00' }]
              }
            };
          }
        });
      } else if (event === 'stream:event') {
        setEvents(evs => [payload, ...evs]);
      }
    };
    window.addEventListener('mock-websocket', handleMock);
    return () => window.removeEventListener('mock-websocket', handleMock);
  }, []);

  const dispatchMockSocket = (event: string, payload: any) => {
    window.dispatchEvent(new CustomEvent('mock-websocket', { detail: { event, payload } }));
  };

  const simulateChatMessage = () => {
    const users = [
      { name: 'cosmic_jeff', display: 'CosmicJeff', color: '#ff5555' },
      { name: 'pixel_witch', display: 'PixelWitch', color: '#50fa7b' },
      { name: 'nebula_smith', display: 'NebulaSmith', color: '#8be9fd' },
      { name: 'moon_dev', display: 'MoonDev', color: '#ff79c6' },
      { name: 'stardust_kelly', display: 'StardustKelly', color: '#bd93f9' },
      { name: 'grumpy_compiler', display: 'GrumpyCompiler', color: '#ffb86c' }
    ];
    const user = users[Math.floor(Math.random() * users.length)];
    const messages = [
      'this stream layout is absolutely gorgeous!',
      'can you explain the flex layout again?',
      'is this next.js or standard react?',
      'what theme are you using in vscode?',
      'the framerate is super smooth today',
      'that parallax background is wild',
      'hello world from chat!',
      'peepoHappy',
      'does anyone know if playerctl works in WSL?',
      'that is a solid solution right there'
    ];
    const text = messages[Math.floor(Math.random() * messages.length)];
    const isFirst = Math.random() > 0.8;

    dispatchMockSocket('chat:message', {
      id: Math.random().toString(36).substring(2),
      username: user.name,
      displayName: user.display,
      color: user.color,
      message: text,
      receivedAt: new Date().toISOString(),
      isFirstTimer: isFirst,
      badges: null,
      emotes: null
    });
  };

  const simulateStreamEvent = () => {
    const kinds = ['follow', 'sub', 'gift', 'cheer', 'raid'] as const;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const names = ['hyper_quantum', 'star_weaver', 'rust_ace', 'gopher_girl', 'neon_rider', 'cyber_duck'];
    const actor = names[Math.floor(Math.random() * names.length)];

    let detail = '';
    let tone = 'silver';
    if (kind === 'follow') {
      detail = 'followed';
      tone = 'silver';
    } else if (kind === 'sub') {
      detail = 'subscribed · Tier 1 · 3 months';
      tone = 'warning';
    } else if (kind === 'gift') {
      detail = 'gifted a sub to a random viewer!';
      tone = 'warning';
    } else if (kind === 'cheer') {
      detail = `cheered ${[100, 500, 1000, 5000][Math.floor(Math.random() * 4)]} bits`;
      tone = 'info';
    } else if (kind === 'raid') {
      detail = `raided with ${Math.floor(Math.random() * 80) + 10} viewers`;
      tone = 'note';
    }

    dispatchMockSocket('stream:event', {
      kind,
      actor,
      detail,
      ago: 'just now',
      tone
    });
  };

  // Auto traffic simulation
  useEffect(() => {
    if (!autoSimulate) return;
    const chatInterval = setInterval(simulateChatMessage, 4000);
    const eventInterval = setInterval(simulateStreamEvent, 12000);
    return () => {
      clearInterval(chatInterval);
      clearInterval(eventInterval);
    };
  }, [autoSimulate]);

  const ctx: PanelCtx = {
    viewers,
    chat,
    events,
    openViewerPopout: login => {
      const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
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
    const footer = m.footer ? <ChatInput /> : undefined;
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
      />
      <StatBar
        clock24={t.clock === '24h'}
        starfield={t.starfield}
        isLive={isLive}
        uptime={uptime}
        viewers={viewersCount}
        peakViewers={peakViewers}
        avgViewers={avgViewers}
        bitrate={bitrate}
        totalFrames={totalFrames}
        droppedFrames={droppedFrames}
        laggedFrames={laggedFrames}
        nextAd={nextAd}
      />
      {page === 'dashboard' ? (layouts[t.layout] ?? layouts['cockpit']) : (
        <Settings t={t} setTweak={setTweak} />
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
              footer={m.footer ? <ChatInput /> : undefined}
            >
              {m.render(ctx)}
            </PopWindow>
          );
        })}
      </div>

      <TweaksPanel title="Dev Menu" open={tweaksOpen} onClose={() => setTweaksOpen(false)}>
        <TweakSection label="Simulator Control" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }}>
          <TweakToggle
            label="Auto-generate Traffic"
            value={autoSimulate}
            onChange={setAutoSimulate}
          />
          <TweakToggle
            label="Stream Live Status"
            value={isLive}
            onChange={setIsLive}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              onClick={simulateChatMessage}
              style={{
                flex: 1,
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid var(--border-2)',
                color: 'var(--fg-1)',
                padding: '6px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '11px',
                fontWeight: 500
              }}
            >
              Simulate Chat
            </button>
            <button
              onClick={simulateStreamEvent}
              style={{
                flex: 1,
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid var(--border-2)',
                color: 'var(--fg-1)',
                padding: '6px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '11px',
                fontWeight: 500
              }}
            >
              Simulate Event
            </button>
          </div>
        </div>
      </TweaksPanel>
    </div>
  );
}
