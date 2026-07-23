import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { reloadAppConfig, saveAppConfig } from '../appConfig';
import { db } from '../db';
import { HttpRouteError } from '../http';
import { RuntimeState } from '../runtime';
import type { TwitchUserToken } from '../runtime';
import { resetTwitchIdentityCache } from '../twitchIdentity';
import { resetCategoryModuleCoordinator } from '../categoryModules';
import { recordTagHistory } from '../tags';
import { REQUIRED_TWITCH_BOT_OAUTH_SCOPES, REQUIRED_TWITCH_OAUTH_SCOPES } from './auth';
import {
  fetchAuthenticatedTwitchUser,
  fetchBroadcasterId,
  fetchCurrentTwitchStream,
  fetchViewerTwitchDetails,
  getEventSubCredentials,
  getMissingTwitchBotScopes,
  getMissingTwitchScopes,
  getTwitchActionCredentials,
  getTwitchApiHeaders,
  getTwitchBotApiHeaders,
  getTwitchCategoryById,
  getTwitchChannelTitle,
  getTwitchUserApiHeaders,
  moderateTwitchUser,
  registerTwitchApiRoutes,
  resolveAutomodMessage,
  resolveTwitchUserId,
  runTwitchCommercial,
  searchTwitchCategories,
  sendTwitchChatMessage,
  sendTwitchShoutout,
  sendTwitchWhisper,
  setTwitchChannelTitle,
  TWITCH_COMMERCIAL_SECONDS,
} from './api';

// --- fetch stub --------------------------------------------------------------

const realFetch = globalThis.fetch;
type FetchCall = { url: URL; method: string; headers: any; body: string | null };
type FetchHandler = (call: { url: URL; method: string; body: string | null }) => Response | null;
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
    fetchCalls.push({ url, method, headers: init?.headers, body });
    const res = handler({ url, method, body });
    if (!res) throw new Error('Unexpected fetch in test: ' + method + ' ' + url.href);
    return res;
  }) as typeof globalThis.fetch;
}

// --- helpers -----------------------------------------------------------------

const CREDS = { clientId: 'cid', authorization: 'Bearer tok' };

function makeToken(scopes: readonly string[] = [], expiresAtMs: number | null = null): TwitchUserToken {
  return { accessToken: 'user-access', refreshToken: 'user-refresh', scopes: [...scopes], tokenType: 'bearer', expiresAtMs };
}

function seedUserToken(state: RuntimeState, scopes: readonly string[] = REQUIRED_TWITCH_OAUTH_SCOPES): TwitchUserToken {
  const token = makeToken(scopes);
  state.runtimeUserToken = token;
  return token;
}

function seedBotToken(state: RuntimeState, scopes: readonly string[] = REQUIRED_TWITCH_BOT_OAUTH_SCOPES): TwitchUserToken {
  const token: TwitchUserToken = { accessToken: 'bot-access', refreshToken: 'bot-refresh', scopes: [...scopes], tokenType: 'bearer', expiresAtMs: null };
  state.runtimeBotToken = token;
  return token;
}

function insertTokenRow(provider: string, opts: { accessToken?: string; scopes?: string[]; expiresAt?: string | null } = {}) {
  db.prepare(
    'insert into twitch_oauth (provider, access_token, refresh_token, scopes_json, token_type, expires_at, updated_at) values (?,?,?,?,?,?,?) on conflict(provider) do update set access_token=excluded.access_token, refresh_token=excluded.refresh_token, scopes_json=excluded.scopes_json, token_type=excluded.token_type, expires_at=excluded.expires_at, updated_at=excluded.updated_at',
  ).run(provider, opts.accessToken ?? 'db-access', 'db-refresh', JSON.stringify(opts.scopes ?? []), 'bearer', opts.expiresAt ?? null, new Date().toISOString());
}

async function catchError(fn: () => Promise<unknown>): Promise<any> {
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  return err;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

let state: RuntimeState;

beforeEach(() => {
  db.prepare('delete from twitch_oauth').run();
  // Route side effects touch these shared in-memory tables/coordinator; clear them so
  // this file cannot leak tag history, wind-down state, or category-module state into
  // any sibling test file running later against the same DB.
  db.prepare('delete from stream_tag_history').run();
  db.prepare('delete from wind_down_state').run();
  db.prepare('delete from wind_down_settings').run();
  resetCategoryModuleCoordinator();
  resetTwitchIdentityCache();
  saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'cid', twitchClientSecret: 'secret' });
  reloadAppConfig();
  state = new RuntimeState();
  // Arm a default handler so any unexpected Twitch URL throws instead of hitting the
  // real network between tests. Individual tests re-install their own handler.
  installFetch(() => null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- twitchFetch -------------------------------------------------------------

describe('twitchFetch', () => {
  test('returns the response on ok', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({ ok: true }));
    const res = await twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('returns the response when its status is in allowStatuses', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({ gone: true }, 404));
    const res = await twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x', allowStatuses: [404] });
    expect(res.status).toBe(404);
  });

  test('throws the passthrough status for 401 and 403', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({ message: 'unauthorized' }, 401));
    const err401 = await catchError(() => twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x' }));
    expect(err401).toBeInstanceOf(HttpRouteError);
    expect(err401.status).toBe(401);
    expect(err401.message).toBe('unauthorized');

    installFetch(() => jsonResponse({ message: 'forbidden' }, 403));
    const err403 = await catchError(() => twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x' }));
    expect(err403.status).toBe(403);
  });

  test('maps a non-passthrough failure (500) to 502', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({ message: 'boom' }, 500));
    const err = await catchError(() => twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'fallback' }));
    expect(err.status).toBe(502);
    expect(err.message).toBe('boom');
  });

  test('honours custom passthroughStatuses', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({ message: 'slow down' }, 429));
    const err = await catchError(() =>
      twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x', passthroughStatuses: [429] }),
    );
    expect(err.status).toBe(429);
  });

  test('sets Client-Id and Authorization headers and passes method through', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({}));
    await twitchFetch('https://api.twitch.tv/helix/test', { credentials: CREDS, errorMessage: 'x', method: 'POST' });
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].headers['Client-Id']).toBe('cid');
    expect(fetchCalls[0].headers.Authorization).toBe('Bearer tok');
    expect(fetchCalls[0].headers['Content-Type']).toBeUndefined();
  });

  test('serializes a body as JSON with a Content-Type and merges extra headers', async () => {
    const { twitchFetch } = await import('./api');
    installFetch(() => jsonResponse({}));
    await twitchFetch('https://api.twitch.tv/helix/test', {
      credentials: CREDS,
      errorMessage: 'x',
      method: 'POST',
      body: { hello: 'world' },
      headers: { 'X-Test': '1' },
    });
    expect(fetchCalls[0].headers['Content-Type']).toBe('application/json');
    expect(fetchCalls[0].headers['X-Test']).toBe('1');
    expect(fetchCalls[0].body).toBe(JSON.stringify({ hello: 'world' }));
  });
});

