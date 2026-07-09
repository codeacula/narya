import type express from 'express';
import { TOKEN_EXPIRY_REFRESH_BUFFER_MS } from '../../shared/constants';
import { appConfig } from '../appConfig';
import { config } from '../config';
import { db } from '../db';
import { parseCookies } from '../http';
import type { RuntimeState, TwitchTokenResponse, TwitchUserToken } from '../runtime';

export const REQUIRED_TWITCH_OAUTH_SCOPES = [
  'moderator:read:followers',
  'moderator:read:chatters',
  'channel:read:subscriptions',
  'bits:read',
  'channel:manage:redemptions',
  'channel:read:ads',
  'channel:edit:commercial',
  'channel:manage:broadcast',
  'moderator:manage:banned_users',
  'moderator:manage:automod',
  'moderator:manage:shoutouts',
  'user:read:chat',
  'user:write:chat',
  'user:manage:whispers',
  'user:read:whispers',
] as const;

export const REQUIRED_TWITCH_BOT_OAUTH_SCOPES = [
  'user:read:chat',
  'user:write:chat',
] as const;

type TwitchAuthAccount = 'user' | 'bot';

const TWITCH_AUTH_PROVIDERS: Record<TwitchAuthAccount, string> = {
  user: 'twitch',
  bot: 'twitch_bot',
};

const TWITCH_AUTH_SCOPES: Record<TwitchAuthAccount, readonly string[]> = {
  user: REQUIRED_TWITCH_OAUTH_SCOPES,
  bot: REQUIRED_TWITCH_BOT_OAUTH_SCOPES,
};

const loadTwitchToken = db.prepare(`
  select access_token as accessToken,
         refresh_token as refreshToken,
         scopes_json as scopesJson,
         token_type as tokenType,
         expires_at as expiresAt
  from twitch_oauth
  where provider = ?
`);

const saveTwitchToken = db.prepare(`
  insert into twitch_oauth (provider, access_token, refresh_token, scopes_json, token_type, expires_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?)
  on conflict(provider) do update set
    access_token = excluded.access_token,
    refresh_token = excluded.refresh_token,
    scopes_json = excluded.scopes_json,
    token_type = excluded.token_type,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
`);

const deleteTwitchToken = db.prepare(`delete from twitch_oauth where provider = ?`);
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

function loadCachedTwitchToken(account: TwitchAuthAccount): TwitchUserToken | null {
  const row = loadTwitchToken.get(TWITCH_AUTH_PROVIDERS[account]) as {
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

export function loadCachedTwitchUserToken(): TwitchUserToken | null {
  return loadCachedTwitchToken('user');
}

export function loadCachedTwitchBotToken(): TwitchUserToken | null {
  return loadCachedTwitchToken('bot');
}

export function hydrateTwitchAuthState(state: RuntimeState) {
  state.runtimeUserToken = loadCachedTwitchUserToken();
  state.runtimeBotToken = loadCachedTwitchBotToken();
}

function persistTwitchToken(
  account: TwitchAuthAccount,
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
    TWITCH_AUTH_PROVIDERS[account],
    token.accessToken,
    token.refreshToken,
    JSON.stringify(token.scopes),
    token.tokenType,
    new Date(expiresAtMs).toISOString(),
    new Date().toISOString(),
  );

  if (account === 'bot') {
    state.runtimeBotToken = token;
    state.twitchBotSenderId = null;
    state.twitchBotLogin = null;
  } else {
    state.runtimeUserToken = token;
    state.twitchSenderId = null;
    state.twitchSenderLogin = null;
    state.clearTwitchCaches();
  }
  return token;
}

function persistTwitchUserToken(
  state: RuntimeState,
  tokenData: Required<Pick<TwitchTokenResponse, 'access_token'>> & TwitchTokenResponse,
  fallbackRefreshToken: string | null = null,
): TwitchUserToken {
  return persistTwitchToken('user', state, tokenData, fallbackRefreshToken);
}

function persistTwitchBotToken(
  state: RuntimeState,
  tokenData: Required<Pick<TwitchTokenResponse, 'access_token'>> & TwitchTokenResponse,
  fallbackRefreshToken: string | null = null,
): TwitchUserToken {
  return persistTwitchToken('bot', state, tokenData, fallbackRefreshToken);
}

async function refreshTwitchToken(account: TwitchAuthAccount, state: RuntimeState, token: TwitchUserToken): Promise<TwitchUserToken | null> {
  const clientId = appConfig.twitchClientId;
  const clientSecret = appConfig.twitchClientSecret;
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
      console.error(`OAuth: ${account} token refresh failed: ${tokenData.message ?? tokenData.error ?? tokenRes.statusText}`);
      return null;
    }

    return persistTwitchToken(account, state, {
      ...tokenData,
      access_token: tokenData.access_token,
      scope: tokenData.scope ?? token.scopes,
    }, token.refreshToken);
  } catch (error) {
    console.error(`OAuth: ${account} token refresh errored:`, error);
    return null;
  }
}

