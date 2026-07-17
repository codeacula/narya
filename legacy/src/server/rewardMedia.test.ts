import { describe, expect, test } from 'bun:test';
import { playMedia } from './rewardMedia';

describe('playMedia', () => {
  test('broadcasts the resolved media with a fresh id per play', () => {
    const first = playMedia({ kind: 'audio', src: '/sounds/a.mp3', volume: 0.4 }, 'Sorlus');
    const second = playMedia({ kind: 'audio', src: '/sounds/a.mp3', volume: 0.4 }, 'Sorlus');

    expect(first).toMatchObject({ kind: 'audio', src: '/sounds/a.mp3', volume: 0.4, actor: 'Sorlus' });
    // The overlay deduplicates on id, so two plays of the same file must not collide.
    expect(first.id).not.toBe(second.id);
  });

  test('omits actor when there is none', () => {
    expect(playMedia({ kind: 'video', src: '/clips/b.mp4', volume: 1 })).not.toHaveProperty('actor');
  });
});
