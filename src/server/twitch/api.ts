import type express from 'express';
import type { ViewerDetails } from '../../shared/api';
import { TOKEN_EXPIRY_REFRESH_BUFFER_MS } from '../../shared/constants';
import { appConfig } from '../appConfig';
import { handle, HttpRouteError, readResponseError } from '../http';
import type { RuntimeState } from '../runtime';
import { parseTwitchGameId } from '../streamCategories';
import { mergeTagSuggestions, normalizeTag, normalizeTags, recordTagHistory, suggestTagHistory } from '../tags';
import { onCategorySignal } from '../categoryModules';
import { rebaseWindDownTitle } from '../windDown';
import {
  getTwitchBotAccessToken,
  getTwitchAuthStatus,
  getTwitchUserAccessToken,
  loadCachedTwitchBotToken,
  loadCachedTwitchUserToken,
  REQUIRED_TWITCH_BOT_OAUTH_SCOPES,
  REQUIRED_TWITCH_OAUTH_SCOPES,
} from './auth';

export const TWITCH_COMMERCIAL_SECONDS = 180;
const TWITCH_DEFAULT_TIMEOUT_SECONDS = 600;
const TWITCH_MAX_TIMEOUT_SECONDS = 1_209_600;
type TwitchChatSender = 'user' | 'bot';

type TwitchAuth = { clientId: string; authorization: string };

const DEFAULT_PASSTHROUGH_STATUSES: readonly number[] = [401, 403];

export type TwitchFetchOptions = {
  credentials: TwitchAuth;
  errorMessage: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  passthroughStatuses?: readonly number[];
  allowStatuses?: readonly number[];
};

export async function twitchFetch(url: string, options: TwitchFetchOptions): Promise<Response> {
  const init: RequestInit = {
    headers: {
      'Client-Id': options.credentials.clientId,
      Authorization: options.credentials.authorization,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers ?? {}),
    },
  };
  if (options.method) init.method = options.method;
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const res = await fetch(url, init);
  if (res.ok) return res;
  if (options.allowStatuses?.includes(res.status)) return res;

  const passthroughStatuses = options.passthroughStatuses ?? DEFAULT_PASSTHROUGH_STATUSES;
  const message = await readResponseError(res, options.errorMessage);
  throw new HttpRouteError(passthroughStatuses.includes(res.status) ? res.status : 502, message);
}

export async function getEventSubCredentials(state: RuntimeState): Promise<{ clientId: string; userToken: string } | null> {
  const clientId = appConfig.twitchClientId;
  const userToken = await getTwitchUserAccessToken(state);
  if (!clientId || !userToken) return null;
  return { clientId, userToken };
}

export async function getTwitchApiHeaders(state: RuntimeState): Promise<{ 'Client-Id': string; Authorization: string } | null> {
  const clientId = appConfig.twitchClientId;
  if (!clientId) return null;

  const userToken = await getTwitchUserAccessToken(state);
  if (userToken) {
    return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}` };
  }

  const clientSecret = appConfig.twitchClientSecret;
  if (!clientSecret) return null;

  if (state.twitchAppToken && state.twitchAppToken.expiresAtMs > Date.now() + TOKEN_EXPIRY_REFRESH_BUFFER_MS) {
    return { 'Client-Id': clientId, Authorization: `Bearer ${state.twitchAppToken.accessToken}` };
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

    state.twitchAppToken = {
      accessToken: tokenData.access_token,
      expiresAtMs: Date.now() + Math.max(60, tokenData.expires_in ?? 3600) * 1000,
    };

    return { 'Client-Id': clientId, Authorization: `Bearer ${state.twitchAppToken.accessToken}` };
  } catch (error) {
    console.error('Twitch API: app token request errored:', error);
    return null;
  }
}

export async function getTwitchUserApiHeaders(state: RuntimeState): Promise<{ 'Client-Id': string; Authorization: string; userToken: string } | null> {
  const clientId = appConfig.twitchClientId;
  const userToken = await getTwitchUserAccessToken(state);
  if (!clientId || !userToken) return null;
  return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}`, userToken };
}

