import { describe, expect, test } from 'bun:test';
import { belongsToCurrentSession } from './panels';

describe('belongsToCurrentSession', () => {
  test('a row from the live session is current', () => {
    expect(belongsToCurrentSession('live', 'live')).toBe(true);
  });

  test('a row from an earlier session is past', () => {
    expect(belongsToCurrentSession('old', 'live')).toBe(false);
  });

  test('a row recorded off-stream is past', () => {
    expect(belongsToCurrentSession(null, 'live')).toBe(false);
    expect(belongsToCurrentSession(undefined, 'live')).toBe(false);
  });

  test('with no stream live, nothing is current', () => {
    expect(belongsToCurrentSession('live', null)).toBe(false);
    expect(belongsToCurrentSession(null, null)).toBe(false);
  });
});
