import { describe, expect, test } from 'bun:test';
import { emptyStateLayout } from './emptyStateLogic';

describe('emptyStateLayout', () => {
  test('panel and pane keep the classes the dashboard and split editors already style', () => {
    expect(emptyStateLayout('panel')).toEqual({ className: 'empty-state', orbSize: 40 });
    expect(emptyStateLayout('pane')).toEqual({ className: 'split-empty', orbSize: 40 });
  });

  test('compact is a modifier on the panel state, with a smaller orb', () => {
    const compact = emptyStateLayout('compact');
    expect(compact.className.split(' ')).toEqual(['empty-state', 'empty-state--compact']);
    expect(compact.orbSize).toBeLessThan(emptyStateLayout('panel').orbSize);
  });
});
