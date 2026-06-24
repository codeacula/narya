import type express from 'express';
import { TOKEN_EXPIRY_REFRESH_BUFFER_MS } from '../../shared/constants';
import { config } from '../config';
import { HttpRouteError, readResponseError, sendRouteError } from '../http';
import type { RuntimeState } from '../runtime';
import {
  getTwitchBotAccessToken,
  getTwitchAuthStatus,
  getTwitchUserAccessToken,
  loadCachedTwitchBotToken,
  loadCachedTwitchUserToken,
  REQUIRED_TWITCH_BOT_OAUTH_SCOPES,
  REQUIRED_TWITCH_OAUTH_SCOPES,
} from './auth';

const TWITCH_PREROLL_COMMERCIAL_SECONDS = 180;
const TWITCH_DEFAULT_TIMEOUT_SECONDS = 600;
const TWITCH_MAX_TIMEOUT_SECONDS = 1_209_600;
type TwitchChatSender = 'user' | 'bot';

export async function getEventSubCredentials(state: RuntimeState): Promise<{ clientId: string; userToken: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = await getTwitchUserAccessToken(state);
  if (!clientId || !userToken) return null;
  return { clientId, userToken };
}

export async function getTwitchApiHeaders(state: RuntimeState): Promise<{ 'Client-Id': string; Authorization: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  if (!clientId) return null;

  const userToken = await getTwitchUserAccessToken(state);
  if (userToken) {
    return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}` };
  }

  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
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
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = await getTwitchUserAccessToken(state);
  if (!clientId || !userToken) return null;
  return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}`, userToken };
}

export async function getTwitchBotApiHeaders(state: RuntimeState): Promise<{ 'Client-Id': string; Authorization: string; userToken: string } | null> {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const userToken = await getTwitchBotAccessToken(state);
  if (!clientId || !userToken) return null;
  return { 'Client-Id': clientId, Authorization: `Bearer ${userToken}`, userToken };
}

export async function fetchBroadcasterId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(config.twitchChannel)}`,
      { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch (error) {
    console.error(`Twitch API: failed to resolve broadcaster ID for "${config.twitchChannel}":`, error);
    return null;
  }
}

export async function fetchAuthenticatedTwitchUserId(clientId: string, userToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${userToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data[0]?.id ?? null;
  } catch (error) {
    console.error('Twitch API: failed to resolve authenticated user ID:', error);
    return null;
  }
}

async function resolveTwitchUserId(login: string, credentials: { clientId: string; authorization: string }): Promise<string> {
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

async function getAuthenticatedActionUserId(
  state: RuntimeState,
  credentials: Awaited<ReturnType<typeof getTwitchActionCredentials>>,
): Promise<string> {
  const userId = state.twitchSenderId ?? await fetchAuthenticatedTwitchUserId(credentials.clientId, credentials.userToken);
  if (!userId) throw new HttpRouteError(502, 'Could not resolve the authenticated Twitch user.');
  state.twitchSenderId = userId;
  return userId;
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

export async function getTwitchActionCredentials(state: RuntimeState, scopes: readonly string[]) {
  const headers = await getTwitchUserApiHeaders(state);
  if (!headers) throw new HttpRouteError(401, 'Twitch login is required.');

  const missingScopes = getMissingTwitchScopes(state, scopes);
  if (missingScopes.length > 0) {
    throw new HttpRouteError(403, `Reconnect Twitch to grant: ${missingScopes.join(', ')}`);
  }

  const bid = state.broadcasterId ?? await fetchBroadcasterId(headers['Client-Id'], headers.userToken);
  if (!bid) throw new HttpRouteError(502, `Could not resolve broadcaster ID for "${config.twitchChannel}".`);
  state.broadcasterId = bid;

  return {
    clientId: headers['Client-Id'],
    authorization: headers.Authorization,
    userToken: headers.userToken,
    broadcasterId: bid,
  };
}

async function getTwitchChatCredentials(state: RuntimeState, sender: TwitchChatSender) {
  if (sender === 'bot') {
    const botHeaders = await getTwitchBotApiHeaders(state);
    if (!botHeaders) throw new HttpRouteError(401, 'Twitch bot login is required.');

    const missingBotScopes = getMissingTwitchBotScopes(state, REQUIRED_TWITCH_BOT_OAUTH_SCOPES);
    if (missingBotScopes.length > 0) {
      throw new HttpRouteError(403, `Reconnect Twitch bot to grant: ${missingBotScopes.join(', ')}`);
    }

    const bid = state.broadcasterId ?? await fetchBroadcasterId(botHeaders['Client-Id'], botHeaders.userToken);
    if (!bid) throw new HttpRouteError(502, `Could not resolve broadcaster ID for "${config.twitchChannel}".`);
    state.broadcasterId = bid;

    return {
      clientId: botHeaders['Client-Id'],
      authorization: botHeaders.Authorization,
      userToken: botHeaders.userToken,
      broadcasterId: bid,
      senderIdKey: 'bot' as const,
    };
  }

  const userCredentials = await getTwitchActionCredentials(state, []);
  const missingUserScopes = getMissingTwitchScopes(state, ['user:write:chat']);
  if (missingUserScopes.length > 0) {
    throw new HttpRouteError(403, `Reconnect Twitch to grant: ${missingUserScopes.join(', ')}`);
  }
  return {
    clientId: userCredentials.clientId,
    authorization: userCredentials.authorization,
    userToken: userCredentials.userToken,
    broadcasterId: userCredentials.broadcasterId,
    senderIdKey: 'user' as const,
  };
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
  const senderId = cachedSenderId ?? await fetchAuthenticatedTwitchUserId(credentials.clientId, credentials.userToken);
  if (!senderId) throw new HttpRouteError(502, 'Could not resolve the authenticated Twitch user.');
  if (credentials.senderIdKey === 'bot') state.twitchBotSenderId = senderId;
  else state.twitchSenderId = senderId;

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

export function normalizeTags(value: unknown): string[] {
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

export function normalizeTwitchTagCandidate(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
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
      if (!channel) throw new HttpRouteError(404, `No Twitch channel information found for "${config.twitchChannel}".`);

      response.json({
        broadcasterName: channel.broadcaster_name ?? config.twitchChannel,
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
      const credentials = await getTwitchActionCredentials(state, []);
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

      const credentials = await getTwitchActionCredentials(state, ['channel:manage:broadcast']);
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

      state.adBreakEndsAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
      state.twitchAdScheduleCache = null;

      response.json({
        ok: true,
        durationSeconds,
        message: commercial.message ?? null,
        retryAfterSeconds: typeof commercial.retry_after === 'number' ? commercial.retry_after : null,
        adBreakEndsAt: state.adBreakEndsAt,
      });
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
