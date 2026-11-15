import type { DashboardStatus } from '../../shared/api';
import { OBS_OFFLINE } from '../obsNotice';

/**
 * What the stat bar's gauges say, kept apart from `StatBar` so the wording rule is
 * written down once and tested.
 *
 * The rule: a value the dashboard does not know is an em dash, never "N/A", and the
 * gauge's sub-line says why in plain words ("OBS offline", "sign in to Twitch to see
 * ads"). A sub-line never carries a "Status:" prefix — it sits under a labelled gauge
 * already. Lower case, except names (Twitch, OBS).
 */
export const UNKNOWN_VALUE = '—';

export type AdCountdownMode = 'active' | 'next' | 'preroll';

function formatShortDuration(sec: number): string {
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}

/**
 * The Ad break gauge's sub-line, plus a `title` carrying the server's longer
 * explanation when the schedule could not be read.
 */
export function adGaugeSub({
  mode,
  adScheduleStatus,
  adScheduleError,
  adBreakDurationSeconds,
  snoozeCount,
}: {
  mode: AdCountdownMode | null;
  adScheduleStatus: DashboardStatus['adScheduleStatus'];
  adScheduleError: string | null;
  adBreakDurationSeconds: number | null;
  snoozeCount: number | null;
}): { text: string; title?: string } {
  if (mode === 'active') return { text: 'ads running' };
  if (mode === 'preroll') return { text: 'pre-roll off' };
  if (mode === 'next') {
    return {
      text: [
        'next ad scheduled',
        adBreakDurationSeconds !== null ? `${formatShortDuration(adBreakDurationSeconds)} break` : null,
        snoozeCount !== null ? `${snoozeCount} snooze${snoozeCount === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · '),
    };
  }
  switch (adScheduleStatus) {
    case 'available':
      return { text: 'no ad scheduled' };
    case 'not_configured':
      return { text: 'sign in to Twitch to see ads', title: adScheduleError ?? undefined };
    case 'missing_scope':
      return { text: 'reconnect Twitch to see ads', title: adScheduleError ?? undefined };
    case 'unauthorized':
      return { text: 'Twitch refused the ad schedule', title: adScheduleError ?? undefined };
    default:
      return { text: 'ad schedule unavailable', title: adScheduleError ?? undefined };
  }
}

/** The Viewers gauge: the count, or a dash with the reason it is missing. */
export function viewersGauge(viewerCount: number | null, streamActive: boolean | null): { value: string; sub: string } {
  if (viewerCount !== null) return { value: String(viewerCount), sub: 'concurrent viewers' };
  return {
    value: UNKNOWN_VALUE,
    sub: streamActive === false ? 'stream offline' : 'Twitch viewer count unavailable',
  };
}

/**
 * The Stream health gauge. OBS down and OBS idle are different reasons and say so;
 * an unknown lag count inside a known reading is a dash like any other unknown.
 */
export function healthGauge({
  obsConnected,
  bitrateKbps,
  totalFrames,
  droppedFrames,
  laggedFrames,
}: {
  obsConnected: boolean;
  bitrateKbps: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  laggedFrames: number | null;
}): { value: string; unit: string; sub: string } {
  const value = bitrateKbps === null ? UNKNOWN_VALUE : String(bitrateKbps);
  const unit = bitrateKbps === null ? '' : ' kbps';
  if (!obsConnected) return { value, unit, sub: OBS_OFFLINE };
  // Throughput, not frame counts, is the idle signal: a connected but idle OBS still
  // reports skipped/lagged frame numbers, and obs.ts only derives a bitrate while the
  // output is active (the same rule the stat bar's health meter keys off).
  if (bitrateKbps === null) return { value, unit, sub: 'not streaming' };
  const frameBase = totalFrames && totalFrames > 0 ? totalFrames : 1;
  const dropped = droppedFrames ?? 0;
  const dropPct = (dropped / frameBase) * 100;
  const lag = laggedFrames !== null ? `${laggedFrames} frames` : UNKNOWN_VALUE;
  return { value, unit, sub: `drop: ${dropped} (${dropPct.toFixed(2)}%) · lag: ${lag}` };
}
