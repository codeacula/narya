// Pure helpers behind the Actions, Automation, and Modules settings pages.
// Kept free of React and fetch so the step/trigger rules can be tested directly.
import type {
  Action,
  ActionRunResult,
  ActionStep,
  ActionStepInput,
  ActionStepType,
  ActionUpsert,
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerKind,
  CategoryModule,
  ChatPhraseMatch,
  Counter,
  MediaAsset,
  TriggerRole,
} from '../../../shared/api';
import {
  MAX_LLM_CHAT_HISTORY_LINES,
  MAX_LLM_EXAMPLE_LENGTH,
  MAX_LLM_EXAMPLES,
  MAX_LLM_INTERACTION_HISTORY,
  MAX_LLM_SYSTEM_PROMPT_LENGTH,
} from '../../../shared/api';

// Mirrors of the server's limits in src/server/actions.ts. Duplicated deliberately:
// validating here turns a 400 round-trip into an inline message, but the server
// stays the authority.
export const MAX_STEPS = 20;
export const MAX_ASSETS_PER_STEP = 25;
export const MAX_DELAY_MS = 600_000;
export const MIN_TEXT_DURATION_MS = 1_000;
export const MAX_TEXT_DURATION_MS = 60_000;
export const MAX_TIMEOUT_SECONDS = 1_209_600; // Twitch's ceiling: 14 days.
export const MAX_TEMPLATE_LENGTH = 500;
export const MAX_ACTION_NAME_LENGTH = 120;

export const STEP_TYPES: ActionStepType[] = [
  'show_text',
  'play_media',
  'tts_speak',
  'send_chat',
  'llm_response',
  'obs_scene',
  'obs_transition',
  'twitch_shoutout',
  'twitch_whisper',
  'twitch_timeout',
  'twitch_ban',
  'set_wind_down',
  'adjust_counter',
  'quote_add',
  'quote_show',
];

export const STEP_TYPE_LABELS: Record<ActionStepType, string> = {
  show_text: 'Show overlay text',
  play_media: 'Play media',
  tts_speak: 'Speak (TTS)',
  send_chat: 'Send chat message',
  llm_response: 'LLM response',
  obs_scene: 'Switch OBS scene',
  obs_transition: 'OBS transition',
  twitch_shoutout: 'Twitch shoutout',
  twitch_whisper: 'Twitch whisper',
  twitch_timeout: 'Twitch timeout',
  twitch_ban: 'Twitch ban',
  set_wind_down: 'Set wind-down mode',
  adjust_counter: 'Adjust counter',
  quote_add: 'Save a quote',
  quote_show: 'Announce a quote',
};

export const TRIGGER_KINDS: AutomationTriggerKind[] = [
  'reward',
  'twitch_event',
  'chat_phrase',
  'viewer_command',
  'dashboard_slash',
  'manual',
  'module_activate',
  'module_deactivate',
];

export const TRIGGER_KIND_LABELS: Record<AutomationTriggerKind, string> = {
  reward: 'Channel point reward',
  twitch_event: 'Twitch event',
  chat_phrase: 'Chat phrase',
  viewer_command: 'Viewer !command',
  dashboard_slash: 'Dashboard /command',
  manual: 'Manual button',
  module_activate: 'Module activated',
  module_deactivate: 'Module deactivated',
};

export const TRIGGER_KIND_HINTS: Record<AutomationTriggerKind, string> = {
  reward: 'Fires when a viewer redeems this channel-point reward.',
  twitch_event: 'Fires on a Twitch event delivered over EventSub.',
  chat_phrase: 'Fires when a chat message matches the phrase.',
  viewer_command: 'A public !command any allowed viewer can type in chat.',
  dashboard_slash: 'A private /command you type in the dashboard. Never sent to Twitch chat.',
  manual: 'A button on the dashboard and tablet Quick actions panel.',
  module_activate: 'Fires when its module becomes the active one (you switched to one of its categories).',
  module_deactivate: 'Fires when its module stops being active.',
};

export const TRIGGER_ROLES: TriggerRole[] = ['broadcaster', 'mod', 'vip', 'sub', 'viewer'];

