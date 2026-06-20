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
  channel,
}: {
  page: string;
  setPage: (p: string) => void;
  tweaksOpen: boolean;
  onTweaksToggle: () => void;
  channel: string;
}) {
  const brand = channel.trim();
  const displayBrand = brand ? brand.toUpperCase() : '...';

  return (
    <div className="navbar">
      <div className="brand">
        <img
          src="/assets/mark.svg"
          alt=""
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <span className="wm">{displayBrand}</span>
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
      <div className="nav-avatar">{brand ? displayBrand[0] : '?'}</div>
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
  streamActive,
  uptimeSeconds,
  activeChatters,
  sessionChatters,
  knownChatters,
  bitrateKbps,
  totalFrames,
  droppedFrames,
  laggedFrames,
  nextAdSeconds,
  chatConnection,
  obsConnected,
  eventSubConnected,
}: {
  clock24: boolean;
  starfield: boolean;
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  activeChatters: number;
  sessionChatters: number;
  knownChatters: number;
  bitrateKbps: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  laggedFrames: number | null;
  nextAdSeconds: number | null;
  chatConnection: string;
  obsConnected: boolean;
  eventSubConnected: boolean;
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

  const formatDuration = (sec: number) => {
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

  const streamLabel = streamActive === null ? 'UNKNOWN' : streamActive ? formatDuration(uptimeSeconds ?? 0) : 'OFFLINE';
  const streamClass = streamActive ? 'live' : 'offline';
  const hasObsStats = bitrateKbps !== null || droppedFrames !== null || laggedFrames !== null;
  const frameBase = totalFrames && totalFrames > 0 ? totalFrames : 1;
  const droppedFrameCount = droppedFrames ?? 0;

  return (
    <div className={'statbar' + (starfield ? ' starfield' : '')}>
      <Gauge label="Stream" className={streamClass} icon={<span className={'live-dot' + (streamActive ? '' : ' offline')} />}>
        <div className="gauge-value">{streamLabel}</div>
        <div className="gauge-sub">chat {chatConnection.toLowerCase()} · events {eventSubConnected ? 'open' : 'closed'}</div>
      </Gauge>
      <Gauge label="Local time">
        <div className="gauge-value">{currentTime}</div>
      </Gauge>
      <Gauge label="Next ad break" className="ad">
        <div className="gauge-value">{nextAdSeconds === null ? 'N/A' : formatAd(nextAdSeconds)}</div>
        <div className="gauge-sub">{nextAdSeconds === null ? 'not reported by backend' : 'live schedule'}</div>
      </Gauge>
      <Gauge label="Chatters" icon={<Icon name="users" size={11} />}>
        <div className="gauge-value">
          {activeChatters}
        </div>
        <div className="gauge-sub">session {sessionChatters} · known {knownChatters}</div>
      </Gauge>
      <Gauge label="Stream health">
        <div className="gauge-value health">
          <span className={'health-dot ' + (obsConnected ? (droppedFrameCount > 1000 ? 'warn' : 'good') : 'bad')} />
          <span style={{ fontSize: '15px' }}>
            {bitrateKbps === null ? 'N/A' : bitrateKbps}<small>{bitrateKbps === null ? '' : ' kbps'}</small>
          </span>
          <span className="health-bars">
            <i style={{ height: obsConnected ? '7px' : '2px' }} />
            <i style={{ height: obsConnected ? '10px' : '2px' }} />
            <i style={{ height: obsConnected ? '13px' : '2px' }} />
            <i style={{ height: obsConnected ? '16px' : '2px' }} />
            <i style={{ height: obsConnected ? '12px' : '2px' }} />
          </span>
        </div>
        <div className="gauge-sub">
          {hasObsStats ? (
            <>
              net drop: {droppedFrameCount} ({((droppedFrameCount / frameBase) * 100).toFixed(2)}%) · lag: {laggedFrames ?? 'N/A'}
            </>
          ) : (
            'OBS unavailable'
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
