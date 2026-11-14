import React from 'react';
import type { LatestEvent } from '../shared/api';
import { CrystalOrb } from './crystalOrb';
import { useLatestEvents } from './latestEvents';
import { MusicPanel } from './music';
import { useStreamSessionStart } from './streamSession';
import { useStreamStatus } from './streamStatus';
import { uptimeSince } from './uptime';

function BarSeparator() {
  return <div className="bar-sep" aria-hidden="true" />;
}

function BarSlot({ label, event }: { label: string; event: LatestEvent | null }) {
  return (
    <div className="bar-slot">
      <span className="bar-eyebrow">{label}</span>
      {/* An empty slot keeps its place with a dash so the four slots never jump. */}
      {event ? (
        <span className="bar-value">
          {event.name}
          {event.amount !== null ? <span className="bar-value-aux"> · {event.amount}</span> : null}
        </span>
      ) : (
        <span className="bar-value bar-value-empty">—</span>
      )}
    </div>
  );
}

/** The community bar: latest follower, sub, bits and raid in four fixed slots. */
export function TopBar() {
  const latest = useLatestEvents();
  return (
    <div className="overlay-bar overlay-bar-top" role="region" aria-label="Latest community events">
      <BarSlot label="latest follower" event={latest.follow} />
      <BarSeparator />
      <BarSlot label="latest sub" event={latest.sub} />
      <BarSeparator />
      <BarSlot label="latest bits" event={latest.cheer} />
      <BarSeparator />
      <BarSlot label="latest raid" event={latest.raid} />
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The Code bar: wordmark, the operator's "now" line, now-playing and uptime. */
export function BottomBar() {
  const status = useStreamStatus();
  const startedAt = useStreamSessionStart();
  const now = useNow(startedAt !== null);
  const nowText = status?.text?.trim() ?? '';
  const uptime = uptimeSince(startedAt, now);

  return (
    <div className="overlay-bar overlay-bar-bottom" role="region" aria-label="Stream info">
      <div className="bar-brand">
        <CrystalOrb variant="arcane" size={22} />
        <span className="bar-wordmark">CODEACULA</span>
      </div>
      {nowText ? (
        <>
          <BarSeparator />
          <div className="bar-slot">
            <span className="bar-eyebrow">now</span>
            <span className="bar-value">{nowText}</span>
          </div>
        </>
      ) : null}
      <div className="bar-spacer" />
      <MusicPanel inBar />
      {uptime ? (
        <>
          <BarSeparator />
          <span className="bar-uptime">{uptime}</span>
        </>
      ) : null}
    </div>
  );
}
