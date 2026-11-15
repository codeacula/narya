import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../icons';
import { ROLE_BADGE, ROLE_BADGE_LABEL } from './badges';

describe('role badges', () => {
  test('every role badge is a line icon that draws, not a text glyph', () => {
    for (const [role, name] of Object.entries(ROLE_BADGE)) {
      const svg = renderToStaticMarkup(React.createElement(Icon, { name }));
      expect({ role, draws: /<(path|circle|rect|ellipse)\b/.test(svg) }).toEqual({ role, draws: true });
    }
  });

  test('every role badge has a spoken name', () => {
    for (const role of Object.keys(ROLE_BADGE)) expect(ROLE_BADGE_LABEL[role]?.length ?? 0).toBeGreaterThan(0);
  });
});
