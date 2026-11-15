import { describe, expect, test } from 'bun:test';
import { asSentence, listFace, neverLoaded, pickerConfirmedEmpty } from './listState';

describe('listFace', () => {
  test('a failed load with nothing on screen is unavailable, never empty', () => {
    expect(listFace({ loading: false, loadFailed: true, count: 0 })).toBe('unavailable');
  });

  test('only a successful load with no rows is empty', () => {
    expect(listFace({ loading: false, loadFailed: false, count: 0 })).toBe('empty');
  });

  test('loading wins, as it did before', () => {
    expect(listFace({ loading: true, loadFailed: false, count: 0 })).toBe('loading');
    expect(listFace({ loading: true, loadFailed: false, count: 3 })).toBe('loading');
    expect(listFace({ loading: true, loadFailed: true, count: 3 })).toBe('loading');
  });

  test('a retry in flight keeps the unavailable face, so its Retry button stays mounted', () => {
    // Swapping to "loading" unmounted the button the operator had just pressed and
    // dropped keyboard focus to the page body.
    expect(listFace({ loading: true, loadFailed: true, count: 0 })).toBe('unavailable');
  });

  test('rows on screen still show after a later load failed', () => {
    expect(listFace({ loading: false, loadFailed: true, count: 2 })).toBe('items');
  });
});

describe('pickerConfirmedEmpty', () => {
  test('[] means "none" only once the list has loaded', () => {
    expect(pickerConfirmedEmpty({ status: 'loaded' }, 0)).toBe(true);
    expect(pickerConfirmedEmpty({ status: 'loading' }, 0)).toBe(false);
    expect(pickerConfirmedEmpty({ status: 'failed', error: 'Twitch login is required.' }, 0)).toBe(false);
    expect(pickerConfirmedEmpty({ status: 'loaded' }, 2)).toBe(false);
  });
});

describe('neverLoaded', () => {
  test('a refreshed list that never loaded and last failed', () => {
    expect(neverLoaded({ lastSuccessAt: null, consecutiveFailures: 1 })).toBe(true);
  });

  test('not before the first attempt, and not once anything loaded', () => {
    expect(neverLoaded({ lastSuccessAt: null, consecutiveFailures: 0 })).toBe(false);
    // Loaded once, then failing: that is stale (StaleNotice), not never-loaded.
    expect(neverLoaded({ lastSuccessAt: 1_000, consecutiveFailures: 3 })).toBe(false);
  });
});

describe('asSentence', () => {
  test('adds a full stop only when one is missing', () => {
    expect(asSentence('Twitch login is required')).toBe('Twitch login is required.');
    expect(asSentence('Twitch login is required.')).toBe('Twitch login is required.');
    expect(asSentence('  Not found!  ')).toBe('Not found!');
    expect(asSentence('')).toBe('');
  });
});
