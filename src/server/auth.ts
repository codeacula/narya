import crypto from 'crypto';
import type express from 'express';
import { INVALID_DASHBOARD_TOKEN } from '../shared/api';
import { config } from './config';

// Two capabilities share one secret. The operator token (DASHBOARD_TOKEN) is
// full control. The overlay token is derived from it and is read-only over a
// small allowlist — it exists because an OBS browser source URL is a long-lived,
// plainly-visible credential (it sits in OBS's config, in screenshots, in scene
// collections that get shared), so it must not be able to ban a viewer, rewrite
// credentials, or read whispers.
export type AuthRole = 'operator' | 'overlay';

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

function extractToken(request: express.Request): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token) return token;
  }
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
