import React from 'react';
import type { ChatEntry, StreamEvent, Viewer } from '../shared/api';
import { playAttentionChime } from './sounds';

export type AttentionItem = {
  id: string;
  source: 'event' | 'chat';
  kind: string;
  actor: string;
  detail: string;
  at: string;
};

/** Thank-worthy event kinds. `ad_break` is deliberately absent — nobody thanks an ad. */
export const ATTENTION_EVENT_KINDS = new Set(['follow', 'sub', 'gift', 'cheer', 'raid', 'redeem']);

const MAX_ITEMS = 30;
const MAX_ACKED_IDS = 200;
const ACK_KEY = 'attentionAckedIds';
const SETTINGS_KEY = 'attentionSettings';

export const DEFAULT_ATTENTION_TAG = 'notify';

export type AttentionSettings = {
  tag: string;
  soundEnabled: boolean;
};

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = {
  tag: DEFAULT_ATTENTION_TAG,
  soundEnabled: true,
};

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Merge the thank-worthy stream events with chat from tagged viewers, newest first.
 * Pure so it can be tested without a renderer.
 */
export function projectAttentionItems(input: {
  events: StreamEvent[];
  chat: ChatEntry[];
  viewers: Record<string, Viewer>;
  tag: string;
  /** Only events from this stream session are worth thanking. Null when off-stream. */
  currentSessionId: string | null;
}): AttentionItem[] {
  const { events, chat, viewers, currentSessionId } = input;
  const tag = normalizeTag(input.tag);

  const items: AttentionItem[] = [];

  // Off-stream there is nobody to thank right now, so no event qualifies —
  // otherwise the feed would pulse over a resub from a previous stream.
  // Tagged chat still routes through, since chat is always live.
  for (const event of currentSessionId === null ? [] : events) {
    if (!ATTENTION_EVENT_KINDS.has(event.kind)) continue;
    if (event.sessionId !== currentSessionId) continue;
    items.push({
      id: event.id,
      source: 'event',
      kind: event.kind,
      actor: event.actor,
      detail: event.kind === 'follow' ? 'followed' : event.detail,
      at: event.receivedAt ?? '',
    });
  }

  if (tag !== '') {
    for (const entry of chat) {
      if (entry.kind === 'whisper') continue;
      const viewer = viewers[entry.user.toLowerCase()];
      if (!viewer?.tags.some(t => normalizeTag(t) === tag)) continue;
      items.push({
        id: entry.id,
        source: 'chat',
        kind: 'chat',
        actor: viewer.display || entry.user,
        detail: entry.text,
        at: entry.at ?? '',
      });
    }
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return items.slice(0, MAX_ITEMS);
}

export function loadAckedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_KEY);
    if (raw === null) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

/** Keeps only the newest ids so a long stream can't grow this without bound. */
export function saveAckedIds(acked: Set<string>): Set<string> {
  const trimmed = [...acked].slice(-MAX_ACKED_IDS);
  try {
    localStorage.setItem(ACK_KEY, JSON.stringify(trimmed));
  } catch {
    // A full or unavailable localStorage shouldn't break the feed.
  }
  return new Set(trimmed);
}

export function loadAttentionSettings(): AttentionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_ATTENTION_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AttentionSettings>;
    return {
      tag: typeof parsed.tag === 'string' ? parsed.tag : DEFAULT_ATTENTION_TAG,
      soundEnabled: parsed.soundEnabled !== false,
    };
  } catch {
    return { ...DEFAULT_ATTENTION_SETTINGS };
  }
}

export function saveAttentionSettings(settings: AttentionSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore — settings fall back to defaults next load.
  }
}

export function useAttentionSettings() {
  const [settings, setSettings] = React.useState<AttentionSettings>(() => loadAttentionSettings());

  const update = React.useCallback((patch: Partial<AttentionSettings>) => {
    setSettings(current => {
      const next = { ...current, ...patch };
      saveAttentionSettings(next);
      return next;
    });
  }, []);

  return { settings, update };
}

export function useAttention(input: {
  events: StreamEvent[];
  chat: ChatEntry[];
  viewers: Record<string, Viewer>;
  tag: string;
  soundEnabled: boolean;
  currentSessionId: string | null;
}) {
  const { events, chat, viewers, tag, soundEnabled, currentSessionId } = input;
  const [acked, setAcked] = React.useState<Set<string>>(() => loadAckedIds());

  const items = React.useMemo(
    () => projectAttentionItems({ events, chat, viewers, tag, currentSessionId }),
    [events, chat, viewers, tag, currentSessionId],
  );

  const seenIds = React.useRef<Set<string> | null>(null);

  React.useEffect(() => {
    const currentIds = new Set(items.map(item => item.id));
    // The first projection is the REST-seeded backlog. Chiming for it would fire
    // a burst of dings on every page load.
    if (seenIds.current === null) {
      seenIds.current = currentIds;
      return;
    }
    const hasNewUnacked = items.some(item => !seenIds.current?.has(item.id) && !acked.has(item.id));
    seenIds.current = currentIds;
    if (hasNewUnacked && soundEnabled) playAttentionChime();
  }, [items, acked, soundEnabled]);

  const ack = React.useCallback((id: string) => {
    setAcked(current => {
      if (current.has(id)) return current;
      return saveAckedIds(new Set(current).add(id));
    });
  }, []);

  const dismissAll = React.useCallback(() => {
    setAcked(current => {
      const next = new Set(current);
      for (const item of items) next.add(item.id);
      return saveAckedIds(next);
    });
  }, [items]);

  const unackedCount = React.useMemo(
    () => items.reduce((count, item) => count + (acked.has(item.id) ? 0 : 1), 0),
    [items, acked],
  );

  return { items, acked, unackedCount, ack, dismissAll };
}
