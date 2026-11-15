import { describe, expect, test } from 'bun:test';
import { suggestionFace, suggestionFailedText } from './suggestions';

describe('suggestionFace', () => {
  test('a failed search is failed, never "no matches"', () => {
    expect(suggestionFace({ loading: false, error: 'Twitch login required', count: 0 })).toBe('failed');
  });

  test('only a search that answered with nothing is none', () => {
    expect(suggestionFace({ loading: false, error: null, count: 0 })).toBe('none');
  });

  test('searching wins while a request is in flight', () => {
    expect(suggestionFace({ loading: true, error: null, count: 0 })).toBe('searching');
  });

  test('results show when the search returned some', () => {
    expect(suggestionFace({ loading: false, error: null, count: 3 })).toBe('results');
  });
});

describe('suggestionFailedText', () => {
  test('carries the reason as a sentence', () => {
    expect(suggestionFailedText('Twitch login required')).toBe('Could not search: Twitch login required.');
    expect(suggestionFailedText('Failed to fetch.')).toBe('Could not search: Failed to fetch.');
  });

  test('says something even with no reason', () => {
    expect(suggestionFailedText('  ')).toBe('Could not search.');
  });
});