export async function getTwitchBotApiHeaders(state: RuntimeState): Promise<{ 'Client-Id': string; Authorization: string; userToken: string } | null> {
  const clientId = appConfig.twitchClientId;
  const userToken = await getTwitchBotAccessToken(state);
  if (!clientId || !userToken) return null;
  return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}`, userToken };
}

export async function fetchBroadcasterId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(appConfig.twitchChannel)}`,
      { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch (error) {
    console.error(`Twitch API: failed to resolve broadcaster ID for "${appConfig.twitchChannel}":`, error);
    return null;
  }
}

export type TwitchLiveStream = {
  id: string;
  startedAt: string;
  title: string;
  category: string;
};

export async function fetchCurrentTwitchStream(clientId: string, userToken: string): Promise<TwitchLiveStream | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(appConfig.twitchChannel)}`,
      { headers: { 'Client-Id': clientId, Authorization: `Bearer ${userToken}` } },
    );
    if (!res.ok) {
      console.error(`Twitch API: current stream lookup failed (${res.status}):`, await res.text());
      return null;
    }
    const data = await res.json() as { data?: Array<{ id?: string; started_at?: string; title?: string; game_name?: string }> };
    const stream = data.data?.[0];
    return stream?.id && stream.started_at
      ? { id: stream.id, startedAt: stream.started_at, title: stream.title ?? '', category: stream.game_name ?? '' }
      : null;
  } catch (error) {
    console.error('Twitch API: current stream lookup errored:', error);
    return null;
  }
}

export async function fetchAuthenticatedTwitchUser(
  clientId: string,
  userToken: string,
): Promise<{ id: string; login: string } | null> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string; login: string }> };
    const user = data.data[0];
    return user?.id ? { id: user.id, login: user.login ?? '' } : null;
  } catch (error) {
    console.error('Twitch API: failed to resolve authenticated user:', error);
    return null;
  }
}

export async function resolveTwitchUserId(login: string, credentials: { clientId: string; authorization: string }): Promise<string> {
  const normalizedLogin = login.trim().replace(/^@/, '').toLowerCase();
  if (!normalizedLogin) throw new HttpRouteError(400, 'Twitch login is required.');

  const res = await twitchFetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(normalizedLogin)}`,
    { credentials, errorMessage: 'Twitch user lookup failed.' },
  );

  const data = await res.json() as { data?: Array<{ id?: string }> };
  const userId = data.data?.[0]?.id;
  if (!userId) throw new HttpRouteError(404, `No Twitch user found for "${normalizedLogin}".`);
  return userId;
}

const VIEWER_DETAIL_UNKNOWN = 'not available';

function formatAccountAge(createdAt: string): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return VIEWER_DETAIL_UNKNOWN;
  const since = created.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  const days = Math.floor((Date.now() - created.getTime()) / 86_400_000);
  if (days < 60) return `${days} days (since ${since})`;
  if (days < 730) return `${Math.floor(days / 30)} months (since ${since})`;
  return `${Math.floor(days / 365)} years (since ${since})`;
}

function formatFollowDate(followedAt: string | undefined): string {
  if (!followedAt) return 'not following';
  const date = new Date(followedAt);
  if (Number.isNaN(date.getTime())) return 'following';
  return `since ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function formatSubTier(tier: string | undefined, isGift: boolean): string {
  if (!tier) return 'not subscribed';
  const label = tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1';
  return isGift ? `${label} (gift)` : label;
}

// Best-effort live Twitch facts for one viewer, fetched on demand for the viewer
// page. Each lookup is independent: a failure leaves that field 'not available'
// rather than failing the whole request. Requires the already-granted
// moderator:read:followers and channel:read:subscriptions scopes.
export async function fetchViewerTwitchDetails(state: RuntimeState, login: string): Promise<ViewerDetails> {
  const details: ViewerDetails = {
    followed: VIEWER_DETAIL_UNKNOWN,
    subbed: VIEWER_DETAIL_UNKNOWN,
    accountAge: VIEWER_DETAIL_UNKNOWN,
  };
  const auth = await getTwitchUserApiHeaders(state);
  if (!auth) return details;
  const headers = { 'Client-Id': auth['Client-Id'], Authorization: auth.Authorization };
  const normalized = login.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return details;

  // User lookup gives both the numeric id (for the calls below) and account age.
  let userId: string | null = null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(normalized)}`, { headers });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id?: string; created_at?: string }> };
      const user = data.data?.[0];
      userId = user?.id ?? null;
      if (user?.created_at) details.accountAge = formatAccountAge(user.created_at);
    }
  } catch (error) {
    console.error(`Twitch API: user lookup failed for "${normalized}":`, error);
  }
  if (!userId) return details;

  const broadcasterId = state.broadcasterId ?? await fetchBroadcasterId(auth['Client-Id'], auth.userToken);
  if (broadcasterId) state.broadcasterId = broadcasterId;
  if (!broadcasterId) return details;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(userId)}`,
      { headers },
    );
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ followed_at?: string }> };
      details.followed = formatFollowDate(data.data?.[0]?.followed_at);
    }
  } catch (error) {
    console.error(`Twitch API: follower lookup failed for "${normalized}":`, error);
  }

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(userId)}`,
      { headers },
    );
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ tier?: string; is_gift?: boolean }> };
      const sub = data.data?.[0];
      details.subbed = sub ? formatSubTier(sub.tier, Boolean(sub.is_gift)) : 'not subscribed';
    } else if (res.status === 404) {
      details.subbed = 'not subscribed';
    }
  } catch (error) {
    console.error(`Twitch API: subscription lookup failed for "${normalized}":`, error);
  }

  return details;
}

