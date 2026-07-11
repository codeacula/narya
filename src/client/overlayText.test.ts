import { describe, expect, test } from 'bun:test';
import type { OverlayTextPlayback } from '../shared/api';
import { advanceOverlayText, enqueueOverlayText, MAX_OVERLAY_TEXT_QUEUE } from './overlayText';

function item(id: string): OverlayTextPlayback {
  return { id, text: `text ${id}`, durationMs: 5000, style: 'banner' };
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

describe('enqueueOverlayText', () => {
  test('appends in arrival order', () => {
    const queue = [item('a'), item('b')].reduce(enqueueOverlayText, [] as OverlayTextPlayback[]);
    expect(queue.map(entry => entry.id)).toEqual(['a', 'b']);
  });

  test('ignores an id that is already queued, so a replayed socket event cannot double-show', () => {
    const queue = [item('a'), item('a')].reduce(enqueueOverlayText, [] as OverlayTextPlayback[]);
    expect(queue.map(entry => entry.id)).toEqual(['a']);
  });

  test('drops overflow past the cap rather than growing without bound', () => {
    const full = Array.from({ length: MAX_OVERLAY_TEXT_QUEUE }, (_, index) => item(`a${index}`))
      .reduce(enqueueOverlayText, [] as OverlayTextPlayback[]);
    const warnings = captureWarnings(() => {
      const overflowed = enqueueOverlayText(full, item('overflow'));
      expect(overflowed).toHaveLength(MAX_OVERLAY_TEXT_QUEUE);
      expect(overflowed.some(entry => entry.id === 'overflow')).toBe(false);
    });
    expect(warnings.join(' ')).toContain('queue is full');
  });
});

describe('advanceOverlayText', () => {
  test('drops the head', () => {
    const queue = [item('a'), item('b')];
    expect(advanceOverlayText(queue, 'a').map(entry => entry.id)).toEqual(['b']);
  });

  test('ignores a completion for an item that is no longer the head', () => {
    const queue = [item('a'), item('b')];
    expect(advanceOverlayText(queue, 'b')).toBe(queue);
  });
});
