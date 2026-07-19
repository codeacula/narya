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
 */
export async function reconcileWindDownOnBoot(port: WindDownTitlePort): Promise<void> {
  if (!getWindDownState().active) return;
  await applyWindDownTitle(port, true);
}

let windDownTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(port: WindDownTitlePort): Promise<void> {
  // Overlapping ticks could double-apply the title while a slow PATCH is in flight.
  if (running) return;
  running = true;
  try {
    const settings = getWindDownSettings();
    const decision = evaluateWindDown({
      now: Date.now(),
      plannedEndAt: getPlannedStreamEnd(),
      leadMinutes: settings.leadMinutes,
      sessionId: getCurrentStreamSessionId(),
      state: { active: getWindDownState().active, dismissedSessionId: getWindDownState().dismissedSessionId },
    });
    if (decision.action !== 'activate') return;

    setWindDownActive({ active: true, source: 'scheduled' });
    try {
      await applyWindDownTitle(port, true);
    } catch (error) {
      // The overlay signal is already up; only the title failed. Leave wind-down
      // active and let the next tick's reconcile retry rather than tearing down a
      // signal the viewer can already see.
      console.error('Wind-down: could not update the Twitch title:', error);
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
