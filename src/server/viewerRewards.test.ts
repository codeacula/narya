import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from './apps';
import { db } from './db';
import { setRewardSource } from './rewardProvenance';
import { fetchRewards, type TwitchRewardCredentials } from './viewerRewards';

// --- fetch stub --------------------------------------------------------------
// Modeled on src/server/twitch/api.test.ts: a host-aware globalThis.fetch swap
// that answers the Twitch reward-list endpoint and throws on anything else.

const realFetch = globalThis.fetch;
type FetchCall = { url: URL; method: string; body: string | null };
type FetchHandler = (call: FetchCall) => Response | null;
let fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(handler: FetchHandler) {
  fetchCalls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body == null ? null : String(init.body);
    fetchCalls.push({ url, method, body });
    const res = handler({ url, method, body });
    if (!res) throw new Error('Unexpected fetch in test: ' + method + ' ' + url.href);
    return res;
  }) as typeof globalThis.fetch;
}

function rawReward(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
    title: 'Reward',
    prompt: '',
    cost: 100,
    is_enabled: true,
    is_paused: false,
    is_in_stock: true,
    is_user_input_required: false,
    background_color: '#9147FF',
    image: null,
    default_image: { url_1x: 'https://example.com/img.png' },
    should_redemptions_skip_request_queue: false,
    global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 60 },
    max_per_stream_setting: { is_enabled: false, max_per_stream: 1 },
    max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 1 },
    ...overrides,
  };
}

const fakeCredentials: TwitchRewardCredentials = {
  clientId: 'cid',
  authorization: 'Bearer tok',
  userToken: 'tok',
  broadcasterId: 'bid',
};

beforeEach(() => {
  db.prepare('delete from reward_provenance').run();
  db.prepare('delete from apps').run();
  db.prepare('delete from viewer_reward_category_members').run();
  const rewards = [rawReward({ id: 'r1' }), rawReward({ id: 'r2' })];
  installFetch(({ url }) => {
    if (url.pathname === '/helix/channel_points/custom_rewards') return jsonResponse({ data: rewards });
    return null;
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchRewards', () => {
  test('self-heals unknown ids to manual and surfaces source', async () => {
    createApp('pztmi');
    setRewardSource('r2', 'pztmi');

    const rewards = await fetchRewards(fakeCredentials);
    const byId = Object.fromEntries(rewards.map(r => [r.id, r.source]));

    expect(byId.r1).toBe('manual');
    expect(byId.r2).toBe('pztmi');
  });
});
