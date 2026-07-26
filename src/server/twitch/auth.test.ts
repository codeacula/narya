import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import { reloadAppConfig, saveAppConfig } from '../appConfig';
import { db } from '../db';
import { RuntimeState, type TwitchUserToken } from '../runtime';
import { resetTwitchIdentityCache, setTwitchIdentity } from '../twitchIdentity';
import {
  REQUIRED_TWITCH_BOT_OAUTH_SCOPES,
  REQUIRED_TWITCH_OAUTH_SCOPES,
  getTwitchAuthStatus,
  getTwitchBotAccessToken,
  getTwitchUserAccessToken,
  hydrateTwitchAuthState,
  loadCachedTwitchBotToken,
  loadCachedTwitchUserToken,
  registerTwitchAuthRoutes,
} from './auth';

// ---------------------------------------------------------------------------
// Host-aware global fetch stub. Twitch calls (id.twitch.tv / api.twitch.tv) are
// recorded and answered from `fetchHandler`; anything on loopback (the express
// route tests below fetch 127.0.0.1) is passed through to the real fetch.
// ---------------------------------------------------------------------------
let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: URL; method: string; headers: unknown; body: string | null }>;
let fetchHandler: (call: { url: URL; method: string; body: string | null }) => Response | null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch() {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  fetchHandler = () => null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return originalFetch(input as never, init as never);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body == null ? null : String(init.body);
    fetchCalls.push({ url, method, headers: init?.headers, body });
    const res = fetchHandler({ url, method, body });
    if (!res) throw new Error('Unexpected fetch in test: ' + method + ' ' + url.href);
    return res;
  }) as typeof globalThis.fetch;
}

// A single non-loopback (Twitch) call recorded during the test.
function onlyTwitchCall() {
  expect(fetchCalls.length).toBe(1);
  return fetchCalls[0]!;
}

// ---------------------------------------------------------------------------
// DB seeding helpers
// ---------------------------------------------------------------------------
function insertTokenRow(
  provider: string,
  opts: {
    accessToken?: string;
    refreshToken?: string | null;
    scopesJson?: string;
    tokenType?: string | null;
    expiresAt?: string | null;
  } = {},
) {
  const {
    accessToken = 'access-tok',
    refreshToken = 'refresh-tok',
    scopesJson = '["a"]',
    tokenType = 'bearer',
    expiresAt = null,
  } = opts;
  db.prepare(
    `insert into twitch_oauth (provider, access_token, refresh_token, scopes_json, token_type, expires_at, updated_at)
     values (?,?,?,?,?,?,?)
     on conflict(provider) do update set
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       scopes_json=excluded.scopes_json,
       token_type=excluded.token_type,
       expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`,
  ).run(provider, accessToken, refreshToken, scopesJson, tokenType, expiresAt, new Date().toISOString());
}

function seedConfig(opts: { clientId?: string; clientSecret?: string } = {}) {
  saveAppConfig({
    twitchChannel: '',
    twitchClientId: opts.clientId ?? '',
    ...(opts.clientSecret !== undefined && opts.clientSecret !== ''
      ? { twitchClientSecret: opts.clientSecret }
      : { clearTwitchClientSecret: true }),
  });
}

function makeToken(overrides: Partial<TwitchUserToken> = {}): TwitchUserToken {
  return {
    accessToken: 'access-tok',
    refreshToken: 'refresh-tok',
    scopes: ['a'],
    tokenType: 'bearer',
    expiresAtMs: null,
    ...overrides,
  };
}

const HOUR = 3_600_000;

beforeEach(() => {
  db.prepare('delete from twitch_oauth').run();
  resetTwitchIdentityCache();
  // Clear both client id and (via the clear flag) the secret to a known-empty state.
  saveAppConfig({ twitchChannel: '', twitchClientId: '', clearTwitchClientSecret: true });
  reloadAppConfig();
  installFetch();
});

