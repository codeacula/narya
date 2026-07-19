import { describe, expect, test } from 'bun:test';
import { parseCounterValue, previewCounterKey } from './CountersPage';

describe('previewCounterKey', () => {
  test('mirrors the server normalization so the hint shows the real token', () => {
    expect(previewCounterKey('Zambie Deaths!')).toBe('zambie-deaths');
    expect(previewCounterKey('total_wipes')).toBe('total-wipes');
    expect(previewCounterKey('--a---b--')).toBe('a-b');
    expect(previewCounterKey('!!!')).toBe('');
  });
});

describe('parseCounterValue', () => {
  /**
   * Counters are deliberately signed, and the editor previously parsed on every
   * keystroke: typing "-" produced NaN, which `|| 0` rewrote to "0" before the
   * digits could arrive, making a negative unreachable from the keyboard.
   */
  test('treats a lone minus as a legal mid-typing state', () => {
    expect(parseCounterValue('-')).toBe(0);
  });

  test('parses a completed negative', () => {
    expect(parseCounterValue('-5')).toBe(-5);
  });

  test('treats empty as zero rather than invalid', () => {
    expect(parseCounterValue('')).toBe(0);
    expect(parseCounterValue('   ')).toBe(0);
  });

  test('rounds a decimal to a whole number', () => {
    expect(parseCounterValue('2.6')).toBe(3);
  });

  test('rejects text so the form can say so instead of silently writing 0', () => {
    expect(parseCounterValue('banana')).toBeNull();
    expect(parseCounterValue('1-2')).toBeNull();
  });

  test('parses a positive', () => {
    expect(parseCounterValue('42')).toBe(42);
  });
});
