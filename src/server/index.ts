import { connectTwitchChat, getSessionChatterCount, getTwitchRoomId, twitchClient } from './chat';
import { config } from './config';
import { addColumnIfMissing, db } from './db';
import { getEmoteMap } from './emotes';
import { HttpRouteError, parseCookies, readResponseError, sendRouteError } from './http';
import { clearManualMusic, getCurrentMusic, setManualMusic, startMusicPolling } from './music';
import { getObsDashboardStats, isObsConnected, switchObsScene, triggerObsTransition } from './obs';
import { app, broadcast, getSocketCount, server } from './realtime';
import { triggerQuackSound } from './sounds';

const {
  port,
  twitchChannel,
  twitchRedirectUri,
} = config;

const serverStartedAt = Date.now();

addColumnIfMissing('chat_messages', 'deleted_at', 'text');
addColumnIfMissing('chat_messages', 'deleted_reason', 'text');
addColumnIfMissing('chat_messages', 'moderation_event_id', 'text');
addColumnIfMissing('chat_messages', 'badges_json', 'text');
addColumnIfMissing('chat_messages', 'emotes_json', 'text');

type TwitchUserToken = {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  tokenType: string | null;
  expiresAtMs: number | null;
};

type TwitchTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
  token_type?: string;
  error?: string;
  message?: string;
};

const REQUIRED_TWITCH_OAUTH_SCOPES = [
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

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function loadCachedTwitchUserToken(): TwitchUserToken | null {
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

let runtimeUserToken: TwitchUserToken | null = loadCachedTwitchUserToken();
let twitchAppToken: { accessToken: string; expiresAtMs: number } | null = null;

function persistTwitchUserToken(tokenData: Required<Pick<TwitchTokenResponse, 'access_token'>> & TwitchTokenResponse, fallbackRefreshToken: string | null = null): TwitchUserToken {
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

  runtimeUserToken = token;
  twitchStreamStatusCache = null;
  twitchAdScheduleCache = null;
  twitchSenderId = null;
  return token;
}

async function refreshTwitchUserToken(token: TwitchUserToken): Promise<TwitchUserToken | null> {
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

    return persistTwitchUserToken({
      ...tokenData,
      access_token: tokenData.access_token,
      scope: tokenData.scope ?? token.scopes,
    }, token.refreshToken);
  } catch (error) {
    console.error('OAuth: token refresh errored:', error);
    return null;
  }
}

async function getTwitchUserAccessToken(): Promise<string | null> {
  const token = runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    runtimeUserToken = token;
    if (!token.expiresAtMs || token.expiresAtMs > Date.now() + 60_000) {
      return token.accessToken;
    }

    const refreshed = await refreshTwitchUserToken(token);
    return refreshed?.accessToken ?? null;
  }

  return process.env.TWITCH_USER_TOKEN ?? null;
}

async function getEventSubCredentials(): Promise<{ clientId: string; userToken: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = await getTwitchUserAccessToken();
  if (!clientId || !userToken) return null;
  return { clientId, userToken };
}

async function getTwitchApiHeaders(): Promise<{ 'Client-Id': string; Authorization: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  if (!clientId) return null;

  const userToken = await getTwitchUserAccessToken();
  if (userToken) {
    return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}` };
  }

  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
  if (!clientSecret) return null;

  if (twitchAppToken && twitchAppToken.expiresAtMs > Date.now() + 60_000) {
    return { 'Client-Id': clientId, Authorization: `Bearer ${twitchAppToken.accessToken}` };
  }

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; expires_in?: number; error?: string };
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error(`Twitch API: app token request failed: ${tokenData.error ?? tokenRes.statusText}`);
      return null;
    }

    twitchAppToken = {
      accessToken: tokenData.access_token,
      expiresAtMs: Date.now() + Math.max(60, tokenData.expires_in ?? 3600) * 1000,
    };

    return { 'Client-Id': clientId, Authorization: `Bearer ${twitchAppToken.accessToken}` };
  } catch (error) {
    console.error('Twitch API: app token request errored:', error);
    return null;
  }
}

async function getTwitchUserApiHeaders(): Promise<{ 'Client-Id': string; Authorization: string; userToken: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = await getTwitchUserAccessToken();
  if (!clientId || !userToken) return null;
  return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}`, userToken };
}

// ─── EventSub ─────────────────────────────────────────────────────────────

let eventSubWs: WebSocket | null = null;
let eventSubConnected = false;
let broadcasterId: string | null = null;
let twitchSenderId: string | null = null;
let eventSubKeepaliveMs = 20_000;
let eventSubKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let adBreakEndsAt: string | null = null;

const insertStreamEvent = db.prepare(`
  insert or ignore into stream_events (id, kind, actor, detail, tone, received_at)
  values (?, ?, ?, ?, ?, ?)
`);

