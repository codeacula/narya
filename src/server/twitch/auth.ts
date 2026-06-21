import type express from 'express';
import { TOKEN_EXPIRY_REFRESH_BUFFER_MS } from '../../shared/constants';
import { config } from '../config';
import { db } from '../db';
import { parseCookies } from '../http';
import type { RuntimeState, TwitchTokenResponse, TwitchUserToken } from '../runtime';

export const REQUIRED_TWITCH_OAUTH_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'channel:read:ads',
  'channel:edit:commercial',
  'channel:manage:broadcast',
  'user:read:chat',
  'user:write:chat',
] as const;

const loadTwitchToken = db.prepare(`
  select access_token as accessToken,
         refresh_token as refreshToken,
         scopes_json as scopesJson,
         token_type as tokenType,
         expires_at as expiresAt
  from twitch_oauth
  where provider = 'twitch'
`);

const saveTwitchToken = db.prepare(`
  insert into twitch_oauth (provider, access_token, refresh_token, scopes_json, token_type, expires_at, updated_at)
  values ('twitch', ?, ?, ?, ?, ?, ?)
  on conflict(provider) do update set
    access_token = excluded.access_token,
    refresh_token = excluded.refresh_token,
    scopes_json = excluded.scopes_json,
    token_type = excluded.token_type,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
`);

const deleteTwitchToken = db.prepare(`delete from twitch_oauth where provider = 'twitch'`);
const TWITCH_OAUTH_SCOPES = REQUIRED_TWITCH_OAUTH_SCOPES.join(' ');
const twitchOAuthStateCookie = 'streamer_tools_twitch_oauth_state';

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    console.error('OAuth: failed to parse cached scopes JSON:', error);
    return [];
  }
}

export function loadCachedTwitchUserToken(): TwitchUserToken | null {
  const row = loadTwitchToken.get() as {
    accessToken: string;
    refreshToken: string | null;
    scopesJson: string | null;
    tokenType: string | null;
    expiresAt: string | null;
  } | null;

  if (!row?.accessToken) return null;
  const expiresAtMs = row.expiresAt ? new Date(row.expiresAt).getTime() : null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    scopes: parseJsonArray(row.scopesJson),
    tokenType: row.tokenType,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

export function hydrateTwitchAuthState(state: RuntimeState) {
  state.runtimeUserToken = loadCachedTwitchUserToken();
}

function persistTwitchUserToken(
  state: RuntimeState,
  tokenData: Required<Pick<TwitchTokenResponse, 'access_token'>> & TwitchTokenResponse,
  fallbackRefreshToken: string | null = null,
): TwitchUserToken {
  const expiresAtMs = Date.now() + Math.max(60, tokenData.expires_in ?? 3600) * 1000;
  const token: TwitchUserToken = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? fallbackRefreshToken,
    scopes: tokenData.scope ?? [],
    tokenType: tokenData.token_type ?? null,
    expiresAtMs,
  };

  saveTwitchToken.run(
    token.accessToken,
    token.refreshToken,
    JSON.stringify(token.scopes),
    token.tokenType,
    new Date(expiresAtMs).toISOString(),
    new Date().toISOString(),
  );

  state.runtimeUserToken = token;
  state.twitchSenderId = null;
  state.clearTwitchCaches();
  return token;
}

async function refreshTwitchUserToken(state: RuntimeState, token: TwitchUserToken): Promise<TwitchUserToken | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret || !token.refreshToken) return null;

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }),
    });

    const tokenData = await tokenRes.json() as TwitchTokenResponse;
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error(`OAuth: token refresh failed: ${tokenData.message ?? tokenData.error ?? tokenRes.statusText}`);
      return null;
    }

    return persistTwitchUserToken(state, {
      ...tokenData,
      access_token: tokenData.access_token,
      scope: tokenData.scope ?? token.scopes,
    }, token.refreshToken);
  } catch (error) {
    console.error('OAuth: token refresh errored:', error);
    return null;
  }
}

