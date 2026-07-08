import { describe, expect, test } from 'bun:test';
import { getAutomodQueue } from './automod';
import { db } from './db';
import { handleEventSubNotification } from './eventsub';
import { RuntimeState } from './runtime';

function latestEventFor(actor: string): { kind: string; detail: string; tone: string } | null {
  return db.prepare('select kind, detail, tone from stream_events where actor = ? order by received_at desc limit 1')
    .get(actor) as { kind: string; detail: string; tone: string } | null;
}

function countEventsFor(actor: string): number {
  return (db.prepare('select count(*) as c from stream_events where actor = ?').get(actor) as { c: number }).c;
}

describe('handleEventSubNotification', () => {
  test('channel.follow records a follow event', async () => {
    const actor = `follower-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.follow', { user_name: actor });
    expect(latestEventFor(actor)).toMatchObject({ kind: 'follow', detail: 'followed' });
  });

  test('channel.subscribe records a sub event', async () => {
    const actor = `sub-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { user_name: actor, tier: '1000', is_gift: false });
    const row = latestEventFor(actor);
    expect(row?.kind).toBe('sub');
    expect(row?.detail).toContain('subscribed');
  });

  test('channel.subscribe skips gifted subs (avoids double-count with the gift event)', async () => {
    const actor = `gifted-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { user_name: actor, tier: '1000', is_gift: true });
    expect(countEventsFor(actor)).toBe(0);
  });

  test('channel.subscription.message records a resub with month count', async () => {
    const actor = `resub-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', {
      user_name: actor, tier: '2000', cumulative_months: 7,
    });
    const row = latestEventFor(actor);
    expect(row?.kind).toBe('sub');
    expect(row?.detail).toContain('resubscribed');
    expect(row?.detail).toContain('7 months');
  });

  test('channel.cheer records a cheer event', async () => {
    const actor = `cheerer-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.cheer', { user_name: actor, bits: 500 });
    expect(latestEventFor(actor)).toMatchObject({ kind: 'cheer', detail: 'cheered 500 bits' });
  });

  test('channel.raid records a raid event with viewer count', async () => {
    const actor = `raider-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'channel.raid', { from_broadcaster_user_name: actor, viewers: 42 });
    expect(latestEventFor(actor)).toMatchObject({ kind: 'raid', detail: 'raided with 42 viewers' });
  });

  test('channel.ad_break.begin sets adBreakEndsAt and clears the schedule cache', async () => {
    const state = new RuntimeState();
    state.twitchAdScheduleCache = { expiresAtMs: Date.now() + 60_000, schedule: {} as never };
    const startedAt = '2026-07-07T12:00:00.000Z';
    await handleEventSubNotification(state, 'channel.ad_break.begin', { duration_seconds: 137, started_at: startedAt });
    expect(state.adBreakEndsAt).toBe('2026-07-07T12:02:17.000Z');
    expect(state.twitchAdScheduleCache).toBeNull();
    const row = db.prepare("select kind from stream_events where detail = 'ad break · 137s' limit 1").get() as { kind: string } | null;
    expect(row?.kind).toBe('ad_break');
  });

  test('stream.offline clears the Twitch caches', async () => {
    const state = new RuntimeState();
    state.twitchStreamStatusCache = { expiresAtMs: Date.now() + 60_000, status: {} as never };
    await handleEventSubNotification(state, 'stream.offline', {});
    expect(state.twitchStreamStatusCache).toBeNull();
  });

  test('automod.message.hold records a pending held message', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      broadcaster_user_login: 'codeacula',
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'this is a held message' },
      held_at: '2026-07-08T12:00:00.000Z',
      reason: 'automod',
      automod: { category: 'profanity', level: 2 },
    });
    const queue = getAutomodQueue();
    const held = queue.pending.find(h => h.id === messageId);
    expect(held).toMatchObject({
      username: 'testviewer',
      displayName: 'TestViewer',
      message: 'this is a held message',
      category: 'profanity',
      level: 2,
      resolution: null,
    });
  });

  test('automod.message.update resolves a held message', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'another held message' },
      held_at: '2026-07-08T12:00:00.000Z',
      reason: 'automod',
      automod: { category: 'profanity', level: 1 },
    });
    await handleEventSubNotification(new RuntimeState(), 'automod.message.update', {
      message_id: messageId,
      status: 'Approved',
      moderator_user_name: 'SomeMod',
    });
    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === messageId)).toBe(false);
    const resolved = queue.recentlyResolved.find(h => h.id === messageId);
    expect(resolved).toMatchObject({ resolution: 'allowed', resolvedBy: 'SomeMod' });
  });
});
