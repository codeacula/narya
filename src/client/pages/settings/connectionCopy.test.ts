import { describe, expect, test } from 'bun:test';
import { connectionsRailWarning, eventSubBadge, eventSubSummary } from './connectionCopy';

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
