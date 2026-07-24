import { beforeEach, describe, expect, test } from 'bun:test';
import type express from 'express';
import {
  APP_API_PREFIX,
  appFromRequest,
  getOverlayToken,
  isOverlayEvent,
  requireAppToken,
  requireDashboardToken,
  roleForToken,
  webSocketRole,
} from './auth';
import { createApp, hashAppToken, mintAppToken, revokeAppToken, setAppDisabled } from './apps';
import { db } from './db';
import { INVALID_DASHBOARD_TOKEN } from '../shared/api';
import { config, isLoopbackHost } from './config';

const OPERATOR = 'operator-secret-token';

function setToken(token: string) {
  config.dashboardToken = token;
}

// config.dashboardToken is read from the environment at import, and `bun test`
// loads .env — so an operator who has a token configured would otherwise see these
// tests fail. Establish the no-token baseline before each test rather than assuming
// a clean environment; tests that need a token call setToken().
beforeEach(() => {
  config.dashboardToken = '';
});

type RouteCall = { status: number | null; body: unknown; nextCalled: boolean };

// Drive the middleware with a minimal request/response pair.
function callMiddleware(options: {
  method?: string;
  path?: string;
  token?: string | null;
}): RouteCall {
  const call: RouteCall = { status: null, body: null, nextCalled: false };
  const request = {
    method: options.method ?? 'GET',
    baseUrl: '/api',
    path: (options.path ?? '/health').replace(/^\/api/, ''),
    headers: {},
    query: options.token ? { token: options.token } : {},
  } as unknown as express.Request;
  const response = {
    status(code: number) {
      call.status = code;
      return this;
    },
    json(body: unknown) {
      call.body = body;
      return this;
    },
  } as unknown as express.Response;
  requireDashboardToken(request, response, () => { call.nextCalled = true; });
  return call;
}

describe('roleForToken', () => {
  test('treats every caller as operator when no token is configured', () => {
    expect(roleForToken(null)).toBe('operator');
  });

  test('resolves the configured token to operator', () => {
    setToken(OPERATOR);
    expect(roleForToken(OPERATOR)).toBe('operator');
  });

  test('resolves the derived overlay token to overlay', () => {
    setToken(OPERATOR);
    expect(roleForToken(getOverlayToken())).toBe('overlay');
  });

  test('rejects an unknown or missing token', () => {
    setToken(OPERATOR);
    expect(roleForToken('nope')).toBeNull();
    expect(roleForToken(null)).toBeNull();
  });

  test('the overlay token is not the operator token', () => {
    setToken(OPERATOR);
    expect(getOverlayToken()).not.toBe(OPERATOR);
  });
});

describe('requireDashboardToken', () => {
  test('rejects a request with no token', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/health' });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
  });

  // Routes 401 for their own reasons ("Twitch login is required."), so a bare 401
  // cannot tell the client its dashboard token is the thing that is wrong. The code
  // is what lets the client clear a stale token without nuking a good one.
  test('tags a rejected dashboard token with a machine-readable code', () => {
    setToken(OPERATOR);
    expect(callMiddleware({ path: '/api/health' }).body).toEqual({
      error: 'Unauthorized',
      code: INVALID_DASHBOARD_TOKEN,
    });
    expect(callMiddleware({ path: '/api/health', token: 'stale-token' }).body).toEqual({
      error: 'Unauthorized',
      code: INVALID_DASHBOARD_TOKEN,
    });
  });

  test('does not tag an overlay token rejection as a bad dashboard token', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'PUT', path: '/api/config', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.body).not.toMatchObject({ code: INVALID_DASHBOARD_TOKEN });
  });

  test('lets the operator token through to a destructive route', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'PUT', path: '/api/config', token: OPERATOR });
    expect(call.nextCalled).toBe(true);
  });

  test('lets the overlay token read an allowlisted route', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/chat/recent', token: getOverlayToken()! });
    expect(call.nextCalled).toBe(true);
  });

  test('blocks the overlay token from writing credentials', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'PUT', path: '/api/config', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.nextCalled).toBe(false);
  });

  test('blocks the overlay token from reading a non-allowlisted route', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/twitch/rewards', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.nextCalled).toBe(false);
  });

  test('blocks the overlay token from a POST to an allowlisted read path', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'POST', path: '/api/sounds', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.nextCalled).toBe(false);
  });

  test('lets the overlay token read wind-down state', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/wind-down', token: getOverlayToken()! });
    expect(call.nextCalled).toBe(true);
  });

  // A browser source that could PUT here would switch wind-down on for every other
  // source and rewrite the operator's Twitch title.
  test('blocks the overlay token from switching wind-down on', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'PUT', path: '/api/wind-down', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.nextCalled).toBe(false);
  });

  test('blocks the overlay token from reading wind-down settings', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/wind-down/settings', token: getOverlayToken()! });
    expect(call.status).toBe(403);
  });

  test('exempts the OAuth callback, which cannot carry our token', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/auth/twitch/callback' });
    expect(call.nextCalled).toBe(true);
  });
});

