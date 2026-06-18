import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Icon } from './icons';

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
        title="Dev Menu"
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
export function StatBar({
  clock24,
  starfield,
  isLive = true,
  uptime = 8077,
  viewers = 342,
  peakViewers = 401,
  avgViewers = 318,
  bitrate = 6000,
  totalFrames = 482910,
  droppedFrames = 124,
  laggedFrames = 42,
  nextAd = 381,
}: {
  clock24: boolean;
  starfield: boolean;
  isLive?: boolean;
  uptime?: number;
  viewers?: number;
  peakViewers?: number;
  avgViewers?: number;
  bitrate?: number;
  totalFrames?: number;
  droppedFrames?: number;
  laggedFrames?: number;
  nextAd?: number;
}) {
  const [currentTime, setCurrentTime] = useState('');

  useEffect(() => {
    const update = () => {
      const d = new Date();
      if (clock24) {
        setCurrentTime(d.toTimeString().slice(0, 5));
      } else {
        let h = d.getHours();
        const m = d.getMinutes().toString().padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        setCurrentTime(`${h}:${m} ${ampm}`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [clock24]);

  const formatUptime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatAd = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className={'statbar' + (starfield ? ' starfield' : '')}>
      <Gauge label="On air" className={isLive ? 'live' : 'offline'} icon={<span className={'live-dot' + (isLive ? '' : ' offline')} />}>
        <div className="gauge-value">{isLive ? formatUptime(uptime) : 'OFFLINE'}</div>
      </Gauge>
      <Gauge label="Local time">
        <div className="gauge-value">{currentTime}</div>
      </Gauge>
      <Gauge label="Next ad break" className="ad">
        <div className="gauge-value">{formatAd(nextAd)}</div>
        <div className="gauge-sub">90s · pre-roll skipped</div>
      </Gauge>
      <Gauge label="Viewers" icon={<Icon name="users" size={11} />}>
        <div className="gauge-value">
          {viewers} <small className="delta-up">▲ 12</small>
        </div>
        <div className="gauge-sub">avg {avgViewers} · peak {peakViewers}</div>
      </Gauge>
      <Gauge label="Stream health">
        <div className="gauge-value health">
          <span className={'health-dot ' + (isLive ? (droppedFrames > 1000 ? 'warn' : 'good') : 'bad')} />
          <span style={{ fontSize: '15px' }}>{isLive ? bitrate : 0}<small> kbps</small></span>
          <span className="health-bars">
            <i style={{ height: isLive ? '7px' : '2px' }} />
            <i style={{ height: isLive ? '10px' : '2px' }} />
            <i style={{ height: isLive ? '13px' : '2px' }} />
            <i style={{ height: isLive ? '16px' : '2px' }} />
            <i style={{ height: isLive ? '12px' : '2px' }} />
          </span>
        </div>
        <div className="gauge-sub">
          {isLive ? (
            <>
              net drop: {droppedFrames} ({((droppedFrames / (totalFrames || 1)) * 100).toFixed(2)}%) · lag: {laggedFrames}
            </>
          ) : (
            'offline'
          )}
        </div>
      </Gauge>
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
