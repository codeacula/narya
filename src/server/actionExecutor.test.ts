import { describe, expect, test } from 'bun:test';
import type { Action, ActionStep, MediaAsset, OverlayTextPlayback, RewardMedia } from '../shared/api';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import { HttpRouteError } from './http';
import { RuntimeState } from './runtime';

// A virtual clock: delays resolve in ascending order without real time passing, so
// a 10-minute delay costs a microtask instead of ten minutes.
function createClock() {
  let now = 0;
  let waiters: Array<{ at: number; resolve: () => void }> = [];

  const delay = (ms: number) => new Promise<void>((resolve) => {
    waiters.push({ at: now + Math.max(0, ms), resolve });
  });

  async function settle() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async function runAll() {
    await settle();
    while (waiters.length > 0) {
      now = Math.min(...waiters.map(waiter => waiter.at));
      const due = waiters.filter(waiter => waiter.at <= now);
      waiters = waiters.filter(waiter => waiter.at > now);
      for (const waiter of due) waiter.resolve();
      await settle();
    }
  }

  return { nowMs: () => now, delay, runAll };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    label: 'Airhorn',
    kind: 'audio',
    sourceType: 'local',
    src: '/sounds/airhorn.mp3',
    volume: 0.8,
    enabled: true,
    available: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function step(overrides: Partial<ActionStep> = {}): ActionStep {
  return {
    id: 'step-1',
    position: 0,
    enabled: true,
    delayMs: 0,
    type: 'send_chat',
    payload: { template: 'hi {actor}', sender: 'bot' },
    ...overrides,
  } as ActionStep;
}

function action(steps: ActionStep[], overrides: Partial<Action> = {}): Action {
  return {
    id: 'action-1',
    name: 'Test action',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: steps.map((s, index) => ({ ...s, id: s.id === 'step-1' ? `step-${index + 1}` : s.id, position: index })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type Harness = {
  broadcasts: Array<{ event: string; payload: unknown }>;
  played: RewardMedia[];
  chats: Array<{ message: string; sender: string }>;
  spoken: string[];
  scenes: string[];
  transitions: number;
  shoutouts: string[];
  whispers: Array<{ login: string; message: string }>;
  timeouts: Array<{ login: string; seconds: number; reason: string }>;
  bans: Array<{ login: string; reason: string }>;
};

function harness(
  target: Action | null,
  overrides: Partial<ActionExecutorDeps> = {},
  clock = createClock(),
) {
  const calls: Harness = {
    broadcasts: [], played: [], chats: [], spoken: [], scenes: [], transitions: 0,
    shoutouts: [], whispers: [], timeouts: [], bans: [],
  };

  const deps: ActionExecutorDeps = {
    state: new RuntimeState(),
    resolveMedia: () => null,
    loadAction: () => target,
    delay: clock.delay,
    newId: () => 'fixed-id',
    broadcast: (event, payload) => { calls.broadcasts.push({ event, payload }); },
    playMedia: (media) => { calls.played.push(media); },
    sendChat: async (_state, message, sender) => { calls.chats.push({ message, sender }); },
    speakText: async (text) => { calls.spoken.push(text); },
    askLlm: async () => 'llm answer',
    switchObsScene: async (sceneName) => { calls.scenes.push(sceneName); },
    triggerObsTransition: async () => { calls.transitions += 1; },
    sendShoutout: async (_state, login) => { calls.shoutouts.push(login); },
    sendWhisper: async (_state, login, message) => { calls.whispers.push({ login, message }); },
    timeoutUser: async (_state, login, seconds, reason) => { calls.timeouts.push({ login, seconds, reason }); },
    banUser: async (_state, login, reason) => { calls.bans.push({ login, reason }); },
    ...overrides,
  };

  return { executor: createActionExecutor(deps), calls, clock };
}

// Runs an invocation to completion on virtual time.
async function run(h: ReturnType<typeof harness>, context = {}) {
  const pending = h.executor.runAction('action-1', context);
  await h.clock.runAll();
  return pending;
}

describe('templating', () => {
  test('renders the template context into a chat step', async () => {
    const h = harness(action([step({ payload: { template: 'hi {actor}, you said {message}', sender: 'bot' } } as never)]));
    const result = await run(h, { actor: 'Sorlus', message: 'yo' });

    expect(h.calls.chats).toEqual([{ message: 'hi Sorlus, you said yo', sender: 'bot' }]);
    expect(result.status).toBe('succeeded');
  });

  test('an absent field renders empty rather than the literal token', async () => {
    const h = harness(action([step({ payload: { template: 'thanks for {months} months', sender: 'bot' } } as never)]));
    await run(h, { actor: 'Sorlus' });

    expect(h.calls.chats[0]!.message).toBe('thanks for  months');
  });

  test('a step whose template renders empty is skipped and emits nothing', async () => {
    const h = harness(action([step({ payload: { template: '{months}', sender: 'bot' } } as never)]));
    const result = await run(h, {});

    expect(h.calls.chats).toEqual([]);
    expect(result.status).toBe('skipped');
    expect(result.steps[0]!.status).toBe('skipped');
  });
});

describe('show_text', () => {
  test('broadcasts overlay:text carrying only the resolved playback payload', async () => {
    const h = harness(action([step({
      type: 'show_text',
      payload: { template: '{actor} raided!', durationMs: 5000, style: 'banner' },
    } as never)]));
    const result = await run(h, { actor: 'Sorlus' });

    expect(h.calls.broadcasts).toHaveLength(1);
    const [broadcast] = h.calls.broadcasts;
    expect(broadcast!.event).toBe('overlay:text');

    const payload = broadcast!.payload as OverlayTextPlayback;
    expect(payload).toEqual({ id: 'fixed-id', text: 'Sorlus raided!', durationMs: 5000, style: 'banner' });
    // The overlay is a public browser source: the operator's Action and asset
    // configuration must never ride along on the wire.
    expect(Object.keys(payload).sort()).toEqual(['durationMs', 'id', 'style', 'text']);
    expect(JSON.stringify(payload)).not.toContain('template');
    expect(result.status).toBe('succeeded');
  });
});

describe('play_media', () => {
  const mediaStep = (assetIds: string[], selection: 'first' | 'random', volume?: number) => step({
    type: 'play_media',
    payload: volume === undefined ? { assetIds, selection } : { assetIds, selection, volume },
  } as never);

  test("selection 'first' plays the first resolvable asset", async () => {
    const assets: Record<string, MediaAsset> = {
      a: asset({ id: 'a', src: '/sounds/a.mp3' }),
      b: asset({ id: 'b', src: '/sounds/b.mp3' }),
    };
    const h = harness(action([mediaStep(['a', 'b'], 'first')]), {
      resolveMedia: (id) => assets[id] ?? null,
    });
    await run(h);

    expect(h.calls.played).toEqual([{ kind: 'audio', src: '/sounds/a.mp3', volume: 0.8 }]);
  });

  test("selection 'random' picks via the injected chooser", async () => {
    const assets: Record<string, MediaAsset> = {
      a: asset({ id: 'a', src: '/sounds/a.mp3' }),
      b: asset({ id: 'b', src: '/sounds/b.mp3' }),
      c: asset({ id: 'c', src: '/sounds/c.mp3' }),
    };
    const h = harness(action([mediaStep(['a', 'b', 'c'], 'random')]), {
      resolveMedia: (id) => assets[id] ?? null,
      randomIndex: (length) => length - 1,
    });
    await run(h);

    expect(h.calls.played).toEqual([{ kind: 'audio', src: '/sounds/c.mp3', volume: 0.8 }]);
  });

  test("selection 'random' only ever picks a resolvable asset", async () => {
    const assets: Record<string, MediaAsset> = { b: asset({ id: 'b', src: '/sounds/b.mp3' }) };
    // 'a' and 'c' are gone; every index the chooser can return must still land on 'b'.
    for (const index of [0, 1, 2]) {
      const h = harness(action([mediaStep(['a', 'b', 'c'], 'random')]), {
        resolveMedia: (id) => assets[id] ?? null,
        randomIndex: () => index,
      });
      await run(h);
      expect(h.calls.played).toEqual([{ kind: 'audio', src: '/sounds/b.mp3', volume: 0.8 }]);
    }
  });

  test('a step volume overrides the asset volume', async () => {
    const h = harness(action([mediaStep(['a'], 'first', 0.25)]), {
      resolveMedia: () => asset({ id: 'a', volume: 0.9 }),
    });
    await run(h);

    expect(h.calls.played[0]!.volume).toBe(0.25);
  });

  test('an asset resolving to null emits no broadcast and skips the step', async () => {
    const h = harness(action([mediaStep(['missing'], 'first')]), { resolveMedia: () => null });
    const result = await run(h);

    expect(h.calls.played).toEqual([]);
    expect(h.calls.broadcasts).toEqual([]);
    expect(result.steps[0]!.status).toBe('skipped');
    expect(result.steps[0]!.detail).toContain('available');
  });

  test('an unavailable asset among several falls through to one that resolves', async () => {
    const assets: Record<string, MediaAsset> = { b: asset({ id: 'b', src: '/sounds/b.mp3' }) };
    const h = harness(action([mediaStep(['a', 'b'], 'first')]), {
      resolveMedia: (id) => assets[id] ?? null,
    });
    await run(h);

    expect(h.calls.played).toEqual([{ kind: 'audio', src: '/sounds/b.mp3', volume: 0.8 }]);
  });

  test('an invocation whose only media asset is unavailable rolls up to skipped and broadcasts nothing', async () => {
    const h = harness(action([mediaStep(['gone'], 'first')]), { resolveMedia: () => null });
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(h.calls.broadcasts).toEqual([]);
    expect(h.calls.played).toEqual([]);
  });
});

describe('delays', () => {
  test('a delayed step does not run until its delay is due', async () => {
    const h = harness(action([step({ delayMs: 5000 })]));
    const pending = h.executor.runAction('action-1', { actor: 'Sorlus' });

    // Let microtasks flush; the delay is not due, so nothing has run.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.calls.chats).toEqual([]);

    await h.clock.runAll();
    const result = await pending;
    expect(h.calls.chats).toHaveLength(1);
    expect(result.status).toBe('succeeded');
  });

  test('two steps with the same delay start together rather than serializing', async () => {
    const clock = createClock();
    const startedAt: Record<string, number> = {};

    const h = harness(action([
      step({ id: 'slow', delayMs: 1000, type: 'tts_speak', payload: { template: 'speak' } } as never),
      step({ id: 'text', delayMs: 1000, type: 'show_text', payload: { template: 'text', durationMs: 3000, style: 'toast' } } as never),
    ]), {
      // TTS occupies 5s of virtual playback; the banner must not wait behind it.
      speakText: async () => {
        startedAt.tts = clock.nowMs();
        await clock.delay(5000);
        startedAt.ttsDone = clock.nowMs();
      },
      broadcast: (event) => { if (event === 'overlay:text') startedAt.text = clock.nowMs(); },
    }, clock);

    const result = await run(h);

    expect(startedAt.tts).toBe(1000);
    // The banner lands with the TTS, not 5s later when playback finishes.
    expect(startedAt.text).toBe(1000);
    expect(startedAt.ttsDone).toBe(6000);
    expect(result.status).toBe('succeeded');
  });

  test('delayMs is relative to the start of the invocation, not to the previous step', async () => {
    const clock = createClock();
    const startedAt: Record<string, number> = {};

    const h = harness(action([
      step({ id: 'slow', delayMs: 0, type: 'tts_speak', payload: { template: 'speak' } } as never),
      step({ id: 'chat', delayMs: 1000, payload: { template: 'later', sender: 'bot' } } as never),
    ]), {
      // The first step occupies 10s of virtual playback time.
      speakText: async () => {
        startedAt.tts = clock.nowMs();
        await clock.delay(10_000);
      },
      sendChat: async () => { startedAt.chat = clock.nowMs(); },
    }, clock);

    await run(h);

    expect(startedAt.tts).toBe(0);
    // 1000ms after the invocation began — not 11_000 (10s of TTS + its own 1s).
    expect(startedAt.chat).toBe(1000);
  });

  test('steps sharing a delay run in stored order', async () => {
    const order: string[] = [];
    const h = harness(action([
      step({ id: 'one', delayMs: 500, type: 'obs_scene', payload: { sceneName: 'first' } } as never),
      step({ id: 'two', delayMs: 500, type: 'obs_scene', payload: { sceneName: 'second' } } as never),
      step({ id: 'three', delayMs: 500, type: 'obs_scene', payload: { sceneName: 'third' } } as never),
    ]), {
      switchObsScene: async (sceneName) => { order.push(sceneName); },
    });
    await run(h);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('step results come back in stored order regardless of completion order', async () => {
    const h = harness(action([
      step({ id: 'late', delayMs: 5000, payload: { template: 'late', sender: 'bot' } } as never),
      step({ id: 'early', delayMs: 0, type: 'obs_transition', payload: {} } as never),
    ]));
    const result = await run(h);

    expect(result.steps.map(s => s.type)).toEqual(['send_chat', 'obs_transition']);
  });
});

describe('failure isolation', () => {
  test('a failing step does not abort the steps after it', async () => {
    const h = harness(action([
      step({ id: 'boom', type: 'obs_scene', payload: { sceneName: 'Nope' } } as never),
      step({ id: 'after', payload: { template: 'still ran', sender: 'bot' } } as never),
    ]), {
      switchObsScene: async () => { throw new Error('OBS is not connected.'); },
    });
    const result = await run(h);

    expect(h.calls.chats).toEqual([{ message: 'still ran', sender: 'bot' }]);
    expect(result.status).toBe('partial');
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.detail).toBe('OBS is not connected.');
    expect(result.steps[1]!.status).toBe('succeeded');
    expect(result.steps[1]!.detail).toBe('');
  });

  test('every step failing rolls up to failed', async () => {
    const h = harness(action([
      step({ id: 'a', type: 'obs_scene', payload: { sceneName: 'One' } } as never),
      step({ id: 'b', type: 'obs_transition', payload: {} } as never),
    ]), {
      switchObsScene: async () => { throw new Error('OBS is not connected.'); },
      triggerObsTransition: async () => { throw new Error('OBS is not connected.'); },
    });
    const result = await run(h);

    expect(result.status).toBe('failed');
    expect(result.steps.every(s => s.status === 'failed')).toBe(true);
  });

  test('a step throwing a non-Error still yields a readable detail and does not throw the invocation', async () => {
    const h = harness(action([step({ type: 'obs_transition', payload: {} } as never)]), {
      triggerObsTransition: async () => { throw 'kaboom'; },
    });
    const result = await run(h);

    expect(result.status).toBe('failed');
    expect(result.steps[0]!.detail).toContain('kaboom');
  });

  test('TTS being unavailable degrades to a failed step, not a thrown invocation', async () => {
    const h = harness(action([
      step({ id: 'tts', type: 'tts_speak', payload: { template: 'hello' } } as never),
      step({ id: 'chat', payload: { template: 'after', sender: 'bot' } } as never),
    ]), {
      speakText: async () => { throw new Error('Chatterbox TTS request failed.'); },
    });
    const result = await run(h);

    expect(result.status).toBe('partial');
    expect(result.steps[0]!.detail).toBe('Chatterbox TTS request failed.');
    expect(h.calls.chats).toHaveLength(1);
  });

  test('Twitch being unauthenticated degrades to a failed step with a readable detail', async () => {
    const h = harness(action([
      step({ id: 'shout', type: 'twitch_shoutout', payload: { loginTemplate: '{login}' } } as never),
      step({ id: 'text', type: 'show_text', payload: { template: 'ran anyway', durationMs: 2000, style: 'banner' } } as never),
    ]), {
      sendShoutout: async () => { throw new HttpRouteError(401, 'Twitch login is required.'); },
    });
    const result = await run(h, { login: 'sorlus' });

    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.detail).toBe('Twitch login is required.');
    expect(result.status).toBe('partial');
    expect(h.calls.broadcasts).toHaveLength(1);
  });
});

describe('rollup', () => {
  test('a disabled action runs nothing and broadcasts nothing', async () => {
    const h = harness(action([step({ type: 'show_text', payload: { template: 'hi', durationMs: 2000, style: 'banner' } } as never)], { enabled: false }));
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(result.steps).toEqual([]);
    expect(h.calls.broadcasts).toEqual([]);
    expect(h.calls.chats).toEqual([]);
  });

  test('an action whose steps are all disabled is skipped and broadcasts nothing', async () => {
    const h = harness(action([
      step({ id: 'a', enabled: false, type: 'show_text', payload: { template: 'hi', durationMs: 2000, style: 'banner' } } as never),
      step({ id: 'b', enabled: false }),
    ]));
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(result.steps.every(s => s.status === 'skipped')).toBe(true);
    expect(h.calls.broadcasts).toEqual([]);
    expect(h.calls.chats).toEqual([]);
  });

  test('a disabled step is skipped while its enabled siblings still run', async () => {
    const h = harness(action([
      step({ id: 'off', enabled: false, type: 'obs_transition', payload: {} } as never),
      step({ id: 'on', payload: { template: 'ran', sender: 'bot' } } as never),
    ]));
    const result = await run(h);

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]!.status).toBe('skipped');
    expect(result.steps[1]!.status).toBe('succeeded');
    expect(h.calls.transitions).toBe(0);
    expect(h.calls.chats).toHaveLength(1);
  });

  test('an unknown action id is skipped and broadcasts nothing', async () => {
    const h = harness(null);
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(result.actionId).toBe('action-1');
    expect(result.steps).toEqual([]);
    expect(h.calls.broadcasts).toEqual([]);
  });

  test('the result carries the action id, the step ids, and a timestamp', async () => {
    const h = harness(action([step({ id: 'step-a' })]));
    const result = await run(h, { actor: 'Sorlus' });

    expect(result.actionId).toBe('action-1');
    expect(result.steps[0]!.stepId).toBe('step-a');
    expect(result.steps[0]!.type).toBe('send_chat');
    expect(Number.isNaN(Date.parse(result.ranAt))).toBe(false);
  });
});

describe('step dispatch', () => {
  test('dispatches each step type to its service', async () => {
    const h = harness(action([
      step({ id: 'a', type: 'tts_speak', payload: { template: 'speak {actor}' } } as never),
      step({ id: 'b', type: 'obs_scene', payload: { sceneName: 'Starting Soon' } } as never),
      step({ id: 'c', type: 'obs_transition', payload: {} } as never),
      step({ id: 'd', type: 'twitch_shoutout', payload: { loginTemplate: '{login}' } } as never),
      step({ id: 'e', type: 'twitch_whisper', payload: { loginTemplate: '{login}', template: 'psst {actor}' } } as never),
      step({ id: 'f', type: 'twitch_timeout', payload: { loginTemplate: '{login}', secondsTemplate: '60', reasonTemplate: 'spam' } } as never),
      step({ id: 'g', type: 'twitch_ban', payload: { loginTemplate: '{login}', reasonTemplate: 'bot' } } as never),
    ]), {});
    const result = await run(h, { actor: 'Sorlus', login: 'sorlus' });

    expect(h.calls.spoken).toEqual(['speak Sorlus']);
    expect(h.calls.scenes).toEqual(['Starting Soon']);
    expect(h.calls.transitions).toBe(1);
    expect(h.calls.shoutouts).toEqual(['sorlus']);
    expect(h.calls.whispers).toEqual([{ login: 'sorlus', message: 'psst Sorlus' }]);
    expect(h.calls.timeouts).toEqual([{ login: 'sorlus', seconds: 60, reason: 'spam' }]);
    expect(h.calls.bans).toEqual([{ login: 'sorlus', reason: 'bot' }]);
    expect(result.status).toBe('succeeded');
  });

  test('llm_response asks the LLM and sends the answer to chat', async () => {
    const asked: string[] = [];
    const h = harness(action([step({ type: 'llm_response', payload: { template: 'why is {actor} here' } } as never)]), {
      askLlm: async (_context, prompt) => { asked.push(prompt); return '@Sorlus because reasons'; },
    });
    const result = await run(h, { actor: 'Sorlus' });

    expect(asked).toEqual(['why is Sorlus here']);
    expect(h.calls.chats).toEqual([{ message: '@Sorlus because reasons', sender: 'bot' }]);
    expect(result.status).toBe('succeeded');
  });

  test('a twitch step whose login template renders empty is skipped, not sent', async () => {
    const h = harness(action([step({ type: 'twitch_shoutout', payload: { loginTemplate: '{login}' } } as never)]));
    const result = await run(h, {});

    expect(h.calls.shoutouts).toEqual([]);
    expect(result.status).toBe('skipped');
    expect(result.steps[0]!.status).toBe('skipped');
  });
});

describe('templated timeout duration', () => {
  const timeoutStep = step({
    id: 't',
    type: 'twitch_timeout',
    payload: { loginTemplate: '{arg1}', secondsTemplate: '{arg2}', reasonTemplate: '{rest2}' },
  } as never);

  test('binds the duration from the invocation, so /timeout bob 300 spam really times out for 300s', async () => {
    const h = harness(action([timeoutStep]));
    await run(h, { args: ['bob', '300', 'spamming', 'links'] });
    expect(h.calls.timeouts).toEqual([{ login: 'bob', seconds: 300, reason: 'spamming links' }]);
  });

  test('a missing or non-numeric duration still lands the timeout at the default, rather than failing', async () => {
    const h = harness(action([timeoutStep]));
    // A moderation command that lands with the wrong duration beats one that does not land.
    const result = await run(h, { args: ['bob'] });
    expect(h.calls.timeouts).toEqual([{ login: 'bob', seconds: 600, reason: '' }]);
    expect(result.status).toBe('succeeded');
  });

  test('an out-of-range duration falls back rather than letting Twitch reject the call', async () => {
    const h = harness(action([timeoutStep]));
    await run(h, { args: ['bob', '99999999'] });
    expect(h.calls.timeouts[0]!.seconds).toBe(600);
  });
});

describe('master media mute', () => {
  test('skips a quick-disable action while muted and broadcasts nothing', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: true },
    );
    const h = harness(target, { isMuted: () => true });
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(result.steps).toEqual([]);
    expect(h.calls.broadcasts).toEqual([]);
    expect(h.calls.chats).toEqual([]);
  });

  test('runs a quick-disable action when not muted', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: true },
    );
    const h = harness(target, { isMuted: () => false });
    const result = await run(h);

    expect(result.status).toBe('succeeded');
    expect(h.calls.chats).toEqual([{ message: 'hi', sender: 'bot' }]);
  });

  test('runs an unflagged action even while muted', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: false },
    );
    const h = harness(target, { isMuted: () => true });
    const result = await run(h);

    expect(result.status).toBe('succeeded');
    expect(h.calls.chats).toEqual([{ message: 'hi', sender: 'bot' }]);
  });
});

