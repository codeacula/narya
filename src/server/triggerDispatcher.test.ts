import { beforeEach, describe, expect, test } from 'bun:test';
import type { ActionRunResult, ChatMessage, TemplateContext } from '../shared/api';
import { createAction } from './actions';
import { createAutomationTrigger } from './automationTriggers';
import { db } from './db';
import { createTriggerDispatcher, pruneAutomationRuns, type TriggerDispatcherDeps } from './triggerDispatcher';
import { upsertTriggerOverride } from './triggerOverrides';

// A hand-cranked clock: cooldown tests move time forward explicitly instead of sleeping.
function createClock(start = Date.parse('2026-07-11T12:00:00.000Z')) {
  let ms = start;
  return {
    now: () => new Date(ms),
    advance: (by: number) => { ms += by; },
  };
}

type RunCall = { actionId: string; context: TemplateContext };

function createRunner() {
  const calls: RunCall[] = [];
  const runAction = async (actionId: string, context: TemplateContext): Promise<ActionRunResult> => {
    calls.push({ actionId, context });
    return { actionId, status: 'succeeded', steps: [], ranAt: new Date().toISOString() };
  };
  return { calls, runAction };
}

function setup(overrides: Partial<TriggerDispatcherDeps> = {}) {
  const clock = createClock();
  const runner = createRunner();
  const dispatcher = createTriggerDispatcher({
    runAction: runner.runAction,
    getActiveModuleId: () => null,
    getBotLogin: () => 'naryabot',
    now: clock.now,
    ...overrides,
  });
  return { clock, runner, dispatcher };
}

let actionId = '';

// Loosely typed on purpose: createAutomationTrigger validates unknown input, and a
// Partial<> of the trigger union collapses each config to `never`.
function trigger(input: Record<string, unknown> & { kind: string; config: unknown }) {
  return createAutomationTrigger({
    name: 'Test trigger',
    actions: [{ actionId, position: 0, enabled: true }],
    moduleId: null,
    enabled: true,
    globalCooldownMs: 0,
    userCooldownMs: 0,
    ...input,
  });
}

function chat(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    channel: 'codeacula',
    username: 'sorlus',
    displayName: 'Sorlus',
    color: null,
    message: 'hello there',
    receivedAt: '2026-07-11T12:00:00.000Z',
    deletedAt: null,
    deletedReason: null,
    badges: null,
    emotes: null,
    isFirstTimer: false,
    isFirstThisSession: false,
    isFirstEver: false,
    ...overrides,
  };
}

function makeModule(id: string, name: string) {
  const now = new Date().toISOString();
  db.prepare('insert into category_modules (id, name, enabled, status, status_detail, created_at, updated_at) values (?, ?, 1, ?, \'\', ?, ?)')
    .run(id, name, 'idle', now, now);
}

beforeEach(() => {
  db.exec('delete from trigger_overrides');
  db.exec('delete from automation_runs');
  db.exec('delete from automation_triggers');
  db.exec('delete from category_modules');
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  actionId = createAction({
    name: 'Test action',
    description: '',
    enabled: true,
    steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'hi {actor}', sender: 'bot' } }],
  }).id;
});

describe('chat phrase triggers', () => {
  test('fires on a case-insensitive contains match', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'Hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleChatMessage(chat({ message: 'so much HYPE today' }));

    expect(runs).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.context.actor).toBe('Sorlus');
    expect(runner.calls[0]!.context.login).toBe('sorlus');
    expect(runner.calls[0]!.context.message).toBe('so much HYPE today');
  });

  test('exact and starts_with do not fire on a bare substring', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'exact' } });
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'starts_with' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'so much hype today' }));

    expect(runner.calls).toHaveLength(0);
  });

  test('starts_with puts the remainder in {input}', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'starts_with' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'HYPE for the raid' }));

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.context.input).toBe('for the raid');
    expect(runner.calls[0]!.context.args).toEqual(['for', 'the', 'raid']);
  });

  test('every matching phrase trigger fires, not just the first', async () => {
    const second = createAction({
      name: 'Second action',
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    });
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    createAutomationTrigger({
      kind: 'chat_phrase',
      name: 'Second trigger',
      actions: [{ actionId: second.id, position: 0, enabled: true }],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { phrase: 'hype', match: 'contains', roles: [] },
    });
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleChatMessage(chat({ message: 'hype!' }));

    expect(runs).toHaveLength(2);
    expect(runner.calls.map(call => call.actionId).sort()).toEqual([actionId, second.id].sort());
  });

  test('a disabled trigger never fires', async () => {
    trigger({ kind: 'chat_phrase', enabled: false, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(0);
  });
});

describe('bot-loop prevention', () => {
  test('ignores chat sent by Narya\'s own bot identity', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getBotLogin: () => 'NaryaBot' });

    const runs = await dispatcher.handleChatMessage(chat({ username: 'naryabot', displayName: 'NaryaBot', message: 'hype' }));

    expect(runs).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  test('ignores the bot\'s own viewer command echo', async () => {
    trigger({ kind: 'viewer_command', config: { command: '!hi', aliases: [], roles: [] } });
    const { dispatcher, runner } = setup({ getBotLogin: () => 'naryabot' });

    await dispatcher.handleChatMessage(chat({ username: 'naryabot', message: '!hi' }));

    expect(runner.calls).toHaveLength(0);
  });

  test('still fires for viewers when no bot identity is configured', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getBotLogin: () => null });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(1);
  });
});