function emitStreamEvent(kind: string, actor: string, detail: string, tone: string) {
  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  insertStreamEvent.run(id, kind, actor, detail, tone, receivedAt);
  broadcast('stream:event', { id, kind, actor, detail, tone, ago: 'just now', receivedAt });
}

function tierLabel(tier: string): string {
  if (tier === '2000') return 'Tier 2';
  if (tier === '3000') return 'Tier 3';
  return 'Tier 1';
}

function handleEventSubNotification(type: string, event: Record<string, unknown>) {
  switch (type) {
    case 'channel.follow':
      emitStreamEvent('follow', event.user_name as string, 'followed', 'silver');
      break;
    case 'channel.subscribe':
      if (!(event.is_gift as boolean)) {
        emitStreamEvent('sub', event.user_name as string,
          `subscribed · ${tierLabel(event.tier as string)}`, 'warning');
      }
      break;
    case 'channel.subscription.message':
      emitStreamEvent('sub', event.user_name as string,
        `resubscribed · ${event.cumulative_months} months · ${tierLabel(event.tier as string)}`, 'warning');
      break;
    case 'channel.subscription.gift':
      emitStreamEvent('gift',
        (event.user_name as string) || 'Anonymous',
        `gifted ${event.total} sub${(event.total as number) !== 1 ? 's' : ''} to the channel`, 'warning');
      break;
    case 'channel.cheer':
      emitStreamEvent('cheer',
        (event.user_name as string) || 'Anonymous',
        `cheered ${event.bits} bits`, 'info');
      break;
    case 'channel.raid':
      emitStreamEvent('raid',
        event.from_broadcaster_user_name as string,
        `raided with ${event.viewers} viewer${(event.viewers as number) !== 1 ? 's' : ''}`, 'note');
      break;
    case 'channel.channel_points_custom_reward_redemption.add':
      emitStreamEvent('redeem',
        event.user_name as string,
        `redeemed "${(event.reward as { title: string }).title}"`, 'info');
      break;
    case 'channel.ad_break.begin': {
      const durationSecs = event.duration_seconds as number;
      const startedAt = new Date(event.started_at as string);
      adBreakEndsAt = new Date(startedAt.getTime() + durationSecs * 1000).toISOString();
      twitchAdScheduleCache = null;
      emitStreamEvent('redeem', 'Twitch', `ad break · ${durationSecs}s`, 'info');
      break;
    }
    case 'channel.chat.notification': {
      const noticeType = event.notice_type as string;
      if (noticeType === 'watch_streak') {
        const streak = event.watch_streak as { cumulative_months: number };
        emitStreamEvent('redeem',
          event.chatter_user_name as string,
          `watch streak · ${streak.cumulative_months} month${streak.cumulative_months !== 1 ? 's' : ''}`, 'silver');
      }
      break;
    }
  }
}

