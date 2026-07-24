import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { reloadAppConfig, saveAppConfig } from './appConfig';
import { createApp } from './apps';
import { db } from './db';
import { RuntimeState } from './runtime';
import type { TwitchUserToken } from './runtime';
import { getRewardSource, setRewardSource } from './rewardProvenance';
import { fetchRewards, REWARD_SCOPE, registerViewerRewardRoutes, type TwitchRewardCredentials } from './viewerRewards';

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

// --- POST /api/twitch/rewards -------------------------------------------------
// Drives the real Express route (registerViewerRewardRoutes) end to end, the same
// pattern as src/server/twitch/api.test.ts's registerTwitchApiRoutes suite: a live
// server on an ephemeral port, hit with the real global fetch (which passes 127.0.0.1
// straight through to the real network stack while the Twitch stub intercepts
// everything else).

const insertProvenanceRow = db.prepare(
  'insert into reward_provenance (reward_id, source, external_ref, created_at) values (?, ?, null, ?)',
);
/** Seeds N synthetic provenance rows per source — only the per-source COUNT matters
 *  for the cap-rejection message, not any real Twitch reward behind these ids. */
function seedProvenanceCounts(counts: Record<string, number>) {
  const now = new Date().toISOString();
  let n = 0;
  for (const [source, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) insertProvenanceRow.run(`seed-${source}-${n++}`, source, now);
  }
}

/** Twitch's real create-custom-reward 400 body when the channel's reward cap is
 *  reached — an enum-style `message` field, same convention as the confirmed
 *  duplicate-title rejection (`CREATE_CUSTOM_REWARD_DUPLICATE_REWARD`). */
const TWITCH_CAP_ERROR_BODY = { error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARDS_REWARD_LIMIT_REACHED' };
/** A real, DIFFERENT Twitch 400 (duplicate title) — must NOT get the cap message. */
const TWITCH_DUPLICATE_TITLE_ERROR_BODY = { error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' };

function twitchRewardPostBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Reward',
    prompt: '',
    cost: 100,
    isEnabled: true,
    isPaused: false,
    categoryId: null,
    isUserInputRequired: false,
    skipQueue: false,
    backgroundColor: '#9147FF',
    globalCooldown: { enabled: false, seconds: 60 },
    maxPerStream: { enabled: false, max: 1 },
    maxPerUserPerStream: { enabled: false, max: 1 },
    ...overrides,
  };
}

