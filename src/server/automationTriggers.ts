import type express from 'express';
import type {
  ActionStepInput,
  AlertEventKind,
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerKind,
  ChatPhraseMatch,
  ChatPhraseTriggerConfig,
  DashboardSlashTriggerConfig,
  ManualTriggerConfig,
  RewardTriggerConfig,
  SlashCommandRequest,
  TemplateContext,
  TriggerRole,
  TwitchEventTriggerConfig,
  ViewerCommandTriggerConfig,
} from '../shared/api';
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_USER_COOLDOWN_MS } from '../shared/api';
import { db, runOnce } from './db';
import { HttpRouteError, sendRouteError } from './http';
import type { TriggerDispatcher } from './triggerDispatcher';

const MAX_PHRASE_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;
const MAX_ALIASES = 5;
const MAX_COOLDOWN_MS = 86_400_000; // 24h — a cooldown longer than a stream is a typo.
const MAX_REWARD_ID_LENGTH = 120;

const TRIGGER_KINDS = new Set<AutomationTriggerKind>([
  'reward',
  'twitch_event',
  'chat_phrase',
  'viewer_command',
  'dashboard_slash',
  'manual',
  'module_activate',
  'module_deactivate',
]);
const PHRASE_MATCHES = new Set<ChatPhraseMatch>(['exact', 'contains', 'starts_with']);
const TRIGGER_ROLES = new Set<TriggerRole>(['broadcaster', 'mod', 'vip', 'sub', 'viewer']);
const EVENT_KINDS = new Set<AlertEventKind>(['sub', 'gift', 'cheer', 'raid', 'follow']);

/** A command word is one token: `!hype`, `/shoutout`. The prefix is added by normalizeCommand. */
const COMMAND_BODY_PATTERN = /^[a-z0-9_-]{1,49}$/;

type TriggerRow = {
  id: string;
  kind: string;
  actionId: string;
  moduleId: string | null;
  enabled: number;
  configJson: string;
  globalCooldownMs: number;
  userCooldownMs: number;
  createdAt: string;
  updatedAt: string;
};

const TRIGGER_COLUMNS = `
  id,
  kind,
  action_id as actionId,
  module_id as moduleId,
  enabled,
  config_json as configJson,
  global_cooldown_ms as globalCooldownMs,
  user_cooldown_ms as userCooldownMs,
  created_at as createdAt,
  updated_at as updatedAt
`;

const listTriggerRows = db.prepare(`select ${TRIGGER_COLUMNS} from automation_triggers order by created_at asc`);
const getTriggerRow = db.prepare(`select ${TRIGGER_COLUMNS} from automation_triggers where id = ?`);
const listEnabledRowsOfKind = db.prepare(`
  select ${TRIGGER_COLUMNS} from automation_triggers
  where kind = ? and enabled = 1
  order by created_at asc
`);