async function fetchBroadcasterId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(twitchChannel)}`,
      { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchAuthenticatedTwitchUserId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function createEventSubSubscription(
  clientId: string, userToken: string, sessionId: string,
  type: string, version: string, condition: Record<string, string>
) {
  try {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } })
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`EventSub: failed to subscribe to ${type} (${res.status}):`, text);
    }
  } catch (err) {
    console.error(`EventSub: error subscribing to ${type}:`, err);
  }
}

async function subscribeToAllEvents(clientId: string, userToken: string, sessionId: string, bid: string) {
  const subs: Array<[string, string, Record<string, string>]> = [
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: bid }],
    ['channel.chat.notification', '1', { broadcaster_user_id: bid, user_id: bid }],
  ];
  for (const [type, version, condition] of subs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }
  console.log('EventSub: all subscriptions created');
}

function clearKeepaliveTimer() {
  if (eventSubKeepaliveTimer !== null) {
    clearTimeout(eventSubKeepaliveTimer);
    eventSubKeepaliveTimer = null;
  }
}

function resetKeepaliveTimer() {
  clearKeepaliveTimer();
  eventSubKeepaliveTimer = setTimeout(() => {
    console.log('EventSub: keepalive timeout, reconnecting...');
    void connectEventSub();
  }, eventSubKeepaliveMs);
}

async function connectEventSub(reconnectUrl?: string) {
  const creds = await getEventSubCredentials();
  if (!creds) {
    console.log('EventSub: no credentials configured, skipping');
    return;
  }

  if (!reconnectUrl && eventSubWs) {
    try { eventSubWs.close(); } catch {}
    eventSubWs = null;
  }
  eventSubConnected = false;

  const ws = new WebSocket(reconnectUrl ?? 'wss://eventsub.wss.twitch.tv/ws');
  eventSubWs = ws;

  ws.addEventListener('open', () => {
    console.log('EventSub: WebSocket connected');
  });

  ws.addEventListener('message', (evt) => {
    if (typeof evt.data !== 'string') return;

    type EventSubMsg = {
      metadata: { message_type: string };
      payload: {
        session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
        subscription?: { type: string };
        event?: Record<string, unknown>;
      };
    };

    let msg: EventSubMsg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    const msgType = msg.metadata.message_type;

    if (msgType === 'session_welcome') {
      const session = msg.payload.session!;
      eventSubConnected = true;
      eventSubKeepaliveMs = (session.keepalive_timeout_seconds + 10) * 1000;
      resetKeepaliveTimer();
      console.log(`EventSub: session ${session.id} established`);

      if (!reconnectUrl) {
        void (async () => {
          if (!broadcasterId) {
            broadcasterId = await fetchBroadcasterId(creds.clientId, creds.userToken);
          }
          if (broadcasterId) {
            await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, broadcasterId);
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${twitchChannel}"`);
          }
        })();
      }

    } else if (msgType === 'session_keepalive') {
      resetKeepaliveTimer();

    } else if (msgType === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url;
      if (newUrl) {
        console.log('EventSub: reconnecting to new URL...');
        const staleWs = ws;
        void connectEventSub(newUrl);
        setTimeout(() => { try { staleWs.close(); } catch {} }, 30_000);
      }

    } else if (msgType === 'notification') {
      const subType = msg.payload.subscription?.type ?? '';
      const event = msg.payload.event ?? {};
      handleEventSubNotification(subType, event);

    } else if (msgType === 'revocation') {
      const sub = msg.payload.subscription as { type?: string; status?: string } | undefined;
      console.warn('EventSub: subscription revoked:', sub?.type, sub?.status);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (ws !== eventSubWs) return;
    eventSubConnected = false;
    clearKeepaliveTimer();
    console.log(`EventSub: disconnected (code ${(evt as CloseEvent).code}), retrying in 10s...`);
    setTimeout(() => { void connectEventSub(); }, 10_000);
  });

  ws.addEventListener('error', () => {
    console.error('EventSub: WebSocket error');
  });
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, twitchChannel, obsConnected: isObsConnected(), twitchRoomId: getTwitchRoomId(), eventSubConnected });
});

const TWITCH_OAUTH_SCOPES = REQUIRED_TWITCH_OAUTH_SCOPES.join(' ');

const twitchOAuthStateCookie = 'streamer_tools_twitch_oauth_state';

function getTwitchAuthStatus() {
  const token = runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) {
    runtimeUserToken = token;
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

app.get('/api/auth/twitch', (request, response) => {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  if (!clientId) {
    response.status(500).send('TWITCH_CLIENT_ID not configured');
    return;
  }
  const state = crypto.randomUUID();
  response.cookie(twitchOAuthStateCookie, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.secure,
    maxAge: 10 * 60 * 1000,
    path: '/api/auth/twitch/callback',
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: twitchRedirectUri,
    response_type: 'code',
    scope: TWITCH_OAUTH_SCOPES,
    state,
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
  const state = request.query['state'] as string | undefined;
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
  if (!state || !expectedState || state !== expectedState) {
    response.status(400).send('Twitch OAuth error: invalid state');
    return;
  }

  const redirectUri = twitchRedirectUri;

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json() as TwitchTokenResponse;
    if (!tokenRes.ok || !tokenData.access_token) {
      response.status(500).send(`Token exchange failed: ${tokenData.message ?? tokenData.error ?? tokenRes.statusText}`);
      return;
    }
    persistTwitchUserToken({ ...tokenData, access_token: tokenData.access_token });
    console.log('OAuth: user token cached, reconnecting EventSub...');
    void connectEventSub();
    response.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err);
    response.status(500).send('Internal error during token exchange');
  }
});

app.get('/api/auth/twitch/status', (_request, response) => {
  response.json(getTwitchAuthStatus());
});

app.delete('/api/auth/twitch', (_request, response) => {
  deleteTwitchToken.run();
  runtimeUserToken = null;
  broadcasterId = null;
  twitchSenderId = null;
  twitchStreamStatusCache = null;
  twitchAdScheduleCache = null;
  if (eventSubWs) {
    try { eventSubWs.close(); } catch {}
    eventSubWs = null;
  }
  eventSubConnected = false;
  clearKeepaliveTimer();
  response.json({ ok: true, ...getTwitchAuthStatus() });
});

