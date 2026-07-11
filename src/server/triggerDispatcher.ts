import type {
  ActionRunResult,
  ActionRunStatus,
  AlertEventKind,
  AutomationTrigger,
  ChatMessage,
  ChatPhraseTriggerConfig,
  SlashCommandResponse,
  TemplateContext,
  TriggerRole,
  ViewerCommandTriggerConfig,
} from '../shared/api';
import { getViewerRolesFromBadges } from '../shared/roles';
import { getAutomationTrigger, listEnabledTriggersOfKind } from './automationTriggers';
import { db } from './db';
import { HttpRouteError } from './http';

export type TriggerDispatcherDeps = {
  runAction: (actionId: string, context: TemplateContext) => Promise<ActionRunResult>;
  /** Id of the module matching the live Twitch category, or null when none matches. */
  getActiveModuleId: () => string | null;
  /** Login of Narya's own bot identity, for loop prevention. */
  getBotLogin: () => string | null;
  now?: () => Date;
};

/** One Twitch alert-shaped event. `eventId` is the EventSub message id — the dedupe key. */
export type TwitchEventSignal = {
  kind: AlertEventKind;
  eventId: string | null;
  actor: string;
  login?: string | null;
  /** Bits cheered, raid viewers, or gift count. */
  amount?: number;
  tier?: string;
  months?: number;
};

export type RewardRedemptionSignal = {
  eventId: string | null;
  rewardId: string;
  rewardTitle: string;
  actor: string;
  login?: string | null;
  userInput?: string;
};

export type ModuleLifecyclePhase = 'activate' | 'deactivate';

export type TriggerRunSummary = {
  triggerId: string;
  actionId: string;
  result: ActionRunResult;
};

export type TriggerDispatcher = {
  handleChatMessage(message: ChatMessage): Promise<TriggerRunSummary[]>;
  handleTwitchEvent(signal: TwitchEventSignal): Promise<TriggerRunSummary[]>;
  handleRewardRedemption(signal: RewardRedemptionSignal): Promise<TriggerRunSummary[]>;
  handleSlashCommand(input: string): Promise<SlashCommandResponse>;
  handleModuleLifecycle(
    phase: ModuleLifecyclePhase,
    moduleId: string,
    moduleName?: string,
  ): Promise<TriggerRunSummary[]>;
  runTriggerManually(triggerId: string, context?: TemplateContext): Promise<ActionRunResult>;
};

const MAX_DETAIL_LENGTH = 500;

const insertRun = db.prepare(`
  insert into automation_runs (id, trigger_id, dedupe_key, actor_login, status, detail, ran_at)
  values (?, ?, ?, ?, ?, ?, ?)
`);
const finishRun = db.prepare('update automation_runs set status = ?, detail = ? where id = ?');
const lastRunAt = db.prepare('select ran_at as ranAt from automation_runs where trigger_id = ? order by ran_at desc limit 1');
const lastUserRunAt = db.prepare(`
  select ran_at as ranAt from automation_runs
  where trigger_id = ? and actor_login = ?
  order by ran_at desc limit 1
`);

/**
 * The run row is inserted BEFORE the Action executes: the partial unique index on
 * dedupe_key is what makes a redelivered event a no-op, and only an insert can win
 * that race (a check-then-insert cannot). The provisional status is therefore
 * `failed` — if the process dies mid-invocation the log keeps the truthful record
 * that the run never completed, rather than claiming it succeeded.
 */
