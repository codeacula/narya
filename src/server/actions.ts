import type express from 'express';
import type {
  Action,
  ActionStep,
  ActionStepInput,
  ActionStepType,
  ActionUpsert,
  ChatSender,
  MediaSelection,
  TemplateContext,
  TextStyle,
} from '../shared/api';
import { MAX_TIMEOUT_SECONDS } from '../shared/api';
import type { ActionExecutor } from './actionExecutor';
import { db } from './db';
import { handle, HttpRouteError } from './http';

const MAX_STEPS = 20;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TEMPLATE_LENGTH = 500;
const MAX_DELAY_MS = 600_000;
const MIN_TEXT_DURATION_MS = 1000;
const MAX_TEXT_DURATION_MS = 60_000;
const MAX_ASSETS_PER_STEP = 25;

const STEP_TYPES = new Set<ActionStepType>([
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
]);
const TEXT_STYLES = new Set<TextStyle>(['banner', 'toast', 'centered']);
const MEDIA_SELECTIONS = new Set<MediaSelection>(['first', 'random']);
const CHAT_SENDERS = new Set<ChatSender>(['user', 'bot']);

type ActionRow = {
  id: string;
  name: string;
  description: string;
  enabled: number;
  quickDisable: number;
  createdAt: string;
  updatedAt: string;
};

type StepRow = {
  id: string;
  stepType: string;
  payloadJson: string;
  delayMs: number;
  enabled: number;
  position: number;
};

const listActionRows = db.prepare(`
  select id, name, description, enabled, quick_disable as quickDisable, created_at as createdAt, updated_at as updatedAt
  from actions
  order by name collate nocase
`);

const getActionRow = db.prepare(`
  select id, name, description, enabled, quick_disable as quickDisable, created_at as createdAt, updated_at as updatedAt
  from actions
  where id = ?
`);

const listStepRows = db.prepare(`
  select
    id,
    step_type as stepType,
    payload_json as payloadJson,
    delay_ms as delayMs,
    enabled,
    position
  from action_steps
  where action_id = ?
  order by position asc
`);

const insertActionRow = db.prepare(`
  insert into actions (id, name, description, enabled, quick_disable, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?)
`);

const updateActionRow = db.prepare(`
  update actions
  set name = ?, description = ?, enabled = ?, quick_disable = ?, updated_at = ?
  where id = ?
`);

const deleteActionRow = db.prepare('delete from actions where id = ?');
const deleteStepsForAction = db.prepare('delete from action_steps where action_id = ?');