// --- getEventSubCredentials --------------------------------------------------

describe('getEventSubCredentials', () => {
  test('null when there is no client id', async () => {
    saveAppConfig({ twitchClientId: '' });
    seedUserToken(state);
    expect(await getEventSubCredentials(state)).toBeNull();
  });

  test('null when there is no user token', async () => {
    expect(await getEventSubCredentials(state)).toBeNull();
  });

  test('returns the client id and user token when both exist', async () => {
    seedUserToken(state);
    expect(await getEventSubCredentials(state)).toEqual({ clientId: 'cid', userToken: 'user-access' });
  });
});

// --- getTwitchApiHeaders -----------------------------------------------------

describe('getTwitchApiHeaders', () => {
  test('null when there is no client id', async () => {
    saveAppConfig({ twitchClientId: '' });
    expect(await getTwitchApiHeaders(state)).toBeNull();
  });

  test('returns user headers when a user token is present', async () => {
    seedUserToken(state);
    installFetch(() => null);
    expect(await getTwitchApiHeaders(state)).toEqual({ 'Client-Id': 'cid', Authorization: 'Bearer user-access' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('uses a still-valid cached app token without fetching', async () => {
    state.twitchAppToken = { accessToken: 'app-tok', expiresAtMs: Date.now() + 120_000 };
    installFetch(() => null);
    expect(await getTwitchApiHeaders(state)).toEqual({ 'Client-Id': 'cid', Authorization: 'Bearer app-tok' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('mints a client-credentials app token when none is cached and caches it', async () => {
    installFetch(() => jsonResponse({ access_token: 'new-app', expires_in: 3600 }));
    const before = Date.now();
    const headers = await getTwitchApiHeaders(state);
    expect(headers).toEqual({ 'Client-Id': 'cid', Authorization: 'Bearer new-app' });
    expect(fetchCalls[0].url.href).toBe('https://id.twitch.tv/oauth2/token');
    expect(fetchCalls[0].body).toContain('grant_type=client_credentials');
    expect(fetchCalls[0].body).toContain('client_id=cid');
    expect(state.twitchAppToken?.accessToken).toBe('new-app');
    expect(state.twitchAppToken!.expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  test('re-mints when the cached app token is inside the refresh buffer', async () => {
    state.twitchAppToken = { accessToken: 'stale', expiresAtMs: Date.now() + 30_000 };
    installFetch(() => jsonResponse({ access_token: 'fresh', expires_in: 3600 }));
    const headers = await getTwitchApiHeaders(state);
    expect(headers).toEqual({ 'Client-Id': 'cid', Authorization: 'Bearer fresh' });
    expect(fetchCalls).toHaveLength(1);
  });

  test('null when the app token request is not ok', async () => {
    installFetch(() => jsonResponse({ error: 'nope' }, 400));
    expect(await getTwitchApiHeaders(state)).toBeNull();
  });

  test('null when the app token response is missing the token', async () => {
    installFetch(() => jsonResponse({ expires_in: 3600 }));
    expect(await getTwitchApiHeaders(state)).toBeNull();
  });

  test('null when the app token request throws', async () => {
    installFetch(() => {
      throw new Error('network down');
    });
    expect(await getTwitchApiHeaders(state)).toBeNull();
  });

  test('null when there is no client secret and no user token', async () => {
    saveAppConfig({ clearTwitchClientSecret: true });
    installFetch(() => null);
    expect(await getTwitchApiHeaders(state)).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });
});

// --- getTwitchUserApiHeaders / getTwitchBotApiHeaders ------------------------

describe('getTwitchUserApiHeaders / getTwitchBotApiHeaders', () => {
  test('user: null on missing client id', async () => {
    saveAppConfig({ twitchClientId: '' });
    seedUserToken(state);
    expect(await getTwitchUserApiHeaders(state)).toBeNull();
  });

  test('user: null on missing token', async () => {
    expect(await getTwitchUserApiHeaders(state)).toBeNull();
  });

  test('user: includes the user token on success', async () => {
    seedUserToken(state);
    expect(await getTwitchUserApiHeaders(state)).toEqual({
      'Client-Id': 'cid',
      Authorization: 'Bearer user-access',
      userToken: 'user-access',
    });
  });

  test('bot: reads the bot token row, not the user token', async () => {
    seedUserToken(state);
    expect(await getTwitchBotApiHeaders(state)).toBeNull();
    seedBotToken(state);
    expect(await getTwitchBotApiHeaders(state)).toEqual({
      'Client-Id': 'cid',
      Authorization: 'Bearer bot-access',
      userToken: 'bot-access',
    });
  });
});

// --- fetchBroadcasterId ------------------------------------------------------

describe('fetchBroadcasterId', () => {
  test('returns the first id and queries by the configured channel', async () => {
    installFetch(() => jsonResponse({ data: [{ id: '999' }] }));
    expect(await fetchBroadcasterId('cid', 'tok')).toBe('999');
    expect(fetchCalls[0].url.pathname).toBe('/helix/users');
    expect(fetchCalls[0].url.searchParams.get('login')).toBe('tester');
  });

  test('null when the data array is empty', async () => {
    installFetch(() => jsonResponse({ data: [] }));
    expect(await fetchBroadcasterId('cid', 'tok')).toBeNull();
  });

  test('null when the response is not ok', async () => {
    installFetch(() => jsonResponse({}, 500));
    expect(await fetchBroadcasterId('cid', 'tok')).toBeNull();
  });

  test('null when the fetch throws', async () => {
    installFetch(() => {
      throw new Error('down');
    });
    expect(await fetchBroadcasterId('cid', 'tok')).toBeNull();
  });
});

// --- fetchCurrentTwitchStream ------------------------------------------------

describe('fetchCurrentTwitchStream', () => {
  test('maps id, started_at, title and game_name', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 's1', started_at: '2026-01-01T00:00:00Z', title: 'T', game_name: 'G' }] }));
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toEqual({ id: 's1', startedAt: '2026-01-01T00:00:00Z', title: 'T', category: 'G' });
    expect(fetchCalls[0].url.pathname).toBe('/helix/streams');
    expect(fetchCalls[0].url.searchParams.get('user_login')).toBe('tester');
  });

  test('defaults title and category to empty strings when absent', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 's1', started_at: '2026-01-01T00:00:00Z' }] }));
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toEqual({ id: 's1', startedAt: '2026-01-01T00:00:00Z', title: '', category: '' });
  });

  test('null when id is missing', async () => {
    installFetch(() => jsonResponse({ data: [{ started_at: '2026-01-01T00:00:00Z' }] }));
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toBeNull();
  });

  test('null when started_at is missing', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 's1' }] }));
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toBeNull();
  });

  test('null when the response is not ok', async () => {
    installFetch(() => jsonResponse({}, 500));
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toBeNull();
  });

  test('null when the fetch throws', async () => {
    installFetch(() => {
      throw new Error('down');
    });
    expect(await fetchCurrentTwitchStream('cid', 'tok')).toBeNull();
  });
});