app.get('/api/twitch/stream-info', async (_request, response) => {
  try {
    const credentials = await getTwitchActionCredentials([]);
    const res = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
    );

    if (!res.ok) {
      const message = await readResponseError(res, 'Twitch channel information is unavailable.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
    }

    const data = await res.json() as {
      data?: Array<{
        broadcaster_name?: string;
        game_id?: string;
        game_name?: string;
        title?: string;
        tags?: string[];
      }>;
    };
    const channel = data.data?.[0];
    if (!channel) throw new HttpRouteError(404, `No Twitch channel information found for "${twitchChannel}".`);

    response.json({
      broadcasterName: channel.broadcaster_name ?? twitchChannel,
      categoryId: channel.game_id ?? '',
      category: channel.game_name ?? '',
      title: channel.title ?? '',
      tags: normalizeTags(channel.tags ?? []),
    });
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.get('/api/twitch/category-suggestions', async (request, response) => {
  try {
    const query = typeof request.query['query'] === 'string' ? request.query['query'].trim() : '';
    if (query.length < 2) {
      response.json([]);
      return;
    }

    const headers = await getTwitchApiHeaders();
    if (!headers) throw new HttpRouteError(401, 'Twitch API credentials are required.');

    const categories = await searchTwitchCategories(query, {
      clientId: headers['Client-Id'],
      authorization: headers.Authorization,
    });
    response.json(categories);
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.get('/api/twitch/tag-suggestions', async (request, response) => {
  try {
    const query = typeof request.query['query'] === 'string' ? request.query['query'].trim() : '';
    const credentials = await getTwitchActionCredentials([]);
    const res = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
    );

    if (!res.ok) {
      const message = await readResponseError(res, 'Twitch channel tags are unavailable.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
    }

    const data = await res.json() as { data?: Array<{ tags?: string[] }> };
    const existingTags = normalizeTags(data.data?.[0]?.tags ?? []);
    const candidate = normalizeTwitchTagCandidate(query);
    const suggestions = new Set<string>();
    const lowerQuery = candidate.toLowerCase();

    for (const tag of existingTags) {
      if (!lowerQuery || tag.toLowerCase().includes(lowerQuery)) suggestions.add(tag);
    }
    if (candidate) suggestions.add(candidate);

    response.json([...suggestions].slice(0, 8));
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.patch('/api/twitch/stream-info', async (request, response) => {
  try {
    const body = request.body as { title?: unknown; category?: unknown; tags?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const tags = normalizeTags(body.tags);

    if (!title) throw new HttpRouteError(400, 'Title is required.');
    if (title.length > 140) throw new HttpRouteError(400, 'Title must be 140 characters or fewer.');
    if (!category) throw new HttpRouteError(400, 'Category is required.');

    const credentials = await getTwitchActionCredentials(['channel:manage:broadcast']);
    const gameId = await resolveTwitchCategoryId(category, credentials);
    const res = await fetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      {
        method: 'PATCH',
        headers: {
          'Client-Id': credentials.clientId,
          Authorization: credentials.authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, game_id: gameId, tags }),
      },
    );

    if (!res.ok) {
      const message = await readResponseError(res, 'Twitch channel update failed.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
    }

    response.json({ ok: true, title, category, categoryId: gameId, tags });
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.post('/api/twitch/preroll', async (_request, response) => {
  try {
    const credentials = await getTwitchActionCredentials(['channel:edit:commercial']);
    const res = await fetch('https://api.twitch.tv/helix/channels/commercial', {
      method: 'POST',
      headers: {
        'Client-Id': credentials.clientId,
        Authorization: credentials.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: credentials.broadcasterId,
        length: TWITCH_PREROLL_COMMERCIAL_SECONDS,
      }),
    });

    if (!res.ok) {
      const message = await readResponseError(res, 'Twitch commercial request failed.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
    }

    const data = await res.json() as {
      data?: Array<{ length?: number; message?: string; retry_after?: number }>;
    };
    const commercial = data.data?.[0] ?? {};
    const durationSeconds = typeof commercial.length === 'number'
      ? commercial.length
      : TWITCH_PREROLL_COMMERCIAL_SECONDS;

    adBreakEndsAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
    twitchAdScheduleCache = null;

    response.json({
      ok: true,
      durationSeconds,
      message: commercial.message ?? null,
      retryAfterSeconds: typeof commercial.retry_after === 'number' ? commercial.retry_after : null,
      adBreakEndsAt,
    });
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.post('/api/twitch/chat-message', async (request, response) => {
  try {
    const body = request.body as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!message) throw new HttpRouteError(400, 'Message is required.');
    if (message.length > 500) throw new HttpRouteError(400, 'Message must be 500 characters or fewer.');

    const credentials = await getTwitchActionCredentials(['user:write:chat']);
    const senderId = twitchSenderId ?? await fetchAuthenticatedTwitchUserId(credentials.clientId, credentials.userToken);
    if (!senderId) throw new HttpRouteError(502, 'Could not resolve the authenticated Twitch user.');
    twitchSenderId = senderId;

    const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Client-Id': credentials.clientId,
        Authorization: credentials.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: credentials.broadcasterId,
        sender_id: senderId,
        message,
      }),
    });

    if (!res.ok) {
      const errorMessage = await readResponseError(res, 'Twitch chat message failed.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, errorMessage);
    }

    const data = await res.json() as {
      data?: Array<{
        message_id?: string;
        is_sent?: boolean;
        drop_reason?: { code?: string; message?: string } | null;
      }>;
    };
    const sentMessage = data.data?.[0] ?? {};
    const dropReason = sentMessage.drop_reason ?? null;
    if (sentMessage.is_sent === false || dropReason) {
      throw new HttpRouteError(422, dropReason?.message ?? 'Twitch did not send the message.');
    }

    response.json({
      ok: true,
      messageId: sentMessage.message_id ?? null,
    });
  } catch (error) {
    sendRouteError(response, error);
  }
});

app.get('/api/music/current', (_request, response) => {
  response.json(getCurrentMusic());
});

app.put('/api/music/current', (request, response) => {
  const music = setManualMusic(request.body);
  if (!music) {
    response.status(400).json({ error: 'status must be playing, paused, or stopped' });
    return;
  }

  response.json(music);
});

app.delete('/api/music/current', async (_request, response) => {
  response.json(await clearManualMusic());
});

app.get('/api/chat/recent', (_request, response) => {
  const rows = db
    .prepare(`
      select
        id,
        channel,
        username,
        display_name as displayName,
        color,
        message,
        received_at as receivedAt,
        deleted_at as deletedAt,
        deleted_reason as deletedReason,
        badges_json as badgesJson,
        emotes_json as emotesJson
      from chat_messages
      order by received_at desc
      limit 40
    `)
    .all()
    .reverse()
    .map((row) => {
      const r = row as Record<string, unknown> & { badgesJson: string | null; emotesJson: string | null };
      const { badgesJson, emotesJson, ...rest } = r;
      return {
        ...rest,
        badges: badgesJson ? JSON.parse(badgesJson) : null,
        emotes: emotesJson ? JSON.parse(emotesJson) : null,
      };
    });

  response.json(rows);
});

app.get('/api/chat/events/recent', (_request, response) => {
  const rows = db
    .prepare(`
      select
        id,
        type,
        channel,
        message_id as messageId,
        username,
        payload_json as payloadJson,
        occurred_at as occurredAt
      from chat_events
      order by occurred_at desc
      limit 100
    `)
    .all()
    .reverse()
    .map((row) => {
      const event = row as Record<string, unknown> & { payloadJson: string };
      const { payloadJson, ...rest } = event;
      return { ...rest, payload: JSON.parse(payloadJson) };
    });

  response.json(rows);
});


app.post('/api/obs/scenes/:sceneName', async (request, response) => {
  try {
    await switchObsScene(request.params.sceneName);
    response.json({ ok: true });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'OBS scene switch failed' });
  }
});

app.post('/api/obs/transition', async (request, response) => {
  try {
    await triggerObsTransition();
    response.json({ ok: true });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'OBS transition failed' });
  }
});

app.post('/api/sounds/quack', (_request, response) => {
  response.json(triggerQuackSound());
});

app.get('/api/emotes', async (_request, response) => {
  response.json(await getEmoteMap(getTwitchRoomId()));
});

function formatAgo(receivedAt: string): string {
  const diffMs = Date.now() - new Date(receivedAt).getTime();
  const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
  if (totalSecs < 60) return 'just now';
  if (totalSecs < 3600) {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  if (totalSecs < 86_400) {
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(totalSecs / 86_400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatClockTime(receivedAt: string): string {
  return new Date(receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatFirstSeen(receivedAt: string): string {
  const date = new Date(receivedAt);
  return `first seen ${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function rolesFromBadges(badges: Record<string, string> | null): string[] {
  if (!badges) return [];
  const roles: string[] = [];
  if (badges.broadcaster) roles.push('broadcaster');
  if (badges.moderator) roles.push('mod');
  if (badges.vip) roles.push('vip');
  if (badges.subscriber) roles.push('sub');
  return roles;
}

function parseBadgesJson(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return null;
  }
}

function fallbackColor(login: string): string {
  const palette = ['#ffc488', '#d7dce2', '#a8e0c4', '#9ccae8', '#bca6f0', '#f0a99d', '#f5f2e0'];
  let hash = 0;
  for (const char of login) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash];
}

function getKnownChatterCount(): number {
  const row = db.prepare('select count(distinct lower(username)) as count from chat_messages').get() as { count: number };
  return row.count;
}

function getActiveChatterCount(): number {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = db
    .prepare('select count(distinct lower(username)) as count from chat_messages where received_at >= ?')
    .get(since) as { count: number };
  return row.count;
}

type StreamStatusSource = 'twitch' | 'obs' | null;

type StreamActivityStatus = {
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  streamStartedAt: string | null;
  uptimeSource: StreamStatusSource;
};

type AdScheduleStatus = 'available' | 'not_configured' | 'missing_scope' | 'unauthorized' | 'unavailable';

type AdSchedule = {
  adScheduleStatus: AdScheduleStatus;
  adScheduleError: string | null;
  nextAdAt: string | null;
  lastAdAt: string | null;
  adBreakDurationSeconds: number | null;
  prerollFreeTimeSeconds: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
};

let twitchStreamStatusCache: { expiresAtMs: number; status: StreamActivityStatus } | null = null;
let twitchAdScheduleCache: { expiresAtMs: number; schedule: AdSchedule } | null = null;
const TWITCH_PREROLL_COMMERCIAL_SECONDS = 180;
const TWITCH_STREAM_STATUS_CACHE_MS = 15_000;
const TWITCH_AD_SCHEDULE_CACHE_MS = 5_000;

const emptyAdSchedule = (adScheduleStatus: AdScheduleStatus, adScheduleError: string | null = null): AdSchedule => ({
  adScheduleStatus,
  adScheduleError,
  nextAdAt: null,
  lastAdAt: null,
  adBreakDurationSeconds: null,
  prerollFreeTimeSeconds: null,
  snoozeCount: null,
  snoozeRefreshAt: null,
});

function parseTwitchInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTwitchDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function clearExpiredAdBreak(nowMs = Date.now()) {
  if (!adBreakEndsAt) return;
  const endsAtMs = new Date(adBreakEndsAt).getTime();
  if (!Number.isFinite(endsAtMs) || endsAtMs > nowMs) return;

  adBreakEndsAt = null;
  twitchAdScheduleCache = null;
}

function getCachedUserTokenForScopeChecks(): TwitchUserToken | null {
  const token = runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) runtimeUserToken = token;
  return token;
}

function getMissingTwitchScopes(scopes: readonly string[]): string[] {
  const token = getCachedUserTokenForScopeChecks();
  if (!token) return [];
  return scopes.filter(scope => !token.scopes.includes(scope));
}

async function getTwitchActionCredentials(scopes: readonly string[]) {
  const headers = await getTwitchUserApiHeaders();
  if (!headers) throw new HttpRouteError(401, 'Twitch login is required.');

  const missingScopes = getMissingTwitchScopes(scopes);
  if (missingScopes.length > 0) {
    throw new HttpRouteError(403, `Reconnect Twitch to grant: ${missingScopes.join(', ')}`);
  }

  const bid = broadcasterId ?? await fetchBroadcasterId(headers['Client-Id'], headers.userToken);
  if (!bid) throw new HttpRouteError(502, `Could not resolve broadcaster ID for "${twitchChannel}".`);
  broadcasterId = bid;

  return {
    clientId: headers['Client-Id'],
    authorization: headers.Authorization,
    userToken: headers.userToken,
    broadcasterId: bid,
  };
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = normalizeTwitchTagCandidate(item);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === 10) break;
  }
  return tags;
}

function normalizeTwitchTagCandidate(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

async function searchTwitchCategories(query: string, credentials: { clientId: string; authorization: string }) {
  const res = await fetch(
    `https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(query)}&first=20`,
    { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
  );
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch category search failed.');
    throw new HttpRouteError(res.status === 401 ? 401 : 502, message);
  }

  const data = await res.json() as { data?: Array<{ id: string; name: string; box_art_url?: string }> };
  return (data.data ?? []).map(category => ({
    id: category.id,
    name: category.name,
    boxArtUrl: category.box_art_url ?? null,
  }));
}

async function resolveTwitchCategoryId(category: string, credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>): Promise<string> {
  const query = category.trim();
  if (!query) throw new HttpRouteError(400, 'Category is required.');

  const categories = await searchTwitchCategories(query, credentials);
  const match = categories.find(item => item.name.toLowerCase() === query.toLowerCase()) ?? categories[0];
  if (!match) throw new HttpRouteError(400, `No Twitch category matched "${query}".`);
  return match.id;
}

async function getTwitchStreamStatus(): Promise<StreamActivityStatus> {
  if (twitchStreamStatusCache && twitchStreamStatusCache.expiresAtMs > Date.now()) {
    return twitchStreamStatusCache.status;
  }

  const unavailable: StreamActivityStatus = {
    streamActive: null,
    uptimeSeconds: null,
    streamStartedAt: null,
    uptimeSource: null,
  };

  const headers = await getTwitchApiHeaders();
  if (!headers) return unavailable;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(twitchChannel)}`,
      { headers },
    );

    if (!res.ok) {
      console.error(`Twitch API: stream status failed (${res.status}):`, await res.text());
      return unavailable;
    }

    const data = await res.json() as { data?: Array<{ started_at?: string }> };
    const startedAt = data.data?.[0]?.started_at ?? null;
    const status: StreamActivityStatus = startedAt
      ? {
          streamActive: true,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
          streamStartedAt: startedAt,
          uptimeSource: 'twitch',
        }
      : {
          streamActive: false,
          uptimeSeconds: null,
          streamStartedAt: null,
          uptimeSource: 'twitch',
        };

    twitchStreamStatusCache = {
      expiresAtMs: Date.now() + TWITCH_STREAM_STATUS_CACHE_MS,
      status,
    };

    return status;
  } catch (error) {
    console.error('Twitch API: stream status errored:', error);
    return unavailable;
  }
}

async function getTwitchAdSchedule(): Promise<AdSchedule> {
  clearExpiredAdBreak();

  if (twitchAdScheduleCache && twitchAdScheduleCache.expiresAtMs > Date.now()) {
    return twitchAdScheduleCache.schedule;
  }

  const headers = await getTwitchUserApiHeaders();
  if (!headers) return emptyAdSchedule('not_configured', 'Twitch user authentication is required for ad schedule data.');

  const cachedToken = runtimeUserToken ?? loadCachedTwitchUserToken();
  const missingScopes = cachedToken
    ? REQUIRED_TWITCH_OAUTH_SCOPES.filter(scope => !cachedToken.scopes.includes(scope))
    : [];
  if (missingScopes.includes('channel:read:ads')) {
    return emptyAdSchedule('missing_scope', 'Reconnect Twitch to grant channel:read:ads.');
  }

  const bid = broadcasterId ?? await fetchBroadcasterId(headers['Client-Id'], headers.userToken);
  if (!bid) return emptyAdSchedule('unavailable', `Could not resolve broadcaster ID for "${twitchChannel}".`);
  broadcasterId = bid;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/ads?broadcaster_id=${encodeURIComponent(bid)}`,
      { headers: { 'Client-Id': headers['Client-Id'], Authorization: headers.Authorization } },
    );

    if (!res.ok) {
      const text = await res.text();
      const status = res.status === 401 || res.status === 403 ? 'unauthorized' : 'unavailable';
      console.error(`Twitch API: ad schedule failed (${res.status}):`, text);
      return emptyAdSchedule(status, status === 'unauthorized'
        ? 'Twitch token is not authorized for channel:read:ads or does not match the configured channel.'
        : 'Twitch ad schedule is unavailable.');
    }

    const data = await res.json() as {
      data?: Array<{
        next_ad_at?: unknown;
        last_ad_at?: unknown;
        duration?: unknown;
        preroll_free_time?: unknown;
        snooze_count?: unknown;
        snooze_refresh_at?: unknown;
      }>;
    };
    const row = data.data?.[0];
    const schedule: AdSchedule = {
      adScheduleStatus: 'available',
      adScheduleError: null,
      nextAdAt: parseTwitchDate(row?.next_ad_at),
      lastAdAt: parseTwitchDate(row?.last_ad_at),
      adBreakDurationSeconds: parseTwitchInteger(row?.duration),
      prerollFreeTimeSeconds: parseTwitchInteger(row?.preroll_free_time),
      snoozeCount: parseTwitchInteger(row?.snooze_count),
      snoozeRefreshAt: parseTwitchDate(row?.snooze_refresh_at),
    };

    twitchAdScheduleCache = {
      expiresAtMs: Date.now() + TWITCH_AD_SCHEDULE_CACHE_MS,
      schedule,
    };

    return schedule;
  } catch (error) {
    console.error('Twitch API: ad schedule errored:', error);
    return emptyAdSchedule('unavailable', 'Twitch ad schedule request failed.');
  }
}

async function getDashboardStatusSnapshot() {
  clearExpiredAdBreak();

  const [twitchStreamStatus, obsStats, adSchedule] = await Promise.all([
    getTwitchStreamStatus(),
    getObsDashboardStats(),
    getTwitchAdSchedule(),
  ]);
  const {
    streamActive: _obsStreamActive,
    uptimeSeconds: _obsUptimeSeconds,
    streamStartedAt: _obsStreamStartedAt,
    uptimeSource: _obsUptimeSource,
    ...obsHealthStats
  } = obsStats;
  const streamStatus = twitchStreamStatus.uptimeSource === 'twitch'
    ? twitchStreamStatus
    : {
        streamActive: _obsStreamActive,
        uptimeSeconds: _obsUptimeSeconds,
        streamStartedAt: _obsStreamStartedAt,
        uptimeSource: _obsUptimeSource,
      };

  return {
    channel: twitchChannel,
    chatConnection: twitchClient.readyState?.() ?? 'UNKNOWN',
    obsConnected: isObsConnected(),
    eventSubConnected,
    ...getTwitchAuthStatus(),
    ...streamStatus,
    ...obsHealthStats,
    activeChatters: getActiveChatterCount(),
    sessionChatters: getSessionChatterCount(),
    knownChatters: getKnownChatterCount(),
    adBreakEndsAt,
    ...adSchedule,
  };
}

app.get('/api/dashboard/status', async (_request, response) => {
  response.json(await getDashboardStatusSnapshot());
});

app.get('/api/dashboard/viewers', (_request, response) => {
  const countRows = db.prepare(`
    select lower(username) as login, count(*) as msgs, min(received_at) as firstSeen
    from chat_messages
    group by lower(username)
  `).all() as Array<{ login: string; msgs: number; firstSeen: string }>;

  const counts = new Map(countRows.map(row => [row.login, row]));
  const recentRows = db.prepare(`
    select username, display_name as displayName, color, message, received_at as receivedAt, badges_json as badgesJson
    from chat_messages
    order by received_at desc
    limit 500
  `).all() as Array<{
    username: string;
    displayName: string;
    color: string | null;
    message: string;
    receivedAt: string;
    badgesJson: string | null;
  }>;

  type ViewerProjection = {
    login: string;
    display: string;
    color: string;
    pronouns: string;
    roles: string[];
    followed: string;
    subbed: string;
    seen: string;
    msgs: number;
    accountAge: string;
    note: string;
    recent: Array<{ t: string; ago: string; kind?: string }>;
  };

  const viewers: Record<string, ViewerProjection> = {};
  for (const row of recentRows) {
    const login = row.username.toLowerCase();
    const count = counts.get(login);
    if (!count) continue;

    if (!viewers[login]) {
      const badges = parseBadgesJson(row.badgesJson);
      const roles = rolesFromBadges(badges);
      viewers[login] = {
        login,
        display: row.displayName,
        color: row.color ?? fallbackColor(login),
        pronouns: 'not available',
        roles,
        followed: 'not available',
        subbed: roles.includes('sub') ? 'subscriber badge present' : 'not available',
        seen: formatFirstSeen(count.firstSeen),
        msgs: count.msgs,
        accountAge: 'not available',
        note: '',
        recent: [],
      };
    }

    if (viewers[login].recent.length < 5) {
      viewers[login].recent.push({
        t: row.message,
        ago: formatAgo(row.receivedAt),
      });
    }
  }

  response.json(viewers);
});

app.get('/api/dashboard/chat', (_request, response) => {
  const beforeId = typeof _request.query['before'] === 'string' ? _request.query['before'] : null;

  const rows = beforeId
    ? db.prepare(`
        select id, username, message, received_at as receivedAt, badges_json as badgesJson
        from chat_messages
        where received_at < (select received_at from chat_messages where id = ?)
        order by received_at desc
        limit 80
      `).all(beforeId) as Array<{ id: string; username: string; message: string; receivedAt: string; badgesJson: string | null }>
    : db.prepare(`
        select id, username, message, received_at as receivedAt, badges_json as badgesJson
        from chat_messages
        order by received_at desc
        limit 80
      `).all() as Array<{ id: string; username: string; message: string; receivedAt: string; badgesJson: string | null }>;

  response.json(rows.reverse().map((row) => {
    const badges = parseBadgesJson(row.badgesJson);
    return {
      id: row.id,
      user: row.username.toLowerCase(),
      text: row.message,
      time: formatClockTime(row.receivedAt),
      highlight: badges?.subscriber ? 'sub' : undefined,
    };
  }));
});

app.get('/api/dashboard/events', (_request, response) => {
  const rows = db.prepare(`
    select id, kind, actor, detail, tone, received_at as receivedAt
    from stream_events
    order by received_at desc
    limit 50
  `).all() as Array<{ id: string; kind: string; actor: string; detail: string; tone: string; receivedAt: string }>;

  if (rows.length > 0) {
    response.json(rows.map(r => ({ ...r, ago: formatAgo(r.receivedAt) })));
    return;
  }

  response.json([]);
});

function startDashboardHeartbeat() {
  setInterval(() => {
    if (getSocketCount() === 0) return;

    void getDashboardStatusSnapshot()
      .then(status => broadcast('dashboard:status', status))
      .catch(error => console.error('Dashboard heartbeat failed:', error));
  }, 5_000);
}

server.listen(port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${port}`);
  connectTwitchChat();
  startMusicPolling();
  startDashboardHeartbeat();
  void connectEventSub();
});
