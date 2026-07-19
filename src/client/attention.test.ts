import { beforeEach, describe, expect, test } from 'bun:test';
import type { ChatEntry, StreamEvent, Viewer } from '../shared/api';

// bun's test runtime has no DOM, and these helpers only need get/set/clear.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
};

import {
  DEFAULT_ATTENTION_TAG,
  loadAckedIds,
  loadAttentionSettings,
  projectAttentionItems,
  saveAckedIds,
  saveAttentionSettings,
} from './attention';

function viewer(login: string, tags: string[]): Viewer {
  return {
    login, display: login, color: '', realName: '', tags, roles: [],
    followed: '', subbed: '', seen: '', msgs: 0, accountAge: '', note: '', recent: [],
  };
}

function event(kind: StreamEvent['kind'], actor: string, at: string, sessionId: string | null = 'live'): StreamEvent {
  return { id: `${kind}-${actor}-${at}`, kind, actor, detail: `${kind} detail`, ago: '', tone: 'warning', receivedAt: at, sessionId };
}

function chatEntry(id: string, user: string, text: string, at: string, sessionId: string | null = 'live'): ChatEntry {
  return { id, user, text, time: '', at, sessionId };
}

describe('projectAttentionItems', () => {
  const viewers = {
    tagged: viewer('tagged', ['Notify', 'friend']),
    untagged: viewer('untagged', ['regular']),
  };

  test('includes thank-worthy event kinds and excludes ad breaks', () => {
    const events: StreamEvent[] = [
      event('sub', 'a', '2026-07-09T10:00:00Z'),
      event('cheer', 'b', '2026-07-09T10:01:00Z'),
      event('raid', 'c', '2026-07-09T10:02:00Z'),
      event('gift', 'd', '2026-07-09T10:03:00Z'),
      event('redeem', 'e', '2026-07-09T10:04:00Z'),
      event('follow', 'f', '2026-07-09T10:05:00Z'),
      event('ad_break', 'Twitch', '2026-07-09T10:06:00Z'),
    ];
    const items = projectAttentionItems({ events, chat: [], viewers, tag: DEFAULT_ATTENTION_TAG, currentSessionId: 'live' });
    expect(items.map(i => i.kind).sort()).toEqual(['cheer', 'follow', 'gift', 'raid', 'redeem', 'sub']);
  });

  test('includes chat only from viewers carrying the tag, case-insensitively', () => {
    const chat = [
      chatEntry('m1', 'tagged', 'hello', '2026-07-09T10:00:00Z'),
      chatEntry('m2', 'untagged', 'ignored', '2026-07-09T10:01:00Z'),
    ];
    const items = projectAttentionItems({ events: [], chat, viewers, tag: 'NOTIFY', currentSessionId: 'live' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'm1', source: 'chat', kind: 'chat', detail: 'hello' });
  });

  test('excludes a viewer once the tag is removed', () => {
    const chat = [chatEntry('m1', 'tagged', 'hello', '2026-07-09T10:00:00Z')];
    const untaggedViewers = { tagged: viewer('tagged', ['friend']) };
    expect(projectAttentionItems({ events: [], chat, viewers: untaggedViewers, tag: 'notify', currentSessionId: 'live' })).toEqual([]);
  });

  test('an empty tag routes no chat at all', () => {
    const chat = [chatEntry('m1', 'tagged', 'hello', '2026-07-09T10:00:00Z')];
    expect(projectAttentionItems({ events: [], chat, viewers, tag: '   ', currentSessionId: 'live' })).toEqual([]);
  });

  test('whispers never route into the feed', () => {
    const chat: ChatEntry[] = [{ ...chatEntry('w1', 'tagged', 'psst', '2026-07-09T10:00:00Z'), kind: 'whisper' }];
    expect(projectAttentionItems({ events: [], chat, viewers, tag: 'notify', currentSessionId: 'live' })).toEqual([]);
  });

  test('merges both sources newest-first', () => {
    const events = [event('sub', 'a', '2026-07-09T10:00:00Z')];
    const chat = [chatEntry('m1', 'tagged', 'later', '2026-07-09T10:05:00Z')];
    const items = projectAttentionItems({ events, chat, viewers, tag: 'notify', currentSessionId: 'live' });
    expect(items.map(i => i.id)).toEqual(['m1', 'sub-a-2026-07-09T10:00:00Z']);
  });

  test('excludes events from an earlier stream session', () => {
    const events = [
      event('sub', 'thisStream', '2026-07-09T10:00:00Z', 'live'),
      event('sub', 'lastStream', '2026-07-09T10:01:00Z', 'old-session'),
      event('sub', 'offStream', '2026-07-09T10:02:00Z', null),
    ];
    const items = projectAttentionItems({ events, chat: [], viewers, tag: 'notify', currentSessionId: 'live' });
    expect(items.map(i => i.actor)).toEqual(['thisStream']);
  });

  test('off-stream, no event is worth thanking', () => {
    const events = [
      event('sub', 'lastStream', '2026-07-09T10:00:00Z', 'old-session'),
      event('follow', 'offStream', '2026-07-09T10:01:00Z', null),
    ];
    const items = projectAttentionItems({ events, chat: [], viewers, tag: 'notify', currentSessionId: null });
    expect(items).toEqual([]);
  });

  test('off-stream, tagged chat sent off-stream still routes through', () => {
    const chat = [chatEntry('m1', 'tagged', 'hello', '2026-07-09T10:00:00Z', null)];
    const items = projectAttentionItems({ events: [], chat, viewers, tag: 'notify', currentSessionId: null });
    expect(items.map(i => i.id)).toEqual(['m1']);
  });

  // The chat backlog spans previous streams; a tagged viewer's day-old message
  // is not something waiting on you right now.
  test('excludes tagged chat from an earlier stream session', () => {
    const chat = [
      chatEntry('m1', 'tagged', 'today', '2026-07-09T10:00:00Z', 'live'),
      chatEntry('m2', 'tagged', 'yesterday', '2026-07-08T10:00:00Z', 'old-session'),
      chatEntry('m3', 'tagged', 'off-stream', '2026-07-08T20:00:00Z', null),
    ];
    const items = projectAttentionItems({ events: [], chat, viewers, tag: 'notify', currentSessionId: 'live' });
    expect(items.map(i => i.id)).toEqual(['m1']);
  });

  test('caps the feed at 30 items', () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      event('sub', `a${i}`, `2026-07-09T10:${String(i).padStart(2, '0')}:00Z`));
    expect(projectAttentionItems({ events, chat: [], viewers, tag: 'notify', currentSessionId: 'live' })).toHaveLength(30);
  });
});