describe('role filters', () => {
  test('an empty allowlist admits every viewer', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'hype', badges: null }));

    expect(runner.calls).toHaveLength(1);
  });

  test('a mod-only trigger ignores a plain viewer', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: ['mod'] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'hype', badges: null }));

    expect(runner.calls).toHaveLength(0);
  });

  test('a mod-only trigger fires for a moderator badge', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: ['mod'] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'hype', badges: { moderator: '1' } }));

    expect(runner.calls).toHaveLength(1);
  });

  test('a viewer-role allowlist admits everyone, badge or not', async () => {
    trigger({ kind: 'viewer_command', config: { command: '!hi', aliases: [], roles: ['viewer'] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: '!hi', badges: null }));

    expect(runner.calls).toHaveLength(1);
  });

  test('a sub-only trigger fires for a broadcaster too when both are listed', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: ['sub', 'broadcaster'] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'hype', badges: { broadcaster: '1' } }));

    expect(runner.calls).toHaveLength(1);
  });
});

describe('viewer commands', () => {
  test('fires on the command word and populates {input} and {args}', async () => {
    trigger({ kind: 'viewer_command', config: { command: '!so', aliases: [], roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: '!so @friend and pals' }));

    const context = runner.calls[0]!.context;
    expect(context.input).toBe('@friend and pals');
    expect(context.args).toEqual(['@friend', 'and', 'pals']);
    expect(context.message).toBe('!so @friend and pals');
  });

  test('matches an alias, case-insensitively', async () => {
    trigger({ kind: 'viewer_command', config: { command: '!shoutout', aliases: ['!so'], roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: '!SO friend' }));

    expect(runner.calls).toHaveLength(1);
  });

  test('does not fire when the command only appears mid-message', async () => {
    trigger({ kind: 'viewer_command', config: { command: '!so', aliases: [], roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ message: 'say !so to greet' }));

    expect(runner.calls).toHaveLength(0);
  });
});

describe('deduplication', () => {
  test('a redelivered chat message does not invoke the action twice', async () => {
    trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();
    const message = chat({ id: 'msg-dupe', message: 'hype' });

    await dispatcher.handleChatMessage(message);
    const second = await dispatcher.handleChatMessage(message);

    expect(runner.calls).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test('a redelivered EventSub notification does not invoke the action twice', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'raid' } });
    const { dispatcher, runner } = setup();
    const signal = { kind: 'raid' as const, eventId: 'esub-1', actor: 'Sorlus', login: 'sorlus', amount: 12 };

    await dispatcher.handleTwitchEvent(signal);
    await dispatcher.handleTwitchEvent(signal);

    expect(runner.calls).toHaveLength(1);
  });

  test('a redelivered redemption does not invoke the action twice', async () => {
    trigger({ kind: 'reward', config: { rewardId: 'reward-1' } });
    const { dispatcher, runner } = setup();
    const signal = { eventId: 'esub-2', rewardId: 'reward-1', rewardTitle: 'Hydrate', actor: 'Sorlus', login: 'sorlus' };

    await dispatcher.handleRewardRedemption(signal);
    await dispatcher.handleRewardRedemption(signal);

    expect(runner.calls).toHaveLength(1);
  });

  test('two triggers on one event both fire — the dedupe key is per trigger', async () => {
    const second = createAction({
      name: 'Second action',
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    });
    trigger({ kind: 'twitch_event', config: { eventKind: 'raid' } });
    createAutomationTrigger({
      kind: 'twitch_event',
      name: 'Second trigger',
      actions: [{ actionId: second.id, position: 0, enabled: true }],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { eventKind: 'raid' },
    });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'raid', eventId: 'esub-3', actor: 'Sorlus', login: 'sorlus' });

    expect(runner.calls).toHaveLength(2);
  });

  test('distinct events with the same trigger both fire', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'follow' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'follow', eventId: 'esub-a', actor: 'A', login: 'a' });
    await dispatcher.handleTwitchEvent({ kind: 'follow', eventId: 'esub-b', actor: 'B', login: 'b' });

    expect(runner.calls).toHaveLength(2);
  });
});

