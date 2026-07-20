import { expect, test } from 'bun:test';
import { addProfileTag, MAX_VIEWER_TAGS, normalizeProfileTag, tagGateAllows } from './viewerTags';

test('normalizeProfileTag strips a leading hash and surrounding space, preserving case', () => {
  expect(normalizeProfileTag('  #No-LLM ')).toBe('No-LLM');
});

test('normalizeProfileTag caps length at 32 characters', () => {
  expect(normalizeProfileTag('x'.repeat(50))).toHaveLength(32);
});

test('addProfileTag dedupes case-insensitively', () => {
  expect(addProfileTag(['No-LLM'], 'no-llm')).toEqual(['No-LLM']);
});

test('addProfileTag refuses to exceed MAX_VIEWER_TAGS', () => {
  const full = Array.from({ length: MAX_VIEWER_TAGS }, (_, i) => `tag${i}`);
  expect(addProfileTag(full, 'one-more')).toEqual(full);
});

test('an empty allow list admits everyone', () => {
  expect(tagGateAllows([], [], [])).toBe(true);
  expect(tagGateAllows(['artist'], [], [])).toBe(true);
});

test('deny beats allow', () => {
  expect(tagGateAllows(['vip', 'no-llm'], ['vip'], ['no-llm'])).toBe(false);
});

test('the gate matches regardless of case', () => {
  expect(tagGateAllows(['No-LLM'], [], ['no-llm'])).toBe(false);
  expect(tagGateAllows(['no-llm'], [], ['No-LLM'])).toBe(false);
});

test('an allow list rejects a viewer carrying none of its tags', () => {
  expect(tagGateAllows(['artist'], ['vip'], [])).toBe(false);
});

test('an allow list rejects an invocation with no tags at all', () => {
  // A module-lifecycle or manual run has no login and therefore no tags. "Only these
  // tags may use this" does not describe an anonymous invocation.
  expect(tagGateAllows([], ['vip'], [])).toBe(false);
});

test('a deny list admits an invocation with no tags', () => {
  expect(tagGateAllows([], [], ['no-llm'])).toBe(true);
});
