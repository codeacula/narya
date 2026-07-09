import { beforeEach, describe, expect, test } from 'bun:test';
import { getAutomodQueue } from './automod';
import { db } from './db';
import { handleEventSubNotification, resetSubMergeState } from './eventsub';
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
    expect(latestEventFor(actor)).toMatchObject({ kind: 'sub', detail: 'new sub · Tier 1' });
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
    expect(latestEventFor(actor)).toMatchObject({ kind: 'sub', detail: 'resub · Tier 2 · 7 months' });
  });

  describe('resub merging', () => {
    beforeEach(() => { resetSubMergeState(); });

    // Twitch fires both notifications for one resub. Either order must collapse
    // to a single row carrying the richer resub detail.
    test('subscribe then subscription.message updates the row in place', async () => {
      const actor = `merge-a-${crypto.randomUUID()}`;
      const userId = crypto.randomUUID();
      await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', {
        user_id: userId, user_name: actor, tier: '1000', is_gift: false,
      });
      await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', {
        user_id: userId, user_name: actor, tier: '1000', cumulative_months: 3,
      });
      expect(countEventsFor(actor)).toBe(1);
      expect(latestEventFor(actor)).toMatchObject({ kind: 'sub', detail: 'resub · Tier 1 · 3 months' });
    });

    test('subscription.message then subscribe drops the bare subscribe', async () => {
      const actor = `merge-b-${crypto.randomUUID()}`;
      const userId = crypto.randomUUID();
      await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', {
        user_id: userId, user_name: actor, tier: '3000', cumulative_months: 12,
      });
      await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', {
        user_id: userId, user_name: actor, tier: '3000', is_gift: false,
      });
      expect(countEventsFor(actor)).toBe(1);
      expect(latestEventFor(actor)).toMatchObject({ detail: 'resub · Tier 3 · 12 months' });
    });

    test('two different subscribers still produce two rows', async () => {
      const first = `merge-c1-${crypto.randomUUID()}`;
      const second = `merge-c2-${crypto.randomUUID()}`;
      await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', {
        user_id: crypto.randomUUID(), user_name: first, tier: '1000', is_gift: false,
      });
      await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', {
        user_id: crypto.randomUUID(), user_name: second, tier: '1000', is_gift: false,
      });
      expect(countEventsFor(first)).toBe(1);
      expect(countEventsFor(second)).toBe(1);
    });

    test('a later resub by the same user is not swallowed once the window lapses', async () => {
      const actor = `merge-d-${crypto.randomUUID()}`;
      const userId = crypto.randomUUID();
      await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', {
        user_id: userId, user_name: actor, tier: '1000', cumulative_months: 3,
      });
      resetSubMergeState(); // stands in for the 60s merge window elapsing
      await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', {
        user_id: userId, user_name: actor, tier: '1000', is_gift: false,
      });
      expect(countEventsFor(actor)).toBe(2);
    });

    test('a resub with no month count omits the month segment', async () => {
      const actor = `merge-e-${crypto.randomUUID()}`;
      await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', {
        user_id: crypto.randomUUID(), user_name: actor, tier: '1000',
      });
      expect(latestEventFor(actor)).toMatchObject({ detail: 'resub · Tier 1' });
    });
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
      held_at: new Date().toISOString(),
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
      held_at: new Date().toISOString(),
      reason: 'automod',
      automod: { category: 'profanity', level: 1 },
    });
    // Twitch delivers this status lowercase; asserting on the lowercase form is
    // what makes this test catch a regression to case-sensitive matching.
    await handleEventSubNotification(new RuntimeState(), 'automod.message.update', {
      message_id: messageId,
      status: 'approved',
      moderator_user_name: 'SomeMod',
    });
    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === messageId)).toBe(false);
    const resolved = queue.recentlyResolved.find(h => h.id === messageId);
    expect(resolved).toMatchObject({ resolution: 'allowed', resolvedBy: 'SomeMod' });
  });

  test('automod.message.update with lowercase "denied" resolves as denied', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'a denied message' },
      held_at: new Date().toISOString(),
      reason: 'automod',
      automod: { category: 'profanity', level: 3 },
    });
    await handleEventSubNotification(new RuntimeState(), 'automod.message.update', {
      message_id: messageId,
      status: 'denied',
      moderator_user_name: 'SomeMod',
    });
    const resolved = getAutomodQueue().recentlyResolved.find(h => h.id === messageId);
    expect(resolved).toMatchObject({ resolution: 'denied', resolvedBy: 'SomeMod' });
  });

  test('automod.message.hold without a message_id is ignored', async () => {
    const before = getAutomodQueue().pending.length;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'no id here' },
      held_at: new Date().toISOString(),
      reason: 'automod',
      automod: { category: 'profanity', level: 1 },
    });
    expect(getAutomodQueue().pending.length).toBe(before);
  });

  test('automod.message.update with an unrecognized status resolves as expired', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'a third held message' },
      held_at: new Date().toISOString(),
      reason: 'automod',
      automod: { category: 'profanity', level: 1 },
    });
    await handleEventSubNotification(new RuntimeState(), 'automod.message.update', {
      message_id: messageId,
      status: 'SomethingTwitchNeverDocumented',
      moderator_user_name: null,
    });
    const queue = getAutomodQueue();
    const resolved = queue.recentlyResolved.find(h => h.id === messageId);
    expect(resolved).toMatchObject({ resolution: 'expired' });
  });
});
