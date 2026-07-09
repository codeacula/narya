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

export type AutomodHold = {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  message: string;
  category: string | null;
  level: number | null;
  heldAt: string;
  resolvedAt: string | null;
  resolution: 'allowed' | 'denied' | 'expired' | null;
  resolvedBy: string | null;
};

export type AutomodQueue = {
  pending: AutomodHold[];
  recentlyResolved: AutomodHold[];
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
  kind?: 'whisper';
};

export type WhisperMessage = {
  id: string;
  fromLogin: string;
  fromDisplayName: string;
  text: string;
  receivedAt: string;
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
  viewerCount: number | null;
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

// A category the user has saved to reuse; box art carries {width}x{height} placeholders.
export type SavedStreamCategoryInput = {
  id: string;
  name: string;
  boxArtUrl: string | null;
};

export type SavedStreamCategory = TwitchCategorySuggestion & { hidden: boolean };

export type StreamInfoUpdate = {
  title: string;
  category: string;
  categoryId?: string;
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

export type RewardStreamCategory = {
  id: string;
  name: string;
};

export type ViewerRewardCategory = {
  id: string;
  name: string;
  enabled: boolean;
  rewardCount: number;
  defaultBackgroundColor: string | null;
  games: RewardStreamCategory[];
};

export type ViewerReward = {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  isEnabled: boolean;
  isPaused: boolean;
  isInStock: boolean;
  canManage: boolean;
  imageUrl: string | null;
  backgroundColor: string;
  categoryId: string | null;
  isUserInputRequired: boolean;
  skipQueue: boolean;
  globalCooldown: { enabled: boolean; seconds: number };
  maxPerStream: { enabled: boolean; max: number };
  maxPerUserPerStream: { enabled: boolean; max: number };
};

export type ViewerRewardsResponse = {
  categories: ViewerRewardCategory[];
  rewards: ViewerReward[];
};

export type ViewerRewardUpsert = {
  title: string;
  prompt: string;
  cost: number;
  isEnabled: boolean;
  isPaused: boolean;
  categoryId: string | null;
  isUserInputRequired: boolean;
  skipQueue: boolean;
  backgroundColor: string;
  globalCooldown: { enabled: boolean; seconds: number };
  maxPerStream: { enabled: boolean; max: number };
  maxPerUserPerStream: { enabled: boolean; max: number };
};

export type ViewerRewardCategoryToggleResult = ViewerRewardsResponse & {
  updatedCount: number;
  skippedReadOnlyCount: number;
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

export type TtsVoice = {
  id: string;
  name: string;
  category: string;
  languageId: string;
  createdAt: string | null;
};

export type TtsSettings = {
  enabled: boolean;
  voiceProfileId: string;
  languageId: string;
  tonePreset: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  volume: number;
  updatedAt: string | null;
};

export type TtsSettingsUpdate = {
  enabled: boolean;
  voiceProfileId: string;
  languageId: string;
  tonePreset: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  volume: number;
};

export type TtsPlayback = {
  audioBase64: string;
  mimeType: string;
  volume: number;
};

// Runtime configuration persisted in the database and edited from the Settings UI.
// Secrets are never returned to the client; instead a `*Configured` boolean reports
// whether a value is set (mirrors the LlmSettings.apiKeyConfigured pattern).
export type AppConfig = {
  twitchChannel: string;
  twitchClientId: string;
  twitchClientSecretConfigured: boolean;
  obsUrl: string;
  obsPasswordConfigured: boolean;
  obsScenes: string[];
  discordClientId: string;
  discordBotTokenConfigured: boolean;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  quackVolume: number;
  updatedAt: string | null;
};

// PUT /api/config accepts partial bodies: absent non-secret fields keep their
// current value server-side, so every non-secret field is optional here.
export type AppConfigUpdate = {
  twitchChannel?: string;
  twitchClientId?: string;
  twitchClientSecret?: string;
  clearTwitchClientSecret?: boolean;
  obsUrl?: string;
  obsPassword?: string;
  clearObsPassword?: boolean;
  obsScenes?: string[];
  discordClientId?: string;
  discordBotToken?: string;
  clearDiscordBotToken?: boolean;
  chatterboxBaseUrl?: string;
  musicPollIntervalMs?: number;
  musicPlayerctlPlayer?: string;
  quackVolume?: number;
};

export type SettingsUpdatedPayload = {
  updatedAt: string;
};

export type DiscordAnnounceFailedPayload = {
  reason: string;
  channelName: string;
};
