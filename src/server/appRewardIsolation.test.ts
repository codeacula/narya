import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { registerAppConfigRoutes, reloadAppConfig, saveAppConfig } from './appConfig';
import { registerAppRewardRoutes } from './appRewards';
import { createApp, hashAppToken, listApps, mintAppToken, registerAppsRoutes, revokeAppToken, setAppDisabled } from './apps';
import { APP_API_PREFIX, getOverlayToken, requireAppToken, requireDashboardToken } from './auth';
import { config } from './config';
import { db } from './db';
import { setRewardSource } from './rewardProvenance';
import { RuntimeState } from './runtime';
import type { TwitchUserToken } from './runtime';
import { REWARD_SCOPE } from './viewerRewards';

/**
 * THE STANDING PROOF OF PER-APP REWARD ISOLATION — Phase D's redeemOnce.test.ts.
 *
 * Every reward on the channel is minted under ONE Twitch client_id with the
 * operator's OAuth token, so Twitch's own `canManage` is true for EVERY
 * narya-created reward no matter which app asked for it. Twitch enforces nothing
 * between apps. The entire boundary is our own `where reward_id = ? and source = ?`
 * (rewardProvenance.ownsReward) plus the fact that `source` is read from the app
 * TOKEN and from nowhere else.
 *
 * This file exists so a refactor that quietly drops either half fails loudly here
 * rather than shipping a channel where any registered app can delete, rename, or
 * read back every other app's — and the operator's — channel-point rewards.
 *
 * Three guards are under test, and each has a mutation that this file catches:
 *   1. the ownsReward gate      → cross-source GET/PATCH/DELETE stop being 404
 *   2. the token-derived source → a body/query `source` re-attributes or grants access
 *   3. the mounted requireAppToken → an /api/ext route answers an un-credentialed caller
 */

// --- fetch stub --------------------------------------------------------------
// Same host-aware swap appRewards.test.ts / viewerRewards.test.ts use: 127.0.0.1
// (our own Express server) passes through to the real network stack, everything
// else is answered here. NO TEST MAY REACH LIVE TWITCH — creating or deleting real
// channel-point rewards is irreversible — so an unmatched URL throws instead of
// escaping. Several assertions below are "fetchCalls is empty", which is only
// meaningful because this stub records every non-loopback call.

const REWARDS_PATH = '/helix/channel_points/custom_rewards';
const realFetch = globalThis.fetch;
type FetchCall = { url: URL; method: string; body: string | null };
let fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Every Twitch reward call of one method — the "this never reached Twitch" counter. */
function rewardCalls(method: string): FetchCall[] {
  return fetchCalls.filter(call => call.url.pathname === REWARDS_PATH && call.method === method);
}

// The victim's reward carries values that appear nowhere else in the process, so
// "did the response leak it?" is a substring search rather than a field-by-field
// guess at a payload shape that may grow later.
const VICTIM_TITLE = 'PZTMI-SECRET-TITLE-8f21';
const VICTIM_PROMPT = 'PZTMI-SECRET-PROMPT-8f21';
const VICTIM_COST = 133_701;

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

// --- route enumeration -------------------------------------------------------
// Read off Express's own router rather than hand-listed. That is the entire point:
// a route added to /api/ext later is swept by the credential tests automatically,
// so shipping one without the prefix guard fails HERE instead of in production.

type RouteSpec = { method: string; path: string };

function registeredRoutes(app: express.Express): RouteSpec[] {
  // Express 5 exposes `app.router`; the `_router` fallback keeps this working if the
  // internal name moves back. If BOTH vanish the sweeps would silently pass over an
  // empty list, so the tests assert the discovered set is non-empty.
  const holder = app as unknown as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } };
  const stack = (holder.router?.stack ?? holder._router?.stack ?? []) as Array<{
    route?: { path?: unknown; methods?: Record<string, boolean> };
  }>;
  const routes: RouteSpec[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route || typeof route.path !== 'string') continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      if (enabled && method !== '_all') routes.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return routes;
}

