import type { Express } from 'express';
import type { ChattersResponse } from '../shared/api';
import { handle } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials } from './twitch/api';

const CHATTERS_SCOPE = 'moderator:read:chatters';

type TwitchChattersData = {
  data: Array<{ user_id: string; user_login: string; user_name: string }>;
  total: number;
  pagination?: { cursor?: string };
};

export function registerChattersRoutes(app: Express, state: RuntimeState) {
  app.get('/api/chatters', handle(async (_req, res) => {
    const creds = await getTwitchActionCredentials(state, [CHATTERS_SCOPE]);
    const params = new URLSearchParams({
      broadcaster_id: creds.broadcasterId,
      moderator_id: creds.broadcasterId,
      first: '1000',
    });
    const twitchRes = await fetch(
      `https://api.twitch.tv/helix/chat/chatters?${params.toString()}`,
      { headers: { 'Client-Id': creds.clientId, Authorization: creds.authorization } },
    );
    if (!twitchRes.ok) {
      res.status(twitchRes.status).json({ error: `Twitch API error: ${twitchRes.statusText}` });
      return;
    }
    const data = await twitchRes.json() as TwitchChattersData;
    const response: ChattersResponse = {
      chatters: data.data.map(c => ({
        userId: c.user_id,
        userLogin: c.user_login,
        userName: c.user_name,
      })),
      total: data.total,
    };
    res.json(response);
  }));
}
