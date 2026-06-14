// Dashboard data service - calls backend API for all data.
import type { Viewer, ChatEntry, StreamEvent, RunItem } from '../types';

const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4317';

let viewersCache: Record<string, Viewer> | null = null;
let chatCache: ChatEntry[] | null = null;
let eventsCache: StreamEvent[] | null = null;

export async function getViewers(): Promise<Record<string, Viewer>> {
  if (viewersCache) return viewersCache;
  const res = await fetch(`${API_BASE}/api/dashboard/viewers`);
  viewersCache = await res.json();
  return viewersCache!;
}

export async function getChatEntries(): Promise<ChatEntry[]> {
  if (chatCache) return chatCache;
  const res = await fetch(`${API_BASE}/api/dashboard/chat`);
  chatCache = await res.json();
  return chatCache!;
}

export async function getStreamEvents(): Promise<StreamEvent[]> {
  if (eventsCache) return eventsCache;
  const res = await fetch(`${API_BASE}/api/dashboard/events`);
  eventsCache = await res.json();
  return eventsCache!;
}

export function getRunsheet(): RunItem[] {
  return [];
}

export function getTicker(): string[] {
  return [];
}