describe('cooldowns', () => {
  test('a global cooldown suppresses a second firing inside the window', async () => {
    trigger({ kind: 'chat_phrase', globalCooldownMs: 30_000, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner, clock } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', message: 'hype' }));
    clock.advance(10_000);
    await dispatcher.handleChatMessage(chat({ id: 'm2', username: 'other', message: 'hype' }));

    expect(runner.calls).toHaveLength(1);
  });

  test('a global cooldown lets the trigger fire again after the window', async () => {
    trigger({ kind: 'chat_phrase', globalCooldownMs: 30_000, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner, clock } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', message: 'hype' }));
    clock.advance(30_000);
    await dispatcher.handleChatMessage(chat({ id: 'm2', username: 'other', message: 'hype' }));

    expect(runner.calls).toHaveLength(2);
  });

  test('a zero global cooldown disables the limit', async () => {
    trigger({ kind: 'chat_phrase', globalCooldownMs: 0, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', message: 'hype' }));
    await dispatcher.handleChatMessage(chat({ id: 'm2', message: 'hype' }));

    expect(runner.calls).toHaveLength(2);
  });

  test('a per-user cooldown suppresses the same user but not a different one', async () => {
    trigger({ kind: 'chat_phrase', userCooldownMs: 60_000, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner, clock } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', username: 'sorlus', message: 'hype' }));
    clock.advance(1000);
    await dispatcher.handleChatMessage(chat({ id: 'm2', username: 'sorlus', message: 'hype' }));
    await dispatcher.handleChatMessage(chat({ id: 'm3', username: 'other', message: 'hype' }));

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map(call => call.context.login)).toEqual(['sorlus', 'other']);
  });

  test('a zero per-user cooldown disables the limit', async () => {
    trigger({ kind: 'chat_phrase', userCooldownMs: 0, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', username: 'sorlus', message: 'hype' }));
    await dispatcher.handleChatMessage(chat({ id: 'm2', username: 'sorlus', message: 'hype' }));

    expect(runner.calls).toHaveLength(2);
  });

  test('a per-user cooldown expires on its own schedule', async () => {
    trigger({ kind: 'chat_phrase', userCooldownMs: 60_000, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner, clock } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', username: 'sorlus', message: 'hype' }));
    clock.advance(60_000);
    await dispatcher.handleChatMessage(chat({ id: 'm2', username: 'sorlus', message: 'hype' }));

    expect(runner.calls).toHaveLength(2);
  });

  test('a suppressed attempt does not extend the cooldown window', async () => {
    trigger({ kind: 'chat_phrase', globalCooldownMs: 30_000, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner, clock } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', message: 'hype' }));
    clock.advance(20_000);
    await dispatcher.handleChatMessage(chat({ id: 'm2', message: 'hype' })); // suppressed
    clock.advance(10_000);
    await dispatcher.handleChatMessage(chat({ id: 'm3', message: 'hype' })); // 30s after the run

    expect(runner.calls).toHaveLength(2);
  });
});

describe('module scoping', () => {
  test('a global trigger fires when no module is active', async () => {
    trigger({ kind: 'chat_phrase', moduleId: null, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(1);
  });

  test('a module-scoped trigger is suppressed when no module is active', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'chat_phrase', moduleId: 'mod-1', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(0);
  });

  test('a module-scoped trigger is suppressed when a different module is active', async () => {
    makeModule('mod-1', 'Rimworld');
    makeModule('mod-2', 'Factorio');
    trigger({ kind: 'chat_phrase', moduleId: 'mod-1', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => 'mod-2' });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(0);
  });

  test('a module-scoped trigger fires when its module is active', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'chat_phrase', moduleId: 'mod-1', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => 'mod-1' });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(1);
  });

  test('global triggers still run while a module is active', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'chat_phrase', moduleId: null, config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => 'mod-1' });

    await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runner.calls).toHaveLength(1);
  });

  test('module scoping applies to redemptions too', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'reward', moduleId: 'mod-1', config: { rewardId: 'reward-1' } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.handleRewardRedemption({
      eventId: 'e1', rewardId: 'reward-1', rewardTitle: 'Hydrate', actor: 'Sorlus', login: 'sorlus',
    });

    expect(runner.calls).toHaveLength(0);
  });
});

describe('twitch events', () => {
  test('only the matching event kind fires', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'cheer' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'follow', eventId: 'e1', actor: 'Sorlus', login: 'sorlus' });
    expect(runner.calls).toHaveLength(0);

    await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e2', actor: 'Sorlus', login: 'sorlus', amount: 500 });
    expect(runner.calls).toHaveLength(1);
  });

  test('populates the subscription context', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({
      kind: 'sub', eventId: 'e1', actor: 'Sorlus', login: 'sorlus', tier: 'Tier 2', months: 7,
    });

    const context = runner.calls[0]!.context;
    expect(context.actor).toBe('Sorlus');
    expect(context.login).toBe('sorlus');
    expect(context.tier).toBe('Tier 2');
    expect(context.months).toBe(7);
  });

  test('an event without an id still fires (no dedupe key available)', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'raid' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'raid', eventId: null, actor: 'A', login: 'a', amount: 3 });
    await dispatcher.handleTwitchEvent({ kind: 'raid', eventId: null, actor: 'B', login: 'b', amount: 4 });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]!.context.amount).toBe(3);
  });
});

describe('reward redemptions', () => {
  test('fires only for its own reward id and carries the user input', async () => {
    trigger({ kind: 'reward', config: { rewardId: 'reward-1' } });
    const { dispatcher, runner } = setup();

    await dispatcher.handleRewardRedemption({
      eventId: 'e1', rewardId: 'reward-2', rewardTitle: 'Other', actor: 'Sorlus', login: 'sorlus',
    });
    expect(runner.calls).toHaveLength(0);

    await dispatcher.handleRewardRedemption({
      eventId: 'e2', rewardId: 'reward-1', rewardTitle: 'Hydrate', actor: 'Sorlus', login: 'sorlus', userInput: 'drink up',
    });

    const context = runner.calls[0]!.context;
    expect(context.rewardTitle).toBe('Hydrate');
    expect(context.input).toBe('drink up');
    expect(context.args).toEqual(['drink', 'up']);
  });
});

