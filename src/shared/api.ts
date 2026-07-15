/**
 * Error code the auth middleware attaches when it rejects the dashboard token
 * itself. Routes 401 for their own reasons too ("Twitch login is required."), so
 * the status alone cannot tell the client which credential is at fault — only a
 * response carrying this code means "the token you sent is missing or stale".
 */
export const INVALID_DASHBOARD_TOKEN = 'invalid_dashboard_token';

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
  /** Stream session the message was sent during. Null when sent off-stream. */
  sessionId?: string | null;
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

export type ClipButton = {
  id: string;
  label: string;
  filename: string;
};

export type ClipButtonUpdate = {
  label: string;
  filename: string;
};

/**
 * `scenes` is whatever OBS currently reports, so it is empty while OBS is
 * disconnected — there is no operator-maintained scene list to fall back on.
 * `scenePrefix` is the configured convention (default "Scene - ") that marks a
 * scene as one the operator switches between; the dashboard and tablet filter
 * their scene buttons by it and strip it from the label.
 */
export type ObsStatus = {
  connected: boolean;
  scenes: string[];
  scenePrefix: string;
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
  roles: string[];
  followed: string;
  subbed: string;
  seen: string;
  msgs: number;
  accountAge: string;
  note: string;
  recent: Array<{ t: string; ago: string; kind?: string; emotes?: Record<string, string[]> | null }>;
};

export type ViewerProfileUpdate = {
  realName: string;
  tags: string[];
  note: string;
};

// Live Twitch-sourced viewer facts, fetched on demand for the viewer page.
// Each field is a display-ready string (or 'not available' when unknown).
export type ViewerDetails = {
  followed: string;
  subbed: string;
  accountAge: string;
};

export type ChatEntry = {
  id: string;
  user: string;
  text: string;
  time: string;
  /** ISO timestamp; `time` is a display-only clock string. */
  at?: string;
  /** Stream session the message was sent during. Null when sent off-stream. */
  sessionId?: string | null;
  highlight?: 'first-session' | 'first-ever' | 'broadcaster' | 'sub' | 'mod' | 'vip';
  kind?: 'whisper';
  /** Twitch emote positions (emoteId → ["start-end", …]) for inline emote rendering. */
  emotes?: Record<string, string[]> | null;
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
  /** Twitch display name. */
  actor: string;
  detail: string;
  ago: string;
  tone: string;
  receivedAt?: string;
  /** Stream session the event belongs to. Null for events recorded off-stream or before sessions were tracked. */
  sessionId?: string | null;
};

/** One person to thank at the end of the stream, with everything they did this session. */
export type SessionShoutout = {
  /** Twitch display name. */
  actor: string;
  /** Twitch login, or null for rows recorded before logins were stored. */
  login: string | null;
  kinds: string[];
  detail: string;
  firstAt: string;
  lastAt: string;
};

export type StreamEventUpdate = {
  id: string;
  detail: string;
  tone: string;
};