// --- adjust_counter -----------------------------------------------------------

/**
 * A counter store backed by a plain object, so these tests exercise the executor's
 * behavior rather than SQLite's. `resolveCounter` reads through it live, which is
 * what makes the ordering test below meaningful.
 */
function counterStore(initial: Record<string, number> = {}) {
  const values: Record<string, number> = { ...initial };
  const keyById = (id: string) => id.replace(/^counter-/, '');

  const deps: Partial<ActionExecutorDeps> = {
    adjustCounter: (id, mode, amount) => {
      const key = keyById(id);
      if (!(key in values)) return null;
      values[key] = mode === 'add' ? values[key]! + amount : amount;
      return {
        id, key, label: key, value: values[key]!,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      };
    },
    resolveCounter: (key: string) => (key in values ? values[key] : undefined),
  };

  return { values, deps };
}

describe('adjust_counter', () => {
  test('add moves the counter and reports the new value', async () => {
    const counters = counterStore({ deaths: 41 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '1' },
    } as never)]), counters.deps);
    const result = await run(h);

    expect(counters.values.deaths).toBe(42);
    expect(result.status).toBe('succeeded');
    expect(result.steps[0]!.detail).toBe('deaths = 42');
  });

  test('set assigns, so "set 0" is how a reset is expressed', async () => {
    const counters = counterStore({ deaths: 99 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'set', amountTemplate: '0' },
    } as never)]), counters.deps);
    await run(h);
    expect(counters.values.deaths).toBe(0);
  });

  test('decrements on a negative amount rather than clamping', async () => {
    const counters = counterStore({ deaths: 1 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '-5' },
    } as never)]), counters.deps);
    await run(h);
    expect(counters.values.deaths).toBe(-4);
  });

  test('binds the amount from the invocation', async () => {
    const counters = counterStore({ deaths: 0 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '{arg1}' },
    } as never)]), counters.deps);
    await run(h, { args: ['3'] });
    expect(counters.values.deaths).toBe(3);
  });

  test('SKIPS a non-numeric amount rather than defaulting, and writes nothing', async () => {
    // Deliberately unlike twitch_timeout, which falls back to a default duration.
    // There is no safe default for how much to write into a durable counter.
    const counters = counterStore({ deaths: 7 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '{arg1}' },
    } as never)]), counters.deps);
    const result = await run(h, { args: ['banana'] });

    expect(counters.values.deaths).toBe(7);
    expect(result.steps[0]!.status).toBe('skipped');
  });

  test('skips an amount that renders empty', async () => {
    const counters = counterStore({ deaths: 7 });
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '{arg1}' },
    } as never)]), counters.deps);
    const result = await run(h, { args: [] });

    expect(counters.values.deaths).toBe(7);
    expect(result.steps[0]!.status).toBe('skipped');
  });

  test('skips a counter that no longer exists', async () => {
    const counters = counterStore({});
    const h = harness(action([step({
      type: 'adjust_counter',
      payload: { counterId: 'counter-gone', mode: 'add', amountTemplate: '1' },
    } as never)]), counters.deps);
    const result = await run(h);
    expect(result.steps[0]!.status).toBe('skipped');
  });
});

