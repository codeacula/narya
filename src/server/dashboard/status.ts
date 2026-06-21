import type express from 'express';
import {
  DASHBOARD_HEARTBEAT_MS,
  DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT,
  TWITCH_AD_SCHEDULE_CACHE_MS,
  TWITCH_STREAM_STATUS_CACHE_MS,
} from '../../shared/constants';
import { getViewerRolesFromBadges } from '../../shared/roles';
import { getSessionChatterCount, twitchClient } from '../chat';
import { config } from '../config';
import { db } from '../db';
import { getObsDashboardStats, isObsConnected } from '../obs';
import { broadcast, getSocketCount } from '../realtime';
import type { AdSchedule, AdScheduleStatus, RuntimeState, StreamActivityStatus } from '../runtime';
import { getTwitchAuthStatus, REQUIRED_TWITCH_OAUTH_SCOPES } from '../twitch/auth';
import { fetchBroadcasterId, getTwitchApiHeaders, getTwitchUserApiHeaders } from '../twitch/api';

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

async function getTwitchStreamStatus(state: RuntimeState): Promise<StreamActivityStatus> {
  if (state.twitchStreamStatusCache && state.twitchStreamStatusCache.expiresAtMs > Date.now()) {
    return state.twitchStreamStatusCache.status;
  }

  const unavailable: StreamActivityStatus = {
    streamActive: null,
    uptimeSeconds: null,
    streamStartedAt: null,
    uptimeSource: null,
  };

  const headers = await getTwitchApiHeaders(state);
  if (!headers) return unavailable;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(config.twitchChannel)}`,
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

async function getTwitchAdSchedule(state: RuntimeState): Promise<AdSchedule> {
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
  if (!bid) return emptyAdSchedule('unavailable', `Could not resolve broadcaster ID for "${config.twitchChannel}".`);
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
  const streamStatus = twitchStreamStatus.uptimeSource === 'twitch'
    ? twitchStreamStatus
    : {
        streamActive: _obsStreamActive,
        uptimeSeconds: _obsUptimeSeconds,
        streamStartedAt: _obsStreamStartedAt,
        uptimeSource: _obsUptimeSource,
      };

  return {
    channel: config.twitchChannel,
    chatConnection: twitchClient.readyState?.() ?? 'UNKNOWN',
    obsConnected: isObsConnected(),
    eventSubConnected: state.eventSubConnected,
    ...getTwitchAuthStatus(state),
    ...streamStatus,
    ...obsHealthStats,
    activeChatters: getActiveChatterCount(),
    sessionChatters: getSessionChatterCount(),
    knownChatters: getKnownChatterCount(),
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
      select lower(username) as login, count(*) as msgs, min(received_at) as firstSeen
      from chat_messages
      group by lower(username)
    `).all() as Array<{ login: string; msgs: number; firstSeen: string }>;

    const counts = new Map(countRows.map(row => [row.login, row]));
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
}

export function startDashboardHeartbeat(state: RuntimeState) {
  setInterval(() => {
    if (getSocketCount() === 0) return;

    void getDashboardStatusSnapshot(state)
      .then(status => broadcast('dashboard:status', status))
      .catch(error => console.error('Dashboard heartbeat failed:', error));
  }, DASHBOARD_HEARTBEAT_MS);
}