export type DashboardStatus = {
  channel: string;
  chatConnection: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  obsConnected: boolean;
  eventSubConnected: boolean;
  eventSubError: string | null;
  // Required EventSub subscriptions Twitch refused. Connected + non-empty = degraded:
  // the socket is up, but the events behind these types never arrive.
  eventSubFailedSubscriptions: string[];
  twitchAuthenticated: boolean;
  twitchAuthSource: 'oauth' | null;
  twitchTokenExpiresAt: string | null;
  twitchMissingScopes: string[];
  twitchBotAuthenticated: boolean;
  twitchBotAuthSource: 'oauth' | null;
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

export type StreamCategoryRewardGroup = { id: string; name: string };

export type SavedStreamCategory = TwitchCategorySuggestion & {
  hidden: boolean;
  tags: string[];
  rewardGroups: StreamCategoryRewardGroup[];
};

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

export type MediaKind = 'video' | 'audio';

/** A playable file discovered under public/clips or public/sounds. */
export type MediaFile = {
  src: string;
  label: string;
  kind: MediaKind;
  sizeBytes: number;
};

/** What a channel-point reward plays when redeemed. */
export type RewardMedia = {
  kind: MediaKind;
  src: string;
  volume: number;
};

export type MediaPlayback = RewardMedia & {
  id: string;
  actor?: string;
};

/** Twitch events a `twitch_event` trigger can fire on. `sub` covers new subs and resubs. */
export type AlertEventKind = 'sub' | 'gift' | 'cheer' | 'raid' | 'follow';

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

// Everyone who has ever chatted, drawn from the persistent `chatters` table joined
// to each person's most recent message (display name, color, badges) and profile note.
export type ViewerRosterEntry = {
  login: string;
  display: string;
  color: string;
  roles: string[];
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  note: string;
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
  // The scene-name convention the dashboard and tablet filter their switch buttons
  // by. OBS itself is the source of truth for which scenes exist.
  obsScenePrefix: string;
  discordClientId: string;
  discordBotTokenConfigured: boolean;
  chatterboxBaseUrl: string;
  musicPollIntervalMs: number;
  musicPlayerctlPlayer: string;
  // Default playback volume for tablet sound buttons.
  soundVolume: number;
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
  obsScenePrefix?: string;
  discordClientId?: string;
  discordBotToken?: string;
  clearDiscordBotToken?: boolean;
  chatterboxBaseUrl?: string;
  musicPollIntervalMs?: number;
  musicPlayerctlPlayer?: string;
  soundVolume?: number;
};

export type SettingsUpdatedPayload = {
  updatedAt: string;
};

export type DiscordAnnounceFailedPayload = {
  reason: string;
  channelName: string;
};

/**
 * Positioning aid: while enabled, every overlay browser source draws a labelled
 * outline of its own bounds, so the operator can see and place a source that is
 * otherwise invisible until an event fires. Real overlay content still renders on
 * top — this only adds the outline.
 *
 * Doubles as the GET /api/overlay/placeholders response and the
 * `overlay:placeholders` WebSocket payload.
 *
 * Deliberately NOT persisted: it lives in memory and a restart clears it. Left on
 * by accident, it would draw boxes over a live stream, so the failure mode is
 * "turns itself off", not "stays on across a reboot you didn't connect it to".
 */
export type OverlayPlaceholders = {
  enabled: boolean;
};

/** `media:mute` WebSocket payload and the GET/PUT /api/automation/media-mute body. */
export type MediaMuteState = {
  muted: boolean;
};

// Freeform stream status line. Doubles as the GET /api/stream-status response
// and the `status:updated` WebSocket payload.
export type StreamStatus = {
  text: string;
  updatedAt: string;
};

export type StreamStatusUpdate = {
  text: string;
};

// =============================================================================
// Automation platform
//
// Three layers, deliberately separable:
//   media_assets      what can be played  (the configured catalog)
//   actions           what happens        (ordered, reusable steps)
//   automation_triggers  when it happens  (typed sources → one Action)
//
// Category modules scope triggers and own reward groups. A trigger with no
// module is global and always armed.
// =============================================================================

/** Where a configured asset's bytes come from. Local srcs must resolve to a file
 * under public/clips or public/sounds; remote is an explicitly configured http(s)
 * URL. Arbitrary local paths are never accepted. */
export type MediaSourceType = 'local' | 'remote';

/**
 * An operator-configured playable asset. This is the ONLY thing rewards, alerts,
 * Actions, commands, and tablet controls may reference — raw filesystem entries
 * (MediaFile) appear solely in the Content settings picker when adding an asset.
 *
 * `available` is derived at runtime, not stored: a local asset whose file has
 * gone missing stays in the catalog (so it can be repaired) but reports
 * available: false and never emits a playback event.
 */
export type MediaAsset = {
  id: string;
  label: string;
  kind: MediaKind;
  sourceType: MediaSourceType;
  src: string;
  volume: number;
  enabled: boolean;
  /** False when a local asset's file is no longer on disk. Derived, never stored. */
  available: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MediaAssetInput = {
  label: string;
  kind: MediaKind;
  sourceType: MediaSourceType;
  src: string;
  volume: number;
  enabled: boolean;
};

/** PUT accepts partial bodies; absent fields keep their current value. */
export type MediaAssetUpdate = Partial<MediaAssetInput>;

/** GET /api/media-assets */
export type MediaAssetsResponse = {
  assets: MediaAsset[];
};

/** GET /api/media/discovered — operator-only; the raw scan of public/. */
export type DiscoveredMediaResponse = {
  files: MediaFile[];
  /** srcs already claimed by a configured asset, so the picker can mark them. */
  configuredSrcs: string[];
};

// --- Actions -----------------------------------------------------------------

export type ActionStepType =
  | 'show_text'
  | 'play_media'
  | 'tts_speak'
  | 'send_chat'
  | 'llm_response'
  | 'obs_scene'
  | 'obs_transition'
  | 'twitch_shoutout'
  | 'twitch_whisper'
  | 'twitch_timeout'
  | 'twitch_ban';

/** How a multi-asset play_media step picks which asset to play. */
export type MediaSelection = 'first' | 'random';

/** Presentation of an overlay text banner. */
export type TextStyle = 'banner' | 'toast' | 'centered';

/**
 * `tone` is an optional accent (mirrors StreamEvent.tone: warning/info/note/silver),
 * so a migrated sub alert keeps reading gold and a cheer blue. Absent = the default
 * accent.
 */
export type ShowTextPayload = { template: string; durationMs: number; style: TextStyle; tone?: string };
export type PlayMediaPayload = { assetIds: string[]; selection: MediaSelection; volume?: number };
export type TtsSpeakPayload = { template: string };
export type SendChatPayload = { template: string; sender: ChatSender };
export type LlmResponsePayload = { template: string };
export type ObsScenePayload = { sceneName: string };
export type ObsTransitionPayload = Record<string, never>;
export type TwitchShoutoutPayload = { loginTemplate: string };
export type TwitchWhisperPayload = { loginTemplate: string; template: string };
/**
 * `secondsTemplate` is a template, not a number, so `/timeout bob 300 spam` can
 * bind the duration from the invocation ("{arg2}") instead of being locked to
 * whatever the Action stored. A template that renders empty or non-numeric falls
 * back to `DEFAULT_TIMEOUT_SECONDS` rather than failing the step — a moderation
 * command must still land when the operator omits the duration.
 */
export type TwitchTimeoutPayload = { loginTemplate: string; secondsTemplate: string; reasonTemplate: string };

export const DEFAULT_TIMEOUT_SECONDS = 600;
/** Twitch's ceiling: 14 days. */
export const MAX_TIMEOUT_SECONDS = 1_209_600;
export type TwitchBanPayload = { loginTemplate: string; reasonTemplate: string };

/**
 * A single step. `delayMs` is relative to the start of the invocation, not to the
 * previous step: due steps start in stored order WITHOUT waiting for media
 * playback to finish, so text, video, and TTS can land together. A step that
 * fails does not abort the ones after it.
 */
export type ActionStep =
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'show_text'; payload: ShowTextPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'play_media'; payload: PlayMediaPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'tts_speak'; payload: TtsSpeakPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'send_chat'; payload: SendChatPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'llm_response'; payload: LlmResponsePayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'obs_scene'; payload: ObsScenePayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'obs_transition'; payload: ObsTransitionPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'twitch_shoutout'; payload: TwitchShoutoutPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'twitch_whisper'; payload: TwitchWhisperPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'twitch_timeout'; payload: TwitchTimeoutPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'twitch_ban'; payload: TwitchBanPayload };

/** Omit that preserves a discriminated union instead of collapsing it to one object. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A step as submitted: no id/position (position comes from array order). */
export type ActionStepInput = DistributiveOmit<ActionStep, 'id' | 'position'>;

export type Action = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  steps: ActionStep[];
  createdAt: string;
  updatedAt: string;
};

