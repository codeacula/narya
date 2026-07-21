import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard against `var(--x)` references to tokens that are defined nowhere.
 *
 * An unresolvable `var()` with no fallback drops its whole declaration silently
 * (this shipped once as `background: var(--bg-0)` on the viewer popout, which
 * rendered transparent), and one *with* a stale fallback renders an off-brand
 * value that no token owns (`var(--warning, #ffc46b)`). Neither errors, neither
 * logs, and neither shows up in a typecheck — so the only place to catch them is
 * a test that resolves every reference against the real definition set.
 *
 * The token closure is deliberately wider than the three stylesheets: components
 * inject CSS from JS, and some tokens are *set* from JS (an inline style writes
 * `--orb`, a keyframe reads it). Both the definitions and the references have to
 * be gathered from `.tsx`/`.ts` as well, or this guard reproduces the exact
 * blind spot it exists to close.
 */

const CLIENT = join(import.meta.dir);
const CSS_FILES = [
  join(CLIENT, 'styles/tokens.css'),
  join(CLIENT, 'styles/panel.css'),
  join(CLIENT, 'styles.css'),
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every `.ts`/`.tsx` under src/client, recursively — excluding test files. A
 * test names tokens as string literals (`'--past'`) and in prose (`var(--bg-0)`
 * in this file's own docstring); scanning them would register those as real
 * definitions and references and defeat the guard.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Custom-property DEFINITIONS in a stylesheet. Only declarations inside a `{}`
 * block count — a brace-depth scan is what keeps `.msg--past:hover` (a selector)
 * from being misread as a definition of `--past`, the false positive that a
 * naive `--x:` grep produces on this codebase's BEM class names.
 */
function cssDefinitions(css: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let inBlock = '';
  for (const char of stripComments(css)) {
    if (char === '{') { depth++; continue; }
    if (char === '}') { depth--; inBlock = ''; continue; }
    if (depth > 0) inBlock += char;
    if (char === ';') {
      const match = inBlock.match(/(--[a-z0-9-]+)\s*:/i);
      if (match) out.add(match[1]);
      inBlock = '';
    }
  }
  return out;
}

/** `var(--x` occurrences — the reference side. Fallbacks don't define anything. */
function varReferences(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) out.add(match[1]);
  return out;
}

/**
 * Tokens WRITTEN from JS — inline style object keys (`'--orb':`,
 * `['--reward-color' as string]:`) and `setProperty('--x', …)`. These are real
 * definitions; a stylesheet reads them back.
 */
function jsDefinitions(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(/['"`]\s*(--[a-z0-9-]+)\s*['"`]/g)) out.add(match[1]);
  for (const match of source.matchAll(/setProperty\(\s*['"`]\s*(--[a-z0-9-]+)/g)) out.add(match[1]);
  return out;
}

const cssText = CSS_FILES.map(f => readFileSync(f, 'utf8'));
const sources = sourceFiles(CLIENT).map(f => readFileSync(f, 'utf8'));

const defined = new Set<string>();
for (const css of cssText) for (const token of cssDefinitions(css)) defined.add(token);
for (const src of sources) for (const token of jsDefinitions(src)) defined.add(token);

const referenced = new Set<string>();
for (const css of cssText) for (const token of varReferences(css)) referenced.add(token);
for (const src of sources) for (const token of varReferences(src)) referenced.add(token);

// The detector has been wrong on this codebase before; prove it works against
// answers known by hand BEFORE trusting its verdict on the real files.
describe('token-reference detector self-check', () => {
  test('resolves aliased and scoped definitions', () => {
    expect(defined.has('--accent-fg')).toBe(true);   // panel.css :root, once mis-reported missing
    expect(defined.has('--fg-3')).toBe(true);
    expect(defined.has('--warning-fg')).toBe(true);
    expect(defined.has('--overlay-text-accent')).toBe(true); // defined only in scoped, non-:root blocks
  });

  test('counts JS-set tokens as defined', () => {
    for (const token of ['--orb', '--reward-color', '--clip-aspect', '--clip-width-from-height']) {
      expect(defined.has(token)).toBe(true);
    }
  });

  test('does not mistake a BEM pseudo-selector for a definition', () => {
    // `.msg--past:hover {` must not register `--past` as a token.
    for (const ghost of ['--past', '--ok', '--toggle', '--live', '--mention']) {
      expect(defined.has(ghost)).toBe(false);
    }
  });

  test('a synthetic dangling reference would be caught', () => {
    // Guards the guard: if this set operation were inverted, the real test below
    // would pass vacuously.
    const fakeReferenced = new Set(referenced);
    fakeReferenced.add('--totally-undefined-xyz');
    const dangling = [...fakeReferenced].filter(t => !defined.has(t));
    expect(dangling).toContain('--totally-undefined-xyz');
  });
});

describe('every var(--x) resolves to a definition', () => {
  test('no reference points at an undefined token', () => {
    const dangling = [...referenced].filter(token => !defined.has(token)).sort();
    expect(dangling).toEqual([]);
  });
});
