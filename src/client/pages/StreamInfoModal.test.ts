import { describe, expect, test } from 'bun:test';
import { categoryPlaceholder } from './StreamInfoModal';

describe('categoryPlaceholder', () => {
  // The bug: a failed load set the list to [] and the select said there were none.
  test('a failed load of saved categories is not "no saved categories"', () => {
    expect(categoryPlaceholder({ status: 'failed', error: 'boom' }, 0)).toBe('Saved categories unavailable — use Add');
  });

  test('a load in flight says so', () => {
    expect(categoryPlaceholder({ status: 'loading' }, 0)).toBe('Loading saved categories…');
  });

  test('only a load that worked and came back empty is "none"', () => {
    expect(categoryPlaceholder({ status: 'loaded' }, 0)).toBe('No saved categories — use Add');
  });

  test('with options to pick from, it asks for a pick', () => {
    expect(categoryPlaceholder({ status: 'loaded' }, 2)).toBe('Select a category…');
    expect(categoryPlaceholder({ status: 'failed', error: 'boom' }, 1)).toBe('Select a category…');
  });
});