export type ActionUpsert = {
  name: string;
  description: string;
  enabled: boolean;
  steps: ActionStepInput[];
};

/**
 * `partial` = at least one step ran and at least one failed. `skipped` = nothing
 * ran (Action disabled, every step disabled, or every referenced asset
 * unavailable) — a skipped invocation broadcasts nothing.
 */
export type ActionRunStatus = 'succeeded' | 'partial' | 'failed' | 'skipped';

export type ActionStepResult = {
  stepId: string;
  type: ActionStepType;
  status: 'succeeded' | 'failed' | 'skipped';
  /** Why it failed or was skipped. Empty on success. */
  detail: string;
};

export type ActionRunResult = {
  actionId: string;
  status: ActionRunStatus;
  steps: ActionStepResult[];
  ranAt: string;
};

/**
 * Everything a template may interpolate. Absent fields render as an empty string
 * rather than the literal token, so a follow alert using {months} degrades
 * quietly instead of printing "{months}".
 */
export type TemplateContext = {
  /** Display name of whoever caused the invocation. */
  actor?: string;
  login?: string;
  message?: string;
  /** Reward user-input, or everything after a command trigger. */
  input?: string;
  args?: string[];
  // Templates may also use {arg1}, {arg2}… to index `args`, and {rest} for
  // everything after the first argument — both are derived from `args`, not stored.
  rewardTitle?: string;
  amount?: number;
  tier?: string;
  months?: number;
  /** Active Twitch category and module at invocation time. */
  category?: string;
  module?: string;
};

/** Broadcast payload (`overlay:text`) consumed by the /overlay/text browser source. */
export type OverlayTextPlayback = {
  id: string;
  text: string;
  durationMs: number;
  style: TextStyle;
  /** Accent colour hint; mirrors StreamEvent.tone. Absent = default. */
  tone?: string;
};

// --- Triggers ----------------------------------------------------------------

