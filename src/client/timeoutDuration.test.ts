import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  TIMEOUT_PRESETS,
  isValidTimeoutMinutes,
  resolveTimeoutMinutes,
  timeoutLabel,
  timeoutSeconds,
} from './timeoutDuration';

describe('timeoutLabel', () => {
  test('a preset keeps the preset wording', () => {
    // 1440 is a whole day, but the chip says 24h — the confirm button has to
    // agree with the chip the operator just clicked, not out-clever it.
    expect(timeoutLabel(1_440)).toBe('24h');
    expect(timeoutLabel(10_080)).toBe('7d');
    expect(timeoutLabel(60)).toBe('1h');
  });

  test('a custom value falls back to the largest whole unit', () => {
    expect(timeoutLabel(3)).toBe('3m');
    expect(timeoutLabel(90)).toBe('90m');
    expect(timeoutLabel(120)).toBe('2h');
    expect(timeoutLabel(2_880)).toBe('2d');
  });

  test('an unusable value renders as a dash rather than "NaNm"', () => {
    expect(timeoutLabel(Number.NaN)).toBe('—');
    expect(timeoutLabel(0)).toBe('—');
    expect(timeoutLabel(-5)).toBe('—');
  });
});

describe('isValidTimeoutMinutes', () => {
  test('accepts the whole range the server accepts', () => {
    expect(isValidTimeoutMinutes(1)).toBe(true);
    expect(isValidTimeoutMinutes(MAX_TIMEOUT_MINUTES)).toBe(true);
  });

  test('rejects just past each bound', () => {
    expect(isValidTimeoutMinutes(0)).toBe(false);
    expect(isValidTimeoutMinutes(MAX_TIMEOUT_MINUTES + 1)).toBe(false);
  });

  test('rejects what an empty or junk custom field parses to', () => {
    expect(isValidTimeoutMinutes(Number.NaN)).toBe(false);
    expect(isValidTimeoutMinutes(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test('every preset is submittable', () => {
    for (const preset of TIMEOUT_PRESETS) {
      expect(isValidTimeoutMinutes(preset.minutes)).toBe(true);
    }
  });
});

describe('resolveTimeoutMinutes', () => {
  test('with no custom entry the selected chip wins', () => {
    expect(resolveTimeoutMinutes(10, '')).toBe(10);
    expect(resolveTimeoutMinutes(60, '   ')).toBe(60);
  });

  test('a custom entry overrides the chip', () => {
    expect(resolveTimeoutMinutes(10, '45')).toBe(45);
  });

  test('clearing the custom field returns to the chip, not to nothing', () => {
    expect(resolveTimeoutMinutes(5, '45')).toBe(45);
    expect(resolveTimeoutMinutes(5, '')).toBe(5);
  });

  test('junk resolves to NaN so the confirm button can disable', () => {
    expect(isValidTimeoutMinutes(resolveTimeoutMinutes(10, 'abc'))).toBe(false);
    expect(isValidTimeoutMinutes(resolveTimeoutMinutes(10, '10abc'))).toBe(false);
  });
});

describe('timeoutSeconds', () => {
  test('converts minutes to seconds', () => {
    expect(timeoutSeconds(10)).toBe(600);
    expect(timeoutSeconds(1)).toBe(60);
  });

  test('clamps over the ceiling rather than substituting a default', () => {
    // Silently serving 10 minutes to someone who typed 30000 would invert their
    // intent; the 14-day ceiling is at least the same direction.
    expect(timeoutSeconds(30_000)).toBe(MAX_TIMEOUT_MINUTES * 60);
    expect(timeoutSeconds(0)).toBe(60);
    expect(timeoutSeconds(-10)).toBe(60);
  });

  test('an unparseable duration falls back to the default', () => {
    expect(timeoutSeconds(Number.NaN)).toBe(DEFAULT_TIMEOUT_MINUTES * 60);
  });

  test('rounds a fractional minute to a whole second', () => {
    expect(timeoutSeconds(1.5)).toBe(90);
    expect(timeoutSeconds(0.017)).toBe(60);
  });
});
