import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_USER_COOLDOWN_MS } from '../shared/api';
import { createAction } from './actions';
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

let actionId = '';

function input(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'chat_phrase',
    actionId,
    moduleId: null,
    enabled: true,
    globalCooldownMs: 1000,
    userCooldownMs: 2000,
    config: { phrase: 'hype', match: 'contains', roles: [] },
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
    expect(() => normalizeAutomationTriggerInput(input({ actionId: 'nope' }))).toThrow('Action not found.');
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

  test('the seeded timeout defaults to 600 seconds, matching the retired client parser', () => {
    seedBuiltInSlashCommands();

    const triggers = listEnabledTriggersOfKind('dashboard_slash');
    const timeout = triggers.find(item => item.kind === 'dashboard_slash' && item.config.command === '/timeout');
    expect(timeout).toBeDefined();

    const steps = db.prepare('select step_type as stepType, payload_json as payloadJson from action_steps where action_id = ?')
      .all(timeout!.actionId) as { stepType: string; payloadJson: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepType).toBe('twitch_timeout');
    expect(JSON.parse(steps[0]!.payloadJson).seconds).toBe(600);
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
});