const PROVISIONAL_STATUS: ActionRunStatus = 'failed';
const PROVISIONAL_DETAIL = 'Invocation did not complete.';

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') || error.message.toLowerCase().includes('unique');
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function detailOf(result: ActionRunResult): string {
  const problems = result.steps
    .filter(step => step.status !== 'succeeded' && step.detail)
    .map(step => step.detail)
    .join('; ');
  return problems.slice(0, MAX_DETAIL_LENGTH);
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Logins are typed with an @ as often as not. */
function stripAt(value: string): string {
  return value.replace(/^@+/, '');
}

/** Everyone is a viewer, so a `viewer` allowlist admits the whole channel. */
function passesRoleFilter(allowed: TriggerRole[], badges: Record<string, string> | null): boolean {
  if (allowed.length === 0) return true;
  if (allowed.includes('viewer')) return true;
  const roles = getViewerRolesFromBadges(badges);
  return roles.some(role => allowed.includes(role));
}

function phraseMatch(config: ChatPhraseTriggerConfig, message: string): { hit: boolean; remainder: string } {
  const text = message.trim();
  const haystack = text.toLowerCase();
  const needle = config.phrase.trim().toLowerCase();
  if (!needle) return { hit: false, remainder: '' };

  switch (config.match) {
    case 'exact':
      return { hit: haystack === needle, remainder: '' };
    case 'starts_with':
      return haystack.startsWith(needle)
        ? { hit: true, remainder: text.slice(needle.length).trim() }
        : { hit: false, remainder: '' };
    case 'contains':
      return { hit: haystack.includes(needle), remainder: text };
  }
}

function commandMatch(config: ViewerCommandTriggerConfig, word: string): boolean {
  const candidate = word.toLowerCase();
  return candidate === config.command || config.aliases.includes(candidate);
}

export function createTriggerDispatcher(deps: TriggerDispatcherDeps): TriggerDispatcher {
  const { runAction, getActiveModuleId, getBotLogin, now = () => new Date() } = deps;

  /** A trigger with a moduleId is armed only while that module is the live one. */
  function isArmed(trigger: AutomationTrigger): boolean {
    return trigger.moduleId === null || trigger.moduleId === getActiveModuleId();
  }

  function isOnCooldown(trigger: AutomationTrigger, actorLogin: string | null, at: Date): boolean {
    const nowMs = at.getTime();

    if (trigger.globalCooldownMs > 0) {
      const last = lastRunAt.get(trigger.id) as { ranAt: string } | null;
      if (last && nowMs - Date.parse(last.ranAt) < trigger.globalCooldownMs) return true;
    }

    if (trigger.userCooldownMs > 0 && actorLogin) {
      const last = lastUserRunAt.get(trigger.id, actorLogin) as { ranAt: string } | null;
      if (last && nowMs - Date.parse(last.ranAt) < trigger.userCooldownMs) return true;
    }

    return false;
  }

  /**
   * The dedupe key is scoped per trigger, not per event: several triggers may
   * legitimately match one chat message, and each must be allowed to claim the same
   * source event exactly once.
   */
  function claim(runId: string, trigger: AutomationTrigger, eventId: string | null, actorLogin: string | null, at: Date): boolean {
    const dedupeKey = eventId ? `${trigger.id}:${eventId}` : null;
    try {
      insertRun.run(runId, trigger.id, dedupeKey, actorLogin, PROVISIONAL_STATUS, PROVISIONAL_DETAIL, at.toISOString());
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  type InvokeOptions = {
    eventId?: string | null;
    actorLogin?: string | null;
    /** Manual runs are an explicit operator action: they bypass cooldowns and arming. */
    enforceGates?: boolean;
  };

  async function invoke(
    trigger: AutomationTrigger,
    context: TemplateContext,
    options: InvokeOptions = {},
  ): Promise<TriggerRunSummary | null> {
    const { eventId = null, actorLogin = null, enforceGates = true } = options;
    const at = now();

    if (enforceGates && !isArmed(trigger)) return null;
    if (enforceGates && isOnCooldown(trigger, actorLogin, at)) return null;

    const runId = crypto.randomUUID();
    if (!claim(runId, trigger, eventId, actorLogin, at)) return null;

    let result: ActionRunResult;
    try {
      result = await runAction(trigger.actionId, context);
    } catch (error) {
      const detail = errorText(error);
      console.error(`Automation: trigger ${trigger.id} failed:`, error);
      finishRun.run('failed', detail.slice(0, MAX_DETAIL_LENGTH), runId);
      result = { actionId: trigger.actionId, status: 'failed', steps: [], ranAt: at.toISOString() };
      return { triggerId: trigger.id, actionId: trigger.actionId, result };
    }

    finishRun.run(result.status, detailOf(result), runId);
    return { triggerId: trigger.id, actionId: trigger.actionId, result };
  }

  async function invokeAll(
    candidates: Array<{ trigger: AutomationTrigger; context: TemplateContext }>,
    options: InvokeOptions,
  ): Promise<TriggerRunSummary[]> {
    const summaries: TriggerRunSummary[] = [];
    for (const candidate of candidates) {
      const summary = await invoke(candidate.trigger, candidate.context, options);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  async function handleChatMessage(message: ChatMessage): Promise<TriggerRunSummary[]> {
    // Loop guard: without this, a send_chat step whose text contains its own phrase
    // would re-trigger itself forever.
    const botLogin = getBotLogin()?.trim().toLowerCase() ?? '';
    const login = message.username.trim().toLowerCase();
    if (botLogin && login === botLogin) return [];

    const text = message.message ?? '';
    const actor = message.displayName || message.username;
    const word = tokenize(text)[0] ?? '';

    const candidates: Array<{ trigger: AutomationTrigger; context: TemplateContext }> = [];

    // Every matching phrase trigger fires — one message legitimately drives several
    // Actions (a sound, a banner, a chat reply), and cooldowns are the throttle.
    for (const trigger of listEnabledTriggersOfKind('chat_phrase')) {
      if (trigger.kind !== 'chat_phrase') continue;
      if (!passesRoleFilter(trigger.config.roles, message.badges)) continue;
      const { hit, remainder } = phraseMatch(trigger.config, text);
      if (!hit) continue;
      candidates.push({
        trigger,
        context: { actor, login, message: text, input: remainder, args: tokenize(remainder) },
      });
    }

    if (word) {
      for (const trigger of listEnabledTriggersOfKind('viewer_command')) {
        if (trigger.kind !== 'viewer_command') continue;
        if (!commandMatch(trigger.config, word)) continue;
        if (!passesRoleFilter(trigger.config.roles, message.badges)) continue;
        const input = text.trim().slice(word.length).trim();
        candidates.push({
          trigger,
          context: { actor, login, message: text, input, args: tokenize(input) },
        });
      }
    }

    return invokeAll(candidates, { eventId: message.id || null, actorLogin: login || null });
  }

  async function handleTwitchEvent(signal: TwitchEventSignal): Promise<TriggerRunSummary[]> {
    const login = signal.login?.trim().toLowerCase() ?? '';
    const context: TemplateContext = {
      actor: signal.actor,
      login,
      ...(signal.amount === undefined ? {} : { amount: signal.amount }),
      ...(signal.tier === undefined ? {} : { tier: signal.tier }),
      ...(signal.months === undefined ? {} : { months: signal.months }),
    };

    const candidates = listEnabledTriggersOfKind('twitch_event')
      .filter(trigger => trigger.kind === 'twitch_event' && trigger.config.eventKind === signal.kind)
      .map(trigger => ({ trigger, context }));

    return invokeAll(candidates, { eventId: signal.eventId, actorLogin: login || null });
  }

  async function handleRewardRedemption(signal: RewardRedemptionSignal): Promise<TriggerRunSummary[]> {
    const login = signal.login?.trim().toLowerCase() ?? '';
    const input = signal.userInput?.trim() ?? '';
    const context: TemplateContext = {
      actor: signal.actor,
      login,
      rewardTitle: signal.rewardTitle,
      input,
      args: tokenize(input),
    };

    const candidates = listEnabledTriggersOfKind('reward')
      .filter(trigger => trigger.kind === 'reward' && trigger.config.rewardId === signal.rewardId)
      .map(trigger => ({ trigger, context }));

    return invokeAll(candidates, { eventId: signal.eventId, actorLogin: login || null });
  }

  async function handleModuleLifecycle(
    phase: ModuleLifecyclePhase,
    moduleId: string,
    moduleName?: string,
  ): Promise<TriggerRunSummary[]> {
    const kind = phase === 'activate' ? 'module_activate' : 'module_deactivate';
    const context: TemplateContext = moduleName ? { module: moduleName } : {};

    // A lifecycle trigger is scoped by its own moduleId (null = every module), not by
    // what is live: a deactivate trigger must still fire once its module has gone away.
    const candidates = listEnabledTriggersOfKind(kind)
      .filter(trigger => trigger.moduleId === null || trigger.moduleId === moduleId)
      .map(trigger => ({ trigger, context }));

    return invokeAll(candidates, { enforceGates: false });
  }

  /**
   * A dashboard slash command never leaves the machine: it resolves to a local trigger
   * or it is rejected here. An unknown `/command` is answered with ok:false so an
   * operator's typo can never be forwarded to Twitch chat as a public message.
   *
   * Context convention (deliberate, and different from a viewer `!command`): a private
   * operator command is always `/command <target> <free text>`, so `{login}`/`{actor}`
   * are the TARGET and `{args}` is the free text after it. `{input}` still holds
   * everything after the command word, which is what a targetless command should use.
   */
  async function handleSlashCommand(raw: string): Promise<SlashCommandResponse> {
    const text = (raw ?? '').trim();
    if (!text.startsWith('/')) {
      return { ok: false, message: 'Slash commands must start with /.', run: null };
    }

    const tokens = tokenize(text);
    const word = (tokens[0] ?? '').toLowerCase();
    if (word === '/' || word.length < 2) {
      return { ok: false, message: 'Type a command after the slash.', run: null };
    }

    const trigger = listEnabledTriggersOfKind('dashboard_slash').find(
      candidate => candidate.kind === 'dashboard_slash'
        && (candidate.config.command === word || candidate.config.aliases.includes(word)),
    );
    if (!trigger) {
      return { ok: false, message: `Unknown command ${word}.`, run: null };
    }
    if (!isArmed(trigger)) {
      return { ok: false, message: `${word} belongs to a module that is not active.`, run: null };
    }

    // Standard command context, identical in shape to viewer_command: `args` is
    // every argument after the command word, so {arg1} is the target and {rest}
    // is the remainder. `actor`/`login` are the target rather than the operator —
    // every seeded slash command acts *on* a viewer, and a per-user cooldown keyed
    // on the operator would be meaningless.
    const args = tokens.slice(1).map(stripAt);
    const target = args[0] ?? '';
    const context: TemplateContext = {
      actor: target,
      login: target.toLowerCase(),
      message: text,
      input: text.slice(word.length).trim(),
      args,
    };

    const summary = await invoke(trigger, context, { actorLogin: target.toLowerCase() || null });
    if (!summary) {
      return { ok: false, message: `${word} is cooling down.`, run: null };
    }

    const status = summary.result.status;
    const ok = status === 'succeeded' || status === 'partial';
    // A skipped run means every step rendered empty — almost always a missing argument.
    const message = ok
      ? `${word} ran.`
      : status === 'skipped'
        ? `${word} did nothing — check the command's arguments.`
        : `${word} failed. ${detailOf(summary.result)}`.trim();

    return { ok, message, run: summary.result };
  }

  async function runTriggerManually(triggerId: string, context: TemplateContext = {}): Promise<ActionRunResult> {
    const trigger = getAutomationTrigger(triggerId);
    if (!trigger) throw new HttpRouteError(404, 'Trigger not found.');

    const summary = await invoke(trigger, context, {
      actorLogin: context.login?.trim().toLowerCase() || null,
      enforceGates: false,
    });
    if (!summary) throw new HttpRouteError(500, 'Trigger did not run.');
    return summary.result;
  }

  return {
    handleChatMessage,
    handleTwitchEvent,
    handleRewardRedemption,
    handleSlashCommand,
    handleModuleLifecycle,
    runTriggerManually,
  };
}