export async function getTwitchUserAccessToken(state: RuntimeState): Promise<string | null> {
  const token = state.runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    state.runtimeUserToken = token;
    if (!token.expiresAtMs || token.expiresAtMs > Date.now() + TOKEN_EXPIRY_REFRESH_BUFFER_MS) {
      return token.accessToken;
    }

    const refreshed = await refreshTwitchUserToken(state, token);
    return refreshed?.accessToken ?? null;
  }

  return process.env.TWITCH_USER_TOKEN ?? null;
}

export function getTwitchAuthStatus(state: RuntimeState) {
  const token = state.runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    state.runtimeUserToken = token;
    return {
      twitchAuthenticated: true,
      twitchAuthSource: 'oauth' as const,
      twitchTokenExpiresAt: token.expiresAtMs ? new Date(token.expiresAtMs).toISOString() : null,
      twitchMissingScopes: REQUIRED_TWITCH_OAUTH_SCOPES.filter(scope => !token.scopes.includes(scope)),
    };
  }

  return {
    twitchAuthenticated: Boolean(process.env.TWITCH_USER_TOKEN),
    twitchAuthSource: process.env.TWITCH_USER_TOKEN ? 'env' as const : null,
    twitchTokenExpiresAt: null,
    twitchMissingScopes: [],
  };
}

export function registerTwitchAuthRoutes({
  app,
  state,
  connectEventSub,
  disconnectEventSub,
}: {
  app: express.Express;
  state: RuntimeState;
  connectEventSub: () => void;
  disconnectEventSub: () => void;
}) {
  app.get('/api/auth/twitch', (request, response) => {
    const clientId = process.env.TWITCH_CLIENT_ID ?? '';
    if (!clientId) {
      response.status(500).send('TWITCH_CLIENT_ID not configured');
      return;
    }
    const oauthState = crypto.randomUUID();
    response.cookie(twitchOAuthStateCookie, oauthState, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      maxAge: 10 * 60 * 1000,
      path: '/api/auth/twitch/callback',
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: config.twitchRedirectUri,
      response_type: 'code',
      scope: TWITCH_OAUTH_SCOPES,
      state: oauthState,
    });
    if (request.query['force'] === '1') {
      params.set('force_verify', 'true');
    }
    response.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  });

  app.get('/api/auth/twitch/callback', async (request, response) => {
    const clientId = process.env.TWITCH_CLIENT_ID ?? '';
    const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
    const code = request.query['code'] as string | undefined;
    const error = request.query['error'] as string | undefined;
    const oauthState = request.query['state'] as string | undefined;
    const expectedState = parseCookies(request.headers.cookie)[twitchOAuthStateCookie];

    response.clearCookie(twitchOAuthStateCookie, { path: '/api/auth/twitch/callback' });

    if (error || !code) {
      response.status(400).send(`Twitch OAuth error: ${error ?? 'missing code'}`);
      return;
    }
    if (!clientSecret) {
      response.status(500).send('TWITCH_CLIENT_SECRET not configured');
      return;
    }
    if (!oauthState || !expectedState || oauthState !== expectedState) {
      response.status(400).send('Twitch OAuth error: invalid state');
      return;
    }

    try {
      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.twitchRedirectUri,
        }),
      });
      const tokenData = await tokenRes.json() as TwitchTokenResponse;
      if (!tokenRes.ok || !tokenData.access_token) {
        response.status(500).send(`Token exchange failed: ${tokenData.message ?? tokenData.error ?? tokenRes.statusText}`);
        return;
      }
      persistTwitchUserToken(state, { ...tokenData, access_token: tokenData.access_token });
      console.log('OAuth: user token cached, reconnecting EventSub...');
      connectEventSub();
      response.redirect('/');
    } catch (err) {
      console.error('OAuth callback error:', err);
      response.status(500).send('Internal error during token exchange');
    }
  });

  app.get('/api/auth/twitch/status', (_request, response) => {
    response.json(getTwitchAuthStatus(state));
  });

  app.delete('/api/auth/twitch', (_request, response) => {
    deleteTwitchToken.run();
    state.clearAuthenticatedUserState();
    disconnectEventSub();
    response.json({ ok: true, ...getTwitchAuthStatus(state) });
  });
}