export const CHAT_PHRASE_MATCHES: ChatPhraseMatch[] = ['exact', 'contains', 'starts_with'];

export const CHAT_PHRASE_MATCH_LABELS: Record<ChatPhraseMatch, string> = {
  exact: 'Exact message',
  contains: 'Contains',
  starts_with: 'Starts with',
};

/** Lifecycle kinds, whose null module means "every module" rather than "global". */
export function isLifecycleKind(kind: AutomationTriggerKind): boolean {
  return kind === 'module_activate' || kind === 'module_deactivate';
}

/** Cooldowns only make sense where a viewer can spam the source. */
export function supportsCooldowns(kind: AutomationTriggerKind): boolean {
  return kind === 'reward' || kind === 'chat_phrase' || kind === 'viewer_command' || kind === 'twitch_event';
}

/** Kinds where a real viewer arrives on the signal, so a per-viewer override can match. */
export function supportsOverrides(kind: AutomationTriggerKind): boolean {
  return kind === 'reward' || kind === 'twitch_event' || kind === 'chat_phrase' || kind === 'viewer_command';
}

// --- Step editing ------------------------------------------------------------

/**
 * Moves the step at `from` to index `to`, shifting the rest. Out-of-range indices
 * return the list untouched so a click on a disabled Up/Down arrow is a no-op
 * rather than a silent reshuffle. Position is array order, so this IS the reorder.
 */
export function moveStep<T>(steps: T[], from: number, to: number): T[] {
  if (from === to) return steps;
  if (from < 0 || from >= steps.length) return steps;
  if (to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeStep<T>(steps: T[], index: number): T[] {
  if (index < 0 || index >= steps.length) return steps;
  return steps.filter((_, i) => i !== index);
}

/** A valid, minimal step of the given type. Payload shape is per-type, so the union stays sound. */
export function newStep(type: ActionStepType): ActionStepInput {
  switch (type) {
    case 'show_text':
      return { type, enabled: true, delayMs: 0, payload: { template: '', durationMs: 5_000, style: 'banner' } };
    case 'play_media':
      return { type, enabled: true, delayMs: 0, payload: { assetIds: [], selection: 'first' } };
    case 'tts_speak':
      return { type, enabled: true, delayMs: 0, payload: { template: '' } };
    case 'send_chat':
      return { type, enabled: true, delayMs: 0, payload: { template: '', sender: 'bot' } };
    case 'llm_response':
      return {
        type,
        enabled: true,
        delayMs: 0,
        payload: {
          template: '',
          systemPrompt: '',
          systemPromptMode: 'enhance',
          chatHistoryLines: 0,
          interactionHistory: 0,
          examples: [],
          allowTags: [],
          denyTags: [],
          allowDecline: false,
          // Matches the stored default: every existing step mentions today.
          mention: true,
        },
      };
    case 'obs_scene':
      return { type, enabled: true, delayMs: 0, payload: { sceneName: '' } };
    case 'obs_transition':
      return { type, enabled: true, delayMs: 0, payload: {} };
    case 'twitch_shoutout':
      return { type, enabled: true, delayMs: 0, payload: { loginTemplate: '{login}' } };
    case 'twitch_whisper':
      return { type, enabled: true, delayMs: 0, payload: { loginTemplate: '{login}', template: '' } };
    case 'twitch_timeout':
      return { type, enabled: true, delayMs: 0, payload: { loginTemplate: '{login}', secondsTemplate: '600', reasonTemplate: '' } };
    case 'twitch_ban':
      return { type, enabled: true, delayMs: 0, payload: { loginTemplate: '{login}', reasonTemplate: '' } };
    case 'set_wind_down':
      return { type, enabled: true, delayMs: 0, payload: { active: true } };
    // Defaults to the common case: bump the chosen counter by one.
    case 'adjust_counter':
      return { type, enabled: true, delayMs: 0, payload: { counterId: '', mode: 'add', amountTemplate: '1' } };
    case 'quote_add':
      return {
        type,
        enabled: true,
        delayMs: 0,
        payload: {
          textTemplate: '{input}',
          slugTemplate: '',
          replyTemplate: 'Saved quote {quoteNumber}.',
        },
      };
    case 'quote_show':
      return {
        type,
        enabled: true,
        delayMs: 0,
        payload: {
          // Empty renders to "any quote", so a bare !quote picks a random one.
          queryTemplate: '{input}',
          messageTemplate: 'Quote {quoteNumber}: {quoteText}',
        },
      };
  }
}

/** Strips a saved step's id/position back to the input shape the server re-derives from array order. */
export function stepToInput(step: ActionStep): ActionStepInput {
  const { id: _id, position: _position, ...input } = step;
  return input as ActionStepInput;
}

export function actionToUpsert(action: Action): ActionUpsert {
  return {
    name: action.name,
    description: action.description,
    enabled: action.enabled,
    quickDisable: action.quickDisable,
    steps: action.steps.map(stepToInput),
  };
}

// --- Formatting --------------------------------------------------------------

/** Zero disables a cooldown entirely — say so rather than printing "0s". */
export function formatCooldown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Off';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds % 1 === 0 ? 0 : 1))}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Number(minutes.toFixed(minutes % 1 === 0 ? 0 : 1))}m`;
  const hours = minutes / 60;
  return `${Number(hours.toFixed(hours % 1 === 0 ? 0 : 1))}h`;
}

export function formatDelay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'immediately';
  return `+${formatCooldown(ms)}`;
}

