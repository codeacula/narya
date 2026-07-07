import { DASHBOARD_HEARTBEAT_MS } from '../shared/constants';
import { getTwitchAdSchedule, getTwitchStreamStatus } from './dashboard/status';
import type { RuntimeState } from './runtime';
import { runTwitchCommercial } from './twitch/api';

const AUTOMATIC_AD_RETRY_MS = 30_000;

export function startAutomaticAds(state: RuntimeState) {
  let running = false;
  let lastCompletedDeadline: string | null = null;
  let trackedPrerollDeadlineMs: number | null = null;
  let retryAfterMs = 0;
  // On the very first usable schedule observation a deadline already in the past
  // is stale from before boot; mark it complete and skip so we don't fire a
  // commercial within seconds of startup. Deadlines that pass while running are
  // handled normally.
  let firstObservation = true;

  const checkSchedule = async () => {
    if (running || Date.now() < retryAfterMs) return;
    const activeAdEndsAtMs = state.adBreakEndsAt ? new Date(state.adBreakEndsAt).getTime() : Number.NaN;
    if (Number.isFinite(activeAdEndsAtMs) && activeAdEndsAtMs > Date.now()) return;

    const [streamStatus, adSchedule] = await Promise.all([
      getTwitchStreamStatus(state),
      getTwitchAdSchedule(state),
    ]);
    if (streamStatus.streamActive !== true || streamStatus.uptimeSource !== 'twitch') {
      trackedPrerollDeadlineMs = null;
      return;
    }
    if (adSchedule.adScheduleStatus !== 'available') return;

    const nowMs = Date.now();
    if (adSchedule.prerollFreeTimeSeconds !== null && adSchedule.prerollFreeTimeSeconds > 0) {
      const reportedDeadlineMs = nowMs + adSchedule.prerollFreeTimeSeconds * 1000;
      if (trackedPrerollDeadlineMs === null || Math.abs(reportedDeadlineMs - trackedPrerollDeadlineMs) > 15_000) {
        trackedPrerollDeadlineMs = reportedDeadlineMs;
      }
    }

    const twitchDeadlineMs = adSchedule.nextAdAt ? new Date(adSchedule.nextAdAt).getTime() : Number.NaN;
    const deadlineMs = trackedPrerollDeadlineMs ?? twitchDeadlineMs;
    if (!Number.isFinite(deadlineMs)) return;

    const deadlineKey = trackedPrerollDeadlineMs !== null
      ? `preroll:${Math.round(deadlineMs / 1000)}`
      : `scheduled:${adSchedule.nextAdAt}`;
    if (deadlineKey === lastCompletedDeadline) return;

    if (deadlineMs > nowMs) {
      firstObservation = false;
      return;
    }

    if (firstObservation) {
      firstObservation = false;
      lastCompletedDeadline = deadlineKey;
      trackedPrerollDeadlineMs = null;
      console.log(`Twitch ads: skipping stale ad deadline observed at boot (${deadlineKey}).`);
      return;
    }

    running = true;
    try {
      const commercial = await runTwitchCommercial(state);
      lastCompletedDeadline = deadlineKey;
      trackedPrerollDeadlineMs = null;
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
