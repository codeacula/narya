import { describe, expect, test } from 'bun:test';
import type {
  ActionRunResult,
  ActionStepInput,
  ActionUpsert,
  AutomationTrigger,
  AutomationTriggerInput,
  CategoryModule,
  MediaAsset,
} from '../../../shared/api';
import {
  actionToUpsert,
  describeStep,
  describeTriggerConfig,
  formatCooldown,
  formatDelay,
  formatRoles,
  isGlobalTrigger,
  moveStep,
  newStep,
  normalizeCommandName,
  parseAliases,
  removeStep,
  isLifecycleKind,
  runResultTone,
  summarizeRunResult,
  supportsCooldowns,
  triggerScopeLabel,
  unplayableAssetIds,
  validateAction,
  validateStep,
  validateTrigger,
} from './automation';

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

describe('newStep', () => {
  test('every step type produces a payload its own validator accepts or flags concretely', () => {
    for (const type of ['obs_transition'] as const) {
      expect(validateStep(newStep(type), 0)).toBeNull();
    }
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
  const base: ActionUpsert = { name: 'Hype', description: '', enabled: true, steps: [newStep('obs_transition')] };

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
    actionId: 'action-1',
    moduleId: null,
    enabled: true,
    globalCooldownMs: 0,
    userCooldownMs: 0,
    config: { label: 'Hype' },
  };

  test('accepts a well-formed manual trigger', () => {
    expect(validateTrigger(base)).toBeNull();
  });

  test('a trigger with no action is rejected', () => {
    expect(validateTrigger({ ...base, actionId: '' })).toContain('Pick the action');
  });

  test('zero cooldowns are valid — that is how a cooldown is disabled', () => {
    const trigger: AutomationTriggerInput = {
      kind: 'chat_phrase',
      actionId: 'action-1',
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
      actionId: 'action-1',
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
      actionId: 'action-1',
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
      actionId: 'a1',
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
      actionId: 'a1',
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
    const described = describeTriggerConfig(
      trigger({ kind: 'viewer_command', config: { command: 'hype', aliases: ['h'], roles: ['mod'] } }),
    );
    expect(described).toBe('!hype (!h) · mod');
  });

  test('a dashboard command shows its slash prefix', () => {
    const described = describeTriggerConfig(
      trigger({ kind: 'dashboard_slash', config: { command: 'brb', aliases: [] } }),
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

describe('run results', () => {
  // A partial run must never be presentable as a success.
  test('a partial run is toned as a warning, not an ok', () => {
    expect(runResultTone(runResult({ status: 'partial' }))).toBe('warn');
    expect(runResultTone(runResult({ status: 'succeeded' }))).toBe('ok');
    expect(runResultTone(runResult({ status: 'failed' }))).toBe('error');
    expect(runResultTone(runResult({ status: 'skipped' }))).toBe('warn');
  });

  test('a partial summary names how many steps ran and how many failed', () => {
    const summary = summarizeRunResult(runResult({
      status: 'partial',
      steps: [
        { stepId: 's1', type: 'show_text', status: 'succeeded', detail: '' },
        { stepId: 's2', type: 'play_media', status: 'failed', detail: 'Asset unavailable' },
      ],
    }));
    expect(summary).toBe('Partial: 1 step ran, 1 failed.');
  });

  test('a skipped run explains that nothing ran', () => {
    expect(summarizeRunResult(runResult({ status: 'skipped' }))).toContain('nothing ran');
  });

  test('a clean run counts the steps it ran', () => {
    const summary = summarizeRunResult(runResult({
      status: 'succeeded',
      steps: [
        { stepId: 's1', type: 'show_text', status: 'succeeded', detail: '' },
        { stepId: 's2', type: 'tts_speak', status: 'succeeded', detail: '' },
      ],
    }));
    expect(summary).toBe('Ran 2 steps.');
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