async function getAuthenticatedActionUser(
  state: RuntimeState,
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
): Promise<{ id: string; login: string }> {
  if (state.twitchSenderId && state.twitchSenderLogin) {
    return { id: state.twitchSenderId, login: state.twitchSenderLogin };
  }
  const user = await fetchAuthenticatedTwitchUser(credentials.clientId, credentials.userToken);
  if (!user?.id) throw new HttpRouteError(502, 'Could not resolve the authenticated Twitch user.');
  state.twitchSenderId = user.id;
  state.twitchSenderLogin = user.login;
  return { id: user.id, login: user.login };
}

async function getAuthenticatedActionUserId(
  state: RuntimeState,
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
): Promise<string> {
  return (await getAuthenticatedActionUser(state, credentials)).id;
}

function normalizeUserActionReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function normalizeTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null || value === '') return TWITCH_DEFAULT_TIMEOUT_SECONDS;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new HttpRouteError(400, 'Timeout duration must be a number.');
  const seconds = Math.round(numeric);
  if (seconds < 1 || seconds > TWITCH_MAX_TIMEOUT_SECONDS) {
    throw new HttpRouteError(400, 'Timeout duration must be between 1 second and 14 days.');
  }
  return seconds;
}

export async function sendTwitchShoutout(state: RuntimeState, login: string) {
  const credentials = await getTwitchActionCredentials(state, ['moderator:manage:shoutouts']);
  const [moderatorId, targetId] = await Promise.all([
    getAuthenticatedActionUserId(state, credentials),
    resolveTwitchUserId(login, credentials),
  ]);
  const params = new URLSearchParams({
    from_broadcaster_id: credentials.broadcasterId,
    to_broadcaster_id: targetId,
    moderator_id: moderatorId,
  });

  await twitchFetch(`https://api.twitch.tv/helix/chat/shoutouts?${params.toString()}`, {
    credentials,
    method: 'POST',
    errorMessage: 'Twitch shoutout failed.',
    passthroughStatuses: [401, 403, 429],
  });
}

export async function sendTwitchWhisper(state: RuntimeState, login: string, message: string) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) throw new HttpRouteError(400, 'Whisper message is required.');
  if (trimmedMessage.length > 500) throw new HttpRouteError(400, 'Whisper message must be 500 characters or fewer.');

  const credentials = await getTwitchActionCredentials(state, ['user:manage:whispers']);
  const [fromUserId, toUserId] = await Promise.all([
    getAuthenticatedActionUserId(state, credentials),
    resolveTwitchUserId(login, credentials),
  ]);
  const params = new URLSearchParams({
    from_user_id: fromUserId,
    to_user_id: toUserId,
  });

  await twitchFetch(`https://api.twitch.tv/helix/whispers?${params.toString()}`, {
    credentials,
    method: 'POST',
    body: { message: trimmedMessage },
    errorMessage: 'Twitch whisper failed.',
    passthroughStatuses: [401, 403, 429],
  });
}

