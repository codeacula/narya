import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_USER_COOLDOWN_MS } from '../shared/api';
import { createAction } from './actions';
import { createApp, declareAppEvent } from './apps';
import {
  createAutomationTrigger,
  deleteAutomationTrigger,
  getAutomationTrigger,
  listAutomationTriggers,
  listEnabledTriggersOfKind,
  normalizeAutomationTriggerInput,
  seedBuiltInSlashCommands,
  updateAutomationTrigger,
} from './automationTriggers';
import { db } from './db';
import { HttpRouteError } from './http';
import { CONDITIONS_UNREADABLE } from './triggerConditions';

let actionId = '';

function input(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'chat_phrase',
    name: 'Test trigger',
    moduleId: null,
    enabled: true,
    globalCooldownMs: 1000,
    userCooldownMs: 2000,
    config: { phrase: 'hype', match: 'contains', roles: [] },
    actions: [{ actionId, position: 0, enabled: true }],
    conditions: [],
    ...overrides,
  };
}

beforeEach(() => {
  db.exec('delete from automation_runs');
  db.exec('delete from automation_triggers');
  db.exec('delete from category_modules');
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  actionId = createAction({
    name: 'Test action',
    description: '',
    enabled: true,
    steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
  }).id;
});

describe('normalizeAutomationTriggerInput', () => {
  test('rejects an unknown kind', () => {
    expect(() => normalizeAutomationTriggerInput(input({ kind: 'telepathy' })))
      .toThrow('Unsupported trigger kind');
  });

  test('rejects a missing kind', () => {
    expect(() => normalizeAutomationTriggerInput(input({ kind: undefined }))).toThrow('Unsupported trigger kind');
  });

  test('rejects an action id that does not exist', () => {
    expect(() => normalizeAutomationTriggerInput(input({ actions: [{ actionId: 'nope', position: 0, enabled: true }] })))
      .toThrow('Action not found.');
  });

  test('rejects a module id that does not exist', () => {
    expect(() => normalizeAutomationTriggerInput(input({ moduleId: 'nope' }))).toThrow('Module not found.');
  });

  test('defaults the cooldowns to the shared constants', () => {
    const result = normalizeAutomationTriggerInput(input({ globalCooldownMs: undefined, userCooldownMs: undefined }));
    expect(result.globalCooldownMs).toBe(DEFAULT_GLOBAL_COOLDOWN_MS);
    expect(result.userCooldownMs).toBe(DEFAULT_USER_COOLDOWN_MS);
  });

  test('keeps a zero cooldown instead of falling back to the default', () => {
    const result = normalizeAutomationTriggerInput(input({ globalCooldownMs: 0, userCooldownMs: 0 }));
    expect(result.globalCooldownMs).toBe(0);
    expect(result.userCooldownMs).toBe(0);
  });

  test('rejects a negative cooldown', () => {
    expect(() => normalizeAutomationTriggerInput(input({ globalCooldownMs: -1 }))).toThrow('Cooldowns');
  });

  describe('chat_phrase', () => {
    test('rejects an empty phrase', () => {
      expect(() => normalizeAutomationTriggerInput(input({ config: { phrase: '  ', match: 'contains', roles: [] } })))
        .toThrow('phrase');
    });

    test('rejects an unknown match mode', () => {
      expect(() => normalizeAutomationTriggerInput(input({ config: { phrase: 'hype', match: 'regex', roles: [] } })))
        .toThrow('match');
    });

    test('rejects an unknown role', () => {
      expect(() => normalizeAutomationTriggerInput(input({ config: { phrase: 'hype', match: 'exact', roles: ['admin'] } })))
        .toThrow('role');
    });

    test('accepts a valid phrase config and defaults roles to empty', () => {
      const result = normalizeAutomationTriggerInput(input({ config: { phrase: ' Hype ', match: 'exact' } }));
      expect(result.kind).toBe('chat_phrase');
      if (result.kind !== 'chat_phrase') throw new Error('unreachable');
      expect(result.config.phrase).toBe('Hype');
      expect(result.config.roles).toEqual([]);
    });
  });

  describe('viewer_command', () => {
    test('normalizes the trigger word to a lowercase !command', () => {
      const result = normalizeAutomationTriggerInput(input({
        kind: 'viewer_command',
        config: { command: 'Hype', aliases: ['!H'], roles: [] },
      }));
      if (result.kind !== 'viewer_command') throw new Error('unreachable');
      expect(result.config.command).toBe('!hype');
      expect(result.config.aliases).toEqual(['!h']);
    });

    test('rejects a command with a space in it', () => {
      expect(() => normalizeAutomationTriggerInput(input({
        kind: 'viewer_command',
        config: { command: '!two words', aliases: [], roles: [] },
      }))).toThrow('Commands');
    });
  });

  describe('dashboard_slash', () => {
    test('normalizes the trigger word to a lowercase /command', () => {
      const result = normalizeAutomationTriggerInput(input({
        kind: 'dashboard_slash',
        config: { command: 'Shoutout', aliases: ['SO'] },
      }));
      if (result.kind !== 'dashboard_slash') throw new Error('unreachable');
      expect(result.config.command).toBe('/shoutout');
      expect(result.config.aliases).toEqual(['/so']);
    });

    test('rejects an empty command', () => {
      expect(() => normalizeAutomationTriggerInput(input({ kind: 'dashboard_slash', config: { command: '/', aliases: [] } })))
        .toThrow('Commands');
    });
  });

  describe('reward and twitch_event', () => {
    test('rejects a reward config without a reward id', () => {
      expect(() => normalizeAutomationTriggerInput(input({ kind: 'reward', config: {} }))).toThrow('reward');
    });

    test('rejects an unknown twitch event kind', () => {
      expect(() => normalizeAutomationTriggerInput(input({ kind: 'twitch_event', config: { eventKind: 'boop' } })))
        .toThrow('event');
    });

    test('accepts every supported event kind', () => {
      for (const eventKind of ['follow', 'sub', 'gift', 'cheer', 'raid']) {
        const result = normalizeAutomationTriggerInput(input({ kind: 'twitch_event', config: { eventKind } }));
        expect(result.kind).toBe('twitch_event');
      }
    });
  });

  describe('manual', () => {
    test('rejects an empty label', () => {
      expect(() => normalizeAutomationTriggerInput(input({ kind: 'manual', config: { label: '' } }))).toThrow('label');
    });
  });

  describe('redis_event', () => {
    beforeEach(() => {
      db.exec('delete from app_events');
      db.exec('delete from apps');
    });

    test('accepts a declared (appId, eventName) pair', () => {
      const app = createApp('pztmi');
      declareAppEvent(app.id, 'boss_killed');

      const result = normalizeAutomationTriggerInput(input({
        kind: 'redis_event',
        config: { appId: app.id, eventName: 'boss_killed' },
      }));
      expect(result.kind).toBe('redis_event');
      if (result.kind !== 'redis_event') throw new Error('unreachable');
      expect(result.config).toEqual({ appId: app.id, eventName: 'boss_killed' });
    });

    test('rejects an unknown appId', () => {
      expect(() => normalizeAutomationTriggerInput(input({
        kind: 'redis_event',
        config: { appId: 'nope', eventName: 'boss_killed' },
      }))).toThrow('App not found.');
    });

    test('rejects an undeclared eventName', () => {
      const app = createApp('pztmi');

      expect(() => normalizeAutomationTriggerInput(input({
        kind: 'redis_event',
        config: { appId: app.id, eventName: 'never_declared' },
      }))).toThrow('is not a declared event for that app');
    });
  });
});