export type AutomationTriggerKind =
  | 'reward'
  | 'twitch_event'
  | 'chat_phrase'
  | 'viewer_command'
  | 'dashboard_slash'
  | 'manual'
  | 'module_activate'
  | 'module_deactivate';

export type ChatPhraseMatch = 'exact' | 'contains' | 'starts_with';

/** Twitch roles that may fire a trigger. Empty array = everyone. */
export type TriggerRole = 'broadcaster' | 'mod' | 'vip' | 'sub' | 'viewer';

export type RewardTriggerConfig = { rewardId: string };
export type TwitchEventTriggerConfig = { eventKind: AlertEventKind };
export type ChatPhraseTriggerConfig = {
  phrase: string;
  match: ChatPhraseMatch;
  /** Empty = all viewers. */
  roles: TriggerRole[];
};
/** Public `!command` typed by viewers in chat. */
export type ViewerCommandTriggerConfig = { command: string; aliases: string[]; roles: TriggerRole[] };
/** Private `/command` typed by the operator in the dashboard. Never sent to Twitch. */
export type DashboardSlashTriggerConfig = { command: string; aliases: string[] };
export type ManualTriggerConfig = { label: string };
export type ModuleLifecycleTriggerConfig = Record<string, never>;

export type AutomationTrigger =
  | { id: string; kind: 'reward'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: RewardTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'twitch_event'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: TwitchEventTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'chat_phrase'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: ChatPhraseTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'viewer_command'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: ViewerCommandTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'dashboard_slash'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: DashboardSlashTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'manual'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: ManualTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'module_activate'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: ModuleLifecycleTriggerConfig; createdAt: string; updatedAt: string }
  | { id: string; kind: 'module_deactivate'; actionId: string; moduleId: string | null; enabled: boolean; globalCooldownMs: number; userCooldownMs: number; config: ModuleLifecycleTriggerConfig; createdAt: string; updatedAt: string };

export type AutomationTriggerInput = DistributiveOmit<AutomationTrigger, 'id' | 'createdAt' | 'updatedAt'>;

/** Default cooldowns for a new chat-phrase trigger. Zero disables either limit. */
export const DEFAULT_GLOBAL_COOLDOWN_MS = 30_000;
export const DEFAULT_USER_COOLDOWN_MS = 60_000;

/** POST /api/automation/slash — the operator's private dashboard command bar. */
export type SlashCommandRequest = {
  /** Raw input including the leading slash. */
  input: string;
};

/**
 * An unknown slash command is rejected here, never forwarded to Twitch chat.
 * `ok: false` with a message is the normal outcome for a typo.
 */
export type SlashCommandResponse = {
  ok: boolean;
  message: string;
  run: ActionRunResult | null;
};

// --- Category modules --------------------------------------------------------

/**
 * `degraded` means the last reconciliation could not be completed (Twitch refused
 * a reward update, or the authoritative category lookup failed). The module keeps
 * its last known state and exposes a Retry — it never guesses.
 */
export type CategoryModuleStatus = 'idle' | 'active' | 'degraded';

export type CategoryModule = {
  id: string;
  name: string;
  enabled: boolean;
  status: CategoryModuleStatus;
  /** Human-readable reason when degraded. Empty otherwise. */
  statusDetail: string;
  /** Twitch categories that activate this module. A game maps to at most one module. */
  games: RewardStreamCategory[];
  /** Reward groups this module owns. Owned groups cannot be toggled by hand. */
  rewardGroups: StreamCategoryRewardGroup[];
  createdAt: string;
  updatedAt: string;
};

export type CategoryModuleInput = {
  name: string;
  enabled: boolean;
  games: RewardStreamCategory[];
  rewardGroupIds: string[];
};

/** What signalled the category change. Drives logging and the degraded message. */
export type CategorySignalSource =
  | 'stream_info_update'
  | 'channel_update'
  | 'eventsub_connect'
  | 'stream_online'
  | 'manual_reconcile';

/** GET /api/category-modules and the `category-modules:updated` WebSocket payload. */
export type CategoryModulesResponse = {
  modules: CategoryModule[];
  /** The module matching the live Twitch category, or null when none matches. */
  activeModuleId: string | null;
  /** Live Twitch category, or null when it could not be established. */
  activeGameId: string | null;
  activeGameName: string | null;
  lastSignalSource: CategorySignalSource | null;
  lastReconciledAt: string | null;
  /**
   * Why the last authoritative category lookup failed, or null when it succeeded.
   * Distinct from a module's own `degraded` status: when the lookup fails and NO
   * module is active there is nowhere per-module to hang the error, and silently
   * reporting "nothing active" would be indistinguishable from a healthy
   * off-category stream. The operator must be able to tell those apart.
   */
  lookupError: string | null;
};