// --- fetchAuthenticatedTwitchUser --------------------------------------------

describe('fetchAuthenticatedTwitchUser', () => {
  test('returns id and login on success', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 'u1', login: 'name' }] }));
    expect(await fetchAuthenticatedTwitchUser('cid', 'tok')).toEqual({ id: 'u1', login: 'name' });
    expect(fetchCalls[0].url.href).toBe('https://api.twitch.tv/helix/users');
  });

  test('defaults login to an empty string', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 'u1' }] }));
    expect(await fetchAuthenticatedTwitchUser('cid', 'tok')).toEqual({ id: 'u1', login: '' });
  });

  test('null when there is no id', async () => {
    installFetch(() => jsonResponse({ data: [{ login: 'x' }] }));
    expect(await fetchAuthenticatedTwitchUser('cid', 'tok')).toBeNull();
  });

  test('null when the response is not ok', async () => {
    installFetch(() => jsonResponse({}, 401));
    expect(await fetchAuthenticatedTwitchUser('cid', 'tok')).toBeNull();
  });

  test('null when the fetch throws', async () => {
    installFetch(() => {
      throw new Error('down');
    });
    expect(await fetchAuthenticatedTwitchUser('cid', 'tok')).toBeNull();
  });
});

// --- resolveTwitchUserId -----------------------------------------------------

describe('resolveTwitchUserId', () => {
  test('strips a leading @, trims and lowercases before looking up', async () => {
    installFetch(() => jsonResponse({ data: [{ id: '42' }] }));
    expect(await resolveTwitchUserId('  @FooBar  ', CREDS)).toBe('42');
    expect(fetchCalls[0].url.searchParams.get('login')).toBe('foobar');
  });

  test('throws 400 when the normalized login is empty', async () => {
    const err = await catchError(() => resolveTwitchUserId('@', CREDS));
    expect(err).toBeInstanceOf(HttpRouteError);
    expect(err.status).toBe(400);
  });

  test('throws 404 when no user is found', async () => {
    installFetch(() => jsonResponse({ data: [] }));
    const err = await catchError(() => resolveTwitchUserId('ghost', CREDS));
    expect(err.status).toBe(404);
  });
});

// --- fetchViewerTwitchDetails ------------------------------------------------

describe('fetchViewerTwitchDetails', () => {
  const DEFAULTS = { followed: 'not available', subbed: 'not available', accountAge: 'not available' };

  test('all fields default to "not available" when there are no auth headers', async () => {
    installFetch(() => null);
    expect(await fetchViewerTwitchDetails(state, 'viewer')).toEqual(DEFAULTS);
    expect(fetchCalls).toHaveLength(0);
  });

  function detailHandler(overrides: {
    user?: Response;
    followers?: Response;
    subs?: Response;
  }): FetchHandler {
    return ({ url }) => {
      if (url.pathname === '/helix/users') {
        if (url.searchParams.get('login') === 'tester') return jsonResponse({ data: [{ id: 'bid' }] });
        return overrides.user ?? jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(10) }] });
      }
      if (url.pathname === '/helix/channels/followers') return overrides.followers ?? jsonResponse({ data: [] });
      if (url.pathname === '/helix/subscriptions') return overrides.subs ?? jsonResponse({ data: [] });
      return null;
    };
  }

  test('account age under 60 days renders in days', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ user: jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(10) }] }) }));
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.accountAge.startsWith('10 days')).toBe(true);
  });

  test('account age under 730 days renders in months', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ user: jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(100) }] }) }));
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.accountAge.startsWith('3 months')).toBe(true);
  });

  test('account age of two years renders in years', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ user: jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(800) }] }) }));
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.accountAge.startsWith('2 years')).toBe(true);
  });

  test('an invalid created_at leaves account age as "not available"', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ user: jsonResponse({ data: [{ id: 'u1', created_at: 'not-a-date' }] }) }));
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.accountAge).toBe('not available');
  });

  test('formats a follow date and reports "not following" when absent', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ followers: jsonResponse({ data: [{ followed_at: '2025-06-15T00:00:00Z' }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).followed.startsWith('since ')).toBe(true);

    installFetch(detailHandler({ followers: jsonResponse({ data: [] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).followed).toBe('not following');
  });

  test('maps subscription tiers including gift', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ subs: jsonResponse({ data: [{ tier: '1000', is_gift: false }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('Tier 1');

    installFetch(detailHandler({ subs: jsonResponse({ data: [{ tier: '2000', is_gift: false }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('Tier 2');

    installFetch(detailHandler({ subs: jsonResponse({ data: [{ tier: '3000', is_gift: true }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('Tier 3 (gift)');
  });

  test('a 404 from subscriptions means "not subscribed"', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ subs: jsonResponse({}, 404) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('not subscribed');
  });

  test('a follower lookup failure isolates only the followed field', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({
      followers: jsonResponse({}, 500),
      subs: jsonResponse({ data: [{ tier: '1000' }] }),
    }));
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.followed).toBe('not available');
    expect(details.subbed).toBe('Tier 1');
    expect(details.accountAge.startsWith('10 days')).toBe(true);
  });

  test('a follower fetch that throws isolates only the followed field', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(10) }] });
      if (url.pathname === '/helix/channels/followers') throw new Error('followers down');
      if (url.pathname === '/helix/subscriptions') return jsonResponse({ data: [{ tier: '2000' }] });
      return null;
    });
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.followed).toBe('not available');
    expect(details.subbed).toBe('Tier 2');
    expect(details.accountAge.startsWith('10 days')).toBe(true);
  });

  test('a subscription fetch that throws isolates only the subbed field', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(10) }] });
      if (url.pathname === '/helix/channels/followers') return jsonResponse({ data: [{ followed_at: '2025-06-15T00:00:00Z' }] });
      if (url.pathname === '/helix/subscriptions') throw new Error('subs down');
      return null;
    });
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.subbed).toBe('not available');
    expect(details.followed.startsWith('since ')).toBe(true);
    expect(details.accountAge.startsWith('10 days')).toBe(true);
  });

  test('a failed user lookup returns all defaults without any downstream fetch', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({}, 500);
      return null;
    });
    expect(await fetchViewerTwitchDetails(state, 'viewer')).toEqual(DEFAULTS);
    expect(fetchCalls).toHaveLength(1);
  });

  test('resolves the broadcaster id when it is not cached and caches it', async () => {
    seedUserToken(state);
    installFetch(detailHandler({}));
    await fetchViewerTwitchDetails(state, 'viewer');
    expect(state.broadcasterId).toBe('bid');
    expect(fetchCalls.some((call) => call.url.pathname === '/helix/users' && call.url.searchParams.get('login') === 'tester')).toBe(true);
  });

  test('a broadcaster-id resolution failure keeps followed/subbed unavailable, still reports age, and skips the follower/sub calls', async () => {
    seedUserToken(state);
    // broadcasterId is NOT cached; the channel lookup for "tester" returns nothing so
    // fetchBroadcasterId resolves null and the function must bail before the two joins.
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') {
        if (url.searchParams.get('login') === 'tester') return jsonResponse({ data: [] });
        return jsonResponse({ data: [{ id: 'u1', created_at: daysAgoIso(10) }] });
      }
      return null;
    });
    const details = await fetchViewerTwitchDetails(state, 'viewer');
    expect(details.accountAge.startsWith('10 days')).toBe(true);
    expect(details.followed).toBe('not available');
    expect(details.subbed).toBe('not available');
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/channels/followers')).toBe(false);
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/subscriptions')).toBe(false);
  });

  test('an invalid followed_at renders "following" rather than a date', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ followers: jsonResponse({ data: [{ followed_at: 'not-a-date' }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).followed).toBe('following');
  });

  test('a subscription row without a tier renders "not subscribed"', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ subs: jsonResponse({ data: [{ is_gift: true }] }) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('not subscribed');
  });

  test('a non-404 subscription failure (500) stays "not available", not "not subscribed"', async () => {
    seedUserToken(state);
    state.broadcasterId = 'bid';
    installFetch(detailHandler({ subs: jsonResponse({}, 500) }));
    expect((await fetchViewerTwitchDetails(state, 'viewer')).subbed).toBe('not available');
  });
});

