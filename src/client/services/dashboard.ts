// Dashboard data service - calls backend API for all data.
import type {
  Action,
  ActionRunResult,
  ActionUpsert,
  AlertEventKind,
  AutomationTrigger,
  AutomationTriggerInput,
  CategoryModule,
  CategoryModuleInput,
  CategoryModulesResponse,
  TemplateContext,
  Viewer,
  ViewerDetails,
  ChatEntry,
  ChatMessage,
  MediaAsset,
  MediaAssetInput,
  MediaAssetsResponse,
  MediaAssetUpdate,
  DiscoveredMediaResponse,
  MediaFile,
  MediaPlayback,
  MusicInfo,
  StreamEvent,
  SessionShoutout,
  DashboardStatus,
  StreamInfo,
  TwitchCategorySuggestion,
  StreamInfoUpdate,
  PrerollResult,
  ChatSendResult,
  SlashCommandResponse,
  ChatSender,
  ControlResponse,
  ObsStatus,
  Chatter,
  ChattersResponse,
  ViewerRosterEntry,
  ViewerRefreshResult,
  ViewerFlushResult,
  SoundButton,
  SoundButtonUpdate,
  SoundPlayback,
  ClipButton,
  ClipButtonUpdate,
  AutomodHold,
  AutomodQueue,
  ChatbotCommand,
  ChatbotCommandUpsert,
  LlmSettings,
  LlmSettingsUpdate,
  LlmTestResult,
  ViewerProfileUpdate,
  TwitchUserActionResult,
  DiscordStatus,
  DiscordGuild,
  DiscordChannel,
  GoLiveSettings,
  Quote,
  QuoteInput,
  QuoteUpdate,
  GoLiveSettingsUpdate,
  GoLiveResult,
  ViewerRewardCategory,
  RewardStreamCategory,
  SavedStreamCategory,
  SavedStreamCategoryInput,
  ViewerRewardCategoryToggleResult,
  ViewerRewardsResponse,
  ViewerRewardUpsert,
  TtsSettings,
  TtsSettingsUpdate,
  TtsVoice,
  AppConfig,
  AppConfigUpdate,
  OverlayPlaceholders,
  MediaMuteState,
  StreamStatus,
} from '../../shared/api';
import { getDashboardToken, isDashboardTokenRejection, reportDashboardTokenRejected } from '../auth';

const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4317';

// Attach the shared dashboard token header when one is stored, merged with any
// caller-supplied headers.
function authHeaders(base?: Record<string, string>): Record<string, string> | undefined {
  const token = getDashboardToken();
  if (!token) return base;
  return { ...(base ?? {}), 'x-dashboard-token': token };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
}

// Every failing API response funnels through here, which is also the only place
// that can see a rejected dashboard token: the panels each fire their own fetch,
// so detecting it per-caller would mean detecting it in a dozen places.
async function readApiError(response: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not a JSON error body (a proxy or a crash) — fall through to the status line.
  }
  if (isDashboardTokenRejection(response.status, body)) {
    reportDashboardTokenRejected();
  }
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : `${response.status} ${response.statusText}`;
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
}

// For endpoints that return no body (e.g. 204 DELETEs). Attaches the auth header
// and surfaces API errors like sendJson.
async function sendVoid(path: string, method: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { method, headers: authHeaders() });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function getAppConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config');
}

export async function updateAppConfig(update: AppConfigUpdate): Promise<AppConfig> {
  return sendJson<AppConfig>('/api/config', 'PUT', update);
}

export async function getViewers(): Promise<Record<string, Viewer>> {
  return fetchJson<Record<string, Viewer>>('/api/dashboard/viewers');
}

export async function updateViewerProfile(login: string, profile: ViewerProfileUpdate): Promise<ViewerProfileUpdate> {
  return sendJson<ViewerProfileUpdate>(`/api/dashboard/viewers/${encodeURIComponent(login)}/profile`, 'PATCH', profile);
}

export async function getChatEntries(): Promise<ChatEntry[]> {
  return fetchJson<ChatEntry[]>('/api/dashboard/chat');
}

export async function getChatEntriesBefore(id: string): Promise<ChatEntry[]> {
  return fetchJson<ChatEntry[]>(`/api/dashboard/chat?before=${encodeURIComponent(id)}`);
}

