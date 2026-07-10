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
  alert,
}: {
  page: string;
  setPage: (p: string) => void;
  tweaksOpen: boolean;
  onTweaksToggle: () => void;
  channel: string;
  alert?: React.ReactNode;
}) {
  const channelName = channel.trim();

  return (
    <div className="navbar">
      <div className="brand">
        <img
          src="/assets/mark.svg"
          alt=""
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <span className="wm">Narya</span>
      </div>
      <div className="navlinks">
        <button
          className={'navlink' + (page === 'dashboard' ? ' active' : '')}
          onClick={() => setPage('dashboard')}
        >
          dashboard
        </button>
        <button
          className={'navlink' + (page === 'rewards' ? ' active' : '')}
          onClick={() => setPage('rewards')}
        >
          viewer rewards
        </button>
        <button
          className={'navlink' + (page === 'categories' ? ' active' : '')}
          onClick={() => setPage('categories')}
        >
          categories
        </button>
        <button
          className={'navlink' + (page === 'viewers' ? ' active' : '')}
          onClick={() => setPage('viewers')}
        >
          viewers
        </button>
        <button
          className={'navlink' + (page === 'settings' ? ' active' : '')}
          onClick={() => setPage('settings')}
        >
          settings
        </button>
      </div>
      <div className="nav-spacer" />
      {alert}
      <a className="nav-icon" href="/tablet" title="Tablet mode" aria-label="Tablet mode">
        <Icon name="dock" size={15} />
      </a>
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
      <div className="nav-avatar">{channelName ? channelName[0].toUpperCase() : '?'}</div>
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
  onGoLive,
  onRunPreroll,
  onOpenStreamInfo,
  goLiveBusy,
  prerollBusy,
  actionMessage,
  twitchMissingScopes,
  streamActive,
  uptimeSeconds,
  uptimeSource,
  viewerCount,
  bitrateKbps,
  congestion,
  totalFrames,
  droppedFrames,
  laggedFrames,
  adBreakEndsAt,
  adScheduleStatus,
  adScheduleError,
  nextAdAt,
  adBreakDurationSeconds,
  prerollFreeTimeSeconds,
  snoozeCount,
  chatConnection,
  obsConnected,
  eventSubConnected,
  eventSubError,
  onReconnectEventSub,
}: {
  clock24: boolean;
  starfield: boolean;
  onGoLive: () => void;
  onRunPreroll: () => void;
  onOpenStreamInfo: () => void;
  goLiveBusy: boolean;
  prerollBusy: boolean;
  actionMessage: string | null;
  twitchMissingScopes: string[];
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  uptimeSource: 'twitch' | 'obs' | null;
  viewerCount: number | null;
  bitrateKbps: number | null;
  congestion: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  laggedFrames: number | null;
  adBreakEndsAt: string | null;
  adScheduleStatus: 'available' | 'not_configured' | 'missing_scope' | 'unauthorized' | 'unavailable';
  adScheduleError: string | null;
  nextAdAt: string | null;
  adBreakDurationSeconds: number | null;
  prerollFreeTimeSeconds: number | null;
  snoozeCount: number | null;
  chatConnection: string;
  obsConnected: boolean;
  eventSubConnected: boolean;
  eventSubError: string | null;
  onReconnectEventSub: () => void;
}) {
  const [currentTime, setCurrentTime] = useState('');
  const [displaySeconds, setDisplaySeconds] = useState(uptimeSeconds ?? 0);
  const [adCountdown, setAdCountdown] = useState<{ seconds: number; mode: 'active' | 'next' | 'preroll' } | null>(null);

  // Local clock
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

  // Stream uptime: seed from OBS poll, then count up locally each second
  useEffect(() => {
    if (uptimeSeconds === null || !streamActive) {
      setDisplaySeconds(0);
      return;
    }
    setDisplaySeconds(uptimeSeconds);
    const interval = setInterval(() => setDisplaySeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [uptimeSeconds, streamActive]);

  // Ad countdown: active ads take warning priority; otherwise show the safest known ad timer.
  useEffect(() => {
    const prerollStartedAt = Date.now();
    const initialPrerollSeconds = prerollFreeTimeSeconds;

    const tick = () => {
      const remainingFrom = (value: string | null) => {
        if (!value) return null;
        const timestamp = new Date(value).getTime();
        if (!Number.isFinite(timestamp)) return null;
        const remaining = Math.floor((timestamp - Date.now()) / 1000);
        return remaining > 0 ? remaining : null;
      };

      const activeSeconds = remainingFrom(adBreakEndsAt);
      if (activeSeconds !== null) {
        setAdCountdown({ seconds: activeSeconds, mode: 'active' });
        return;
      }

      if (initialPrerollSeconds !== null && initialPrerollSeconds > 0) {
        const elapsed = Math.floor((Date.now() - prerollStartedAt) / 1000);
        const prerollSeconds = Math.max(0, initialPrerollSeconds - elapsed);
        setAdCountdown(prerollSeconds > 0 ? { seconds: prerollSeconds, mode: 'preroll' } : null);
        return;
      }

      const nextSeconds = remainingFrom(nextAdAt);
      if (nextSeconds !== null) {
        setAdCountdown({ seconds: nextSeconds, mode: 'next' });
        return;
      }

      setAdCountdown(null);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [adBreakEndsAt, nextAdAt, prerollFreeTimeSeconds]);

  const formatDuration = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatMM = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatShortDuration = (sec: number) => {
    if (sec >= 60) return `${Math.round(sec / 60)}m`;
    return `${sec}s`;
  };

  const streamLabel = streamActive === null ? '—' : streamActive ? formatDuration(displaySeconds) : 'OFFLINE';
  const uptimeSourceLabel = uptimeSource === 'twitch' ? 'twitch uptime' : uptimeSource === 'obs' ? 'obs uptime' : 'uptime unavailable';
  const streamClass = streamActive ? 'live' : 'offline';
  const hasObsStats = obsConnected && (bitrateKbps !== null || droppedFrames !== null);
  const frameBase = totalFrames && totalFrames > 0 ? totalFrames : 1;
  const droppedFrameCount = droppedFrames ?? 0;
  const dropPct = (droppedFrameCount / frameBase) * 100;

  // Health bars: use OBS congestion (0–1) if available, fall back to dropped frame %
  const healthScore = congestion !== null
    ? 1 - congestion
    : obsConnected
      ? Math.max(0, 1 - dropPct / 5)
      : 0;
  // Bitrate is the truest "actually streaming" signal — a connected but idle OBS
  // still reports dropped/lagged frame counts, so keying off those would light the
  // health meter green while the value reads "N/A" and the stream is offline.
  const hasThroughput = obsConnected && bitrateKbps !== null;
  const barCount = hasThroughput ? Math.max(1, Math.round(healthScore * 5)) : 0;
  const barHeights = ['7px', '10px', '13px', '16px', '12px'];
  const healthDotClass = !hasThroughput ? 'bad' : healthScore > 0.7 ? 'good' : healthScore > 0.4 ? 'warn' : 'bad';
  // Green only when an ad is actually scheduled/counting down — not merely because
  // the ad system is reachable, which would tint an idle "N/A" green.
  const adClass = adCountdown?.mode === 'active'
    ? 'ad-warn'
    : adCountdown !== null
      ? 'ad-safe'
      : '';
  const adSub = adCountdown?.mode === 'active'
    ? 'Status: ads running'
    : adCountdown?.mode === 'preroll'
      ? 'Status: pre-roll off'
    : adCountdown?.mode === 'next'
      ? [
          'Status: next ad scheduled',
          adBreakDurationSeconds !== null ? `${formatShortDuration(adBreakDurationSeconds)} break` : null,
          snoozeCount !== null ? `${snoozeCount} snooze${snoozeCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ')
      : adScheduleStatus === 'missing_scope'
        ? 'Status: reconnect Twitch for ads'
        : adScheduleStatus === 'unauthorized'
          ? 'Status: Twitch cannot read ads'
          : adScheduleStatus === 'not_configured'
            ? 'Status: Twitch login required'
            : adScheduleStatus === 'available'
              ? 'Status: no ad scheduled'
            : `Status: ${adScheduleError ?? 'ad status unavailable'}`;
  const activeAdBreak = (() => {
    if (!adBreakEndsAt) return false;
    const timestamp = new Date(adBreakEndsAt).getTime();
    return Number.isFinite(timestamp) && timestamp > Date.now();
  })();
  const missingCommercialScope = twitchMissingScopes.includes('channel:edit:commercial');
  const prerollAvailable = streamActive === true
    && adScheduleStatus === 'available'
    && !missingCommercialScope
    && !activeAdBreak
    && (prerollFreeTimeSeconds === null || prerollFreeTimeSeconds <= 0);
  const prerollDisabledReason = streamActive !== true
    ? 'Stream must be live'
    : missingCommercialScope
      ? 'Reconnect Twitch to grant channel:edit:commercial'
    : adScheduleStatus !== 'available'
      ? adScheduleError ?? 'Twitch ads are unavailable'
      : activeAdBreak
        ? 'Ads are already running'
        : prerollFreeTimeSeconds !== null && prerollFreeTimeSeconds > 0
          ? 'Pre-roll is already off'
          : 'Run 3 minute ad break';

  return (
    <div className={'statbar' + (starfield ? ' starfield' : '')}>
      <Gauge label="Stream" className={'stream-gauge ' + streamClass} icon={<span className={'live-dot' + (streamActive ? '' : ' offline')} />}>
        <div className="gauge-value">{streamLabel}</div>
        <div className="gauge-sub">
          {uptimeSourceLabel} · chat {chatConnection.toLowerCase()} · events {eventSubConnected ? 'open' : eventSubError ? 'error' : 'closed'}
          {eventSubError && !eventSubConnected && (
            <button
              className="eventsub-retry-btn"
              title="Re-authorize Twitch, then click to retry EventSub"
              onClick={onReconnectEventSub}
            >
              retry
            </button>
          )}
        </div>
      </Gauge>
      <Gauge label="Local time">
        <div className="gauge-value">{currentTime}</div>
      </Gauge>
      <Gauge label="Ad break" className={adClass}>
        <div className="gauge-value">{adCountdown !== null ? formatMM(adCountdown.seconds) : 'N/A'}</div>
        <div className="gauge-sub">{adSub}</div>
      </Gauge>
      <Gauge label="Actions">
        <div className="stat-actions">
          <button
            className="stat-action gold"
            type="button"
            title={obsConnected ? 'Switch to the starting scene and start OBS streaming' : 'OBS must be connected'}
            disabled={!obsConnected || goLiveBusy}
            onClick={onGoLive}
          >
            <Icon name="play" size={13} />
            <span>{goLiveBusy ? 'Starting' : 'Go Live'}</span>
          </button>
          <button
            className="stat-action"
            type="button"
            title={prerollDisabledReason}
            disabled={!prerollAvailable || prerollBusy}
            onClick={onRunPreroll}
          >
            <Icon name="play" size={13} />
            <span>{prerollBusy ? 'Running' : '3m ads'}</span>
          </button>
          <button
            className="stat-action"
            type="button"
            title="Edit stream information"
            onClick={onOpenStreamInfo}
          >
            <Icon name="edit" size={13} />
            <span>Info</span>
          </button>
        </div>
        <div className="gauge-sub">{actionMessage ?? 'Twitch controls'}</div>
      </Gauge>
      <Gauge label="Viewers" icon={<Icon name="users" size={11} />}>
        <div className="gauge-value">{viewerCount ?? '—'}</div>
        <div className="gauge-sub">{viewerCount === null ? 'Twitch viewer count' : 'concurrent viewers'}</div>
      </Gauge>
      <Gauge label="Stream health">
        <div className="gauge-value health">
          <span className={'health-dot ' + healthDotClass} />
          <span style={{ fontSize: '15px' }}>
            {bitrateKbps === null ? 'N/A' : bitrateKbps}<small>{bitrateKbps === null ? '' : ' kbps'}</small>
          </span>
          <span className="health-bars">
            {barHeights.map((h, i) => (
              <i key={i} style={{ height: i < barCount ? h : '2px' }} />
            ))}
          </span>
        </div>
        <div className="gauge-sub">
          {hasObsStats
            ? `drop: ${droppedFrameCount} (${dropPct.toFixed(2)}%) · lag: ${laggedFrames !== null ? `${laggedFrames} frames` : 'N/A'}`
            : 'OBS unavailable'}
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
  tabs,
  activeTab,
  onTabChange,
  headerActions,
  titleHidden = false,
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
  tabs?: Array<{ id: string; label: string; badge?: number }>;
  activeTab?: string;
  onTabChange?: (id: string) => void;
  headerActions?: React.ReactNode;
  /** Drop the header title when a tab strip already names the panel. `title` still labels the popout. */
  titleHidden?: boolean;
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
          {!titleHidden && title}
        </span>
        {tabs && tabs.length > 0 && (
          <div className="panel-tabs">
            {tabs.map(t => (
              <button
                key={t.id}
                className={'panel-tab' + (activeTab === t.id ? ' active' : '')}
                onClick={() => onTabChange?.(t.id)}
                type="button"
              >
                {t.label}
                {t.badge ? <span className="panel-tab-badge">{t.badge}</span> : null}
              </button>
            ))}
          </div>
        )}
        {count != null && <span className="panel-count">{count}</span>}
        <span className="panel-actions">
          {headerActions}
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
