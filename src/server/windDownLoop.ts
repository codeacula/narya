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
  setWindDownTitleState,
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
    // Record which suffix actually went up alongside the base, so a later boot
    // reconcile can strip exactly that rather than whatever the setting says by then.
    setWindDownTitleState(baseTitle, settings.titleSuffix);
    return;
  }

  // Nothing captured means the suffix never went up — there is nothing to restore.
  if (stored.baseTitle === null) return;
  await port.setTitle(stored.baseTitle);
  setWindDownTitleState(null, null);
}

/**
 * A restart while wind-down is active would otherwise leave the suffix welded to the
 * title with nothing left that knows what the title used to be. The base title is
 * persisted precisely so this can put things back the way they were.
 *
 * The base is always re-derived from the LIVE title (never blindly trusted from
 * storage), by stripping the suffix that was ACTUALLY applied last time — recorded
 * in `appliedSuffix` alongside `baseTitle` — rather than a heuristic guess of
 * "does the live title merely end with whatever the suffix setting says right now".
 * That guess had two failure modes: an operator editing the suffixed title they can
 * see has no way to know the trailing text is app-managed, and can plausibly retype
 * only the base while leaving a suffix that happens to still match — which the old
 * heuristic read as "unchanged" and clobbered with the stale stored base. And if the
 * suffix setting changed while active, the live title's OLD suffix would never match
 * the NEW configured one, so the heuristic adopted the whole live title — old suffix
 * included — as the base, double-stacking it on the next compose. Stripping the
 * suffix that was actually recorded handles both: the operator's edit survives
 * because the base always comes from the live title, and the old suffix comes off
 * cleanly because we know exactly what it was, independent of what the setting says
 * now. A state row predating this column has no recorded suffix to fall back on, so
 * it falls back to the current setting — the old best-effort behavior.
 */
export async function reconcileWindDownOnBoot(port: WindDownTitlePort): Promise<void> {
  const state = getWindDownState();
  if (!state.active) return;

  const settings = getWindDownSettings();
  if (settings.titleEnabled) {
    const liveTitle = await port.getTitle();
    const suffixToStrip = state.appliedSuffix ?? settings.titleSuffix;
    // Write-then-persist: only correct baseTitle here, derived from a READ of the live
    // title, not from a write that hasn't happened yet. appliedSuffix still accurately
    // describes what's live right now (nothing has been written to Twitch in this
    // function), so leave it alone — applyWindDownTitle below is what persists the new
    // appliedSuffix, and only once ITS OWN Twitch write actually succeeds. Persisting
    // both here (the old bug) records an appliedSuffix ahead of the write that is
    // supposed to make it true: if that write then fails, the DB claims a suffix went
    // out that never did, and the next reconcile strips a suffix the live title
    // doesn't carry, double-stacking it on top of the real one.
    setWindDownBaseTitle(stripWindDownSuffix(liveTitle, suffixToStrip));
  }

  await applyWindDownTitle(port, true);
}

let windDownTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Both retry branches in `tick()` below would otherwise fire every tick
 * (`DASHBOARD_HEARTBEAT_MS`, 5s by default). Against a permanent failure — revoked
 * OAuth, say — that logs every 5 seconds for the rest of the stream. Retry at full
 * speed for the first few failures, since the common case is a network blip that
 * clears on the very next tick, then back off so a permanent failure quiets down
 * instead of spamming the log. This is noise control, not a real backoff schedule —
 * the retry itself is already self-bounding (a success clears the field it is
 * watching and stops firing).
 */
const RETRY_BURST_TICKS = 5;
const RETRY_BACKOFF_TICKS = 12; // ~1 minute at the default 5s heartbeat, after the burst

function shouldAttemptRetry(consecutiveFailures: number): boolean {
  if (consecutiveFailures < RETRY_BURST_TICKS) return true;
  return consecutiveFailures % RETRY_BACKOFF_TICKS === 0;
}

let activationRetryFailures = 0;
let restoreRetryFailures = 0;

/**
 * Test-only: the failure-streak counters above are module state, so a test that
 * exercises the backoff (deliberately leaving a permanent failure mid-streak) would
 * otherwise leak it into whatever test runs next in the same file.
 */
export function resetWindDownRetryBackoffForTests() {
  activationRetryFailures = 0;
  restoreRetryFailures = 0;
}

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
        activationRetryFailures = 0;
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
      if (shouldAttemptRetry(activationRetryFailures)) {
        try {
          await applyWindDownTitle(port, true);
          activationRetryFailures = 0;
        } catch (error) {
          activationRetryFailures += 1;
          console.error('Wind-down: could not update the Twitch title:', error);
        }
      } else {
        activationRetryFailures += 1;
      }
    } else {
      activationRetryFailures = 0;
    }

    // The mirror image: a restore that failed (e.g. a Twitch outage exactly at
    // stream end) leaves baseTitle populated while inactive, and reconcileWindDownOnBoot
    // only runs while `active` is true — this path just set it false. Retry it here
    // too, rather than relying solely on a redelivered `stream.offline` to try again.
    if (!state.active && state.baseTitle !== null && settings.titleEnabled) {
      if (shouldAttemptRetry(restoreRetryFailures)) {
        try {
          await applyWindDownTitle(port, false);
          restoreRetryFailures = 0;
        } catch (error) {
          restoreRetryFailures += 1;
          console.error('Wind-down: could not restore the Twitch title:', error);
        }
      } else {
        restoreRetryFailures += 1;
      }
    } else {
      restoreRetryFailures = 0;
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