export async function getViewerMessages(login: string, before?: string): Promise<ChatEntry[]> {
  const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
  return fetchJson<ChatEntry[]>(`/api/viewers/${encodeURIComponent(login)}/messages${suffix}`);
}

export async function getViewerDetails(login: string): Promise<ViewerDetails> {
  return fetchJson<ViewerDetails>(`/api/viewers/${encodeURIComponent(login)}/details`);
}

export async function getStreamEvents(): Promise<StreamEvent[]> {
  return fetchJson<StreamEvent[]>('/api/dashboard/events');
}

export async function getSessionShoutouts(): Promise<SessionShoutout[]> {
  return fetchJson<SessionShoutout[]>('/api/dashboard/session-shoutouts');
}

export async function getDashboardStatus(): Promise<DashboardStatus> {
  return fetchJson<DashboardStatus>('/api/dashboard/status');
}

export async function getStreamInfo(): Promise<StreamInfo> {
  return fetchJson<StreamInfo>('/api/twitch/stream-info');
}

export async function getCategorySuggestions(query: string): Promise<TwitchCategorySuggestion[]> {
  return fetchJson<TwitchCategorySuggestion[]>(`/api/twitch/category-suggestions?query=${encodeURIComponent(query)}`);
}

export async function getSavedStreamCategories(): Promise<SavedStreamCategory[]> {
  return fetchJson<SavedStreamCategory[]>('/api/stream-categories');
}

export async function addSavedStreamCategory(game: SavedStreamCategoryInput): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>('/api/stream-categories', 'POST', game);
}

export async function setSavedStreamCategoryHidden(id: string, hidden: boolean): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>(`/api/stream-categories/${encodeURIComponent(id)}`, 'PATCH', { hidden });
}

export async function getTagSuggestions(query: string): Promise<string[]> {
  return fetchJson<string[]>(`/api/twitch/tag-suggestions?query=${encodeURIComponent(query)}`);
}

export async function setStreamCategoryTags(gameId: string, tags: string[]): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>(`/api/stream-categories/${encodeURIComponent(gameId)}/tags`, 'PUT', { tags });
}

export async function deleteStreamCategory(gameId: string): Promise<SavedStreamCategory[]> {
  return sendJson<SavedStreamCategory[]>(`/api/stream-categories/${encodeURIComponent(gameId)}`, 'DELETE');
}

export async function getTagHistorySuggestions(query: string): Promise<string[]> {
  return fetchJson<string[]>(`/api/stream-tags?query=${encodeURIComponent(query)}`);
}

export async function updateStreamInfo(info: StreamInfoUpdate): Promise<StreamInfoUpdate & { ok: boolean; categoryId: string }> {
  return sendJson('/api/twitch/stream-info', 'PATCH', info);
}

export async function runPrerollAds(): Promise<PrerollResult> {
  return sendJson('/api/twitch/preroll', 'POST');
}

export async function sendChatMessage(message: string, sender: ChatSender): Promise<ChatSendResult> {
  return sendJson('/api/twitch/chat-message', 'POST', { message, sender });
}

/**
 * Run a private operator slash command. The server owns the whole vocabulary: it
 * either executes the command or rejects it, and an unknown one is never forwarded
 * to Twitch chat. The client must not parse these itself.
 */
export async function runSlashCommand(input: string): Promise<SlashCommandResponse> {
  return sendJson<SlashCommandResponse>('/api/automation/slash', 'POST', { input });
}

export async function sendViewerShoutout(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/shoutout`, 'POST');
}

export async function sendViewerWhisper(login: string, message: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/whisper`, 'POST', { message });
}

export async function timeoutViewer(
  login: string,
  durationSeconds: number,
  reason: string,
): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/timeout`, 'POST', {
    durationSeconds,
    reason,
  });
}

export async function banViewer(login: string, reason: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/ban`, 'POST', { reason });
}

export async function getViewerRewards(): Promise<ViewerRewardsResponse> {
  return fetchJson<ViewerRewardsResponse>('/api/twitch/rewards');
}

export async function createViewerReward(reward: ViewerRewardUpsert): Promise<ViewerRewardsResponse> {
  return sendJson<ViewerRewardsResponse>('/api/twitch/rewards', 'POST', reward);
}

