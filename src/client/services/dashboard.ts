// Dashboard data service - calls backend API for all data.
import type {
  Viewer,
  ChatEntry,
  StreamEvent,
  RunItem,
  DashboardStatus,
  StreamInfo,
  TwitchCategorySuggestion,
  StreamInfoUpdate,
  PrerollResult,
  ChatSendResult,
  ControlConfig,
  ControlResponse,
  ObsStatus,
  SoundButton,
  SoundPlayback,
  ChatbotCommand,
  ChatbotCommandSettings,
  ChatbotCommandSettingsResponse,
  ChatbotCommandUpsert,
  LlmSettings,
  LlmSettingsUpdate,
  ViewerProfileUpdate,
  TwitchUserActionResult,
} from '../../shared/api';

const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4317';

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
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

export async function sendChatMessage(message: string): Promise<ChatSendResult> {
  return sendJson('/api/twitch/chat-message', 'POST', { message });
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

export async function playSoundButton(id: string): Promise<SoundPlayback> {
  return sendJson<SoundPlayback>(`/api/sounds/${encodeURIComponent(id)}/play`, 'POST');
}

export async function getRunsheet(): Promise<RunItem[]> {
  return fetchJson<RunItem[]>('/api/runsheet');
}

export async function getTicker(): Promise<string[]> {
  return fetchJson<string[]>('/api/ticker');
}
