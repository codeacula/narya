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
  isFirstThisSession: boolean;
  isFirstEver: boolean;
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

export type SoundButtonUpdate = {
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

export type ViewerProfileUpdate = {
  realName: string;
  tags: string[];
  note: string;
};

export type ChatEntry = {
  id: string;
  user: string;
  text: string;
  time: string;
  highlight?: 'first-session' | 'first-ever' | 'broadcaster' | 'sub' | 'mod' | 'vip';
};

export type StreamEvent = {
  id: string;
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem' | 'ad_break';
  actor: string;
  detail: string;
  ago: string;
  tone: string;
  receivedAt?: string;
};

export type RunItem = {
  id: string;
  text: string;
  done: boolean;
  position: number;
};

export type RunItemUpdate = {
  text: string;
  done: boolean;
};

export type TickerItem = {
  id: string;
  text: string;
  position: number;
};

export type TickerItemUpdate = {
  text: string;
};

export type DashboardStatus = {
  channel: string;
  chatConnection: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  obsConnected: boolean;
  eventSubConnected: boolean;
  eventSubError: string | null;
  twitchAuthenticated: boolean;
  twitchAuthSource: 'oauth' | 'env' | null;
  twitchTokenExpiresAt: string | null;
  twitchMissingScopes: string[];
  twitchBotAuthenticated: boolean;
  twitchBotAuthSource: 'oauth' | 'env' | null;
  twitchBotTokenExpiresAt: string | null;
  twitchBotMissingScopes: string[];
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  streamStartedAt: string | null;
  uptimeSource: 'twitch' | 'obs' | null;
  activeChatters: number;
  sessionChatters: number;
  knownChatters: number;
  streamSessionId: string | null;
  streamSessionStartedAt: string | null;
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

export type DiscordStatus = {
  clientIdConfigured: boolean;
  botTokenConfigured: boolean;
  ready: boolean;
  botUser: string | null;
  installUrl: string | null;
  error: string | null;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
};

export type DiscordChannel = {
  id: string;
  guildId: string;
  name: string;
  type: 'text' | 'announcement';
  position: number;
  parentId: string | null;
};

export type GoLiveSettings = {
  obsSceneName: string;
  discordGuildId: string;
  discordGuildName: string;
  discordChannelId: string;
  discordChannelName: string;
  discordMessage: string;
  updatedAt: string | null;
};

export type GoLiveSettingsUpdate = {
  obsSceneName: string;
  discordGuildId: string;
  discordGuildName: string;
  discordChannelId: string;
  discordChannelName: string;
  discordMessage: string;
};

export type GoLiveResult = {
  ok: boolean;
  obsStatus: ObsStatus;
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

export type ChatSender = 'user' | 'bot';

export type TwitchUserActionResult = {
  ok: boolean;
  message: string;
};

export type ChatbotCommandActionType = 'chat_reply' | 'llm_response' | 'sound_play' | 'obs_scene' | 'obs_transition';

export type ChatbotCommandActionPayload = {
  template?: string;
  soundId?: string;
  sceneName?: string;
};

export type ChatbotCommandAction = {
  id: string;
  type: ChatbotCommandActionType;
  enabled: boolean;
  position: number;
  payload: ChatbotCommandActionPayload;
};

export type ChatbotCommandActionInput = {
  type: ChatbotCommandActionType;
  enabled: boolean;
  payload: ChatbotCommandActionPayload;
};

export type ChatbotCommand = {
  id: string;
  enabled: boolean;
  command: string;
  actions: ChatbotCommandAction[];
  updatedAt: string;
};

export type ChatbotCommandUpsert = {
  enabled: boolean;
  command: string;
  actions: ChatbotCommandActionInput[];
};

export type ChatbotCommandSettings = {
  enabled: boolean;
  command: string;
  response: string;
};

export type ChatbotCommandSettingsResponse = ChatbotCommandSettings & {
  updatedAt: string | null;
};

export type LlmSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  personalityPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedAt: string | null;
};

export type LlmSettingsUpdate = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  personalityPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type LlmTestResult = {
  ok: boolean;
  reply: string;
};

export type Chatter = {
  userId: string;
  userLogin: string;
  userName: string;
};

export type ChattersResponse = {
  chatters: Chatter[];
  total: number;
};
