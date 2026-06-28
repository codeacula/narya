// Dashboard data service - calls backend API for all data.
import type {
  Viewer,
  ChatEntry,
  StreamEvent,
  RunItem,
  RunItemUpdate,
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
  ChattersResponse,
  SoundButton,
  SoundButtonUpdate,
  SoundPlayback,
  TickerItem,
  TickerItemUpdate,
  ChatbotCommand,
  ChatbotCommandSettings,
  ChatbotCommandSettingsResponse,
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
} from '../../shared/api';

const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4317';

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
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
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
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

export async function getStreamEvents(): Promise<StreamEvent[]> {
  return fetchJson<StreamEvent[]>('/api/dashboard/events');
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

export async function getTagSuggestions(query: string): Promise<string[]> {
  return fetchJson<string[]>(`/api/twitch/tag-suggestions?query=${encodeURIComponent(query)}`);
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

export async function getDiscordStatus(): Promise<DiscordStatus> {
  return fetchJson<DiscordStatus>('/api/discord/status');
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

export async function runGoLive(): Promise<GoLiveResult> {
  return sendJson<GoLiveResult>('/api/go-live', 'POST');
}

export async function getChatbotCommandSettings(): Promise<ChatbotCommandSettingsResponse> {
  return fetchJson<ChatbotCommandSettingsResponse>('/api/chatbot/command-settings');
}

export async function updateChatbotCommandSettings(settings: ChatbotCommandSettings): Promise<ChatbotCommandSettingsResponse> {
  return sendJson<ChatbotCommandSettingsResponse>('/api/chatbot/command-settings', 'PUT', settings);
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
  const response = await fetch(`${API_BASE}/api/chatbot/commands/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await readApiError(response));
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
  const response = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
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
  const response = await fetch(`${API_BASE}/api/sounds/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function playSoundButton(id: string): Promise<SoundPlayback> {
  return sendJson<SoundPlayback>(`/api/sounds/${encodeURIComponent(id)}/play`, 'POST');
}

export async function getRunsheet(): Promise<RunItem[]> {
  return fetchJson<RunItem[]>('/api/runsheet');
}

export async function createRunsheetItem(item: RunItemUpdate): Promise<RunItem> {
  return sendJson<RunItem>('/api/runsheet', 'POST', item);
}

export async function updateRunsheetItem(id: string, item: RunItemUpdate): Promise<RunItem> {
  return sendJson<RunItem>(`/api/runsheet/${encodeURIComponent(id)}`, 'PUT', item);
}

export async function deleteRunsheetItem(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/runsheet/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function getTicker(): Promise<TickerItem[]> {
  return fetchJson<TickerItem[]>('/api/ticker');
}

export async function createTickerItem(item: TickerItemUpdate): Promise<TickerItem> {
  return sendJson<TickerItem>('/api/ticker', 'POST', item);
}

export async function updateTickerItem(id: string, item: TickerItemUpdate): Promise<TickerItem> {
  return sendJson<TickerItem>(`/api/ticker/${encodeURIComponent(id)}`, 'PUT', item);
}

export async function deleteTickerItem(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/ticker/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function getChatters(): Promise<ChattersResponse> {
  return fetchJson<ChattersResponse>('/api/chatters');
}
