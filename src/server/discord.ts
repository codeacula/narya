import type express from 'express';
import type { DiscordChannel, DiscordGuild, DiscordStatus } from '../shared/api';
import { appConfig } from './appConfig';
import { config } from './config';
import { handle, HttpRouteError, readResponseError } from './http';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_BOT_PERMISSIONS = String((1 << 10) | (1 << 11)); // VIEW_CHANNEL + SEND_MESSAGES
const DISCORD_STATUS_CACHE_MS = 30_000;

let discordStatusCache: { status: DiscordStatus; expiresAtMs: number } | null = null;

export function clearDiscordStatusCache() {
  discordStatusCache = null;
}

type DiscordUserResponse = {
  id?: string;
  username?: string;
  global_name?: string | null;
};

type DiscordGuildResponse = {
  id?: string;
  name?: string;
  icon?: string | null;
};

type DiscordChannelResponse = {
  id?: string;
  guild_id?: string;
  name?: string;
  type?: number;
  position?: number;
  parent_id?: string | null;
};

type DiscordMessageResponse = {
  id?: string;
  channel_id?: string;
};

function discordHeaders(): HeadersInit {
  if (!appConfig.discordBotToken) throw new HttpRouteError(400, 'DISCORD_BOT_TOKEN is not configured.');
  return {
    Authorization: `Bot ${appConfig.discordBotToken}`,
    'Content-Type': 'application/json',
  };
}

async function discordFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      ...discordHeaders(),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    if (response.status === 429) {
      const data = await response.json().catch(() => ({})) as { retry_after?: number; global?: boolean };
      const retryAfter = typeof data.retry_after === 'number' ? data.retry_after : null;
      const scope = data.global ? 'global rate limit' : 'rate limit';
      const retryMsg = retryAfter !== null ? ` Retry after ${retryAfter.toFixed(1)}s.` : '';
      throw new HttpRouteError(429, `Discord ${scope} hit.${retryMsg}`);
    }
    const message = await readResponseError(response, `Discord request failed (${response.status}).`);
    throw new HttpRouteError(response.status === 401 || response.status === 403 ? response.status : 502, message);
  }

  return response.json() as Promise<T>;
}

export function buildDiscordInstallUrl(): string | null {
  if (!appConfig.discordClientId) return null;
  const params = new URLSearchParams({
    client_id: appConfig.discordClientId,
    scope: 'bot',
    permissions: DISCORD_BOT_PERMISSIONS,
    integration_type: '0',
  });
  if (config.discordRedirectUri) params.set('redirect_uri', config.discordRedirectUri);
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function displayBotUser(user: DiscordUserResponse): string | null {
  const name = user.global_name || user.username;
  return name ? `${name}${user.id ? ` (${user.id})` : ''}` : null;
}

export async function getDiscordStatus(): Promise<DiscordStatus> {
  if (discordStatusCache && discordStatusCache.expiresAtMs > Date.now()) {
    return discordStatusCache.status;
  }

  const baseStatus = {
    clientIdConfigured: Boolean(appConfig.discordClientId),
    botTokenConfigured: Boolean(appConfig.discordBotToken),
    ready: false,
    botUser: null,
    installUrl: buildDiscordInstallUrl(),
    error: null,
  };

  if (!appConfig.discordBotToken) {
    const status = { ...baseStatus, error: 'DISCORD_BOT_TOKEN is not configured.' };
    discordStatusCache = { status, expiresAtMs: Date.now() + DISCORD_STATUS_CACHE_MS };
    return status;
  }

  try {
    const user = await discordFetch<DiscordUserResponse>('/users/@me');
    const status = { ...baseStatus, ready: true, botUser: displayBotUser(user) };
    discordStatusCache = { status, expiresAtMs: Date.now() + DISCORD_STATUS_CACHE_MS };
    return status;
  } catch (error) {
    const status = { ...baseStatus, error: error instanceof Error ? error.message : 'Discord bot check failed.' };
    discordStatusCache = { status, expiresAtMs: Date.now() + 5_000 };
    return status;
  }
}

export async function listDiscordGuilds(): Promise<DiscordGuild[]> {
  const rows = await discordFetch<DiscordGuildResponse[]>('/users/@me/guilds?limit=200');
  return rows
    .filter((row): row is Required<Pick<DiscordGuildResponse, 'id' | 'name'>> & DiscordGuildResponse => Boolean(row.id && row.name))
    .map(row => ({
      id: row.id,
      name: row.name,
      icon: row.icon ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDiscordChannels(guildId: string): Promise<DiscordChannel[]> {
  const trimmedGuildId = guildId.trim();
  if (!trimmedGuildId) throw new HttpRouteError(400, 'Discord server is required.');

  const rows = await discordFetch<DiscordChannelResponse[]>(`/guilds/${encodeURIComponent(trimmedGuildId)}/channels`);
  return rows
    .filter(row => row.id && row.name && (row.type === 0 || row.type === 5))
    .map(row => ({
      id: row.id as string,
      guildId: row.guild_id ?? trimmedGuildId,
      name: row.name as string,
      type: row.type === 5 ? 'announcement' as const : 'text' as const,
      position: row.position ?? 0,
      parentId: row.parent_id ?? null,
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export async function sendDiscordMessage(channelId: string, content: string): Promise<{ id: string; channelId: string }> {
  const trimmedChannelId = channelId.trim();
  const message = content.trim();
  if (!trimmedChannelId) throw new HttpRouteError(400, 'Discord channel is required.');
  if (!message) throw new HttpRouteError(400, 'Discord announcement message is required.');
  if (message.length > 2000) throw new HttpRouteError(400, 'Discord announcement message must be 2000 characters or fewer.');

  const response = await discordFetch<DiscordMessageResponse>(`/channels/${encodeURIComponent(trimmedChannelId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.id) throw new HttpRouteError(502, 'Discord did not return a message ID.');
  return {
    id: response.id,
    channelId: response.channel_id ?? trimmedChannelId,
  };
}

export function registerDiscordRoutes(app: express.Express) {
  app.get('/api/auth/discord', (_request, response) => {
    const installUrl = buildDiscordInstallUrl();
    if (!installUrl) {
      response.status(400).json({ error: 'DISCORD_CLIENT_ID is not configured.' });
      return;
    }
    response.redirect(installUrl);
  });

  app.get('/api/auth/discord/callback', (_request, response) => {
    response.redirect('/dashboard?discord=installed');
  });

  app.get('/api/discord/status', async (_request, response) => {
    response.json(await getDiscordStatus());
  });

  app.post('/api/discord/status/refresh', async (_request, response) => {
    clearDiscordStatusCache();
    response.json(await getDiscordStatus());
  });

  app.get('/api/discord/guilds', handle(async (_request, response) => {
    response.json(await listDiscordGuilds());
  }));

  app.get('/api/discord/guilds/:guildId/channels', handle(async (request, response) => {
    response.json(await listDiscordChannels(request.params.guildId));
  }));
}