/** Empty role list means everyone — the server treats [] as "all viewers". */
export function formatRoles(roles: TriggerRole[]): string {
  if (roles.length === 0) return 'everyone';
  return roles.join(', ');
}

/** A one-line summary of a step for the collapsed list row. */
export function describeStep(step: ActionStepInput, assets: MediaAsset[] = [], counters: Counter[] = []): string {
  switch (step.type) {
    case 'show_text':
      return step.payload.template || '(no text)';
    case 'play_media': {
      const labels = step.payload.assetIds.map(id => assets.find(asset => asset.id === id)?.label ?? 'unknown asset');
      if (labels.length === 0) return '(no assets)';
      if (labels.length === 1) return labels[0];
      return `${labels.length} assets, ${step.payload.selection}: ${labels.join(', ')}`;
    }
    case 'tts_speak':
      return step.payload.template || '(empty)';
    case 'llm_response': {
      const parts = [step.payload.template || '(empty)'];
      if (step.payload.systemPromptMode === 'override') parts.push('override persona');
      if (step.payload.chatHistoryLines > 0) parts.push(`${step.payload.chatHistoryLines} chat lines`);
      if (step.payload.interactionHistory > 0) parts.push(`${step.payload.interactionHistory} prior turns`);
      if (step.payload.denyTags.length > 0) parts.push(`deny: ${step.payload.denyTags.join(', ')}`);
      if (step.payload.allowTags.length > 0) parts.push(`allow: ${step.payload.allowTags.join(', ')}`);
      if (step.payload.allowDecline) parts.push('may decline');
      return parts.join(' · ');
    }
    case 'send_chat':
      return `as ${step.payload.sender}: ${step.payload.template || '(empty)'}`;
    case 'obs_scene':
      return step.payload.sceneName || '(no scene)';
    case 'obs_transition':
      return 'studio-mode transition';
    case 'twitch_shoutout':
      return step.payload.loginTemplate;
    case 'twitch_whisper':
      return `${step.payload.loginTemplate}: ${step.payload.template || '(empty)'}`;
    case 'twitch_timeout':
      return `${step.payload.loginTemplate} for ${step.payload.secondsTemplate}s`;
    case 'twitch_ban':
      return step.payload.loginTemplate;
    case 'set_wind_down':
      return step.payload.active ? 'turn wind-down on' : 'turn wind-down off';
    case 'adjust_counter': {
      const counter = counters.find(entry => entry.id === step.payload.counterId);
      const name = counter?.label ?? 'unknown counter';
      const amount = step.payload.amountTemplate;
      if (step.payload.mode === 'set') return `set ${name} to ${amount}`;
      // A leading sign already reads as a direction, so "+1" must not become "by +1".
      return /^[+-]/.test(amount) ? `${name} ${amount}` : `${name} by ${amount}`;
    }
    case 'quote_add':
      return `save ${step.payload.textTemplate || '(nothing)'}`;
    case 'quote_show':
      return step.payload.queryTemplate || 'random quote';
  }
}