export async function moderateTwitchUser(
  state: RuntimeState,
  login: string,
  action: 'ban' | 'timeout',
  options: { durationSeconds?: unknown; reason?: unknown },
) {
  const credentials = await getTwitchActionCredentials(state, ['moderator:manage:banned_users']);
  const [moderatorId, targetId] = await Promise.all([
    getAuthenticatedActionUserId(state, credentials),
    resolveTwitchUserId(login, credentials),
  ]);
  const params = new URLSearchParams({
    broadcaster_id: credentials.broadcasterId,
    moderator_id: moderatorId,
  });
  const reason = normalizeUserActionReason(options.reason);
  const data: { user_id: string; duration?: number; reason?: string } = { user_id: targetId };
  if (action === 'timeout') data.duration = normalizeTimeoutSeconds(options.durationSeconds);
  if (reason) data.reason = reason;

  await twitchFetch(`https://api.twitch.tv/helix/moderation/bans?${params.toString()}`, {
    credentials,
    method: 'POST',
    body: { data },
    errorMessage: `Twitch ${action} failed.`,
  });
}

export type AutomodResolveResult = { outcome: 'ok' | 'gone'; moderatorLogin: string };

export async function resolveAutomodMessage(
  state: RuntimeState,
  messageId: string,
  action: 'ALLOW' | 'DENY',
): Promise<AutomodResolveResult> {
  const credentials = await getTwitchActionCredentials(state, ['moderator:manage:automod']);
  const moderator = await getAuthenticatedActionUser(state, credentials);

  // 404 means Twitch no longer holds this message (expired or already handled
  // elsewhere). That's not an error for us — the caller resolves it locally as
  // expired so the stuck hold can leave the queue. Anything else is a real fault.
  const res = await twitchFetch('https://api.twitch.tv/helix/moderation/automod/message', {
    credentials,
    method: 'POST',
    body: { user_id: moderator.id, msg_id: messageId, action },
    errorMessage: `Twitch AutoMod ${action.toLowerCase()} failed.`,
    allowStatuses: [404],
  });
  if (res.status === 404) return { outcome: 'gone', moderatorLogin: moderator.login };
  return { outcome: 'ok', moderatorLogin: moderator.login };
}

export function getMissingTwitchScopes(state: RuntimeState, scopes: readonly string[]): string[] {
  const token = state.runtimeUserToken ?? loadCachedTwitchUserToken();
  if (token) state.runtimeUserToken = token;
  if (!token) return [];
  return scopes.filter(scope => !token.scopes.includes(scope));
}

export function getMissingTwitchBotScopes(state: RuntimeState, scopes: readonly string[]): string[] {
  const token = state.runtimeBotToken ?? loadCachedTwitchBotToken();
  if (token) state.runtimeBotToken = token;
  if (!token) return [];
  return scopes.filter(scope => !token.scopes.includes(scope));
}

// Shared tail for both the user- and bot-account credential paths: enforce the
// scope check, resolve/cache the broadcaster ID, and shape the credentials. The
// callers differ only in which headers/scopes they resolve and their error copy.
async function assembleTwitchCredentials(
  state: RuntimeState,
  headers: { 'Client-Id': string; Authorization: string; userToken: string },
  missingScopes: string[],
  scopeErrorPrefix: string,
) {
  if (missingScopes.length > 0) {
    throw new HttpRouteError(403, `${scopeErrorPrefix}: ${missingScopes.join(', ')}`);
  }

  const bid = state.broadcasterId ?? await fetchBroadcasterId(headers['Client-Id'], headers.userToken);
  if (!bid) throw new HttpRouteError(502, `Could not resolve broadcaster ID for "${appConfig.twitchChannel}".`);
  state.broadcasterId = bid;

  return {
    clientId: headers['Client-Id'],
    authorization: headers.Authorization,
    userToken: headers.userToken,
    broadcasterId: bid,
  };
}

export async function getTwitchActionCredentials(state: RuntimeState, scopes: readonly string[]) {
  const headers = await getTwitchUserApiHeaders(state);
  if (!headers) throw new HttpRouteError(401, 'Twitch login is required.');

  const missingScopes = getMissingTwitchScopes(state, scopes);
  return assembleTwitchCredentials(state, headers, missingScopes, 'Reconnect Twitch to grant');
}

