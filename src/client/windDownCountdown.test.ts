import { describe, expect, test } from 'bun:test';
import { formatWindDownCountdown } from './windDownCountdown';

describe('formatWindDownCountdown', () => {
  test('reads in whole minutes', () => {
    expect(formatWindDownCountdown(25 * 60_000)).toBe('~25 min left');
    expect(formatWindDownCountdown(2 * 60_000)).toBe('~2 min left');
  });

  test('rounds up so it never reads a minute short', () => {
    expect(formatWindDownCountdown(90_000)).toBe('~2 min left');
  });

  test('the last minute reads in seconds', () => {
    expect(formatWindDownCountdown(45_000)).toBe('~45 sec left');
    expect(formatWindDownCountdown(5_000)).toBe('~5 sec left');
  });

  test('at or past zero it stops counting', () => {
    expect(formatWindDownCountdown(0)).toBe('ending soon');
    expect(formatWindDownCountdown(-60_000)).toBe('ending soon');
  });

  test('an hour or more reads in hours and minutes', () => {
    expect(formatWindDownCountdown(90 * 60_000)).toBe('~1h 30m left');
    expect(formatWindDownCountdown(60 * 60_000)).toBe('~1h 0m left');
  });
});
