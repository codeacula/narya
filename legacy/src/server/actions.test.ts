import { beforeEach, describe, expect, test } from 'bun:test';
import type { ActionStepInput } from '../shared/api';
import {
  createAction,
  deleteAction,
  getActionById,
  listActions,
  normalizeActionUpsert,
  updateAction,
} from './actions';
import { db } from './db';
import { HttpRouteError } from './http';

function step(overrides: Partial<ActionStepInput> = {}): ActionStepInput {
  return {
    type: 'send_chat',
    enabled: true,
    delayMs: 0,
    payload: { template: 'hi {actor}', sender: 'bot' },
    ...overrides,
  } as ActionStepInput;
}

function upsert(steps: ActionStepInput[] = [step()], overrides: Record<string, unknown> = {}) {
  return { name: 'Test action', description: '', enabled: true, steps, ...overrides };
}

beforeEach(() => {
  db.exec('delete from action_steps');
  db.exec('delete from actions');
});

describe('normalizeActionUpsert', () => {
  test('accepts a valid action and trims the name', () => {
    const result = normalizeActionUpsert(upsert([step()], { name: '  Raid hype  ' }));
    expect(result.name).toBe('Raid hype');
    expect(result.enabled).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  test('rejects a missing name', () => {
    expect(() => normalizeActionUpsert(upsert([step()], { name: '   ' }))).toThrow('Action name is required.');
  });

  test('rejects an empty step list', () => {
    expect(() => normalizeActionUpsert(upsert([]))).toThrow('At least one step is required.');
  });

  test('rejects an unknown step type', () => {
    expect(() => normalizeActionUpsert(upsert([step({ type: 'launch_missiles' } as never)])))
      .toThrow('Unsupported action step: launch_missiles.');
  });

  test('rejects a negative delay', () => {
    expect(() => normalizeActionUpsert(upsert([step({ delayMs: -1 })]))).toThrow('Step delay');
  });

  test('defaults enabled to true and delay to zero', () => {
    const result = normalizeActionUpsert(upsert([
      { type: 'obs_transition', payload: {} } as unknown as ActionStepInput,
    ]));
    expect(result.steps[0]!.enabled).toBe(true);
    expect(result.steps[0]!.delayMs).toBe(0);
  });

  describe('per-type payload validation', () => {
    test('show_text requires a template and a known style', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'show_text', payload: { template: '', durationMs: 5000, style: 'banner' } } as never),
      ]))).toThrow('Text steps need a template.');

      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'show_text', payload: { template: 'hi', durationMs: 5000, style: 'sideways' } } as never),
      ]))).toThrow('Unsupported text style');
    });

    test('show_text clamps duration into the allowed range', () => {
      const long = normalizeActionUpsert(upsert([
        step({ type: 'show_text', payload: { template: 'hi', durationMs: 999_999, style: 'toast' } } as never),
      ]));
      expect(long.steps[0]!.payload).toEqual({ template: 'hi', durationMs: 60_000, style: 'toast' });

      const short = normalizeActionUpsert(upsert([
        step({ type: 'show_text', payload: { template: 'hi', durationMs: 5, style: 'toast' } } as never),
      ]));
      expect((short.steps[0]!.payload as { durationMs: number }).durationMs).toBe(1000);
    });

    test('play_media requires at least one asset and a known selection', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'play_media', payload: { assetIds: [], selection: 'first' } } as never),
      ]))).toThrow('Media steps need at least one asset.');

      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'play_media', payload: { assetIds: ['a'], selection: 'shuffle' } } as never),
      ]))).toThrow('Unsupported media selection');
    });

    test('play_media clamps an out-of-range volume and drops an absent one', () => {
      const loud = normalizeActionUpsert(upsert([
        step({ type: 'play_media', payload: { assetIds: ['a'], selection: 'random', volume: 4 } } as never),
      ]));
      expect(loud.steps[0]!.payload).toEqual({ assetIds: ['a'], selection: 'random', volume: 1 });

      const unset = normalizeActionUpsert(upsert([
        step({ type: 'play_media', payload: { assetIds: ['a'], selection: 'first' } } as never),
      ]));
      expect(unset.steps[0]!.payload).toEqual({ assetIds: ['a'], selection: 'first' });
    });

    test('send_chat requires a template and a known sender', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'send_chat', payload: { template: '  ', sender: 'bot' } } as never),
      ]))).toThrow('Chat steps need a message.');

      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'send_chat', payload: { template: 'hi', sender: 'moderator' } } as never),
      ]))).toThrow('Unsupported chat sender');
    });

    test('send_chat rejects a message longer than Twitch allows', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'send_chat', payload: { template: 'x'.repeat(501), sender: 'bot' } } as never),
      ]))).toThrow('500 characters or fewer');
    });

    test('obs_scene requires a scene name', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'obs_scene', payload: { sceneName: '' } } as never),
      ]))).toThrow('OBS scene steps need a scene name.');
    });

    test('obs_transition accepts an empty payload', () => {
      const result = normalizeActionUpsert(upsert([step({ type: 'obs_transition', payload: {} } as never)]));
      expect(result.steps[0]!.payload).toEqual({});
    });

    test('twitch steps require a login template', () => {
      for (const type of ['twitch_shoutout', 'twitch_whisper', 'twitch_timeout', 'twitch_ban']) {
        expect(() => normalizeActionUpsert(upsert([
          step({ type, payload: { loginTemplate: '', template: 'x', seconds: 60, reasonTemplate: '' } } as never),
        ]))).toThrow('need a target login.');
      }
    });

    test('twitch_whisper requires a message', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'twitch_whisper', payload: { loginTemplate: '{login}', template: '' } } as never),
      ]))).toThrow('Whisper steps need a message.');
    });

    test('twitch_timeout rejects a duration outside the Twitch limits', () => {
      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'twitch_timeout', payload: { loginTemplate: '{login}', secondsTemplate: '0', reasonTemplate: '' } } as never),
      ]))).toThrow('Timeout duration');

      expect(() => normalizeActionUpsert(upsert([
        step({ type: 'twitch_timeout', payload: { loginTemplate: '{login}', secondsTemplate: '1209601', reasonTemplate: '' } } as never),
      ]))).toThrow('Timeout duration');
    });

    test('tts_speak and llm_response require a template', () => {
      expect(() => normalizeActionUpsert(upsert([step({ type: 'tts_speak', payload: { template: '' } } as never)])))
        .toThrow('TTS steps need a template.');
      expect(() => normalizeActionUpsert(upsert([step({ type: 'llm_response', payload: { template: '' } } as never)])))
        .toThrow('LLM steps need a prompt.');
    });
  });
});

