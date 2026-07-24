import crypto from 'crypto';
import type express from 'express';
import { INVALID_DASHBOARD_TOKEN, type App } from '../shared/api';
import { findAppByTokenHash, hashAppToken } from './apps';
import { config } from './config';

// Two capabilities share one secret. The operator token (DASHBOARD_TOKEN) is
// full control. The overlay token is derived from it and is read-only over a
// small allowlist — it exists because an OBS browser source URL is a long-lived,
// plainly-visible credential (it sits in OBS's config, in screenshots, in scene
// collections that get shared), so it must not be able to ban a viewer, rewrite
// credentials, or read whispers.
export type AuthRole = 'operator' | 'overlay';

// The app-token surface. Deliberately NOT '/api/app/': the operator's app registry
// is '/api/apps/', and '/api/apps/x'.startsWith('/api/app') is true, so a prefix
// check one character short would skip the operator guard on the registry itself —
// handing app management, including token minting, to an app token or to no token.
// The trailing slash is load-bearing for the same reason ('/api/extras').
export const APP_API_PREFIX = '/api/ext/';

// External OAuth redirects can't carry our token, so they're exempt. The Twitch
// callback is already protected by its state cookie; the Discord callback
// likewise completes an operator-initiated flow.
const EXEMPT_PATHS = new Set([
  '/api/auth/twitch/callback',
  '/api/auth/discord/callback',
]);

// Everything the overlay browser sources read at startup. GET only — the
// overlay never writes. Keep in sync with the fetches in src/client/pages/Overlay.tsx
// and the hooks it mounts.
const OVERLAY_PATHS = new Set([
  '/api/health',
  '/api/chat/recent',
  '/api/emotes',
  '/api/music/current',
  '/api/sounds',
  '/api/clips',
  '/api/stream-status',
  '/api/dashboard/session-shoutouts',
  // Read-only, and GET-only by the rule above: an overlay learns whether to draw its
  // bounds, and cannot turn the boxes on for every other source.
  '/api/overlay/placeholders',
  // The countdown overlay seeds itself from this. GET only by the rule above, so a
  // browser source can read that the stream is winding down but never declare it.
  // /api/wind-down/settings is deliberately absent — it is operator configuration.
  '/api/wind-down',
]);

// Events an overlay connection is allowed to receive. Everything else — whispers,
// dashboard heartbeats, AutoMod holds, settings changes, OBS/reward state — stays
// on operator connections.
const OVERLAY_EVENTS = new Set([
  'chat:message',
  'chat:moderated',
  'music:updated',
  'sound:play',
  'media:play',
  'tts:speak',
  'overlay:text',
  'stream:event',
  'stream:event:update',
  'status:updated',
  // Carries one boolean (draw your bounds or don't) — no operator configuration.
  'overlay:placeholders',
  // An active flag, a source, and the planned end time — no operator configuration.
  // The stored base title is deliberately not on this payload.
  'winddown:updated',
]);

// Derived rather than separately configured so the operator has exactly one
// secret to manage. Rotating DASHBOARD_TOKEN rotates the overlay token with it.
export function getOverlayToken(): string | null {
  if (!config.dashboardToken) return null;
  return crypto
    .createHmac('sha256', config.dashboardToken)
    .update('narya:overlay:v1')
    .digest('hex')
    .slice(0, 32);
}

/** The Authorization bearer header and nothing else. Split out because the app
 *  surface accepts only this transport — see requireAppToken. */
function bearerToken(request: express.Request): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return null;
}

