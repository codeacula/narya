import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A minted app token exists in exactly ONE place: the resolved value of the mint
 * call. The server has already rotated `apps.token_hash` by the time that promise
 * settles, so the app's previous token is dead the moment the request lands — and
 * the plaintext is never stored, never re-fetchable, and deliberately never
 * persisted client-side.
 *
 * That makes the reveal the only thing in the mint handler that must not be
 * skippable. Refreshing the apps list afterwards is cosmetic (it re-reads
 * `tokenConfigured` and the reward count); if the reveal is sequenced *after* an
 * awaited refresh, one failed reload — a backend blip, an expired dashboard token —
 * discards the new token forever while the UI reports that nothing happened. The
 * operator then has a live app whose every `/api/ext/*` call 401s and no credential
 * that can fix it.
 *
 * There is no React test harness in this repo (no testing-library, no DOM), so this
 * two-statement ordering is guarded at the source level, the same way
 * `src/client/tokenReferences.test.ts` guards an invariant that typecheck cannot
 * see. A refactor that moves the code will fail here loudly rather than silently
 * reintroducing the strand.
 */

const SOURCE = readFileSync(join(import.meta.dir, 'AppsPage.tsx'), 'utf8');

/** The `handleMint` handler's text, bounded by the next handler declared after it. */
function handleMintBody(): string {
  const start = SOURCE.indexOf('const handleMint');
  const end = SOURCE.indexOf('const handleRevoke');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('AppsPage mint handler', () => {
  test('reveals the minted token before it refreshes the apps list', () => {
    const body = handleMintBody();
    const reveal = body.indexOf('setRevealed(result.token)');
    const reload = body.indexOf('onChanged()');
    expect(reveal).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(-1);
    expect(reveal).toBeLessThan(reload);
  });

  test('does not gate the reveal behind anything awaited', () => {
    const body = handleMintBody();
    const beforeReveal = body.slice(0, body.indexOf('setRevealed(result.token)'));
    expect(beforeReveal).not.toContain('await ');
  });
});