type AppRouteCall = RouteCall & { resolvedApp: { id: string; name: string } | null };

// Drive requireAppToken, which is mounted per-route on /api/ext/* rather than at /api.
function callAppMiddleware(options: {
  method?: string;
  path?: string;
  token?: string | null;
}): AppRouteCall {
  const call: AppRouteCall = { status: null, body: null, nextCalled: false, resolvedApp: null };
  const fullPath = options.path ?? '/api/ext/rewards';
  const request = {
    method: options.method ?? 'POST',
    baseUrl: '',
    path: fullPath,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    query: {},
  } as unknown as express.Request;
  const response = {
    status(code: number) {
      call.status = code;
      return this;
    },
    json(body: unknown) {
      call.body = body;
      return this;
    },
  } as unknown as express.Response;
  requireAppToken(request, response, () => { call.nextCalled = true; });
  call.resolvedApp = appFromRequest(request);
  return call;
}

describe('requireAppToken', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('a valid app token resolves to its app', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    const token = mintAppToken(app.id);
    const call = callAppMiddleware({ token });
    expect(call.nextCalled).toBe(true);
    expect(call.status).toBeNull();
    expect(call.resolvedApp?.id).toBe(app.id);
    expect(call.resolvedApp?.name).toBe('extapp');
  });

  // Pasting the dashboard token into an app's config is a realistic operator error.
  // It must fail closed rather than depend on that token happening not to be a hash
  // in apps.token_hash.
  test('rejects the operator token', () => {
    setToken(OPERATOR);
    createApp('extapp');
    const call = callAppMiddleware({ token: OPERATOR });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
    expect(call.resolvedApp).toBeNull();
  });

  test('rejects the overlay token', () => {
    setToken(OPERATOR);
    createApp('extapp');
    const call = callAppMiddleware({ token: getOverlayToken()! });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
    expect(call.resolvedApp).toBeNull();
  });

  // The rejections above would also pass "by accident" — neither token is normally a
  // hash in apps.token_hash. These force the coincidence: an operator who pastes the
  // dashboard token into an app's config must be refused by the EXPLICIT check, not
  // by luck. Delete that check and only these two fail.
  test('rejects the operator token even when it is genuinely an app token', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    db.prepare('update apps set token_hash = ? where id = ?').run(hashAppToken(OPERATOR), app.id);
    const call = callAppMiddleware({ token: OPERATOR });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
    expect(call.resolvedApp).toBeNull();
  });

  test('rejects the overlay token even when it is genuinely an app token', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    const overlay = getOverlayToken()!;
    db.prepare('update apps set token_hash = ? where id = ?').run(hashAppToken(overlay), app.id);
    const call = callAppMiddleware({ token: overlay });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
    expect(call.resolvedApp).toBeNull();
  });

  test('rejects a disabled app', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    const token = mintAppToken(app.id);
    setAppDisabled(app.id, true);
    const call = callAppMiddleware({ token });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
    expect(call.resolvedApp).toBeNull();
  });

  test('rejects a revoked app token', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    const token = mintAppToken(app.id);
    revokeAppToken(app.id);
    const call = callAppMiddleware({ token });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
  });

  // token_hash is SQL NULL after a revoke, so nothing a caller can present matches
  // it — but an empty presented token must be refused before the lookup regardless.
  test('rejects a missing or empty token, and an empty token never matches a revoked app', () => {
    setToken(OPERATOR);
    const app = createApp('extapp');
    mintAppToken(app.id);
    revokeAppToken(app.id);
    expect(callAppMiddleware({ token: null }).status).toBe(401);
    expect(callAppMiddleware({ token: '' }).status).toBe(401);
    expect(callAppMiddleware({ token: null }).nextCalled).toBe(false);
    expect(callAppMiddleware({ token: '' }).nextCalled).toBe(false);
  });

  test('rejects an unknown token', () => {
    setToken(OPERATOR);
    createApp('extapp');
    const call = callAppMiddleware({ token: 'narya_app_not-a-real-token' });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
  });

  // No token configured means the server is loopback-only, which makes every caller
  // the OPERATOR — it must not also make every caller a valid app. /api/ext/ is
  // about *which app* is acting, so it still demands a real app token.
  test('an unconfigured dashboard token does not turn every caller into an app', () => {
    config.dashboardToken = '';
    const app = createApp('extapp');
    const token = mintAppToken(app.id);
    expect(callAppMiddleware({ token: null }).status).toBe(401);
    expect(callAppMiddleware({ token: 'anything' }).status).toBe(401);
    // ...and a real app token still resolves in loopback mode.
    const ok = callAppMiddleware({ token });
    expect(ok.nextCalled).toBe(true);
    expect(ok.resolvedApp?.id).toBe(app.id);
  });

  // A 401 that says *why* tells an attacker whether a guessed token is well-formed,
  // belongs to a real app, or belongs to a disabled one.
  test('every rejection is an identical bare 401 that never echoes the token', () => {
    setToken(OPERATOR);
    const disabled = createApp('disabledapp');
    const disabledToken = mintAppToken(disabled.id);
    setAppDisabled(disabled.id, true);
    const revoked = createApp('revokedapp');
    const revokedToken = mintAppToken(revoked.id);
    revokeAppToken(revoked.id);
    const bodies = [
      callAppMiddleware({ token: null }),
      callAppMiddleware({ token: OPERATOR }),
      callAppMiddleware({ token: getOverlayToken()! }),
      callAppMiddleware({ token: 'narya_app_unknown' }),
      callAppMiddleware({ token: disabledToken }),
      callAppMiddleware({ token: revokedToken }),
    ];
    for (const call of bodies) {
      expect(call.status).toBe(401);
      expect(call.body).toEqual({ error: 'Unauthorized' });
    }
    const serialized = JSON.stringify(bodies.map(c => c.body));
    expect(serialized).not.toContain(OPERATOR);
    expect(serialized).not.toContain(getOverlayToken()!);
    expect(serialized).not.toContain(disabledToken);
    expect(serialized).not.toContain(revokedToken);
  });
});

