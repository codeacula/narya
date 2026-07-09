import { describe, expect, test } from 'bun:test';
import type { MediaPlayback } from '../shared/api';
import { advance, enqueue } from './clips';

function item(id: string): MediaPlayback {
  return { id, kind: 'video', src: `/clips/${id}.mp4`, volume: 0.8 };
}

describe('enqueue', () => {
  test('appends in arrival order so nobody\'s redeem jumps the line', () => {
    const queue = [item('a'), item('b')].reduce(enqueue, [] as MediaPlayback[]);
    expect(queue.map(q => q.id)).toEqual(['a', 'b']);
  });

  test('ignores a duplicate id, so a replayed socket event does not double-play', () => {
    const queue = enqueue([item('a')], item('a'));
    expect(queue.map(q => q.id)).toEqual(['a']);
  });

  test('caps the queue so a redeem storm cannot grow it without bound', () => {
    let queue: MediaPlayback[] = [];
    for (let i = 0; i < 40; i++) queue = enqueue(queue, item(`clip-${i}`));
    expect(queue).toHaveLength(20);
    expect(queue[0]?.id).toBe('clip-0');
  });
});

describe('advance', () => {
  test('drops the head so the next clip plays', () => {
    expect(advance([item('a'), item('b')]).map(q => q.id)).toEqual(['b']);
  });

  test('advancing an empty queue stays empty', () => {
    expect(advance([])).toEqual([]);
  });

  // A clip that errors or is blocked by autoplay policy must not wedge the queue.
  test('advancing past a failed head still reaches the tail', () => {
    let queue = [item('bad'), item('good')];
    queue = advance(queue);
    expect(queue[0]?.id).toBe('good');
  });
});
