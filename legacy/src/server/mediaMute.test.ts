import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Bind the module under test to a broadcast spy (static imports are hoisted, so the
// module is imported dynamically below, after the mock is installed).
const emitted: Array<{ event: string; payload: unknown }> = [];
const realtime = await import('./realtime');
mock.module('./realtime', () => ({
  ...realtime,
  broadcast: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
}));

const { getMediaMuted, setMediaMuted } = await import('./mediaMute');
const { db } = await import('./db');

beforeEach(() => {
  db.exec('delete from media_mute');
  emitted.length = 0;
});

describe('media mute store', () => {
  test('defaults to false when no row exists', () => {
    expect(getMediaMuted()).toBe(false);
  });

  test('persists mute on and off', () => {
    expect(setMediaMuted(true)).toEqual({ muted: true });
    expect(getMediaMuted()).toBe(true);
    expect(setMediaMuted(false)).toEqual({ muted: false });
    expect(getMediaMuted()).toBe(false);
  });

  test('broadcasts media:mute on every change', () => {
    setMediaMuted(true);
    expect(emitted).toEqual([{ event: 'media:mute', payload: { muted: true } }]);
  });
});