function extractToken(request: express.Request): string | null {
  const bearer = bearerToken(request);
  if (bearer) return bearer;
  const headerToken = request.headers['x-dashboard-token'];
  if (typeof headerToken === 'string' && headerToken) return headerToken;
  // Query param is needed for <a href> OAuth links and OBS browser sources.
  const queryToken = request.query['token'];
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; bail early (still constant-time
  // within a given expected length).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Resolve a presented token to the capability it carries, or null if it carries
// none. With no token configured the server is loopback-only (enforced at
// startup), so every caller is the operator.
export function roleForToken(provided: string | null): AuthRole | null {
  if (!config.dashboardToken) return 'operator';
  if (!provided) return null;
  if (tokensMatch(provided, config.dashboardToken)) return 'operator';
  const overlay = getOverlayToken();
  if (overlay && tokensMatch(provided, overlay)) return 'overlay';
  return null;
}

export function isOverlayEvent(event: string): boolean {
  return OVERLAY_EVENTS.has(event);
}

// Express middleware guarding /api/*.
export function requireDashboardToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
) {
  // Mounted at '/api', so reconstruct the full path for the exempt/allowlist checks.
  const fullPath = request.baseUrl + request.path;
  if (EXEMPT_PATHS.has(fullPath)) {
    next();
    return;
  }
  // Delegated to requireAppToken, which index.ts mounts ONCE on the whole prefix
  // (app.use('/api/ext', requireAppToken)) before any ext route is registered.
  // Skipping here is safe ONLY because of that: guarding the prefix rather than each
  // route is what makes an unguarded /api/ext route impossible to add.
  if (fullPath.startsWith(APP_API_PREFIX)) {
    next();
    return;
  }
  const role = roleForToken(extractToken(request));
  if (role === 'operator') {
    next();
    return;
  }
  if (role === 'overlay') {
    if (request.method === 'GET' && OVERLAY_PATHS.has(fullPath)) {
      next();
      return;
    }
    response.status(403).json({ error: 'Forbidden: overlay token' });
    return;
  }
  // The code says "the token you presented is the problem" — a bare 401 is
  // ambiguous with the routes that 401 over a missing *Twitch* login, and the
  // client uses that distinction to decide whether to discard its stored token.
  response.status(401).json({ error: 'Unauthorized', code: INVALID_DASHBOARD_TOKEN });
}

// Express already owns `request.app` — it is the Application instance, and the
// `req.ip`, `req.protocol`, `req.hostname` and `req.subdomains` getters all call
// `this.app.get(...)`. The resolved app therefore rides on its own property rather
// than shadowing it.
export type AppAuthedRequest = express.Request & { naryaApp?: App };

/** The app a /api/ext/* request authenticated as, or null on any other request. */
export function appFromRequest(request: express.Request): App | null {
  return (request as AppAuthedRequest).naryaApp ?? null;
}

/**
 * Guards /api/ext/*. A presented token resolves to a registered, ENABLED app or the
 * request is refused. Three things this does deliberately:
 *
 *  - An operator or overlay token is rejected EXPLICITLY, not incidentally. Pasting
 *    the dashboard token into an app's config is a realistic operator error, and it
 *    must fail closed instead of depending on that token happening not to be a hash
 *    in apps.token_hash.
 *  - roleForToken is never consulted, so the loopback-only mode (no DASHBOARD_TOKEN
 *    configured, every caller is the operator) does not make every caller a valid
 *    app. This surface is about *which app* is acting; that needs a real app token.
 *  - Every rejection is the same bare 401. Saying which check failed would tell a
 *    caller whether a guessed token is well-formed, belongs to a real app, or
 *    belongs to a disabled one. The presented token is never echoed or logged.
 *  - The BEARER HEADER ONLY, not extractToken's full set. `?token=` exists for OBS
 *    browser sources and `x-dashboard-token` for the dashboard's own fetches; a
 *    server-side app is neither, and a credential in a URL ends up in access logs,
 *    proxy logs and Referer headers. requireDashboardToken keeps all three.
 */
export function requireAppToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
) {
  const provided = bearerToken(request);
  if (!provided) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (config.dashboardToken && tokensMatch(provided, config.dashboardToken)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const overlay = getOverlayToken();
  if (overlay && tokensMatch(provided, overlay)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // A revoked app stores SQL NULL, which no hash can equal, so a revoked token
  // falls out here as an unknown one.
  const app = findAppByTokenHash(hashAppToken(provided));
  if (!app || app.disabledAt) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (request as AppAuthedRequest).naryaApp = app;
  next();
}

// The capability a WebSocket connection URL carries, or null to reject it.
export function webSocketRole(requestUrl: string | undefined): AuthRole | null {
  if (!config.dashboardToken) return 'operator';
  try {
    const parsed = new URL(requestUrl ?? '', 'http://localhost');
    return roleForToken(parsed.searchParams.get('token'));
  } catch {
    return null;
  }
}
