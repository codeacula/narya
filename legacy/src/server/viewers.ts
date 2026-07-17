import type express from 'express';
import type { Chatter } from '../shared/api';
import { HttpRouteError, readResponseError, sendRouteError } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials, resolveTwitchUserId } from './twitch/api';

const HELIX = 'https://api.twitch.tv/helix';
const VIP_SCOPE = 'channel:manage:vips';
const MOD_SCOPE = 'channel:manage:moderators';

type ActionCredentials = Awaited<ReturnType<typeof getTwitchActionCredentials>>;

function getHeaders(credentials: ActionCredentials) {
  return { 'Client-Id': credentials.clientId, Authorization: credentials.authorization };
}

async function listRoleUsers(url: string, credentials: ActionCredentials): Promise<Chatter[]> {
  // Helix caps each page at 100 and returns a cursor; a channel with more than
  // 100 mods/VIPs would otherwise drop everyone past the first page, so they'd
  // show as ordinary users with the wrong (grant, not revoke) role action.
  const users: Chatter[] = [];
  let cursor: string | undefined;
  do {
    const pageUrl = cursor ? `${url}&after=${encodeURIComponent(cursor)}` : url;
    const res = await fetch(pageUrl, { headers: getHeaders(credentials) });
    if (!res.ok) {
      const message = await readResponseError(res, 'Twitch request failed.');
      throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, message);
    }
    const data = await res.json() as {
      data?: Array<{ user_id: string; user_login: string; user_name: string }>;
      pagination?: { cursor?: string };
    };
    for (const user of data.data ?? []) {
      users.push({ userId: user.user_id, userLogin: user.user_login, userName: user.user_name });
    }
    cursor = data.pagination?.cursor || undefined;
  } while (cursor);
  return users;
}

async function writeRole(
  state: RuntimeState,
  scope: string,
  path: string,
  method: 'POST' | 'DELETE',
  login: string,
): Promise<void> {
  const credentials = await getTwitchActionCredentials(state, [scope]);
  const targetId = await resolveTwitchUserId(login, { clientId: credentials.clientId, authorization: credentials.authorization });
  const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, user_id: targetId });
  const res = await fetch(`${HELIX}${path}?${params.toString()}`, { method, headers: getHeaders(credentials) });
  if (!res.ok) {
    const message = await readResponseError(res, 'Twitch request failed.');
    const status = [400, 401, 403, 409, 422].includes(res.status) ? res.status : 502;
    throw new HttpRouteError(status, message);
  }
}

export function registerViewerRoleRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/vips', async (_request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, [VIP_SCOPE]);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
      response.json(await listRoleUsers(`${HELIX}/channels/vips?${params.toString()}`, credentials));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/twitch/moderators', async (_request, response) => {
    try {
      const credentials = await getTwitchActionCredentials(state, [MOD_SCOPE]);
      const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
      response.json(await listRoleUsers(`${HELIX}/moderation/moderators?${params.toString()}`, credentials));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/vip', async (request, response) => {
    try {
      await writeRole(state, VIP_SCOPE, '/channels/vips', 'POST', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is now a VIP.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/users/:login/vip', async (request, response) => {
    try {
      await writeRole(state, VIP_SCOPE, '/channels/vips', 'DELETE', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is no longer a VIP.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/twitch/users/:login/moderator', async (request, response) => {
    try {
      await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'POST', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is now a moderator.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/twitch/users/:login/moderator', async (request, response) => {
    try {
      await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'DELETE', request.params.login);
      response.json({ ok: true, message: `@${request.params.login} is no longer a moderator.` });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