async function getTwitchChatCredentials(state: RuntimeState, sender: TwitchChatSender) {
  if (sender === 'bot') {
    const botHeaders = await getTwitchBotApiHeaders(state);
    if (!botHeaders) throw new HttpRouteError(401, 'Twitch bot login is required.');

    const missingBotScopes = getMissingTwitchBotScopes(state, REQUIRED_TWITCH_BOT_OAUTH_SCOPES);
    const credentials = await assembleTwitchCredentials(state, botHeaders, missingBotScopes, 'Reconnect Twitch bot to grant');
    return { ...credentials, senderIdKey: 'bot' as const };
  }

  const userCredentials = await getTwitchActionCredentials(state, ['user:write:chat']);
  return { ...userCredentials, senderIdKey: 'user' as const };
}

export async function sendTwitchChatMessage(
  state: RuntimeState,
  message: string,
  sender: TwitchChatSender,
): Promise<{ messageId: string | null }> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) throw new HttpRouteError(400, 'Message is required.');
  if (trimmedMessage.length > 500) throw new HttpRouteError(400, 'Message must be 500 characters or fewer.');

  const credentials = await getTwitchChatCredentials(state, sender);
  const cachedSenderId = credentials.senderIdKey === 'bot' ? state.twitchBotSenderId : state.twitchSenderId;
  const resolvedUser = cachedSenderId ? null : await fetchAuthenticatedTwitchUser(credentials.clientId, credentials.userToken);
  const senderId = cachedSenderId ?? resolvedUser?.id;
  if (!senderId) throw new HttpRouteError(502, 'Could not resolve the authenticated Twitch user.');
  if (credentials.senderIdKey === 'bot') {
    state.twitchBotSenderId = senderId;
    if (resolvedUser?.login) state.twitchBotLogin = resolvedUser.login.toLowerCase();
  } else {
    state.twitchSenderId = senderId;
  }

  const res = await twitchFetch('https://api.twitch.tv/helix/chat/messages', {
    credentials,
    method: 'POST',
    body: {
      broadcaster_id: credentials.broadcasterId,
      sender_id: senderId,
      message: trimmedMessage,
    },
    errorMessage: 'Twitch chat message failed.',
  });

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

  return { messageId: sentMessage.message_id ?? null };
}

type TwitchCommercialResult = {
  durationSeconds: number;
  message: string | null;
  retryAfterSeconds: number | null;
  adBreakEndsAt: string;
};

const twitchCommercialTasks = new WeakMap<RuntimeState, Promise<TwitchCommercialResult>>();

async function executeTwitchCommercial(state: RuntimeState): Promise<TwitchCommercialResult> {
  const credentials = await getTwitchActionCredentials(state, ['channel:edit:commercial']);
  const res = await twitchFetch('https://api.twitch.tv/helix/channels/commercial', {
    credentials,
    method: 'POST',
    body: {
      broadcaster_id: credentials.broadcasterId,
      length: TWITCH_COMMERCIAL_SECONDS,
    },
    errorMessage: 'Twitch commercial request failed.',
  });

  const data = await res.json() as {
    data?: Array<{ length?: number; message?: string; retry_after?: number }>;
  };
  const commercial = data.data?.[0] ?? {};
  const durationSeconds = typeof commercial.length === 'number'
    ? commercial.length
    : TWITCH_COMMERCIAL_SECONDS;

  state.adBreakEndsAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
  state.twitchAdScheduleCache = null;

  try {
    await sendTwitchChatMessage(
      state,
      `Ads are running for the next ${Math.ceil(durationSeconds / 60)} minutes. Thanks for hanging out — we'll be right back!`,
      'bot',
    );
  } catch (error) {
    console.error('Twitch commercial started, but the bot chat announcement failed:', error);
  }

  return {
    durationSeconds,
    message: commercial.message ?? null,
    retryAfterSeconds: typeof commercial.retry_after === 'number' ? commercial.retry_after : null,
    adBreakEndsAt: state.adBreakEndsAt,
  };
}

export async function runTwitchCommercial(state: RuntimeState): Promise<TwitchCommercialResult> {
  const activeTask = twitchCommercialTasks.get(state);
  if (activeTask) return activeTask;

  const task = executeTwitchCommercial(state);
  twitchCommercialTasks.set(state, task);
  try {
    return await task;
  } finally {
    if (twitchCommercialTasks.get(state) === task) twitchCommercialTasks.delete(state);
  }
}

