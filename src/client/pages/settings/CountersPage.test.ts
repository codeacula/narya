import { describe, expect, test } from 'bun:test';
import { counterUpdateFromDraft, parseCounterValue, previewCounterKey } from './CountersPage';

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

describe('counterUpdateFromDraft', () => {
  const draft = (over: Partial<{ key: string; label: string; value: string; originalValue: string }> = {}) => ({
    key: 'deaths', label: 'Deaths', value: '10', originalValue: '10', ...over,
  });

  /**
   * The form holds a snapshot from when the editor opened. Sending an untouched
   * value back would overwrite whatever automation or /counter wrote in the
   * meantime — silently losing a durable count while renaming a label.
   */
  test('omits the value entirely when the operator did not touch it', () => {
    const update = counterUpdateFromDraft(draft({ label: 'Renamed' }));
    expect(update).toEqual({ key: 'deaths', label: 'Renamed' });
    expect(update && 'value' in update).toBe(false);
  });

  test('includes the value when the operator edited it', () => {
    expect(counterUpdateFromDraft(draft({ value: '42' }))).toEqual({
      key: 'deaths', label: 'Deaths', value: 42,
    });
  });

  test('includes a deliberately typed negative', () => {
    expect(counterUpdateFromDraft(draft({ value: '-3' }))).toEqual({
      key: 'deaths', label: 'Deaths', value: -3,
    });
  });

  test('an explicit edit back to the same number still counts as untouched', () => {
    // Same text as loaded, so there is nothing to write and nothing to clobber.
    const update = counterUpdateFromDraft(draft({ value: '10', originalValue: '10' }));
    expect(update && 'value' in update).toBe(false);
  });

  test('returns null when an edited value is not a number', () => {
    expect(counterUpdateFromDraft(draft({ value: 'banana' }))).toBeNull();
  });
});
