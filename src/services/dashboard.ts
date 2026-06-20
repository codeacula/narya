// Dashboard data service - calls backend API for all data.
import type { Viewer, ChatEntry, StreamEvent, RunItem, DashboardStatus } from '../types';

const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4317';

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getViewers(): Promise<Record<string, Viewer>> {
  return fetchJson<Record<string, Viewer>>('/api/dashboard/viewers');
}

export async function getChatEntries(): Promise<ChatEntry[]> {
  return fetchJson<ChatEntry[]>('/api/dashboard/chat');
}

export async function getStreamEvents(): Promise<StreamEvent[]> {
  return fetchJson<StreamEvent[]>('/api/dashboard/events');
}

export async function getDashboardStatus(): Promise<DashboardStatus> {
  return fetchJson<DashboardStatus>('/api/dashboard/status');
}

export function getRunsheet(): RunItem[] {
  return [];
}

export function getTicker(): string[] {
  return [];
}
