import { describe, expect, test } from 'bun:test';
import { pickMediaTargets } from './realtime';

// Stand-ins for ws sockets: only readyState and identity matter here.
const OPEN = 1;
const CLOSED = 3;
function sock(readyState = OPEN) {
  return { readyState, OPEN } as unknown as Parameters<typeof pickMediaTargets>[0][number];
}

describe('pickMediaTargets', () => {
  test('routes to the clip player alone when one is connected', () => {
    const player = sock();
    const dashboard = sock();
    expect(pickMediaTargets([dashboard, player], [player])).toEqual([player]);
  });

  test('falls back to every client when no clip player is connected', () => {
    const dashboard = sock();
    const tablet = sock();
    expect(pickMediaTargets([dashboard, tablet], [])).toEqual([dashboard, tablet]);
  });

  // A closed-but-not-yet-reaped player must not swallow the redeem.
  test('ignores a closed clip player and falls back', () => {
    const dead = sock(CLOSED);
    const dashboard = sock();
    expect(pickMediaTargets([dashboard, dead], [dead])).toEqual([dashboard]);
  });

  test('with several clip players, all of them get it and no dashboard does', () => {
    const a = sock();
    const b = sock();
    const dashboard = sock();
    expect(pickMediaTargets([dashboard, a, b], [a, b])).toEqual([a, b]);
  });

  test('no clients at all yields no targets', () => {
    expect(pickMediaTargets([], [])).toEqual([]);
  });
});