export async function searchTwitchCategories(query: string, credentials: { clientId: string; authorization: string }) {
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(query)}&first=20`,
    { credentials, errorMessage: 'Twitch category search failed.', passthroughStatuses: [401] },
  );

  const data = await res.json() as { data?: Array<{ id: string; name: string; box_art_url?: string }> };
  return (data.data ?? []).map(category => ({
    id: category.id,
    name: category.name,
    boxArtUrl: category.box_art_url ?? null,
  }));
}

// Look up a single category by its numeric game id; returns null when Twitch no longer knows it.
export async function getTwitchCategoryById(
  id: string,
  credentials: { clientId: string; authorization: string },
): Promise<{ id: string; name: string; boxArtUrl: string | null } | null> {
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/games?id=${encodeURIComponent(id)}`,
    { credentials, errorMessage: 'Twitch category lookup failed.', passthroughStatuses: [401] },
  );

  const data = await res.json() as { data?: Array<{ id: string; name: string; box_art_url?: string }> };
  const game = data.data?.[0];
  return game ? { id: game.id, name: game.name, boxArtUrl: game.box_art_url ?? null } : null;
}

async function resolveTwitchCategoryId(category: string, credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>): Promise<string> {
  const query = category.trim();
  if (!query) throw new HttpRouteError(400, 'Category is required.');

  const categories = await searchTwitchCategories(query, credentials);
  const match = categories.find(item => item.name.toLowerCase() === query.toLowerCase()) ?? categories[0];
  if (!match) throw new HttpRouteError(400, `No Twitch category matched "${query}".`);
  return match.id;
}

/**
 * Set ONLY the channel title.
 *
 * Deliberately not routed through PATCH /api/twitch/stream-info: that route requires
 * a category alongside the title and calls onCategorySignal on every success, so a
 * wind-down title tweak would re-fire category-module switching as a side effect of
 * the clock reaching a number. Twitch accepts a partial channel update, so send only
 * what is actually changing.
 */
export async function setTwitchChannelTitle(state: RuntimeState, title: string): Promise<void> {
  const credentials = await getTwitchActionCredentials(state, ['channel:manage:broadcast']);
  await twitchFetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
    {
      credentials,
      method: 'PATCH',
      body: { title },
      errorMessage: 'Twitch channel title update failed.',
    },
  );
}

/** The channel's current title, for capturing a base title before wind-down edits it. */
export async function getTwitchChannelTitle(state: RuntimeState): Promise<string> {
  const credentials = await getTwitchActionCredentials(state, []);
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
    { credentials, errorMessage: 'Twitch channel information is unavailable.' },
  );
  const data = await res.json() as { data?: Array<{ title?: string }> };
  return data.data?.[0]?.title ?? '';
}

