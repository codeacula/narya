import { DASHBOARD_HEARTBEAT_MS } from '../shared/constants';
import { getTwitchAdSchedule, getTwitchStreamStatus } from './dashboard/status';
import type { AdSchedule, RuntimeState, StreamActivityStatus } from './runtime';
import { runTwitchCommercial } from './twitch/api';

const AUTOMATIC_AD_RETRY_MS = 30_000;
const PREROLL_REANCHOR_DRIFT_MS = 15_000;

export type AdScheduleTracker = {
  lastCompletedDeadline: string | null;
  trackedPrerollDeadlineMs: number | null;
  // Whether we've yet observed a usable schedule. A past deadline on the very
  // first observation is stale from before boot and is skipped (see A13).
  firstObservation: boolean;
};

export type AdScheduleDecision = {
  action: 'run' | 'skip';
  // For a run, the deadlineKey to record once the commercial succeeds. For a
  // skip, a short machine-readable reason.
  reason: string;
  nextTracker: AdScheduleTracker;
};

// Pure decision logic for the automatic-ads loop, extracted so it can be tested
// without timers or network. The caller fetches streamStatus/adSchedule and owns
// the running/retry guards and the actual commercial call.
export function evaluateAdSchedule(input: {
  now: number;
  adBreakEndsAt: string | null;
  streamStatus: StreamActivityStatus;
  adSchedule: AdSchedule;
  tracker: AdScheduleTracker;
}): AdScheduleDecision {
  const { now, adBreakEndsAt, streamStatus, adSchedule } = input;
  let { lastCompletedDeadline, trackedPrerollDeadlineMs, firstObservation } = input.tracker;

  const skip = (reason: string): AdScheduleDecision => ({
    action: 'skip',
    reason,
    nextTracker: { lastCompletedDeadline, trackedPrerollDeadlineMs, firstObservation },
  });

  const activeAdEndsAtMs = adBreakEndsAt ? new Date(adBreakEndsAt).getTime() : Number.NaN;
  if (Number.isFinite(activeAdEndsAtMs) && activeAdEndsAtMs > now) return skip('ad_break_active');

  if (streamStatus.streamActive !== true || streamStatus.uptimeSource !== 'twitch') {
    trackedPrerollDeadlineMs = null;
    return skip('stream_offline');
  }
  if (adSchedule.adScheduleStatus !== 'available') return skip('schedule_unavailable');

  if (adSchedule.prerollFreeTimeSeconds !== null && adSchedule.prerollFreeTimeSeconds > 0) {
    const reportedDeadlineMs = now + adSchedule.prerollFreeTimeSeconds * 1000;
    if (trackedPrerollDeadlineMs === null || Math.abs(reportedDeadlineMs - trackedPrerollDeadlineMs) > PREROLL_REANCHOR_DRIFT_MS) {
      trackedPrerollDeadlineMs = reportedDeadlineMs;
    }
  }

  const twitchDeadlineMs = adSchedule.nextAdAt ? new Date(adSchedule.nextAdAt).getTime() : Number.NaN;
  const deadlineMs = trackedPrerollDeadlineMs ?? twitchDeadlineMs;
  if (!Number.isFinite(deadlineMs)) return skip('no_deadline');

  const deadlineKey = trackedPrerollDeadlineMs !== null
    ? `preroll:${Math.round(deadlineMs / 1000)}`
    : `scheduled:${adSchedule.nextAdAt}`;
  if (deadlineKey === lastCompletedDeadline) return skip('already_completed');

  if (deadlineMs > now) {
    firstObservation = false;
    return skip('deadline_future');
  }

  if (firstObservation) {
    // Stale deadline from before boot: mark it complete and skip so we don't
    // fire a commercial within seconds of startup.
    firstObservation = false;
    lastCompletedDeadline = deadlineKey;
    trackedPrerollDeadlineMs = null;
    return skip('stale_at_boot');
  }

  // Deadline reached while running: run. The caller records deadlineKey as
  // completed and clears the preroll deadline only after the commercial succeeds.
  return {
    action: 'run',
    reason: deadlineKey,
    nextTracker: { lastCompletedDeadline, trackedPrerollDeadlineMs, firstObservation },
  };
}

export function startAutomaticAds(state: RuntimeState) {
  let running = false;
  let retryAfterMs = 0;
  let tracker: AdScheduleTracker = {
    lastCompletedDeadline: null,
    trackedPrerollDeadlineMs: null,
    firstObservation: true,
  };

  const checkSchedule = async () => {
    if (running || Date.now() < retryAfterMs) return;
    // Cheap pre-filter: don't fetch the schedule while an ad break is active.
    const activeAdEndsAtMs = state.adBreakEndsAt ? new Date(state.adBreakEndsAt).getTime() : Number.NaN;
    if (Number.isFinite(activeAdEndsAtMs) && activeAdEndsAtMs > Date.now()) return;

    const [streamStatus, adSchedule] = await Promise.all([
      getTwitchStreamStatus(state),
      getTwitchAdSchedule(state),
    ]);

    const decision = evaluateAdSchedule({
      now: Date.now(),
      adBreakEndsAt: state.adBreakEndsAt,
      streamStatus,
      adSchedule,
      tracker,
    });
    tracker = decision.nextTracker;

    if (decision.action === 'skip') {
      if (decision.reason === 'stale_at_boot') {
        console.log(`Twitch ads: skipping stale ad deadline observed at boot (${tracker.lastCompletedDeadline}).`);
      }
      return;
    }

    running = true;
    try {
      const commercial = await runTwitchCommercial(state);
      tracker = { ...tracker, lastCompletedDeadline: decision.reason, trackedPrerollDeadlineMs: null };
      retryAfterMs = 0;
      console.log(`Twitch ads: automatically started a ${commercial.durationSeconds}s commercial.`);
    } catch (error) {
      retryAfterMs = Date.now() + AUTOMATIC_AD_RETRY_MS;
      console.error('Twitch ads: automatic commercial failed; retrying in 30 seconds:', error);
    } finally {
      running = false;
    }
  };

  void checkSchedule().catch(error => console.error('Twitch ads: schedule check failed:', error));
  setInterval(() => {
    void checkSchedule().catch(error => console.error('Twitch ads: schedule check failed:', error));
  }, DASHBOARD_HEARTBEAT_MS);
}