describe('module lifecycle', () => {
  test('activation fires module_activate triggers scoped to that module', async () => {
    makeModule('mod-1', 'Rimworld');
    makeModule('mod-2', 'Factorio');
    trigger({ kind: 'module_activate', moduleId: 'mod-1', config: {} });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => 'mod-1' });

    await dispatcher.handleModuleLifecycle('activate', 'mod-2', 'Factorio');
    expect(runner.calls).toHaveLength(0);

    await dispatcher.handleModuleLifecycle('activate', 'mod-1', 'Rimworld');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.context.module).toBe('Rimworld');
  });

  test('deactivation fires module_deactivate triggers even though the module is no longer active', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'module_deactivate', moduleId: 'mod-1', config: {} });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.handleModuleLifecycle('deactivate', 'mod-1', 'Rimworld');

    expect(runner.calls).toHaveLength(1);
  });

  test('a global lifecycle trigger fires for any module', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'module_activate', moduleId: null, config: {} });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => 'mod-1' });

    await dispatcher.handleModuleLifecycle('activate', 'mod-1', 'Rimworld');

    expect(runner.calls).toHaveLength(1);
  });

  test('activate triggers do not fire on deactivation', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'module_activate', moduleId: 'mod-1', config: {} });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.handleModuleLifecycle('deactivate', 'mod-1', 'Rimworld');

    expect(runner.calls).toHaveLength(0);
  });
});

