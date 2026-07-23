import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { initAutomation } from './automation';
import { RuntimeState } from './runtime';
import { handleEventSubNotification, resetSubMergeState } from './eventsub';
import { saveAppConfig } from './appConfig';
import { __resetRedisForTest, __setRedisClientFactory, startRedis } from './redis';

/**
 * The eventBus publishers must fire ONCE per real event, at the same post-dedup
 * choke point the automation dispatch already uses. The load-bearing case is a
 * resub: Twitch delivers it as BOTH channel.subscribe and channel.subscription.message,
 * and the sub-merge in eventsub.ts makes exactly one of those call handleTwitchEvent.
 * A publish placed anywhere but beside that dispatch (e.g. in the message
 * update-only branch) would double-publish the resub. This is the redeemOnce-analogue
 * that proves the publish rides the merge, not each emit branch.
 *
 * We observe the REAL publish path at the ./redis seam (a fake client that records the
 * xadd args) rather than mock.module('./eventBus'). A global module mock of the bus is
 * process-wide and leaks into eventBus.test.ts (which needs the real module), so the
 * two files must both intercept below the bus, not replace it.
 */

type PublishCall = { kind: string; sourceId: string } & Record<string, unknown>;

const xaddCalls: unknown[][] = [];

function fakeClient() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    on(event: string, cb: (arg?: unknown) => void) { handlers[event] = cb; },
    async xadd(...args: unknown[]) { xaddCalls.push(args); return '1-0'; },
    quit: async () => {},
    disconnect() {},
    emit(event: string, arg?: unknown) { handlers[event]?.(arg); },
  };
}

// xadd args are [key, 'MINID', '~', minId, '*', 'v', value]. Map each published envelope
// back to the shape the assertions want: kind from envelope.type, sourceId from the
// envelope id, and the allowlisted fields from envelope.data.
function publishCalls(): PublishCall[] {
  return xaddCalls.map(args => {
    const env = JSON.parse(String(args[6]));
    const kind = env.type === 'twitch_event' ? 'twitch' : env.type === 'redeem' ? 'redeem' : 'module';
    return { kind, sourceId: env.id, ...(env.data as Record<string, unknown>) };
  });
}

beforeEach(() => {
  xaddCalls.length = 0;
  __resetRedisForTest();
  __setRedisClientFactory(() => fakeClient() as never);
  saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
  startRedis();
  // The sub-merge lives in SQLite; a leftover row from a prior case would make the
  // second half of a resub look like a redelivery and hide a double-publish.
  resetSubMergeState();
  db.exec('delete from stream_events');
  // So the automation dispatch has a dispatcher and doesn't log an init error.
  initAutomation(new RuntimeState());
});

afterEach(() => { __resetRedisForTest(); saveAppConfig({ clearRedisUrl: true }); });

describe('eventBus choke points fire once per real event', () => {
  const resub = { broadcaster_user_id: 'b1', broadcaster_user_login: 's', user_id: 'u1', user_name: 'V', user_login: 'v', tier: '1000' };

  test('a resub delivered as subscribe THEN subscription.message publishes exactly one twitch_event', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { ...resub }, 'm1');
    await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', { ...resub, cumulative_months: 3 }, 'm2');

    const twitch = publishCalls().filter(c => c.kind === 'twitch');
    expect(twitch).toHaveLength(1);
    expect(twitch[0]!.eventKind).toBe('sub');
    expect(twitch[0]!.actorLogin).toBe('v');
    expect(twitch[0]!.tier).toBe('Tier 1');
  });

  test('a resub delivered as subscription.message THEN subscribe still publishes exactly one twitch_event', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', { ...resub, cumulative_months: 3 }, 'm1');
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { ...resub }, 'm2');

    expect(publishCalls().filter(c => c.kind === 'twitch')).toHaveLength(1);
  });

  test('a follow publishes exactly one twitch_event with the follower login', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.follow', {
      broadcaster_user_id: 'b1', broadcaster_user_login: 's', user_id: 'u9', user_name: 'F', user_login: 'f',
    }, 'm-follow');

    const twitch = publishCalls().filter(c => c.kind === 'twitch');
    expect(twitch).toHaveLength(1);
    expect(twitch[0]!.eventKind).toBe('follow');
    expect(twitch[0]!.actorLogin).toBe('f');
    expect(twitch[0]!.sourceId).toBe('m-follow');
  });

  test('a redeem publishes exactly one redeem carrying its redemption id and reward', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      id: 'redemption-42',
      broadcaster_user_id: 'b1', broadcaster_user_login: 's',
      user_id: 'u7', user_name: 'R', user_login: 'r', user_input: '  hi  ',
      reward: { id: 'reward-xyz', title: 'Play a clip' },
    }, 'm-redeem');

    const redeems = publishCalls().filter(c => c.kind === 'redeem');
    expect(redeems).toHaveLength(1);
    expect(redeems[0]!.rewardId).toBe('reward-xyz');
    expect(redeems[0]!.redemptionId).toBe('redemption-42');
    expect(redeems[0]!.userLogin).toBe('r');
    expect(redeems[0]!.userInput).toBe('hi');
    expect(redeems[0]!.sourceId).toBe('m-redeem');
  });
});
