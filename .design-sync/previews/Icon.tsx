import * as React from 'react';
import { Icon } from 'streamer-tools';

// `.cockpit` owns the dark surface, the ivory foreground and the body font —
// every preview wraps in it, exactly as the real dashboard does.
const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// The complete vocabulary. `Icon` renders `PATHS[name] ?? null`, so an
// unlisted name is a silently empty <svg> — this grid is the contract.
const NAMES = [
  'settings', 'grid', 'popout', 'dock', 'x', 'check',
  'heart', 'star', 'gift', 'bits', 'chat', 'play',
  'edit', 'users', 'swords', 'info', 'refresh', 'chevron-down',
];

const label: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-3)',
};

const cell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: '12px 4px',
  border: '1px solid var(--border-1)',
  borderRadius: 'var(--radius-2)',
  color: 'var(--fg-1)',
};

// Every name at the size the dashboard chrome actually uses.
export const AllNames = () => (
  <Cockpit>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, maxWidth: 620 }}>
      {NAMES.map(name => (
        <div key={name} style={cell}>
          <Icon name={name} size={20} />
          <span style={label}>{name}</span>
        </div>
      ))}
    </div>
  </Cockpit>
);

// `size` drives width/height on a 24-viewBox stroke icon, so the 1.6 stroke
// stays constant and thins visually as the glyph grows.
export const Sizes = () => (
  <Cockpit>
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', color: 'var(--fg-1)' }}>
      {[12, 16, 20, 28, 40].map(size => (
        <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Icon name="swords" size={size} />
          <span style={label}>{size}px</span>
        </div>
      ))}
    </div>
  </Cockpit>
);

// Stroke is `currentColor`: the icon inherits whatever the surrounding chrome
// sets, which is how the same glyph reads as muted, active, or alert.
export const Tones = () => (
  <Cockpit>
    <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
      {[
        { tone: 'var(--fg-3)', name: 'chat', text: 'idle' },
        { tone: 'var(--fg-1)', name: 'users', text: 'default' },
        { tone: 'var(--fg-accent)', name: 'star', text: 'accent' },
        { tone: 'var(--success-fg)', name: 'check', text: 'ok' },
        { tone: 'var(--danger-fg)', name: 'heart', text: 'alert' },
        { tone: 'var(--fg-arcane)', name: 'gift', text: 'arcane' },
      ].map(t => (
        <div key={t.text} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: t.tone }}>
          <Icon name={t.name} size={24} />
          <span style={label}>{t.text}</span>
        </div>
      ))}
    </div>
  </Cockpit>
);

// Real usage: every panel header action is an `.icon-btn` wrapping one Icon.
export const InPanelActions = () => (
  <Cockpit>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'var(--bg-2)',
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-3)',
        maxWidth: 380,
      }}
    >
      <span style={{ ...label, fontSize: 11, letterSpacing: '0.14em', color: 'var(--fg-2)' }}>chat</span>
      <span className="panel-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
        <button className="icon-btn" title="Refresh"><Icon name="refresh" /></button>
        <button className="icon-btn" title="Settings"><Icon name="settings" /></button>
        <button className="icon-btn" title="Pop out"><Icon name="popout" /></button>
        <button className="icon-btn" title="Re-dock"><Icon name="dock" /></button>
        <button className="icon-btn" title="Close"><Icon name="x" /></button>
      </span>
    </div>
  </Cockpit>
);