describe('slash commands', () => {
  function slashTrigger(command: string, aliases: string[] = []) {
    return trigger({ kind: 'dashboard_slash', config: { command, aliases } });
  }

  test('an unknown slash command is rejected locally and never reaches an action', async () => {
    slashTrigger('/shoutout', ['/so']);
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('/shoutuot friend');

    expect(response.ok).toBe(false);
    expect(response.run).toBeNull();
    expect(response.message).toContain('/shoutuot');
    // The whole point: an operator typo must never be forwarded to Twitch chat.
    expect(runner.calls).toHaveLength(0);
  });

  test('input that does not start with a slash is rejected', async () => {
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('shoutout friend');

    expect(response.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  test('an empty slash is rejected', async () => {
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('/');

    expect(response.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  test('a known command runs its action with the target as {login}', async () => {
    slashTrigger('/shoutout', ['/so']);
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('/shoutout @Friend');

    expect(response.ok).toBe(true);
    expect(response.run?.status).toBe('succeeded');
    const context = runner.calls[0]!.context;
    expect(context.login).toBe('friend');
    expect(context.actor).toBe('Friend');
  });

  test('an alias resolves to the same trigger, case-insensitively', async () => {
    slashTrigger('/shoutout', ['/so']);
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('/SO friend');

    expect(response.ok).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });

  test('args holds every argument, so {arg1} is the target and {rest} the free text', async () => {
    slashTrigger('/whisper', ['/w']);
    const { dispatcher, runner } = setup();

    await dispatcher.handleSlashCommand('/w friend thanks for the raid');

    const context = runner.calls[0]!.context;
    expect(context.login).toBe('friend');
    // Same context shape as viewer_command: args starts at the first argument, not
    // after the target. {rest} is what drops the target.
    expect(context.args).toEqual(['friend', 'thanks', 'for', 'the', 'raid']);
    expect(context.input).toBe('friend thanks for the raid');
  });

  test('a missing argument leaves the action nothing to do and reports not-ok', async () => {
    // The whisper step renders an empty body, the executor skips it, and a run that
    // did nothing is reported as a failure to the operator rather than silently "sent".
    const whisper = createAction({
      name: 'Whisper (test)',
      description: '',
      enabled: true,
      steps: [{ type: 'twitch_whisper', enabled: true, delayMs: 0, payload: { loginTemplate: '{login}', template: '{args}' } }],
    });
    createAutomationTrigger({
      kind: 'dashboard_slash',
      name: 'Whisper',
      actions: [{ actionId: whisper.id, position: 0, enabled: true }],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { command: '/whisper', aliases: [] },
    });
    const { dispatcher } = setup({
      runAction: async (id): Promise<ActionRunResult> => ({
        actionId: id,
        status: 'skipped',
        steps: [{ stepId: 's1', type: 'twitch_whisper', status: 'skipped', detail: 'The whisper template rendered empty.' }],
        ranAt: new Date().toISOString(),
      }),
    });

    const response = await dispatcher.handleSlashCommand('/whisper friend');

    expect(response.ok).toBe(false);
    expect(response.run?.status).toBe('skipped');
  });

  test('a slash command with no target at all still resolves and reports', async () => {
    slashTrigger('/shoutout');
    const { dispatcher, runner } = setup();

    const response = await dispatcher.handleSlashCommand('/shoutout');

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.context.login).toBe('');
    expect(response.ok).toBe(true);
  });

  test('a module-scoped slash command is suppressed when its module is inactive', async () => {
    makeModule('mod-1', 'Rimworld');
    trigger({ kind: 'dashboard_slash', moduleId: 'mod-1', config: { command: '/raid', aliases: [] } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    const response = await dispatcher.handleSlashCommand('/raid friend');

    expect(response.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('manual runs', () => {
  test('runs the trigger\'s action and records the invocation', async () => {
    const created = trigger({ kind: 'manual', config: { label: 'Intermission' } });
    const { dispatcher, runner } = setup();

    const result = await dispatcher.runTriggerManually(created.id);

    expect(result.status).toBe('succeeded');
    expect(runner.calls).toHaveLength(1);
    const runs = db.prepare('select status from automation_runs where trigger_id = ?').all(created.id) as { status: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
  });

  test('bypasses cooldowns — an explicit operator run always fires', async () => {
    const created = trigger({ kind: 'manual', globalCooldownMs: 60_000, config: { label: 'Intermission' } });
    const { dispatcher, runner } = setup();

    await dispatcher.runTriggerManually(created.id);
    await dispatcher.runTriggerManually(created.id);

    expect(runner.calls).toHaveLength(2);
  });

  test('bypasses module scoping — the operator asked for it explicitly', async () => {
    makeModule('mod-1', 'Rimworld');
    const created = trigger({ kind: 'manual', moduleId: 'mod-1', config: { label: 'Intermission' } });
    const { dispatcher, runner } = setup({ getActiveModuleId: () => null });

    await dispatcher.runTriggerManually(created.id);

    expect(runner.calls).toHaveLength(1);
  });

  test('throws for an unknown trigger', async () => {
    const { dispatcher } = setup();

    await expect(dispatcher.runTriggerManually('nope')).rejects.toThrow('Trigger not found.');
  });

  test('a disabled trigger can still be run by hand', async () => {
    const created = trigger({ kind: 'manual', enabled: false, config: { label: 'Intermission' } });
    const { dispatcher, runner } = setup();

    await dispatcher.runTriggerManually(created.id);

    expect(runner.calls).toHaveLength(1);
  });

  test('a trigger with all actions disabled returns skipped instead of throwing', async () => {
    const created = trigger({
      kind: 'manual',
      actions: [{ actionId, position: 0, enabled: false }],
      config: { label: 'Intermission' },
    });
    const { dispatcher, runner } = setup();

    const result = await dispatcher.runTriggerManually(created.id);

    expect(result).toEqual({ status: 'skipped', actions: [] });
    expect(runner.calls).toHaveLength(0);
    const runs = db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(created.id) as { n: number };
    expect(runs.n).toBe(0);
  });
});

describe('run log', () => {
  test('records the status and actor of every invocation', async () => {
    const created = trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher } = setup();

    await dispatcher.handleChatMessage(chat({ id: 'm1', username: 'Sorlus', message: 'hype' }));

    const runs = db.prepare('select trigger_id as triggerId, dedupe_key as dedupeKey, actor_login as actorLogin, status from automation_runs')
      .all() as { triggerId: string; dedupeKey: string; actorLogin: string; status: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggerId).toBe(created.id);
    expect(runs[0]!.actorLogin).toBe('sorlus');
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.dedupeKey).toContain('m1');
  });

  test('records a failed run when the action throws', async () => {
    const created = trigger({ kind: 'chat_phrase', config: { phrase: 'hype', match: 'contains', roles: [] } });
    const { dispatcher } = setup({
      runAction: async () => { throw new Error('executor exploded'); },
    });

    const runs = await dispatcher.handleChatMessage(chat({ message: 'hype' }));

    expect(runs[0]!.status).toBe('failed');
    const logged = db.prepare('select status, detail from automation_runs where trigger_id = ?').all(created.id) as { status: string; detail: string }[];
    expect(logged[0]!.status).toBe('failed');
    expect(logged[0]!.detail).toContain('executor exploded');
  });
});

describe('pruneAutomationRuns', () => {
  test('drops runs past the retention window and keeps everything inside it', () => {
    const now = new Date('2026-07-11T12:00:00.000Z');
    const insert = (id: string, ranAt: string) => db.prepare(`
      insert into automation_runs (id, trigger_id, dedupe_key, actor_login, status, detail, ran_at)
      values (?, 't', ?, null, 'succeeded', '', ?)
    `).run(id, `k-${id}`, ranAt);

    insert('old', '2026-07-01T12:00:00.000Z');    // 10 days — past the window
    insert('edge', '2026-07-05T12:00:00.000Z');   // 6 days — inside
    insert('fresh', '2026-07-11T11:59:00.000Z');

    expect(pruneAutomationRuns(now)).toBe(1);

    const kept = (db.prepare('select id from automation_runs order by id').all() as Array<{ id: string }>).map(row => row.id);
    // 'edge' must survive: cooldowns are computed from this table, so pruning a row
    // inside its window would silently re-arm a trigger that should still be cooling.
    expect(kept).toEqual(['edge', 'fresh']);
  });
});

describe('the reserved /counter command', () => {
  /** An in-memory counters port, so these tests do not touch the counters table. */
  function counters(initial: Record<string, number> = {}) {
    const values: Record<string, number> = { ...initial };
    const asCounter = (key: string) => ({
      id: `counter-${key}`,
      key,
      label: key,
      value: values[key]!,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    return {
      values,
      deps: {
        findCounterByKey: (key: string) => (key in values ? asCounter(key) : null),
        adjustCounterByKey: (key: string, mode: 'add' | 'set', amount: number) => {
          if (!(key in values)) return null;
          values[key] = mode === 'add' ? values[key]! + amount : amount;
          return asCounter(key);
        },
      },
    };
  }

  test('reports a value without changing it', async () => {
    const store = counters({ deaths: 42 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths');

    expect(response.ok).toBe(true);
    expect(response.message).toBe('deaths: 42');
    expect(store.values.deaths).toBe(42);
  });

  test('increments and reports the transition', async () => {
    const store = counters({ deaths: 41 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths +1');

    expect(response.ok).toBe(true);
    expect(response.message).toBe('deaths: 41 → 42');
    expect(store.values.deaths).toBe(42);
  });

  test('decrements', async () => {
    const store = counters({ deaths: 3 });
    const { dispatcher } = setup(store.deps);
    await dispatcher.handleSlashCommand('/counter deaths -1');
    expect(store.values.deaths).toBe(2);
  });

  test('sets, which is how a reset is expressed', async () => {
    const store = counters({ deaths: 99 });
    const { dispatcher } = setup(store.deps);
    await dispatcher.handleSlashCommand('/counter deaths set 0');
    expect(store.values.deaths).toBe(0);
  });

  test('normalizes the key the operator typed', async () => {
    const store = counters({ 'zambie-deaths': 1 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter Zambie_Deaths');
    expect(response.ok).toBe(true);
  });

  test('rejects an unknown counter without touching anything', async () => {
    const store = counters({ deaths: 1 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter wipes +1');

    expect(response.ok).toBe(false);
    expect(response.message).toContain('wipes');
    expect(store.values.deaths).toBe(1);
  });

  test('rejects a non-numeric amount rather than guessing', async () => {
    const store = counters({ deaths: 5 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths banana');

    expect(response.ok).toBe(false);
    expect(store.values.deaths).toBe(5);
  });

  test('rejects a bare number rather than guessing add vs set', async () => {
    // "/counter deaths 5" is plausibly "+5" or "set 5". Both are destructive when
    // wrong, so the sign (or the word set) has to be explicit.
    const store = counters({ deaths: 10 });
    const { dispatcher } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths 5');

    expect(response.ok).toBe(false);
    expect(response.message).toContain('set 5');
    expect(store.values.deaths).toBe(10);
  });

  test('an explicit +5 still works', async () => {
    const store = counters({ deaths: 10 });
    const { dispatcher } = setup(store.deps);
    await dispatcher.handleSlashCommand('/counter deaths +5');
    expect(store.values.deaths).toBe(15);
  });

  test('explains itself when no key is given', async () => {
    const { dispatcher } = setup(counters().deps);
    const response = await dispatcher.handleSlashCommand('/counter');

    expect(response.ok).toBe(false);
    expect(response.message).toContain('Usage');
  });

  test('never carries an action run, since it is not Action-backed', async () => {
    const store = counters({ deaths: 1 });
    const { dispatcher, runner } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths +1');

    expect(response.run).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  test('an operator-created /counter trigger takes precedence over the built-in', async () => {
    // The built-in is consulted only after the trigger lookup misses, so an operator
    // who wires their own /counter is never shadowed by it.
    const store = counters({ deaths: 1 });
    trigger({ kind: 'dashboard_slash', config: { command: '/counter', aliases: [] } });
    const { dispatcher, runner } = setup(store.deps);
    const response = await dispatcher.handleSlashCommand('/counter deaths +1');

    expect(runner.calls).toHaveLength(1);
    expect(response.message).toBe('/counter ran.');
    expect(store.values.deaths).toBe(1);
  });
});

describe('per-viewer trigger overrides', () => {
  function specialAction(name = 'Special action') {
    return createAction({
      name, description: '', enabled: true,
      steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'special', sender: 'bot' } }],
    }).id;
  }

  test('the override action runs instead of the base — never both', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-1', actor: 'Sorlus', login: 'sorlus' });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.actionId).toBe(specialId);
    expect(runs[0]!.actions[0]!.actionId).toBe(specialId);
  });

  test('other viewers and anonymous events take the base action', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-2', actor: 'Frodo', login: 'frodo' });
    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-3', actor: 'Anonymous', login: null });

    // Both matched the trigger; neither viewer has an override, so both ran the base.
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]!.actionId).toBe(actionId);
    expect(runner.calls[1]!.actionId).toBe(actionId);
  });

  test('a skipped override run falls back to the base action, once, same run row', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const calls: Array<{ actionId: string }> = [];
    const { dispatcher } = setup({
      runAction: async (id: string) => {
        calls.push({ actionId: id });
        // The special path's media is unavailable; the base action succeeds.
        const status = id === specialId ? 'skipped' as const : 'succeeded' as const;
        return { actionId: id, status, steps: [], ranAt: new Date().toISOString() };
      },
    });

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-4', actor: 'Sorlus', login: 'sorlus' });

    expect(calls.map(call => call.actionId)).toEqual([specialId, actionId]);
    expect(runs[0]!.actions[0]!.actionId).toBe(actionId);
    expect(runs[0]!.status).toBe('succeeded');
    // One claimed run row, its detail recording the substitution.
    const rows = db.prepare('select detail from automation_runs').all() as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toStartWith('Override for sorlus skipped; ran the base actions.');
  });

  test('the skip-fallback detail carries the override run\'s own skip reason', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const { dispatcher } = setup({
      runAction: async (id: string) => {
        if (id === specialId) {
          return {
            actionId: id,
            status: 'skipped' as const,
            steps: [{
              stepId: 's1',
              type: 'play_media' as const,
              status: 'skipped' as const,
              detail: 'No media asset for this step is available.',
            }],
            ranAt: new Date().toISOString(),
          };
        }
        return { actionId: id, status: 'succeeded' as const, steps: [], ranAt: new Date().toISOString() };
      },
    });

    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-9', actor: 'Sorlus', login: 'sorlus' });

    const rows = db.prepare('select detail from automation_runs').all() as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toStartWith(
      'Override for sorlus skipped (No media asset for this step is available.); ran the base actions.',
    );
  });

  test('a failed override run does NOT fall back — it may have broadcast', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const calls: string[] = [];
    const { dispatcher } = setup({
      runAction: async (id: string) => {
        calls.push(id);
        return { actionId: id, status: 'failed' as const, steps: [], ranAt: new Date().toISOString() };
      },
    });

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-5', actor: 'Sorlus', login: 'sorlus' });

    expect(calls).toEqual([specialId]);
    expect(runs[0]!.actions[0]!.actionId).toBe(specialId);
    expect(runs[0]!.status).toBe('failed');
  });

  test('a throwing override run does NOT fall back either', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const calls: string[] = [];
    const { dispatcher } = setup({
      runAction: async (id: string) => {
        calls.push(id);
        if (id === specialId) throw new Error('boom');
        return { actionId: id, status: 'succeeded' as const, steps: [], ranAt: new Date().toISOString() };
      },
    });

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-8', actor: 'Sorlus', login: 'sorlus' });

    expect(calls).toEqual([specialId]);
    expect(runs[0]!.status).toBe('failed');
  });

  test('the override run arms the base trigger cooldowns (shared throttle)', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' }, globalCooldownMs: 60_000 });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-6', actor: 'Sorlus', login: 'sorlus' });
    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-7', actor: 'Frodo', login: 'frodo' });

    // Frodo's generic alert is gated by the same trigger's global cooldown.
    expect(runner.calls).toHaveLength(1);
  });

  test('runTriggerManually with a login exercises the override path', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.runTriggerManually(created.id, { login: 'sorlus' });

    expect(runner.calls[0]!.actionId).toBe(specialId);
  });

  test('runTriggerManually strips a leading @ from the login before resolving the override', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.runTriggerManually(created.id, { login: '@sorlus' });

    expect(runner.calls[0]!.actionId).toBe(specialId);
  });
});

describe('trigger conditions', () => {
  function runCount(triggerId: string): number {
    return (db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(triggerId) as { n: number }).n;
  }

  test('a non-matching condition fires nothing — no run row, no cooldown consumed', async () => {
    const created = trigger({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'gte', value: 100 }],
      globalCooldownMs: 60_000,
    });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 50 });

    expect(runner.calls).toHaveLength(0);
    // The suppressed event claims no run row — which is also the proof no cooldown was
    // burned, since cooldowns are computed from automation_runs.
    expect(runCount(created.id)).toBe(0);

    // ...so a matching event immediately after is not gated by a phantom cooldown.
    await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e2', actor: 'bob', login: 'bob', amount: 150 });
    expect(runner.calls).toHaveLength(1);
  });

  test('a matching condition fires', async () => {
    trigger({ kind: 'twitch_event', config: { eventKind: 'cheer' }, conditions: [{ field: 'amount', op: 'gte', value: 100 }] });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 150 });

    expect(runner.calls).toHaveLength(1);
  });

  test('role_is fires for a sub in chat and not for a non-sub', async () => {
    trigger({
      kind: 'viewer_command',
      config: { command: '!cmd', aliases: [], roles: [] },
      conditions: [{ field: 'role', op: 'role_is', value: 'sub' }],
    });
    const { dispatcher, runner } = setup();

    // No subscriber badge → context.roles is empty → role_is 'sub' is false → nothing fires.
    await dispatcher.handleChatMessage(chat({ id: 'm1', message: '!cmd', badges: null }));
    expect(runner.calls).toHaveLength(0);

    // Subscriber badge → context.roles includes 'sub' → fires.
    await dispatcher.handleChatMessage(chat({ id: 'm2', message: '!cmd', badges: { subscriber: '1' } }));
    expect(runner.calls).toHaveLength(1);
  });

  test('role_is never passes off the chat path (twitch_event carries no roles)', async () => {
    // role_is is normally chat-only, but even a hand-tampered non-chat trigger cannot
    // pass it: the twitch_event builder sets no roles, so the resolved set is empty.
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'cheer' } });
    db.prepare('update automation_triggers set conditions_json = ? where id = ?')
      .run(JSON.stringify([{ field: 'role', op: 'role_is', value: 'sub' }]), created.id);
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 500 });

    expect(runner.calls).toHaveLength(0);
  });

  test('a manual run bypasses conditions and fires', async () => {
    // The amount condition would fail against the empty manual context (amount missing),
    // but a manual run sets enforceGates: false, so conditions are skipped entirely.
    const created = trigger({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'gte', value: 100 }],
    });
    const { dispatcher, runner } = setup();

    const result = await dispatcher.runTriggerManually(created.id);

    expect(result.status).not.toBe('skipped');
    expect(runner.calls).toHaveLength(1);
  });

  test('a non-array conditions_json fails closed without throwing', async () => {
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'cheer' } });
    // Manual DB tampering: syntactically valid JSON that is not an array.
    db.prepare('update automation_triggers set conditions_json = ? where id = ?').run('{}', created.id);
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 500 });

    expect(runner.calls).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(runCount(created.id)).toBe(0);
  });

  test('unparseable conditions_json fails closed without throwing', async () => {
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'cheer' } });
    db.prepare('update automation_triggers set conditions_json = ? where id = ?').run('{not json', created.id);
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 500 });

    expect(runner.calls).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });
});