const insertStepRow = db.prepare(`
  insert into action_steps
    (id, action_id, step_type, payload_json, delay_ms, enabled, position, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function requireTemplate(value: unknown, message: string): string {
  const template = typeof value === 'string' ? value.trim() : '';
  if (!template) throw new HttpRouteError(400, message);
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new HttpRouteError(400, 'Templates must be 500 characters or fewer.');
  }
  return template;
}

function optionalTemplate(value: unknown): string {
  const template = typeof value === 'string' ? value.trim() : '';
  return template.slice(0, MAX_TEMPLATE_LENGTH);
}

function requireLoginTemplate(value: unknown, label: string): string {
  const template = typeof value === 'string' ? value.trim() : '';
  if (!template) throw new HttpRouteError(400, `${label} steps need a target login.`);
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new HttpRouteError(400, 'Templates must be 500 characters or fewer.');
  }
  return template;
}

function normalizeStepPayload(type: ActionStepType, payload: unknown): ActionStepInput['payload'] {
  const value = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

  switch (type) {
    case 'show_text': {
      const template = requireTemplate(value.template, 'Text steps need a template.');
      const style = typeof value.style === 'string' ? value.style : '';
      if (!TEXT_STYLES.has(style as TextStyle)) {
        throw new HttpRouteError(400, `Unsupported text style: ${style || 'unknown'}.`);
      }
      const rawDuration = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
        ? value.durationMs
        : MIN_TEXT_DURATION_MS;
      const durationMs = clamp(Math.round(rawDuration), MIN_TEXT_DURATION_MS, MAX_TEXT_DURATION_MS);
      const tone = typeof value.tone === 'string' && value.tone.trim() ? value.tone.trim().slice(0, 24) : undefined;
      return { template, durationMs, style: style as TextStyle, ...(tone ? { tone } : {}) };
    }

    case 'play_media': {
      const rawIds = Array.isArray(value.assetIds) ? value.assetIds : [];
      const assetIds = rawIds
        .filter((id): id is string => typeof id === 'string')
        .map(id => id.trim())
        .filter(Boolean);
      if (assetIds.length === 0) throw new HttpRouteError(400, 'Media steps need at least one asset.');
      if (assetIds.length > MAX_ASSETS_PER_STEP) {
        throw new HttpRouteError(400, `Media steps can reference at most ${MAX_ASSETS_PER_STEP} assets.`);
      }
      const selection = typeof value.selection === 'string' ? value.selection : '';
      if (!MEDIA_SELECTIONS.has(selection as MediaSelection)) {
        throw new HttpRouteError(400, `Unsupported media selection: ${selection || 'unknown'}.`);
      }
      // An absent volume means "use the asset's own volume", which is not the same
      // as an explicit 0, so it stays absent rather than defaulting.
      if (typeof value.volume !== 'number' || !Number.isFinite(value.volume)) {
        return { assetIds, selection: selection as MediaSelection };
      }
      return { assetIds, selection: selection as MediaSelection, volume: clamp(value.volume, 0, 1) };
    }

    case 'tts_speak':
      return { template: requireTemplate(value.template, 'TTS steps need a template.') };

    case 'send_chat': {
      const template = requireTemplate(value.template, 'Chat steps need a message.');
      const sender = typeof value.sender === 'string' ? value.sender : '';
      if (!CHAT_SENDERS.has(sender as ChatSender)) {
        throw new HttpRouteError(400, `Unsupported chat sender: ${sender || 'unknown'}.`);
      }
      return { template, sender: sender as ChatSender };
    }

    case 'llm_response':
      return { template: requireTemplate(value.template, 'LLM steps need a prompt.') };

    case 'obs_scene': {
      const sceneName = typeof value.sceneName === 'string' ? value.sceneName.trim() : '';
      if (!sceneName) throw new HttpRouteError(400, 'OBS scene steps need a scene name.');
      if (sceneName.length > 160) throw new HttpRouteError(400, 'OBS scene names must be 160 characters or fewer.');
      return { sceneName };
    }

    case 'obs_transition':
      return {};

    case 'twitch_shoutout':
      return { loginTemplate: requireLoginTemplate(value.loginTemplate, 'Shoutout') };

    case 'twitch_whisper':
      return {
        loginTemplate: requireLoginTemplate(value.loginTemplate, 'Whisper'),
        template: requireTemplate(value.template, 'Whisper steps need a message.'),
      };

    case 'twitch_timeout': {
      const loginTemplate = requireLoginTemplate(value.loginTemplate, 'Timeout');
      // A template, so `/timeout bob 300 spam` can bind the duration per invocation.
      // A literal duration ("600") still validates here; anything templated can only
      // be range-checked at render time, in the executor.
      const secondsTemplate = typeof value.secondsTemplate === 'string' ? value.secondsTemplate.trim() : '';
      if (!secondsTemplate) throw new HttpRouteError(400, 'Timeout steps need a duration.');
      if (!/\{/.test(secondsTemplate)) {
        const literal = Number(secondsTemplate);
        if (!Number.isFinite(literal) || literal < 1 || literal > MAX_TIMEOUT_SECONDS) {
          throw new HttpRouteError(400, 'Timeout duration must be between 1 second and 14 days.');
        }
      }
      return { loginTemplate, secondsTemplate, reasonTemplate: optionalTemplate(value.reasonTemplate) };
    }

    case 'twitch_ban':
      return {
        loginTemplate: requireLoginTemplate(value.loginTemplate, 'Ban'),
        reasonTemplate: optionalTemplate(value.reasonTemplate),
      };
  }
}

function normalizeSteps(value: unknown): ActionStepInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpRouteError(400, 'At least one step is required.');
  }
  if (value.length > MAX_STEPS) {
    throw new HttpRouteError(400, `Actions can have at most ${MAX_STEPS} steps.`);
  }

  return value.map((item) => {
    const raw = (item && typeof item === 'object' ? item : {}) as Partial<ActionStepInput> & { delayMs?: unknown };
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (!STEP_TYPES.has(type as ActionStepType)) {
      throw new HttpRouteError(400, `Unsupported action step: ${type || 'unknown'}.`);
    }
    const stepType = type as ActionStepType;

    const rawDelay = typeof raw.delayMs === 'number' && Number.isFinite(raw.delayMs) ? raw.delayMs : 0;
    const delayMs = Math.round(rawDelay);
    if (delayMs < 0 || delayMs > MAX_DELAY_MS) {
      throw new HttpRouteError(400, `Step delay must be between 0 and ${MAX_DELAY_MS} ms.`);
    }

    return {
      type: stepType,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      delayMs,
      payload: normalizeStepPayload(stepType, raw.payload),
    } as ActionStepInput;
  });
}

export function normalizeActionUpsert(body: unknown): ActionUpsert {
  const value = (body && typeof body === 'object' ? body : {}) as Partial<ActionUpsert>;

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) throw new HttpRouteError(400, 'Action name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpRouteError(400, `Action names must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  const description = typeof value.description === 'string'
    ? value.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
    : '';

  return {
    name,
    description,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    quickDisable: typeof value.quickDisable === 'boolean' ? value.quickDisable : false,
    steps: normalizeSteps(value.steps),
  };
}

