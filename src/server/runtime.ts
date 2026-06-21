import { EVENTSUB_DEFAULT_KEEPALIVE_MS } from '../shared/constants';

export type TwitchUserToken = {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  tokenType: string | null;
  expiresAtMs: number | null;
};

export type TwitchTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
  token_type?: string;
  error?: string;
  message?: string;
};

export type StreamStatusSource = 'twitch' | 'obs' | null;

export type StreamActivityStatus = {
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  streamStartedAt: string | null;
  uptimeSource: StreamStatusSource;
};

export type AdScheduleStatus = 'available' | 'not_configured' | 'missing_scope' | 'unauthorized' | 'unavailable';

export type AdSchedule = {
  adScheduleStatus: AdScheduleStatus;
  adScheduleError: string | null;
  nextAdAt: string | null;
  lastAdAt: string | null;
  adBreakDurationSeconds: number | null;
  prerollFreeTimeSeconds: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
};

export class RuntimeState {
  readonly serverStartedAt = Date.now();
  runtimeUserToken: TwitchUserToken | null = null;
  twitchAppToken: { accessToken: string; expiresAtMs: number } | null = null;
  eventSubWs: WebSocket | null = null;
  eventSubConnected = false;
  broadcasterId: string | null = null;
  twitchSenderId: string | null = null;
  eventSubKeepaliveMs = EVENTSUB_DEFAULT_KEEPALIVE_MS;
  eventSubKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  adBreakEndsAt: string | null = null;
  twitchStreamStatusCache: { expiresAtMs: number; status: StreamActivityStatus } | null = null;
  twitchAdScheduleCache: { expiresAtMs: number; schedule: AdSchedule } | null = null;

  clearTwitchCaches() {
    this.twitchStreamStatusCache = null;
    this.twitchAdScheduleCache = null;
  }

  clearAuthenticatedUserState() {
    this.runtimeUserToken = null;
    this.broadcasterId = null;
    this.twitchSenderId = null;
    this.clearTwitchCaches();
  }

  clearEventSubSocket() {
    this.eventSubWs = null;
    this.eventSubConnected = false;
  }
}
