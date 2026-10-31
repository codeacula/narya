import { describe, expect, test } from 'bun:test';
import type {
  Action,
  ActionRunResult,
  ActionStep,
  ActionStepInput,
  ActionStepType,
  ActionUpsert,
  App,
  AppEvent,
  AutomationTrigger,
  AutomationTriggerInput,
  CategoryModule,
  MediaAsset,
  TriggerAction,
  TriggerCondition,
  TriggerRunResult,
} from '../../../shared/api';
import {
  CONDITION_FIELDS_BY_KIND,
  MAX_ACTIONS_PER_TRIGGER,
  MAX_CONDITIONS,
  REDIS_SAFE_STEP_TYPES,
  STEP_TYPES,
  STEP_TYPE_LABELS,
  TRIGGER_KINDS,
  actionRunResultTone,
  actionToUpsert,
  conditionFieldsForKind,
  describeStep,
  describeTriggerConfig,
  formatCooldown,
  formatDelay,
  formatRoles,
  isGlobalTrigger,
  isLifecycleKind,
  listInertReason,
  moveStep,
  newStep,
  normalizeCommandName,
  opsForField,
  parseAliases,
  redisTriggerInertReason,
  redisUnsafeStepWarning,
  removeStep,
  runResultTone,
  summarizeActionRunResult,
  summarizeRunResult,
  supportsCooldowns,
  supportsOverrides,
  triggerScopeLabel,
  triggerToInput,
  unplayableAssetIds,
  validateAction,
  validateConditions,
  validateStep,
  validateTrigger,
} from './automation';
import { newTrigger } from './AutomationPage';

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    label: 'Air horn',
    kind: 'audio',
    sourceType: 'local',
    src: '/sounds/horn.mp3',
    volume: 0.8,
    enabled: true,
    available: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function runResult(overrides: Partial<ActionRunResult> = {}): ActionRunResult {
  return {
    actionId: 'action-1',
    status: 'succeeded',
    steps: [],
    ranAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('moveStep', () => {
  test('moves a step later, shifting the rest', () => {
    expect(moveStep(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  test('moves a step earlier', () => {
    expect(moveStep(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  test('a one-slot move swaps neighbours', () => {
    expect(moveStep(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c']);
  });

  // The Up arrow on the first row and Down on the last are disabled; if one is
  // clicked anyway the list must not silently reshuffle.
  test('an out-of-range target leaves the list untouched', () => {
    const steps = ['a', 'b', 'c'];
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 3)).toBe(steps);
    expect(moveStep(steps, 5, 0)).toBe(steps);
  });

  test('moving a step onto itself is a no-op', () => {
    const steps = ['a', 'b', 'c'];
    expect(moveStep(steps, 1, 1)).toBe(steps);
  });

  test('does not mutate the input', () => {
    const steps = ['a', 'b', 'c'];
    moveStep(steps, 0, 2);
    expect(steps).toEqual(['a', 'b', 'c']);
  });
});

describe('removeStep', () => {
  test('drops the step at the index', () => {
    expect(removeStep(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });

  test('an out-of-range index leaves the list untouched', () => {
    const steps = ['a', 'b'];
    expect(removeStep(steps, 4)).toBe(steps);
  });
});

// Both helpers are generic (T[]) and already covered above with strings; these
// confirm they work the same way over a trigger's actions[] — the shape the trigger
// editor's Up/Down/Remove controls actually reorder.
describe('moveStep / removeStep over a TriggerAction[]', () => {
  const actions: TriggerAction[] = [
    { actionId: 'a1', position: 0, enabled: true },
    { actionId: 'a2', position: 1, enabled: true },
    { actionId: 'a3', position: 2, enabled: false },
  ];

  test('moveStep reorders by actionId, not by position field', () => {
    const reordered = moveStep(actions, 0, 2);
    expect(reordered.map(a => a.actionId)).toEqual(['a2', 'a3', 'a1']);
    // moveStep itself does not touch position — the editor reindexes separately.
    expect(reordered[0]!.position).toBe(1);
  });

  test('removeStep drops one action and leaves the rest untouched', () => {
    const next = removeStep(actions, 1);
    expect(next.map(a => a.actionId)).toEqual(['a1', 'a3']);
    expect(next[1]!.enabled).toBe(false);
  });
});

describe('newStep', () => {
  // Every step type, from the real list rather than a hand-written sample: the old
  // version of this test looped over ['obs_transition'] alone, so it passed while
  // catching nothing. A new step type must land in STEP_TYPES to appear in either
  // dropdown, and nothing but this asserts it.
  test('every step type has a label and produces a payload validateStep understands', () => {
    for (const type of STEP_TYPES) {
      expect(STEP_TYPE_LABELS[type]).toBeTruthy();
      const step = newStep(type);
      expect(step.type).toBe(type);
      // Either it is immediately valid, or it names the field the operator must fill.
      const problem = validateStep(step, 0);
      if (problem !== null) expect(problem).toContain(STEP_TYPE_LABELS[type]);
    }
  });

  test('STEP_TYPES covers the whole ActionStepType union', () => {
    expect(new Set(STEP_TYPES).size).toBe(STEP_TYPES.length);
    // STEP_TYPE_LABELS is a Record<ActionStepType, …>, so the compiler already forces
    // it to cover the union. Comparing against it makes STEP_TYPES — a plain array the
    // compiler does NOT check — inherit that coverage.
    expect([...STEP_TYPES].sort()).toEqual(Object.keys(STEP_TYPE_LABELS).sort() as ActionStepType[]);
  });

  test('a fresh media step starts empty and is flagged until an asset is picked', () => {
    const step = newStep('play_media');
    expect(step.type).toBe('play_media');
    expect(validateStep(step, 0)).toContain('at least one media asset');
  });

  test('a fresh text step defaults to a duration the server accepts', () => {
    const step = newStep('show_text');
    if (step.type !== 'show_text') throw new Error('wrong type');
    expect(step.payload.durationMs).toBe(5_000);
    expect(step.payload.style).toBe('banner');
    expect(step.enabled).toBe(true);
    expect(step.delayMs).toBe(0);
  });

  test('moderation steps default to the actor who triggered them', () => {
    const step = newStep('twitch_timeout');
    if (step.type !== 'twitch_timeout') throw new Error('wrong type');
    expect(step.payload.loginTemplate).toBe('{login}');
    expect(validateStep(step, 0)).toBeNull();
  });
});

describe('actionToUpsert', () => {
  // The server re-derives position from array order, so a round-trip must drop
  // id/position rather than send stale ones back.
  test('strips ids and positions from saved steps', () => {
    const upsert = actionToUpsert({
      id: 'a1',
      name: 'Hype',
      description: '',
      enabled: true,
      quickDisable: false,
      steps: [
        { id: 's1', position: 0, enabled: true, delayMs: 0, type: 'obs_transition', payload: {} },
        { id: 's2', position: 1, enabled: false, delayMs: 500, type: 'tts_speak', payload: { template: 'hi' } },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(upsert.steps).toEqual([
      { enabled: true, delayMs: 0, type: 'obs_transition', payload: {} },
      { enabled: false, delayMs: 500, type: 'tts_speak', payload: { template: 'hi' } },
    ]);
  });

  test('actionToUpsert carries quickDisable through', () => {
    const action: Action = {
      id: 'a1',
      name: 'Fart',
      description: '',
      enabled: true,
      quickDisable: true,
      steps: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(actionToUpsert(action).quickDisable).toBe(true);
  });
});

describe('formatCooldown', () => {
  // Zero disables the limit. Rendering "0s" would read like an instant cooldown.
  test('zero reads as off, not as a zero-length cooldown', () => {
    expect(formatCooldown(0)).toBe('Off');
  });

  test('a negative or non-finite value also reads as off', () => {
    expect(formatCooldown(-1)).toBe('Off');
    expect(formatCooldown(Number.NaN)).toBe('Off');
  });

  test('scales through ms, seconds, minutes, and hours', () => {
    expect(formatCooldown(250)).toBe('250ms');
    expect(formatCooldown(30_000)).toBe('30s');
    expect(formatCooldown(1_500)).toBe('1.5s');
    expect(formatCooldown(60_000)).toBe('1m');
    expect(formatCooldown(90_000)).toBe('1.5m');
    expect(formatCooldown(3_600_000)).toBe('1h');
  });
});

describe('formatDelay', () => {
  test('no delay reads as immediate', () => {
    expect(formatDelay(0)).toBe('immediately');
  });

  test('a delay is shown as an offset from the start of the run', () => {
    expect(formatDelay(2_000)).toBe('+2s');
  });
});

describe('formatRoles', () => {
  // The server treats an empty allowlist as "all viewers".
  test('an empty allowlist means everyone', () => {
    expect(formatRoles([])).toBe('everyone');
  });

  test('lists the allowed roles', () => {
    expect(formatRoles(['mod', 'vip'])).toBe('mod, vip');
  });
});

describe('describeStep', () => {
  test('names the configured asset rather than its path', () => {
    const step: ActionStepInput = {
      type: 'play_media',
      enabled: true,
      delayMs: 0,
      payload: { assetIds: ['asset-1'], selection: 'first' },
    };
    expect(describeStep(step, [asset()])).toBe('Air horn');
  });

  test('a reference to a deleted asset says so instead of rendering an id', () => {
    const step: ActionStepInput = {
      type: 'play_media',
      enabled: true,
      delayMs: 0,
      payload: { assetIds: ['gone'], selection: 'first' },
    };
    expect(describeStep(step, [asset()])).toBe('unknown asset');
  });

  test('multiple assets report the selection mode', () => {
    const step: ActionStepInput = {
      type: 'play_media',
      enabled: true,
      delayMs: 0,
      payload: { assetIds: ['asset-1', 'asset-2'], selection: 'random' },
    };
    const assets = [asset(), asset({ id: 'asset-2', label: 'Sad trombone' })];
    expect(describeStep(step, assets)).toBe('2 assets, random: Air horn, Sad trombone');
  });
});

describe('unplayableAssetIds', () => {
  const step: ActionStepInput = {
    type: 'play_media',
    enabled: true,
    delayMs: 0,
    payload: { assetIds: ['ok', 'disabled', 'missing', 'deleted'], selection: 'first' },
  };
  const assets = [
    asset({ id: 'ok' }),
    asset({ id: 'disabled', enabled: false }),
    asset({ id: 'missing', available: false }),
  ];

  // A disabled or file-missing asset never emits playback, so the editor has to
  // flag it rather than let the operator believe the step will fire.
  test('flags disabled, missing-on-disk, and deleted assets', () => {
    expect(unplayableAssetIds(step, assets)).toEqual(['disabled', 'missing', 'deleted']);
  });

  test('a healthy asset is not flagged', () => {
    expect(unplayableAssetIds(step, assets)).not.toContain('ok');
  });

  test('non-media steps have nothing to flag', () => {
    expect(unplayableAssetIds(newStep('obs_transition'), assets)).toEqual([]);
  });
});

describe('validateAction', () => {
  const base: ActionUpsert = {
    name: 'Hype',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: [newStep('obs_transition')],
  };

  test('accepts a well-formed action', () => {
    expect(validateAction(base)).toBeNull();
  });

  test('a nameless action is rejected', () => {
    expect(validateAction({ ...base, name: '  ' })).toBe('Name is required.');
  });

  test('an action with no steps is rejected', () => {
    expect(validateAction({ ...base, steps: [] })).toBe('Add at least one step.');
  });

  test('more than twenty steps is rejected', () => {
    const steps = Array.from({ length: 21 }, () => newStep('obs_transition'));
    expect(validateAction({ ...base, steps })).toContain('at most 20 steps');
  });

  test('reports the first bad step by its position', () => {
    const steps = [newStep('obs_transition'), newStep('tts_speak')];
    expect(validateAction({ ...base, steps })).toContain('Step 2');
  });
});

describe('validateStep', () => {
  test('a delay beyond the server ceiling is rejected', () => {
    const step: ActionStepInput = { ...newStep('obs_transition'), delayMs: 600_001 };
    expect(validateStep(step, 0)).toContain('delay must be between');
  });

  test('a text duration under the floor is rejected', () => {
    const step: ActionStepInput = {
      type: 'show_text',
      enabled: true,
      delayMs: 0,
      payload: { template: 'hi', durationMs: 500, style: 'banner' },
    };
    expect(validateStep(step, 0)).toContain('duration must be between');
  });

  test('a timeout beyond fourteen days is rejected', () => {
    const step: ActionStepInput = {
      type: 'twitch_timeout',
      enabled: true,
      delayMs: 0,
      payload: { loginTemplate: '{login}', secondsTemplate: '1209601', reasonTemplate: '' },
    };
    expect(validateStep(step, 0)).toContain('14 days');
  });

  // A disabled step is still stored and can be re-enabled, so it is validated too.
  test('a disabled step with an empty template is still rejected', () => {
    const step: ActionStepInput = { ...newStep('tts_speak'), enabled: false };
    expect(validateStep(step, 0)).not.toBeNull();
  });
});

describe('validateTrigger', () => {
  const base: AutomationTriggerInput = {
    kind: 'manual',
    name: 'Hype trigger',
    actions: [{ actionId: 'action-1', position: 0, enabled: true }],
    conditions: [],
    moduleId: null,
    enabled: true,
    globalCooldownMs: 0,
    userCooldownMs: 0,
    config: { label: 'Hype' },
  };

  test('accepts a well-formed manual trigger', () => {
    expect(validateTrigger(base)).toBeNull();
  });

  test('a trigger with no actions is rejected', () => {
    expect(validateTrigger({ ...base, actions: [] })).toBe('Add at least one action.');
  });

  // >=1 stored action is the invariant; a trigger where every one is disabled is
  // still valid to save — that is the deliberate "do nothing" state, not an error.
  test('every action disabled is still a valid, just inert, trigger', () => {
    expect(validateTrigger({ ...base, actions: [{ actionId: 'action-1', position: 0, enabled: false }] })).toBeNull();
  });

  test('more than the per-trigger action cap is rejected', () => {
    const actions: TriggerAction[] = Array.from({ length: MAX_ACTIONS_PER_TRIGGER + 1 }, (_, index) => ({
      actionId: `action-${index}`,
      position: index,
      enabled: true,
    }));
    expect(validateTrigger({ ...base, actions })).toContain(`at most ${MAX_ACTIONS_PER_TRIGGER}`);
  });

  test('exactly the cap is accepted', () => {
    const actions: TriggerAction[] = Array.from({ length: MAX_ACTIONS_PER_TRIGGER }, (_, index) => ({
      actionId: `action-${index}`,
      position: index,
      enabled: true,
    }));
    expect(validateTrigger({ ...base, actions })).toBeNull();
  });

  test('zero cooldowns are valid — that is how a cooldown is disabled', () => {
    const trigger: AutomationTriggerInput = {
      kind: 'chat_phrase',
      name: 'Hype trigger',
      actions: [{ actionId: 'action-1', position: 0, enabled: true }],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { phrase: 'hello', match: 'contains', roles: [] },
    };
    expect(validateTrigger(trigger)).toBeNull();
  });

  test('a negative cooldown is rejected', () => {
    expect(validateTrigger({ ...base, globalCooldownMs: -1 })).toContain('cannot be negative');
  });

  // A lifecycle trigger with no module could never fire.
  test('a module lifecycle trigger with no module is accepted: it means every module', () => {
    const trigger: AutomationTriggerInput = {
      kind: 'module_activate',
      name: 'Module switch',
      actions: [{ actionId: 'action-1', position: 0, enabled: true }],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: {},
    };
    // handleModuleLifecycle scopes on the trigger's own moduleId, so null fires for
    // every module — one Action can announce any switch. Rejecting it would forbid a
    // configuration the dispatcher explicitly supports.
    expect(validateTrigger(trigger)).toBeNull();
  });

  test('a chat phrase trigger with no phrase is rejected', () => {
    const trigger: AutomationTriggerInput = {
      kind: 'chat_phrase',
      name: 'Hype trigger',
      actions: [{ actionId: 'action-1', position: 0, enabled: true }],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { phrase: '   ', match: 'exact', roles: [] },
    };
    expect(validateTrigger(trigger)).toContain('phrase');
  });
});

describe('isLifecycleKind / supportsCooldowns', () => {
  test('only lifecycle triggers require a module', () => {
    expect(isLifecycleKind('module_activate')).toBe(true);
    expect(isLifecycleKind('module_deactivate')).toBe(true);
    expect(isLifecycleKind('manual')).toBe(false);
    expect(isLifecycleKind('reward')).toBe(false);
  });

  // A manual button is operator-only, and lifecycle triggers fire from a category
  // switch — neither is a surface a viewer can spam.
  test('operator-only and lifecycle sources have no cooldowns', () => {
    expect(supportsCooldowns('manual')).toBe(false);
    expect(supportsCooldowns('dashboard_slash')).toBe(false);
    expect(supportsCooldowns('module_activate')).toBe(false);
    expect(supportsCooldowns('chat_phrase')).toBe(true);
    expect(supportsCooldowns('viewer_command')).toBe(true);
    expect(supportsCooldowns('reward')).toBe(true);
  });
});

describe('supportsOverrides', () => {
  test('only kinds where a real viewer arrives on the signal', () => {
    expect(supportsOverrides('reward')).toBe(true);
    expect(supportsOverrides('twitch_event')).toBe(true);
    expect(supportsOverrides('chat_phrase')).toBe(true);
    expect(supportsOverrides('viewer_command')).toBe(true);
    expect(supportsOverrides('dashboard_slash')).toBe(false);
    expect(supportsOverrides('manual')).toBe(false);
    expect(supportsOverrides('module_activate')).toBe(false);
    expect(supportsOverrides('module_deactivate')).toBe(false);
  });
});

describe('trigger scope', () => {
  const modules: CategoryModule[] = [{
    id: 'mod-1',
    name: 'Minecraft',
    enabled: true,
    status: 'active',
    statusDetail: '',
    games: [],
    rewardGroups: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];

  function trigger(moduleId: string | null): AutomationTrigger {
    return {
      id: 't1',
      kind: 'manual',
      name: 'Hype trigger',
      actions: [{ actionId: 'a1', position: 0, enabled: true }],
      conditions: [],
      moduleId,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'Hype' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  // No module = always armed. That distinction drives the Global badge.
  test('a trigger with no module is global', () => {
    expect(isGlobalTrigger(trigger(null))).toBe(true);
    expect(triggerScopeLabel(trigger(null), modules)).toBe('Global');
  });

  test('a module-scoped trigger names its module', () => {
    expect(isGlobalTrigger(trigger('mod-1'))).toBe(false);
    expect(triggerScopeLabel(trigger('mod-1'), modules)).toBe('Minecraft');
  });

  test('a trigger pointing at a deleted module does not read as global', () => {
    expect(triggerScopeLabel(trigger('gone'), modules)).toBe('Unknown module');
  });
});

describe('describeTriggerConfig', () => {
  function trigger(overrides: Partial<AutomationTrigger>): AutomationTrigger {
    return {
      id: 't1',
      kind: 'manual',
      name: 'Hype trigger',
      actions: [{ actionId: 'a1', position: 0, enabled: true }],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'Hype' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    } as AutomationTrigger;
  }

  test('a reward trigger shows the reward title, not its id', () => {
    const described = describeTriggerConfig(
      trigger({ kind: 'reward', config: { rewardId: 'r-9' } }),
      { 'r-9': 'Hydrate!' },
    );
    expect(described).toBe('Hydrate!');
  });

  test('a reward whose title is unknown falls back to the id', () => {
    expect(describeTriggerConfig(trigger({ kind: 'reward', config: { rewardId: 'r-9' } }), {})).toBe('r-9');
  });

  test('a viewer command shows its bang prefix and aliases', () => {
    // The server's normalizeCommand stores the sigil, so a trigger read back from the
    // API always carries it. Fixtures without it modelled a shape that never exists.
    const described = describeTriggerConfig(
      trigger({ kind: 'viewer_command', config: { command: '!hype', aliases: ['!h'], roles: ['mod'] } }),
    );
    expect(described).toBe('!hype (!h) · mod');
  });

  test('a dashboard command shows its slash prefix', () => {
    const described = describeTriggerConfig(
      trigger({ kind: 'dashboard_slash', config: { command: '/brb', aliases: [] } }),
    );
    expect(described).toBe('/brb');
  });

  test('a chat phrase shows its match mode and role allowlist', () => {
    const described = describeTriggerConfig(
      trigger({ kind: 'chat_phrase', config: { phrase: 'gg', match: 'starts_with', roles: [] } }),
    );
    expect(described).toBe('starts with "gg" · everyone');
  });
});

describe('run results (single Action — ActionsPage)', () => {
  // A partial run must never be presentable as a success.
  test('a partial run is toned as a warning, not an ok', () => {
    expect(actionRunResultTone(runResult({ status: 'partial' }))).toBe('warn');
    expect(actionRunResultTone(runResult({ status: 'succeeded' }))).toBe('ok');
    expect(actionRunResultTone(runResult({ status: 'failed' }))).toBe('error');
    expect(actionRunResultTone(runResult({ status: 'skipped' }))).toBe('warn');
  });

  test('a partial summary names how many steps ran and how many failed', () => {
    const summary = summarizeActionRunResult(runResult({
      status: 'partial',
      steps: [
        { stepId: 's1', type: 'show_text', status: 'succeeded', detail: '' },
        { stepId: 's2', type: 'play_media', status: 'failed', detail: 'Asset unavailable' },
      ],
    }));
    expect(summary).toBe('Partial: 1 step ran, 1 failed.');
  });

  test('a skipped run explains that nothing ran', () => {
    expect(summarizeActionRunResult(runResult({ status: 'skipped' }))).toContain('nothing ran');
  });

  test('a clean run counts the steps it ran', () => {
    const summary = summarizeActionRunResult(runResult({
      status: 'succeeded',
      steps: [
        { stepId: 's1', type: 'show_text', status: 'succeeded', detail: '' },
        { stepId: 's2', type: 'tts_speak', status: 'succeeded', detail: '' },
      ],
    }));
    expect(summary).toBe('Ran 2 steps.');
  });
});

describe('run results (trigger, N actions — AutomationPage / quickActions)', () => {
  function triggerRunResult(overrides: Partial<TriggerRunResult> = {}): TriggerRunResult {
    return {
      status: 'succeeded',
      actions: [runResult()],
      ...overrides,
    };
  }

  // This is the shape the server actually returns from a trigger run (Task 4):
  // { status, actions: ActionRunResult[] } — no top-level `.steps`. Before this task
  // the client read `.steps` off this object, which is undefined here, so
  // summarizeRunResult would throw at runtime the first time an operator hit Test or
  // a Quick action button.
  test('has no top-level steps field to accidentally read', () => {
    const result = triggerRunResult();
    expect((result as unknown as { steps?: unknown }).steps).toBeUndefined();
  });

  test('a partial run is toned as a warning, not an ok', () => {
    expect(runResultTone(triggerRunResult({ status: 'partial' }))).toBe('warn');
    expect(runResultTone(triggerRunResult({ status: 'succeeded' }))).toBe('ok');
    expect(runResultTone(triggerRunResult({ status: 'failed' }))).toBe('error');
    expect(runResultTone(triggerRunResult({ status: 'skipped' }))).toBe('warn');
  });

  test('a clean run counts the actions it ran', () => {
    const summary = summarizeRunResult(triggerRunResult({
      status: 'succeeded',
      actions: [runResult({ actionId: 'a1' }), runResult({ actionId: 'a2' })],
    }));
    expect(summary).toBe('Ran 2 actions.');
  });

  test('a single successful action is not pluralized', () => {
    expect(summarizeRunResult(triggerRunResult({ status: 'succeeded', actions: [runResult()] }))).toBe('Ran 1 action.');
  });

  test('a partial summary names how many actions succeeded and how many failed', () => {
    const summary = summarizeRunResult(triggerRunResult({
      status: 'partial',
      actions: [
        runResult({ actionId: 'a1', status: 'succeeded' }),
        runResult({ actionId: 'a2', status: 'failed' }),
      ],
    }));
    expect(summary).toBe('Partial: 1 succeeded, 1 failed.');
  });

  test('a failed run counts the failed actions', () => {
    const summary = summarizeRunResult(triggerRunResult({
      status: 'failed',
      actions: [
        runResult({ actionId: 'a1', status: 'failed' }),
        runResult({ actionId: 'a2', status: 'failed' }),
      ],
    }));
    expect(summary).toBe('Failed: 2 actions failed.');
  });

  test('a skipped run explains that nothing ran', () => {
    expect(summarizeRunResult(triggerRunResult({ status: 'skipped', actions: [] }))).toContain('nothing ran');
  });
});

describe('command name parsing', () => {
  // The prefix is presentation; the stored name is bare.
  test('strips a leading ! or / and lowercases', () => {
    expect(normalizeCommandName('!Hype')).toBe('hype');
    expect(normalizeCommandName('/BRB')).toBe('brb');
    expect(normalizeCommandName('  so  ')).toBe('so');
  });

  test('parses and de-duplicates a comma-separated alias list', () => {
    expect(parseAliases('!h, hype , H, ,')).toEqual(['h', 'hype']);
  });

  test('an empty alias field yields no aliases', () => {
    expect(parseAliases('   ')).toEqual([]);
  });
});

describe('describeTriggerConfig command rendering', () => {
  test('does not double up the sigil the server already stored', () => {
    // normalizeCommand on the server stores "!lurk" / "/ban", not "lurk" / "ban".
    // Prefixing again here rendered "!!lurk" and "//shoutout (//so)" in the UI.
    const viewer = {
      id: 't1', kind: 'viewer_command', name: 'Lurk', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { command: '!lurk', aliases: [], roles: [] },
      createdAt: '', updatedAt: '',
    } as AutomationTrigger;
    const slash = {
      id: 't2', kind: 'dashboard_slash', name: 'Shoutout', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { command: '/shoutout', aliases: ['/so'] },
      createdAt: '', updatedAt: '',
    } as AutomationTrigger;

    expect(describeTriggerConfig(viewer, {})).toContain('!lurk');
    expect(describeTriggerConfig(viewer, {})).not.toContain('!!');
    expect(describeTriggerConfig(slash, {})).toBe('/shoutout (/so)');
  });
});

describe('triggerToInput', () => {
  test('strips the stored prefix so the editor holds a bare command name', () => {
    // The server stores the word the dispatcher matches against chat — "!quack", not
    // "quack". The editor strips ! as you type and its hint renders the ! itself, so
    // loading the stored value raw showed "Viewers type !!quack" and the field rewrote
    // itself on the first keystroke.
    const viewer = {
      id: 't1', kind: 'viewer_command', name: 'Quack', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { command: '!quack', aliases: ['!duck'], roles: [] },
      createdAt: '', updatedAt: '',
    } as AutomationTrigger;

    const input = triggerToInput(viewer);
    expect(input.kind).toBe('viewer_command');
    if (input.kind !== 'viewer_command') throw new Error('wrong kind');
    expect(input.config.command).toBe('quack');
    expect(input.config.aliases).toEqual(['duck']);
  });

  test('strips the slash prefix from a dashboard command and its aliases', () => {
    const slash = {
      id: 't2', kind: 'dashboard_slash', name: 'Shoutout', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { command: '/shoutout', aliases: ['/so'] },
      createdAt: '', updatedAt: '',
    } as AutomationTrigger;

    const input = triggerToInput(slash);
    if (input.kind !== 'dashboard_slash') throw new Error('wrong kind');
    expect(input.config.command).toBe('shoutout');
    expect(input.config.aliases).toEqual(['so']);
  });

  test('leaves a non-command trigger config untouched', () => {
    const phrase = {
      id: 't3', kind: 'chat_phrase', name: 'Hype phrase', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { phrase: '!!! hype !!!', match: 'contains', roles: [] },
      createdAt: '', updatedAt: '',
    } as AutomationTrigger;

    const input = triggerToInput(phrase);
    if (input.kind !== 'chat_phrase') throw new Error('wrong kind');
    expect(input.config.phrase).toBe('!!! hype !!!');
  });

  test('round-trips name and the ordered actions list untouched', () => {
    const trigger = {
      id: 't5',
      kind: 'manual',
      name: 'Hype train',
      actions: [
        { actionId: 'a1', position: 0, enabled: true },
        { actionId: 'a2', position: 1, enabled: false },
      ] as TriggerAction[],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'Hype train' },
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    } as AutomationTrigger;

    const input = triggerToInput(trigger);
    expect(input.name).toBe('Hype train');
    expect(input.actions).toEqual([
      { actionId: 'a1', position: 0, enabled: true },
      { actionId: 'a2', position: 1, enabled: false },
    ]);
  });

  test('drops the server-owned id and timestamps', () => {
    const trigger = {
      id: 't4', kind: 'manual', name: 'Hype train', actions: [{ actionId: 'a', position: 0, enabled: true }], conditions: [], moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { label: 'Hype train' },
      createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
    } as AutomationTrigger;

    expect(triggerToInput(trigger)).not.toHaveProperty('id');
    expect(triggerToInput(trigger)).not.toHaveProperty('createdAt');
    expect(triggerToInput(trigger)).not.toHaveProperty('updatedAt');
  });

  // Task 4: the editor's draft must carry the saved filter back into the form
  // unchanged, or every trigger with conditions would silently lose them on edit.
  test('round-trips conditions untouched', () => {
    const conditions: TriggerCondition[] = [
      { field: 'amount', op: 'gte', value: 100 },
      { field: 'actor', op: 'eq', value: 'bob' },
    ];
    const trigger = {
      id: 't6', kind: 'twitch_event', name: 'Big cheer', actions: [{ actionId: 'a', position: 0, enabled: true }],
      conditions,
      moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0,
      config: { eventKind: 'cheer' },
      createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
    } as AutomationTrigger;

    expect(triggerToInput(trigger).conditions).toEqual(conditions);
  });
});

describe('trigger conditions vocabulary', () => {
  test('CONDITION_FIELDS_BY_KIND mirrors the server per-kind field list exactly', () => {
    expect(CONDITION_FIELDS_BY_KIND.reward).toEqual(['actor', 'login', 'input', 'rewardTitle']);
    expect(CONDITION_FIELDS_BY_KIND.twitch_event).toEqual(['actor', 'login', 'amount', 'tier', 'months']);
    expect(CONDITION_FIELDS_BY_KIND.chat_phrase).toEqual(['actor', 'login', 'message']);
    expect(CONDITION_FIELDS_BY_KIND.viewer_command).toEqual(['actor', 'login', 'input', 'message']);
    expect(CONDITION_FIELDS_BY_KIND.dashboard_slash).toEqual(['actor', 'login', 'input']);
    expect(CONDITION_FIELDS_BY_KIND.manual).toEqual(['actor', 'login']);
    expect(CONDITION_FIELDS_BY_KIND.module_activate).toEqual(['actor', 'login']);
    expect(CONDITION_FIELDS_BY_KIND.module_deactivate).toEqual(['actor', 'login']);
  });

  test('conditionFieldsForKind adds the chat-only role/tags pseudo-fields', () => {
    expect(conditionFieldsForKind('chat_phrase')).toEqual(['actor', 'login', 'message', 'role', 'tags']);
    expect(conditionFieldsForKind('viewer_command')).toContain('role');
    expect(conditionFieldsForKind('reward')).not.toContain('role');
    expect(conditionFieldsForKind('reward')).not.toContain('tags');
  });

  test('opsForField offers range ops on numeric fields, not on text fields', () => {
    expect(opsForField('twitch_event', 'amount')).toEqual(['eq', 'neq', 'gte', 'lte', 'in']);
    expect(opsForField('twitch_event', 'months')).toEqual(['eq', 'neq', 'gte', 'lte', 'in']);
    expect(opsForField('reward', 'actor')).toEqual(['eq', 'neq', 'contains', 'starts_with', 'in']);
  });

  test('opsForField exposes role_is/tag_has only on chat kinds', () => {
    expect(opsForField('chat_phrase', 'role')).toEqual(['role_is']);
    expect(opsForField('viewer_command', 'tags')).toEqual(['tag_has']);
    expect(opsForField('reward', 'role')).toEqual([]);
    expect(opsForField('manual', 'tags')).toEqual([]);
  });

  test('opsForField offers numeric ops for a number-typed data key and text ops otherwise', () => {
    expect(opsForField('redis_event', 'data.wave', 'number')).toEqual(['eq', 'neq', 'gte', 'lte', 'in']);
    expect(opsForField('redis_event', 'data.boss', 'string')).toEqual(['eq', 'neq', 'contains', 'starts_with', 'in']);
    expect(opsForField('redis_event', 'data.unknown')).toEqual(['eq', 'neq', 'contains', 'starts_with', 'in']);
  });

  test('conditionFieldsForKind appends catalog keys for redis_event', () => {
    expect(conditionFieldsForKind('redis_event', [{ name: 'boss', type: 'string' }])).toEqual(['actor', 'login', 'data.boss']);
    expect(conditionFieldsForKind('redis_event')).toEqual(['actor', 'login']);
  });
});

describe('validateConditions', () => {
  test('an empty list is valid — no filter', () => {
    expect(validateConditions('reward', [])).toBeNull();
  });

  test('accepts a well-formed set of conditions', () => {
    const conditions: TriggerCondition[] = [
      { field: 'amount', op: 'gte', value: 100 },
      { field: 'actor', op: 'eq', value: 'bob' },
    ];
    expect(validateConditions('twitch_event', conditions)).toBeNull();
  });

  test('rejects a gte with a non-numeric value', () => {
    const conditions: TriggerCondition[] = [{ field: 'amount', op: 'gte', value: 'banana' }];
    expect(validateConditions('twitch_event', conditions)).toContain('number');
  });

  test('rejects an lte with a non-numeric value', () => {
    const conditions: TriggerCondition[] = [{ field: 'months', op: 'lte', value: 'banana' }];
    expect(validateConditions('twitch_event', conditions)).toContain('number');
  });

  test('a numeric string is a valid gte value', () => {
    const conditions: TriggerCondition[] = [{ field: 'amount', op: 'gte', value: '100' }];
    expect(validateConditions('twitch_event', conditions)).toBeNull();
  });

  // Fail-open regression: Number('1e999') passes the old !Number.isNaN check and
  // stores Infinity, which JSON.stringify drops to null — a "gte <huge>" filter
  // silently became always-true. Mirrors the server's normalizeConditions guard.
  test('rejects a gte with a value that coerces to a non-finite number', () => {
    const conditions: TriggerCondition[] = [{ field: 'amount', op: 'gte', value: '1e999' }];
    expect(validateConditions('twitch_event', conditions)).not.toBeNull();
  });

  test('rejects an lte with a value that coerces to a non-finite number', () => {
    const conditions: TriggerCondition[] = [{ field: 'months', op: 'lte', value: 'Infinity' }];
    expect(validateConditions('twitch_event', conditions)).not.toBeNull();
  });

  // Number('') === 0, so a blank value used to pass validation and become an
  // always-true "gte 0" filter instead of a validation error.
  test('rejects a gte with an empty or whitespace-only value', () => {
    const empty: TriggerCondition[] = [{ field: 'amount', op: 'gte', value: '' }];
    expect(validateConditions('twitch_event', empty)).not.toBeNull();

    const whitespace: TriggerCondition[] = [{ field: 'amount', op: 'gte', value: '   ' }];
    expect(validateConditions('twitch_event', whitespace)).not.toBeNull();
  });

  test('rejects role_is on a non-chat kind', () => {
    const conditions: TriggerCondition[] = [{ field: 'role', op: 'role_is', value: 'sub' }];
    expect(validateConditions('reward', conditions)).toContain('chat');
  });

  test('accepts role_is on a chat kind with a valid role', () => {
    const conditions: TriggerCondition[] = [{ field: 'role', op: 'role_is', value: 'sub' }];
    expect(validateConditions('chat_phrase', conditions)).toBeNull();
  });

  test('rejects role_is with an invalid role value', () => {
    const conditions: TriggerCondition[] = [{ field: 'role', op: 'role_is', value: 'viewer' }];
    expect(validateConditions('chat_phrase', conditions)).toContain('role');
  });

  test('rejects tag_has on a non-chat kind', () => {
    const conditions: TriggerCondition[] = [{ field: 'tags', op: 'tag_has', value: 'friend' }];
    expect(validateConditions('viewer_command', conditions)).toBeNull();
    expect(validateConditions('dashboard_slash', conditions)).toContain('chat');
  });

  test('rejects a field not available on this kind', () => {
    const conditions: TriggerCondition[] = [{ field: 'amount', op: 'eq', value: '5' }];
    expect(validateConditions('reward', conditions)).toContain('not available');
  });

  test('rejects an empty "in" list', () => {
    const conditions: TriggerCondition[] = [{ field: 'tier', op: 'in', value: [] }];
    expect(validateConditions('twitch_event', conditions)).not.toBeNull();
  });

  test('rejects more than MAX_CONDITIONS', () => {
    const conditions: TriggerCondition[] = Array.from({ length: MAX_CONDITIONS + 1 }, () => (
      { field: 'actor', op: 'eq', value: 'x' }
    ));
    expect(validateConditions('reward', conditions)).toContain(`at most ${MAX_CONDITIONS}`);
  });

  test('exactly MAX_CONDITIONS is accepted', () => {
    const conditions: TriggerCondition[] = Array.from({ length: MAX_CONDITIONS }, () => (
      { field: 'actor', op: 'eq', value: 'x' }
    ));
    expect(validateConditions('reward', conditions)).toBeNull();
  });

  test('validateConditions accepts a data.* field on redis_event and rejects it elsewhere', () => {
    expect(validateConditions('redis_event', [{ field: 'data.wave', op: 'gte', value: 5 }])).toBeNull();
    expect(validateConditions('reward', [{ field: 'data.wave', op: 'gte', value: 5 }])).not.toBeNull();
  });

  test('validateConditions rejects a malformed data field', () => {
    expect(validateConditions('redis_event', [{ field: 'data.a b', op: 'eq', value: 'x' }])).not.toBeNull();
  });
});

describe('validateTrigger with conditions', () => {
  const base: AutomationTriggerInput = {
    kind: 'twitch_event',
    name: 'Big cheer',
    actions: [{ actionId: 'action-1', position: 0, enabled: true }],
    conditions: [],
    moduleId: null,
    enabled: true,
    globalCooldownMs: 0,
    userCooldownMs: 0,
    config: { eventKind: 'cheer' },
  };

  test('a valid condition set is accepted', () => {
    const trigger = { ...base, conditions: [{ field: 'amount', op: 'gte', value: 100 }] as TriggerCondition[] };
    expect(validateTrigger(trigger)).toBeNull();
  });

  test('an invalid condition surfaces its own message rather than a generic one', () => {
    const trigger = { ...base, conditions: [{ field: 'amount', op: 'gte', value: 'banana' }] as TriggerCondition[] };
    expect(validateTrigger(trigger)).toContain('number');
  });

  test('a gte value that coerces to a non-finite number is rejected at the trigger level too', () => {
    const trigger = { ...base, conditions: [{ field: 'amount', op: 'gte', value: '1e999' }] as TriggerCondition[] };
    expect(validateTrigger(trigger)).not.toBeNull();
  });

  test('a blank gte value is rejected at the trigger level too', () => {
    const trigger = { ...base, conditions: [{ field: 'amount', op: 'gte', value: '' }] as TriggerCondition[] };
    expect(validateTrigger(trigger)).not.toBeNull();
  });

  test('a role_is on a non-chat kind trigger is rejected at the trigger level too', () => {
    const trigger: AutomationTriggerInput = {
      kind: 'manual',
      name: 'Hype trigger',
      actions: [{ actionId: 'action-1', position: 0, enabled: true }],
      conditions: [{ field: 'role', op: 'role_is', value: 'sub' }],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { label: 'Hype' },
    };
    expect(validateTrigger(trigger)).toContain('chat');
  });
});

describe('adjust_counter steps', () => {
  const counter = (overrides = {}) => ({
    id: 'counter-1',
    key: 'deaths',
    label: 'Deaths',
    value: 3,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  });

  test('a fresh step defaults to +1 and is flagged until a counter is picked', () => {
    const step = newStep('adjust_counter');
    expect(step.payload).toEqual({ counterId: '', mode: 'add', amountTemplate: '1' });
    expect(validateStep(step, 0)).toContain('pick a counter');
  });

  test('accepts a literal amount once a counter is chosen', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: '-1' };
    expect(validateStep(step, 0)).toBeNull();
  });

  test('accepts a templated amount, which can only be checked at render time', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: '{arg1}' };
    expect(validateStep(step, 0)).toBeNull();
  });

  test('rejects a non-numeric literal amount', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: 'banana' };
    expect(validateStep(step, 0)).toContain('whole number');
  });

  test('rejects an empty amount', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: '  ' };
    expect(validateStep(step, 0)).toContain('needs an amount');
  });

  test('describes an add without doubling up on the sign', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: '+1' };
    expect(describeStep(step, [], [counter()])).toBe('Deaths +1');
  });

  test('describes an unsigned add as "by"', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'add', amountTemplate: '2' };
    expect(describeStep(step, [], [counter()])).toBe('Deaths by 2');
  });

  test('describes a set', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'counter-1', mode: 'set', amountTemplate: '0' };
    expect(describeStep(step, [], [counter()])).toBe('set Deaths to 0');
  });

  test('names a deleted counter rather than rendering a bare id', () => {
    const step = newStep('adjust_counter');
    step.payload = { counterId: 'gone', mode: 'add', amountTemplate: '1' };
    expect(describeStep(step, [], [counter()])).toContain('unknown counter');
  });
});

describe('quote steps', () => {
  const showStep = (payload: Partial<Record<string, unknown>> = {}): ActionStepInput => ({
    type: 'quote_show',
    enabled: true,
    delayMs: 0,
    payload: {
      queryTemplate: '{input}',
      messageTemplate: 'Quote {quoteNumber}: {quoteText}',
      ...payload,
    },
  } as ActionStepInput);

  test('an empty query is allowed — it means "any quote"', () => {
    expect(validateStep(showStep({ queryTemplate: '' }), 0)).toBeNull();
  });

  test('an empty announcement message is rejected', () => {
    expect(validateStep(showStep({ messageTemplate: '  ' }), 0)).toContain('needs a message');
  });

  test('a save step needs the text to save', () => {
    const step: ActionStepInput = {
      type: 'quote_add',
      enabled: true,
      delayMs: 0,
      payload: { textTemplate: '', slugTemplate: '', replyTemplate: '' },
    };
    expect(validateStep(step, 0)).toContain('needs the text to save');
  });

  test('a fresh quote step is valid with no configuration at all', () => {
    // Quotes go to Twitch chat, which needs nothing set up — so a step the operator
    // just added must not be born invalid.
    expect(validateStep(newStep('quote_show'), 0)).toBeNull();
    expect(validateStep(newStep('quote_add'), 0)).toBeNull();
  });

});

describe('redis_event trigger', () => {
  test('TRIGGER_KINDS now offers redis_event — the editor exists', () => {
    expect(TRIGGER_KINDS).toContain('redis_event');
  });

  test('newTrigger seeds an empty appId/eventName', () => {
    const draft = newTrigger('redis_event');
    expect(draft.kind).toBe('redis_event');
    if (draft.kind !== 'redis_event') throw new Error('wrong kind');
    expect(draft.config).toEqual({ appId: '', eventName: '' });
  });

  const base: AutomationTriggerInput = {
    kind: 'redis_event',
    name: 'External event',
    actions: [{ actionId: 'action-1', position: 0, enabled: true }],
    conditions: [],
    moduleId: null,
    enabled: true,
    globalCooldownMs: 0,
    userCooldownMs: 0,
    config: { appId: 'app-1', eventName: 'boss_killed' },
  };

  test('accepts a well-formed redis_event trigger', () => {
    expect(validateTrigger(base)).toBeNull();
  });

  test('an empty appId is rejected', () => {
    const trigger = { ...base, config: { ...base.config, appId: '' } };
    expect(validateTrigger(trigger)).toContain('app');
  });

  test('an empty eventName is rejected', () => {
    const trigger = { ...base, config: { ...base.config, eventName: '' } };
    expect(validateTrigger(trigger)).toContain('event');
  });

  test('triggerToInput round-trips a redis_event config untouched', () => {
    const trigger: AutomationTrigger = {
      id: 't1',
      kind: 'redis_event',
      name: 'External event',
      actions: [{ actionId: 'action-1', position: 0, enabled: true }],
      conditions: [],
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { appId: 'app-1', eventName: 'boss_killed' },
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };

    const input = triggerToInput(trigger);
    expect(input.kind).toBe('redis_event');
    if (input.kind !== 'redis_event') throw new Error('wrong kind');
    expect(input.config).toEqual({ appId: 'app-1', eventName: 'boss_killed' });
  });
});

describe('REDIS_SAFE_STEP_TYPES / redisUnsafeStepWarning', () => {
  // Mirrors the server's REDIS_SAFE_STEP_TYPES (src/server/triggerDispatcher.ts)
  // exactly — drift here only means a wrong/missing advisory warning, never a
  // security hole, but it must still match.
  test('is exactly the five safe step types', () => {
    expect([...REDIS_SAFE_STEP_TYPES].sort()).toEqual(
      ['adjust_counter', 'play_media', 'send_chat', 'show_text', 'tts_speak'],
    );
  });

  function action(overrides: Partial<Action> = {}): Action {
    return {
      id: 'action-1',
      name: 'Boss killed',
      description: '',
      enabled: true,
      quickDisable: false,
      steps: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  const banStep: ActionStep = {
    id: 's1',
    position: 0,
    enabled: true,
    delayMs: 0,
    type: 'twitch_ban',
    payload: { loginTemplate: '{login}', reasonTemplate: '' },
  };
  const safeStep: ActionStep = {
    id: 's2',
    position: 0,
    enabled: true,
    delayMs: 0,
    type: 'show_text',
    payload: { template: 'hi', durationMs: 5_000, style: 'banner' },
  };

  const boundActions: TriggerAction[] = [{ actionId: 'action-1', position: 0, enabled: true }];

  test('warns when a bound action has a step outside the safe subset', () => {
    const warning = redisUnsafeStepWarning(boundActions, [action({ steps: [banStep] })]);
    expect(warning).not.toBeNull();
    expect(warning).toContain(STEP_TYPE_LABELS.twitch_ban);
  });

  test('no warning when every bound step is in the safe subset', () => {
    expect(redisUnsafeStepWarning(boundActions, [action({ steps: [safeStep] })])).toBeNull();
  });

  test('a mixed action warns only about the unsafe step type', () => {
    const warning = redisUnsafeStepWarning(boundActions, [action({ steps: [safeStep, banStep] })]);
    expect(warning).toContain(STEP_TYPE_LABELS.twitch_ban);
    expect(warning).not.toContain(STEP_TYPE_LABELS.show_text);
  });

  test('a disabled trigger action is not counted — it never runs at all', () => {
    const disabledBinding: TriggerAction[] = [{ actionId: 'action-1', position: 0, enabled: false }];
    expect(redisUnsafeStepWarning(disabledBinding, [action({ steps: [banStep] })])).toBeNull();
  });

  test('an unbound action is ignored', () => {
    expect(redisUnsafeStepWarning([], [action({ steps: [banStep] })])).toBeNull();
  });
});

describe('redisTriggerInertReason', () => {
  test('flags a removed app, disabled app, and undeclared event', () => {
    const apps = [{ id: 'a1', name: 'pztmi', disabledAt: null }] as App[];
    const events = [{ appId: 'a1', eventName: 'boss_killed', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[];

    expect(redisTriggerInertReason({ appId: 'a1', eventName: 'boss_killed' }, apps, events)).toBeNull();
    expect(redisTriggerInertReason({ appId: 'gone', eventName: 'boss_killed' }, apps, events)).toMatch(/app/i);
    expect(redisTriggerInertReason({ appId: 'a1', eventName: 'not_declared' }, apps, events)).toMatch(/declared/i);
    const disabled = [{ id: 'a1', name: 'pztmi', disabledAt: '2026-07-24T00:00:00.000Z' }] as App[];
    expect(redisTriggerInertReason({ appId: 'a1', eventName: 'boss_killed' }, disabled, events)).toMatch(/disabled/i);
  });

  // Precedence is deliberate: de-registering an app cascade-deletes its declared
  // events, so a MISSING app and an "undeclared" event are simultaneously true for
  // every trigger that was bound to it. The app-existence check must win, or the
  // operator sees a misleading "event not declared" instead of "app was removed".
  test('precedence: a removed app is reported as removed, never as an undeclared event', () => {
    const apps = [{ id: 'a1', name: 'pztmi', disabledAt: null }] as App[];
    // 'gone' has no app row AND no declared events at all in this fixture — both
    // conditions are true at once.
    const events = [{ appId: 'a1', eventName: 'boss_killed', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[];
    const reason = redisTriggerInertReason({ appId: 'gone', eventName: 'boss_killed' }, apps, events);
    expect(reason).toMatch(/app/i);
    expect(reason).not.toMatch(/declared/i);
  });

  test('precedence: a disabled app is reported as disabled, never as an undeclared event', () => {
    const disabled = [{ id: 'a1', name: 'pztmi', disabledAt: '2026-07-24T00:00:00.000Z' }] as App[];
    const events = [{ appId: 'a1', eventName: 'boss_killed', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[];
    const reason = redisTriggerInertReason({ appId: 'a1', eventName: 'not_declared' }, disabled, events);
    expect(reason).toMatch(/disabled/i);
    expect(reason).not.toMatch(/declared/i);
  });

  test('an event declared for a different app does not count as declared for this one', () => {
    const apps = [
      { id: 'a1', name: 'pztmi', disabledAt: null },
      { id: 'a2', name: 'other', disabledAt: null },
    ] as App[];
    const events = [{ appId: 'a2', eventName: 'boss_killed', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[];
    const reason = redisTriggerInertReason({ appId: 'a1', eventName: 'boss_killed' }, apps, events);
    expect(reason).toMatch(/declared/i);
  });
});

// The wiring bug the Task 6 review found: "data not loaded yet" was being read as
// "the thing is gone", so a healthy trigger got a false "won't fire" badge for the
// entire in-flight window (or permanently, on a cache write from stale/failed
// fetch state). listInertReason is the pure decision the page's effects delegate
// to, so these false-positive cases are testable without a component harness.
describe('listInertReason', () => {
  const apps = [{ id: 'a1', name: 'pztmi', disabledAt: null }] as App[];
  const events = [{ appId: 'a1', eventName: 'boss_killed', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[];
  const config = { appId: 'a1', eventName: 'boss_killed' };

  test('apps not loaded yet: no badge, even though apps is empty', () => {
    expect(listInertReason({ config, apps: [], appsLoaded: false, events: undefined })).toBeNull();
  });

  test('events not loaded for this app yet: no badge, even for an otherwise healthy app', () => {
    expect(listInertReason({ config, apps, appsLoaded: true, events: undefined })).toBeNull();
  });

  test('a cache entry belonging to a different app is not "loaded" for this one', () => {
    // Modeled as the page's Record<appId, AppEvent[]> cache: a lookup miss on the
    // trigger's own appId is `undefined`, exactly like "not loaded", even though the
    // cache is non-empty and holds real data for some other app. Both halves are
    // asserted against the SAME cache — without the second, the first is input-identical
    // to the "events not loaded" case above and kills nothing extra.
    const bothApps = [
      { id: 'a1', name: 'pztmi', disabledAt: null },
      { id: 'a2', name: 'other', disabledAt: null },
    ] as App[];
    const cache: Record<string, AppEvent[]> = {
      a2: [{ appId: 'a2', eventName: 'other_event', dataKeys: [], boundTriggerCount: 0, createdAt: '' }] as AppEvent[],
    };

    // a1's trigger: nothing cached for a1, so a2's list must not stand in for it.
    expect(listInertReason({ config, apps: bothApps, appsLoaded: true, events: cache[config.appId] })).toBeNull();

    // The same cache DOES resolve for a trigger bound to a2 — and 'boss_killed' is
    // genuinely absent from a2's declared events, so that one badges.
    const a2Config = { appId: 'a2', eventName: 'boss_killed' };
    expect(listInertReason({ config: a2Config, apps: bothApps, appsLoaded: true, events: cache[a2Config.appId] }))
      .toMatch(/declared/i);
  });

  // The gate is `events === undefined`, NOT `!events?.length`: an app that has loaded
  // and genuinely declares nothing is a confirmed fact, and a trigger bound to it can
  // never fire. Without this case, loosening the gate to `!events?.length` leaves every
  // other test here green — the same error/empty conflation this branch fixed, from the
  // opposite direction.
  test('loaded + healthy app that declares no events at all: still badges', () => {
    expect(listInertReason({ config, apps, appsLoaded: true, events: [] })).toMatch(/declared/i);
  });

  test('loaded + genuinely undeclared event: the undeclared reason', () => {
    const reason = listInertReason({
      config: { appId: 'a1', eventName: 'not_declared' },
      apps,
      appsLoaded: true,
      events,
    });
    expect(reason).toMatch(/declared/i);
  });

  test('loaded + app genuinely missing: the removed reason, even with no events loaded for it', () => {
    const reason = listInertReason({
      config: { appId: 'gone', eventName: 'boss_killed' },
      apps,
      appsLoaded: true,
      events: undefined,
    });
    expect(reason).toMatch(/app/i);
  });

  test('loaded + healthy: no badge', () => {
    expect(listInertReason({ config, apps, appsLoaded: true, events })).toBeNull();
  });
});
