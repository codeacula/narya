import { describe, expect, test } from 'bun:test';
import {
  connectionsFreshness,
  connectionsFreshnessNote,
  connectionsRailWarning,
  eventSubBadge,
  eventSubSummary,
} from './connectionCopy';

/** The words the connected/offline vocabulary (connectionWords.ts) retired. */
const RETIRED = /unavailable|disconnected|not connected/i;

const signedIn = {
  twitchAuthenticated: true,
  twitchMissingScopes: [] as string[],
  eventSubConnected: true,
  eventSubFailedSubscriptions: [] as string[],
};

describe('Connections settings wording', () => {
  test('EventSub down is "offline" on the row, its badge and the rail', () => {
    const down = { ...signedIn, eventSubConnected: false };
    expect(eventSubBadge(down)).toBe('Offline');
    expect(eventSubSummary(down)).toMatch(/^Offline\./);
    expect(connectionsRailWarning(down)).toBe('Twitch EventSub offline');
    for (const text of [eventSubBadge(down), eventSubSummary(down), connectionsRailWarning(down) ?? '']) {
      expect(text).not.toMatch(RETIRED);
    }
  });

  test('signed out of Twitch says offline, and why', () => {
    const out = { ...signedIn, twitchAuthenticated: false, eventSubConnected: false };
    expect(connectionsRailWarning(out)).toBe('Twitch offline: not signed in');
  });

  test('refused subscriptions are degraded, and named', () => {
    const degraded = { ...signedIn, eventSubFailedSubscriptions: ['channel.follow'] };
    expect(eventSubBadge(degraded)).toBe('Degraded');
    expect(eventSubSummary(degraded)).toContain('channel.follow');
    expect(connectionsRailWarning(degraded)).toContain('channel.follow');
  });

  test('all well is connected, with nothing on the rail', () => {
    expect(eventSubBadge(signedIn)).toBe('Connected');
    expect(connectionsRailWarning(signedIn)).toBeNull();
  });
});

/** The placeholder status the dashboard holds before the first one arrives. */
const placeholder = {
  twitchAuthenticated: false,
  twitchMissingScopes: [] as string[],
  eventSubConnected: false,
  eventSubFailedSubscriptions: [] as string[],
};

describe('Connections settings before and without a fresh status', () => {
  test('freshness follows whether a status arrived and whether Narya answers', () => {
    expect(connectionsFreshness({ known: false, stale: false })).toBe('unknown');
    expect(connectionsFreshness({ known: false, stale: true })).toBe('unknown');
    expect(connectionsFreshness({ known: true, stale: true })).toBe('stale');
    expect(connectionsFreshness({ known: true, stale: false })).toBe('fresh');
  });

  // The placeholder says "not signed in" and "offline"; nobody has reported either.
  test('before the first status, nothing is stated as offline or signed out', () => {
    expect(connectionsRailWarning(placeholder, 'unknown')).toBeNull();
    expect(eventSubBadge(placeholder, 'unknown')).toBe('Unknown');
    expect(eventSubSummary(placeholder, 'unknown')).not.toMatch(/offline/i);
    expect(connectionsFreshnessNote('unknown')).toMatch(/waiting/i);
  });

  test('while Narya is not answering, the rail marks its warning as last known', () => {
    expect(connectionsRailWarning(placeholder, 'stale')).toBe('Twitch offline: not signed in (last known)');
    expect(connectionsRailWarning(signedIn, 'stale')).toBeNull();
    expect(connectionsFreshnessNote('stale')).toMatch(/last known/);
  });

  test('a fresh status needs no note', () => {
    expect(connectionsFreshnessNote('fresh')).toBeNull();
  });
});