describe('POST /api/twitch/rewards', () => {
  let server: import('node:http').Server;
  let port: number;
  let state: RuntimeState;

  function seedUserToken(scopes: readonly string[]): TwitchUserToken {
    const token: TwitchUserToken = { accessToken: 'user-access', refreshToken: 'user-refresh', scopes: [...scopes], tokenType: 'bearer', expiresAtMs: null };
    state.runtimeUserToken = token;
    return token;
  }

  beforeEach(async () => {
    saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'cid', twitchClientSecret: 'secret' });
    reloadAppConfig();
    state = new RuntimeState();
    seedUserToken(REWARD_SCOPE);
    state.broadcasterId = 'bid';

    // Twitch is the source of truth for the reward list, so the stub must remember
    // what it "created" and echo it back on the subsequent GET the route makes to
    // build its response — otherwise the created reward would vanish from the payload.
    const createdRewards: ReturnType<typeof rawReward>[] = [];
    installFetch(({ url, method }) => {
      if (url.pathname === '/helix/channel_points/custom_rewards') {
        if (method === 'POST') {
          const reward = rawReward({ id: `created${createdRewards.length + 1}` });
          createdRewards.push(reward);
          return jsonResponse({ data: [reward] });
        }
        return jsonResponse({ data: createdRewards });
      }
      return null;
    });

    const app = express();
    app.use(express.json());
    registerViewerRewardRoutes(app, state);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  test('honors a caller-supplied source', async () => {
    createApp('pztmi');
    const res = await fetch(url('/api/twitch/rewards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twitchRewardPostBody({ source: 'pztmi' })),
    });
    expect(res.status).toBe(201);
    const payload = await res.json() as { rewards: Array<{ id: string; source: string | null }> };
    const created = payload.rewards.find(r => r.id === 'created1');
    expect(created?.source).toBe('pztmi');
    expect(getRewardSource('created1')).toBe('pztmi');
  });

  test('defaults the source to narya when the caller sends none', async () => {
    const res = await fetch(url('/api/twitch/rewards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twitchRewardPostBody()),
    });
    expect(res.status).toBe(201);
    const payload = await res.json() as { rewards: Array<{ id: string; source: string | null }> };
    const created = payload.rewards.find(r => r.id === 'created1');
    expect(created?.source).toBe('narya');
    expect(getRewardSource('created1')).toBe('narya');
  });

  // The operator is the party who has to act on the cap rejection, so the operator's
  // own create route gets the same per-source attribution as the app-facing route.
  test('a Twitch cap rejection attributes current consumption per source', async () => {
    seedProvenanceCounts({ pztmi: 7, narya: 3, manual: 12 });
    installFetch(({ url: reqUrl, method }) => {
      if (reqUrl.pathname !== '/helix/channel_points/custom_rewards') return null;
      if (method === 'POST') return jsonResponse(TWITCH_CAP_ERROR_BODY, 400);
      return jsonResponse({ data: [] });
    });

    const res = await fetch(url('/api/twitch/rewards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twitchRewardPostBody()),
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: string };
    expect(payload.error).toContain("Twitch rejected the reward: the channel's reward limit is reached.");
    expect(payload.error).toContain('pztmi: 7');
    expect(payload.error).toContain('narya: 3');
    expect(payload.error).toContain('manual: 12');
  });

  // Over-matching risk: only the cap-shaped 400 gets the attribution message: a
  // different real Twitch 400 (duplicate title) passes through unchanged.
  test('a non-cap Twitch 400 is NOT rewritten to the cap message', async () => {
    seedProvenanceCounts({ pztmi: 7, narya: 3, manual: 12 });
    installFetch(({ url: reqUrl, method }) => {
      if (reqUrl.pathname !== '/helix/channel_points/custom_rewards') return null;
      if (method === 'POST') return jsonResponse(TWITCH_DUPLICATE_TITLE_ERROR_BODY, 400);
      return jsonResponse({ data: [] });
    });

    const res = await fetch(url('/api/twitch/rewards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twitchRewardPostBody()),
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: string };
    expect(payload.error).toBe('CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
    expect(payload.error).not.toContain('reward limit');
    expect(payload.error).not.toContain('Current rewards by source');
  });
});

// --- PATCH / DELETE /api/twitch/rewards/:id -----------------------------------
// Both operator routes were refactored onto the primitives the app-facing routes
// share (sendTwitchRewardUpdate, deleteTwitchReward, forgetRewardLocalState) with no
// coverage. DELETE irreversibly destroys a channel-point reward and PATCH is the only
// place the reward-group clamp is applied on an edit, so neither is safe to infer.

const insertCategoryRow = db.prepare(`
  insert into viewer_reward_categories (id, name, enabled, created_at, updated_at)
  values (?, ?, ?, ?, ?)
`);
const insertCategoryMember = db.prepare(`
  insert into viewer_reward_category_members (reward_id, category_id, updated_at)
  values (?, ?, ?)
`);
const readCategoryMember = db.prepare('select category_id as categoryId from viewer_reward_category_members where reward_id = ?');
const readProvenance = db.prepare('select source from reward_provenance where reward_id = ?');

describe('PATCH/DELETE /api/twitch/rewards/:id', () => {
  let server: import('node:http').Server;
  let port: number;
  let state: RuntimeState;
  let rewards: ReturnType<typeof rawReward>[] = [];

  beforeEach(async () => {
    db.prepare('delete from viewer_reward_category_members').run();
    db.prepare('delete from viewer_reward_categories').run();
    db.prepare('delete from reward_provenance').run();

    saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'cid', twitchClientSecret: 'secret' });
    reloadAppConfig();
    state = new RuntimeState();
    const token: TwitchUserToken = { accessToken: 'user-access', refreshToken: 'user-refresh', scopes: [...REWARD_SCOPE], tokenType: 'bearer', expiresAtMs: null };
    state.runtimeUserToken = token;
    state.broadcasterId = 'bid';

    // One reward that exists on Twitch. The stub answers both list calls fetchRewards
    // makes (all rewards, then only_manageable_rewards=true) from the same array, so
    // canManage is true — the operator PATCH route refuses Twitch fields without it.
    rewards = [rawReward({ id: 'r1' })];
    installFetch(({ url, method }) => {
      if (url.pathname !== '/helix/channel_points/custom_rewards') return null;
      if (method === 'PATCH') {
        const existing = rewards.find(reward => reward.id === url.searchParams.get('id'));
        if (!existing) return jsonResponse({ message: 'not found' }, 404);
        return jsonResponse({ data: [existing] });
      }
      if (method === 'DELETE') {
        rewards = rewards.filter(reward => reward.id !== url.searchParams.get('id'));
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ data: rewards });
    });

    const app = express();
    app.use(express.json());
    registerViewerRewardRoutes(app, state);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function twitchCalls(method: string): FetchCall[] {
    return fetchCalls.filter(call => call.url.pathname === '/helix/channel_points/custom_rewards' && call.method === method);
  }

  // Group membership and provenance are local rows that must not outlive the Twitch
  // reward. A surviving membership row silently re-counts a dead reward in its group;
  // a surviving provenance row keeps attributing a reward that no longer exists.
  test('DELETE issues exactly one Twitch delete and clears both local rows', async () => {
    const categoryId = crypto.randomUUID();
    const now = new Date().toISOString();
    insertCategoryRow.run(categoryId, 'Group', 1, now, now);
    insertCategoryMember.run('r1', categoryId, now);
    setRewardSource('r1', 'narya');

    const res = await fetch(url('/api/twitch/rewards/r1'), { method: 'DELETE' });
    expect(res.status).toBe(204);

    const deletes = twitchCalls('DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url.searchParams.get('id')).toBe('r1');
    expect(readCategoryMember.get('r1')).toBeNull();
    expect(readProvenance.get('r1')).toBeNull();
  });

  // The clamp is the invariant: a reward moved into (or edited inside) a group the
  // operator has switched OFF must go out disabled regardless of what the form sent,
  // or a game switch's "these rewards are off" state is undone by an unrelated edit.
  test('PATCH sends the merged flat body with the reward-group clamp applied', async () => {
    const categoryId = crypto.randomUUID();
    const now = new Date().toISOString();
    insertCategoryRow.run(categoryId, 'Disabled Group', 0, now, now);

    const res = await fetch(url('/api/twitch/rewards/r1'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', isEnabled: true, categoryId }),
    });
    expect(res.status).toBe(200);

    const updates = twitchCalls('PATCH');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.url.searchParams.get('id')).toBe('r1');
    const sent = JSON.parse(updates[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent.title).toBe('Renamed');
    // Clamped: the caller asked for enabled, the group it now belongs to is off.
    expect(sent.is_enabled).toBe(false);
    // Merged, not reset — fields the caller omitted carry their current Twitch values.
    expect(sent.cost).toBe(100);
    expect(sent.prompt).toBe('');
    // is_paused rides only on the update body (Twitch rejects it on create).
    expect(sent.is_paused).toBe(false);
    // And the membership was actually recorded.
    expect(readCategoryMember.get('r1')).toEqual({ categoryId });
  });
});