// --- authenticated action user (via sendTwitchShoutout) ----------------------

describe('sendTwitchShoutout', () => {
  test('requires the shoutout scope', async () => {
    seedUserToken(state, ['moderator:read:followers']);
    state.broadcasterId = 'bid';
    const err = await catchError(() => sendTwitchShoutout(state, 'target'));
    expect(err).toBeInstanceOf(HttpRouteError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('moderator:manage:shoutouts');
  });

  test('posts the shoutout with the resolved ids using the cached moderator id', async () => {
    seedUserToken(state, ['moderator:manage:shoutouts']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'me';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (url.pathname === '/helix/chat/shoutouts') return new Response(null, { status: 204 });
      return null;
    });
    await sendTwitchShoutout(state, 'target');
    // No authenticated-user lookup because the sender id was cached.
    const shoutout = fetchCalls.find((call) => call.url.pathname === '/helix/chat/shoutouts')!;
    expect(shoutout.method).toBe('POST');
    expect(shoutout.url.searchParams.get('from_broadcaster_id')).toBe('bid');
    expect(shoutout.url.searchParams.get('to_broadcaster_id')).toBe('77');
    expect(shoutout.url.searchParams.get('moderator_id')).toBe('uid');
  });

  test('resolves and caches the authenticated user when it is not cached, and 502s when unresolved', async () => {
    seedUserToken(state, ['moderator:manage:shoutouts']);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      // Authenticated-user lookup has no login query; the target has one.
      if (url.pathname === '/helix/users' && !url.searchParams.get('login')) return jsonResponse({ data: [] });
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (url.pathname === '/helix/chat/shoutouts') return new Response(null, { status: 204 });
      return null;
    });
    const err = await catchError(() => sendTwitchShoutout(state, 'target'));
    expect(err.status).toBe(502);
  });

  test('propagates a 429 (rate limit) as a passthrough status', async () => {
    seedUserToken(state, ['moderator:manage:shoutouts']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'me';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (url.pathname === '/helix/chat/shoutouts') return jsonResponse({ message: 'rate limited' }, 429);
      return null;
    });
    const err = await catchError(() => sendTwitchShoutout(state, 'target'));
    expect(err.status).toBe(429);
  });
});

// --- sendTwitchWhisper -------------------------------------------------------

describe('sendTwitchWhisper', () => {
  test('rejects an empty message', async () => {
    const err = await catchError(() => sendTwitchWhisper(state, 'target', '   '));
    expect(err.status).toBe(400);
  });

  test('rejects a message over 500 characters', async () => {
    const err = await catchError(() => sendTwitchWhisper(state, 'target', 'x'.repeat(501)));
    expect(err.status).toBe(400);
  });

  test('posts the whisper body and resolved ids', async () => {
    seedUserToken(state, ['user:manage:whispers']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'me';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (url.pathname === '/helix/whispers') return new Response(null, { status: 204 });
      return null;
    });
    await sendTwitchWhisper(state, 'target', '  hi  ');
    const whisper = fetchCalls.find((call) => call.url.pathname === '/helix/whispers')!;
    expect(whisper.method).toBe('POST');
    expect(whisper.url.searchParams.get('from_user_id')).toBe('uid');
    expect(whisper.url.searchParams.get('to_user_id')).toBe('77');
    expect(whisper.body).toBe(JSON.stringify({ message: 'hi' }));
  });
});

// --- moderateTwitchUser ------------------------------------------------------

