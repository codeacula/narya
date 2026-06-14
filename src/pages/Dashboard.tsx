import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { ChatInput, MODULES, PanelCtx } from '../ui/panels';
import { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor } from '../ui/tweaks';
import { getViewers, getChatEntries, getStreamEvents } from '../services/dashboard';

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
      <div>
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

  useEffect(() => {
    const a = ACCENTS[t.accent] ?? ACCENTS['#ffb86c'];
    const s = document.documentElement.style;
    s.setProperty('--accent', t.accent);
    s.setProperty('--accent-fg', a.fg);
    s.setProperty('--accent-soft', a.soft);
    s.setProperty('--border-3', a.border);
  }, [t.accent]);

  const ctx: PanelCtx = {
    viewers: getViewers(),
    chat: getChatEntries(),
    events: getStreamEvents(),
    openViewerPopout: login => {
      window.open(`/viewer?login=${encodeURIComponent(login)}`, `viewer-${login}`, 'width=380,height=560');
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
      <StatBar clock24={t.clock === '24h'} starfield={t.starfield} />

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

      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)}>
        <TweakSection label="Layout" />
        <TweakRadio
          label="Arrangement"
          value={t.layout}
          options={['cockpit', 'mission', 'modular']}
          onChange={v => setTweak('layout', v)}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          options={['dense', 'comfy']}
          onChange={v => setTweak('density', v)}
        />
        <TweakSection label="Top bar" />
        <TweakRadio
          label="Clock"
          value={t.clock}
          options={['12h', '24h']}
          onChange={v => setTweak('clock', v)}
        />
        <TweakToggle
          label="Starfield behind stats"
          value={t.starfield}
          onChange={v => setTweak('starfield', v)}
        />
        <TweakSection label="Accent" />
        <TweakColor
          label="Status accent"
          value={t.accent}
          options={['#ffb86c', '#9e82e8', '#6aa8d4']}
          onChange={v => setTweak('accent', v)}
        />
      </TweaksPanel>
    </div>
  );
}