/** The assets a play_media step references that would refuse to play right now. */
export function unplayableAssetIds(step: ActionStepInput, assets: MediaAsset[]): string[] {
  if (step.type !== 'play_media') return [];
  return step.payload.assetIds.filter(id => {
    const asset = assets.find(entry => entry.id === id);
    return !asset || !asset.enabled || !asset.available;
  });
}

export function describeTriggerConfig(trigger: AutomationTrigger, rewardTitles: Record<string, string> = {}): string {
  switch (trigger.kind) {
    case 'reward':
      return rewardTitles[trigger.config.rewardId] ?? trigger.config.rewardId ?? '(no reward)';
    case 'twitch_event':
      return trigger.config.eventKind;
    case 'chat_phrase':
      return `${CHAT_PHRASE_MATCH_LABELS[trigger.config.match].toLowerCase()} "${trigger.config.phrase}" · ${formatRoles(trigger.config.roles)}`;
    // The server's normalizeCommand stores the sigil, so command and aliases already
    // read "!lurk" / "/ban". Prefixing again here rendered "!!lurk" and "//ban".
    case 'viewer_command': {
      const aliases = trigger.config.aliases.length > 0 ? ` (${trigger.config.aliases.join(', ')})` : '';
      return `${trigger.config.command}${aliases} · ${formatRoles(trigger.config.roles)}`;
    }
    case 'dashboard_slash': {
      const aliases = trigger.config.aliases.length > 0 ? ` (${trigger.config.aliases.join(', ')})` : '';
      return `${trigger.config.command}${aliases}`;
    }
    case 'manual':
      return trigger.config.label || '(unlabelled button)';
    case 'module_activate':
      return 'on activate';
    case 'module_deactivate':
      return 'on deactivate';
  }
}

/**
 * A trigger with no module is global: always armed, whatever category is live.
 * A module-scoped one only fires while its module is the active one.
 */
export function triggerScopeLabel(trigger: AutomationTrigger, modules: CategoryModule[]): string {
  // On a lifecycle trigger a null module means "fires for every module", which is not
  // the same claim as a global chat trigger being armed regardless of category.
  if (!trigger.moduleId) return isLifecycleKind(trigger.kind) ? 'Every module' : 'Global';
  return modules.find(module => module.id === trigger.moduleId)?.name ?? 'Unknown module';
}

export function isGlobalTrigger(trigger: AutomationTrigger): boolean {
  return trigger.moduleId === null;
}

// --- Run results -------------------------------------------------------------

/**
 * `partial` must never read like success: at least one step failed. Callers use the
 * tone to pick the status class, so a partial run stays visibly distinct.
 */
export function runResultTone(result: ActionRunResult): 'ok' | 'warn' | 'error' {
  if (result.status === 'succeeded') return 'ok';
  if (result.status === 'failed') return 'error';
  return 'warn'; // partial and skipped both need explaining, neither is a clean success.
}

export function summarizeRunResult(result: ActionRunResult): string {
  const failed = result.steps.filter(step => step.status === 'failed').length;
  const skipped = result.steps.filter(step => step.status === 'skipped').length;
  const succeeded = result.steps.filter(step => step.status === 'succeeded').length;

  switch (result.status) {
    case 'succeeded':
      return `Ran ${succeeded} step${succeeded === 1 ? '' : 's'}.`;
    case 'partial':
      return `Partial: ${succeeded} step${succeeded === 1 ? '' : 's'} ran, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}.`;
    case 'failed':
      return `Failed: ${failed} step${failed === 1 ? '' : 's'} failed.`;
    case 'skipped':
      return 'Skipped: nothing ran. The action or every step is disabled, or every asset it plays is unavailable.';
  }
}

// --- Validation --------------------------------------------------------------

function templateMissing(value: string): boolean {
  return value.trim().length === 0;
}

