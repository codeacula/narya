import { describe, expect, test } from 'bun:test';
import { headerCountParts } from './headerCounts';

describe('headerCountParts', () => {
  test('uses the singular noun for exactly one', () => {
    expect(headerCountParts([{ value: 1, one: 'counter' }])).toEqual([{ value: 1, label: 'counter' }]);
  });

  test('pluralizes zero and many with a trailing s by default', () => {
    expect(headerCountParts([{ value: 0, one: 'quote' }])).toEqual([{ value: 0, label: 'quotes' }]);
    expect(headerCountParts([{ value: 7, one: 'quote' }])).toEqual([{ value: 7, label: 'quotes' }]);
  });

  test('an explicit plural wins over the default', () => {
    expect(headerCountParts([{ value: 2, one: 'app registered', other: 'apps registered' }]))
      .toEqual([{ value: 2, label: 'apps registered' }]);
    // Words that do not change in the plural ("saved") pass the same noun twice.
    expect(headerCountParts([{ value: 4, one: 'saved', other: 'saved' }])).toEqual([{ value: 4, label: 'saved' }]);
  });

  test('drops a zero count only when it asks to be hidden', () => {
    const counts = [
      { value: 0, one: 'saved', other: 'saved' },
      { value: 0, one: 'hidden', other: 'hidden', hideWhenZero: true },
    ];
    expect(headerCountParts(counts)).toEqual([{ value: 0, label: 'saved' }]);
    expect(headerCountParts([{ value: 3, one: 'hidden', other: 'hidden', hideWhenZero: true }]))
      .toEqual([{ value: 3, label: 'hidden' }]);
  });

  test('keeps the order it was given', () => {
    expect(headerCountParts([
      { value: 2, one: 'saved', other: 'saved' },
      { value: 1, one: 'hidden', other: 'hidden' },
    ]).map(part => part.label)).toEqual(['saved', 'hidden']);
  });
});
