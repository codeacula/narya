import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  mergeTagSuggestions,
  normalizeTag,
  normalizeTags,
  recordTagHistory,
  suggestTagHistory,
} from './tags';

describe('normalizeTag', () => {
  test('strips a leading # and non-alphanumerics, caps at 25 chars', () => {
    expect(normalizeTag('#Speedrun!')).toBe('Speedrun');
    expect(normalizeTag('  hello world  ')).toBe('helloworld');
    expect(normalizeTag('x'.repeat(40))).toHaveLength(25);
  });
});

describe('normalizeTags', () => {
  test('dedupes case-insensitively and caps at 10', () => {
    expect(normalizeTags(['Chill', 'chill', 'Cozy'])).toEqual(['Chill', 'Cozy']);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
  test('ignores non-arrays and non-strings', () => {
    expect(normalizeTags('nope')).toEqual([]);
    expect(normalizeTags([1, {}, 'ok'])).toEqual(['ok']);
  });
});

describe('tag history', () => {
  beforeEach(() => { db.exec('delete from stream_tag_history'); });

  test('records tags and suggests them by substring, most-recent first', () => {
    recordTagHistory(['Cozy']);
    recordTagHistory(['Speedrun', 'Coding']);
    // Later inserts are more recent; "co" matches Coding and Cozy.
    expect(suggestTagHistory('co')).toEqual(['Coding', 'Cozy']);
  });

  test('an empty query returns recent history', () => {
    recordTagHistory(['Alpha']);
    recordTagHistory(['Beta']);
    expect(suggestTagHistory('')).toEqual(['Beta', 'Alpha']);
  });

  test('re-recording a tag refreshes its recency without duplicating', () => {
    recordTagHistory(['Alpha']);
    recordTagHistory(['Beta']);
    recordTagHistory(['Alpha']);
    expect(suggestTagHistory('')).toEqual(['Alpha', 'Beta']);
  });
});

describe('mergeTagSuggestions', () => {
  test('history first, then channel tags, then the typed candidate, deduped, capped', () => {
    const merged = mergeTagSuggestions({
      history: ['Coding', 'Cozy'],
      channelTags: ['Cozy', 'English'],
      candidate: 'Coding',
      limit: 8,
    });
    expect(merged).toEqual(['Coding', 'Cozy', 'English']);
  });
  test('adds the candidate when it is not already present', () => {
    expect(mergeTagSuggestions({ history: [], channelTags: [], candidate: 'Fresh' }))
      .toEqual(['Fresh']);
  });
});