describe('moderateTwitchUser', () => {
  function moderationHandler(): FetchHandler {
    return ({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (url.pathname === '/helix/moderation/bans') return jsonResponse({ data: [{}] });
      return null;
    };
  }

  function seedMod() {
    seedUserToken(state, ['moderator:manage:banned_users']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'mod';
  }

  test('ban builds a data body with only the user id and POSTs with the resolved ids in the query', async () => {
    seedMod();
    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'ban', {});
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!;
    expect(call.method).toBe('POST');
    expect(call.url.searchParams.get('broadcaster_id')).toBe('bid');
    expect(call.url.searchParams.get('moderator_id')).toBe('uid');
    const body = JSON.parse(call.body!);
    expect(body).toEqual({ data: { user_id: '77' } });
  });

  test('timeout adds the default duration of 600 when unspecified and POSTs with the resolved ids in the query', async () => {
    seedMod();
    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'timeout', {});
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!;
    expect(call.method).toBe('POST');
    expect(call.url.searchParams.get('broadcaster_id')).toBe('bid');
    expect(call.url.searchParams.get('moderator_id')).toBe('uid');
    expect(JSON.parse(call.body!).data.duration).toBe(600);
  });

  test('timeout accepts the inclusive boundary durations (1 second and 14 days)', async () => {
    seedMod();
    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 1 });
    expect(JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!).data.duration).toBe(1);

    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 1_209_600 });
    expect(JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!).data.duration).toBe(1_209_600);
  });

  test('timeout rounds a fractional duration', async () => {
    seedMod();
    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 12.7 });
    const body = JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!);
    expect(body.data.duration).toBe(13);
  });

  test('timeout rejects a non-numeric duration', async () => {
    seedMod();
    installFetch(moderationHandler());
    const err = await catchError(() => moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 'abc' }));
    expect(err.status).toBe(400);
  });

  test('timeout rejects a duration below 1 or above 14 days', async () => {
    seedMod();
    installFetch(moderationHandler());
    expect((await catchError(() => moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 0 }))).status).toBe(400);
    expect((await catchError(() => moderateTwitchUser(state, 'target', 'timeout', { durationSeconds: 1_209_601 }))).status).toBe(400);
  });

  test('normalizes the reason (trim + slice) and omits a non-string reason', async () => {
    seedMod();
    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'ban', { reason: '  spam  ' });
    let body = JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!);
    expect(body.data.reason).toBe('spam');

    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'ban', { reason: 'x'.repeat(600) });
    body = JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!);
    expect(body.data.reason.length).toBe(500);

    installFetch(moderationHandler());
    await moderateTwitchUser(state, 'target', 'ban', { reason: 123 });
    body = JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!.body!);
    expect(body.data.reason).toBeUndefined();
  });
});

// --- resolveAutomodMessage ---------------------------------------------------

