import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  endActiveStreamSession,
  getActiveStreamSession,
  getOrStartStreamSession,
  getPlannedStreamEnd,
  hasSeenChatterBefore,
  recordCurrentSessionChatter,
  setPlannedStreamEnd,
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

describe('planned stream end', () => {
  beforeEach(() => {
    db.exec('delete from stream_session_chatters');
    db.exec('delete from stream_sessions');
  });

  test('a new session has no planned end', () => {
    getOrStartStreamSession('test-a', '2026-07-19T18:00:00.000Z');
    expect(getPlannedStreamEnd()).toBeNull();
    expect(getActiveStreamSession()?.plannedEndAt).toBeNull();
  });

  test('stores and reads back a planned end', () => {
    const session = getOrStartStreamSession('test-b', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    expect(getPlannedStreamEnd()).toBe('2026-07-19T21:00:00.000Z');
  });

  test('clears a planned end', () => {
    const session = getOrStartStreamSession('test-c', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    setPlannedStreamEnd(session.id, null);
    expect(getPlannedStreamEnd()).toBeNull();
  });

  // The plan belongs to one stream. Ending the session must not leak it into the next.
  test('a planned end does not survive the session ending', () => {
    const session = getOrStartStreamSession('test-d', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    endActiveStreamSession('2026-07-19T21:30:00.000Z');
    expect(getPlannedStreamEnd()).toBeNull();
  });

  test('off-stream, there is no planned end to read', () => {
    expect(getPlannedStreamEnd()).toBeNull();
  });
});
