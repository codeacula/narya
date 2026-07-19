import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { db } from './db';
import { getOrStartStreamSession, setPlannedStreamEnd } from './streamSession';
import {
  getWindDownPublicState,
  getWindDownSettings,
  getWindDownState,
  rebaseWindDownTitle,
  registerWindDownRoutes,
  resetWindDownForStreamEnd,
  saveWindDownSettings,
  setWindDownActive,
  setWindDownBaseTitle,
  setWindDownTitleApplier,
} from './windDown';

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
});

// The applier is a module-level seam (see windDown.ts) so it must not leak a fake
// registered by one test into the next.
afterEach(() => {
  setWindDownTitleApplier(null);
});

/** Stands up a throwaway express app with just the wind-down routes mounted. */
async function startTestApp() {
  const app = express();
  app.use(express.json());
  registerWindDownRoutes(app);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('wind-down settings', () => {
  test('a fresh install gets the documented defaults', () => {
    const settings = getWindDownSettings();
    expect(settings.leadMinutes).toBe(15);
    expect(settings.titleSuffix).toBe('| Ending soon');
    expect(settings.titleEnabled).toBe(true);
    expect(settings.overlayEnabled).toBe(true);
  });

  test('saves and reads back', () => {
    saveWindDownSettings({ leadMinutes: 30, titleSuffix: '| Wrapping up', titleEnabled: false, overlayEnabled: true });
    const settings = getWindDownSettings();
    expect(settings.leadMinutes).toBe(30);
    expect(settings.titleSuffix).toBe('| Wrapping up');
    expect(settings.titleEnabled).toBe(false);
  });

  test('clamps an absurd lead time rather than storing it', () => {
    saveWindDownSettings({ leadMinutes: 99_999, titleSuffix: 'x', titleEnabled: true, overlayEnabled: true });
    expect(getWindDownSettings().leadMinutes).toBe(720);
    saveWindDownSettings({ leadMinutes: -10, titleSuffix: 'x', titleEnabled: true, overlayEnabled: true });
    expect(getWindDownSettings().leadMinutes).toBe(0);
  });

  // A suffix that cannot fit inside Twitch's 140 characters would make every title
  // update fail. Reject it here, in the form, rather than at 9pm.
  test('rejects a suffix that could never fit a Twitch title', () => {
    expect(() => saveWindDownSettings({
      leadMinutes: 15,
      titleSuffix: 'X'.repeat(200),
      titleEnabled: true,
      overlayEnabled: true,
    })).toThrow();
  });
});

describe('wind-down state', () => {
  test('starts inactive', () => {
    expect(getWindDownPublicState().active).toBe(false);
    expect(getWindDownPublicState().source).toBeNull();
  });

  test('activating records the source and session', () => {
    const session = getOrStartStreamSession('test-a', '2026-07-19T18:00:00.000Z');
    const state = setWindDownActive({ active: true, source: 'manual' });
    expect(state.active).toBe(true);
    expect(state.source).toBe('manual');
    expect(getWindDownState().sessionId).toBe(session.id);
  });

  test('the public state carries the planned end for the overlay countdown', () => {
    const session = getOrStartStreamSession('test-b', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    expect(getWindDownPublicState().plannedEndAt).toBe('2026-07-19T21:00:00.000Z');
  });

  // The public payload rides an overlay-visible WebSocket event. Operator state must
  // not be on it.
  test('the public state never exposes the stored base title', () => {
    setWindDownBaseTitle('Modding Skyrim');
    expect(Object.keys(getWindDownPublicState())).not.toContain('baseTitle');
    expect(JSON.stringify(getWindDownPublicState())).not.toContain('Modding Skyrim');
  });

  test('turning it off by hand latches the dismissal to the current session', () => {
    const session = getOrStartStreamSession('test-c', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'manual' });
    expect(getWindDownState().active).toBe(false);
    expect(getWindDownState().dismissedSessionId).toBe(session.id);
  });

  // Only a manual switch-off is a decision to keep streaming. An Action or the
  // scheduler turning it off must not stop the schedule from arming again.
  test('a non-manual switch-off does not latch a dismissal', () => {
    getOrStartStreamSession('test-d', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'action' });
    expect(getWindDownState().dismissedSessionId).toBeNull();
  });

  test('activating again clears a stale dismissal', () => {
    getOrStartStreamSession('test-e', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownActive({ active: false, source: 'manual' });
    setWindDownActive({ active: true, source: 'manual' });
    expect(getWindDownState().dismissedSessionId).toBeNull();
  });

  test('the base title round-trips through storage', () => {
    setWindDownBaseTitle('Modding Skyrim');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    setWindDownBaseTitle(null);
    expect(getWindDownState().baseTitle).toBeNull();
  });
});

describe('rebaseWindDownTitle', () => {
  // The operator edits the title they can SEE, which already carries the suffix.
  // Storing that verbatim would double the suffix on the next compose.
  test('re-bases an edit made against the suffixed title', () => {
    getOrStartStreamSession('test-f', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownBaseTitle('Modding Skyrim');
    const live = rebaseWindDownTitle('Modding Fallout | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(live).toBe('Modding Fallout | Ending soon');
  });

  test('re-bases an edit made without the suffix', () => {
    getOrStartStreamSession('test-g', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownBaseTitle('Modding Skyrim');
    const live = rebaseWindDownTitle('Modding Fallout');
    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(live).toBe('Modding Fallout | Ending soon');
  });

  test('passes the title straight through when wind-down is off', () => {
    expect(rebaseWindDownTitle('Modding Fallout')).toBe('Modding Fallout');
    expect(getWindDownState().baseTitle).toBeNull();
  });

  test('leaves the title alone when the title effect is disabled', () => {
    getOrStartStreamSession('test-h', '2026-07-19T18:00:00.000Z');
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });
    setWindDownActive({ active: true, source: 'manual' });
    expect(rebaseWindDownTitle('Modding Fallout')).toBe('Modding Fallout');
  });
});

// Finding 1 (CRITICAL): PUT /api/wind-down only flipped the DB row and broadcast —
// nothing ever called the title applier, so switching off left the suffix on the
// operator's live title forever. These drive the route itself (not the helper
// functions directly) because the bug was specifically that the ROUTE never wired
// the applier in.
describe('PUT /api/wind-down applies the title (Finding 1)', () => {
  test('switching on calls the applier with active=true', async () => {
    const calls: boolean[] = [];
    setWindDownTitleApplier(async active => { calls.push(active); });
    const app = await startTestApp();
    try {
      getOrStartStreamSession('test-put-on', '2026-07-19T18:00:00.000Z');
      const res = await fetch(`http://127.0.0.1:${app.port}/api/wind-down`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual([true]);
      expect(getWindDownState().active).toBe(true);
    } finally {
      await app.close();
    }
  });

  // The exact bug: turning wind-down off never took the suffix back off the title.
  test('switching off calls the applier with active=false', async () => {
    const calls: boolean[] = [];
    setWindDownTitleApplier(async active => { calls.push(active); });
    const app = await startTestApp();
    try {
      getOrStartStreamSession('test-put-off', '2026-07-19T18:00:00.000Z');
      setWindDownActive({ active: true, source: 'manual' });
      calls.length = 0; // only interested in what the PUT itself triggers

      const res = await fetch(`http://127.0.0.1:${app.port}/api/wind-down`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual([false]);
      expect(getWindDownState().active).toBe(false);
    } finally {
      await app.close();
    }
  });

  // Finding 5: this used to never inspect the applier's call record, so it would
  // pass whether or not the route called the applier at all. Assert it was actually
  // invoked, not just that the route survived a throw nobody triggered.
  test('a Twitch failure from the applier does not fail the route or corrupt the state', async () => {
    const calls: boolean[] = [];
    setWindDownTitleApplier(async active => {
      calls.push(active);
      throw new Error('Twitch is down');
    });
    const app = await startTestApp();
    try {
      getOrStartStreamSession('test-put-fail', '2026-07-19T18:00:00.000Z');
      const res = await fetch(`http://127.0.0.1:${app.port}/api/wind-down`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { active: boolean };
      expect(body.active).toBe(true);
      expect(getWindDownState().active).toBe(true);
      expect(calls).toEqual([true]);
    } finally {
      await app.close();
    }
  });
});

// Finding 2 (CRITICAL): stream.offline never reset wind_down_state, so
// evaluateWindDown's `already_active` guard permanently disarmed the scheduler from
// the second stream onward, and the suffix never came back off.
describe('resetWindDownForStreamEnd (Finding 2)', () => {
  test('restores the title and clears every field of the state row', async () => {
    const calls: boolean[] = [];
    setWindDownTitleApplier(async active => { calls.push(active); });

    const session = getOrStartStreamSession('test-reset-a', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownBaseTitle('Modding Skyrim');
    expect(getWindDownState().sessionId).toBe(session.id);

    await resetWindDownForStreamEnd();

    expect(calls).toEqual([false]);
    const state = getWindDownState();
    expect(state.active).toBe(false);
    expect(state.activatedAt).toBeNull();
    expect(state.source).toBeNull();
    expect(state.sessionId).toBeNull();
    expect(state.baseTitle).toBeNull();
    expect(state.dismissedSessionId).toBeNull();
  });

  // The dismissal is scoped to the session that just ended. Leaving it set would
  // silently disable the schedule for the entirely different stream that starts next.
  test('clears a stale manual dismissal even when wind-down was never reactivated', async () => {
    const session = getOrStartStreamSession('test-reset-b', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'manual' });
    expect(getWindDownState().dismissedSessionId).toBe(session.id);

    await resetWindDownForStreamEnd();

    expect(getWindDownState().dismissedSessionId).toBeNull();
  });

  test('a Twitch failure from the applier still clears the state row', async () => {
    setWindDownTitleApplier(async () => { throw new Error('Twitch is down'); });
    getOrStartStreamSession('test-reset-c', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownBaseTitle('Modding Skyrim');

    await resetWindDownForStreamEnd();

    expect(getWindDownState().active).toBe(false);
  });

  test('does nothing harmful when no applier is registered', async () => {
    getOrStartStreamSession('test-reset-d', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    await expect(resetWindDownForStreamEnd()).resolves.toBeUndefined();
    expect(getWindDownState().active).toBe(false);
  });
});

// Finding 3: a failed restore write used to be indistinguishable from a successful
// one — resetWindDownForStreamEnd wiped baseTitle unconditionally, so a transient
// Twitch failure welded the suffix on forever and a redelivered stream.offline (which
// just calls this again) saw baseTitle already null and no-opped instead of retrying.
describe('resetWindDownForStreamEnd preserves state on a failed restore (Finding 3)', () => {
  test('a failed restore keeps the base title instead of wiping it', async () => {
    setWindDownTitleApplier(async () => { throw new Error('Twitch is down'); });
    getOrStartStreamSession('test-reset-e', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownBaseTitle('Modding Skyrim');

    await resetWindDownForStreamEnd();

    expect(getWindDownState().active).toBe(false);
    // The write never landed — wiping this would leave the suffix stuck on the
    // title with nothing left able to recover it.
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
  });

  // The other half: once the applier actually succeeds, the failed-restore fields
  // must still clear — this ISN'T a "never clear on this path" fix.
  test('a successful restore still clears the base title', async () => {
    setWindDownTitleApplier(async () => {});
    getOrStartStreamSession('test-reset-f', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownBaseTitle('Modding Skyrim');

    await resetWindDownForStreamEnd();

    expect(getWindDownState().active).toBe(false);
    expect(getWindDownState().baseTitle).toBeNull();
  });
});