describe('resolveAutomodMessage', () => {
  function seedMod() {
    seedUserToken(state, ['moderator:manage:automod']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'mod-login';
  }

  test('a 404 reports the message as gone (allowed status)', async () => {
    seedMod();
    installFetch(({ url }) => (url.pathname === '/helix/moderation/automod/message' ? jsonResponse({}, 404) : null));
    expect(await resolveAutomodMessage(state, 'm1', 'ALLOW')).toEqual({ outcome: 'gone', moderatorLogin: 'mod-login' });
  });

  test('a 200 reports ok and posts the action with the moderator and message ids', async () => {
    seedMod();
    installFetch(({ url }) => (url.pathname === '/helix/moderation/automod/message' ? jsonResponse({}) : null));
    expect(await resolveAutomodMessage(state, 'm1', 'DENY')).toEqual({ outcome: 'ok', moderatorLogin: 'mod-login' });
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/moderation/automod/message')!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ user_id: 'uid', msg_id: 'm1', action: 'DENY' });
  });
});

// --- getMissingTwitchScopes / getMissingTwitchBotScopes ----------------------

describe('getMissingTwitchScopes / getMissingTwitchBotScopes', () => {
  test('empty array when there is no token', () => {
    expect(getMissingTwitchScopes(state, ['a', 'b'])).toEqual([]);
    expect(getMissingTwitchBotScopes(state, ['a'])).toEqual([]);
  });

  test('returns the requested scopes not granted by the token', () => {
    state.runtimeUserToken = makeToken(['a']);
    expect(getMissingTwitchScopes(state, ['a', 'b'])).toEqual(['b']);
  });

  test('loads the user token from the database and caches it onto state', () => {
    insertTokenRow('twitch', { scopes: ['a'] });
    expect(state.runtimeUserToken).toBeNull();
    expect(getMissingTwitchScopes(state, ['a', 'b'])).toEqual(['b']);
    expect(state.runtimeUserToken?.scopes).toEqual(['a']);
  });

  test('loads the bot token from the database and caches it onto state', () => {
    insertTokenRow('twitch_bot', { scopes: ['user:read:chat'] });
    expect(state.runtimeBotToken).toBeNull();
    expect(getMissingTwitchBotScopes(state, ['user:read:chat', 'user:write:chat'])).toEqual(['user:write:chat']);
    expect(state.runtimeBotToken?.scopes).toEqual(['user:read:chat']);
  });
});

// --- getTwitchActionCredentials ----------------------------------------------

describe('getTwitchActionCredentials', () => {
  test('401 when there are no user headers', async () => {
    const err = await catchError(() => getTwitchActionCredentials(state, []));
    expect(err.status).toBe(401);
  });

  test('403 listing the missing scopes', async () => {
    seedUserToken(state, ['a']);
    state.broadcasterId = 'bid';
    const err = await catchError(() => getTwitchActionCredentials(state, ['a', 'b']));
    expect(err.status).toBe(403);
    expect(err.message).toContain('b');
  });

  test('uses a cached broadcaster id without fetching', async () => {
    seedUserToken(state, []);
    state.broadcasterId = 'bid';
    installFetch(() => null);
    const creds = await getTwitchActionCredentials(state, []);
    expect(creds).toEqual({ clientId: 'cid', authorization: 'Bearer user-access', userToken: 'user-access', broadcasterId: 'bid' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('fetches and caches the broadcaster id when absent', async () => {
    seedUserToken(state, []);
    installFetch(({ url }) => (url.pathname === '/helix/users' ? jsonResponse({ data: [{ id: 'bid2' }] }) : null));
    const creds = await getTwitchActionCredentials(state, []);
    expect(creds.broadcasterId).toBe('bid2');
    expect(state.broadcasterId).toBe('bid2');
  });

  test('502 when the broadcaster id cannot be resolved', async () => {
    seedUserToken(state, []);
    state.broadcasterId = null;
    installFetch(({ url }) => (url.pathname === '/helix/users' ? jsonResponse({ data: [] }) : null));
    const err = await catchError(() => getTwitchActionCredentials(state, []));
    expect(err.status).toBe(502);
  });
});

// --- sendTwitchChatMessage ---------------------------------------------------

describe('sendTwitchChatMessage', () => {
  test('rejects an empty message and one over 500 characters', async () => {
    expect((await catchError(() => sendTwitchChatMessage(state, '   ', 'user'))).status).toBe(400);
    expect((await catchError(() => sendTwitchChatMessage(state, 'x'.repeat(501), 'user'))).status).toBe(400);
  });

  test('user path with a cached sender id posts the message and returns the id', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    installFetch(({ url }) => (url.pathname === '/helix/chat/messages' ? jsonResponse({ data: [{ message_id: 'mid', is_sent: true }] }) : null));
    const result = await sendTwitchChatMessage(state, '  hello  ', 'user');
    expect(result).toEqual({ messageId: 'mid' });
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/chat/messages')!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ broadcaster_id: 'bid', sender_id: 'uid', message: 'hello' });
    // The cached id means no authenticated-user lookup was performed.
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/users')).toBe(false);
  });

  test('user path resolves and caches the sender id when not cached', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: 'sid', login: 'me' }] });
      if (url.pathname === '/helix/chat/messages') return jsonResponse({ data: [{ message_id: 'mid', is_sent: true }] });
      return null;
    });
    await sendTwitchChatMessage(state, 'hi', 'user');
    expect(state.twitchSenderId).toBe('sid');
    expect(JSON.parse(fetchCalls.find((c) => c.url.pathname === '/helix/chat/messages')!.body!).sender_id).toBe('sid');
  });

  test('502 when the sender id cannot be resolved', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [] });
      return null;
    });
    const err = await catchError(() => sendTwitchChatMessage(state, 'hi', 'user'));
    expect(err.status).toBe(502);
  });

  test('422 when Twitch reports is_sent false', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    installFetch(({ url }) => (url.pathname === '/helix/chat/messages' ? jsonResponse({ data: [{ is_sent: false }] }) : null));
    const err = await catchError(() => sendTwitchChatMessage(state, 'hi', 'user'));
    expect(err.status).toBe(422);
  });

  test('422 with the drop reason message when Twitch drops the message', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    installFetch(({ url }) =>
      url.pathname === '/helix/chat/messages' ? jsonResponse({ data: [{ drop_reason: { message: 'blocked term' } }] }) : null,
    );
    const err = await catchError(() => sendTwitchChatMessage(state, 'hi', 'user'));
    expect(err.status).toBe(422);
    expect(err.message).toBe('blocked term');
  });

  test('resolves when Twitch omits is_sent (message not dropped)', async () => {
    seedUserToken(state, ['user:write:chat']);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    installFetch(({ url }) => (url.pathname === '/helix/chat/messages' ? jsonResponse({ data: [{ message_id: 'mid' }] }) : null));
    expect(await sendTwitchChatMessage(state, 'hi', 'user')).toEqual({ messageId: 'mid' });
  });

  test('bot path 401s when no bot token is seeded', async () => {
    state.broadcasterId = 'bid';
    const err = await catchError(() => sendTwitchChatMessage(state, 'hi', 'bot'));
    expect(err).toBeInstanceOf(HttpRouteError);
    expect(err.status).toBe(401);
    // The scope/bot-header gate fails before any Twitch call.
    expect(fetchCalls).toHaveLength(0);
  });

  test('bot path 403s naming the missing bot scope', async () => {
    seedBotToken(state, ['user:read:chat']);
    state.broadcasterId = 'bid';
    const err = await catchError(() => sendTwitchChatMessage(state, 'hi', 'bot'));
    expect(err).toBeInstanceOf(HttpRouteError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('user:write:chat');
    expect(err.message).toContain('bot');
    expect(fetchCalls).toHaveLength(0);
  });

  test('bot path caches the bot sender id and lowercased login', async () => {
    seedBotToken(state, REQUIRED_TWITCH_BOT_OAUTH_SCOPES);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/users') return jsonResponse({ data: [{ id: 'botid', login: 'BotName' }] });
      if (url.pathname === '/helix/chat/messages') return jsonResponse({ data: [{ message_id: 'bmid', is_sent: true }] });
      return null;
    });
    const result = await sendTwitchChatMessage(state, 'from the bot', 'bot');
    expect(result).toEqual({ messageId: 'bmid' });
    expect(state.twitchBotSenderId).toBe('botid');
    expect(state.twitchBotLogin).toBe('botname');
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/chat/messages')!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!).sender_id).toBe('botid');
  });
});

// --- runTwitchCommercial / executeTwitchCommercial ---------------------------

describe('runTwitchCommercial', () => {
  function seedForCommercial() {
    seedUserToken(state, ['channel:edit:commercial']);
    state.broadcasterId = 'bid';
    // No bot token: the chat announcement will fail and must be swallowed.
  }

  test('POSTs the commercial with the broadcaster id and the fixed commercial length', async () => {
    seedForCommercial();
    installFetch(({ url }) => (url.pathname === '/helix/channels/commercial' ? jsonResponse({ data: [{ length: 180 }] }) : null));
    await runTwitchCommercial(state);
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/channels/commercial')!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ broadcaster_id: 'bid', length: TWITCH_COMMERCIAL_SECONDS });
  });

  test('two concurrent runs share a single commercial POST', async () => {
    seedForCommercial();
    installFetch(({ url }) => (url.pathname === '/helix/channels/commercial' ? jsonResponse({ data: [{ length: 180 }] }) : null));
    const [a, b] = await Promise.all([runTwitchCommercial(state), runTwitchCommercial(state)]);
    expect(a).toBe(b);
    expect(fetchCalls.filter((c) => c.url.pathname === '/helix/channels/commercial')).toHaveLength(1);
  });

  test('sets adBreakEndsAt, clears the ad schedule cache, and returns the result', async () => {
    seedForCommercial();
    state.twitchAdScheduleCache = { expiresAtMs: Date.now() + 10_000, schedule: {} as any };
    installFetch(({ url }) =>
      url.pathname === '/helix/channels/commercial' ? jsonResponse({ data: [{ length: 120, message: 'ok', retry_after: 5 }] }) : null,
    );
    const result = await runTwitchCommercial(state);
    expect(result.durationSeconds).toBe(120);
    expect(result.message).toBe('ok');
    expect(result.retryAfterSeconds).toBe(5);
    expect(result.adBreakEndsAt).toBe(state.adBreakEndsAt!);
    expect(state.adBreakEndsAt).not.toBeNull();
    expect(state.twitchAdScheduleCache).toBeNull();
  });

  test('defaults the duration when Twitch omits length', async () => {
    seedForCommercial();
    installFetch(({ url }) => (url.pathname === '/helix/channels/commercial' ? jsonResponse({ data: [{}] }) : null));
    const result = await runTwitchCommercial(state);
    expect(result.durationSeconds).toBe(TWITCH_COMMERCIAL_SECONDS);
  });

  test('a failed bot chat announcement is swallowed and the commercial still resolves', async () => {
    // Provide a bot token so the announcement path runs, then fail the message send.
    seedUserToken(state, ['channel:edit:commercial']);
    seedBotToken(state, REQUIRED_TWITCH_BOT_OAUTH_SCOPES);
    state.broadcasterId = 'bid';
    state.twitchBotSenderId = 'botid';
    installFetch(({ url }) => {
      if (url.pathname === '/helix/channels/commercial') return jsonResponse({ data: [{ length: 180 }] });
      if (url.pathname === '/helix/chat/messages') return jsonResponse({ message: 'no' }, 500);
      return null;
    });
    const result = await runTwitchCommercial(state);
    expect(result.durationSeconds).toBe(180);
  });
});

