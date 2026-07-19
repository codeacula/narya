/**
 * Pure decision logic for the wind-down loop, extracted so it can be tested without
 * timers, a database, or network — the same split as `evaluateAdSchedule`. The caller
 * loads the state and settings, and owns the actual activation.
 */

/** Only the fields of the stored row the decision depends on. */
export type WindDownSchedulerState = {
  active: boolean;
  /** The session the operator manually turned wind-down off during, if any. */
  dismissedSessionId: string | null;
};

export type WindDownDecision = {
  action: 'activate' | 'none';
  /** Machine-readable, for logs and tests. */
  reason: string;
};

const MS_PER_MINUTE = 60_000;

export function evaluateWindDown(input: {
  now: number;
  plannedEndAt: string | null;
  leadMinutes: number;
  sessionId: string | null;
  state: WindDownSchedulerState;
}): WindDownDecision {
  const { now, plannedEndAt, leadMinutes, sessionId, state } = input;

  if (state.active) return { action: 'none', reason: 'already_active' };
  if (!sessionId) return { action: 'none', reason: 'no_active_session' };

  // The operator turned it off by hand during this session. Honour that for the rest
  // of the stream: re-arming on the next tick makes the off switch useless, which is
  // worse than never having scheduled it.
  if (state.dismissedSessionId === sessionId) {
    return { action: 'none', reason: 'dismissed_this_session' };
  }

  if (!plannedEndAt) return { action: 'none', reason: 'no_planned_end' };
  if (leadMinutes <= 0) return { action: 'none', reason: 'lead_disabled' };

  const endMs = new Date(plannedEndAt).getTime();
  if (!Number.isFinite(endMs)) return { action: 'none', reason: 'unparsable_planned_end' };

  // No upper bound on purpose. Past the planned end the stream is still winding down,
  // so a late boot or a stream running over must still raise the signal.
  if (now < endMs - leadMinutes * MS_PER_MINUTE) return { action: 'none', reason: 'before_window' };

  return { action: 'activate', reason: 'lead_window_reached' };
}
