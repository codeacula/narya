import { describe, expect, test } from 'bun:test';
import { evaluateAdSchedule, type AdScheduleTracker } from './automaticAds';
import type { AdSchedule, StreamActivityStatus } from './runtime';

const NOW = 1_000_000_000_000;

function liveStream(overrides: Partial<StreamActivityStatus> = {}): StreamActivityStatus {
  return {
    streamActive: true,
    uptimeSeconds: 3600,
    streamStartedAt: new Date(NOW - 3_600_000).toISOString(),
    uptimeSource: 'twitch',
    viewerCount: 10,
    ...overrides,
  };
}

function schedule(overrides: Partial<AdSchedule> = {}): AdSchedule {
  return {
    adScheduleStatus: 'available',
    adScheduleError: null,
    nextAdAt: null,
    lastAdAt: null,
    adBreakDurationSeconds: 180,
    prerollFreeTimeSeconds: null,
    snoozeCount: null,
    snoozeRefreshAt: null,
    ...overrides,
  };
}

const freshTracker: AdScheduleTracker = {
  lastCompletedDeadline: null,
  trackedPrerollDeadlineMs: null,
  firstObservation: true,
};

describe('evaluateAdSchedule', () => {
  test('skips and marks a past deadline observed at boot (A13)', () => {
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ nextAdAt: new Date(NOW - 60_000).toISOString() }),
      tracker: freshTracker,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('stale_at_boot');
    expect(decision.nextTracker.firstObservation).toBe(false);
    expect(decision.nextTracker.lastCompletedDeadline).toBe(`scheduled:${new Date(NOW - 60_000).toISOString()}`);
  });

  test('runs when a past deadline passes after boot', () => {
    const nextAdAt = new Date(NOW - 60_000).toISOString();
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ nextAdAt }),
      tracker: { lastCompletedDeadline: null, trackedPrerollDeadlineMs: null, firstObservation: false },
    });
    expect(decision.action).toBe('run');
    expect(decision.reason).toBe(`scheduled:${nextAdAt}`);
  });

  test('does not run twice for the same completed deadline key', () => {
    const nextAdAt = new Date(NOW - 60_000).toISOString();
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ nextAdAt }),
      tracker: { lastCompletedDeadline: `scheduled:${nextAdAt}`, trackedPrerollDeadlineMs: null, firstObservation: false },
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('already_completed');
  });

  test('skips a future deadline and clears the first-observation flag', () => {
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ nextAdAt: new Date(NOW + 300_000).toISOString() }),
      tracker: freshTracker,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('deadline_future');
    expect(decision.nextTracker.firstObservation).toBe(false);
  });

  test('anchors the preroll deadline and re-anchors only on >15s drift', () => {
    const first = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ prerollFreeTimeSeconds: 600 }),
      tracker: { lastCompletedDeadline: null, trackedPrerollDeadlineMs: null, firstObservation: false },
    });
    const anchored = NOW + 600_000;
    expect(first.nextTracker.trackedPrerollDeadlineMs).toBe(anchored);

    // A small drift (<=15s) keeps the original anchor.
    const smallDrift = evaluateAdSchedule({
      now: NOW + 5_000,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ prerollFreeTimeSeconds: 595 }),
      tracker: first.nextTracker,
    });
    expect(smallDrift.nextTracker.trackedPrerollDeadlineMs).toBe(anchored);

    // A large drift (>15s) re-anchors.
    const largeDrift = evaluateAdSchedule({
      now: NOW + 60_000,
      adBreakEndsAt: null,
      streamStatus: liveStream(),
      adSchedule: schedule({ prerollFreeTimeSeconds: 600 }),
      tracker: first.nextTracker,
    });
    expect(largeDrift.nextTracker.trackedPrerollDeadlineMs).toBe(NOW + 60_000 + 600_000);
  });

  test('clears the tracked preroll deadline when the stream goes offline', () => {
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: null,
      streamStatus: liveStream({ streamActive: false }),
      adSchedule: schedule({ prerollFreeTimeSeconds: 600 }),
      tracker: { lastCompletedDeadline: null, trackedPrerollDeadlineMs: NOW + 600_000, firstObservation: false },
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('stream_offline');
    expect(decision.nextTracker.trackedPrerollDeadlineMs).toBeNull();
  });

  test('skips while an ad break is still active', () => {
    const decision = evaluateAdSchedule({
      now: NOW,
      adBreakEndsAt: new Date(NOW + 60_000).toISOString(),
      streamStatus: liveStream(),
      adSchedule: schedule({ nextAdAt: new Date(NOW - 60_000).toISOString() }),
      tracker: { lastCompletedDeadline: null, trackedPrerollDeadlineMs: null, firstObservation: false },
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('ad_break_active');
  });
});
