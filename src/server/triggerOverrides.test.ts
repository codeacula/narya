import { beforeEach, describe, expect, test } from 'bun:test';
import { createAction } from './actions';
import { createAutomationTrigger } from './automationTriggers';
import { db } from './db';
import {
  deleteOverridesForLogin,
  deleteTriggerOverride,
  listTriggerOverrides,
  resolveOverrideActionId,
  upsertTriggerOverride,
} from './triggerOverrides';

let baseActionId = '';
let specialActionId = '';
let triggerId = '';

beforeEach(() => {
  db.exec('delete from trigger_overrides');
  db.exec('delete from automation_runs');
  db.exec('delete from automation_triggers');
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  db.exec('delete from ignored_logins');

  baseActionId = createAction({
    name: 'Base alert', description: '', enabled: true,
    steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'hi {actor}', sender: 'bot' } }],
  }).id;
  specialActionId = createAction({
    name: 'Special alert', description: '', enabled: true,
    steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'HI {actor}!!', sender: 'bot' } }],
  }).id;
  triggerId = createAutomationTrigger({
    kind: 'twitch_event', actionId: baseActionId, moduleId: null, enabled: true,
    globalCooldownMs: 0, userCooldownMs: 0, config: { eventKind: 'sub' },
  }).id;
});

describe('upsertTriggerOverride', () => {
  test('creates, normalizes the login, and reads back', () => {
    const saved = upsertTriggerOverride(triggerId, { login: '@Sorlus', actionId: specialActionId, enabled: true, note: '' });

    expect(saved.login).toBe('sorlus');
    expect(saved.triggerId).toBe(triggerId);
    expect(saved.actionId).toBe(specialActionId);
    expect(listTriggerOverrides()).toHaveLength(1);
  });

  test('same login upserts in place — the unique constraint is not a 500', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    const second = upsertTriggerOverride(triggerId, { login: 'SORLUS', actionId: baseActionId, enabled: false, note: 'off for now' });

    expect(listTriggerOverrides()).toHaveLength(1);
    expect(second.actionId).toBe(baseActionId);
    expect(second.enabled).toBe(false);
    expect(second.note).toBe('off for now');
  });

  test('rejects a bad login, a missing action, an unknown trigger, and a non-actor kind', () => {
    expect(() => upsertTriggerOverride(triggerId, { login: 'has spaces', actionId: specialActionId, enabled: true, note: '' })).toThrow();
    expect(() => upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: 'nope', enabled: true, note: '' })).toThrow();
    expect(() => upsertTriggerOverride('nope', { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' })).toThrow();

    const manual = createAutomationTrigger({
      kind: 'manual', actionId: baseActionId, moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0, config: { label: 'Button' },
    });
    expect(() => upsertTriggerOverride(manual.id, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' })).toThrow();
  });

  test('rejects a flushed (ignored) login', () => {
    db.prepare('insert into ignored_logins (login, reason, created_at) values (?, ?, ?)')
      .run('spambot', '', new Date().toISOString());
    expect(() => upsertTriggerOverride(triggerId, { login: 'spambot', actionId: specialActionId, enabled: true, note: '' })).toThrow();
  });
});

describe('resolveOverrideActionId', () => {
  test('resolves an enabled override whose action is enabled', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBe(specialActionId);
  });

  test('returns null for other viewers, empty logins, disabled overrides, and disabled actions', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(resolveOverrideActionId(triggerId, 'someoneelse')).toBeNull();
    expect(resolveOverrideActionId(triggerId, '')).toBeNull();

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: false, note: '' });
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBeNull();

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    db.prepare('update actions set enabled = 0 where id = ?').run(specialActionId);
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBeNull();
  });
});

describe('cascades and deletion', () => {
  test('deleting the trigger removes its overrides; deleting the override action removes the override', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    db.prepare('delete from actions where id = ?').run(specialActionId);
    expect(listTriggerOverrides()).toHaveLength(0);

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: baseActionId, enabled: true, note: '' });
    db.prepare('delete from automation_triggers where id = ?').run(triggerId);
    expect(listTriggerOverrides()).toHaveLength(0);
  });

  test('deleteTriggerOverride removes one; unknown id is a 404', () => {
    const saved = upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    deleteTriggerOverride(saved.id);
    expect(listTriggerOverrides()).toHaveLength(0);
    expect(() => deleteTriggerOverride(saved.id)).toThrow();
  });

  test('deleteOverridesForLogin reports the count', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(deleteOverridesForLogin('sorlus')).toBe(1);
    expect(deleteOverridesForLogin('sorlus')).toBe(0);
  });
});
