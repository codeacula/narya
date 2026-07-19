import { DASHBOARD_HEARTBEAT_MS } from '../shared/constants';
import type { RuntimeState } from './runtime';
import { getCurrentStreamSessionId, getPlannedStreamEnd } from './streamSession';
import { getTwitchChannelTitle, setTwitchChannelTitle } from './twitch/api';
import {
  broadcastWindDown,
  getWindDownSettings,
  getWindDownState,
  setWindDownActive,
  setWindDownBaseTitle,
} from './windDown';
import { evaluateWindDown } from './windDownSchedule';
import { composeWindDownTitle, stripWindDownSuffix } from './windDownTitle';

/**
 * The wind-down tick loop and the one place that edits the Twitch title for it.
 *
 * The Twitch calls are behind a port so the title logic — which is where the
 * interesting failure modes live — is testable without network.
 */

/** The Twitch surface this module needs, injected so tests can supply a fake channel. */
export type WindDownTitlePort = {
  getTitle: () => Promise<string>;
  setTitle: (title: string) => Promise<void>;
};

/** Exported so the `set_wind_down` Action step uses this port rather than rebuilding it. */
export function windDownTitlePort(state: RuntimeState): WindDownTitlePort {
  return {
    getTitle: () => getTwitchChannelTitle(state),
    setTitle: (title: string) => setTwitchChannelTitle(state, title),
  };
}

/**
 * Put the suffix up, or take it down.
 *
 * The live title is always recomputed from the stored base title, never appended to
 * whatever is currently on the channel, so repeated activation cannot stack suffixes.
 * The base title is only captured on the transition into wind-down, and only cleared
 * once the restore has actually landed.
 */
export async function applyWindDownTitle(port: WindDownTitlePort, active: boolean): Promise<void> {
  const settings = getWindDownSettings();
  if (!settings.titleEnabled) return;

  const stored = getWindDownState();

  if (active) {
    // An already-captured base title wins: it is the operator's real title, and the
    // live one has the suffix on it.
    const baseTitle = stored.baseTitle ?? await port.getTitle();
    const next = composeWindDownTitle(baseTitle, settings.titleSuffix);
    // Write first. A failed PATCH must not leave a base title recorded for a suffix
    // that never went up, and must not clear one that is still live.
    await port.setTitle(next);
    setWindDownBaseTitle(baseTitle);
    return;
  }

  // Nothing captured means the suffix never went up — there is nothing to restore.
  if (stored.baseTitle === null) return;
  await port.setTitle(stored.baseTitle);
  setWindDownBaseTitle(null);
}

/**
 * A restart while wind-down is active would otherwise leave the suffix welded to the
 * title with nothing left that knows what the title used to be. The base title is
 * persisted precisely so this can put things back the way they were.
 *
 * But the stored base title can go stale: activate -> process dies -> the operator
 * edits the title directly on Twitch -> restart. Blindly reapplying the stored base
 * would clobber that edit. The live title is the tell: if our suffix is still on the
 * end of it, nothing has changed underneath us (or the crash landed after the Twitch
 * write succeeded but before the base title got persisted — stripping the suffix
 * recovers the correct base either way). If the suffix is already gone, the operator
 * changed the title while we were down, and their edit — with no suffix to strip —
 * becomes the new base untouched.
 */
export async function reconcileWindDownOnBoot(port: WindDownTitlePort): Promise<void> {
  const state = getWindDownState();
  if (!state.active) return;

  const settings = getWindDownSettings();
  if (settings.titleEnabled) {
    const liveTitle = await port.getTitle();
    const suffix = settings.titleSuffix.trim();
    const suffixStillPresent = suffix.length > 0 && liveTitle.trim().endsWith(suffix);
    if (state.baseTitle === null || !suffixStillPresent) {
      setWindDownBaseTitle(stripWindDownSuffix(liveTitle, settings.titleSuffix));
    }
  }

  await applyWindDownTitle(port, true);
}

let windDownTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Exported so tests can drive a tick directly rather than waiting on the real
 * interval — the only seam this needs, since the decision logic itself already reads
 * real wall-clock time (`Date.now()`) and DB state that a test can set up directly
 * (a planned end a few minutes out, a real stream session row, etc).
 */
export async function tick(port: WindDownTitlePort): Promise<void> {
  // Overlapping ticks could double-apply the title while a slow PATCH is in flight.
  if (running) return;
  running = true;
  try {
    const settings = getWindDownSettings();
    const state = getWindDownState();
    const decision = evaluateWindDown({
      now: Date.now(),
      plannedEndAt: getPlannedStreamEnd(),
      leadMinutes: settings.leadMinutes,
      sessionId: getCurrentStreamSessionId(),
      state: { active: state.active, dismissedSessionId: state.dismissedSessionId },
    });

    if (decision.action === 'activate') {
      setWindDownActive({ active: true, source: 'scheduled' });
      try {
        await applyWindDownTitle(port, true);
      } catch (error) {
        // Left active with baseTitle still null — applyWindDownTitle only persists
        // it once the Twitch write succeeds. That null is exactly the signal the
        // retry branch below looks for on the next tick; this IS the retry
        // mechanism, not a placeholder for one.
        console.error('Wind-down: could not update the Twitch title:', error);
      }
      return;
    }

    // Not activating this tick — but if we are already active and the activation's
    // Twitch write never actually landed (baseTitle null, activation not disabled),
    // retry it here rather than leaving the suffix off for the rest of the stream
    // while the dashboard confidently shows "active".
    if (state.active && state.baseTitle === null && settings.titleEnabled) {
      try {
        await applyWindDownTitle(port, true);
      } catch (error) {
        console.error('Wind-down: could not update the Twitch title:', error);
      }
    }
  } finally {
    running = false;
  }
}

export function startWindDownLoop(state: RuntimeState) {
  const port = windDownTitlePort(state);

  void reconcileWindDownOnBoot(port)
    .then(() => broadcastWindDown())
    .catch(error => console.error('Wind-down: boot reconcile failed:', error));

  if (windDownTimer) clearInterval(windDownTimer);
  windDownTimer = setInterval(() => { void tick(port); }, DASHBOARD_HEARTBEAT_MS);
}
