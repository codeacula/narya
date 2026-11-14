import { afterEach, expect, mock, test } from 'bun:test';

// Bind the module under test to a broadcast spy (static imports are hoisted, so the
// modules are imported dynamically below, after the mock is installed).
const emitted: Array<{ event: string; payload: unknown }> = [];
const realtime = await import('../realtime');
mock.module('../realtime', () => ({
  ...realtime,
  broadcast: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
}));

const { saveAppConfig, reloadAppConfig } = await import('../appConfig');
const { RuntimeState } = await import('../runtime');
const { resetTwitchIdentityCache } = await import('../twitchIdentity');
const { runTwitchCommercial } = await import('./api');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The overlay banner only learns of a break from this broadcast, and Twitch's
// channel.ad_break.begin does not fire for a commercial this app started, so a manual
// commercial must send it itself.
test('a manual commercial broadcasts overlay:ad-break with the end time', async () => {
  resetTwitchIdentityCache();
  saveAppConfig({ twitchChannel: 'tester', twitchClientId: 'cid', twitchClientSecret: 'secret' });
  reloadAppConfig();
  const state = new RuntimeState();
  state.runtimeUserToken = { accessToken: 'a', refreshToken: 'r', scopes: ['channel:edit:commercial'], tokenType: 'bearer', expiresAtMs: null };
  state.broadcasterId = 'bid';
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/helix/channels/commercial') {
      return new Response(JSON.stringify({ data: [{ length: 120 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected fetch in test: ' + url.href);
  }) as typeof globalThis.fetch;
  emitted.length = 0;

  const result = await runTwitchCommercial(state);

  expect(emitted.filter(e => e.event === 'overlay:ad-break')).toEqual([
    { event: 'overlay:ad-break', payload: { endsAt: result.adBreakEndsAt } },
  ]);
});
