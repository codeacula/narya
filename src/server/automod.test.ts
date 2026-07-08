import { describe, expect, test } from 'bun:test';
import {
  getAutomodQueue,
  recordAutomodHold,
  resolveAutomodHold,
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
});
