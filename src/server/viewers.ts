import type express from 'express';
import type {
  Chatter,
  IgnoredLogin,
  ViewerFlushResult,
  ViewerRefreshResult,
  ViewerRosterEntry,
} from '../shared/api';
import { buildViewerRoster } from './dashboard/status';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import type { RuntimeState } from './runtime';
import { getTwitchActionCredentials, resolveTwitchUserId, twitchFetch } from './twitch/api';
import { flushViewer, ignoredLogins, saveChatterProfile, unflushViewer } from './viewerIdentity';

const HELIX = 'https://api.twitch.tv/helix';
const VIP_SCOPE = 'channel:manage:vips';
const MOD_SCOPE = 'channel:manage:moderators';

const selectStoredChatter = db.prepare('select twitch_user_id as twitchUserId from chatters where login = ?');

function getStoredChatter(login: string): { twitchUserId: string | null } | null {
  return selectStoredChatter.get(login) as { twitchUserId: string | null } | null;
}

function getRosterEntry(login: string): ViewerRosterEntry | null {
  return buildViewerRoster(login)[0] ?? null;
}

type ActionCredentials = Awaited<ReturnType<typeof getTwitchActionCredentials>>;

async function listRoleUsers(url: string, credentials: ActionCredentials): Promise<Chatter[]> {
  // Helix caps each page at 100 and returns a cursor; a channel with more than
  // 100 mods/VIPs would otherwise drop everyone past the first page, so they'd
  // show as ordinary users with the wrong (grant, not revoke) role action.
  const users: Chatter[] = [];
  let cursor: string | undefined;
  do {
    const pageUrl = cursor ? `${url}&after=${encodeURIComponent(cursor)}` : url;
    const res = await twitchFetch(pageUrl, { credentials, errorMessage: 'Twitch request failed.' });
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
  await twitchFetch(`${HELIX}${path}?${params.toString()}`, {
    credentials,
    method,
    errorMessage: 'Twitch request failed.',
    passthroughStatuses: [400, 401, 403, 409, 422],
  });
}

export function registerViewerRoleRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/twitch/vips', handle(async (_request, response) => {
    const credentials = await getTwitchActionCredentials(state, [VIP_SCOPE]);
    const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
    response.json(await listRoleUsers(`${HELIX}/channels/vips?${params.toString()}`, credentials));
  }));

  app.get('/api/twitch/moderators', handle(async (_request, response) => {
    const credentials = await getTwitchActionCredentials(state, [MOD_SCOPE]);
    const params = new URLSearchParams({ broadcaster_id: credentials.broadcasterId, first: '100' });
    response.json(await listRoleUsers(`${HELIX}/moderation/moderators?${params.toString()}`, credentials));
  }));

  app.post('/api/twitch/users/:login/vip', handle(async (request, response) => {
    await writeRole(state, VIP_SCOPE, '/channels/vips', 'POST', request.params.login);
    response.json({ ok: true, message: `@${request.params.login} is now a VIP.` });
  }));

  app.delete('/api/twitch/users/:login/vip', handle(async (request, response) => {
    await writeRole(state, VIP_SCOPE, '/channels/vips', 'DELETE', request.params.login);
    response.json({ ok: true, message: `@${request.params.login} is no longer a VIP.` });
  }));

  app.post('/api/twitch/users/:login/moderator', handle(async (request, response) => {
    await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'POST', request.params.login);
    response.json({ ok: true, message: `@${request.params.login} is now a moderator.` });
  }));

  app.delete('/api/twitch/users/:login/moderator', handle(async (request, response) => {
    await writeRole(state, MOD_SCOPE, '/moderation/moderators', 'DELETE', request.params.login);
    response.json({ ok: true, message: `@${request.params.login} is no longer a moderator.` });
  }));

  /**
   * Re-fetch one viewer from Twitch and persist what comes back.
   *
   * Looks up by stored `twitch_user_id` when we have one, because a login is not a
   * stable identity — that is exactly how this detects a rename. An account Twitch no
   * longer returns is marked `missing` rather than deleted: it is still part of the
   * channel's history, and dropping it would silently rewrite past chat.
   */
  app.post('/api/viewers/:login/refresh', handle(async (request, response) => {
    const login = request.params.login.trim().replace(/^@/, '').toLowerCase();
    if (!login) throw new HttpRouteError(400, 'Viewer login is required.');

    const credentials = await getTwitchActionCredentials(state, []);
    const stored = getStoredChatter(login);

    const params = new URLSearchParams();
    if (stored?.twitchUserId) params.append('id', stored.twitchUserId);
    else params.append('login', login);

    const res = await twitchFetch(`${HELIX}/users?${params.toString()}`, {
      credentials,
      errorMessage: 'Twitch user lookup failed.',
    });
    const data = await res.json() as {
      data?: Array<{ id: string; login: string; display_name: string; profile_image_url: string; created_at: string }>;
    };
    const user = data.data?.[0];

    if (!user) {
      saveChatterProfile({ login, missing: true });
      response.json({ login, found: false, renamedTo: null, entry: getRosterEntry(login) } satisfies ViewerRefreshResult);
      return;
    }

    saveChatterProfile({
      login,
      userId: user.id,
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
      accountCreatedAt: user.created_at,
    });

    const renamedTo = user.login.toLowerCase() !== login ? user.login.toLowerCase() : null;
    response.json({ login, found: true, renamedTo, entry: getRosterEntry(login) } satisfies ViewerRefreshResult);
  }));

  /**
   * Remove a viewer from the roster and keep them out. See flushViewer — the ignore
   * entry is what stops the next chat message or presence poll recreating the row.
   */
  app.post('/api/viewers/:login/flush', handle((request, response) => {
    const login = request.params.login.trim().replace(/^@/, '').toLowerCase();
    if (!login) throw new HttpRouteError(400, 'Viewer login is required.');

    const reason = typeof request.body?.reason === 'string' ? request.body.reason.slice(0, 200) : '';
    const { messages, quotes } = flushViewer(login, reason);
    response.json({ login, messagesRemoved: messages, quotesAnonymized: quotes } satisfies ViewerFlushResult);
  }));

  app.get('/api/viewers/ignored', handle((_request, response) => {
    response.json(ignoredLogins() satisfies IgnoredLogin[]);
  }));

  app.delete('/api/viewers/ignored/:login', handle((request, response) => {
    unflushViewer(request.params.login);
    response.json({ ok: true });
  }));
}
