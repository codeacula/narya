import type express from 'express';
import { TOKEN_EXPIRY_REFRESH_BUFFER_MS } from '../../shared/constants';
import { appConfig } from '../appConfig';
import { HttpRouteError, readResponseError, sendRouteError } from '../http';
import type { RuntimeState } from '../runtime';
import { parseTwitchGameId } from '../streamCategories';
import { mergeTagSuggestions, normalizeTag, normalizeTags, recordTagHistory, suggestTagHistory } from '../tags';
import { applyRewardGroupsForStreamCategory } from '../viewerRewards';
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

  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(normalizedLogin)}`,
    { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
  );
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch user lookup failed.');
    throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
  }

  const data = await res.json() as { data?: Array<{ id?: string }> };
  const userId = data.data?.[0]?.id;
  if (!userId) throw new HttpRouteError(404, `No Twitch user found for "${normalizedLogin}".`);
  return userId;
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

async function sendTwitchShoutout(state: RuntimeState, login: string) {
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

  const res = await fetch(`https://api.twitch.tv/helix/chat/shoutouts?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
    },
  });
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch shoutout failed.');
    throw new HttpRouteError(res.status === 401 || res.status === 403 || res.status === 429 ? res.status : 502, message);
  }
}

async function sendTwitchWhisper(state: RuntimeState, login: string, message: string) {
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

  const res = await fetch(`https://api.twitch.tv/helix/whispers?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: trimmedMessage }),
  });
  if (!res.ok) {
    const errorMessage = await readResponseError(res, 'Twitch whisper failed.');
    throw new HttpRouteError(res.status === 401 || res.status === 403 || res.status === 429 ? res.status : 502, errorMessage);
  }
}

async function moderateTwitchUser(
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

  const res = await fetch(`https://api.twitch.tv/helix/moderation/bans?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const errorMessage = await readResponseError(res, `Twitch ${action} failed.`);
    throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, errorMessage);
  }
}

export type AutomodResolveResult = { outcome: 'ok' | 'gone'; moderatorLogin: string };

export async function resolveAutomodMessage(
  state: RuntimeState,
  messageId: string,
  action: 'ALLOW' | 'DENY',
): Promise<AutomodResolveResult> {
  const credentials = await getTwitchActionCredentials(state, ['moderator:manage:automod']);
  const moderator = await getAuthenticatedActionUser(state, credentials);

  const res = await fetch('https://api.twitch.tv/helix/moderation/automod/message', {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: moderator.id, msg_id: messageId, action }),
  });
  // 404 means Twitch no longer holds this message (expired or already handled
  // elsewhere). That's not an error for us — the caller resolves it locally as
  // expired so the stuck hold can leave the queue. Anything else is a real fault.
  if (res.status === 404) return { outcome: 'gone', moderatorLogin: moderator.login };
  if (!res.ok) {
    const errorMessage = await readResponseError(res, `Twitch AutoMod ${action.toLowerCase()} failed.`);
    throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, errorMessage);
  }
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
      message: trimmedMessage,
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
  const res = await fetch('https://api.twitch.tv/helix/channels/commercial', {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcaster_id: credentials.broadcasterId,
      length: TWITCH_COMMERCIAL_SECONDS,
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

// Look up a single category by its numeric game id; returns null when Twitch no longer knows it.
export async function getTwitchCategoryById(
  id: string,
  credentials: { clientId: string; authorization: string },
): Promise<{ id: string; name: string; boxArtUrl: string | null } | null> {
  const res = await fetch(
    `https://api.twitch.tv/helix/games?id=${encodeURIComponent(id)}`,
    { headers: { 'Client-Id': credentials.clientId, Authorization: credentials.authorization } },
  );
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch category lookup failed.');
    throw new HttpRouteError(res.status === 401 ? 401 : 502, message);
  }

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

export function registerTwitchApiRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/stream-info', async (_request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, []);
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
      if (!channel) throw new HttpRouteError(404, `No Twitch channel information found for "${appConfig.twitchChannel}".`);

      response.json({
        broadcasterName: channel.broadcaster_name ?? appConfig.twitchChannel,
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

      const headers = await getTwitchApiHeaders(state);
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
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.patch('/api/twitch/stream-info', async (request, response) => {
    try {
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

      // Remember these tags so the type-ahead can suggest them next time.
      recordTagHistory(tags);

      // Swap reward groups to match the new stream category (best-effort — never fails the update).
      await applyRewardGroupsForStreamCategory(state, gameId);

      response.json({ ok: true, title, category: categoryName, categoryId: gameId, tags });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/preroll', async (_request, response) => {
    try {
      response.json({ ok: true, ...await runTwitchCommercial(state) });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/chat-message', async (request, response) => {
    try {
      const body = request.body as { message?: unknown; sender?: unknown };
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const sender = body.sender === 'bot' ? 'bot' : 'user';

      const result = await sendTwitchChatMessage(state, message, sender);

      response.json({
        ok: true,
        messageId: result.messageId,
      });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/shoutout', async (request, response) => {
    try {
      await sendTwitchShoutout(state, request.params.login);
      response.json({ ok: true, message: `Shoutout sent to @${request.params.login}.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/whisper', async (request, response) => {
    try {
      const body = request.body as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      await sendTwitchWhisper(state, request.params.login, message);
      response.json({ ok: true, message: `Whisper sent to @${request.params.login}.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/timeout', async (request, response) => {
    try {
      const body = request.body as { durationSeconds?: unknown; reason?: unknown };
      await moderateTwitchUser(state, request.params.login, 'timeout', {
        durationSeconds: body.durationSeconds,
        reason: body.reason,
      });
      response.json({ ok: true, message: `@${request.params.login} timed out.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/ban', async (request, response) => {
    try {
      const body = request.body as { reason?: unknown };
      await moderateTwitchUser(state, request.params.login, 'ban', { reason: body.reason });
      response.json({ ok: true, message: `@${request.params.login} banned.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}

export { getTwitchAuthStatus, REQUIRED_TWITCH_OAUTH_SCOPES };
