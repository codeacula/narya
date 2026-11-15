import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from './icons';

const render = (name: string) => renderToStaticMarkup(React.createElement(Icon, { name }));

/** Every `name="…"` literal passed to <Icon> anywhere in the client source. */
function iconNamesUsed(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const name of iconNamesUsed(path)) names.add(name);
    } else if (entry.name.endsWith('.tsx')) {
      for (const match of readFileSync(path, 'utf8').matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g)) names.add(match[1]!);
    }
  }
  return names;
}

describe('Icon', () => {
  test('the speaker glyphs for the media mute exist and draw something', () => {
    for (const name of ['speaker', 'speaker-off']) expect(render(name)).toContain('<path');
  });

  test('an unknown name renders an empty svg, so every literal name in use must be known', () => {
    expect(render('no-such-icon')).not.toContain('<path');
    const used = iconNamesUsed(join(import.meta.dir, '..'));
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter(name => !/<(path|circle|rect|line|polyline|polygon)\b/.test(render(name)));
    expect(missing).toEqual([]);
  });
});
