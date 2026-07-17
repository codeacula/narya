import { describe, expect, test } from 'bun:test';
import { shoutoutVerb } from './shoutouts';

describe('shoutoutVerb', () => {
  test('maps a single kind to its verb', () => {
    expect(shoutoutVerb(['follow'])).toBe('followed');
    expect(shoutoutVerb(['raid'])).toBe('raided');
  });

  test('joins two kinds with an ampersand', () => {
    expect(shoutoutVerb(['sub', 'cheer'])).toBe('subscribed & cheered');
  });

  test('comma-separates three or more kinds', () => {
    expect(shoutoutVerb(['follow', 'sub', 'cheer'])).toBe('followed, subscribed & cheered');
  });

  test('falls back to the raw kind when unmapped', () => {
    expect(shoutoutVerb(['mystery'])).toBe('mystery');
  });

  test('returns an empty string for no kinds', () => {
    expect(shoutoutVerb([])).toBe('');
  });
});
