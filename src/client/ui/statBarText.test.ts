import { describe, expect, test } from 'bun:test';
import { UNKNOWN_VALUE, adGaugeSub, healthGauge, statusIsStale, viewersGauge } from './statBarText';

const adBase = {
  mode: null,
  adScheduleStatus: 'available' as const,
  adScheduleError: null,
  adBreakDurationSeconds: null,
  snoozeCount: null,
};

/** Every sub-line the stat bar can show is held to the same rule. */
function expectPlainWords(text: string) {
  expect(text).not.toContain('N/A');
  expect(text).not.toMatch(/^Status:/);
  expect(text.length).toBeGreaterThan(0);
}

describe('adGaugeSub', () => {
  test('a countdown says what it is counting toward', () => {
    expect(adGaugeSub({ ...adBase, mode: 'active' }).text).toBe('ads running');
    expect(adGaugeSub({ ...adBase, mode: 'preroll' }).text).toBe('pre-roll off');
    expect(adGaugeSub({ ...adBase, mode: 'next', adBreakDurationSeconds: 180, snoozeCount: 1 }).text)
      .toBe('next ad scheduled · 3m break · 1 snooze');
    expect(adGaugeSub({ ...adBase, mode: 'next', adBreakDurationSeconds: 30, snoozeCount: 2 }).text)
      .toBe('next ad scheduled · 30s break · 2 snoozes');
  });

  test('a readable schedule with nothing on it says so', () => {
    expect(adGaugeSub(adBase)).toEqual({ text: 'no ad scheduled' });
  });

  test('each unknown state names its reason, with the server detail on hover', () => {
    const notConfigured = adGaugeSub({ ...adBase, adScheduleStatus: 'not_configured', adScheduleError: 'Twitch user authentication is required.' });
    expect(notConfigured.text).toBe('sign in to Twitch to see ads');
    expect(notConfigured.title).toBe('Twitch user authentication is required.');
    expect(adGaugeSub({ ...adBase, adScheduleStatus: 'missing_scope' }).text).toBe('reconnect Twitch to see ads');
    expect(adGaugeSub({ ...adBase, adScheduleStatus: 'unauthorized' }).text).toBe('Twitch refused the ad schedule');
  });

  test('an unreadable schedule keeps the raw error off the gauge', () => {
    const sub = adGaugeSub({ ...adBase, adScheduleStatus: 'unavailable', adScheduleError: 'Could not resolve broadcaster ID for "x".' });
    expect(sub.text).toBe('ad schedule unavailable');
    expect(sub.title).toBe('Could not resolve broadcaster ID for "x".');
  });

  test('no sub-line uses N/A or a Status: prefix', () => {
    for (const adScheduleStatus of ['available', 'not_configured', 'missing_scope', 'unauthorized', 'unavailable'] as const) {
      for (const mode of [null, 'active', 'next', 'preroll'] as const) {
        expectPlainWords(adGaugeSub({ ...adBase, adScheduleStatus, mode }).text);
      }
    }
  });
});

describe('viewersGauge', () => {
  test('a known count reads as the number', () => {
    expect(viewersGauge(12, true)).toEqual({ value: '12', sub: 'concurrent viewers' });
    expect(viewersGauge(0, true)).toEqual({ value: '0', sub: 'concurrent viewers' });
  });

  test('an unknown count is a dash with its reason', () => {
    expect(viewersGauge(null, false)).toEqual({ value: UNKNOWN_VALUE, sub: 'stream offline' });
    expect(viewersGauge(null, null)).toEqual({ value: UNKNOWN_VALUE, sub: 'Twitch viewer count unavailable' });
    expect(viewersGauge(null, true)).toEqual({ value: UNKNOWN_VALUE, sub: 'Twitch viewer count unavailable' });
  });
});

describe('healthGauge', () => {
  const healthBase = { obsConnected: true, bitrateKbps: 6000, totalFrames: 1000, droppedFrames: 5, laggedFrames: 2 };

  test('a live reading shows bitrate, drops and lag', () => {
    expect(healthGauge(healthBase)).toEqual({
      value: '6000',
      unit: ' kbps',
      sub: 'drop: 5 (0.50%) · lag: 2 frames',
    });
  });

  test('OBS down is a dash and says OBS is offline', () => {
    expect(healthGauge({ ...healthBase, obsConnected: false, bitrateKbps: null })).toEqual({
      value: UNKNOWN_VALUE,
      unit: '',
      sub: 'OBS offline',
    });
  });

  test('OBS up but idle is a dash and says it is not streaming', () => {
    // The shape a connected, idle OBS really sends: GetStreamStatus still reports
    // outputSkippedFrames as a number and GetStats a render-lag count, but obs.ts
    // only derives a bitrate while outputActive is true.
    expect(healthGauge({ ...healthBase, bitrateKbps: null, droppedFrames: 0, laggedFrames: 3 })).toEqual({
      value: UNKNOWN_VALUE,
      unit: '',
      sub: 'not streaming',
    });
  });

  test('an unknown lag count inside a reading is a dash, not N/A', () => {
    const sub = healthGauge({ ...healthBase, laggedFrames: null }).sub;
    expect(sub).toBe(`drop: 5 (0.50%) · lag: ${UNKNOWN_VALUE}`);
    expectPlainWords(sub);
  });

  test('zero total frames does not divide by zero', () => {
    expect(healthGauge({ ...healthBase, totalFrames: 0, droppedFrames: 0 }).sub).toBe('drop: 0 (0.00%) · lag: 2 frames');
  });
});

describe('statusIsStale', () => {
  // The bug: with the backend down the bar kept saying "events connected" and a live
  // uptime, because only the chat word was reset on a failed refresh.
  test('a dropped socket makes every reading last-known', () => {
    expect(statusIsStale({ socket: 'closed', refreshFailed: false })).toBe(true);
  });

  test('a failed refresh with no status since is stale', () => {
    expect(statusIsStale({ socket: 'open', refreshFailed: true })).toBe(true);
  });

  test('an open socket with a good refresh is fresh, and so is the first connect', () => {
    expect(statusIsStale({ socket: 'open', refreshFailed: false })).toBe(false);
    expect(statusIsStale({ socket: 'connecting', refreshFailed: false })).toBe(false);
  });
});