export async function updateViewerReward(id: string, reward: Partial<ViewerRewardUpsert>): Promise<ViewerRewardsResponse> {
  return sendJson<ViewerRewardsResponse>(`/api/twitch/rewards/${encodeURIComponent(id)}`, 'PATCH', reward);
}

export async function deleteViewerReward(id: string): Promise<void> {
  return sendVoid(`/api/twitch/rewards/${encodeURIComponent(id)}`, 'DELETE');
}

export async function getMediaFiles(): Promise<MediaFile[]> {
  return fetchJson<MediaFile[]>('/api/media');
}


export async function createViewerRewardCategory(name: string): Promise<ViewerRewardCategory> {
  return sendJson<ViewerRewardCategory>('/api/twitch/reward-categories', 'POST', { name });
}

export async function updateViewerRewardCategory(
  id: string,
  update: { name?: string; enabled?: boolean; defaultBackgroundColor?: string | null; games?: RewardStreamCategory[] },
): Promise<ViewerRewardCategoryToggleResult> {
  return sendJson<ViewerRewardCategoryToggleResult>(`/api/twitch/reward-categories/${encodeURIComponent(id)}`, 'PATCH', update);
}

export async function applyViewerRewardCategoryColor(id: string): Promise<ViewerRewardsResponse> {
  return sendJson<ViewerRewardsResponse>(`/api/twitch/reward-categories/${encodeURIComponent(id)}/apply-color`, 'POST', {});
}

export async function deleteViewerRewardCategory(id: string): Promise<void> {
  return sendVoid(`/api/twitch/reward-categories/${encodeURIComponent(id)}`, 'DELETE');
}

export async function getDiscordStatus(): Promise<DiscordStatus> {
  return fetchJson<DiscordStatus>('/api/discord/status');
}

export async function refreshDiscordStatus(): Promise<DiscordStatus> {
  return sendJson<DiscordStatus>('/api/discord/status/refresh', 'POST');
}

export async function getDiscordGuilds(): Promise<DiscordGuild[]> {
  return fetchJson<DiscordGuild[]>('/api/discord/guilds');
}

export async function getDiscordChannels(guildId: string): Promise<DiscordChannel[]> {
  return fetchJson<DiscordChannel[]>(`/api/discord/guilds/${encodeURIComponent(guildId)}/channels`);
}

export async function getGoLiveSettings(): Promise<GoLiveSettings> {
  return fetchJson<GoLiveSettings>('/api/go-live/settings');
}

export async function updateGoLiveSettings(settings: GoLiveSettingsUpdate): Promise<GoLiveSettings> {
  return sendJson<GoLiveSettings>('/api/go-live/settings', 'PUT', settings);
}

export async function clearDiscordGoLiveSettings(): Promise<GoLiveSettings> {
  return sendJson<GoLiveSettings>('/api/go-live/settings/discord', 'DELETE');
}

export async function runGoLive(): Promise<GoLiveResult> {
  return sendJson<GoLiveResult>('/api/go-live', 'POST');
}

export async function getChatbotCommands(): Promise<ChatbotCommand[]> {
  return fetchJson<ChatbotCommand[]>('/api/chatbot/commands');
}

export async function createChatbotCommand(settings: ChatbotCommandUpsert): Promise<ChatbotCommand> {
  return sendJson<ChatbotCommand>('/api/chatbot/commands', 'POST', settings);
}

export async function updateChatbotCommand(id: string, settings: ChatbotCommandUpsert): Promise<ChatbotCommand> {
  return sendJson<ChatbotCommand>(`/api/chatbot/commands/${encodeURIComponent(id)}`, 'PUT', settings);
}

export async function deleteChatbotCommand(id: string): Promise<void> {
  return sendVoid(`/api/chatbot/commands/${encodeURIComponent(id)}`, 'DELETE');
}

export async function getLlmSettings(): Promise<LlmSettings> {
  return fetchJson<LlmSettings>('/api/llm/settings');
}

export async function updateLlmSettings(settings: LlmSettingsUpdate): Promise<LlmSettings> {
  return sendJson<LlmSettings>('/api/llm/settings', 'PUT', settings);
}

export async function testLlm(question: string): Promise<LlmTestResult> {
  return sendJson<LlmTestResult>('/api/llm/test', 'POST', { question });
}

