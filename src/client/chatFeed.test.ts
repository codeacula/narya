import { describe, expect, test } from 'bun:test';
import type { ChatEntry, Chatter } from '../shared/api';
import type { RecentChatter } from './ui/panels';
import { CHAT_PRESENCE_TTL_MS } from '../shared/constants';
import {
  LIVE_CHAT_CAP,
  OLDER_CHAT_PAGE,
  appendLiveChatEntry,
  fetchOlderChatPage,
  mergeChatterPresence,
  registerChatterLogin,
} from './chatFeed';

function entry(id: string, user = 'someone'): ChatEntry {
  return { id, user, text: `text ${id}`, time: '', at: '2026-07-09T10:00:00Z', sessionId: 'live' };
}

function chatter(login: string): Chatter {
  return { userId: 'chat:' + login.toLowerCase(), userLogin: login, userName: login };
}

function recent(login: string, at: number): RecentChatter {
  return { chatter: chatter(login), at };
}

describe('appendLiveChatEntry', () => {
  test('appends to the end', () => {
    const result = appendLiveChatEntry([entry('a')], entry('b'));
    expect(result.map(e => e.id)).toEqual(['a', 'b']);
  });

  test('caps the tail at LIVE_CHAT_CAP, dropping the oldest', () => {
    let chat: ChatEntry[] = [];
    for (let i = 0; i < LIVE_CHAT_CAP + 25; i += 1) chat = appendLiveChatEntry(chat, entry(`m${i}`));
    expect(chat).toHaveLength(LIVE_CHAT_CAP);
    expect(chat[0].id).toBe('m25');
    expect(chat[chat.length - 1].id).toBe(`m${LIVE_CHAT_CAP + 24}`);
    expect(chat.some(e => e.id === 'm24')).toBe(false);
  });

  test('stays exactly at the cap once full', () => {
    let chat: ChatEntry[] = [];
    for (let i = 0; i < LIVE_CHAT_CAP; i += 1) chat = appendLiveChatEntry(chat, entry(`m${i}`));
    expect(chat).toHaveLength(LIVE_CHAT_CAP);
    expect(chat[0].id).toBe('m0');
    chat = appendLiveChatEntry(chat, entry('next'));
    expect(chat).toHaveLength(LIVE_CHAT_CAP);
    expect(chat[0].id).toBe('m1');
  });

  // tmi replays messages after a reconnect.
  test('a repeated id does not append a second entry', () => {
    const chat = [entry('a'), entry('b')];
    const result = appendLiveChatEntry(chat, entry('a'));
    expect(result.map(e => e.id)).toEqual(['a', 'b']);
    expect(result).toBe(chat);
  });

  test('a replayed id does not reorder or mutate existing entries', () => {
    const chat = [entry('a'), entry('b'), entry('c')];
    const replayed = appendLiveChatEntry(chat, { ...entry('b'), text: 'replayed' });
    expect(replayed.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(replayed.map(e => e.text)).toEqual(['text a', 'text b', 'text c']);
  });

  test('a replay of a message already pushed past the cap appends again', () => {
    let chat: ChatEntry[] = [];
    for (let i = 0; i < LIVE_CHAT_CAP + 5; i += 1) chat = appendLiveChatEntry(chat, entry(`m${i}`));
    const evicted = appendLiveChatEntry(chat, entry('m0'));
    expect(evicted[evicted.length - 1].id).toBe('m0');
    expect(evicted).toHaveLength(LIVE_CHAT_CAP);
  });
});

describe('mergeChatterPresence', () => {
  const now = 1_700_000_000_000;

  test('folds a sender in immediately', () => {
    const result = mergeChatterPresence([], chatter('alice'), now);
    expect(result).toEqual([{ chatter: chatter('alice'), at: now }]);
  });

  test('drops entries older than the presence TTL', () => {
    const current = [
      recent('stale', now - CHAT_PRESENCE_TTL_MS - 1),
      recent('fresh', now - CHAT_PRESENCE_TTL_MS + 1),
    ];
    const result = mergeChatterPresence(current, chatter('alice'), now);
    expect(result.map(e => e.chatter.userLogin)).toEqual(['fresh', 'alice']);
  });

  test('keeps an entry sitting exactly on the TTL boundary', () => {
    const current = [recent('edge', now - CHAT_PRESENCE_TTL_MS)];
    const result = mergeChatterPresence(current, chatter('alice'), now);
    expect(result.map(e => e.chatter.userLogin)).toEqual(['edge', 'alice']);
  });

  test('a repeat chatter is de-duplicated by login rather than appearing twice', () => {
    const current = [recent('alice', now - 1000), recent('bob', now - 500)];
    const result = mergeChatterPresence(current, chatter('alice'), now);
    expect(result.map(e => e.chatter.userLogin)).toEqual(['bob', 'alice']);
    expect(result[result.length - 1].at).toBe(now);
  });

  test('de-duplication ignores login case', () => {
    const current = [recent('Alice', now - 1000)];
    const result = mergeChatterPresence(current, chatter('aLiCe'), now);
    expect(result).toHaveLength(1);
    expect(result[0].chatter.userLogin).toBe('aLiCe');
  });
});

describe('registerChatterLogin', () => {
  test('is true the first time a login is seen and false afterwards', () => {
    const known = new Set<string>();
    expect(registerChatterLogin(known, 'alice')).toBe(true);
    expect(registerChatterLogin(known, 'alice')).toBe(false);
    expect(registerChatterLogin(known, 'alice')).toBe(false);
  });

  test('an already-known login never triggers a refetch', () => {
    expect(registerChatterLogin(new Set(['alice']), 'alice')).toBe(false);
  });

  test('tracks each login independently', () => {
    const known = new Set<string>();
    expect(registerChatterLogin(known, 'alice')).toBe(true);
    expect(registerChatterLogin(known, 'bob')).toBe(true);
    expect(registerChatterLogin(known, 'alice')).toBe(false);
    expect(known).toEqual(new Set(['alice', 'bob']));
  });
});

describe('fetchOlderChatPage', () => {
  function page(size: number): ChatEntry[] {
    return Array.from({ length: size }, (_, i) => entry(`old-${i}`));
  }

  test('fetches before the current oldest entry', async () => {
    const asked: string[] = [];
    await fetchOlderChatPage([entry('oldest'), entry('newest')], async id => {
      asked.push(id);
      return [];
    });
    expect(asked).toEqual(['oldest']);
  });

  test('does not fetch at all when the feed is empty', async () => {
    let called = false;
    const result = await fetchOlderChatPage([], async () => { called = true; return page(OLDER_CHAT_PAGE); });
    expect(called).toBe(false);
    expect(result).toEqual({ older: [], hasMore: false });
  });

  test('returns the older entries so the caller can prepend them', async () => {
    const older = page(3);
    const result = await fetchOlderChatPage([entry('a')], async () => older);
    expect(result.older).toEqual(older);
    expect([...result.older, entry('a')].map(e => e.id)).toEqual(['old-0', 'old-1', 'old-2', 'a']);
  });

  test('hasMore is false when nothing older came back', async () => {
    expect(await fetchOlderChatPage([entry('a')], async () => [])).toEqual({ older: [], hasMore: false });
  });

  test('hasMore is true only for a full page', async () => {
    const full = await fetchOlderChatPage([entry('a')], async () => page(OLDER_CHAT_PAGE));
    expect(full.hasMore).toBe(true);
    const short = await fetchOlderChatPage([entry('a')], async () => page(OLDER_CHAT_PAGE - 1));
    expect(short.hasMore).toBe(false);
  });
});
