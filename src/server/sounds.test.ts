import { describe, expect, test } from 'bun:test';
import { DEFAULT_QUACK_SOUNDS, defaultSoundButtonsToSeed } from './sounds';

describe('defaultSoundButtonsToSeed', () => {
  test('seeds nothing when none of the default files exist (a bare clone)', () => {
    expect(defaultSoundButtonsToSeed(() => false)).toEqual([]);
  });

  test('seeds every default when all files exist', () => {
    const seeded = defaultSoundButtonsToSeed(() => true);
    expect(seeded.map(s => s.filename)).toEqual(DEFAULT_QUACK_SOUNDS);
  });

  test('seeds only the defaults whose file exists, keeping their original ids', () => {
    const present = new Set([DEFAULT_QUACK_SOUNDS[1]]);
    const seeded = defaultSoundButtonsToSeed(src => present.has(src));
    expect(seeded).toEqual([{ id: 'quack-2', label: 'Quack 2', filename: DEFAULT_QUACK_SOUNDS[1] }]);
  });
});
