// Domain types shared across the app. These match the backend API.

export type Viewer = {
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

export type ChatEntry = {
  id: string;
  user: string;
  text: string;
  time: string;
  highlight?: 'first' | 'sub';
};

export type StreamEvent = {
  id: string;
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem';
  actor: string;
  detail: string;
  ago: string;
  tone: string;
  receivedAt?: string;
};

export type RunItem = {
  text: string;
  done: boolean;
};

export type DashboardStatus = {
  channel: string;
  chatConnection: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  obsConnected: boolean;
  eventSubConnected: boolean;
  twitchAuthenticated: boolean;
  twitchAuthSource: 'oauth' | 'env' | null;
  twitchTokenExpiresAt: string | null;
  twitchMissingScopes: string[];
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  streamStartedAt: string | null;
  uptimeSource: 'twitch' | 'obs' | null;
  activeChatters: number;
  sessionChatters: number;
  knownChatters: number;
  bitrateKbps: number | null;
  congestion: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  laggedFrames: number | null;
  adBreakEndsAt: string | null;
  adScheduleStatus: 'available' | 'not_configured' | 'missing_scope' | 'unauthorized' | 'unavailable';
  adScheduleError: string | null;
  nextAdAt: string | null;
  lastAdAt: string | null;
  adBreakDurationSeconds: number | null;
  prerollFreeTimeSeconds: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
};
