import type express from 'express';
import type {
  ChatMessage,
  ChatbotCommand,
  ChatbotCommandActionInput,
  ChatbotCommandActionPayload,
  ChatbotCommandActionType,
  ChatbotCommandSettingsResponse,
  ChatbotCommandUpsert,
} from '../shared/api';
import { db } from './db';
import { HttpRouteError, sendRouteError } from './http';
import { askPonderLlm, formatPonderReply } from './llm';
import { switchObsScene, triggerObsTransition } from './obs';
import type { RuntimeState } from './runtime';
import { triggerSoundButton } from './sounds';
import { sendTwitchChatMessage } from './twitch/api';

const V1_COMMAND_ID = 'default-chat-reply-command';
const V1_ACTION_ID = 'default-chat-reply-action';
const PONDER_COMMAND_ID = 'ponder-llm-command';
const PONDER_ACTION_ID = 'ponder-llm-action';
const CHAT_REPLY_ACTION = 'chat_reply';
const LLM_RESPONSE_ACTION = 'llm_response';
const SOUND_PLAY_ACTION = 'sound_play';
const OBS_SCENE_ACTION = 'obs_scene';
const OBS_TRANSITION_ACTION = 'obs_transition';
const COMMAND_PATTERN = /^![A-Za-z0-9_-]{1,49}$/;
const ACTION_TYPES = new Set<ChatbotCommandActionType>([
  CHAT_REPLY_ACTION,
  LLM_RESPONSE_ACTION,
  SOUND_PLAY_ACTION,
  OBS_SCENE_ACTION,
  OBS_TRANSITION_ACTION,
]);

type CommandRow = {
  id: string;
  trigger: string;
  enabled: number;
  updatedAt: string;
};

type ActionRow = {
  id?: string;
  actionType: string;
  payloadJson: string;
  enabled?: number;
  position?: number;
};

type ChatReplyPayload = {
  template?: unknown;
};

const getV1Command = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  where id = ?
`);

const getV1Action = db.prepare(`
  select action_type as actionType, payload_json as payloadJson
  from chatbot_command_actions
  where command_id = ? and action_type = ?
  order by position asc
  limit 1
`);

const deleteActionsForCommand = db.prepare('delete from chatbot_command_actions where command_id = ?');
const deleteCommand = db.prepare('delete from chatbot_commands where id = ?');

const upsertV1Command = db.prepare(`
  insert into chatbot_commands (id, trigger, enabled, created_at, updated_at)
  values (?, ?, ?, ?, ?)
  on conflict(id) do update set
    trigger = excluded.trigger,
    enabled = excluded.enabled,
    updated_at = excluded.updated_at
`);

const upsertV1Action = db.prepare(`
  insert into chatbot_command_actions (id, command_id, action_type, payload_json, enabled, position, created_at, updated_at)
  values (?, ?, ?, ?, 1, 0, ?, ?)
  on conflict(id) do update set
    payload_json = excluded.payload_json,
    enabled = excluded.enabled,
    position = excluded.position,
    updated_at = excluded.updated_at
`);

const upsertPonderCommand = db.prepare(`
  insert into chatbot_commands (id, trigger, enabled, created_at, updated_at)
  values (?, '!ponder', 1, ?, ?)
  on conflict(id) do update set
    trigger = excluded.trigger,
    enabled = 1,
    updated_at = excluded.updated_at
`);

const upsertPonderAction = db.prepare(`
  insert into chatbot_command_actions (id, command_id, action_type, payload_json, enabled, position, created_at, updated_at)
  values (?, ?, ?, '{}', 1, 0, ?, ?)
  on conflict(id) do update set
    action_type = excluded.action_type,
    enabled = 1,
    position = 0,
    updated_at = excluded.updated_at
`);

const getEnabledCommandByTrigger = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  where enabled = 1 and lower(trigger) = lower(?)
  limit 1
`);

const getCommandByTrigger = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  where lower(trigger) = lower(?)
  limit 1
`);

const listEnabledActionsForCommand = db.prepare(`
  select action_type as actionType, payload_json as payloadJson
  from chatbot_command_actions
  where command_id = ? and enabled = 1
  order by position asc
`);

const listCommands = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  order by trigger collate nocase
`);

