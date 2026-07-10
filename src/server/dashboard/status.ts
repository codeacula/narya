import type express from 'express';
import {
  DASHBOARD_HEARTBEAT_MS,
  DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT,
  THANK_WORTHY_EVENT_KINDS,
  TWITCH_AD_SCHEDULE_CACHE_MS,
  TWITCH_STREAM_STATUS_CACHE_MS,
} from '../../shared/constants';
import type { SessionShoutout, ViewerRosterEntry } from '../../shared/api';
import { chatHighlight, getViewerRolesFromBadges } from '../../shared/roles';
import { twitchClient } from '../chat';
import { appConfig } from '../appConfig';
import { db } from '../db';
import { HttpRouteError, sendRouteError } from '../http';
import { getObsDashboardStats, isObsConnected } from '../obs';
import { broadcast, getSocketCount } from '../realtime';
import type { AdSchedule, AdScheduleStatus, RuntimeState, StreamActivityStatus } from '../runtime';
import { getActiveStreamSession, getCurrentStreamSessionId, getSessionChatterCount } from '../streamSession';
import { getTwitchAuthStatus, REQUIRED_TWITCH_OAUTH_SCOPES } from '../twitch/auth';
import { fetchBroadcasterId, getTwitchApiHeaders, getTwitchUserApiHeaders } from '../twitch/api';

type ChatMessageRow = {
  id: string;
  username: string;
  message: string;
  receivedAt: string;
  badgesJson: string | null;
  isFirstThisSession: number;
  isFirstEver: number;
  sessionId: string | null;
};

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

function parseBadgesJson(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch (error) {
    console.error('Chat: failed to parse badges JSON:', error);
    return null;
  }
}

function parseTagsJson(value: string): string[] {
  try {
    const tags = JSON.parse(value) as unknown;
    if (!Array.isArray(tags)) return [];
    return tags.filter((tag): tag is string => typeof tag === 'string');
  } catch (error) {
    console.error('Dashboard: failed to parse viewer tags JSON:', error);
    return [];
  }
}

function normalizeViewerProfileBody(body: unknown) {
  const value = body as { realName?: unknown; tags?: unknown; note?: unknown };
  const realName = typeof value.realName === 'string' ? value.realName.trim() : '';
  const note = typeof value.note === 'string' ? value.note.trim() : '';
  if (realName.length > 120) throw new HttpRouteError(400, 'Real name must be 120 characters or fewer.');
  if (note.length > 1000) throw new HttpRouteError(400, 'Note must be 1000 characters or fewer.');

  const inputTags = Array.isArray(value.tags) ? value.tags : [];
  if (inputTags.length > 12) throw new HttpRouteError(400, 'A viewer can have at most 12 tags.');

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of inputTags) {
    if (typeof item !== 'string') throw new HttpRouteError(400, 'Tags must be strings.');
    const tag = item.trim();
    if (!tag) continue;
    if (tag.length > 32) throw new HttpRouteError(400, 'Tags must be 32 characters or fewer.');
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return { realName, tags, note };
}

function fallbackColor(login: string): string {
  const palette = ['#ffc488', '#d7dce2', '#a8e0c4', '#9ccae8', '#bca6f0', '#f0a99d', '#f5f2e0'];
  let hash = 0;
  for (const char of login) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash];
}

function getKnownChatterCount(): number {
  const row = db.prepare('select count(*) as count from chatters').get() as { count: number };
  return row.count;
}

function getActiveChatterCount(): number {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = db
    .prepare('select count(distinct username) as count from chat_messages where received_at >= ?')
    .get(since) as { count: number };
  return row.count;
}

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

export function clearExpiredAdBreak(state: RuntimeState, nowMs = Date.now()) {
  if (!state.adBreakEndsAt) return;
  const endsAtMs = new Date(state.adBreakEndsAt).getTime();
  if (!Number.isFinite(endsAtMs) || endsAtMs > nowMs) return;

  state.adBreakEndsAt = null;
  state.twitchAdScheduleCache = null;
}