describe('multi-action triggers', () => {
  function makeAction(name: string) {
    return createAction({
      name, description: '', enabled: true,
      steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'x', sender: 'bot' } }],
    }).id;
  }

  function triggerWithActions(actions: Array<{ actionId: string; enabled: boolean }>) {
    return trigger({
      kind: 'twitch_event',
      config: { eventKind: 'raid' },
      actions: actions.map((entry, index) => ({ actionId: entry.actionId, position: index, enabled: entry.enabled })),
    });
  }

  function raid(eventId: string, login: string | null = 'sorlus') {
    return { kind: 'raid' as const, eventId, actor: 'Sorlus', login };
  }

  function runCount(triggerId: string): number {
    return (db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(triggerId) as { n: number }).n;
  }

  test('runs every enabled action once and rolls up succeeded; exactly one run row', async () => {
    const a1 = actionId;
    const a2 = makeAction('A2');
    const a3 = makeAction('A3');
    const created = triggerWithActions([
      { actionId: a1, enabled: true },
      { actionId: a2, enabled: false },
      { actionId: a3, enabled: true },
    ]);
    const { dispatcher, runner } = setup();

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-1'));

    // a2 is disabled → skipped entirely; a1 and a3 each run exactly once.
    expect(runner.calls.map(call => call.actionId).sort()).toEqual([a1, a3].sort());
    expect(summaries[0]!.status).toBe('succeeded');
    expect(summaries[0]!.actions).toHaveLength(2);
    // The N-action fan-out claims ONE automation_runs row, not one per action: a
    // second claim would collide on the dedupe unique index and silently no-op.
    expect(runCount(created.id)).toBe(1);
  });

  test('a trigger with zero enabled actions never claims — no run row, no cooldown burned', async () => {
    const a2 = makeAction('A2');
    // A positive cooldown would leave a telltale row if the skip landed after the
    // claim; the assertion that no row exists is exactly the proof no cooldown was
    // consumed, because cooldowns are computed from automation_runs.
    const created = triggerWithActions([
      { actionId: actionId, enabled: false },
      { actionId: a2, enabled: false },
    ]);
    const { dispatcher, runner } = setup();

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-2'));

    expect(summaries).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(runCount(created.id)).toBe(0);
  });

  test('rolls up to partial when enabled actions have mixed outcomes', async () => {
    const a1 = actionId;
    const a2 = makeAction('A2');
    const created = triggerWithActions([
      { actionId: a1, enabled: true },
      { actionId: a2, enabled: true },
    ]);
    const { dispatcher } = setup({
      runAction: async (id: string): Promise<ActionRunResult> => ({
        actionId: id, status: id === a1 ? 'succeeded' : 'failed', steps: [], ranAt: new Date().toISOString(),
      }),
    });

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-3'));

    expect(summaries[0]!.status).toBe('partial');
    const row = db.prepare('select status from automation_runs where trigger_id = ?').get(created.id) as { status: string };
    expect(row.status).toBe('partial');
    expect(runCount(created.id)).toBe(1);
  });

  test('rolls up to failed when every enabled action fails', async () => {
    const a2 = makeAction('A2');
    const created = triggerWithActions([
      { actionId: actionId, enabled: true },
      { actionId: a2, enabled: true },
    ]);
    const { dispatcher } = setup({
      runAction: async (id: string): Promise<ActionRunResult> => ({ actionId: id, status: 'failed', steps: [], ranAt: new Date().toISOString() }),
    });

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-4'));

    expect(summaries[0]!.status).toBe('failed');
    expect(runCount(created.id)).toBe(1);
  });

  test('rolls up to skipped when every enabled action skips (a skipped run broadcasts nothing)', async () => {
    const a2 = makeAction('A2');
    const created = triggerWithActions([
      { actionId: actionId, enabled: true },
      { actionId: a2, enabled: true },
    ]);
    const { dispatcher } = setup({
      runAction: async (id: string): Promise<ActionRunResult> => ({ actionId: id, status: 'skipped', steps: [], ranAt: new Date().toISOString() }),
    });

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-5'));

    expect(summaries[0]!.status).toBe('skipped');
    expect(runCount(created.id)).toBe(1);
  });

  test('an override replaces the whole enabled list with the single override action', async () => {
    const a1 = actionId;
    const a2 = makeAction('A2');
    const special = makeAction('Special');
    const created = triggerWithActions([
      { actionId: a1, enabled: true },
      { actionId: a2, enabled: true },
    ]);
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: special, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-ovr-1'));

    // Only the override runs — never the base list, and still under one claimed row.
    expect(runner.calls.map(call => call.actionId)).toEqual([special]);
    expect(summaries[0]!.actions.map(result => result.actionId)).toEqual([special]);
    expect(runCount(created.id)).toBe(1);
  });

  test('a skipped override falls back to the FULL base list, once, under one run row', async () => {
    const a1 = actionId;
    const a2 = makeAction('A2');
    const special = makeAction('Special');
    const created = triggerWithActions([
      { actionId: a1, enabled: true },
      { actionId: a2, enabled: true },
    ]);
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: special, enabled: true, note: '' });

    const calls: string[] = [];
    const { dispatcher } = setup({
      runAction: async (id: string): Promise<ActionRunResult> => {
        calls.push(id);
        return { actionId: id, status: id === special ? 'skipped' : 'succeeded', steps: [], ranAt: new Date().toISOString() };
      },
    });

    const summaries = await dispatcher.handleTwitchEvent(raid('evt-multi-ovr-2'));

    // The override runs first and skips; the base list (a1, a2) then delivers, once each.
    expect(calls).toEqual([special, a1, a2]);
    expect(summaries[0]!.status).toBe('succeeded');
    expect(summaries[0]!.actions.map(result => result.actionId)).toEqual([a1, a2]);
    expect(runCount(created.id)).toBe(1);
    const row = db.prepare('select detail from automation_runs where trigger_id = ?').get(created.id) as { detail: string };
    expect(row.detail).toStartWith('Override for sorlus skipped; ran the base actions.');
  });
});