export async function disconnectTwitch(account: 'user' | 'bot' = 'user'): Promise<void> {
  const path = account === 'bot' ? '/api/auth/twitch/bot' : '/api/auth/twitch';
  await sendVoid(path, 'DELETE');
}

export async function getObsStatus(): Promise<ObsStatus> {
  return fetchJson<ObsStatus>('/api/obs/status');
}

export async function switchObsScene(sceneName: string): Promise<ControlResponse> {
  return sendJson<ControlResponse>(`/api/obs/scenes/${encodeURIComponent(sceneName)}`, 'POST');
}

export async function triggerObsTransition(): Promise<ControlResponse> {
  return sendJson<ControlResponse>('/api/obs/transition', 'POST');
}

export async function getSoundButtons(): Promise<SoundButton[]> {
  return fetchJson<SoundButton[]>('/api/sounds');
}

export async function createSoundButton(sound: SoundButtonUpdate): Promise<SoundButton> {
  return sendJson<SoundButton>('/api/sounds', 'POST', sound);
}

export async function updateSoundButton(id: string, sound: SoundButtonUpdate): Promise<SoundButton> {
  return sendJson<SoundButton>(`/api/sounds/${encodeURIComponent(id)}`, 'PUT', sound);
}

export async function deleteSoundButton(id: string): Promise<void> {
  return sendVoid(`/api/sounds/${encodeURIComponent(id)}`, 'DELETE');
}

export async function playSoundButton(id: string): Promise<SoundPlayback> {
  return sendJson<SoundPlayback>(`/api/sounds/${encodeURIComponent(id)}/play`, 'POST');
}

export async function getClipButtons(): Promise<ClipButton[]> {
  return fetchJson<ClipButton[]>('/api/clips');
}

export async function createClipButton(clip: ClipButtonUpdate): Promise<ClipButton> {
  return sendJson<ClipButton>('/api/clips', 'POST', clip);
}

export async function updateClipButton(id: string, clip: ClipButtonUpdate): Promise<ClipButton> {
  return sendJson<ClipButton>(`/api/clips/${encodeURIComponent(id)}`, 'PUT', clip);
}

export async function deleteClipButton(id: string): Promise<void> {
  return sendVoid(`/api/clips/${encodeURIComponent(id)}`, 'DELETE');
}

export async function playClipButton(id: string): Promise<MediaPlayback> {
  return sendJson<MediaPlayback>(`/api/clips/${encodeURIComponent(id)}/play`, 'POST');
}

export async function getAutomodQueue(): Promise<AutomodQueue> {
  return fetchJson<AutomodQueue>('/api/automod/queue');
}

export async function allowAutomodHold(id: string): Promise<AutomodHold> {
  return sendJson<AutomodHold>(`/api/automod/${encodeURIComponent(id)}/allow`, 'POST');
}

export async function denyAutomodHold(id: string): Promise<AutomodHold> {
  return sendJson<AutomodHold>(`/api/automod/${encodeURIComponent(id)}/deny`, 'POST');
}

export async function getChatters(): Promise<ChattersResponse> {
  return fetchJson<ChattersResponse>('/api/chatters');
}

export async function getViewerRoster(): Promise<ViewerRosterEntry[]> {
  return fetchJson<ViewerRosterEntry[]>('/api/viewers/roster');
}

/** Re-query Twitch for one viewer, persisting the result and detecting a dead account. */
export async function refreshViewer(login: string): Promise<ViewerRefreshResult> {
  return sendJson<ViewerRefreshResult>(`/api/viewers/${encodeURIComponent(login)}/refresh`, 'POST');
}

/** Remove a viewer and keep them out. See flushViewer on the server. */
export async function flushViewer(login: string, reason = ''): Promise<ViewerFlushResult> {
  return sendJson<ViewerFlushResult>(`/api/viewers/${encodeURIComponent(login)}/flush`, 'POST', { reason });
}

export async function getVips(): Promise<Chatter[]> {
  return fetchJson<Chatter[]>('/api/twitch/vips');
}

export async function getModerators(): Promise<Chatter[]> {
  return fetchJson<Chatter[]>('/api/twitch/moderators');
}

