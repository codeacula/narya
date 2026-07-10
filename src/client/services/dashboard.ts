// Dashboard data service - calls backend API for all data.
import type {
  Viewer,
  ViewerDetails,
  ChatEntry,
  ChatMessage,
  MediaFile,
  MediaPlayback,
  MusicInfo,
  RewardMedia,
  StreamEvent,
  SessionShoutout,
  DashboardStatus,
  StreamInfo,
  TwitchCategorySuggestion,
  StreamInfoUpdate,
  PrerollResult,
  ChatSendResult,
  ChatSender,
  ControlConfig,
  ControlResponse,
  ObsStatus,
  Chatter,
  ChattersResponse,
  ViewerRosterEntry,
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
  StreamStatus,
} from '../../shared/api';
import { getDashboardToken } from '../auth';

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

async function readApiError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    return data.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
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

/** Plays a reward's media on the overlay without spending channel points. */
/** Pass `media` to preview an unsaved binding; omit it to play the saved one. */
export async function testRewardMedia(id: string, media?: RewardMedia | null): Promise<MediaPlayback> {
  return sendJson<MediaPlayback>(
    `/api/twitch/rewards/${encodeURIComponent(id)}/media/play`,
    'POST',
    media ? { media } : {},
  );
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
  const response = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!response.ok) throw new Error(`Twitch logout failed with ${response.status}`);
}

export async function getControlConfig(): Promise<ControlConfig> {
  return fetchJson<ControlConfig>('/api/control/config');
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

export async function getTtsEnabledRewards(): Promise<string[]> {
  return fetchJson<string[]>('/api/tts/rewards');
}

export async function setTtsRewardEnabled(rewardId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return sendJson<{ enabled: boolean }>(`/api/tts/reward/${encodeURIComponent(rewardId)}`, 'PUT', { enabled });
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