describe('crud', () => {
  test('creates, reads back, and lists a trigger', () => {
    const created = createAutomationTrigger(input());
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe('chat_phrase');

    const loaded = getAutomationTrigger(created.id);
    expect(loaded?.id).toBe(created.id);
    if (loaded?.kind !== 'chat_phrase') throw new Error('unreachable');
    expect(loaded.config.phrase).toBe('hype');
    expect(listAutomationTriggers()).toHaveLength(1);
  });

  test('updates a trigger in place', () => {
    const created = createAutomationTrigger(input());
    const updated = updateAutomationTrigger(created.id, input({
      enabled: false,
      config: { phrase: 'raid', match: 'exact', roles: ['mod'] },
    }));

    expect(updated.id).toBe(created.id);
    expect(updated.enabled).toBe(false);
    if (updated.kind !== 'chat_phrase') throw new Error('unreachable');
    expect(updated.config.phrase).toBe('raid');
    expect(updated.config.roles).toEqual(['mod']);
  });

  test('rejects an update to an unknown trigger', () => {
    expect(() => updateAutomationTrigger('nope', input())).toThrow(HttpRouteError);
  });

  test('deletes a trigger', () => {
    const created = createAutomationTrigger(input());
    deleteAutomationTrigger(created.id);
    expect(getAutomationTrigger(created.id)).toBeNull();
  });

  test('rejects deleting an unknown trigger', () => {
    expect(() => deleteAutomationTrigger('nope')).toThrow('Trigger not found.');
  });

  test('a redis_event trigger persists {appId, eventName} and reads it back', () => {
    db.exec('delete from app_events');
    db.exec('delete from apps');
    const app = createApp('pztmi');
    declareAppEvent(app.id, 'boss_killed');

    const created = createAutomationTrigger(input({
      kind: 'redis_event',
      config: { appId: app.id, eventName: 'boss_killed' },
    }));
    expect(created.kind).toBe('redis_event');
    if (created.kind !== 'redis_event') throw new Error('unreachable');
    expect(created.config).toEqual({ appId: app.id, eventName: 'boss_killed' });

    const loaded = getAutomationTrigger(created.id);
    if (loaded?.kind !== 'redis_event') throw new Error('unreachable');
    expect(loaded.config).toEqual({ appId: app.id, eventName: 'boss_killed' });
  });

  test('deleting an action cascades to its triggers', () => {
    const created = createAutomationTrigger(input());
    db.prepare('delete from actions where id = ?').run(actionId);
    expect(getAutomationTrigger(created.id)).toBeNull();
  });

  test('listEnabledTriggersOfKind skips disabled triggers and other kinds', () => {
    createAutomationTrigger(input());
    createAutomationTrigger(input({ enabled: false }));
    createAutomationTrigger(input({ kind: 'manual', config: { label: 'Intermission' } }));

    const enabled = listEnabledTriggersOfKind('chat_phrase');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.enabled).toBe(true);
  });
});