export async function getTwitchStreamStatus(state: RuntimeState): Promise<StreamActivityStatus> {
  if (state.twitchStreamStatusCache && state.twitchStreamStatusCache.expiresAtMs > Date.now()) {
    return state.twitchStreamStatusCache.status;
  }

  const unavailable: StreamActivityStatus = {
    streamActive: null,
    uptimeSeconds: null,
    streamStartedAt: null,
    uptimeSource: null,
    viewerCount: null,
  };

  const headers = await getTwitchApiHeaders(state);
  if (!headers) return unavailable;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(appConfig.twitchChannel)}`,
      { headers },
    );

    if (!res.ok) {
      console.error(`Twitch API: stream status failed (${res.status}):`, await res.text());
      return unavailable;
    }

    const data = await res.json() as { data?: Array<{ started_at?: string; viewer_count?: number }> };
    const stream = data.data?.[0] ?? null;
    const startedAt = stream?.started_at ?? null;
    const status: StreamActivityStatus = startedAt
      ? {
          streamActive: true,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
          streamStartedAt: startedAt,
          uptimeSource: 'twitch',
          viewerCount: typeof stream?.viewer_count === 'number' ? stream.viewer_count : null,
        }
      : {
          streamActive: false,
          uptimeSeconds: null,
          streamStartedAt: null,
          uptimeSource: 'twitch',
          viewerCount: null,
        };

    state.twitchStreamStatusCache = {
      expiresAtMs: Date.now() + TWITCH_STREAM_STATUS_CACHE_MS,
      status,
    };

    return status;
  } catch (error) {
    console.error('Twitch API: stream status errored:', error);
    return unavailable;
  }
}

export async function getTwitchAdSchedule(state: RuntimeState): Promise<AdSchedule> {
  clearExpiredAdBreak(state);

  if (state.twitchAdScheduleCache && state.twitchAdScheduleCache.expiresAtMs > Date.now()) {
    return state.twitchAdScheduleCache.schedule;
  }

  const headers = await getTwitchUserApiHeaders(state);
  if (!headers) return emptyAdSchedule('not_configured', 'Twitch user authentication is required for ad schedule data.');

  const cachedToken = state.runtimeUserToken;
  const missingScopes = cachedToken
    ? REQUIRED_TWITCH_OAUTH_SCOPES.filter(scope => !cachedToken.scopes.includes(scope))
    : [];
  if (missingScopes.includes('channel:read:ads')) {
    return emptyAdSchedule('missing_scope', 'Reconnect Twitch to grant channel:read:ads.');
  }

  const bid = state.broadcasterId ?? await fetchBroadcasterId(headers['Client-Id'], headers.userToken);
  if (!bid) return emptyAdSchedule('unavailable', `Could not resolve broadcaster ID for "${appConfig.twitchChannel}".`);
  state.broadcasterId = bid;

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

    state.twitchAdScheduleCache = {
      expiresAtMs: Date.now() + TWITCH_AD_SCHEDULE_CACHE_MS,
      schedule,
    };

    return schedule;
  } catch (error) {
    console.error('Twitch API: ad schedule errored:', error);
    return emptyAdSchedule('unavailable', 'Twitch ad schedule request failed.');
  }
}

export async function getDashboardStatusSnapshot(state: RuntimeState) {
  clearExpiredAdBreak(state);

  const [twitchStreamStatus, obsStats, adSchedule] = await Promise.all([
    getTwitchStreamStatus(state),
    getObsDashboardStats(),
    getTwitchAdSchedule(state),
  ]);
  const {
    streamActive: _obsStreamActive,
    uptimeSeconds: _obsUptimeSeconds,
    streamStartedAt: _obsStreamStartedAt,
    uptimeSource: _obsUptimeSource,
    ...obsHealthStats
  } = obsStats;
  const obsStreamStatus: StreamActivityStatus = {
    streamActive: _obsStreamActive,
    uptimeSeconds: _obsUptimeSeconds,
    streamStartedAt: _obsStreamStartedAt,
    uptimeSource: _obsUptimeSource,
    viewerCount: null,
  };
  const streamStatus = twitchStreamStatus.streamActive === true
    ? twitchStreamStatus
    : obsStreamStatus.streamActive === true
      ? obsStreamStatus
      : twitchStreamStatus.uptimeSource === 'twitch'
        ? twitchStreamStatus
        : obsStreamStatus;
  const activeStreamSession = getActiveStreamSession();

  return {
    channel: appConfig.twitchChannel,
    chatConnection: twitchClient.readyState?.() ?? 'UNKNOWN',
    obsConnected: isObsConnected(),
    eventSubConnected: state.eventSubConnected,
    eventSubError: state.eventSubError,
    ...getTwitchAuthStatus(state),
    ...streamStatus,
    ...obsHealthStats,
    activeChatters: getActiveChatterCount(),
    sessionChatters: getSessionChatterCount(),
    knownChatters: getKnownChatterCount(),
    streamSessionId: activeStreamSession?.id ?? null,
    streamSessionStartedAt: activeStreamSession?.startedAt ?? null,
    adBreakEndsAt: state.adBreakEndsAt,
    ...adSchedule,
  };
}

export function registerDashboardRoutes(app: express.Express, state: RuntimeState) {
  app.get('/api/dashboard/status', async (_request, response) => {
    response.json(await getDashboardStatusSnapshot(state));
  });

  app.get('/api/dashboard/viewers', (_request, response) => {
    const countRows = db.prepare(`
      select login, message_count as msgs, first_seen_at as firstSeen
      from chatters
    `).all() as Array<{ login: string; msgs: number; firstSeen: string }>;

    const counts = new Map(countRows.map(row => [row.login, row]));
    const profileRows = db.prepare(`
      select login, real_name as realName, tags_json as tagsJson, note
      from viewer_profiles
    `).all() as Array<{ login: string; realName: string; tagsJson: string; note: string }>;
    const profiles = new Map(profileRows.map(row => [row.login, {
      realName: row.realName,
      tags: parseTagsJson(row.tagsJson),
      note: row.note,
    }]));
    const recentRows = db.prepare(`
      select username, display_name as displayName, color, message, received_at as receivedAt, badges_json as badgesJson
      from chat_messages
      order by received_at desc
      limit ${DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT}
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
      realName: string;
      tags: string[];
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
        const roles = getViewerRolesFromBadges(badges);
        const profile = profiles.get(login);
        viewers[login] = {
          login,
          display: row.displayName,
          color: row.color ?? fallbackColor(login),
          realName: profile?.realName ?? '',
          tags: profile?.tags ?? [],
          pronouns: 'not available',
          roles,
          followed: 'not available',
          subbed: roles.includes('sub') ? 'subscriber badge present' : 'not available',
          seen: formatFirstSeen(count.firstSeen),
          msgs: count.msgs,
          accountAge: 'not available',
          note: profile?.note ?? '',
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

  // The full roster: everyone in the persistent `chatters` table, each joined to
  // their most recent message for a current display name/color/badges. Ordered
  // most-recently-seen first so "who's come by" reads top-down. Client-side search
  // covers the rest; a channel with tens of thousands of chatters would want
  // server-side paging, but this stays simple for the common case.
  app.get('/api/viewers/roster', (_request, response) => {
    const rows = db.prepare(`
      select
        c.login as login,
        c.first_seen_at as firstSeen,
        c.message_count as msgs,
        m.display_name as display,
        m.color as color,
        m.received_at as lastSeen,
        m.badges_json as badgesJson
      from chatters c
      left join (
        select username, display_name, color, received_at, badges_json,
               row_number() over (partition by username order by received_at desc) as rn
        from chat_messages
      ) m on m.username = c.login and m.rn = 1
      order by coalesce(m.received_at, c.first_seen_at) desc
    `).all() as Array<{
      login: string;
      firstSeen: string;
      msgs: number;
      display: string | null;
      color: string | null;
      lastSeen: string | null;
      badgesJson: string | null;
    }>;

    const noteRows = db.prepare(`select login, note from viewer_profiles`).all() as Array<{ login: string; note: string }>;
    const notes = new Map(noteRows.map(row => [row.login, row.note]));

    const roster: ViewerRosterEntry[] = rows.map(row => ({
      login: row.login,
      display: row.display ?? row.login,
      color: row.color ?? fallbackColor(row.login),
      roles: getViewerRolesFromBadges(parseBadgesJson(row.badgesJson)),
      messageCount: row.msgs,
      firstSeenAt: row.firstSeen,
      lastSeenAt: row.lastSeen ?? row.firstSeen,
      note: notes.get(row.login) ?? '',
    }));

    response.json(roster);
  });

  app.patch('/api/dashboard/viewers/:login/profile', (request, response) => {
    try {
      const login = request.params.login.trim().toLowerCase();
      if (!login) throw new HttpRouteError(400, 'Viewer login is required.');

      const profile = normalizeViewerProfileBody(request.body);
      const now = new Date().toISOString();
      db.prepare(`
        insert into viewer_profiles (login, real_name, tags_json, note, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(login) do update set
          real_name = excluded.real_name,
          tags_json = excluded.tags_json,
          note = excluded.note,
          updated_at = excluded.updated_at
      `).run(login, profile.realName, JSON.stringify(profile.tags), profile.note, now, now);

      response.json(profile);
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/dashboard/chat', (_request, response) => {
    const beforeId = typeof _request.query['before'] === 'string' ? _request.query['before'] : null;

    const rows = beforeId
      ? db.prepare(`
          select
            id,
            username,
            message,
            received_at as receivedAt,
            badges_json as badgesJson,
            is_first_in_session as isFirstThisSession,
            is_first_ever as isFirstEver,
            stream_session_id as sessionId
          from chat_messages
          where (received_at, id) < (select received_at, id from chat_messages where id = ?)
          order by received_at desc, id desc
          limit 80
        `).all(beforeId) as Array<{
          id: string;
          username: string;
          message: string;
          receivedAt: string;
          badgesJson: string | null;
          isFirstThisSession: number;
          isFirstEver: number;
          sessionId: string | null;
        }>
      : db.prepare(`
          select
            id,
            username,
            message,
            received_at as receivedAt,
            badges_json as badgesJson,
            is_first_in_session as isFirstThisSession,
            is_first_ever as isFirstEver,
            stream_session_id as sessionId
          from chat_messages
          order by received_at desc, id desc
          limit 80
        `).all() as Array<{
          id: string;
          username: string;
          message: string;
          receivedAt: string;
          badgesJson: string | null;
          isFirstThisSession: number;
          isFirstEver: number;
          sessionId: string | null;
        }>;

    response.json(rows.reverse().map((row) => {
      const badges = parseBadgesJson(row.badgesJson);
      return {
        id: row.id,
        user: row.username.toLowerCase(),
        text: row.message,
        time: formatClockTime(row.receivedAt),
        at: row.receivedAt,
        sessionId: row.sessionId,
        highlight: chatHighlight(badges, Boolean(row.isFirstEver), Boolean(row.isFirstThisSession)),
      };
    }));
  });

  // A single viewer's full chat history, newest-first with keyset pagination
  // (`?before=<id>`). Uses the username index; the keyset is scoped to the same
  // username so paging never leaks other viewers' messages.
  app.get('/api/viewers/:login/messages', (request, response) => {
    const login = request.params.login.trim().toLowerCase();
    if (!login) {
      sendRouteError(response, new HttpRouteError(400, 'Viewer login is required.'));
      return;
    }
    const beforeId = typeof request.query['before'] === 'string' ? request.query['before'] : null;

    const rows = beforeId
      ? db.prepare(`
          select
            id, username, message, received_at as receivedAt,
            badges_json as badgesJson, is_first_in_session as isFirstThisSession,
            is_first_ever as isFirstEver, stream_session_id as sessionId
          from chat_messages
          where username = ?
            and (received_at, id) < (select received_at, id from chat_messages where id = ?)
          order by received_at desc, id desc
          limit 80
        `).all(login, beforeId) as ChatMessageRow[]
      : db.prepare(`
          select
            id, username, message, received_at as receivedAt,
            badges_json as badgesJson, is_first_in_session as isFirstThisSession,
            is_first_ever as isFirstEver, stream_session_id as sessionId
          from chat_messages
          where username = ?
          order by received_at desc, id desc
          limit 80
        `).all(login) as ChatMessageRow[];

    response.json(rows.reverse().map((row) => {
      const badges = parseBadgesJson(row.badgesJson);
      return {
        id: row.id,
        user: row.username.toLowerCase(),
        text: row.message,
        time: formatClockTime(row.receivedAt),
        at: row.receivedAt,
        sessionId: row.sessionId,
        highlight: chatHighlight(badges, Boolean(row.isFirstEver), Boolean(row.isFirstThisSession)),
      };
    }));
  });

  app.get('/api/dashboard/events', (_request, response) => {
    const rows = db.prepare(`
      select id, kind, actor, detail, tone, received_at as receivedAt, session_id as sessionId
      from stream_events
      order by received_at desc
      limit 50
    `).all() as Array<{
      id: string; kind: string; actor: string; detail: string;
      tone: string; receivedAt: string; sessionId: string | null;
    }>;

    if (rows.length > 0) {
      response.json(rows.map(r => ({ ...r, ago: formatAgo(r.receivedAt) })));
      return;
    }

    response.json([]);
  });

  // Everyone worth thanking this session, newest activity first. Unlike the
  // 50-row event feed this reads the whole session, so a long stream doesn't
  // drop the people who showed up early.
  app.get('/api/dashboard/session-shoutouts', (_request, response) => {
    response.json(getSessionShoutouts());
  });
}

// An allowlist, matching the attention feed's: a new non-thankable kind must not
// silently appear on the public /overlay/shoutouts ticker.
const shoutoutKindPlaceholders = THANK_WORTHY_EVENT_KINDS.map(() => '?').join(', ');
const selectSessionShoutoutRows = db.prepare(`
  select kind, actor, actor_login as login, detail, received_at as receivedAt
  from stream_events
  where session_id = ? and kind in (${shoutoutKindPlaceholders})
  order by received_at asc
`);

export function getSessionShoutouts(): SessionShoutout[] {
  const sessionId = getCurrentStreamSessionId();
  if (!sessionId) return [];

  const rows = selectSessionShoutoutRows.all(sessionId, ...THANK_WORTHY_EVENT_KINDS) as Array<{
    kind: string; actor: string; login: string | null; detail: string; receivedAt: string;
  }>;

  const byActor = new Map<string, SessionShoutout>();
  for (const row of rows) {
    // Group by login where we have one; older rows fall back to the display name.
    const key = row.login ?? row.actor.toLowerCase();
    const existing = byActor.get(key);
    if (!existing) {
      byActor.set(key, {
        actor: row.actor,
        login: row.login,
        kinds: [row.kind],
        detail: row.detail,
        firstAt: row.receivedAt,
        lastAt: row.receivedAt,
      });
      continue;
    }
    if (!existing.kinds.includes(row.kind)) existing.kinds.push(row.kind);
    // Keep the most recent detail — a resub says more than the follow that preceded it.
    existing.detail = row.detail;
    existing.lastAt = row.receivedAt;
    existing.login ??= row.login;
  }

  return [...byActor.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function startDashboardHeartbeat(state: RuntimeState) {
  setInterval(() => {
    if (getSocketCount() === 0) return;

    void getDashboardStatusSnapshot(state)
      .then(status => broadcast('dashboard:status', status))
      .catch(error => console.error('Dashboard heartbeat failed:', error));
  }, DASHBOARD_HEARTBEAT_MS);
}