/** The first problem that would make the server reject this step, or null. */
export function validateStep(step: ActionStepInput, index: number): string | null {
  const where = `Step ${index + 1} (${STEP_TYPE_LABELS[step.type]})`;

  if (step.delayMs < 0 || step.delayMs > MAX_DELAY_MS) {
    return `${where}: delay must be between 0 and ${MAX_DELAY_MS / 1000}s.`;
  }

  switch (step.type) {
    case 'show_text':
      if (templateMissing(step.payload.template)) return `${where}: needs text to show.`;
      if (step.payload.durationMs < MIN_TEXT_DURATION_MS || step.payload.durationMs > MAX_TEXT_DURATION_MS) {
        return `${where}: duration must be between ${MIN_TEXT_DURATION_MS / 1000}s and ${MAX_TEXT_DURATION_MS / 1000}s.`;
      }
      return null;
    case 'play_media':
      if (step.payload.assetIds.length === 0) return `${where}: pick at least one media asset.`;
      if (step.payload.assetIds.length > MAX_ASSETS_PER_STEP) {
        return `${where}: at most ${MAX_ASSETS_PER_STEP} assets.`;
      }
      return null;
    case 'tts_speak':
      if (templateMissing(step.payload.template)) return `${where}: needs something to say.`;
      return null;
    case 'send_chat':
      if (templateMissing(step.payload.template)) return `${where}: needs a message.`;
      return null;
    case 'llm_response': {
      if (templateMissing(step.payload.template)) return `${where}: needs a prompt.`;
      if (step.payload.systemPrompt.length > MAX_LLM_SYSTEM_PROMPT_LENGTH) {
        return `${where}: the system prompt must be ${MAX_LLM_SYSTEM_PROMPT_LENGTH} characters or fewer.`;
      }
      if (step.payload.chatHistoryLines < 0 || step.payload.chatHistoryLines > MAX_LLM_CHAT_HISTORY_LINES) {
        return `${where}: chat history must be between 0 and ${MAX_LLM_CHAT_HISTORY_LINES} lines.`;
      }
      if (step.payload.interactionHistory < 0 || step.payload.interactionHistory > MAX_LLM_INTERACTION_HISTORY) {
        return `${where}: interaction history must be between 0 and ${MAX_LLM_INTERACTION_HISTORY}.`;
      }
      if (step.payload.examples.length > MAX_LLM_EXAMPLES) {
        return `${where}: at most ${MAX_LLM_EXAMPLES} examples.`;
      }
      if (step.payload.examples.some(pair => !pair.input.trim() || !pair.output.trim())) {
        return `${where}: every example needs both an input and an output.`;
      }
      if (step.payload.examples.some(pair =>
        pair.input.length > MAX_LLM_EXAMPLE_LENGTH || pair.output.length > MAX_LLM_EXAMPLE_LENGTH)) {
        return `${where}: example text must be ${MAX_LLM_EXAMPLE_LENGTH} characters or fewer.`;
      }
      return null;
    }
    case 'obs_scene':
      if (templateMissing(step.payload.sceneName)) return `${where}: needs a scene name.`;
      return null;
    case 'obs_transition':
      return null;
    case 'twitch_shoutout':
      if (templateMissing(step.payload.loginTemplate)) return `${where}: needs a target login.`;
      return null;
    case 'twitch_whisper':
      if (templateMissing(step.payload.loginTemplate)) return `${where}: needs a target login.`;
      if (templateMissing(step.payload.template)) return `${where}: needs a message.`;
      return null;
    case 'twitch_timeout': {
      if (templateMissing(step.payload.loginTemplate)) return `${where}: needs a target login.`;
      const duration = step.payload.secondsTemplate.trim();
      if (!duration) return `${where}: needs a duration.`;
      // A templated duration ("{arg2}") can only be range-checked once it renders, in
      // the executor. Only a literal is checkable here.
      if (!duration.includes('{')) {
        const literal = Number(duration);
        if (!Number.isFinite(literal) || literal < 1 || literal > MAX_TIMEOUT_SECONDS) {
          return `${where}: duration must be between 1 second and 14 days.`;
        }
      }
      return null;
    }
    case 'twitch_ban':
      if (templateMissing(step.payload.loginTemplate)) return `${where}: needs a target login.`;
      return null;
    case 'set_wind_down':
      return null;
    case 'adjust_counter': {
      if (templateMissing(step.payload.counterId)) return `${where}: pick a counter.`;
      const amount = step.payload.amountTemplate.trim();
      if (!amount) return `${where}: needs an amount.`;
      // A templated amount ("{arg1}") can only be checked once it renders, in the
      // executor — which skips rather than guessing. Only a literal is checkable here.
      if (!amount.includes('{')) {
        const literal = Number(amount);
        if (!Number.isFinite(literal) || !Number.isSafeInteger(Math.round(literal))) {
          return `${where}: amount must be a whole number.`;
        }
      }
      return null;
    }
    case 'quote_add':
      if (templateMissing(step.payload.textTemplate)) return `${where}: needs the text to save.`;
      return null;
    case 'quote_show':
      // queryTemplate is deliberately optional — empty means "any quote".
      if (templateMissing(step.payload.messageTemplate)) return `${where}: needs a message to announce.`;
      return null;
  }
}