describe('actions[]', () => {
  let act1 = '';
  let act2 = '';

  beforeEach(() => {
    act1 = actionId;
    act2 = createAction({
      name: 'Second action',
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    }).id;
  });

  test('a trigger persists N ordered actions and reads them back', () => {
    const trigger = createAutomationTrigger({
      kind: 'manual',
      name: 'My combo',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: [{ actionId: act1, position: 0, enabled: true }, { actionId: act2, position: 1, enabled: false }],
    });

    expect(trigger.name).toBe('My combo');
    expect(trigger.actions).toEqual([
      { actionId: act1, position: 0, enabled: true },
      { actionId: act2, position: 1, enabled: false },
    ]);
    // legacy column tracks actions[0]
    const row = db.prepare('select action_id as a from automation_triggers where id = ?').get(trigger.id) as { a: string };
    expect(row.a).toBe(act1);

    const reloaded = getAutomationTrigger(trigger.id);
    expect(reloaded?.actions).toEqual([
      { actionId: act1, position: 0, enabled: true },
      { actionId: act2, position: 1, enabled: false },
    ]);
  });

  test('an update replaces the action list rather than appending to it', () => {
    const created = createAutomationTrigger({
      kind: 'manual',
      name: 'My combo',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: [{ actionId: act1, position: 0, enabled: true }, { actionId: act2, position: 1, enabled: false }],
    });

    const updated = updateAutomationTrigger(created.id, {
      kind: 'manual',
      name: 'My combo',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: [{ actionId: act2, position: 0, enabled: true }],
    });

    expect(updated.actions).toEqual([{ actionId: act2, position: 0, enabled: true }]);
    const row = db.prepare('select action_id as a from automation_triggers where id = ?').get(created.id) as { a: string };
    expect(row.a).toBe(act2);
  });

  test('rejects an empty actions[] and a duplicate action', () => {
    expect(() => createAutomationTrigger({
      kind: 'manual',
      name: 'n',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: [],
    })).toThrow(/at least one action/i);

    expect(() => createAutomationTrigger({
      kind: 'manual',
      name: 'n',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: [{ actionId: act1, position: 0, enabled: true }, { actionId: act1, position: 1, enabled: true }],
    })).toThrow();
  });

  test('rejects more than the per-trigger action cap', () => {
    // 21 distinct, existing actions — one over the cap. Each must exist and be unique
    // or the "not found" / "listed once" checks would fire before the cap check does.
    const manyActionIds = Array.from({ length: 21 }, (_, index) => createAction({
      name: `Cap action ${index}`,
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    }).id);

    expect(() => createAutomationTrigger({
      kind: 'manual',
      name: 'n',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'x' },
      actions: manyActionIds.map((id, position) => ({ actionId: id, position, enabled: true })),
    })).toThrow(/at most 20 actions/i);
  });
});