describe('per-app reward isolation', () => {
  const OPERATOR = 'operator-secret-token-for-isolation';
  const originalDashboardToken = config.dashboardToken;

  let server: import('node:http').Server;
  let port: number;
  let httpApp: express.Express;
  let state: RuntimeState;
  let fooToken: string;
  let pztmiToken: string;
  let disabledToken: string;
  let revokedToken: string;
  let probeAppId: string;
  let twitchRewards: ReturnType<typeof rawReward>[] = [];
  let nextCreatedId = 1;

  beforeEach(async () => {
    db.prepare('delete from reward_provenance').run();
    db.prepare('delete from apps').run();

    // A token is configured on purpose: the operator-token rejection below is
    // vacuous in loopback mode, where roleForToken calls every caller the operator.
    config.dashboardToken = OPERATOR;

    fooToken = mintAppToken(createApp('foo').id);
    pztmiToken = mintAppToken(createApp('pztmi').id);
    const disabled = createApp('disabledapp');
    disabledToken = mintAppToken(disabled.id);
    setAppDisabled(disabled.id, true);
    const revoked = createApp('revokedapp');
    revokedToken = mintAppToken(revoked.id);
    revokeAppToken(revoked.id);
    probeAppId = createApp('probetarget').id;

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

    twitchRewards = [];
    nextCreatedId = 1;
    fetchCalls = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      fetchCalls.push({ url, method, body: init?.body == null ? null : String(init.body) });
      if (url.pathname !== REWARDS_PATH) {
        throw new Error('Unexpected fetch in test: ' + method + ' ' + url.href);
      }
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
        twitchRewards = twitchRewards.filter(reward => reward.id !== id);
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ data: twitchRewards });
    }) as typeof globalThis.fetch;

    httpApp = express();
    httpApp.use(express.json());
    // Exactly index.ts's order and mounting: the operator guard over all of /api,
    // which deliberately next()s /api/ext/* with zero auth, then the app guard
    // mounted ONCE for the whole /api/ext prefix, then every route.
    httpApp.use('/api', requireDashboardToken);
    httpApp.use('/api/ext', requireAppToken);
    registerAppRewardRoutes(httpApp, state);
    registerAppsRoutes(httpApp);
    registerAppConfigRoutes(httpApp, () => {}, () => 'tester');
    server = httpApp.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    config.dashboardToken = originalDashboardToken;
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

  /** Seed a reward that exists on Twitch and is attributed to `source`. */
  function seedReward(id: string, source: string, overrides: Record<string, unknown> = {}) {
    twitchRewards.push(rawReward({ id, ...overrides }));
    setRewardSource(id, source);
  }

  /** pztmi's reward, carrying values that must never come back to foo. */
  function seedVictim(id = 'victim') {
    seedReward(id, 'pztmi', { title: VICTIM_TITLE, prompt: VICTIM_PROMPT, cost: VICTIM_COST });
    return id;
  }

  async function assertNoLeak(response: Response) {
    const text = await response.text();
    expect(text).not.toContain(VICTIM_TITLE);
    expect(text).not.toContain(VICTIM_PROMPT);
    expect(text).not.toContain(String(VICTIM_COST));
  }

  // ---------------------------------------------------------------------------
  // 1. The ownsReward gate: another app's reward
  // ---------------------------------------------------------------------------

  describe('one app cannot reach another app\'s reward', () => {
    // There is no GET /api/ext/rewards/:id — the list route IS the read surface, so
    // "cannot GET" means the reward never appears in it and its contents never
    // appear in the body.
    test('GET (the list) omits it entirely and leaks none of its contents', async () => {
      seedVictim();
      seedReward('mine', 'foo');

      const res = await api('/api/ext/rewards', { token: fooToken });
      expect(res.status).toBe(200);
      const clone = res.clone();
      const payload = await res.json() as { rewards: Array<{ id: string }> };
      expect(payload.rewards.map(reward => reward.id)).toEqual(['mine']);
      await assertNoLeak(clone);
    });

    // And the by-id read that does not exist must not become an accidental one: it
    // answers 404 like every other unowned lookup, and says nothing about the reward.
    test('GET by id is a 404 that discloses nothing', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}`, { token: fooToken });
      expect(res.status).toBe(404);
      await assertNoLeak(res);
    });

    // 404, never 403: a 403 confirms to the caller that the reward exists, which is
    // itself the disclosure this boundary is supposed to prevent.
    test('PATCH is 404 — not 403 — reaches no Twitch call, and changes nothing', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}`, {
        token: fooToken,
        method: 'PATCH',
        body: { title: 'Hijacked', cost: 1 },
      });
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
      await assertNoLeak(res);
      expect(rewardCalls('PATCH')).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
      // Provenance, not the echoed response: the stored attribution is the boundary.
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(twitchRewards.find(reward => reward.id === victim)?.title).toBe(VICTIM_TITLE);
    });

    test('DELETE is 404 — not 403 — leaves it on Twitch, and keeps its provenance', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}`, { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
      await assertNoLeak(res);
      expect(rewardCalls('DELETE')).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(twitchRewards.some(reward => reward.id === victim)).toBe(true);
    });

    // The owner is unaffected by the failed attempts — the gate is per (reward,
    // source), not a lock that a rejected caller can leave behind.
    test('the owner still reaches its own reward afterwards', async () => {
      const victim = seedVictim();
      await api(`/api/ext/rewards/${victim}`, { token: fooToken, method: 'DELETE' });
      const res = await api(`/api/ext/rewards/${victim}`, { token: pztmiToken, method: 'PATCH', body: { title: 'Renamed' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: victim, source: 'pztmi' });
    });
  });

  // ---------------------------------------------------------------------------
  // 2. The ownsReward gate: the operator's own rewards
  // ---------------------------------------------------------------------------

  // 'manual' (created by hand in Twitch's dashboard) and 'narya' (created by the
  // operator's own reward UI) are the operator's rewards. An app that could delete
  // one would be destroying configuration it never provisioned.
  describe('one app cannot reach a manual- or narya-sourced reward', () => {
    for (const source of ['manual', 'narya'] as const) {
      test(`PATCH on a ${source} reward is a 404 and never reaches Twitch`, async () => {
        seedReward('operator-owned', source, { title: VICTIM_TITLE, prompt: VICTIM_PROMPT, cost: VICTIM_COST });
        const res = await api('/api/ext/rewards/operator-owned', {
          token: fooToken,
          method: 'PATCH',
          body: { title: 'Hijacked' },
        });
        expect(res.status).toBe(404);
        await assertNoLeak(res);
        expect(fetchCalls).toHaveLength(0);
        expect(provenanceOf('operator-owned')).toEqual({ source, externalRef: null });
      });

      test(`DELETE on a ${source} reward is a 404 and never reaches Twitch`, async () => {
        seedReward('operator-owned', source, { title: VICTIM_TITLE, prompt: VICTIM_PROMPT, cost: VICTIM_COST });
        const res = await api('/api/ext/rewards/operator-owned', { token: fooToken, method: 'DELETE' });
        expect(res.status).toBe(404);
        await assertNoLeak(res);
        expect(fetchCalls).toHaveLength(0);
        expect(provenanceOf('operator-owned')).toEqual({ source, externalRef: null });
        expect(twitchRewards.some(reward => reward.id === 'operator-owned')).toBe(true);
      });

      test(`GET omits ${source} rewards from an app's list`, async () => {
        seedReward('operator-owned', source, { title: VICTIM_TITLE, prompt: VICTIM_PROMPT, cost: VICTIM_COST });
        const res = await api('/api/ext/rewards', { token: fooToken });
        expect(res.status).toBe(200);
        await assertNoLeak(res);
      });
    }

    // The structural half of the same guarantee: no app can ever be NAMED 'manual'
    // or 'narya', so no app token can ever resolve to the operator's source.
    test('no app can be registered under a reserved source name', async () => {
      for (const name of ['narya', 'manual']) {
        expect(() => createApp(name)).toThrow();
        const res = await api('/api/apps', { token: OPERATOR, method: 'POST', body: { name } });
        expect(res.status).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. source comes from the token, from nowhere else
  // ---------------------------------------------------------------------------

  describe('a caller-supplied source is ignored', () => {
    test('POST with source: pztmi is attributed to foo in the stored provenance', async () => {
      const res = await api('/api/ext/rewards', {
        token: fooToken,
        method: 'POST',
        body: { external_ref: 'ref-1', title: 'App Reward', cost: 250, source: 'pztmi' },
      });
      expect(res.status).toBe(201);
      const payload = await res.json() as { id: string; source: string };
      // The stored row, not the echoed field — the two could disagree, and only the
      // stored one decides who may touch this reward later.
      expect(provenanceOf(payload.id)).toEqual({ source: 'foo', externalRef: 'ref-1' });
      expect(payload.source).toBe('foo');

      // ...and the reward it just created is pztmi's to nobody: pztmi cannot see it.
      const theirs = await api('/api/ext/rewards', { token: pztmiToken });
      const theirsPayload = await theirs.json() as { rewards: Array<{ id: string }> };
      expect(theirsPayload.rewards.map(reward => reward.id)).not.toContain(payload.id);
    });

    test('PATCH with source: pztmi does not re-attribute foo\'s own reward', async () => {
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards/mine', {
        token: fooToken,
        method: 'PATCH',
        body: { title: 'Renamed', source: 'pztmi' },
      });
      expect(res.status).toBe(200);
      expect(provenanceOf('mine')).toEqual({ source: 'foo', externalRef: null });
      // pztmi still cannot touch it.
      const theirs = await api('/api/ext/rewards/mine', { token: pztmiToken, method: 'DELETE' });
      expect(theirs.status).toBe(404);
    });

    // The attacker's obvious move: claim to BE the owner. Under a source read from
    // the body this is a complete bypass of the gate, so it is asserted on both the
    // by-id verbs and through the query string as well as the body.
    test('PATCH claiming source: pztmi does not grant foo access to pztmi\'s reward', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}`, {
        token: fooToken,
        method: 'PATCH',
        body: { title: 'Hijacked', source: 'pztmi' },
      });
      expect(res.status).toBe(404);
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(fetchCalls).toHaveLength(0);
      expect(twitchRewards.find(reward => reward.id === victim)?.title).toBe(VICTIM_TITLE);
    });

    test('PATCH with ?source=pztmi does not grant access either', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}?source=pztmi`, {
        token: fooToken,
        method: 'PATCH',
        body: { title: 'Hijacked' },
      });
      expect(res.status).toBe(404);
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(fetchCalls).toHaveLength(0);
    });

    test('DELETE claiming source: pztmi does not grant access either', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}`, {
        token: fooToken,
        method: 'DELETE',
        body: { source: 'pztmi' },
      });
      expect(res.status).toBe(404);
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(fetchCalls).toHaveLength(0);
      expect(twitchRewards.some(reward => reward.id === victim)).toBe(true);
    });

    test('DELETE with ?source=pztmi does not grant access either', async () => {
      const victim = seedVictim();
      const res = await api(`/api/ext/rewards/${victim}?source=pztmi`, { token: fooToken, method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(provenanceOf(victim)).toEqual({ source: 'pztmi', externalRef: null });
      expect(twitchRewards.some(reward => reward.id === victim)).toBe(true);
    });

    // The query string is the other place a `source` could be read from.
    test('a source query parameter does not widen the list', async () => {
      seedVictim();
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards?source=pztmi', { token: fooToken });
      expect(res.status).toBe(200);
      const clone = res.clone();
      const payload = await res.json() as { rewards: Array<{ id: string }> };
      expect(payload.rewards.map(reward => reward.id)).toEqual(['mine']);
      await assertNoLeak(clone);
    });

    // A source that is not a registered app must not become one by being asked for.
    test('POST with an unregistered source still lands under the token\'s app', async () => {
      const res = await api('/api/ext/rewards', {
        token: fooToken,
        method: 'POST',
        body: { external_ref: 'ref-2', title: 'App Reward', cost: 250, source: 'no-such-app' },
      });
      expect(res.status).toBe(201);
      const payload = await res.json() as { id: string };
      expect(provenanceOf(payload.id)).toEqual({ source: 'foo', externalRef: 'ref-2' });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. The credential boundary, swept over every registered route
  // ---------------------------------------------------------------------------

  describe('the credential boundary', () => {
    // A body that would be valid for whichever route it reaches, so a guard that let
    // one of these through would actually mint a reward, rename an app, or disable
    // one — leaving evidence the "nothing happened" assertions below can find.
    const PROBE_BODY = {
      external_ref: 'probe-ref',
      title: 'Probe Title',
      cost: 4242,
      name: 'probecreated',
      disabled: true,
      eventName: 'probe.event',
    };

    function concretePath(path: string, victimRewardId: string): string {
      return path.split('/').map(segment => {
        if (!segment.startsWith(':')) return segment;
        if (segment === ':id') return path.startsWith('/api/apps') ? probeAppId : victimRewardId;
        return 'probe';
      }).join('/');
    }

    function extRoutes(): RouteSpec[] {
      return registeredRoutes(httpApp).filter(route => route.path.startsWith(APP_API_PREFIX));
    }

    function operatorRoutes(): RouteSpec[] {
      return registeredRoutes(httpApp).filter(route =>
        route.path.startsWith('/api/') && !route.path.startsWith(APP_API_PREFIX));
    }

    function sweep(routes: RouteSpec[], token: string | null, victimRewardId: string) {
      return Promise.all(routes.map(async route => {
        const path = concretePath(route.path, victimRewardId);
        const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : PROBE_BODY;
        const res = await api(path, { token, method: route.method, body });
        return { route, path, status: res.status, text: await res.text() };
      }));
    }

    /** Nothing the sweep did reached Twitch, the reward book, or the app registry. */
    function expectNothingHappened(victimRewardId: string, appCountBefore: number) {
      expect(fetchCalls).toHaveLength(0);
      expect(provenanceOf(victimRewardId)).toEqual({ source: 'pztmi', externalRef: null });
      expect(listApps()).toHaveLength(appCountBefore);
      expect(listApps().some(app => app.name === 'probecreated')).toBe(false);
      expect(listApps().find(app => app.id === probeAppId)?.disabledAt).toBeNull();
    }

    // If the enumeration silently returned nothing — Express renaming its internal
    // router, say — every sweep below would pass vacuously, which is the one way this
    // whole section could rot. The list is exact rather than a subset on purpose: a
    // new /api/ext route fails here until it is written down, which is the moment to
    // confirm the sweeps below cover it.
    test('the enumeration actually finds the ext routes', () => {
      const routes = extRoutes().map(route => `${route.method} ${route.path}`).sort();
      expect(routes).toEqual([
        'DELETE /api/ext/rewards/:id',
        'GET /api/ext/rewards',
        'PATCH /api/ext/rewards/:id',
        'POST /api/ext/rewards',
      ]);
      expect(operatorRoutes().length).toBeGreaterThan(0);
      // The credential-minting route is the one an app token must never reach.
      expect(operatorRoutes()).toContainEqual({ method: 'POST', path: '/api/apps/:id/token' });
    });

    // Enumerated, not spot-checked: requireDashboardToken next()s every /api/ext/*
    // request with zero auth and delegates to requireAppToken, so an ext route that
    // is reachable without a credential is COMPLETELY unauthenticated. A future route
    // added to the prefix is swept by this test the moment it is registered.
    test('every /api/ext route rejects an unauthenticated request', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(extRoutes(), null, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
        expect(result.text).not.toContain(VICTIM_TITLE);
      }
      expectNothingHappened(victim, before);
    });

    // Pasting the dashboard token into an app's config is a realistic operator
    // error. It must fail closed rather than act as a superuser app token.
    test('every /api/ext route rejects the operator token', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(extRoutes(), OPERATOR, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
      }
      expectNothingHappened(victim, before);
    });

    // The overlay token sits in plain text in an OBS scene collection.
    test('every /api/ext route rejects the overlay token', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(extRoutes(), getOverlayToken()!, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
      }
      expectNothingHappened(victim, before);
    });

    // Forced coincidence: the operator/overlay rejections above would also pass by
    // luck, since neither token is normally a hash in apps.token_hash. Storing the
    // operator token AS an app token proves the rejection is the explicit check.
    test('the operator token is rejected even when it is genuinely an app token', async () => {
      const victim = seedVictim();
      db.prepare('update apps set token_hash = ? where name = ?').run(hashAppToken(OPERATOR), 'foo');
      const results = await sweep(extRoutes(), OPERATOR, victim);
      for (const result of results) expect(result.status).toBe(401);
      expect(fetchCalls).toHaveLength(0);
    });

    test('the overlay token is rejected even when it is genuinely an app token', async () => {
      const victim = seedVictim();
      const overlay = getOverlayToken()!;
      db.prepare('update apps set token_hash = ? where name = ?').run(hashAppToken(overlay), 'foo');
      const results = await sweep(extRoutes(), overlay, victim);
      for (const result of results) expect(result.status).toBe(401);
      expect(fetchCalls).toHaveLength(0);
    });

    // Disabling an app is the operator's kill switch. If it only hid the app from
    // the UI, a compromised integration would keep its channel-point access.
    test('every /api/ext route rejects a disabled app\'s token', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(extRoutes(), disabledToken, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
      }
      expectNothingHappened(victim, before);
    });

    // A revoked app stores SQL NULL, which no hash can equal.
    test('every /api/ext route rejects a revoked app\'s token', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(extRoutes(), revokedToken, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
      }
      expectNothingHappened(victim, before);
    });

    // Disabling an app must take effect on the token already in the app's hands,
    // not only on the next mint.
    test('disabling an app revokes access mid-flight', async () => {
      seedReward('mine', 'foo');
      const ok = await api('/api/ext/rewards', { token: fooToken });
      expect(ok.status).toBe(200);
      setAppDisabled(listApps().find(app => app.name === 'foo')!.id, true);
      const after = await api('/api/ext/rewards', { token: fooToken });
      expect(after.status).toBe(401);
    });

    // THE PREFIX TRAP, at the HTTP layer: '/api/apps/x'.startsWith('/api/app') is
    // true, so a skip check one character short would hand the operator's app
    // registry — token minting included — to an app token.
    test('an app token is rejected on every operator route, including /api/apps/:id/token', async () => {
      const victim = seedVictim();
      const before = listApps().length;
      const results = await sweep(operatorRoutes(), fooToken, victim);
      expect(results).not.toHaveLength(0);
      for (const result of results) {
        expect(`${result.route.method} ${result.path} -> ${result.status}`)
          .toBe(`${result.route.method} ${result.path} -> 401`);
      }
      expectNothingHappened(victim, before);
      // Named explicitly, because these two are the ones that hurt: minting a
      // credential and reading the operator's stored configuration.
      const minted = await api(`/api/apps/${probeAppId}/token`, { token: fooToken, method: 'POST' });
      expect(minted.status).toBe(401);
      expect(await minted.text()).not.toContain('narya_app_');
      const configRes = await api('/api/config', { token: fooToken });
      expect(configRes.status).toBe(401);
      const configWrite = await api('/api/config', { token: fooToken, method: 'PUT', body: { twitchChannel: 'hijacked' } });
      expect(configWrite.status).toBe(401);
    });

    // The control that keeps the sweep above honest: these routes exist and DO
    // answer the operator, so the 401s are about the credential, not a 404 in
    // disguise or a route that was never registered.
    test('the operator still reaches the routes the app token was refused', async () => {
      expect((await api('/api/config', { token: OPERATOR })).status).toBe(200);
      expect((await api('/api/apps', { token: OPERATOR })).status).toBe(200);
      const minted = await api(`/api/apps/${probeAppId}/token`, { token: OPERATOR, method: 'POST' });
      expect(minted.status).toBe(201);
      expect((await minted.json() as { token: string }).token).toStartWith('narya_app_');
    });

    // ...and the control for the ext sweep: a live app token DOES work, so the 401s
    // above are the credential being refused rather than the surface being broken.
    test('a valid app token still reaches its own rewards', async () => {
      seedReward('mine', 'foo');
      const res = await api('/api/ext/rewards', { token: fooToken });
      expect(res.status).toBe(200);
      const payload = await res.json() as { rewards: Array<{ id: string }> };
      expect(payload.rewards.map(reward => reward.id)).toEqual(['mine']);
    });
  });
});
