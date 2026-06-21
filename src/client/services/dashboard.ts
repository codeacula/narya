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
  SoundButton,
  SoundPlayback,
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

export async function disconnectTwitch(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/auth/twitch`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Twitch logout failed with ${response.status}`);
}

export async function getControlConfig(): Promise<ControlConfig> {
  return fetchJson<ControlConfig>('/api/control/config');
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
