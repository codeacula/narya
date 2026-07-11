import { describe, expect, test } from 'bun:test';
import type { AlertPlayback } from '../shared/api';
import { advanceAlert, enqueueAlert, MAX_ALERT_QUEUE } from './alerts';

function item(id: string): AlertPlayback {
  return { id, kind: 'sub', text: `alert ${id}`, tone: 'warning', sound: null, clip: null, durationMs: 6000 };
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

describe('enqueueAlert', () => {
  test('appends in arrival order', () => {
    const queue = [item('a'), item('b')].reduce(enqueueAlert, [] as AlertPlayback[]);
    expect(queue.map(q => q.id)).toEqual(['a', 'b']);
  });

  test('ignores a duplicate id so a replayed socket event does not double-play', () => {
    const queue = enqueueAlert([item('a')], item('a'));
    expect(queue.map(q => q.id)).toEqual(['a']);
  });

  test('caps the queue so an event storm cannot grow it without bound', () => {
    const warnings = captureWarnings(() => {
      let queue: AlertPlayback[] = [];
      for (let i = 0; i < MAX_ALERT_QUEUE + 20; i++) queue = enqueueAlert(queue, item(`alert-${i}`));
      expect(queue).toHaveLength(MAX_ALERT_QUEUE);
      expect(queue[0]?.id).toBe('alert-0');
    });
    expect(warnings).toHaveLength(20);
  });

  test('says which alert it dropped', () => {
    const full = Array.from({ length: MAX_ALERT_QUEUE }, (_, i) => item(`alert-${i}`));
    const warnings = captureWarnings(() => {
      expect(enqueueAlert(full, item('late'))).toHaveLength(MAX_ALERT_QUEUE);
    });
    expect(warnings[0]).toContain('alert late');
  });
});

describe('advanceAlert', () => {
  test('drops the head so the next alert plays', () => {
    expect(advanceAlert([item('a'), item('b')], 'a').map(q => q.id)).toEqual(['b']);
  });

  test('advancing an empty queue stays empty', () => {
    expect(advanceAlert([], 'a')).toEqual([]);
  });

  // A clip that errors and its duration timer both call onFinished; the second
  // completion must not drop the alert queued behind it.
  test('a second completion for the same item is a no-op', () => {
    const queue = advanceAlert([item('bad'), item('good')], 'bad');
    expect(advanceAlert(queue, 'bad').map(q => q.id)).toEqual(['good']);
  });

  test('a completion for an item that is not the head is ignored', () => {
    expect(advanceAlert([item('a'), item('b')], 'b').map(q => q.id)).toEqual(['a', 'b']);
  });
});