describe('actions persistence', () => {
  test('creates an action and stores step position from array order', () => {
    const created = createAction(upsert([
      step({ payload: { template: 'one', sender: 'bot' } } as never),
      step({ type: 'obs_transition', payload: {} } as never),
      step({ type: 'show_text', payload: { template: 'three', durationMs: 4000, style: 'banner' } } as never),
    ]));

    expect(created.steps).toHaveLength(3);
    expect(created.steps.map(s => s.position)).toEqual([0, 1, 2]);
    expect(created.steps.map(s => s.type)).toEqual(['send_chat', 'obs_transition', 'show_text']);
    expect(created.steps[0]!.id).not.toBe('');
    expect(created.id).not.toBe('');
  });

  test('round-trips an action through getActionById', () => {
    const created = createAction(upsert([
      step({ delayMs: 2500, payload: { template: 'hi {actor}', sender: 'user' } } as never),
    ]));
    const loaded = getActionById(created.id);
    expect(loaded).toEqual(created);
    expect(loaded!.steps[0]!.delayMs).toBe(2500);
    expect(loaded!.steps[0]!.payload).toEqual({ template: 'hi {actor}', sender: 'user' });
  });

  test('getActionById returns null for an unknown id', () => {
    expect(getActionById('nope')).toBeNull();
  });

  test('rejects a duplicate name with 409', () => {
    createAction(upsert([step()], { name: 'Hype' }));
    try {
      createAction(upsert([step()], { name: 'Hype' }));
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRouteError);
      expect((error as HttpRouteError).status).toBe(409);
    }
  });

  test('update replaces the whole step list and repositions', () => {
    const created = createAction(upsert([step(), step(), step()]));
    const updated = updateAction(created.id, upsert([
      step({ type: 'obs_transition', payload: {} } as never),
    ], { name: 'Renamed', description: 'now shorter', enabled: false }));

    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('now shorter');
    expect(updated.enabled).toBe(false);
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0]!.type).toBe('obs_transition');
    expect(updated.steps[0]!.position).toBe(0);

    const orphans = db.prepare('select count(*) as count from action_steps where action_id = ?')
      .get(created.id) as { count: number };
    expect(orphans.count).toBe(1);
  });

  test('update on an unknown id is a 404', () => {
    try {
      updateAction('missing', upsert());
      throw new Error('expected a 404');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRouteError);
      expect((error as HttpRouteError).status).toBe(404);
    }
  });

  test('delete removes the action and cascades to its steps', () => {
    const created = createAction(upsert([step(), step()]));
    deleteAction(created.id);

    expect(getActionById(created.id)).toBeNull();
    const remaining = db.prepare('select count(*) as count from action_steps where action_id = ?')
      .get(created.id) as { count: number };
    expect(remaining.count).toBe(0);
  });

  test('delete on an unknown id is a 404', () => {
    try {
      deleteAction('missing');
      throw new Error('expected a 404');
    } catch (error) {
      expect((error as HttpRouteError).status).toBe(404);
    }
  });

  test('listActions returns every action ordered by name', () => {
    createAction(upsert([step()], { name: 'Zebra' }));
    createAction(upsert([step()], { name: 'apple' }));
    expect(listActions().map(action => action.name)).toEqual(['apple', 'Zebra']);
  });

  test('a step disabled at save time round-trips as disabled', () => {
    const created = createAction(upsert([step({ enabled: false })]));
    expect(getActionById(created.id)!.steps[0]!.enabled).toBe(false);
  });
});

describe('quickDisable persistence', () => {
  test('defaults to false and round-trips through create/read', () => {
    const created = createAction(upsert());
    expect(created.quickDisable).toBe(false);
    expect(getActionById(created.id)!.quickDisable).toBe(false);
  });

  test('persists quickDisable = true and can be toggled back off', () => {
    const created = createAction(upsert([step()], { name: 'Fart', quickDisable: true }));
    expect(created.quickDisable).toBe(true);

    const updated = updateAction(created.id, upsert([step()], { name: 'Fart', quickDisable: false }));
    expect(updated.quickDisable).toBe(false);
    expect(getActionById(created.id)!.quickDisable).toBe(false);
  });
});
