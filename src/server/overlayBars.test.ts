import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getLatestEvents, getOverlayStreamSession } from './overlayBars';
import { endActiveStreamSession, getOrStartStreamSession } from './streamSession';

function insertEvent(kind: string, actor: string, receivedAt: string, opts: { amount?: number | null; sessionId?: string | null } = {}) {
  db.prepare(`
    insert into stream_events (id, kind, actor, detail, tone, received_at, session_id, actor_login, amount)
    values (?, ?, ?, 'detail', 'silver', ?, ?, ?, ?)
  `).run(crypto.randomUUID(), kind, actor, receivedAt, opts.sessionId ?? null, actor.toLowerCase(), opts.amount ?? null);
}

beforeEach(() => {
  db.exec('delete from stream_events');
  endActiveStreamSession();
});

describe('getLatestEvents', () => {
  test('is all null on a fresh install', () => {
    expect(getLatestEvents()).toEqual({ follow: null, sub: null, cheer: null, raid: null });
  });

  test('returns the latest ever, across sessions', () => {
    insertEvent('follow', 'OldFollower', '2026-01-01T00:00:00.000Z', { sessionId: 'session-a' });
    insertEvent('follow', 'NewFollower', '2026-02-01T00:00:00.000Z', { sessionId: 'session-b' });
    insertEvent('follow', 'MiddleFollower', '2026-01-15T00:00:00.000Z', { sessionId: 'session-a' });
    // No active session at all — the bar must still be populated.
    expect(getLatestEvents().follow).toEqual({ name: 'NewFollower', amount: null });
  });

  test('sub is the most recent of sub or gift, name only', () => {
    insertEvent('sub', 'Subber', '2026-03-01T00:00:00.000Z');
    insertEvent('gift', 'Gifter', '2026-03-02T00:00:00.000Z', { amount: 5 });
    expect(getLatestEvents().sub).toEqual({ name: 'Gifter', amount: null });

    insertEvent('sub', 'LaterSubber', '2026-03-03T00:00:00.000Z');
    expect(getLatestEvents().sub).toEqual({ name: 'LaterSubber', amount: null });
  });

  test('cheer and raid carry their amounts', () => {
    insertEvent('cheer', 'Cheerer', '2026-03-01T00:00:00.000Z', { amount: 250 });
    insertEvent('raid', 'RaidingChannel', '2026-03-01T00:00:00.000Z', { amount: 42 });
    const latest = getLatestEvents();
    expect(latest.cheer).toEqual({ name: 'Cheerer', amount: 250 });
    expect(latest.raid).toEqual({ name: 'RaidingChannel', amount: 42 });
  });

  test('rows predating the amount column read as just a name', () => {
    insertEvent('cheer', 'LegacyCheerer', '2026-03-01T00:00:00.000Z', { amount: null });
    expect(getLatestEvents().cheer).toEqual({ name: 'LegacyCheerer', amount: null });
  });

  test('ignores kinds the bar does not show', () => {
    insertEvent('redeem', 'Redeemer', '2026-03-01T00:00:00.000Z');
    insertEvent('ad_break', 'Twitch', '2026-03-01T00:00:00.000Z');
    expect(getLatestEvents()).toEqual({ follow: null, sub: null, cheer: null, raid: null });
  });

  // The overlay role can read this; ids, logins, details and session ids must not leak.
  test('exposes only the declared fields', () => {
    insertEvent('follow', 'F', '2026-03-01T00:00:00.000Z', { sessionId: 'secret-session' });
    insertEvent('sub', 'S', '2026-03-01T00:00:00.000Z', { sessionId: 'secret-session' });
    insertEvent('cheer', 'C', '2026-03-01T00:00:00.000Z', { amount: 1, sessionId: 'secret-session' });
    insertEvent('raid', 'R', '2026-03-01T00:00:00.000Z', { amount: 1, sessionId: 'secret-session' });
    const latest = getLatestEvents();
    expect(Object.keys(latest).sort()).toEqual(['cheer', 'follow', 'raid', 'sub']);
    for (const entry of Object.values(latest)) {
      expect(Object.keys(entry!).sort()).toEqual(['amount', 'name']);
    }
    expect(JSON.stringify(latest)).not.toContain('secret-session');
  });
});

describe('getOverlayStreamSession', () => {
  test('is null off-stream and carries only startedAt while live', () => {
    expect(getOverlayStreamSession()).toEqual({ startedAt: null });
    const startedAt = '2026-03-01T12:00:00.000Z';
    getOrStartStreamSession(`test-source-${crypto.randomUUID()}`, startedAt);
    expect(getOverlayStreamSession()).toEqual({ startedAt });
    endActiveStreamSession();
    expect(getOverlayStreamSession()).toEqual({ startedAt: null });
  });
});