describe('conditions[]', () => {
  test('conditions persist and read back; invalid ones are rejected', () => {
    const created = createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'gte', value: 100 }],
    }));
    expect(created.conditions).toEqual([{ field: 'amount', op: 'gte', value: 100 }]);

    const reloaded = getAutomationTrigger(created.id);
    expect(reloaded?.conditions).toEqual([{ field: 'amount', op: 'gte', value: 100 }]);

    // unknown field is rejected
    expect(() => createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'nope', op: 'eq', value: 'x' }],
    }))).toThrow(HttpRouteError);

    // unknown op is rejected
    expect(() => createAutomationTrigger(input({
      conditions: [{ field: 'message', op: 'matches', value: 'x' }],
    }))).toThrow(HttpRouteError);
  });

  test('role_is and tag_has are only valid on chat kinds', () => {
    // 'reward' is not a chat kind — rejected even though the op itself is well-formed.
    expect(() => createAutomationTrigger(input({
      kind: 'reward',
      config: { rewardId: 'reward-1' },
      conditions: [{ field: 'role', op: 'role_is', value: 'sub' }],
    }))).toThrow(HttpRouteError);

    // chat_phrase (the input() default kind) is a chat kind — accepted.
    const created = createAutomationTrigger(input({
      conditions: [{ field: 'role', op: 'role_is', value: 'sub' }],
    }));
    expect(created.conditions).toEqual([{ field: 'role', op: 'role_is', value: 'sub' }]);
  });

  test('rejects a comparison op whose value has the wrong shape', () => {
    expect(() => createAutomationTrigger(input({
      conditions: [{ field: 'message', op: 'gte', value: 'not-a-number' }],
    }))).toThrow(HttpRouteError);

    expect(() => createAutomationTrigger(input({
      conditions: [{ field: 'message', op: 'in', value: [] }],
    }))).toThrow(HttpRouteError);
  });

  test('rejects more than the per-trigger condition cap', () => {
    const conditions = Array.from({ length: 11 }, () => ({ field: 'message', op: 'contains', value: 'x' }));
    expect(() => createAutomationTrigger(input({ conditions }))).toThrow(/at most 10 conditions/i);
  });

  // Fail-open regression: Number('1e999') / Number('Infinity') pass !Number.isNaN,
  // and JSON.stringify(Infinity) === 'null', so the stored condition read back as
  // `Number(null) === 0` — an "amount gte <huge>" filter silently became always-true.
  test('rejects a gte/lte value that coerces to a non-finite number', () => {
    expect(() => createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'gte', value: '1e999' }],
    }))).toThrow(HttpRouteError);

    expect(() => createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'lte', value: 'Infinity' }],
    }))).toThrow(HttpRouteError);
  });

  // Number('') === 0 and Number('   ') === 0, so a blank/whitespace value used to
  // pass validation too and become an always-true "gte 0" filter instead of an error.
  test('rejects a gte/lte value that is empty or whitespace-only', () => {
    expect(() => createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'gte', value: '' }],
    }))).toThrow(HttpRouteError);

    expect(() => createAutomationTrigger(input({
      kind: 'twitch_event',
      config: { eventKind: 'cheer' },
      conditions: [{ field: 'amount', op: 'lte', value: '   ' }],
    }))).toThrow(HttpRouteError);
  });

  test('a trigger with unreadable conditions_json reads back the fail-closed sentinel', () => {
    const created = createAutomationTrigger(input());
    db.prepare('update automation_triggers set conditions_json = ? where id = ?').run('{bad json', created.id);
    expect(getAutomationTrigger(created.id)!.conditions).toBe(CONDITIONS_UNREADABLE);
  });

  describe('data.* fields on redis_event', () => {
    beforeEach(() => {
      db.exec('delete from app_events');
      db.exec('delete from apps');
    });

    test('a redis_event trigger with a data.wave gte 5 condition round-trips', () => {
      const app = createApp('pztmi');
      declareAppEvent(app.id, 'boss_killed');

      const created = createAutomationTrigger(input({
        kind: 'redis_event',
        config: { appId: app.id, eventName: 'boss_killed' },
        conditions: [{ field: 'data.wave', op: 'gte', value: 5 }],
      }));
      expect(created.conditions).toEqual([{ field: 'data.wave', op: 'gte', value: 5 }]);

      const reloaded = getAutomationTrigger(created.id);
      expect(reloaded?.conditions).toEqual([{ field: 'data.wave', op: 'gte', value: 5 }]);
    });

    test('a malformed data. field is rejected', () => {
      const app = createApp('pztmi');
      declareAppEvent(app.id, 'boss_killed');

      expect(() => createAutomationTrigger(input({
        kind: 'redis_event',
        config: { appId: app.id, eventName: 'boss_killed' },
        conditions: [{ field: 'data.a b', op: 'eq', value: 'x' }],
      }))).toThrow(HttpRouteError);
    });

    test('a data.* field on a non-redis kind is still rejected', () => {
      expect(() => createAutomationTrigger(input({
        kind: 'reward',
        config: { rewardId: 'reward-1' },
        conditions: [{ field: 'data.wave', op: 'gte', value: 5 }],
      }))).toThrow(HttpRouteError);
    });
  });
});