/** The first problem that would make the server reject this Action, or null. */
export function validateAction(action: ActionUpsert): string | null {
  if (templateMissing(action.name)) return 'Name is required.';
  if (action.name.length > MAX_ACTION_NAME_LENGTH) {
    return `Name must be ${MAX_ACTION_NAME_LENGTH} characters or fewer.`;
  }
  if (action.steps.length === 0) return 'Add at least one step.';
  if (action.steps.length > MAX_STEPS) return `An action can have at most ${MAX_STEPS} steps.`;

  for (let index = 0; index < action.steps.length; index += 1) {
    const problem = validateStep(action.steps[index], index);
    if (problem) return problem;
  }
  return null;
}

/** The first problem that would make the server reject this trigger, or null. */
export function validateTrigger(trigger: AutomationTriggerInput): string | null {
  if (!trigger.actionId) return 'Pick the action this trigger runs.';
  if (trigger.globalCooldownMs < 0 || trigger.userCooldownMs < 0) {
    return 'Cooldowns cannot be negative. Use 0 to disable one.';
  }

  switch (trigger.kind) {
    case 'reward':
      if (!trigger.config.rewardId) return 'Pick the channel-point reward that fires this.';
      return null;
    case 'twitch_event':
      if (!trigger.config.eventKind) return 'Pick the Twitch event that fires this.';
      return null;
    case 'chat_phrase':
      if (templateMissing(trigger.config.phrase)) return 'Enter the phrase to match.';
      return null;
    case 'viewer_command':
      if (templateMissing(trigger.config.command)) return 'Enter the command name, without the !.';
      return null;
    case 'dashboard_slash':
      if (templateMissing(trigger.config.command)) return 'Enter the command name, without the /.';
      return null;
    case 'manual':
      if (templateMissing(trigger.config.label)) return 'Give the button a label.';
      return null;
    case 'module_activate':
    case 'module_deactivate':
      return null;
  }
}

/**
 * The bare name the editor works in. Commands are **stored with their prefix**
 * (`!quack`, `/shoutout`) — that is the literal word the dispatcher compares against
 * chat — and the server adds it on write. The editor strips it so the field holds a name
 * and the hint can render the prefix itself.
 */
export function normalizeCommandName(value: string): string {
  return value.trim().replace(/^[!/]+/, '').toLowerCase();
}

/** Splits the comma-separated alias field into stored alias names. */
export function parseAliases(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const alias = normalizeCommandName(raw);
    if (alias) seen.add(alias);
  }
  return [...seen];
}

/**
 * A stored trigger, as the editor's draft.
 *
 * Command triggers need the prefix stripped: the field strips `!` as you type and the
 * hint renders the `!` itself, so loading the stored `!quack` raw showed "Viewers type
 * !!quack" and the field rewrote itself to `quack` on the first keystroke. The server
 * re-adds the prefix on save, so a bare name is what round-trips.
 */
export function triggerToInput(trigger: AutomationTrigger): AutomationTriggerInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = trigger;
  if (input.kind === 'viewer_command' || input.kind === 'dashboard_slash') {
    return {
      ...input,
      config: {
        ...input.config,
        command: normalizeCommandName(input.config.command),
        aliases: input.config.aliases.map(normalizeCommandName),
      },
    } as AutomationTriggerInput;
  }
  return input as AutomationTriggerInput;
}
