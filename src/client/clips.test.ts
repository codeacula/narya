import { describe, expect, test } from 'bun:test';
import type { MediaPlayback } from '../shared/api';
import { advance, enqueue, videoAspectRatio } from './clips';

function item(id: string): MediaPlayback {
  return { id, kind: 'video', src: `/clips/${id}.mp4`, volume: 0.8 };
}

/** Runs `body` with console.warn swallowed, returning what it would have printed. */
function captureWarnings(body: () => void): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    body();
  } finally {
    console.warn = original;
  }
  return warnings;
}

describe('videoAspectRatio', () => {
  test('preserves portrait, landscape, and square metadata', () => {
    expect(videoAspectRatio(576, 1024)).toBeCloseTo(9 / 16);
    expect(videoAspectRatio(1280, 720)).toBeCloseTo(16 / 9);
    expect(videoAspectRatio(800, 800)).toBe(1);
  });

  test('falls back to landscape when metadata is invalid', () => {
    expect(videoAspectRatio(0, 720)).toBeCloseTo(16 / 9);
    expect(videoAspectRatio(1280, Number.NaN)).toBeCloseTo(16 / 9);
  });
});

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
    const warnings = captureWarnings(() => {
      let queue: MediaPlayback[] = [];
      for (let i = 0; i < 40; i++) queue = enqueue(queue, item(`clip-${i}`));
      expect(queue).toHaveLength(20);
      expect(queue[0]?.id).toBe('clip-0');
    });
    expect(warnings).toHaveLength(20);
  });

  // The viewer already spent their points, so a drop the operator can't see reads
  // as a broken clip.
  test('says so when it drops a redeem', () => {
    const full = Array.from({ length: 20 }, (_, i) => item(`clip-${i}`));
    const warnings = captureWarnings(() => {
      expect(enqueue(full, { ...item('late'), actor: 'Sorlus' })).toHaveLength(20);
    });
    expect(warnings[0]).toContain('/clips/late.mp4');
    expect(warnings[0]).toContain('Sorlus');
  });
});

describe('advance', () => {
  test('drops the head so the next clip plays', () => {
    expect(advance([item('a'), item('b')], 'a').map(q => q.id)).toEqual(['b']);
  });

  test('advancing an empty queue stays empty', () => {
    expect(advance([], 'a')).toEqual([]);
  });

  // A clip that errors or is blocked by autoplay policy must not wedge the queue.
  test('advancing past a failed head still reaches the tail', () => {
    expect(advance([item('bad'), item('good')], 'bad')[0]?.id).toBe('good');
  });

  // A bad file can both reject play() and fire the element's error event. Both
  // call onFinished; the second must not drop the clip queued behind it.
  test('a second completion for the same item is a no-op', () => {
    const queue = advance([item('bad'), item('good')], 'bad');
    expect(advance(queue, 'bad').map(q => q.id)).toEqual(['good']);
  });

  test('a completion for an item that is not the head is ignored', () => {
    expect(advance([item('a'), item('b')], 'b').map(q => q.id)).toEqual(['a', 'b']);
  });
});
