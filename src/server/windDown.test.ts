import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getOrStartStreamSession, setPlannedStreamEnd } from './streamSession';
import {
  getWindDownPublicState,
  getWindDownSettings,
  getWindDownState,
  rebaseWindDownTitle,
  saveWindDownSettings,
  setWindDownActive,
  setWindDownBaseTitle,
} from './windDown';

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
});

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
