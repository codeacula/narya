import { expect, test } from 'bun:test';
import { overflowBelow, overflowLabel, type ListRow } from './attentionOverflow';

// Five 68px rows, the shape the dashboard's attention list measured at 1600x1000.
function rows(unacked: boolean[] = [true, true, true, true, true]): ListRow[] {
  return unacked.map((flag, index) => ({ top: index * 68, bottom: (index + 1) * 68, unacked: flag }));
}

test('nothing is below when every row fits', () => {
  expect(overflowBelow(rows(), { scrollTop: 0, clientHeight: 400 }).count).toBe(0);
  expect(overflowBelow(rows(), { scrollTop: 0, clientHeight: 400 }).scrollTarget).toBeNull();
});

test('a row cut by the bottom edge counts as below, along with everything after it', () => {
  // 281px viewport: rows 0-3 end at 272, row 4 (272-340) is cut.
  const result = overflowBelow(rows(), { scrollTop: 0, clientHeight: 281 });
  expect(result.count).toBe(1);
  expect(result.scrollTarget).toBe(272);

  const shorter = overflowBelow(rows(), { scrollTop: 0, clientHeight: 150 });
  expect(shorter.count).toBe(3);
  expect(shorter.scrollTarget).toBe(136);
});

test('scrolling to the end clears the cue', () => {
  const result = overflowBelow(rows(), { scrollTop: 59, clientHeight: 281 });
  expect(result.count).toBe(0);
});

test('a sub-pixel overhang on the last row is not "1 more"', () => {
  expect(overflowBelow(rows(), { scrollTop: 0, clientHeight: 339.5 }).count).toBe(0);
});

test('unacked rows below are counted separately from acked ones', () => {
  const result = overflowBelow(rows([true, true, false, true, false]), { scrollTop: 0, clientHeight: 140 });
  expect(result.count).toBe(3);
  expect(result.unacked).toBe(1);
});

test('a row taller than the viewport pages down instead of scrolling backwards', () => {
  const tall: ListRow[] = [{ top: 0, bottom: 600, unacked: true }];
  const result = overflowBelow(tall, { scrollTop: 100, clientHeight: 200 });
  expect(result.count).toBe(1);
  expect(result.scrollTarget).toBe(300);
});

test('the label names the new ones only when there are some', () => {
  expect(overflowLabel({ count: 3, unacked: 0, scrollTarget: 0 })).toBe('3 more below');
  expect(overflowLabel({ count: 3, unacked: 2, scrollTarget: 0 })).toBe('3 more below · 2 new');
});