// --- searchTwitchCategories / getTwitchCategoryById --------------------------

describe('searchTwitchCategories / getTwitchCategoryById', () => {
  test('maps search results and defaults boxArtUrl to null', async () => {
    installFetch(({ url }) =>
      url.pathname === '/helix/search/categories'
        ? jsonResponse({ data: [{ id: 'g1', name: 'Game', box_art_url: 'url' }, { id: 'g2', name: 'G2' }] })
        : null,
    );
    const results = await searchTwitchCategories('game', CREDS);
    expect(results).toEqual([
      { id: 'g1', name: 'Game', boxArtUrl: 'url' },
      { id: 'g2', name: 'G2', boxArtUrl: null },
    ]);
    expect(fetchCalls[0].url.searchParams.get('query')).toBe('game');
    expect(fetchCalls[0].url.searchParams.get('first')).toBe('20');
  });

  test('search passes 401 through', async () => {
    installFetch(() => jsonResponse({ message: 'no' }, 401));
    const err = await catchError(() => searchTwitchCategories('game', CREDS));
    expect(err.status).toBe(401);
  });

  test('getTwitchCategoryById maps a game and returns null when unknown', async () => {
    installFetch(({ url }) => (url.pathname === '/helix/games' ? jsonResponse({ data: [{ id: 'g1', name: 'Game' }] }) : null));
    expect(await getTwitchCategoryById('g1', CREDS)).toEqual({ id: 'g1', name: 'Game', boxArtUrl: null });
    expect(fetchCalls[0].url.searchParams.get('id')).toBe('g1');

    installFetch(() => jsonResponse({ data: [] }));
    expect(await getTwitchCategoryById('nope', CREDS)).toBeNull();
  });
});

// --- setTwitchChannelTitle / getTwitchChannelTitle ---------------------------

describe('setTwitchChannelTitle / getTwitchChannelTitle', () => {
  test('PATCHes only the title, without a game_id', async () => {
    seedUserToken(state, ['channel:manage:broadcast']);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => (url.pathname === '/helix/channels' ? new Response(null, { status: 204 }) : null));
    await setTwitchChannelTitle(state, 'New Title');
    const call = fetchCalls.find((c) => c.url.pathname === '/helix/channels')!;
    expect(call.method).toBe('PATCH');
    expect(call.url.searchParams.get('broadcaster_id')).toBe('bid');
    const body = JSON.parse(call.body!);
    expect(body).toEqual({ title: 'New Title' });
    expect('game_id' in body).toBe(false);
  });

  test('getTwitchChannelTitle returns the title, or an empty string when absent', async () => {
    seedUserToken(state, []);
    state.broadcasterId = 'bid';
    installFetch(({ url }) => (url.pathname === '/helix/channels' ? jsonResponse({ data: [{ title: 'Current' }] }) : null));
    expect(await getTwitchChannelTitle(state)).toBe('Current');

    installFetch(({ url }) => (url.pathname === '/helix/channels' ? jsonResponse({ data: [] }) : null));
    expect(await getTwitchChannelTitle(state)).toBe('');
  });
});

// --- registerTwitchApiRoutes -------------------------------------------------