describe('{counter:key} in templates', () => {
  test('renders a counter value into overlay text', async () => {
    const counters = counterStore({ deaths: 12 });
    const h = harness(action([step({
      type: 'show_text',
      payload: { template: 'Deaths: {counter:deaths}', durationMs: 5000, style: 'banner' },
    } as never)]), counters.deps);
    await run(h);

    const playback = h.calls.broadcasts[0]!.payload as OverlayTextPlayback;
    expect(playback.text).toBe('Deaths: 12');
  });

  test('renders zero as "0", not as empty and not as a literal token', async () => {
    const counters = counterStore({ deaths: 0 });
    const h = harness(action([step({
      payload: { template: 'Deaths: {counter:deaths}', sender: 'bot' },
    } as never)]), counters.deps);
    await run(h);
    expect(h.calls.chats[0]!.message).toBe('Deaths: 0');
  });

  test('leaves an unknown counter key visible as a literal token', async () => {
    const counters = counterStore({});
    const h = harness(action([step({
      payload: { template: 'Deaths: {counter:typo}', sender: 'bot' },
    } as never)]), counters.deps);
    await run(h);
    expect(h.calls.chats[0]!.message).toBe('Deaths: {counter:typo}');
  });

  /**
   * The ordering guarantee the design depends on: same-delay steps start in stored
   * order without awaiting each other, and adjust_counter writes synchronously, so a
   * display step placed after an increment sees the incremented value. That is
   * currently incidental; this test is what makes it a guarantee.
   */
  test('a display step after an increment at the same delay sees the new value', async () => {
    const counters = counterStore({ deaths: 41 });
    const h = harness(action([
      step({
        type: 'adjust_counter',
        payload: { counterId: 'counter-deaths', mode: 'add', amountTemplate: '1' },
      } as never),
      step({
        id: 'step-b',
        payload: { template: 'Deaths: {counter:deaths}', sender: 'bot' },
      } as never),
    ]), counters.deps);
    await run(h);

    expect(h.calls.chats[0]!.message).toBe('Deaths: 42');
  });
});
