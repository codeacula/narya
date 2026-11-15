import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState, emptyStateClass } from './emptyState';

const render = (props: React.ComponentProps<typeof EmptyState>) =>
  renderToStaticMarkup(React.createElement(EmptyState, props));

describe('EmptyState', () => {
  test('each size has its own class, and compact keeps the base class', () => {
    expect(emptyStateClass('panel')).toBe('empty-state');
    expect(emptyStateClass('pane')).toBe('split-empty');
    expect(emptyStateClass('compact')).toBe('empty-state empty-state--compact');
  });

  test('panel and pane show the orb by default; compact does not', () => {
    expect(render({ title: 'Nothing held' })).toContain('crystal-orb');
    expect(render({ title: 'Nothing held', size: 'pane' })).toContain('crystal-orb');
    expect(render({ title: 'No sounds yet', size: 'compact' })).not.toContain('crystal-orb');
  });

  test('an explicit orb prop wins over the size default', () => {
    expect(render({ title: 'x', size: 'compact', orb: true })).toContain('crystal-orb');
    expect(render({ title: 'x', orb: false })).not.toContain('crystal-orb');
  });

  test('the sentence renders only when given', () => {
    expect(render({ title: 'Loading…', size: 'compact' })).not.toContain('es-sub');
    expect(render({ title: 'No clips yet', size: 'compact', children: 'Add clip buttons in Settings → Content.' }))
      .toContain('<div class="es-sub">Add clip buttons in Settings → Content.</div>');
  });
});
