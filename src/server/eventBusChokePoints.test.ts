import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The eventBus publishers must fire ONCE per real event, at the same post-dedup
 * choke point the automation dispatch already uses. The load-bearing case is a
 * resub: Twitch delivers it as BOTH channel.subscribe and channel.subscription.message,
 * and the sub-merge in eventsub.ts makes exactly one of those call handleTwitchEvent.
 * A publish placed anywhere but beside that dispatch (e.g. in the message
 * update-only branch) would double-publish the resub. This is the redeemOnce-analogue
 * that proves the publish rides the merge, not each emit branch.
 */

type PublishCall = { kind: string } & Record<string, unknown>;

const publishCalls: PublishCall[] = [];

// Intercept the bus before eventsub.ts binds its static import of it, so the module
// under test calls these spies. Static imports are hoisted above this line, hence the
// dynamic imports below.
mock.module('./eventBus', () => ({
  publishRedeem: (input: Record<string, unknown>) => { publishCalls.push({ kind: 'redeem', ...input }); },
  publishTwitchEvent: (input: Record<string, unknown>) => { publishCalls.push({ kind: 'twitch', ...input }); },
  publishModuleSwitch: (input: Record<string, unknown>) => { publishCalls.push({ kind: 'module', ...input }); },
}));

const { db } = await import('./db');
const { initAutomation } = await import('./automation');
const { RuntimeState } = await import('./runtime');
const { handleEventSubNotification, resetSubMergeState } = await import('./eventsub');

beforeEach(() => {
  publishCalls.length = 0;
  // The sub-merge lives in SQLite; a leftover row from a prior case would make the
  // second half of a resub look like a redelivery and hide a double-publish.
  resetSubMergeState();
  db.exec('delete from stream_events');
  // So the automation dispatch has a dispatcher and doesn't log an init error.
  initAutomation(new RuntimeState());
});

describe('eventBus choke points fire once per real event', () => {
  const resub = { broadcaster_user_id: 'b1', broadcaster_user_login: 's', user_id: 'u1', user_name: 'V', user_login: 'v', tier: '1000' };

  test('a resub delivered as subscribe THEN subscription.message publishes exactly one twitch_event', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { ...resub }, 'm1');
    await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', { ...resub, cumulative_months: 3 }, 'm2');

    const twitch = publishCalls.filter(c => c.kind === 'twitch');
    expect(twitch).toHaveLength(1);
    expect(twitch[0]!.eventKind).toBe('sub');
    expect(twitch[0]!.actorLogin).toBe('v');
    expect(twitch[0]!.tier).toBe('Tier 1');
  });

  test('a resub delivered as subscription.message THEN subscribe still publishes exactly one twitch_event', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.subscription.message', { ...resub, cumulative_months: 3 }, 'm1');
    await handleEventSubNotification(new RuntimeState(), 'channel.subscribe', { ...resub }, 'm2');

    expect(publishCalls.filter(c => c.kind === 'twitch')).toHaveLength(1);
  });

  test('a follow publishes exactly one twitch_event with the follower login', async () => {
    await handleEventSubNotification(new RuntimeState(), 'channel.follow', {
      broadcaster_user_id: 'b1', broadcaster_user_login: 's', user_id: 'u9', user_name: 'F', user_login: 'f',
    }, 'm-follow');

    const twitch = publishCalls.filter(c => c.kind === 'twitch');
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

    const redeems = publishCalls.filter(c => c.kind === 'redeem');
    expect(redeems).toHaveLength(1);
    expect(redeems[0]!.rewardId).toBe('reward-xyz');
    expect(redeems[0]!.redemptionId).toBe('redemption-42');
    expect(redeems[0]!.userLogin).toBe('r');
    expect(redeems[0]!.userInput).toBe('hi');
    expect(redeems[0]!.sourceId).toBe('m-redeem');
  });
});
