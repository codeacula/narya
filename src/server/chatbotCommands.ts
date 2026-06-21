import type express from 'express';
import type { ChatMessage, ChatbotCommandSettingsResponse } from '../shared/api';
import { db } from './db';
import { HttpRouteError, sendRouteError } from './http';
import type { RuntimeState } from './runtime';
import { sendTwitchChatMessage } from './twitch/api';

const V1_COMMAND_ID = 'default-chat-reply-command';
const V1_ACTION_ID = 'default-chat-reply-action';
const CHAT_REPLY_ACTION = 'chat_reply';
const COMMAND_PATTERN = /^![A-Za-z0-9_-]{1,49}$/;

type CommandRow = {
  id: string;
  trigger: string;
  enabled: number;
  updatedAt: string;
};

type ActionRow = {
  actionType: string;
  payloadJson: string;
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

const getEnabledCommandByTrigger = db.prepare(`
  select id, trigger, enabled, updated_at as updatedAt
  from chatbot_commands
  where enabled = 1 and lower(trigger) = lower(?)
  limit 1
`);

const listEnabledActionsForCommand = db.prepare(`
  select action_type as actionType, payload_json as payloadJson
  from chatbot_command_actions
  where command_id = ? and enabled = 1
  order by position asc
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

function parseChatReplyTemplate(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as ChatReplyPayload;
    return typeof payload.template === 'string' ? payload.template : '';
  } catch {
    return '';
  }
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
  if (response.length > 500) throw new HttpRouteError(400, 'Response must be 500 characters or fewer.');

  return { command: command.toLowerCase(), response, enabled };
}

function firstMessageWord(message: string): string {
  return message.trim().split(/\s+/, 1)[0] ?? '';
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
    if (action.actionType !== CHAT_REPLY_ACTION) continue;
    const template = parseChatReplyTemplate(action.payloadJson);
    if (!template) continue;
    const message = renderTemplate(template, chatMessage).trim();
    if (!message) continue;
    await sendTwitchChatMessage(state, message, 'bot');
  }
}

export function registerChatbotCommandRoutes(app: express.Express) {
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