const getCommandById = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  where id = ?
`);

const listActionsForCommand = db.prepare(`
  select
    id,
    action_type as actionType,
    payload_json as payloadJson,
    enabled,
    position
  from chatbot_command_actions
  where command_id = ?
  order by position asc
`);

const insertCommand = db.prepare(`
  insert into chatbot_commands (id, trigger, enabled, created_at, updated_at)
  values (?, ?, ?, ?, ?)
`);

const updateCommand = db.prepare(`
  update chatbot_commands
  set trigger = ?, enabled = ?, updated_at = ?
  where id = ?
`);

const insertAction = db.prepare(`
  insert into chatbot_command_actions (id, command_id, action_type, payload_json, enabled, position, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)
`);

const saveV1Settings = db.transaction((settings: { command: string; response: string; enabled: boolean; now: string }) => {
  upsertV1Command.run(V1_COMMAND_ID, settings.command, settings.enabled ? 1 : 0, settings.now, settings.now);
  upsertV1Action.run(
    V1_ACTION_ID,
    V1_COMMAND_ID,
    CHAT_REPLY_ACTION,
    JSON.stringify({ template: settings.response }),
    settings.now,
    settings.now,
  );
});

const clearV1Settings = db.transaction(() => {
  deleteActionsForCommand.run(V1_COMMAND_ID);
  deleteCommand.run(V1_COMMAND_ID);
});

const saveCommandActions = (commandId: string, actions: ChatbotCommandActionInput[], now: string) => {
  deleteActionsForCommand.run(commandId);
  actions.forEach((action, index) => {
    insertAction.run(
      crypto.randomUUID(),
      commandId,
      action.type,
      JSON.stringify(action.payload),
      action.enabled ? 1 : 0,
      index,
      now,
      now,
    );
  });
};

const createCommandRecord = db.transaction((settings: ChatbotCommandUpsert) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  insertCommand.run(id, settings.command, settings.enabled ? 1 : 0, now, now);
  saveCommandActions(id, settings.actions, now);
  return id;
});

const updateCommandRecord = db.transaction((id: string, settings: ChatbotCommandUpsert) => {
  const now = new Date().toISOString();
  updateCommand.run(settings.command, settings.enabled ? 1 : 0, now, id);
  saveCommandActions(id, settings.actions, now);
});

function isUniqueTriggerError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unique');
}

export function createChatbotCommand(body: unknown): ChatbotCommand {
  const settings = normalizeCommandUpsert(body);
  try {
    const id = createCommandRecord(settings);
    const row = getCommandById.get(id) as CommandRow | null;
    if (!row) throw new HttpRouteError(500, 'Command was not saved.');
    return rowToCommand(row);
  } catch (error) {
    if (isUniqueTriggerError(error)) {
      throw new HttpRouteError(409, `Command ${settings.command} already exists.`);
    }
    throw error;
  }
}

export function updateChatbotCommand(id: string, body: unknown): ChatbotCommand {
  const existing = getCommandById.get(id) as CommandRow | null;
  if (!existing) throw new HttpRouteError(404, 'Command not found.');

  const settings = normalizeCommandUpsert(body);
  try {
    updateCommandRecord(id, settings);
    const row = getCommandById.get(id) as CommandRow | null;
    if (!row) throw new HttpRouteError(500, 'Command was not saved.');
    return rowToCommand(row);
  } catch (error) {
    if (isUniqueTriggerError(error)) {
      throw new HttpRouteError(409, `Command ${settings.command} already exists.`);
    }
    throw error;
  }
}

export function deleteChatbotCommand(id: string) {
  const existing = getCommandById.get(id) as CommandRow | null;
  if (!existing) throw new HttpRouteError(404, 'Command not found.');
  deleteActionsForCommand.run(id);
  deleteCommand.run(id);
}

function ensurePonderCommand() {
  const now = new Date().toISOString();
  const existing = getCommandByTrigger.get('!ponder') as CommandRow | null;
  if (existing && existing.id !== PONDER_COMMAND_ID) {
    deleteActionsForCommand.run(existing.id);
    deleteCommand.run(existing.id);
  }
  upsertPonderCommand.run(PONDER_COMMAND_ID, now, now);
  upsertPonderAction.run(PONDER_ACTION_ID, PONDER_COMMAND_ID, LLM_RESPONSE_ACTION, now, now);
}

function parseChatReplyTemplate(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as ChatReplyPayload;
    return typeof payload.template === 'string' ? payload.template : '';
  } catch {
    return '';
  }
}

function parseActionPayload(payloadJson: string): ChatbotCommandActionPayload {
  try {
    const payload = JSON.parse(payloadJson) as ChatbotCommandActionPayload;
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function rowToCommand(row: CommandRow): ChatbotCommand {
  const actions = (listActionsForCommand.all(row.id) as ActionRow[]).map(action => ({
    id: action.id ?? '',
    type: action.actionType as ChatbotCommandActionType,
    enabled: action.enabled === 1,
    position: action.position ?? 0,
    payload: parseActionPayload(action.payloadJson),
  }));

  return {
    id: row.id,
    enabled: row.enabled === 1,
    command: row.trigger,
    actions,
    updatedAt: row.updatedAt,
  };
}

export function getChatbotCommands(): ChatbotCommand[] {
  ensurePonderCommand();
  return (listCommands.all() as CommandRow[]).map(rowToCommand);
}

function normalizeCommandTrigger(value: unknown): string {
  const command = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!command) throw new HttpRouteError(400, 'Command is required.');
  if (!COMMAND_PATTERN.test(command)) {
    throw new HttpRouteError(400, 'Command must start with ! and use only letters, numbers, underscores, or hyphens.');
  }
  return command;
}

function normalizeActionPayload(type: ChatbotCommandActionType, payload: unknown): ChatbotCommandActionPayload {
  const value = payload && typeof payload === 'object' ? payload as ChatbotCommandActionPayload : {};

  if (type === CHAT_REPLY_ACTION) {
    const template = typeof value.template === 'string' ? value.template.trim() : '';
    if (!template) throw new HttpRouteError(400, 'Chat reply actions need a response.');
    if (template.length > 500) throw new HttpRouteError(400, 'Chat replies must be 500 characters or fewer.');
    return { template };
  }

  if (type === SOUND_PLAY_ACTION) {
    const soundId = typeof value.soundId === 'string' ? value.soundId.trim() : '';
    if (!soundId) throw new HttpRouteError(400, 'Sound actions need a sound button.');
    if (soundId.length > 120) throw new HttpRouteError(400, 'Sound IDs must be 120 characters or fewer.');
    return { soundId };
  }

  if (type === OBS_SCENE_ACTION) {
    const sceneName = typeof value.sceneName === 'string' ? value.sceneName.trim() : '';
    if (!sceneName) throw new HttpRouteError(400, 'OBS scene actions need a scene name.');
    if (sceneName.length > 160) throw new HttpRouteError(400, 'OBS scene names must be 160 characters or fewer.');
    return { sceneName };
  }

  return {};
}

function normalizeActions(value: unknown): ChatbotCommandActionInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpRouteError(400, 'At least one command action is required.');
  }
  if (value.length > 5) throw new HttpRouteError(400, 'Commands can have at most five actions.');

  return value.map((item) => {
    const action = item as Partial<ChatbotCommandActionInput>;
    const type = typeof action.type === 'string' ? action.type : '';
    if (!ACTION_TYPES.has(type as ChatbotCommandActionType)) {
      throw new HttpRouteError(400, `Unsupported command action: ${type || 'unknown'}.`);
    }
    const actionType = type as ChatbotCommandActionType;
    return {
      type: actionType,
      enabled: typeof action.enabled === 'boolean' ? action.enabled : true,
      payload: normalizeActionPayload(actionType, action.payload),
    };
  });
}

function normalizeCommandUpsert(body: unknown): ChatbotCommandUpsert {
  const value = body as Partial<ChatbotCommandUpsert>;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    command: normalizeCommandTrigger(value.command),
    actions: normalizeActions(value.actions),
  };
}

export function getChatbotCommandSettings(): ChatbotCommandSettingsResponse {
  const command = getV1Command.get(V1_COMMAND_ID) as CommandRow | null;
  if (!command) {
    return {
      enabled: true,
      command: '',
      response: '',
      updatedAt: null,
    };
  }

  const action = getV1Action.get(V1_COMMAND_ID, CHAT_REPLY_ACTION) as ActionRow | null;
  return {
    enabled: command.enabled === 1,
    command: command.trigger,
    response: action ? parseChatReplyTemplate(action.payloadJson) : '',
    updatedAt: command.updatedAt,
  };
}

function normalizeSettingsBody(body: unknown): { command: string; response: string; enabled: boolean } | null {
  const value = body as { command?: unknown; response?: unknown; enabled?: unknown };
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const response = typeof value.response === 'string' ? value.response.trim() : '';
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true;

  if (!command && !response) return null;
  if (!command) throw new HttpRouteError(400, 'Command is required when a response is set.');
  if (!response) throw new HttpRouteError(400, 'Response is required when a command is set.');
  if (!COMMAND_PATTERN.test(command)) {
    throw new HttpRouteError(400, 'Command must start with ! and use only letters, numbers, underscores, or hyphens.');
  }
  if (command.toLowerCase() === '!ponder') {
    throw new HttpRouteError(400, '!ponder is reserved for the LLM command.');
  }
  if (response.length > 500) throw new HttpRouteError(400, 'Response must be 500 characters or fewer.');

  return { command: command.toLowerCase(), response, enabled };
}

function firstMessageWord(message: string): string {
  return message.trim().split(/\s+/, 1)[0] ?? '';
}

function messageAfterFirstWord(message: string): string {
  return message.trim().replace(/^\S+\s*/, '').trim();
}

function renderTemplate(template: string, chatMessage: ChatMessage): string {
  const username = chatMessage.displayName || chatMessage.username;
  return template.replaceAll('{username}', username);
}

export async function handleChatbotCommandMessage(state: RuntimeState, chatMessage: ChatMessage): Promise<void> {
  const trigger = firstMessageWord(chatMessage.message);
  if (!trigger) return;

  const command = getEnabledCommandByTrigger.get(trigger) as CommandRow | null;
  if (!command) return;

  const actions = listEnabledActionsForCommand.all(command.id) as ActionRow[];
  for (const action of actions) {
    if (action.actionType === CHAT_REPLY_ACTION) {
      const template = parseChatReplyTemplate(action.payloadJson);
      if (!template) continue;
      const message = renderTemplate(template, chatMessage).trim();
      if (!message) continue;
      await sendTwitchChatMessage(state, message, 'bot');
      continue;
    }

    if (action.actionType === LLM_RESPONSE_ACTION) {
      const question = messageAfterFirstWord(chatMessage.message);
      const message = question
        ? await askPonderLlm(chatMessage, question)
        : formatPonderReply(chatMessage, 'ask me something after !ponder. I left my crystal ball in another hoodie.');
      await sendTwitchChatMessage(state, message, 'bot');
      continue;
    }

    if (action.actionType === SOUND_PLAY_ACTION) {
      const payload = parseActionPayload(action.payloadJson);
      if (payload.soundId) {
        const playback = triggerSoundButton(payload.soundId);
        if (!playback) console.warn(`Chatbot command: sound button "${payload.soundId}" was not found.`);
      }
      continue;
    }

    if (action.actionType === OBS_SCENE_ACTION) {
      const payload = parseActionPayload(action.payloadJson);
      if (payload.sceneName) {
        await switchObsScene(payload.sceneName);
      }
      continue;
    }

    if (action.actionType === OBS_TRANSITION_ACTION) {
      await triggerObsTransition();
    }
  }
}

export function registerChatbotCommandRoutes(app: express.Express) {
  ensurePonderCommand();

  app.get('/api/chatbot/commands', (_request, response) => {
    response.json(getChatbotCommands());
  });

  app.post('/api/chatbot/commands', (request, response) => {
    try {
      response.status(201).json(createChatbotCommand(request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.put('/api/chatbot/commands/:id', (request, response) => {
    try {
      response.json(updateChatbotCommand(request.params.id, request.body));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.delete('/api/chatbot/commands/:id', (request, response) => {
    try {
      deleteChatbotCommand(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.get('/api/chatbot/command-settings', (_request, response) => {
    response.json(getChatbotCommandSettings());
  });

  app.put('/api/chatbot/command-settings', (request, response) => {
    try {
      const settings = normalizeSettingsBody(request.body);
      if (!settings) {
        clearV1Settings();
      } else {
        saveV1Settings({ ...settings, now: new Date().toISOString() });
      }
      response.json(getChatbotCommandSettings());
    } catch (error) {
      sendRouteError(response, error);
    }
  });
}
