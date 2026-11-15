import { describe, expect, test } from 'bun:test';
import { createSettingsEchoFilter } from './settingsEcho';

describe('createSettingsEchoFilter', () => {
  test('a broadcast landing while this window saves is its own echo', async () => {
    const filter = createSettingsEchoFilter();
    let finish: (value: { updatedAt: string }) => void = () => undefined;
    const save = filter.track(new Promise<{ updatedAt: string }>(resolve => { finish = resolve; }));
    expect(filter.isOwnEcho('2026-11-14T10:00:00.000Z')).toBe(true);
    finish({ updatedAt: '2026-11-14T10:00:00.000Z' });
    await save;
  });

  test('a broadcast landing after the response is recognised by its stamp', async () => {
    const filter = createSettingsEchoFilter();
    await filter.track(Promise.resolve({ updatedAt: 'stamp-a' }));
    expect(filter.isOwnEcho('stamp-a')).toBe(true);
  });

  test('a save made elsewhere is not an echo', async () => {
    const filter = createSettingsEchoFilter();
    expect(filter.isOwnEcho('stamp-b')).toBe(false);
    await filter.track(Promise.resolve({ updatedAt: 'stamp-a' }));
    expect(filter.isOwnEcho('stamp-b')).toBe(false);
  });

  test('a failed save stops counting as in flight', async () => {
    const filter = createSettingsEchoFilter();
    await filter.track(Promise.reject(new Error('boom'))).catch(() => undefined);
    expect(filter.isOwnEcho('stamp-c')).toBe(false);
  });
});
