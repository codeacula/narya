export type ChatMessage = {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  color: string | null;
  message: string;
  receivedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  badges: Record<string, string> | null;
  emotes: Record<string, string[]> | null;
  isFirstTimer: boolean;
  isExiting?: boolean;
};

export type ChatModerationEvent = {
  type: 'message.deleted' | 'user.timeout' | 'user.ban' | 'chat.clear';
  channel: string;
  messageId?: string;
  username?: string;
  deletedAt: string;
  deletedReason: string;
};

export type MusicInfo = {
  status: 'playing' | 'paused' | 'stopped' | 'unavailable';
  playerName: string | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  source: 'playerctl' | 'manual' | 'none';
  updatedAt: string;
};

export type SoundPlayback = {
  id: string;
  src: string;
  volume?: number;
};

export type SoundButton = {
  id: string;
  label: string;
  filename: string;
};

export type ControlConfig = {
  scenes: string[];
};

export type ObsStatus = {
  connected: boolean;
  scenes: string[];
  currentProgramScene: string | null;
  currentPreviewScene: string | null;
  studioMode: boolean;
  lastError: string | null;
  updatedAt: string;
};

export type ControlResponse = {
  ok: boolean;
  obsStatus?: ObsStatus;
};

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

export type StreamInfo = {
  broadcasterName: string;
  categoryId: string;
  category: string;
  title: string;
  tags: string[];
};

export type TwitchCategorySuggestion = {
  id: string;
  name: string;
  boxArtUrl: string | null;
};

export type StreamInfoUpdate = {
  title: string;
  category: string;
  tags: string[];
};

export type PrerollResult = {
  ok: boolean;
  durationSeconds: number;
  message: string | null;
  retryAfterSeconds: number | null;
  adBreakEndsAt: string;
};

export type ChatSendResult = {
  ok: boolean;
  messageId: string | null;
};
