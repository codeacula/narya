import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from './emptyState';
import { emptyStateLayout } from './emptyStateLogic';

const render = (props: React.ComponentProps<typeof EmptyState>) =>
  renderToStaticMarkup(React.createElement(EmptyState, props));

describe('EmptyState', () => {
  test('the note size has its own class and keeps the base class', () => {
    expect(emptyStateLayout('note').className).toBe('empty-state empty-state--note');
  });

  test('panel, pane and compact show the orb by default; note does not', () => {
    expect(render({ title: 'Nothing held' })).toContain('crystal-orb');
    expect(render({ title: 'Nothing held', size: 'pane' })).toContain('crystal-orb');
    expect(render({ title: 'No actions yet', size: 'compact' })).toContain('crystal-orb');
    expect(render({ title: 'No sounds yet', size: 'note' })).not.toContain('crystal-orb');
  });

  test('an explicit orb prop wins over the size default', () => {
    expect(render({ title: 'x', size: 'note', orb: true })).toContain('crystal-orb');
    expect(render({ title: 'x', orb: false })).not.toContain('crystal-orb');
  });

  test('the sentence renders only when given', () => {
    expect(render({ title: 'Loading…', size: 'note' })).not.toContain('es-sub');
    expect(render({ title: 'No clips yet', size: 'note', children: 'Add clip buttons in Settings → Content.' }))
      .toContain('<div class="es-sub">Add clip buttons in Settings → Content.</div>');
  });
});