let activeServer: Server | null = null;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (activeServer) {
    await new Promise<void>(resolve => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

// ---------------------------------------------------------------------------
// loadCachedTwitchUserToken / loadCachedTwitchBotToken
// ---------------------------------------------------------------------------
describe('loadCachedTwitch*Token', () => {
  test('no row returns null', () => {
    expect(loadCachedTwitchUserToken()).toBeNull();
    expect(loadCachedTwitchBotToken()).toBeNull();
  });

  test('maps access token, refresh token and token type', () => {
    insertTokenRow('twitch', { accessToken: 'aaa', refreshToken: 'rrr', tokenType: 'bearer' });
    const token = loadCachedTwitchUserToken()!;
    expect(token.accessToken).toBe('aaa');
    expect(token.refreshToken).toBe('rrr');
    expect(token.tokenType).toBe('bearer');
  });

  test('a null refresh token stays null', () => {
    insertTokenRow('twitch', { refreshToken: null });
    expect(loadCachedTwitchUserToken()!.refreshToken).toBeNull();
  });

  test('a valid scopes JSON array is parsed', () => {
    insertTokenRow('twitch', { scopesJson: '["a","b","c"]' });
    expect(loadCachedTwitchUserToken()!.scopes).toEqual(['a', 'b', 'c']);
  });

  test('invalid scopes JSON yields [] and does not throw', () => {
    insertTokenRow('twitch', { scopesJson: 'not json{' });
    expect(loadCachedTwitchUserToken()!.scopes).toEqual([]);
  });

  test('a non-array scopes JSON yields []', () => {
    insertTokenRow('twitch', { scopesJson: '{"scope":"a"}' });
    expect(loadCachedTwitchUserToken()!.scopes).toEqual([]);
  });

  test('non-string entries in the scopes array are dropped', () => {
    insertTokenRow('twitch', { scopesJson: '["a",1,null,"b"]' });
    expect(loadCachedTwitchUserToken()!.scopes).toEqual(['a', 'b']);
  });

  test('a null expires_at maps to a null expiresAtMs', () => {
    insertTokenRow('twitch', { expiresAt: null });
    expect(loadCachedTwitchUserToken()!.expiresAtMs).toBeNull();
  });

  test('a valid ISO expires_at maps to epoch milliseconds', () => {
    const t = 1_900_000_000_000;
    insertTokenRow('twitch', { expiresAt: new Date(t).toISOString() });
    expect(loadCachedTwitchUserToken()!.expiresAtMs).toBe(t);
  });

  test('an unparseable expires_at maps to null (Number.isFinite guard)', () => {
    insertTokenRow('twitch', { expiresAt: 'not-a-real-date' });
    expect(loadCachedTwitchUserToken()!.expiresAtMs).toBeNull();
  });

  test('user and bot providers are independent', () => {
    insertTokenRow('twitch', { accessToken: 'user-tok' });
    expect(loadCachedTwitchUserToken()!.accessToken).toBe('user-tok');
    expect(loadCachedTwitchBotToken()).toBeNull();

    db.prepare('delete from twitch_oauth').run();
    insertTokenRow('twitch_bot', { accessToken: 'bot-tok' });
    expect(loadCachedTwitchBotToken()!.accessToken).toBe('bot-tok');
    expect(loadCachedTwitchUserToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hydrateTwitchAuthState
// ---------------------------------------------------------------------------
describe('hydrateTwitchAuthState', () => {
  test('populates both runtime tokens from the DB rows', () => {
    insertTokenRow('twitch', { accessToken: 'user-tok' });
    insertTokenRow('twitch_bot', { accessToken: 'bot-tok' });
    const state = new RuntimeState();
    hydrateTwitchAuthState(state);
    expect(state.runtimeUserToken?.accessToken).toBe('user-tok');
    expect(state.runtimeBotToken?.accessToken).toBe('bot-tok');
  });
});

// ---------------------------------------------------------------------------
// getTwitchUserAccessToken / getTwitchBotAccessToken
// ---------------------------------------------------------------------------
describe('getTwitchAccessToken', () => {
  test('no token returns null', async () => {
    const state = new RuntimeState();
    expect(await getTwitchUserAccessToken(state)).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test('a token with no expiry is returned without refreshing', async () => {
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ accessToken: 'no-expiry', expiresAtMs: null });
    expect(await getTwitchUserAccessToken(state)).toBe('no-expiry');
    expect(fetchCalls.length).toBe(0);
  });

  test('a token expiring outside the buffer is returned directly', async () => {
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ accessToken: 'still-valid', expiresAtMs: Date.now() + 120_000 });
    expect(await getTwitchUserAccessToken(state)).toBe('still-valid');
    expect(fetchCalls.length).toBe(0);
  });

  test('reading from the DB cache assigns the token onto state', async () => {
    const state = new RuntimeState();
    insertTokenRow('twitch', { accessToken: 'from-db', expiresAt: new Date(Date.now() + HOUR).toISOString() });
    expect(await getTwitchUserAccessToken(state)).toBe('from-db');
    expect(state.runtimeUserToken?.accessToken).toBe('from-db');
    expect(fetchCalls.length).toBe(0);
  });

  test('a token inside the buffer refreshes, returns the new token, and updates DB + state', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    insertTokenRow('twitch', { accessToken: 'old', refreshToken: 'the-refresh', scopesJson: '["old"]' });
    state.runtimeUserToken = makeToken({
      accessToken: 'old',
      refreshToken: 'the-refresh',
      scopes: ['old'],
      expiresAtMs: Date.now() + 30_000, // inside the 60s buffer
    });
    fetchHandler = () => jsonResponse({ access_token: 'fresh', refresh_token: 'new-refresh', expires_in: 3600, scope: ['old', 'new'], token_type: 'bearer' });

    const result = await getTwitchUserAccessToken(state);
    expect(result).toBe('fresh');

    const call = onlyTwitchCall();
    expect(call.method).toBe('POST');
    expect(call.url.href).toBe('https://id.twitch.tv/oauth2/token');
    const params = new URLSearchParams(call.body ?? '');
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('the-refresh');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('secret');

    // State and DB both carry the refreshed token now.
    expect(state.runtimeUserToken?.accessToken).toBe('fresh');
    expect(state.runtimeUserToken?.refreshToken).toBe('new-refresh');
    expect(loadCachedTwitchUserToken()?.accessToken).toBe('fresh');
  });

  test('a user refresh invalidates the cached sender identity and clears the Twitch caches', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    // Stale sender identity + populated caches from the prior token must not survive
    // a re-auth: persistTwitchToken's user branch nulls the sender identity and
    // invalidates the caches so nothing keyed to the old token is reused.
    state.twitchSenderId = 'stale';
    state.twitchSenderLogin = 'stale-login';
    state.twitchStreamStatusCache = {
      expiresAtMs: Date.now() + HOUR,
      status: { streamActive: true, uptimeSeconds: 1, streamStartedAt: null, uptimeSource: 'twitch', viewerCount: 3 },
    };
    state.twitchAdScheduleCache = {
      expiresAtMs: Date.now() + HOUR,
      schedule: {
        adScheduleStatus: 'available',
        adScheduleError: null,
        nextAdAt: null,
        lastAdAt: null,
        adBreakDurationSeconds: null,
        prerollFreeTimeSeconds: null,
        snoozeCount: null,
        snoozeRefreshAt: null,
      },
    };
    fetchHandler = () => jsonResponse({ access_token: 'fresh', expires_in: 3600 });

    expect(await getTwitchUserAccessToken(state)).toBe('fresh');
    expect(state.twitchSenderId).toBeNull();
    expect(state.twitchSenderLogin).toBeNull();
    expect(state.twitchStreamStatusCache).toBeNull();
    expect(state.twitchAdScheduleCache).toBeNull();
  });

  test('a refresh response without scope falls back to the old scopes', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', scopes: ['kept-scope'], expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => jsonResponse({ access_token: 'fresh', expires_in: 3600 });

    expect(await getTwitchUserAccessToken(state)).toBe('fresh');
    expect(state.runtimeUserToken?.scopes).toEqual(['kept-scope']);
  });

  test('a refresh response without refresh_token keeps the prior refresh token', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'prior-refresh', expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => jsonResponse({ access_token: 'fresh', expires_in: 3600 });

    await getTwitchUserAccessToken(state);
    expect(state.runtimeUserToken?.refreshToken).toBe('prior-refresh');
  });

  test('a tiny expires_in still yields at least a 60s lifetime', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    const before = Date.now();
    fetchHandler = () => jsonResponse({ access_token: 'fresh', expires_in: 5 });

    await getTwitchUserAccessToken(state);
    const expiresAtMs = state.runtimeUserToken!.expiresAtMs!;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  test('an expiring token with no refresh token returns null', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: null, expiresAtMs: Date.now() - 1000 });
    expect(await getTwitchUserAccessToken(state)).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test('a non-ok refresh response returns null and does not throw', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => jsonResponse({ error: 'invalid_grant', message: 'bad' }, 400);
    expect(await getTwitchUserAccessToken(state)).toBeNull();
  });

  test('a refresh response missing access_token returns null', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => jsonResponse({ expires_in: 3600 });
    expect(await getTwitchUserAccessToken(state)).toBeNull();
  });

  test('a thrown refresh fetch returns null', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => { throw new Error('network down'); };
    expect(await getTwitchUserAccessToken(state)).toBeNull();
  });

  test('a missing client id skips the refresh and returns null', async () => {
    seedConfig({ clientId: '', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    expect(await getTwitchUserAccessToken(state)).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test('a missing client secret skips the refresh and returns null', async () => {
    seedConfig({ clientId: 'cid', clientSecret: '' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ refreshToken: 'r', expiresAtMs: Date.now() - 1000 });
    expect(await getTwitchUserAccessToken(state)).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test('the bot account refreshes and persists independently of the user account', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    state.runtimeBotToken = makeToken({ accessToken: 'bot-old', refreshToken: 'bot-refresh', expiresAtMs: Date.now() - 1000 });
    fetchHandler = () => jsonResponse({ access_token: 'bot-fresh', expires_in: 3600 });

    expect(await getTwitchBotAccessToken(state)).toBe('bot-fresh');
    expect(state.runtimeBotToken?.accessToken).toBe('bot-fresh');
    expect(loadCachedTwitchBotToken()?.accessToken).toBe('bot-fresh');
    expect(loadCachedTwitchUserToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTwitchAuthStatus / getTwitchAccountAuthStatus
// ---------------------------------------------------------------------------
describe('getTwitchAuthStatus', () => {
  test('unauthenticated reports every field empty', () => {
    const state = new RuntimeState();
    const status = getTwitchAuthStatus(state);
    expect(status.twitchAuthenticated).toBe(false);
    expect(status.twitchAuthSource).toBeNull();
    expect(status.twitchTokenExpiresAt).toBeNull();
    expect(status.twitchMissingScopes).toEqual([]);
    expect(status.twitchBotAuthenticated).toBe(false);
    expect(status.twitchBotAuthSource).toBeNull();
    expect(status.twitchBotTokenExpiresAt).toBeNull();
    expect(status.twitchBotMissingScopes).toEqual([]);
  });

  test('authenticated reports oauth, ISO expiry, and the missing required scopes', () => {
    const state = new RuntimeState();
    const expiresAtMs = Date.now() + HOUR;
    // Grant every required scope except the first, so exactly one is missing.
    const granted = REQUIRED_TWITCH_OAUTH_SCOPES.slice(1);
    state.runtimeUserToken = makeToken({ scopes: [...granted], expiresAtMs });

    const status = getTwitchAuthStatus(state);
    expect(status.twitchAuthenticated).toBe(true);
    expect(status.twitchAuthSource).toBe('oauth');
    expect(status.twitchTokenExpiresAt).toBe(new Date(expiresAtMs).toISOString());
    expect(status.twitchMissingScopes).toEqual([REQUIRED_TWITCH_OAUTH_SCOPES[0]]);
  });

  test('an authenticated token with no expiry reports a null tokenExpiresAt', () => {
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ scopes: [...REQUIRED_TWITCH_OAUTH_SCOPES], expiresAtMs: null });
    const status = getTwitchAuthStatus(state);
    expect(status.twitchAuthenticated).toBe(true);
    expect(status.twitchTokenExpiresAt).toBeNull();
    expect(status.twitchMissingScopes).toEqual([]);
  });

  test('the bot account uses its own (smaller) required-scope set', () => {
    const state = new RuntimeState();
    // The bot only needs chat scopes; grant them and nothing is missing even though
    // it lacks the many user scopes.
    state.runtimeBotToken = makeToken({ scopes: [...REQUIRED_TWITCH_BOT_OAUTH_SCOPES] });
    const status = getTwitchAuthStatus(state);
    expect(status.twitchBotAuthenticated).toBe(true);
    expect(status.twitchBotMissingScopes).toEqual([]);

    // A bot token missing a chat scope reports exactly that gap.
    state.runtimeBotToken = makeToken({ scopes: [REQUIRED_TWITCH_BOT_OAUTH_SCOPES[0]] });
    expect(getTwitchAuthStatus(state).twitchBotMissingScopes).toEqual([REQUIRED_TWITCH_BOT_OAUTH_SCOPES[1]]);
  });

  test('reads from the DB cache and assigns the token onto state', () => {
    const state = new RuntimeState();
    insertTokenRow('twitch', { scopesJson: JSON.stringify([...REQUIRED_TWITCH_OAUTH_SCOPES]) });
    expect(state.runtimeUserToken).toBeNull();
    const status = getTwitchAuthStatus(state);
    expect(status.twitchAuthenticated).toBe(true);
    expect(state.runtimeUserToken).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerTwitchAuthRoutes — express route tests
// ---------------------------------------------------------------------------
type Deps = {
  connectEventSub: ReturnType<typeof mock>;
  disconnectEventSub: ReturnType<typeof mock>;
  resolveAccountIdentity: ReturnType<typeof mock>;
  onResolvedChannelChanged: ReturnType<typeof mock>;
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    connectEventSub: mock(() => {}),
    disconnectEventSub: mock(() => {}),
    resolveAccountIdentity: mock(async () => ({ id: 'uid', login: 'streamer' })),
    onResolvedChannelChanged: mock(() => {}),
    ...overrides,
  };
}

async function startApp(state: RuntimeState, deps: Deps): Promise<number> {
  const app = express();
  app.use(express.json());
  registerTwitchAuthRoutes({ app, state, ...deps });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  activeServer = server;
  return (server.address() as AddressInfo).port;
}

describe('GET /api/auth/twitch (start login)', () => {
  test('without a configured client id returns 500', async () => {
    seedConfig({ clientId: '' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch`, { redirect: 'manual' });
    expect(res.status).toBe(500);
  });

  test('redirects to the Twitch authorize URL with the user scope set and sets the state cookie', async () => {
    seedConfig({ clientId: 'my-client' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch`, { redirect: 'manual' });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('my-client');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/twitch/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe(REQUIRED_TWITCH_OAUTH_SCOPES.join(' '));
    expect(location.searchParams.get('state')).toMatch(/^user:/);
    expect(location.searchParams.get('force_verify')).toBeNull();

    // The state cookie must be locked down: HttpOnly (no JS read), SameSite=Lax
    // (not sent on cross-site top-level POSTs), scoped to the callback path only,
    // and short-lived. A mutation dropping any of these must fail here.
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('streamer_tools_twitch_oauth_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/auth/twitch/callback');
    expect(setCookie).toContain('Max-Age=');
  });

  test('force=1 adds force_verify=true', async () => {
    seedConfig({ clientId: 'my-client' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch?force=1`, { redirect: 'manual' });
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('force_verify')).toBe('true');
  });

  test('the bot login uses the bot scope set and a bot: state prefix', async () => {
    seedConfig({ clientId: 'my-client' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch/bot`, { redirect: 'manual' });
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('scope')).toBe(REQUIRED_TWITCH_BOT_OAUTH_SCOPES.join(' '));
    expect(location.searchParams.get('state')).toMatch(/^bot:/);
  });
});

describe('GET /api/auth/twitch/callback', () => {
  const STATE_COOKIE = 'streamer_tools_twitch_oauth_state';

  async function callback(port: number, opts: { query: string; cookie?: string }) {
    const headers: Record<string, string> = {};
    if (opts.cookie !== undefined) headers['Cookie'] = `${STATE_COOKIE}=${opts.cookie}`;
    return fetch(`http://127.0.0.1:${port}/api/auth/twitch/callback?${opts.query}`, {
      redirect: 'manual',
      headers,
    });
  }

  test('an error query param returns 400', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'error=access_denied&state=user:s', cookie: 's' });
    expect(res.status).toBe(400);
  });

  test('a missing code returns 400', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'state=user:s', cookie: 's' });
    expect(res.status).toBe(400);
  });

  test('a missing client secret returns 500', async () => {
    seedConfig({ clientId: 'cid', clientSecret: '' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'code=abc&state=user:s', cookie: 's' });
    expect(res.status).toBe(500);
  });

  test('a state that does not match the cookie returns 400 invalid state', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'code=abc&state=user:one', cookie: 'two' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid state');
  });

  test('a missing cookie returns 400 invalid state', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'code=abc&state=user:one' });
    expect(res.status).toBe(400);
  });

  test('an unrecognized account segment returns 400', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const port = await startApp(new RuntimeState(), makeDeps());
    const res = await callback(port, { query: 'code=abc&state=bogus:s', cookie: 's' });
    expect(res.status).toBe(400);
  });

  test('the happy user path exchanges the code, persists the token, resolves identity, reconnects EventSub, and redirects to /', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    const deps = makeDeps();
    const port = await startApp(state, deps);
    fetchHandler = () => jsonResponse({ access_token: 'user-token', refresh_token: 'user-refresh', expires_in: 3600, scope: ['a'], token_type: 'bearer' });

    const res = await callback(port, { query: 'code=the-code&state=user:s', cookie: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    // The code exchange request shape.
    const call = onlyTwitchCall();
    expect(call.method).toBe('POST');
    expect(call.url.href).toBe('https://id.twitch.tv/oauth2/token');
    const params = new URLSearchParams(call.body ?? '');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('secret');
    expect(params.get('redirect_uri')).toBe('http://localhost:5173/api/auth/twitch/callback');

    // Token row written and state populated.
    expect(loadCachedTwitchUserToken()?.accessToken).toBe('user-token');
    expect(state.runtimeUserToken?.accessToken).toBe('user-token');

    // Identity resolved with the configured client id + the new token.
    expect(deps.resolveAccountIdentity).toHaveBeenCalledWith('cid', 'user-token');
    // Fresh login -> channel changed -> reconcile fired.
    expect(deps.onResolvedChannelChanged).toHaveBeenCalledTimes(1);
    // EventSub torn down then reconnected.
    expect(deps.disconnectEventSub).toHaveBeenCalledTimes(1);
    expect(deps.connectEventSub).toHaveBeenCalledTimes(1);
  });

  test('a user callback whose identity resolves to null still logs in and reconnects EventSub', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    // resolveAccountIdentity returning null (as opposed to throwing) makes
    // captureAccountIdentity return false, but the login must still succeed.
    const deps = makeDeps({ resolveAccountIdentity: mock(async () => null) });
    const port = await startApp(state, deps);
    fetchHandler = () => jsonResponse({ access_token: 'user-token', refresh_token: 'user-refresh', expires_in: 3600, scope: ['a'] });

    const res = await callback(port, { query: 'code=the-code&state=user:s', cookie: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    // The token is still persisted even though the identity lookup came back empty.
    expect(loadCachedTwitchUserToken()?.accessToken).toBe('user-token');
    expect(state.runtimeUserToken?.accessToken).toBe('user-token');

    expect(deps.resolveAccountIdentity).toHaveBeenCalledWith('cid', 'user-token');
    // captureAccountIdentity returned false -> no channel-changed reconcile.
    expect(deps.onResolvedChannelChanged).not.toHaveBeenCalled();
    // EventSub is still torn down and reconnected for the newly granted scopes.
    expect(deps.disconnectEventSub).toHaveBeenCalledTimes(1);
    expect(deps.connectEventSub).toHaveBeenCalledTimes(1);
  });

  test('the user path does not fire onResolvedChannelChanged when the login is unchanged', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    // Establish the current identity as "streamer" first.
    insertTokenRow('twitch');
    setTwitchIdentity('user', { userId: 'uid', login: 'streamer' });
    const state = new RuntimeState();
    const deps = makeDeps({ resolveAccountIdentity: mock(async () => ({ id: 'uid', login: 'streamer' })) });
    const port = await startApp(state, deps);
    fetchHandler = () => jsonResponse({ access_token: 'user-token', expires_in: 3600, scope: ['a'] });

    const res = await callback(port, { query: 'code=the-code&state=user:s', cookie: 's' });
    expect(res.status).toBe(302);
    expect(deps.onResolvedChannelChanged).not.toHaveBeenCalled();
    // EventSub still reconnects even when the channel did not change.
    expect(deps.disconnectEventSub).toHaveBeenCalledTimes(1);
    expect(deps.connectEventSub).toHaveBeenCalledTimes(1);
  });

  test('the happy bot path persists the bot token, redirects, and never touches EventSub', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    const deps = makeDeps();
    const port = await startApp(state, deps);
    fetchHandler = () => jsonResponse({ access_token: 'bot-token', refresh_token: 'bot-refresh', expires_in: 3600, scope: ['a'] });

    const res = await callback(port, { query: 'code=the-code&state=bot:s', cookie: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    expect(loadCachedTwitchBotToken()?.accessToken).toBe('bot-token');
    expect(state.runtimeBotToken?.accessToken).toBe('bot-token');
    expect(loadCachedTwitchUserToken()).toBeNull();

    expect(deps.resolveAccountIdentity).toHaveBeenCalledWith('cid', 'bot-token');
    expect(deps.onResolvedChannelChanged).not.toHaveBeenCalled();
    expect(deps.disconnectEventSub).not.toHaveBeenCalled();
    expect(deps.connectEventSub).not.toHaveBeenCalled();
  });

  test('a non-ok token exchange returns 500 and writes no token', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const state = new RuntimeState();
    const port = await startApp(state, makeDeps());
    fetchHandler = () => jsonResponse({ error: 'invalid_grant', message: 'bad code' }, 400);

    const res = await callback(port, { query: 'code=the-code&state=user:s', cookie: 's' });
    expect(res.status).toBe(500);
    expect(loadCachedTwitchUserToken()).toBeNull();
    expect(state.runtimeUserToken).toBeNull();
  });

  test('a thrown error during the flow returns 500', async () => {
    seedConfig({ clientId: 'cid', clientSecret: 'secret' });
    const deps = makeDeps({ resolveAccountIdentity: mock(async () => { throw new Error('lookup exploded'); }) });
    const port = await startApp(new RuntimeState(), deps);
    fetchHandler = () => jsonResponse({ access_token: 'user-token', expires_in: 3600, scope: ['a'] });

    const res = await callback(port, { query: 'code=the-code&state=user:s', cookie: 's' });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Internal error');
  });
});

