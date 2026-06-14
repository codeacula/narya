import React, { useState, useRef, useCallback } from 'react';
import { Icon } from './icons';
import { getTicker } from '../services/dashboard';

const TICKER = getTicker();

/* ---------------- useDrag ---------------- */

type DragPos = { x: number; y: number; w: number; h: number };
type DragMemo = { sx: number; sy: number; ox: number; oy: number };

export function useDrag(initial: DragPos) {
  const [pos, setPos] = useState<DragPos>(initial);
  const [dragging, setDragging] = useState(false);
  const memo = useRef<DragMemo>({ sx: 0, sy: 0, ox: 0, oy: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.icon-btn, .popwin-resize')) return;
    const startX = e.clientX, startY = e.clientY;
    setDragging(true);
    setPos(p => {
      memo.current = { sx: startX, sy: startY, ox: p.x, oy: p.y };
      return p;
    });
    const move = (ev: PointerEvent) => {
      const m = memo.current;
      const nx = Math.max(4, Math.min(window.innerWidth - 120, m.ox + (ev.clientX - m.sx)));
      const ny = Math.max(48, Math.min(window.innerHeight - 60, m.oy + (ev.clientY - m.sy)));
      setPos(p => ({ ...p, x: nx, y: ny }));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return { pos, setPos, dragging, onPointerDown };
}

/* ---------------- NavBar ---------------- */

export function NavBar({
  page,
  setPage,
  tweaksOpen,
  onTweaksToggle,
}: {
  page: string;
  setPage: (p: string) => void;
  tweaksOpen: boolean;
  onTweaksToggle: () => void;
}) {
  return (
    <div className="navbar">
      <div className="brand">
        <img
          src="/assets/mark.svg"
          alt=""
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <span className="wm">CODE<span>·</span>ACULA</span>
      </div>
      <div className="navlinks">
        <button
          className={'navlink' + (page === 'dashboard' ? ' active' : '')}
          onClick={() => setPage('dashboard')}
        >
          dashboard
        </button>
        <button
          className={'navlink' + (page === 'settings' ? ' active' : '')}
          onClick={() => setPage('settings')}
        >
          settings
        </button>
      </div>
      <div className="nav-spacer" />
      <button
        className={'nav-icon' + (tweaksOpen ? ' active' : '')}
        title="Tweaks"
        onClick={onTweaksToggle}
      >
        <Icon name="grid" size={15} />
      </button>
      <button className="nav-icon" title="Settings" onClick={() => setPage('settings')}>
        <Icon name="settings" size={15} />
      </button>
      <div className="nav-avatar">C</div>
    </div>
  );
}

/* ---------------- StatBar ---------------- */

function Gauge({
  label,
  icon,
  className = '',
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={'gauge ' + className}>
      <div className="gauge-label">{icon}{label}</div>
      {children}
    </div>
  );
}

export function StatBar({ clock24, starfield }: { clock24: boolean; starfield: boolean }) {
  const time = clock24 ? '21:42' : '9:42 PM';

  const tickerRow = (key: string) => (
    <span className="ticker-track" key={key}>
      {TICKER.map((t, i) => {
        const [who, ...rest] = t.split(' ');
        return (
          <span key={i}>
            <b>{who}</b> {rest.join(' ')} <span className="sep">·</span>
          </span>
        );
      })}
    </span>
  );

  return (
    <div className={'statbar' + (starfield ? ' starfield' : '')}>
      <Gauge label="On air" className="live" icon={<span className="live-dot" />}>
        <div className="gauge-value">2:14:37</div>
      </Gauge>
      <Gauge label="Local time">
        <div className="gauge-value">{time}</div>
      </Gauge>
      <Gauge label="Next ad break" className="ad">
        <div className="gauge-value">06:21</div>
        <div className="gauge-sub">90s · pre-roll skipped</div>
      </Gauge>
      <Gauge label="Viewers" icon={<Icon name="users" size={11} />}>
        <div className="gauge-value">
          342 <small className="delta-up">▲ 12</small>
        </div>
        <div className="gauge-sub">avg 318 · peak 401</div>
      </Gauge>
      <Gauge label="Stream health">
        <div className="gauge-value health">
          <span className="health-dot good" />
          <span style={{ fontSize: '15px' }}>6000<small> kbps</small></span>
          <span className="health-bars">
            <i style={{ height: '7px' }} />
            <i style={{ height: '10px' }} />
            <i style={{ height: '13px' }} />
            <i style={{ height: '16px' }} />
            <i style={{ height: '12px' }} />
          </span>
        </div>
        <div className="gauge-sub">0.0% dropped · 1080p60</div>
      </Gauge>
      <div className="ticker">
        <div className="gauge-label">Latest activity</div>
        <div className="ticker-window">
          <div style={{ display: 'inline-flex' }}>
            {tickerRow('a')}
            {tickerRow('b')}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Panel ---------------- */

export function Panel({
  id,
  title,
  count,
  dot = true,
  popped,
  onPop,
  className = '',
  bodyClass = '',
  footer,
  children,
}: {
  id: string;
  title: string;
  count?: React.ReactNode;
  dot?: boolean;
  popped: boolean;
  onPop: (id: string, on: boolean) => void;
  className?: string;
  bodyClass?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (popped) {
    return (
      <div className={'panel ghost ' + className}>
        <div className="ghost-inner">
          <Icon name="popout" size={20} />
          <div className="gi-title">{title} · popped out</div>
          <div className="gi-sub">floating window — drag it anywhere</div>
          <button className="modbtn gold" onClick={() => onPop(id, false)}>re-dock</button>
        </div>
      </div>
    );
  }
  return (
    <div className={'panel ' + className}>
      <div className="panel-head">
        <span className="panel-title">
          {dot && <span className="tdot" />}
          {title}
        </span>
        {count != null && <span className="panel-count">{count}</span>}
        <span className="panel-actions">
          <button className="icon-btn" title="Pop out" onClick={() => onPop(id, true)}>
            <Icon name="popout" />
          </button>
        </span>
      </div>
      <div className={'panel-body ' + bodyClass}>{children}</div>
      {footer}
    </div>
  );
}

/* ---------------- PopWindow ---------------- */

export function PopWindow({
  id,
  title,
  initial,
  onClose,
  footer,
  children,
}: {
  id: string;
  title: string;
  initial: DragPos;
  onClose: (id: string) => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { pos, setPos, dragging, onPointerDown } = useDrag(initial);

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, ow = pos.w, oh = pos.h;
    const move = (ev: PointerEvent) =>
      setPos(p => ({
        ...p,
        w: Math.max(280, ow + (ev.clientX - sx)),
        h: Math.max(200, oh + (ev.clientY - sy)),
      }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={'popwin' + (dragging ? ' dragging' : '')}
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
    >
      <div className="popwin-head" onPointerDown={onPointerDown}>
        <span className="grip">
          <i /><i /><i /><i /><i /><i />
        </span>
        <span className="popwin-title">{title}</span>
        <span className="panel-actions" style={{ marginLeft: 'auto' }}>
          <button className="icon-btn" title="Re-dock" onClick={() => onClose(id)}>
            <Icon name="dock" />
          </button>
        </span>
      </div>
      <div className="popwin-body">{children}</div>
      {footer}
      <div className="popwin-resize" onPointerDown={startResize} />
    </div>
  );
}
