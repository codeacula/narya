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

  // An astral-plane character (e.g. most emoji) occupies two UTF-16 code units. If the
  // cut point lands between them, a raw slice leaves a lone high surrogate: `.length`
  // still satisfies the guard, but encoding the result to UTF-8 turns the orphan into
  // U+FFFD, glitching the live title. The cut must fall on a whole-character boundary.
  test('an astral character straddling the cut boundary produces no unpaired surrogate', () => {
    const base = `${'A'.repeat(124)}\u{1F600}${'B'.repeat(50)}`;
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
  });

  test('an astral character comfortably before the cut point survives intact', () => {
    const base = `\u{1F600}${'A'.repeat(200)}`;
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(result).toContain('\u{1F600}');
    expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
  });

  // The suffix itself can be too long to fit at all (the `room <= 0` branch), which
  // hard-truncates the suffix with a raw slice. If an astral character straddles
  // position 140 within the suffix, the same dangling-surrogate corruption applies —
  // this must fail without the shared guard even though the earlier "comfortably
  // before" case does not exercise this branch.
  test('an astral character straddling the cut point inside an over-long suffix produces no unpaired surrogate', () => {
    const suffix = `${'X'.repeat(139)}\u{1F600}${'Z'.repeat(20)}`;
    const result = composeWindDownTitle('Base', suffix);
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
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
