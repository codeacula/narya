import { describe, expect, test } from 'bun:test';
import {
  getAutomodHold,
  getAutomodQueue,
  recordAutomodHold,
  resolveAutomodHold,
  sweepExpiredHolds,
} from './automod';

function sampleHold(overrides: Partial<Parameters<typeof recordAutomodHold>[0]> = {}) {
  const id = `hold-${crypto.randomUUID()}`;
  return {
    id,
    channel: 'codeacula',
    username: 'testviewer',
    displayName: 'TestViewer',
    message: 'this message was held',
    category: 'profanity',
    level: 2,
    heldAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('recordAutomodHold', () => {
  test('inserts a pending hold that shows up in the queue', () => {
    const hold = sampleHold();
    const recorded = recordAutomodHold(hold);
    expect(recorded.id).toBe(hold.id);
    expect(recorded.resolvedAt).toBeNull();
    expect(recorded.resolution).toBeNull();

    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(true);
  });

  test('re-recording an already-resolved id (EventSub redelivery) does not reopen it', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);
    resolveAutomodHold(hold.id, 'allowed', 'You');

    const redelivered = recordAutomodHold(hold);
    expect(redelivered.resolution).toBe('allowed');
    expect(redelivered.resolvedBy).toBe('You');

    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(false);
  });
});

describe('resolveAutomodHold', () => {
  test('marks a pending hold as resolved and moves it out of pending', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    const resolved = resolveAutomodHold(hold.id, 'allowed', 'You');
    expect(resolved?.resolution).toBe('allowed');
    expect(resolved?.resolvedBy).toBe('You');
    expect(resolved?.resolvedAt).not.toBeNull();

    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(false);
    expect(queue.recentlyResolved.some(h => h.id === hold.id)).toBe(true);
  });

  test('is idempotent — a second resolve call does not overwrite the first', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    resolveAutomodHold(hold.id, 'allowed', 'You');
    const secondAttempt = resolveAutomodHold(hold.id, 'denied', 'AutoMod');

    // The row itself is still 'allowed' by 'You' — the second call was a no-op.
    expect(secondAttempt?.resolution).toBe('allowed');
    expect(secondAttempt?.resolvedBy).toBe('You');
  });

  test('resolving an unknown id returns null', () => {
    const result = resolveAutomodHold(`missing-${crypto.randomUUID()}`, 'denied', null);
    expect(result).toBeNull();
  });

  test('an authoritative result replaces a provisional expiry', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    // Provisional: our sweep (or Twitch reporting the hold gone) guessed it aged out.
    resolveAutomodHold(hold.id, 'expired', null);
    expect(getAutomodHold(hold.id)?.resolution).toBe('expired');

    // Twitch then tells us what actually happened.
    const resolved = resolveAutomodHold(hold.id, 'allowed', 'ModFriend', { authoritative: true });
    expect(resolved?.resolution).toBe('allowed');
    expect(resolved?.resolvedBy).toBe('ModFriend');
    expect(getAutomodHold(hold.id)?.resolution).toBe('allowed');
  });

  test('an authoritative result does not overwrite another authoritative result', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    resolveAutomodHold(hold.id, 'allowed', 'You', { authoritative: true });
    const second = resolveAutomodHold(hold.id, 'denied', 'ModFriend', { authoritative: true });

    expect(second?.resolution).toBe('allowed');
    expect(second?.resolvedBy).toBe('You');
  });

  test('a provisional expiry does not overwrite an authoritative result', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    resolveAutomodHold(hold.id, 'allowed', 'You', { authoritative: true });
    resolveAutomodHold(hold.id, 'expired', null);

    expect(getAutomodHold(hold.id)?.resolution).toBe('allowed');
  });
});

describe('getAutomodQueue pending cap', () => {
  test('keeps the newest holds when more are pending than the cap allows', () => {
    // 210 holds, oldest first, all inside the sweep window.
    const base = Date.now() - 60 * 60 * 1000;
    const ids: string[] = [];
    for (let i = 0; i < 210; i++) {
      const hold = sampleHold({ heldAt: new Date(base + i * 1000).toISOString() });
      recordAutomodHold(hold);
      ids.push(hold.id);
    }

    const pending = getAutomodQueue().pending.filter(h => ids.includes(h.id));
    const newest = ids[ids.length - 1];

    // The newest hold is the one a moderator most needs during a spam wave; a
    // naive `order by held_at asc limit N` dropped exactly that one.
    expect(pending.some(h => h.id === newest)).toBe(true);
    expect(pending.length).toBeLessThanOrEqual(200);

    // Still oldest-first for display.
    const heldAts = pending.map(h => h.heldAt);
    expect([...heldAts].sort()).toEqual(heldAts);
  });
});

describe('sweepExpiredHolds', () => {
  test('expires a long-pending hold and drops it from the pending queue', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const hold = sampleHold({ heldAt: threeHoursAgo });
    recordAutomodHold(hold);

    // getAutomodQueue sweeps first, so a stale hold is gone from pending.
    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(false);
    expect(getAutomodHold(hold.id)?.resolution).toBe('expired');
  });

  test('leaves a freshly-held hold pending', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    sweepExpiredHolds();
    expect(getAutomodHold(hold.id)?.resolvedAt).toBeNull();
  });
});