describe('seedBuiltInSlashCommands', () => {
  beforeEach(() => {
    // runOnce is once per database; clear the ledger so the seed is exercisable here.
    db.exec("delete from schema_migrations where id like 'seed-builtin%'");
  });

  test('seeds shoutout, whisper, timeout, and ban as editable rows', () => {
    seedBuiltInSlashCommands();

    const triggers = listEnabledTriggersOfKind('dashboard_slash');
    expect(triggers).toHaveLength(4);

    const byCommand = new Map(triggers.map(item => {
      if (item.kind !== 'dashboard_slash') throw new Error('unreachable');
      return [item.config.command, item];
    }));
    expect([...byCommand.keys()].sort()).toEqual(['/ban', '/shoutout', '/timeout', '/whisper']);

    const shoutout = byCommand.get('/shoutout');
    if (shoutout?.kind !== 'dashboard_slash') throw new Error('unreachable');
    expect(shoutout.config.aliases).toEqual(['/so']);

    const whisper = byCommand.get('/whisper');
    if (whisper?.kind !== 'dashboard_slash') throw new Error('unreachable');
    expect(whisper.config.aliases).toEqual(['/w']);

    // Operator commands must not be rate limited: /timeout one viewer then another.
    for (const item of triggers) {
      expect(item.globalCooldownMs).toBe(0);
      expect(item.userCooldownMs).toBe(0);
      expect(item.moduleId).toBeNull();
    }
  });

  test('the seeded timeout binds its duration from the invocation, not a stored constant', () => {
    seedBuiltInSlashCommands();

    const triggers = listEnabledTriggersOfKind('dashboard_slash');
    const timeout = triggers.find(item => item.kind === 'dashboard_slash' && item.config.command === '/timeout');
    expect(timeout).toBeDefined();

    const steps = db.prepare('select step_type as stepType, payload_json as payloadJson from action_steps where action_id = ?')
      .all(timeout!.actions[0]!.actionId) as { stepType: string; payloadJson: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepType).toBe('twitch_timeout');
    // `/timeout bob 300 spam` must actually time bob out for 300s. A stored number
    // would silently ignore the operator's duration and swallow it into the reason.
    expect(JSON.parse(steps[0]!.payloadJson)).toMatchObject({
      loginTemplate: '{arg1}',
      secondsTemplate: '{arg2}',
      reasonTemplate: '{rest2}',
    });
  });

  test('is idempotent — a second call seeds nothing new', () => {
    seedBuiltInSlashCommands();
    seedBuiltInSlashCommands();

    expect(listEnabledTriggersOfKind('dashboard_slash')).toHaveLength(4);
  });

  test('does not collide with an action the operator already named "Shoutout"', () => {
    createAction({ name: 'Shoutout', description: '', enabled: true, steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }] });

    expect(() => seedBuiltInSlashCommands()).not.toThrow();
    expect(listEnabledTriggersOfKind('dashboard_slash')).toHaveLength(4);
  });

  test('writes exactly one join row (position 0, enabled) and a non-empty name for each seeded trigger', () => {
    seedBuiltInSlashCommands();

    const triggers = listEnabledTriggersOfKind('dashboard_slash');
    expect(triggers).toHaveLength(4);
    for (const trigger of triggers) {
      expect(trigger.name.trim().length).toBeGreaterThan(0);
      expect(trigger.actions).toHaveLength(1);
      expect(trigger.actions[0]).toMatchObject({ position: 0, enabled: true });
      expect(trigger.actions[0]!.actionId.length).toBeGreaterThan(0);
    }
  });
});
