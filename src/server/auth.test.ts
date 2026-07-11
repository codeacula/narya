import { beforeEach, describe, expect, test } from 'bun:test';
import type express from 'express';
import {
  getOverlayToken,
  isOverlayEvent,
  requireDashboardToken,
  roleForToken,
  webSocketRole,
} from './auth';
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

  test('exempts the OAuth callback, which cannot carry our token', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/auth/twitch/callback' });
    expect(call.nextCalled).toBe(true);
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