async function getTwitchAccessToken(account: TwitchAuthAccount, state: RuntimeState): Promise<string | null> {
  const token = account === 'bot'
    ? state.runtimeBotToken ?? loadCachedTwitchBotToken()
    : state.runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    if (account === 'bot') state.runtimeBotToken = token;
    else state.runtimeUserToken = token;
    if (!token.expiresAtMs || token.expiresAtMs > Date.now() + TOKEN_EXPIRY_REFRESH_BUFFER_MS) {
      return token.accessToken;
    }

    const refreshed = await refreshTwitchToken(account, state, token);
    return refreshed?.accessToken ?? null;
  }

  if (account === 'user') return process.env.TWITCH_USER_TOKEN ?? null;
  return process.env.TWITCH_BOT_USER_TOKEN ?? null;
}

export async function getTwitchUserAccessToken(state: RuntimeState): Promise<string | null> {
  return getTwitchAccessToken('user', state);
}

export async function getTwitchBotAccessToken(state: RuntimeState): Promise<string | null> {
  return getTwitchAccessToken('bot', state);
}

function getTwitchAccountAuthStatus(
  account: TwitchAuthAccount,
  state: RuntimeState,
): {
  authenticated: boolean;
  authSource: 'oauth' | 'env' | null;
  tokenExpiresAt: string | null;
  missingScopes: string[];
} {
  const token = account === 'bot'
    ? state.runtimeBotToken ?? loadCachedTwitchBotToken()
    : state.runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    if (account === 'bot') state.runtimeBotToken = token;
    else state.runtimeUserToken = token;
    return {
      authenticated: true,
      authSource: 'oauth' as const,
      tokenExpiresAt: token.expiresAtMs ? new Date(token.expiresAtMs).toISOString() : null,
      missingScopes: TWITCH_AUTH_SCOPES[account].filter(scope => !token.scopes.includes(scope)),
    };
  }

  const envToken = account === 'bot' ? process.env.TWITCH_BOT_USER_TOKEN : process.env.TWITCH_USER_TOKEN;
  return {
    authenticated: Boolean(envToken),
    authSource: envToken ? 'env' as const : null,
    tokenExpiresAt: null,
    missingScopes: [],
  };
}

export function getTwitchAuthStatus(state: RuntimeState) {
  const user = getTwitchAccountAuthStatus('user', state);
  const bot = getTwitchAccountAuthStatus('bot', state);
  return {
    twitchAuthenticated: user.authenticated,
    twitchAuthSource: user.authSource,
    twitchTokenExpiresAt: user.tokenExpiresAt,
    twitchMissingScopes: user.missingScopes,
    twitchBotAuthenticated: bot.authenticated,
    twitchBotAuthSource: bot.authSource,
    twitchBotTokenExpiresAt: bot.tokenExpiresAt,
    twitchBotMissingScopes: bot.missingScopes,
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
  function startTwitchLogin(account: TwitchAuthAccount, request: express.Request, response: express.Response) {
    const clientId = appConfig.twitchClientId;
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
      scope: TWITCH_AUTH_SCOPES[account].join(' '),
      state: `${account}:${oauthState}`,
    });
    if (request.query['force'] === '1') {
      params.set('force_verify', 'true');
    }
    response.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  }

  app.get('/api/auth/twitch', (request, response) => {
    startTwitchLogin('user', request, response);
  });

  app.get('/api/auth/twitch/bot', (request, response) => {
    startTwitchLogin('bot', request, response);
  });

  app.get('/api/auth/twitch/callback', async (request, response) => {
    const clientId = appConfig.twitchClientId;
    const clientSecret = appConfig.twitchClientSecret;
    const code = request.query['code'] as string | undefined;
    const error = request.query['error'] as string | undefined;
    const oauthStateParam = request.query['state'] as string | undefined;
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
    const [accountValue, oauthState] = oauthStateParam?.split(':', 2) ?? [];
    const account = accountValue === 'bot' ? 'bot' : accountValue === 'user' ? 'user' : null;
    if (!account || !oauthState || !expectedState || oauthState !== expectedState) {
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
      if (account === 'bot') {
        persistTwitchBotToken(state, { ...tokenData, access_token: tokenData.access_token });
        console.log('OAuth: bot token cached.');
      } else {
        persistTwitchUserToken(state, { ...tokenData, access_token: tokenData.access_token });
        console.log('OAuth: user token cached, reconnecting EventSub...');
        connectEventSub();
      }
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
    deleteTwitchToken.run(TWITCH_AUTH_PROVIDERS.user);
    state.clearAuthenticatedUserState();
    disconnectEventSub();
    response.json({ ok: true, ...getTwitchAuthStatus(state) });
  });

  app.delete('/api/auth/twitch/bot', (_request, response) => {
    deleteTwitchToken.run(TWITCH_AUTH_PROVIDERS.bot);
    state.clearAuthenticatedBotState();
    response.json({ ok: true, ...getTwitchAuthStatus(state) });
  });
}