describe('operator/app mutual exclusion', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('an app token is rejected on an operator route', () => {
    setToken(OPERATOR);
    const token = mintAppToken(createApp('extapp').id);
    const call = callMiddleware({ path: '/api/twitch/rewards', token });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
  });

  test('an app token is rejected on an overlay-allowlisted route', () => {
    setToken(OPERATOR);
    const token = mintAppToken(createApp('extapp').id);
    const call = callMiddleware({ path: '/api/chat/recent', token });
    expect(call.status).toBe(401);
    expect(call.nextCalled).toBe(false);
  });

  test('roleForToken resolves an app token to no role at all', () => {
    setToken(OPERATOR);
    const token = mintAppToken(createApp('extapp').id);
    expect(roleForToken(token)).toBeNull();
  });
});

describe('the /api/ext prefix', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('is exactly /api/ext/', () => {
    expect(APP_API_PREFIX).toBe('/api/ext/');
  });

  test('requireDashboardToken defers /api/ext/* to requireAppToken', () => {
    setToken(OPERATOR);
    expect(callMiddleware({ method: 'POST', path: '/api/ext/rewards' }).nextCalled).toBe(true);
    const token = mintAppToken(createApp('extapp').id);
    expect(callMiddleware({ method: 'POST', path: '/api/ext/rewards', token }).nextCalled).toBe(true);
  });

  // THE PREFIX TRAP: '/api/apps/x'.startsWith('/api/app') is true, so a skip check
  // one character short would hand the operator's own app registry — including token
  // minting — to an app token or to no token at all.
  test('does NOT skip the operator app registry at /api/apps', () => {
    setToken(OPERATOR);
    const token = mintAppToken(createApp('extapp').id);
    const registryPaths = [
      '/api/apps',
      '/api/apps/some-id',
      '/api/apps/some-id/token',
      '/api/apps/some-id/events',
    ];
    for (const path of registryPaths) {
      expect(callMiddleware({ method: 'POST', path }).status).toBe(401);
      expect(callMiddleware({ method: 'POST', path }).nextCalled).toBe(false);
      expect(callMiddleware({ method: 'POST', path, token }).status).toBe(401);
      expect(callMiddleware({ method: 'POST', path, token }).nextCalled).toBe(false);
      // The registry is operator-only, and stays reachable by the operator.
      expect(callMiddleware({ method: 'POST', path, token: OPERATOR }).nextCalled).toBe(true);
    }
  });

  // The trailing slash also stops a sibling path from inheriting the skip.
  test('does not skip a path that merely starts with /api/ext', () => {
    setToken(OPERATOR);
    for (const path of ['/api/ext', '/api/extras', '/api/external']) {
      const call = callMiddleware({ method: 'POST', path });
      expect(call.status).toBe(401);
      expect(call.nextCalled).toBe(false);
    }
  });
});

