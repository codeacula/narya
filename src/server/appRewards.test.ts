import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { registerAppRewardRoutes } from './appRewards';
import { reloadAppConfig, saveAppConfig } from './appConfig';
import { createApp, mintAppToken } from './apps';
import { requireAppToken } from './auth';
import { db } from './db';
import { setRewardSource } from './rewardProvenance';
import { RuntimeState } from './runtime';
import type { TwitchUserToken } from './runtime';
import { REWARD_SCOPE } from './viewerRewards';

// --- fetch stub --------------------------------------------------------------
// Same host-aware swap viewerRewards.test.ts uses: 127.0.0.1 (our own Express server)
// passes through to the real network stack, everything else is answered here. NO TEST
// MAY REACH LIVE TWITCH — creating or deleting real channel-point rewards is
// irreversible — so an unmatched URL throws instead of escaping.

const REWARDS_PATH = '/helix/channel_points/custom_rewards';
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

/** Every Twitch reward call of one method — the create counter the idempotency test rides on. */
function rewardCalls(method: string): FetchCall[] {
  return fetchCalls.filter(call => call.url.pathname === REWARDS_PATH && call.method === method);
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

type ProvenanceRow = { source: string; externalRef: string | null };
const readProvenance = db.prepare('select source, external_ref as externalRef from reward_provenance where reward_id = ?');
function provenanceOf(rewardId: string): ProvenanceRow | null {
  return (readProvenance.get(rewardId) as ProvenanceRow | undefined) ?? null;
}

const insertProvenanceRow = db.prepare(
  'insert into reward_provenance (reward_id, source, external_ref, created_at) values (?, ?, null, ?)',
);
/** Claims a (source, external_ref) pair directly, standing in for the request that
 *  WINS a concurrent race — it is written while the losing request is awaiting Twitch. */
const insertProvenanceWithRef = db.prepare(
  'insert into reward_provenance (reward_id, source, external_ref, created_at) values (?, ?, ?, ?)',
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

/** Run one request with console.error captured. The per-source breakdown is the
 *  OPERATOR'S diagnostic: on the app-facing route the log is the only place it may
 *  appear, so a test that only inspects the response body cannot tell "moved to the
 *  log" from "lost entirely". */
async function withCapturedErrorLog<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(arg => String(arg)).join(' ')); };
  try {
    const result = await fn();
    return { result, logged: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

/** Twitch's real create-custom-reward 400 body when the channel's reward cap is
 *  reached — an enum-style `message` field, same convention as the confirmed
 *  duplicate-title rejection (`CREATE_CUSTOM_REWARD_DUPLICATE_REWARD`). */
const TWITCH_CAP_ERROR_BODY = { error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARDS_REWARD_LIMIT_REACHED' };
/** A real, DIFFERENT Twitch 400 (duplicate title) — must NOT get the cap message. */
const TWITCH_DUPLICATE_TITLE_ERROR_BODY = { error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' };

// Raw inserts (mirroring viewerRewards.ts's own statements) so a GET test can prove
// an operator-assigned category is NOT leaked into the app-facing payload — a null
// categoryId wouldn't distinguish "omitted" from "assigned but stripped".
const insertCategoryRow = db.prepare(`
  insert into viewer_reward_categories (id, name, enabled, created_at, updated_at)
  values (?, ?, 1, ?, ?)
`);
const insertCategoryMember = db.prepare(`
  insert into viewer_reward_category_members (reward_id, category_id, updated_at)
  values (?, ?, ?)
`);

describe('/api/ext/rewards', () => {
  let server: import('node:http').Server;
  let port: number;
  let state: RuntimeState;
  let fooToken: string;
  let barToken: string;
  let twitchRewards: ReturnType<typeof rawReward>[] = [];
  let nextCreatedId = 1;

  beforeEach(async () => {
    db.prepare('delete from reward_provenance').run();
    db.prepare('delete from apps').run();
    db.prepare('delete from viewer_reward_category_members').run();
    db.prepare('delete from viewer_reward_categories').run();

    fooToken = mintAppToken(createApp('foo').id);
    barToken = mintAppToken(createApp('bar').id);

    saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'cid', twitchClientSecret: 'secret' });
    reloadAppConfig();
    state = new RuntimeState();
    const token: TwitchUserToken = {
      accessToken: 'user-access',
      refreshToken: 'user-refresh',
      scopes: [...REWARD_SCOPE],
      tokenType: 'bearer',
      expiresAtMs: null,
    };
    state.runtimeUserToken = token;
    state.broadcasterId = 'bid';

    // Twitch is the source of truth for reward state, so the stub keeps a list and
    // answers create/list/update/delete against it.
    twitchRewards = [];
    nextCreatedId = 1;
    installFetch(({ url, method }) => {
      if (url.pathname !== REWARDS_PATH) return null;
      if (method === 'POST') {
        const created = rawReward({ id: `created${nextCreatedId++}` });
        twitchRewards.push(created);
        return jsonResponse({ data: [created] });
      }
      if (method === 'PATCH') {
        const existing = twitchRewards.find(reward => reward.id === url.searchParams.get('id'));
        if (!existing) return jsonResponse({ message: 'not found' }, 404);
        return jsonResponse({ data: [existing] });
      }
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        const existed = twitchRewards.some(reward => reward.id === id);
        twitchRewards = twitchRewards.filter(reward => reward.id !== id);
        // Real Twitch 404s deleting a reward that isn't there — the shape the
        // "already gone" recovery test below depends on.
        if (!existed) return jsonResponse({ message: 'The Custom Reward specified was not found' }, 404);
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ data: twitchRewards });
    });

    const app = express();
    app.use(express.json());
    // Mounted ONCE for the whole prefix, exactly as index.ts does it. requireDashboardToken
    // next()s every /api/ext/* request with zero auth, so a route reachable without this
    // is completely unauthenticated.
    app.use('/api/ext', requireAppToken);
    registerAppRewardRoutes(app, state);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function api(path: string, options: { token?: string | null; method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  function createBody(overrides: Record<string, unknown> = {}) {
    return { external_ref: 'ref-1', title: 'App Reward', prompt: 'do a thing', cost: 250, ...overrides };
  }

  /** Seed a reward that exists on Twitch and is attributed to `source`. */
  function seedReward(id: string, source: string) {
    twitchRewards.push(rawReward({ id }));
    setRewardSource(id, source);
  }

  describe('GET', () => {
    test('returns only this app\'s rewards', async () => {
      seedReward('mine', 'foo');
      seedReward('theirs', 'bar');
      twitchRewards.push(rawReward({ id: 'operator-made' }));

      const res = await api('/api/ext/rewards', { token: fooToken });
      expect(res.status).toBe(200);
      const payload = await res.json() as { rewards: Array<{ id: string; source: string | null }> };
      expect(payload.rewards.map(reward => reward.id)).toEqual(['mine']);
      expect(payload.rewards[0]?.source).toBe('foo');
    });

    test('is empty for an app that has provisioned nothing', async () => {
      seedReward('theirs', 'bar');
      const res = await api('/api/ext/rewards', { token: fooToken });
      const payload = await res.json() as { rewards: unknown[] };
      expect(payload.rewards).toEqual([]);
    });

    // categoryId is the operator's reward-group UUID and canManage is Twitch's own
    // manageable-by-this-client_id flag — both operator-internal, neither belongs in
    // a public app contract that must not silently change when ViewerReward does.
    test('omits operator-internal fields (categoryId, canManage)', async () => {
      seedReward('mine', 'foo');
      const categoryId = crypto.randomUUID();
      const now = new Date().toISOString();
      insertCategoryRow.run(categoryId, 'Some Group', now, now);
      insertCategoryMember.run('mine', categoryId, now);

      const res = await api('/api/ext/rewards', { token: fooToken });
      const payload = await res.json() as { rewards: Array<Record<string, unknown>> };
      expect(payload.rewards).toHaveLength(1);
      const reward = payload.rewards[0]!;
      expect('categoryId' in reward).toBe(false);
      expect('canManage' in reward).toBe(false);
      expect(reward.id).toBe('mine');
      expect(reward.title).toBe('Reward');
      expect(reward.cost).toBe(100);
    });
  });

  describe('POST', () => {
    test('creates exactly one Twitch reward and writes provenance with the ref', async () => {
      const res = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() });
      expect(res.status).toBe(201);
      const payload = await res.json() as { id: string; source: string; externalRef: string; created: boolean };
      expect(payload).toEqual({ id: 'created1', source: 'foo', externalRef: 'ref-1', created: true });
      expect(rewardCalls('POST')).toHaveLength(1);
      expect(provenanceOf('created1')).toEqual({ source: 'foo', externalRef: 'ref-1' });
    });

    // THE CAP-BURNING FAILURE the (source, external_ref) index exists to prevent: a
    // retried provision must never mint a second Twitch reward out of the channel's
    // shared pool.
    test('repeated with the same external_ref performs no second Twitch create', async () => {
      const first = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() });
      const firstPayload = await first.json() as { id: string };
      const callsAfterFirst = fetchCalls.length;

      const second = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody({ title: 'Different title' }) });
      expect(second.status).toBe(200);
      const secondPayload = await second.json() as { id: string; created: boolean };

      expect(secondPayload.id).toBe(firstPayload.id);
      expect(secondPayload.created).toBe(false);
      expect(rewardCalls('POST')).toHaveLength(1);
      // Not one Twitch call of any kind on the replay.
      expect(fetchCalls.length).toBe(callsAfterFirst);
    });

    // Each source is its own idempotency namespace, so two apps picking the same key
    // do not collide.
    test('the same external_ref used by a different app creates its own reward', async () => {
      const mine = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() });
      const theirs = await api('/api/ext/rewards', { token: barToken, method: 'POST', body: createBody() });
      expect(theirs.status).toBe(201);
      const minePayload = await mine.json() as { id: string };
      const theirsPayload = await theirs.json() as { id: string };
      expect(theirsPayload.id).not.toBe(minePayload.id);
      expect(rewardCalls('POST')).toHaveLength(2);
      expect(provenanceOf(minePayload.id)).toEqual({ source: 'foo', externalRef: 'ref-1' });
      expect(provenanceOf(theirsPayload.id)).toEqual({ source: 'bar', externalRef: 'ref-1' });
    });

    test('without an external_ref is a 400 and never reaches Twitch', async () => {
      const res = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: { title: 'App Reward', cost: 250 } });
      expect(res.status).toBe(400);
      expect(rewardCalls('POST')).toHaveLength(0);
    });

    test('with a blank external_ref is a 400', async () => {
      const res = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody({ external_ref: '   ' }) });
      expect(res.status).toBe(400);
      expect(rewardCalls('POST')).toHaveLength(0);
    });

    test('ignores a body-supplied source — the token\'s app wins', async () => {
      const res = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody({ source: 'bar' }) });
      expect(res.status).toBe(201);
      const payload = await res.json() as { id: string; source: string };
      expect(payload.source).toBe('foo');
      expect(provenanceOf(payload.id)).toEqual({ source: 'foo', externalRef: 'ref-1' });
    });

    test('rejects an invalid reward before calling Twitch', async () => {
      const res = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody({ cost: 0 }) });
      expect(res.status).toBe(400);
      expect(rewardCalls('POST')).toHaveLength(0);
    });

    // The compensating control for "no per-app quota" is the per-source breakdown —
    // but that is the OPERATOR'S diagnostic, and this caller holds nothing but its own
    // app token. Handing it "pztmi: 7, narya: 3, manual: 12" would disclose the
    // operator's entire app registry and each app's consumption to app `foo`, which
    // contradicts the same reasoning that makes every by-id miss a 404 and not a 403.
    // The app gets a generic cap message plus its OWN count; the breakdown goes to
    // the operator's log.
    test('a Twitch cap rejection tells the app its own count and no other source\'s', async () => {
      seedProvenanceCounts({ foo: 2, pztmi: 7, narya: 3, manual: 12 });
      installFetch(({ url, method }) => {
        if (url.pathname !== REWARDS_PATH) return null;
        if (method === 'POST') return jsonResponse(TWITCH_CAP_ERROR_BODY, 400);
        return jsonResponse({ data: twitchRewards });
      });

      const { result: res, logged } = await withCapturedErrorLog(
        () => api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() }),
      );
      expect(res.status).toBe(400);
      const payload = await res.json() as { error: string };
      expect(payload.error).toContain("the channel's reward limit is reached");
      // Its own consumption, so the app can act on its own footprint.
      expect(payload.error).toContain('2');
      // Nothing about anyone else: no other source's NAME and no other source's COUNT.
      expect(payload.error).not.toContain('pztmi');
      expect(payload.error).not.toContain('narya');
      expect(payload.error).not.toContain('manual');
      expect(payload.error).not.toContain('Current rewards by source');
      expect(payload.error).not.toContain('7');
      expect(payload.error).not.toContain('12');
      // The operator still gets the attribution — in the log, where only they can read it.
      expect(logged).toContain('pztmi: 7');
      expect(logged).toContain('narya: 3');
      expect(logged).toContain('manual: 12');
      // Never provisioned — the cap rejection must not leave a dangling provenance row.
      expect(rewardCalls('POST')).toHaveLength(1);
    });

    // Over-matching risk: Twitch's create returns 400 for several reasons. Only the
    // cap-shaped rejection may get the attribution message; a different real Twitch
    // 400 (duplicate title) must pass through unchanged, underlying message intact.
    test('a non-cap Twitch 400 is NOT rewritten to the cap message', async () => {
      seedProvenanceCounts({ pztmi: 7, narya: 3, manual: 12 });
      installFetch(({ url, method }) => {
        if (url.pathname !== REWARDS_PATH) return null;
        if (method === 'POST') return jsonResponse(TWITCH_DUPLICATE_TITLE_ERROR_BODY, 400);
        return jsonResponse({ data: twitchRewards });
      });

      const { result: res, logged } = await withCapturedErrorLog(
        () => api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() }),
      );
      expect(res.status).toBe(400);
      const payload = await res.json() as { error: string };
      expect(payload.error).toBe('CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
      expect(payload.error).not.toContain('reward limit');
      expect(payload.error).not.toContain('Current rewards by source');
      // …but the operator still gets attribution in the LOG, because the cap regex is
      // the fragile part: Twitch renaming its enum would otherwise take the whole
      // diagnostic away silently. Logging on every create failure is what makes the
      // regex an optimization for the response body rather than a single point of loss.
      expect(logged).toContain('pztmi: 7');
      expect(logged).toContain('narya: 3');
      expect(logged).toContain('manual: 12');
    });

    // The (source, external_ref) index is checked BEFORE the Twitch create and enforced
    // only AFTER it, so two concurrent POSTs can both pass the check and both mint a
    // reward. The loser must not leave its reward behind: an orphan self-heals to
    // 'manual' on the next list and becomes indistinguishable from a reward the operator
    // made by hand, silently consuming a slot out of a pool with no quota protecting it.
    test('losing the external_ref race deletes the reward it just created', async () => {
      installFetch(({ url, method }) => {
        if (url.pathname !== REWARDS_PATH) return null;
        if (method === 'POST') {
          // The winning request lands while this one is awaiting Twitch — exactly the
          // window between the idempotency read and the provenance write.
          insertProvenanceWithRef.run('race-winner', 'foo', 'ref-1', new Date().toISOString());
          const created = rawReward({ id: 'orphan' });
          twitchRewards.push(created);
          return jsonResponse({ data: [created] });
        }
        if (method === 'DELETE') {
          twitchRewards = twitchRewards.filter(reward => reward.id !== url.searchParams.get('id'));
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ data: twitchRewards });
      });

      const { result: res, logged } = await withCapturedErrorLog(
        () => api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() }),
      );
      expect(res.status).toBe(409);
      // Compensated: the reward this request minted is gone from Twitch again.
      const deletes = rewardCalls('DELETE');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.url.searchParams.get('id')).toBe('orphan');
      expect(twitchRewards.map(reward => reward.id)).not.toContain('orphan');
      expect(provenanceOf('orphan')).toBeNull();
      // The winner's claim is untouched.
      expect(provenanceOf('race-winner')).toEqual({ source: 'foo', externalRef: 'ref-1' });
      // The app never learned the id, so the operator's log is the only trace there can be.
      expect(logged).toContain('orphan');
    });

    test('still 409s, and logs the orphan, when the compensating delete itself fails', async () => {
      installFetch(({ url, method }) => {
        if (url.pathname !== REWARDS_PATH) return null;
        if (method === 'POST') {
          insertProvenanceWithRef.run('race-winner', 'foo', 'ref-1', new Date().toISOString());
          const created = rawReward({ id: 'orphan' });
          twitchRewards.push(created);
          return jsonResponse({ data: [created] });
        }
        if (method === 'DELETE') return jsonResponse({ message: 'Twitch is having a day' }, 500);
        return jsonResponse({ data: twitchRewards });
      });

      const { result: res, logged } = await withCapturedErrorLog(
        () => api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() }),
      );
      // A failed compensation is never swallowed into a 500 — the caller's answer is
      // still "someone else claimed this ref", and the orphan is still reported.
      expect(res.status).toBe(409);
      expect(rewardCalls('DELETE')).toHaveLength(1);
      expect(logged).toContain('orphan');
      expect(provenanceOf('orphan')).toBeNull();
    });
  });

  describe('PATCH', () => {
    test('updates this app\'s reward on Twitch', async () => {
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards/mine', { token: fooToken, method: 'PATCH', body: { title: 'Renamed', cost: 500 } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'mine', source: 'foo' });

      const updates = rewardCalls('PATCH');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.url.searchParams.get('id')).toBe('mine');
      const sent = JSON.parse(updates[0]?.body ?? '{}') as Record<string, unknown>;
      expect(sent.title).toBe('Renamed');
      expect(sent.cost).toBe(500);
      // Unspecified fields keep their current Twitch values rather than being reset.
      expect(sent.prompt).toBe('');
    });

    // 404, never 403: a 403 confirms the reward exists to an app that does not own it.
    test('on another app\'s reward is a 404 and never reaches Twitch', async () => {
      seedReward('theirs', 'bar');
      const res = await api('/api/ext/rewards/theirs', { token: fooToken, method: 'PATCH', body: { title: 'Hijacked' } });
      expect(res.status).toBe(404);
      expect(rewardCalls('PATCH')).toHaveLength(0);
    });

    test('on an unknown reward id is a 404', async () => {
      const res = await api('/api/ext/rewards/nope', { token: fooToken, method: 'PATCH', body: { title: 'Ghost' } });
      expect(res.status).toBe(404);
    });

    test('ignores a body-supplied source', async () => {
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards/mine', { token: fooToken, method: 'PATCH', body: { title: 'Renamed', source: 'bar' } });
      expect(res.status).toBe(200);
      expect(provenanceOf('mine')?.source).toBe('foo');
    });
  });

  describe('DELETE', () => {
    test('deletes this app\'s reward and clears its provenance', async () => {
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards/mine', { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(rewardCalls('DELETE')).toHaveLength(1);
      expect(provenanceOf('mine')).toBeNull();
    });

    test('on another app\'s reward is a 404, leaves it on Twitch, and keeps its provenance', async () => {
      seedReward('theirs', 'bar');
      const res = await api('/api/ext/rewards/theirs', { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(rewardCalls('DELETE')).toHaveLength(0);
      expect(provenanceOf('theirs')).toEqual({ source: 'bar', externalRef: null });
    });

    test('on a manually-created reward is a 404', async () => {
      seedReward('operator-made', 'manual');
      const res = await api('/api/ext/rewards/operator-made', { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(rewardCalls('DELETE')).toHaveLength(0);
    });

    // The reviewer's repro: the operator deletes the reward from Twitch's own
    // dashboard (routine, out of band). Provenance survives that; Twitch's list
    // does not. A DELETE against an already-gone reward must still clear
    // provenance, or the app's external_ref is wedged forever.
    test('when Twitch already deleted the reward, still succeeds and clears provenance', async () => {
      seedReward('created1', 'foo');
      twitchRewards = twitchRewards.filter(reward => reward.id !== 'created1');

      const res = await api('/api/ext/rewards/created1', { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(rewardCalls('DELETE')).toHaveLength(1);
      expect(provenanceOf('created1')).toBeNull();
    });

    // The recovery loop the fix exists for: once provenance is cleared, the same
    // external_ref can provision a fresh reward instead of being wedged on a dead id.
    test('after a Twitch-side deletion, re-POSTing the same external_ref creates a NEW reward', async () => {
      const first = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() });
      expect(first.status).toBe(201);
      const firstPayload = await first.json() as { id: string };

      // Operator deletes it on Twitch, outside the app entirely.
      twitchRewards = twitchRewards.filter(reward => reward.id !== firstPayload.id);

      const deleteRes = await api(`/api/ext/rewards/${firstPayload.id}`, { token: fooToken, method: 'DELETE' });
      expect(deleteRes.status).toBe(204);
      expect(provenanceOf(firstPayload.id)).toBeNull();

      const second = await api('/api/ext/rewards', { token: fooToken, method: 'POST', body: createBody() });
      expect(second.status).toBe(201);
      const secondPayload = await second.json() as { id: string; created: boolean };
      expect(secondPayload.created).toBe(true);
      expect(secondPayload.id).not.toBe(firstPayload.id);
      expect(rewardCalls('POST')).toHaveLength(2);
      expect(provenanceOf(secondPayload.id)).toEqual({ source: 'foo', externalRef: 'ref-1' });
    });
  });

  // If the guard is not mounted these all pass through with no auth at all, because
  // requireDashboardToken deliberately skips the /api/ext/ prefix.
  test('every route rejects an unauthenticated request', async () => {
    seedReward('mine', 'foo');
    const calls = [
      api('/api/ext/rewards'),
      api('/api/ext/rewards', { method: 'POST', body: createBody() }),
      api('/api/ext/rewards/mine', { method: 'PATCH', body: { title: 'Renamed' } }),
      api('/api/ext/rewards/mine', { method: 'DELETE' }),
    ];
    for (const call of calls) expect((await call).status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });
});
