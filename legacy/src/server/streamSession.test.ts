import { describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  getActiveStreamSession,
  getOrStartStreamSession,
  hasSeenChatterBefore,
  recordCurrentSessionChatter,
} from './streamSession';

function uniqueSource() {
  return `test-source-${crypto.randomUUID()}`;
}

describe('getOrStartStreamSession', () => {
  test('is idempotent for the same source', () => {
    const source = uniqueSource();
    const first = getOrStartStreamSession(source, new Date().toISOString());
    const second = getOrStartStreamSession(source, new Date().toISOString());
    expect(second.id).toBe(first.id);
  });

  test('a new source ends the previous active session', () => {
    const a = getOrStartStreamSession(uniqueSource(), new Date().toISOString());
    const b = getOrStartStreamSession(uniqueSource(), new Date().toISOString());
    expect(b.id).not.toBe(a.id);
    expect(getActiveStreamSession()?.id).toBe(b.id);
  });
});

describe('recordCurrentSessionChatter', () => {
  test('flags the first message of a login in the session and not repeats', () => {
    getOrStartStreamSession(uniqueSource(), new Date().toISOString());
    const login = `viewer-${crypto.randomUUID()}`;
    const first = recordCurrentSessionChatter(login, crypto.randomUUID(), new Date().toISOString());
    expect(first.isFirstInSession).toBe(true);
    const second = recordCurrentSessionChatter(login, crypto.randomUUID(), new Date().toISOString());
    expect(second.isFirstInSession).toBe(false);
  });
});

describe('hasSeenChatterBefore', () => {
  test('reads presence from the chatters table (case-insensitive)', () => {
    const login = `seen-${crypto.randomUUID()}`.toLowerCase();
    expect(hasSeenChatterBefore(login)).toBe(false);
    db.prepare('insert into chatters (login, first_seen_at, message_count) values (?, ?, 1)')
      .run(login, new Date().toISOString());
    expect(hasSeenChatterBefore(login)).toBe(true);
    expect(hasSeenChatterBefore(login.toUpperCase())).toBe(true);
  });
});