describe('webSocketRole', () => {
  test('rejects a socket with no token', () => {
    setToken(OPERATOR);
    expect(webSocketRole('/socket')).toBeNull();
  });

  test('classifies operator and overlay sockets', () => {
    setToken(OPERATOR);
    expect(webSocketRole(`/socket?token=${OPERATOR}`)).toBe('operator');
    expect(webSocketRole(`/socket?token=${getOverlayToken()}`)).toBe('overlay');
  });
});

describe('overlay event scope', () => {
  test('overlay connections receive what they render', () => {
    expect(isOverlayEvent('chat:message')).toBe(true);
    expect(isOverlayEvent('overlay:text')).toBe(true);
    expect(isOverlayEvent('media:play')).toBe(true);
  });

  test('overlay connections never receive private or control-plane events', () => {
    expect(isOverlayEvent('whisper:message')).toBe(false);
    expect(isOverlayEvent('dashboard:status')).toBe(false);
    expect(isOverlayEvent('automod:held')).toBe(false);
    expect(isOverlayEvent('settings:updated')).toBe(false);
  });

  // The countdown overlay is a browser source and cannot authenticate, so it must be
  // able to receive this. The payload carries no operator configuration — see
  // getWindDownPublicState.
  test('overlay connections receive wind-down updates', () => {
    expect(isOverlayEvent('winddown:updated')).toBe(true);
  });
});

describe('isLoopbackHost', () => {
  test('recognizes loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  test('treats a wildcard or LAN bind as non-loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
  });
});
