import crypto from 'crypto';
import type express from 'express';
import { config } from './config';

// External OAuth redirects can't carry our token, so they're exempt. The Twitch
// callback is already protected by its state cookie; the Discord callback
// likewise completes an operator-initiated flow.
const EXEMPT_PATHS = new Set([
  '/api/auth/twitch/callback',
  '/api/auth/discord/callback',
]);

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

// Express middleware guarding /api/*. No-op when no token is configured.
export function requireDashboardToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
) {
  if (!config.dashboardToken) {
    next();
    return;
  }
  // Mounted at '/api', so reconstruct the full path for the exempt check.
  const fullPath = request.baseUrl + request.path;
  if (EXEMPT_PATHS.has(fullPath)) {
    next();
    return;
  }
  const provided = extractToken(request);
  if (provided && tokensMatch(provided, config.dashboardToken)) {
    next();
    return;
  }
  response.status(401).json({ error: 'Unauthorized' });
}

// Whether a WS connection URL carries a valid token. Always true when no token
// is configured.
export function isWebSocketTokenValid(requestUrl: string | undefined): boolean {
  if (!config.dashboardToken) return true;
  try {
    const parsed = new URL(requestUrl ?? '', 'http://localhost');
    const token = parsed.searchParams.get('token');
    return token != null && tokensMatch(token, config.dashboardToken);
  } catch {
    return false;
  }
}
