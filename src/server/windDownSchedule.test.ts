import { describe, expect, test } from 'bun:test';
import { evaluateWindDown, type WindDownSchedulerState } from './windDownSchedule';

const AT_9PM = Date.parse('2026-07-19T21:00:00.000Z');
const MINUTE = 60_000;

const idle: WindDownSchedulerState = { active: false, dismissedSessionId: null };

function evaluate(overrides: Partial<Parameters<typeof evaluateWindDown>[0]> = {}) {
  return evaluateWindDown({
    now: AT_9PM - 20 * MINUTE,
    plannedEndAt: '2026-07-19T21:00:00.000Z',
    leadMinutes: 15,
    sessionId: 'session-1',
    state: idle,
    ...overrides,
  });
}

describe('evaluateWindDown', () => {
  test('does nothing before the lead window opens', () => {
    expect(evaluate({ now: AT_9PM - 20 * MINUTE }).action).toBe('none');
    expect(evaluate({ now: AT_9PM - 20 * MINUTE }).reason).toBe('before_window');
  });

  test('activates once the lead window is reached', () => {
    expect(evaluate({ now: AT_9PM - 15 * MINUTE })).toEqual({ action: 'activate', reason: 'lead_window_reached' });
  });

  test('activates inside the window', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE }).action).toBe('activate');
  });

  // Running over does not undo it: a stream past its planned end is still winding
  // down, and a restart at that point must still put the signal up.
  test('still activates after the planned end has passed', () => {
    expect(evaluate({ now: AT_9PM + 30 * MINUTE }).action).toBe('activate');
  });

  test('does nothing when already active', () => {
    const state: WindDownSchedulerState = { active: true, dismissedSessionId: null };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state })).toEqual({ action: 'none', reason: 'already_active' });
  });

  // The rule that makes this feature usable. Turning wind-down off by hand because
  // the stream is continuing must not be undone by the very next tick.
  test('a manual dismissal latches for the rest of the session', () => {
    const state: WindDownSchedulerState = { active: false, dismissedSessionId: 'session-1' };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state }))
      .toEqual({ action: 'none', reason: 'dismissed_this_session' });
  });

  test('a dismissal from a previous session does not latch the current one', () => {
    const state: WindDownSchedulerState = { active: false, dismissedSessionId: 'session-0' };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state }).action).toBe('activate');
  });

  test('does nothing off-stream', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, sessionId: null }))
      .toEqual({ action: 'none', reason: 'no_active_session' });
  });

  test('does nothing with no planned end', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, plannedEndAt: null }))
      .toEqual({ action: 'none', reason: 'no_planned_end' });
  });

  test('an unparsable planned end is inert rather than throwing', () => {
    expect(evaluate({ now: AT_9PM, plannedEndAt: 'not a date' }))
      .toEqual({ action: 'none', reason: 'unparsable_planned_end' });
  });

  test('a zero or negative lead disables scheduling', () => {
    expect(evaluate({ now: AT_9PM, leadMinutes: 0 })).toEqual({ action: 'none', reason: 'lead_disabled' });
    expect(evaluate({ now: AT_9PM, leadMinutes: -5 })).toEqual({ action: 'none', reason: 'lead_disabled' });
  });
});