function saveSteps(actionId: string, steps: ActionStepInput[], now: string) {
  deleteStepsForAction.run(actionId);
  steps.forEach((step, index) => {
    insertStepRow.run(
      crypto.randomUUID(),
      actionId,
      step.type,
      JSON.stringify(step.payload),
      step.delayMs,
      step.enabled ? 1 : 0,
      index,
      now,
      now,
    );
  });
}

const createActionRecord = db.transaction((settings: ActionUpsert) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  insertActionRow.run(id, settings.name, settings.description, settings.enabled ? 1 : 0, settings.quickDisable ? 1 : 0, now, now);
  saveSteps(id, settings.steps, now);
  return id;
});

const updateActionRecord = db.transaction((id: string, settings: ActionUpsert) => {
  const now = new Date().toISOString();
  updateActionRow.run(settings.name, settings.description, settings.enabled ? 1 : 0, settings.quickDisable ? 1 : 0, now, id);
  saveSteps(id, settings.steps, now);
});

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unique');
}

function rowToStep(row: StepRow): ActionStep {
  // payload_json is written only by saveSteps, after normalizeStepPayload validated
  // it against the row's step_type, so the union stays sound on the way back out.
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payloadJson);
  } catch (error) {
    console.error(`Actions: step ${row.id} has unreadable payload JSON:`, error);
  }

  return {
    id: row.id,
    position: row.position,
    enabled: row.enabled === 1,
    delayMs: row.delayMs,
    type: row.stepType as ActionStepType,
    payload,
  } as ActionStep;
}

function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    quickDisable: row.quickDisable === 1,
    steps: (listStepRows.all(row.id) as StepRow[]).map(rowToStep),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listActions(): Action[] {
  return (listActionRows.all() as ActionRow[]).map(rowToAction);
}

export function getActionById(id: string): Action | null {
  const row = getActionRow.get(id) as ActionRow | null;
  return row ? rowToAction(row) : null;
}

export function createAction(body: unknown): Action {
  const settings = normalizeActionUpsert(body);
  let id: string;
  try {
    id = createActionRecord(settings);
  } catch (error) {
    if (isUniqueNameError(error)) throw new HttpRouteError(409, `An action named "${settings.name}" already exists.`);
    throw error;
  }
  const saved = getActionById(id);
  if (!saved) throw new HttpRouteError(500, 'Action was not saved.');
  return saved;
}

export function updateAction(id: string, body: unknown): Action {
  if (!getActionRow.get(id)) throw new HttpRouteError(404, 'Action not found.');
  const settings = normalizeActionUpsert(body);
  try {
    updateActionRecord(id, settings);
  } catch (error) {
    if (isUniqueNameError(error)) throw new HttpRouteError(409, `An action named "${settings.name}" already exists.`);
    throw error;
  }
  const saved = getActionById(id);
  if (!saved) throw new HttpRouteError(500, 'Action was not saved.');
  return saved;
}

export function deleteAction(id: string) {
  if (!getActionRow.get(id)) throw new HttpRouteError(404, 'Action not found.');
  deleteActionRow.run(id);
}

function normalizeRunContext(body: unknown): TemplateContext {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const context = (value.context && typeof value.context === 'object' ? value.context : value) as TemplateContext;
  return context;
}

/**
 * Every route here is operator-only: requireDashboardToken already gates /api, and
 * the manual-run route must never be reachable from an overlay browser source.
 */
export function registerActionRoutes(app: express.Express, executor: ActionExecutor) {
  app.get('/api/actions', (_request, response) => {
    response.json(listActions());
  });

  app.post('/api/actions', handle((request, response) => {
    response.status(201).json(createAction(request.body));
  }));

  app.put('/api/actions/:id', handle((request, response) => {
    response.json(updateAction(request.params.id, request.body));
  }));

  app.delete('/api/actions/:id', handle((request, response) => {
    deleteAction(request.params.id);
    response.status(204).end();
  }));

  app.post('/api/actions/:id/run', handle(async (request, response) => {
    const id = request.params.id;
    if (!getActionRow.get(id)) throw new HttpRouteError(404, 'Action not found.');
    response.json(await executor.runAction(id, normalizeRunContext(request.body)));
  }));
}