export function registerTwitchApiRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/stream-info', handle(async (_request, response) => {
    const credentials = await getTwitchActionCredentials(state, []);
    const res = await twitchFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      { credentials, errorMessage: 'Twitch channel information is unavailable.' },
    );

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
    if (!channel) throw new HttpRouteError(404, `No Twitch channel information found for "${appConfig.twitchChannel}".`);

    response.json({
      broadcasterName: channel.broadcaster_name ?? appConfig.twitchChannel,
      categoryId: channel.game_id ?? '',
      category: channel.game_name ?? '',
      title: channel.title ?? '',
      tags: normalizeTags(channel.tags ?? []),
    });
  }));

  app.get('/api/twitch/category-suggestions', handle(async (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'].trim() : '';
    if (query.length < 2) {
      response.json([]);
      return;
    }

    const headers = await getTwitchApiHeaders(state);
    if (!headers) throw new HttpRouteError(401, 'Twitch API credentials are required.');

    const categories = await searchTwitchCategories(query, {
      clientId: headers['Client-Id'],
      authorization: headers.Authorization,
    });
    response.json(categories);
  }));

  app.get('/api/twitch/tag-suggestions', handle(async (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'].trim() : '';
    const candidate = normalizeTag(query);
    const history = suggestTagHistory(query, 8);

    // The channel's current tags are a nice-to-have; if Twitch is unreachable or
    // unauthenticated, fall back to history-only suggestions rather than 500ing.
    let channelTags: string[] = [];
    try {
      const credentials = await getTwitchActionCredentials(state, []);
      const res = await fetch(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
        { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
      );
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ tags?: string[] }> };
        // Filter the channel's tags by the query the same way history is, so a
        // search like "cod" can't surface unrelated tags (English, Cozy) and
        // crowd out the relevant candidate. An empty query browses them all.
        const needle = candidate.toLowerCase();
        channelTags = normalizeTags(data.data?.[0]?.tags ?? [])
          .filter(tag => !needle || tag.toLowerCase().includes(needle));
      }
    } catch {
      // history-only suggestions
    }

    response.json(mergeTagSuggestions({ history, channelTags, candidate }));
  }));

  app.patch('/api/twitch/stream-info', handle(async (request, response) => {
    const body = request.body as { title?: unknown; category?: unknown; categoryId?: unknown; tags?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const providedId = parseTwitchGameId(body.categoryId);
    const tags = normalizeTags(body.tags);

    if (!title) throw new HttpRouteError(400, 'Title is required.');
    if (title.length > 140) throw new HttpRouteError(400, 'Title must be 140 characters or fewer.');
    if (!category) throw new HttpRouteError(400, 'Category is required.');

    const credentials = await getTwitchActionCredentials(state, ['channel:manage:broadcast']);
    // Prefer an exact game id chosen from the saved list, but confirm it still resolves so a stale
    // saved id can't be pushed under a mismatched name; otherwise fall back to fuzzy name resolution.
    let gameId: string;
    let categoryName = category;
    if (providedId) {
      const found = await getTwitchCategoryById(providedId, credentials);
      if (!found) throw new HttpRouteError(400, 'Saved category no longer exists on Twitch — re-add it from search.');
      gameId = found.id;
      categoryName = found.name;
    } else {
      gameId = await resolveTwitchCategoryId(category, credentials);
    }
    // While wind-down is active the operator is editing the SUFFIXED title they can
    // see. Re-base so their edit is kept as the new base title rather than being
    // clobbered, and so the suffix is not appended twice.
    const titleToSend = rebaseWindDownTitle(title);
    await twitchFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      {
        credentials,
        method: 'PATCH',
        body: { title: titleToSend, game_id: gameId, tags },
        errorMessage: 'Twitch channel update failed.',
      },
    );

    // Remember these tags so the type-ahead can suggest them next time.
    recordTagHistory(tags);

    // Swap category modules to match the new stream category (best-effort — never
    // fails the update). This is one of several signals; see categoryModules.ts.
    await onCategorySignal(state, 'stream_info_update', gameId || null, categoryName || null);

    response.json({ ok: true, title, category: categoryName, categoryId: gameId, tags });
  }));

  app.post('/api/twitch/preroll', handle(async (_request, response) => {
    response.json({ ok: true, ...await runTwitchCommercial(state) });
  }));

  app.post('/api/twitch/chat-message', handle(async (request, response) => {
    const body = request.body as { message?: unknown; sender?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const sender = body.sender === 'bot' ? 'bot' : 'user';

    const result = await sendTwitchChatMessage(state, message, sender);

    response.json({
      ok: true,
      messageId: result.messageId,
    });
  }));

  app.post('/api/twitch/users/:login/shoutout', handle(async (request, response) => {
    await sendTwitchShoutout(state, request.params.login);
    response.json({ ok: true, message: `Shoutout sent to @${request.params.login}.` });
  }));

  app.post('/api/twitch/users/:login/whisper', handle(async (request, response) => {
    const body = request.body as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message : '';
    await sendTwitchWhisper(state, request.params.login, message);
    response.json({ ok: true, message: `Whisper sent to @${request.params.login}.` });
  }));

  app.post('/api/twitch/users/:login/timeout', handle(async (request, response) => {
    const body = request.body as { durationSeconds?: unknown; reason?: unknown };
    await moderateTwitchUser(state, request.params.login, 'timeout', {
      durationSeconds: body.durationSeconds,
      reason: body.reason,
    });
    response.json({ ok: true, message: `@${request.params.login} timed out.` });
  }));

  app.post('/api/twitch/users/:login/ban', handle(async (request, response) => {
    const body = request.body as { reason?: unknown };
    await moderateTwitchUser(state, request.params.login, 'ban', { reason: body.reason });
    response.json({ ok: true, message: `@${request.params.login} banned.` });
  }));
}

export { getTwitchAuthStatus, REQUIRED_TWITCH_OAUTH_SCOPES };
