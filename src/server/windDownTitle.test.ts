import { describe, expect, test } from 'bun:test';
import { composeWindDownTitle, MAX_TWITCH_TITLE_LENGTH, stripWindDownSuffix } from './windDownTitle';

describe('composeWindDownTitle', () => {
  test('appends the suffix to the base title', () => {
    expect(composeWindDownTitle('Modding Skyrim', '| Ending soon')).toBe('Modding Skyrim | Ending soon');
  });

  test('trims surrounding whitespace on both parts', () => {
    expect(composeWindDownTitle('  Modding Skyrim  ', '  | Ending soon  ')).toBe('Modding Skyrim | Ending soon');
  });

  test('an empty suffix leaves the title untouched', () => {
    expect(composeWindDownTitle('Modding Skyrim', '   ')).toBe('Modding Skyrim');
  });

  test('an empty base title yields just the suffix', () => {
    expect(composeWindDownTitle('', '| Ending soon')).toBe('| Ending soon');
  });

  // Twitch rejects a title over 140 characters, and a rejected PATCH is a silent
  // no-op at exactly the moment the operator is counting on it. The suffix is the
  // entire point of the operation, so the base title is what yields.
  test('truncates the base title so the suffix always survives', () => {
    const base = 'A'.repeat(200);
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(result.endsWith('| Ending soon')).toBe(true);
    expect(result).toContain('…');
  });

  test('truncation prefers a word boundary', () => {
    const base = `${'word '.repeat(40)}tail`;
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(result).toContain('word… | Ending soon');
  });

  test('a suffix longer than the whole limit is hard-truncated rather than throwing', () => {
    const result = composeWindDownTitle('Base', 'X'.repeat(200));
    expect(result.length).toBe(MAX_TWITCH_TITLE_LENGTH);
  });

  test('a title exactly at the limit is left alone', () => {
    const suffix = '| Ending soon';
    const base = 'B'.repeat(MAX_TWITCH_TITLE_LENGTH - suffix.length - 1);
    const result = composeWindDownTitle(base, suffix);
    expect(result.length).toBe(MAX_TWITCH_TITLE_LENGTH);
    expect(result).toBe(`${base} ${suffix}`);
  });
});

describe('stripWindDownSuffix', () => {
  test('removes a suffix the operator edited around', () => {
    expect(stripWindDownSuffix('Modding Skyrim | Ending soon', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('removes the truncation ellipsis along with the suffix', () => {
    expect(stripWindDownSuffix('Modding Skyrim… | Ending soon', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('leaves a title that does not carry the suffix alone', () => {
    expect(stripWindDownSuffix('Modding Skyrim', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('an empty suffix is a no-op', () => {
    expect(stripWindDownSuffix('Modding Skyrim', '')).toBe('Modding Skyrim');
  });

  test('a title that is only the suffix strips to empty', () => {
    expect(stripWindDownSuffix('| Ending soon', '| Ending soon')).toBe('');
  });
});