const insertTriggerRow = db.prepare(`
  insert into automation_triggers
    (id, kind, action_id, module_id, enabled, config_json, global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateTriggerRow = db.prepare(`
  update automation_triggers
  set kind = ?, action_id = ?, module_id = ?, enabled = ?, config_json = ?,
      global_cooldown_ms = ?, user_cooldown_ms = ?, updated_at = ?
  where id = ?
`);

const deleteTriggerRow = db.prepare('delete from automation_triggers where id = ?');
const actionExists = db.prepare('select 1 as present from actions where id = ?');
const moduleExists = db.prepare('select 1 as present from category_modules where id = ?');

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function requireText(value: unknown, max: number, message: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HttpRouteError(400, message);
  if (text.length > max) throw new HttpRouteError(400, `${message.replace(/\.$/, '')} — ${max} characters or fewer.`);
  return text;
}

function normalizeCooldown(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new HttpRouteError(400, 'Cooldowns must be zero or a positive number of milliseconds.');
  }
  return Math.min(Math.floor(ms), MAX_COOLDOWN_MS);
}

function normalizeRoles(value: unknown): TriggerRole[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'Trigger roles must be a list.');
  const roles: TriggerRole[] = [];
  for (const entry of value) {
    const role = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!TRIGGER_ROLES.has(role as TriggerRole)) {
      throw new HttpRouteError(400, `Unsupported trigger role: ${role || 'unknown'}.`);
    }
    if (!roles.includes(role as TriggerRole)) roles.push(role as TriggerRole);
  }
  return roles;
}

/** Accepts `hype`, `!hype`, or `!HYPE` and always stores `!hype`. */
function normalizeCommand(value: unknown, prefix: '!' | '/'): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!COMMAND_BODY_PATTERN.test(body)) {
    throw new HttpRouteError(
      400,
      `Commands must start with ${prefix} and use only letters, numbers, underscores, or hyphens.`,
    );
  }
  return `${prefix}${body}`;
}

function normalizeAliases(value: unknown, prefix: '!' | '/', command: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'Command aliases must be a list.');
  if (value.length > MAX_ALIASES) throw new HttpRouteError(400, `A command can have at most ${MAX_ALIASES} aliases.`);
  const aliases: string[] = [];
  for (const entry of value) {
    const alias = normalizeCommand(entry, prefix);
    if (alias !== command && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
}

function normalizeConfig(kind: AutomationTriggerKind, value: unknown): AutomationTriggerInput['config'] {
  const config = asRecord(value);

  switch (kind) {
    case 'reward': {
      const rewardId = requireText(config.rewardId, MAX_REWARD_ID_LENGTH, 'A reward trigger needs a reward id.');
      return { rewardId } satisfies RewardTriggerConfig;
    }

    case 'twitch_event': {
      const eventKind = typeof config.eventKind === 'string' ? config.eventKind.trim().toLowerCase() : '';
      if (!EVENT_KINDS.has(eventKind as AlertEventKind)) {
        throw new HttpRouteError(400, `Unsupported Twitch event kind: ${eventKind || 'unknown'}.`);
      }
      return { eventKind: eventKind as AlertEventKind } satisfies TwitchEventTriggerConfig;
    }

    case 'chat_phrase': {
      const phrase = requireText(config.phrase, MAX_PHRASE_LENGTH, 'A chat phrase trigger needs a phrase.');
      const match = typeof config.match === 'string' ? config.match.trim().toLowerCase() : '';
      if (!PHRASE_MATCHES.has(match as ChatPhraseMatch)) {
        throw new HttpRouteError(400, `Unsupported phrase match mode: ${match || 'unknown'}.`);
      }
      return { phrase, match: match as ChatPhraseMatch, roles: normalizeRoles(config.roles) } satisfies ChatPhraseTriggerConfig;
    }

    case 'viewer_command': {
      const command = normalizeCommand(config.command, '!');
      return {
        command,
        aliases: normalizeAliases(config.aliases, '!', command),
        roles: normalizeRoles(config.roles),
      } satisfies ViewerCommandTriggerConfig;
    }

    case 'dashboard_slash': {
      const command = normalizeCommand(config.command, '/');
      return {
        command,
        aliases: normalizeAliases(config.aliases, '/', command),
      } satisfies DashboardSlashTriggerConfig;
    }

    case 'manual': {
      const label = requireText(config.label, MAX_LABEL_LENGTH, 'A manual trigger needs a label.');
      return { label } satisfies ManualTriggerConfig;
    }

    case 'module_activate':
    case 'module_deactivate':
      return {};
  }
}

export function normalizeAutomationTriggerInput(body: unknown): AutomationTriggerInput {
  const value = asRecord(body);

  const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
  if (!TRIGGER_KINDS.has(kind as AutomationTriggerKind)) {
    throw new HttpRouteError(400, `Unsupported trigger kind: ${kind || 'unknown'}.`);
  }

  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  if (!actionId || !actionExists.get(actionId)) throw new HttpRouteError(400, 'Action not found.');

  const moduleId = typeof value.moduleId === 'string' && value.moduleId.trim() ? value.moduleId.trim() : null;
  if (moduleId && !moduleExists.get(moduleId)) throw new HttpRouteError(400, 'Module not found.');

  return {
    kind,
    actionId,
    moduleId,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    globalCooldownMs: normalizeCooldown(value.globalCooldownMs, DEFAULT_GLOBAL_COOLDOWN_MS),
    userCooldownMs: normalizeCooldown(value.userCooldownMs, DEFAULT_USER_COOLDOWN_MS),
    config: normalizeConfig(kind as AutomationTriggerKind, value.config),
  } as AutomationTriggerInput;
}

function rowToTrigger(row: TriggerRow): AutomationTrigger {
  // config_json is written only after normalizeConfig validated it against this
  // row's kind, so the discriminated union stays sound on the way back out.
  let config: unknown = {};
  try {
    config = JSON.parse(row.configJson);
  } catch (error) {
    console.error(`Automation: trigger ${row.id} has unreadable config JSON:`, error);
  }

  return {
    id: row.id,
    kind: row.kind as AutomationTriggerKind,
    actionId: row.actionId,
    moduleId: row.moduleId,
    enabled: row.enabled === 1,
    globalCooldownMs: row.globalCooldownMs,
    userCooldownMs: row.userCooldownMs,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as AutomationTrigger;
}

export function listAutomationTriggers(): AutomationTrigger[] {
  return (listTriggerRows.all() as TriggerRow[]).map(rowToTrigger);
}

export function getAutomationTrigger(id: string): AutomationTrigger | null {
  const row = getTriggerRow.get(id) as TriggerRow | null;
  return row ? rowToTrigger(row) : null;
}

/** The dispatcher's read path: only armed triggers of one kind, in creation order. */
export function listEnabledTriggersOfKind(kind: AutomationTriggerKind): AutomationTrigger[] {
  return (listEnabledRowsOfKind.all(kind) as TriggerRow[]).map(rowToTrigger);
}

export function createAutomationTrigger(body: unknown): AutomationTrigger {
  const input = normalizeAutomationTriggerInput(body);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  insertTriggerRow.run(
    id,
    input.kind,
    input.actionId,
    input.moduleId,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    input.globalCooldownMs,
    input.userCooldownMs,
    now,
    now,
  );
  const saved = getAutomationTrigger(id);
  if (!saved) throw new HttpRouteError(500, 'Trigger was not saved.');
  return saved;
}

export function updateAutomationTrigger(id: string, body: unknown): AutomationTrigger {
  if (!getTriggerRow.get(id)) throw new HttpRouteError(404, 'Trigger not found.');
  const input = normalizeAutomationTriggerInput(body);
  updateTriggerRow.run(
    input.kind,
    input.actionId,
    input.moduleId,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    input.globalCooldownMs,
    input.userCooldownMs,
    new Date().toISOString(),
    id,
  );
  const saved = getAutomationTrigger(id);
  if (!saved) throw new HttpRouteError(500, 'Trigger was not saved.');
  return saved;
}

export function deleteAutomationTrigger(id: string): void {
  if (!getTriggerRow.get(id)) throw new HttpRouteError(404, 'Trigger not found.');
  deleteTriggerRow.run(id);
}

// --- Built-in dashboard slash commands ---------------------------------------

const insertSeedAction = db.prepare(`
  insert into actions (id, name, description, enabled, created_at, updated_at)
  values (?, ?, ?, 1, ?, ?)
`);
const insertSeedStep = db.prepare(`
  insert into action_steps (id, action_id, step_type, payload_json, delay_ms, enabled, position, created_at, updated_at)
  values (?, ?, ?, ?, 0, 1, 0, ?, ?)
`);
const actionNameTaken = db.prepare('select 1 as present from actions where name = ? collate nocase');

/** actions.name is unique; an operator may already own "Shoutout". Never fail the boot over it. */
function availableActionName(base: string): string {
  if (!actionNameTaken.get(base)) return base;
  for (let suffix = 2; suffix < 50; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!actionNameTaken.get(candidate)) return candidate;
  }
  return `${base} ${crypto.randomUUID().slice(0, 8)}`;
}

type SeedCommand = {
  name: string;
  description: string;
  command: string;
  aliases: string[];
  step: ActionStepInput;
};

/**
 * The four commands the dashboard chat bar used to parse by hand. They are seeded as
 * ordinary Action + trigger rows so the operator can edit or delete them like any other.
 *
 * `{arg1}` is the target, `{rest}` everything after it, `{rest2}` everything after the
 * second argument. Cooldowns are zero: an operator timing out two spammers in a row
 * must not be rate limited by their own tool.
 */
const SEED_COMMANDS: SeedCommand[] = [
  {
    name: 'Shoutout',
    description: 'Shout out a viewer from the dashboard chat bar.',
    command: '/shoutout',
    aliases: ['/so'],
    step: { type: 'twitch_shoutout', enabled: true, delayMs: 0, payload: { loginTemplate: '{arg1}' } },
  },
  {
    name: 'Whisper',
    description: 'Whisper a viewer. Usage: /whisper <user> <message>',
    command: '/whisper',
    aliases: ['/w'],
    step: {
      type: 'twitch_whisper',
      enabled: true,
      delayMs: 0,
      payload: { loginTemplate: '{arg1}', template: '{rest}' },
    },
  },
  {
    name: 'Timeout',
    description: 'Time a viewer out. Usage: /timeout <user> <seconds> [reason]',
    command: '/timeout',
    aliases: [],
    // The retired client parser guessed: if the second token was numeric it was the
    // duration, otherwise the whole remainder was the reason. Templates cannot express
    // that conditional, so the duration is now positional. A non-numeric or missing
    // {arg2} still lands the timeout at DEFAULT_TIMEOUT_SECONDS rather than failing.
    step: {
      type: 'twitch_timeout',
      enabled: true,
      delayMs: 0,
      payload: { loginTemplate: '{arg1}', secondsTemplate: '{arg2}', reasonTemplate: '{rest2}' },
    },
  },
  {
    name: 'Ban',
    description: 'Ban a viewer. Usage: /ban <user> [reason]',
    command: '/ban',
    aliases: [],
    step: {
      type: 'twitch_ban',
      enabled: true,
      delayMs: 0,
      payload: { loginTemplate: '{arg1}', reasonTemplate: '{rest}' },
    },
  },
];

/** Idempotent via runOnce: the operator's later edits and deletions are never undone. */
export function seedBuiltInSlashCommands(): void {
  runOnce('seed-builtin-dashboard-slash-commands', () => {
    const now = new Date().toISOString();
    for (const seed of SEED_COMMANDS) {
      const actionId = crypto.randomUUID();
      insertSeedAction.run(actionId, availableActionName(seed.name), seed.description, now, now);
      insertSeedStep.run(crypto.randomUUID(), actionId, seed.step.type, JSON.stringify(seed.step.payload), now, now);
      insertTriggerRow.run(
        crypto.randomUUID(),
        'dashboard_slash',
        actionId,
        null,
        1,
        JSON.stringify({ command: seed.command, aliases: seed.aliases }),
        0,
        0,
        now,
        now,
      );
    }
  });
}

// --- Routes ------------------------------------------------------------------

function runContext(body: unknown): TemplateContext {
  const value = asRecord(body);
  return asRecord(value.context ?? value) as TemplateContext;
}

function slashInput(body: unknown): string {
  const value = asRecord(body) as Partial<SlashCommandRequest>;
  return typeof value.input === 'string' ? value.input : '';
}

/**
 * Operator-only: requireDashboardToken already gates /api. /api/automation/slash in
 * particular must never be reachable from an overlay browser source — it can ban.
 */
export function registerAutomationTriggerRoutes(app: express.Express, dispatcher: TriggerDispatcher) {
  app.get('/api/automation/triggers', (_request, response) => {
    response.json(listAutomationTriggers());
  });

  app.post('/api/automation/triggers', (request, response) => {
    try {
      response.status(201).json(createAutomationTrigger(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/automation/triggers/:id', (request, response) => {
    try {
      response.json(updateAutomationTrigger(request.params.id, request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/automation/triggers/:id', (request, response) => {
    try {
      deleteAutomationTrigger(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/automation/triggers/:id/run', async (request, response) => {
    try {
      response.json(await dispatcher.runTriggerManually(request.params.id, runContext(request.body)));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  // Always 200: an unknown command is a normal `ok: false` outcome, not an HTTP error,
  // and it is answered here rather than forwarded anywhere.
  app.post('/api/automation/slash', async (request, response) => {
    try {
      response.json(await dispatcher.handleSlashCommand(slashInput(request.body)));
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