describe('GET /api/auth/twitch/status', () => {
  test('returns the current auth status as JSON', async () => {
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken({ scopes: [...REQUIRED_TWITCH_OAUTH_SCOPES], expiresAtMs: null });
    const port = await startApp(state, makeDeps());
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.twitchAuthenticated).toBe(true);
    expect(body.twitchAuthSource).toBe('oauth');
    expect(body.twitchBotAuthenticated).toBe(false);
  });
});

describe('DELETE /api/auth/twitch', () => {
  test('deletes the user row, clears state and identity, reconciles, disconnects, and reports unauthenticated', async () => {
    insertTokenRow('twitch');
    setTwitchIdentity('user', { userId: 'uid', login: 'streamer' });
    const state = new RuntimeState();
    state.runtimeUserToken = makeToken();
    state.broadcasterId = 'bid';
    const deps = makeDeps();
    const port = await startApp(state, deps);

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.twitchAuthenticated).toBe(false);

    expect(loadCachedTwitchUserToken()).toBeNull();
    expect(state.runtimeUserToken).toBeNull();
    expect(state.broadcasterId).toBeNull();
    expect(deps.onResolvedChannelChanged).toHaveBeenCalledTimes(1);
    expect(deps.disconnectEventSub).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/auth/twitch/bot', () => {
  test('deletes the bot row, clears bot state, and reports the status without touching EventSub', async () => {
    insertTokenRow('twitch_bot');
    const state = new RuntimeState();
    state.runtimeBotToken = makeToken();
    const deps = makeDeps();
    const port = await startApp(state, deps);

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/twitch/bot`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.twitchBotAuthenticated).toBe(false);

    expect(loadCachedTwitchBotToken()).toBeNull();
    expect(state.runtimeBotToken).toBeNull();
    expect(deps.onResolvedChannelChanged).not.toHaveBeenCalled();
    expect(deps.disconnectEventSub).not.toHaveBeenCalled();
  });
});