describe('acked ids', () => {
  beforeEach(() => { localStorage.clear(); });

  test('round-trips through localStorage', () => {
    saveAckedIds(new Set(['a', 'b']));
    expect(loadAckedIds()).toEqual(new Set(['a', 'b']));
  });

  test('keeps only the newest ids once capped', () => {
    const many = new Set(Array.from({ length: 250 }, (_, i) => `id-${i}`));
    const saved = saveAckedIds(many);
    expect(saved.size).toBe(200);
    expect(saved.has('id-249')).toBe(true);
    expect(saved.has('id-0')).toBe(false);
  });

  test('returns an empty set when nothing is stored', () => {
    expect(loadAckedIds()).toEqual(new Set());
  });

  test('survives corrupt stored json', () => {
    localStorage.setItem('attentionAckedIds', 'not json');
    expect(loadAckedIds()).toEqual(new Set());
  });
});

describe('attention settings', () => {
  beforeEach(() => { localStorage.clear(); });

  test('defaults to the notify tag with both sounds on', () => {
    expect(loadAttentionSettings()).toEqual({ tag: 'notify', soundEnabled: true, mentionSoundEnabled: true });
  });

  test('round-trips a custom tag and muted sounds', () => {
    saveAttentionSettings({ tag: 'vip', soundEnabled: false, mentionSoundEnabled: false });
    expect(loadAttentionSettings()).toEqual({ tag: 'vip', soundEnabled: false, mentionSoundEnabled: false });
  });

  test('the two sound toggles are independent', () => {
    saveAttentionSettings({ tag: 'notify', soundEnabled: false, mentionSoundEnabled: true });
    expect(loadAttentionSettings().mentionSoundEnabled).toBe(true);
  });

  // Settings written before mention sound had its own toggle have no such key;
  // defaulting it off would silently take the ping away from existing operators.
  test('settings stored before the mention toggle existed keep the ping', () => {
    localStorage.setItem('attentionSettings', JSON.stringify({ tag: 'notify', soundEnabled: true }));
    expect(loadAttentionSettings().mentionSoundEnabled).toBe(true);
  });

  test('falls back to defaults on corrupt json', () => {
    localStorage.setItem('attentionSettings', '{{');
    expect(loadAttentionSettings()).toEqual({ tag: 'notify', soundEnabled: true, mentionSoundEnabled: true });
  });
});
