import { describe, expect, test } from 'bun:test';
import type { Chatter } from '../../shared/api';
import { belongsToCurrentSession, mergeRecentChatters, sessionBoundaryIndex } from './panels';

describe('belongsToCurrentSession', () => {
  test('a row from the live session is current', () => {
    expect(belongsToCurrentSession('live', 'live')).toBe(true);
  });

  test('a row from an earlier session is past', () => {
    expect(belongsToCurrentSession('old', 'live')).toBe(false);
  });

  test('a row recorded off-stream is past', () => {
    expect(belongsToCurrentSession(null, 'live')).toBe(false);
    expect(belongsToCurrentSession(undefined, 'live')).toBe(false);
  });

  test('with no stream live, nothing is current', () => {
    expect(belongsToCurrentSession('live', null)).toBe(false);
    expect(belongsToCurrentSession(null, null)).toBe(false);
  });
});

// Chat renders oldest-first and marks where this stream begins.
describe('sessionBoundaryIndex, chat', () => {
  const opts = { side: 'current' as const, markListStart: false };

  test('marks the first message of this stream', () => {
    const rows = [{ sessionId: 'old' }, { sessionId: 'old' }, { sessionId: 'live' }, { sessionId: 'live' }];
    expect(sessionBoundaryIndex(rows, 'live', opts)).toBe(2);
  });

  // A whisper carries no session, so it must not read as a session change.
  test('a whisper mid-stream does not start a new boundary', () => {
    const rows = [
      { sessionId: 'live' },
      { sessionless: true },
      { sessionId: 'live' },
    ];
    expect(sessionBoundaryIndex(rows, 'live', opts)).toBe(-1);
  });

  test('a whisper does not hide a real boundary', () => {
    const rows = [
      { sessionId: 'old' },
      { sessionless: true },
      { sessionId: 'live' },
    ];
    expect(sessionBoundaryIndex(rows, 'live', opts)).toBe(2);
  });

  test('chat that opens in the current session has nothing above it to divide from', () => {
    expect(sessionBoundaryIndex([{ sessionId: 'live' }, { sessionId: 'live' }], 'live', opts)).toBe(-1);
  });

  test('a leading whisper does not turn the first message into a boundary', () => {
    const rows = [{ sessionless: true }, { sessionId: 'live' }];
    expect(sessionBoundaryIndex(rows, 'live', opts)).toBe(-1);
  });

  test('off-stream there is no boundary', () => {
    expect(sessionBoundaryIndex([{ sessionId: 'old' }], null, opts)).toBe(-1);
  });
});

// The "viewers" tab shows Twitch's presence list, which lags brand-new arrivals.
// mergeRecentChatters folds in people who just chatted so they show immediately.
describe('mergeRecentChatters', () => {
  const chatter = (login: string, id = login): Chatter => ({ userId: id, userLogin: login, userName: login });
  const recent = (login: string, at: number) => ({ chatter: chatter('chat:' + login, 'chat:' + login), at });
  const NOW = 1_000_000;
  const TTL = 5 * 60_000;

  test('a fresh chatter absent from Twitch presence is folded in', () => {
    const merged = mergeRecentChatters([chatter('alice')], [recent('bob', NOW)], NOW, TTL);
    expect(merged.map(c => c.userLogin).sort()).toEqual(['alice', 'chat:bob']);
  });

  test('a chatter Twitch already lists is not duplicated, and Twitch\'s row wins', () => {
    // Same login in both; the presence row (real userId) must be the one kept.
    const merged = mergeRecentChatters(
      [chatter('bob', '12345')],
      [{ chatter: chatter('bob', 'chat:bob'), at: NOW }],
      NOW,
      TTL,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].userId).toBe('12345');
  });

  test('login match is case-insensitive so a cased display login does not double a row', () => {
    const merged = mergeRecentChatters(
      [chatter('Bob', '12345')],
      [{ chatter: chatter('bob', 'chat:bob'), at: NOW }],
      NOW,
      TTL,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].userId).toBe('12345');
  });

  test('a chat sender older than the TTL has aged out and is dropped', () => {
    const merged = mergeRecentChatters([chatter('alice')], [recent('bob', NOW - TTL - 1)], NOW, TTL);
    expect(merged.map(c => c.userLogin)).toEqual(['alice']);
  });

  test('an empty presence list still surfaces recent chatters', () => {
    const merged = mergeRecentChatters([], [recent('bob', NOW)], NOW, TTL);
    expect(merged.map(c => c.userLogin)).toEqual(['chat:bob']);
  });
});

// The event feed renders newest-first and heads the past-stream rows.
describe('sessionBoundaryIndex, events', () => {
  const opts = { side: 'past' as const, markListStart: true };

  test('marks the first row from an earlier stream', () => {
    const rows = [{ sessionId: 'live' }, { sessionId: 'old' }, { sessionId: null }];
    expect(sessionBoundaryIndex(rows, 'live', opts)).toBe(1);
  });

  test('a wholly-past list is headed at the top', () => {
    expect(sessionBoundaryIndex([{ sessionId: 'old' }, { sessionId: 'old' }], 'live', opts)).toBe(0);
  });

  test('a wholly-current list has no boundary', () => {
    expect(sessionBoundaryIndex([{ sessionId: 'live' }], 'live', opts)).toBe(-1);
  });
});