export async function grantVip(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/vip`, 'POST');
}

export async function removeVip(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/vip`, 'DELETE');
}

export async function grantModerator(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/moderator`, 'POST');
}

export async function removeModerator(login: string): Promise<TwitchUserActionResult> {
  return sendJson<TwitchUserActionResult>(`/api/twitch/users/${encodeURIComponent(login)}/moderator`, 'DELETE');
}

export async function reconnectEventSub(): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>('/api/eventsub/reconnect', 'POST');
}

export async function getTtsSettings(): Promise<TtsSettings> {
  return fetchJson<TtsSettings>('/api/tts/settings');
}

export async function updateTtsSettings(settings: TtsSettingsUpdate): Promise<TtsSettings> {
  return sendJson<TtsSettings>('/api/tts/settings', 'PUT', settings);
}

export async function getTtsVoices(): Promise<TtsVoice[]> {
  return fetchJson<TtsVoice[]>('/api/tts/voices');
}

export async function getTtsStatus(): Promise<{ ok: boolean; baseUrl: string; error?: string }> {
  return fetchJson<{ ok: boolean; baseUrl: string; error?: string }>('/api/tts/status');
}

export async function testTtsSpeak(text: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>('/api/tts/speak', 'POST', { text });
}






export type HealthResponse = {
  ok: boolean;
  twitchChannel: string;
  obsConnected: boolean;
  twitchRoomId: string | null;
  eventSubConnected: boolean;
};

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>('/api/health');
}

export async function getRecentChat(): Promise<ChatMessage[]> {
  return fetchJson<ChatMessage[]>('/api/chat/recent');
}

export async function getEmotes(): Promise<Record<string, string>> {
  return fetchJson<Record<string, string>>('/api/emotes');
}

export async function getCurrentMusic(): Promise<MusicInfo | null> {
  return fetchJson<MusicInfo | null>('/api/music/current');
}

export async function setManualMusic(input: { title: string; artist: string; status: MusicInfo['status'] }): Promise<MusicInfo> {
  return sendJson<MusicInfo>('/api/music/current', 'PUT', input);
}

export async function clearManualMusic(): Promise<MusicInfo> {
  return sendJson<MusicInfo>('/api/music/current', 'DELETE');
}

export async function getStreamStatus(): Promise<StreamStatus> {
  return fetchJson<StreamStatus>('/api/stream-status');
}

export async function updateStreamStatus(text: string): Promise<StreamStatus> {
  return sendJson<StreamStatus>('/api/stream-status', 'PUT', { text });
}

// Overlay bounds outlines. The GET is on the overlay token's read allowlist (a
// browser source seeds from it); the PUT is operator-only.
export async function getOverlayPlaceholders(): Promise<OverlayPlaceholders> {
  return fetchJson<OverlayPlaceholders>('/api/overlay/placeholders');
}

export async function updateOverlayPlaceholders(enabled: boolean): Promise<OverlayPlaceholders> {
  return sendJson<OverlayPlaceholders>('/api/overlay/placeholders', 'PUT', { enabled });
}

// Master media mute (Stream Controls). Operator-only; never on the overlay allowlist.
export async function getMediaMute(): Promise<MediaMuteState> {
  return fetchJson<MediaMuteState>('/api/automation/media-mute');
}

export async function setMediaMute(muted: boolean): Promise<MediaMuteState> {
  return sendJson<MediaMuteState>('/api/automation/media-mute', 'PUT', { muted });
}

// --- Configured media catalog ------------------------------------------------
// Everything that plays media references an asset by id. The raw scan
// (getDiscoveredMedia) is only for the Content settings picker.

export async function getMediaAssets(): Promise<MediaAsset[]> {
  const response = await fetchJson<MediaAssetsResponse>('/api/media-assets');
  return response.assets;
}

export async function createMediaAsset(input: MediaAssetInput): Promise<MediaAsset> {
  return sendJson<MediaAsset>('/api/media-assets', 'POST', input);
}

export async function updateMediaAsset(id: string, update: MediaAssetUpdate): Promise<MediaAsset> {
  return sendJson<MediaAsset>(`/api/media-assets/${encodeURIComponent(id)}`, 'PUT', update);
}

export async function deleteMediaAsset(id: string): Promise<void> {
  return sendVoid(`/api/media-assets/${encodeURIComponent(id)}`, 'DELETE');
}

export async function getDiscoveredMedia(): Promise<DiscoveredMediaResponse> {
  return fetchJson<DiscoveredMediaResponse>('/api/media/discovered');
}

// --- Actions -----------------------------------------------------------------
// An Action is a named, ordered list of steps. Triggers reference one by id, and
// the operator can run one by hand from Settings → Actions.

export async function getActions(): Promise<Action[]> {
  return fetchJson<Action[]>('/api/actions');
}

export async function createAction(action: ActionUpsert): Promise<Action> {
  return sendJson<Action>('/api/actions', 'POST', action);
}

export async function updateAction(id: string, action: ActionUpsert): Promise<Action> {
  return sendJson<Action>(`/api/actions/${encodeURIComponent(id)}`, 'PUT', action);
}

export async function deleteAction(id: string): Promise<void> {
  return sendVoid(`/api/actions/${encodeURIComponent(id)}`, 'DELETE');
}

/** Fires the Action immediately. `context` supplies the tokens its templates interpolate. */
export async function runAction(id: string, context: TemplateContext = {}): Promise<ActionRunResult> {
  return sendJson<ActionRunResult>(`/api/actions/${encodeURIComponent(id)}/run`, 'POST', { context });
}

// --- Automation triggers -----------------------------------------------------


export async function getAutomationTriggers(): Promise<AutomationTrigger[]> {
  return fetchJson<AutomationTrigger[]>('/api/automation/triggers');
}

export async function createAutomationTrigger(trigger: AutomationTriggerInput): Promise<AutomationTrigger> {
  return sendJson<AutomationTrigger>('/api/automation/triggers', 'POST', trigger);
}

export async function updateAutomationTrigger(id: string, trigger: AutomationTriggerInput): Promise<AutomationTrigger> {
  return sendJson<AutomationTrigger>(`/api/automation/triggers/${encodeURIComponent(id)}`, 'PUT', trigger);
}

export async function deleteAutomationTrigger(id: string): Promise<void> {
  return sendVoid(`/api/automation/triggers/${encodeURIComponent(id)}`, 'DELETE');
}

/** Fires a trigger's Action, bypassing its cooldowns. Backs the manual Quick actions buttons. */
export async function runAutomationTrigger(id: string): Promise<ActionRunResult> {
  return sendJson<ActionRunResult>(`/api/automation/triggers/${encodeURIComponent(id)}/run`, 'POST', {});
}

// --- Category modules --------------------------------------------------------

export async function getCategoryModules(): Promise<CategoryModulesResponse> {
  return fetchJson<CategoryModulesResponse>('/api/category-modules');
}

export async function createCategoryModule(module: CategoryModuleInput): Promise<CategoryModule> {
  return sendJson<CategoryModule>('/api/category-modules', 'POST', module);
}

export async function updateCategoryModule(id: string, module: CategoryModuleInput): Promise<CategoryModule> {
  return sendJson<CategoryModule>(`/api/category-modules/${encodeURIComponent(id)}`, 'PUT', module);
}

export async function deleteCategoryModule(id: string): Promise<void> {
  return sendVoid(`/api/category-modules/${encodeURIComponent(id)}`, 'DELETE');
}

/** Re-reads the live Twitch category and re-applies module-owned reward groups. Clears `degraded` when it succeeds. */
export async function reconcileCategoryModules(): Promise<CategoryModulesResponse> {
  return sendJson<CategoryModulesResponse>('/api/category-modules/reconcile', 'POST', {});
}

// --- Quotes ------------------------------------------------------------------

export async function getQuotes(): Promise<Quote[]> {
  return fetchJson<Quote[]>('/api/quotes');
}

export async function createQuote(quote: QuoteInput): Promise<Quote> {
  return sendJson<Quote>('/api/quotes', 'POST', quote);
}

/** Only the fields present are changed; an explicit null slug clears it. */
export async function updateQuote(id: string, update: QuoteUpdate): Promise<Quote> {
  return sendJson<Quote>(`/api/quotes/${encodeURIComponent(id)}`, 'PATCH', update);
}

export async function deleteQuote(id: string): Promise<void> {
  return sendVoid(`/api/quotes/${encodeURIComponent(id)}`, 'DELETE');
}