describe('registerTwitchApiRoutes', () => {
  let server: import('node:http').Server;
  let port: number;

  beforeEach(async () => {
    seedUserToken(state, REQUIRED_TWITCH_OAUTH_SCOPES);
    state.broadcasterId = 'bid';
    state.twitchSenderId = 'uid';
    state.twitchSenderLogin = 'me';
    const app = express();
    app.use(express.json());
    registerTwitchApiRoutes(app, state);
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

  test('GET /api/twitch/stream-info maps channel fields', async () => {
    installFetch(({ url: u }) =>
      u.pathname === '/helix/channels'
        ? jsonResponse({ data: [{ broadcaster_name: 'Tester', game_id: 'g1', game_name: 'Game', title: 'T', tags: ['English'] }] })
        : null,
    );
    const res = await fetch(url('/api/twitch/stream-info'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ broadcasterName: 'Tester', categoryId: 'g1', category: 'Game', title: 'T', tags: ['English'] });
  });

  test('GET /api/twitch/stream-info 404s when Twitch returns no channel', async () => {
    installFetch(({ url: u }) => (u.pathname === '/helix/channels' ? jsonResponse({ data: [] }) : null));
    const res = await fetch(url('/api/twitch/stream-info'));
    expect(res.status).toBe(404);
  });

  test('GET /api/twitch/category-suggestions returns [] for a query under 2 characters', async () => {
    installFetch(() => null);
    const res = await fetch(url('/api/twitch/category-suggestions?query=a'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  test('GET /api/twitch/category-suggestions searches for a long-enough query', async () => {
    installFetch(({ url: u }) =>
      u.pathname === '/helix/search/categories' ? jsonResponse({ data: [{ id: 'g1', name: 'Game' }] }) : null,
    );
    const res = await fetch(url('/api/twitch/category-suggestions?query=gam'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'g1', name: 'Game', boxArtUrl: null }]);
  });

  test('GET /api/twitch/category-suggestions 401s when Twitch API credentials are unavailable', async () => {
    // Clearing the client id makes getTwitchApiHeaders return null → the route rejects.
    saveAppConfig({ twitchClientId: '' });
    const res = await fetch(url('/api/twitch/category-suggestions?query=game'));
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test('GET /api/twitch/tag-suggestions falls back to history when the channel fetch fails (no 500)', async () => {
    // "cozy vibes" normalizes to "cozyvibes"; a query of "cozy" must surface it from history.
    recordTagHistory(['cozy vibes']);
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/channels') throw new Error('channel down');
      return null;
    });
    const res = await fetch(url('/api/twitch/tag-suggestions?query=cozy'));
    expect(res.status).toBe(200);
    expect(await res.json()).toContain('cozyvibes');
  });

  test('GET /api/twitch/tag-suggestions returns the channel tags filtered by the query needle', async () => {
    installFetch(({ url: u }) =>
      u.pathname === '/helix/channels' ? jsonResponse({ data: [{ tags: ['English', 'Cozy', 'Cod Warfare'] }] }) : null,
    );
    const res = await fetch(url('/api/twitch/tag-suggestions?query=cod'));
    expect(res.status).toBe(200);
    const tags = await res.json();
    // "Cod Warfare" normalizes to "CodWarfare" which contains "cod"; unrelated tags drop out.
    expect(tags).toContain('CodWarfare');
    expect(tags).not.toContain('English');
    expect(tags).not.toContain('Cozy');
  });

  test('PATCH /api/twitch/stream-info validates title and category', async () => {
    installFetch(() => null);
    expect((await fetch(url('/api/twitch/stream-info'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect(
      (await fetch(url('/api/twitch/stream-info'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(141), category: 'Game' }),
      })).status,
    ).toBe(400);
    expect(
      (await fetch(url('/api/twitch/stream-info'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'A Title' }),
      })).status,
    ).toBe(400);
  });

  test('PATCH /api/twitch/stream-info resolves the category and PATCHes title, game_id and tags', async () => {
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/search/categories') return jsonResponse({ data: [{ id: 'g9', name: 'Some Game' }] });
      if (u.pathname === '/helix/channels') return new Response(null, { status: 204 });
      return null;
    });
    const res = await fetch(url('/api/twitch/stream-info'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Stream', category: 'Some Game', tags: ['Cozy'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: 'My Stream', category: 'Some Game', categoryId: 'g9', tags: ['Cozy'] });
    const patch = fetchCalls.find((c) => c.url.pathname === '/helix/channels' && c.method === 'PATCH')!;
    expect(JSON.parse(patch.body!)).toEqual({ title: 'My Stream', game_id: 'g9', tags: ['Cozy'] });
  });

  test('PATCH /api/twitch/stream-info confirms a provided numeric categoryId against Twitch and returns the confirmed name', async () => {
    installFetch(({ url: u, method }) => {
      if (u.pathname === '/helix/games') return jsonResponse({ data: [{ id: '9909', name: 'Confirmed Name' }] });
      if (u.pathname === '/helix/channels' && method === 'PATCH') return new Response(null, { status: 204 });
      return null;
    });
    const res = await fetch(url('/api/twitch/stream-info'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Stream', categoryId: '9909', category: 'Old Name' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // The confirmed game name wins over the submitted "Old Name"; no fuzzy search is used.
    expect(json.category).toBe('Confirmed Name');
    expect(json.categoryId).toBe('9909');
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/search/categories')).toBe(false);
    const patch = fetchCalls.find((c) => c.url.pathname === '/helix/channels' && c.method === 'PATCH')!;
    expect(JSON.parse(patch.body!).game_id).toBe('9909');
  });

  test('PATCH /api/twitch/stream-info 400s when a provided categoryId no longer resolves and issues no channel PATCH', async () => {
    installFetch(({ url: u }) => (u.pathname === '/helix/games' ? jsonResponse({ data: [] }) : null));
    const res = await fetch(url('/api/twitch/stream-info'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Stream', categoryId: '9909', category: 'Old Name' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Saved category no longer exists');
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/channels' && c.method === 'PATCH')).toBe(false);
  });

  test('PATCH /api/twitch/stream-info 400s when no category matches the fuzzy search and issues no channel PATCH', async () => {
    installFetch(({ url: u }) => (u.pathname === '/helix/search/categories' ? jsonResponse({ data: [] }) : null));
    const res = await fetch(url('/api/twitch/stream-info'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Stream', category: 'Nonexistent Game' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No Twitch category matched');
    expect(fetchCalls.some((c) => c.url.pathname === '/helix/channels' && c.method === 'PATCH')).toBe(false);
  });

  test('POST /api/twitch/preroll runs a commercial', async () => {
    installFetch(({ url: u }) => (u.pathname === '/helix/channels/commercial' ? jsonResponse({ data: [{ length: 180 }] }) : null));
    const res = await fetch(url('/api/twitch/preroll'), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.durationSeconds).toBe(180);
  });

  test('POST /api/twitch/chat-message sends a message', async () => {
    installFetch(({ url: u }) => (u.pathname === '/helix/chat/messages' ? jsonResponse({ data: [{ message_id: 'mid', is_sent: true }] }) : null));
    const res = await fetch(url('/api/twitch/chat-message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sender: 'user' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: 'mid' });
  });

  test('POST /api/twitch/users/:login/shoutout', async () => {
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (u.pathname === '/helix/chat/shoutouts') return new Response(null, { status: 204 });
      return null;
    });
    const res = await fetch(url('/api/twitch/users/someone/shoutout'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Shoutout sent to @someone.' });
  });

  test('POST /api/twitch/users/:login/whisper', async () => {
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (u.pathname === '/helix/whispers') return new Response(null, { status: 204 });
      return null;
    });
    const res = await fetch(url('/api/twitch/users/someone/whisper'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi there' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Whisper sent to @someone.' });
  });

  test('POST /api/twitch/users/:login/timeout', async () => {
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (u.pathname === '/helix/moderation/bans') return jsonResponse({ data: [{}] });
      return null;
    });
    const res = await fetch(url('/api/twitch/users/someone/timeout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds: 60, reason: 'cool off' }),
    });
    expect(res.status).toBe(200);
    const ban = fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!;
    const body = JSON.parse(ban.body!);
    expect(body.data.duration).toBe(60);
    expect(body.data.reason).toBe('cool off');
  });

  test('POST /api/twitch/users/:login/ban', async () => {
    installFetch(({ url: u }) => {
      if (u.pathname === '/helix/users') return jsonResponse({ data: [{ id: '77' }] });
      if (u.pathname === '/helix/moderation/bans') return jsonResponse({ data: [{}] });
      return null;
    });
    const res = await fetch(url('/api/twitch/users/someone/ban'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    });
    expect(res.status).toBe(200);
    const ban = fetchCalls.find((c) => c.url.pathname === '/helix/moderation/bans')!;
    const body = JSON.parse(ban.body!);
    expect(body.data).toEqual({ user_id: '77', reason: 'spam' });
  });
});
