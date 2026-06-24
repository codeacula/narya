import tmi from 'tmi.js';
import type { ChatMessage } from '../shared/api';
import { handleChatbotCommandMessage } from './chatbotCommands';
import { config } from './config';
import { db } from './db';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';
import { triggerQuackSound } from './sounds';
import {
  hasSeenChatterBefore,
  recordCurrentSessionChatter,
} from './streamSession';

let twitchRoomId: string | null = null;
let runtimeState: RuntimeState | null = null;

const insertChat = db.prepare(`
  insert or ignore into chat_messages
    (
      id,
      channel,
      username,
      display_name,
      color,
      message,
      received_at,
      deleted_at,
      deleted_reason,
      badges_json,
      emotes_json,
      stream_session_id,
      is_first_in_session,
      is_first_ever
    )
  values
    (?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?, ?, ?)
`);

const insertChatEvent = db.prepare(`
  insert into chat_events
    (id, type, channel, message_id, username, payload_json, occurred_at)
  values
    (?, ?, ?, ?, ?, ?, ?)
`);

const markMessageDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where id = ?
`);

const markUserMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and lower(username) = lower(?) and deleted_at is null
`);

const markChannelMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and deleted_at is null
`);

export const twitchClient = new tmi.Client({
  connection: { reconnect: true, secure: true },
  channels: [config.twitchChannel],
});

export function getTwitchRoomId(): string | null {
  return twitchRoomId;
}

function appendChatEvent(
  type: string,
  channel: string,
  payload: unknown,
  options: { messageId?: string | null; username?: string | null; occurredAt?: string } = {},
) {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const id = crypto.randomUUID();

  insertChatEvent.run(
    id,
    type,
    channel.replace(/^#/, ''),
    options.messageId ?? null,
    options.username ?? null,
    JSON.stringify(payload),
    occurredAt,
  );

  return { id, occurredAt };
}

twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;

  if (!twitchRoomId && tags['room-id']) {
    twitchRoomId = String(tags['room-id']);
  }

  const occurredAt = new Date().toISOString();
  const username = (tags.username ?? 'unknown').toLowerCase();
  const badges = (tags.badges as Record<string, string> | null) ?? null;
  const isChannelOwner = username === config.twitchChannel.toLowerCase() || Boolean(badges?.broadcaster);
  const messageId = tags.id ?? crypto.randomUUID();
  const isFirstEver = !isChannelOwner && !hasSeenChatterBefore(username);
  const sessionChatter = !isChannelOwner
    ? recordCurrentSessionChatter(username, messageId, occurredAt)
    : { sessionId: null, isFirstInSession: false };

  const chatMessage: ChatMessage = {
    id: messageId,
    channel: channel.replace(/^#/, ''),
    username: tags.username ?? 'unknown',
    displayName: tags['display-name'] ?? tags.username ?? 'unknown',
    color: tags.color ?? null,
    message,
    receivedAt: occurredAt,
    deletedAt: null,
    deletedReason: null,
    badges,
    emotes: (tags.emotes as Record<string, string[]> | null) ?? null,
    isFirstTimer: isFirstEver,
    isFirstThisSession: sessionChatter.isFirstInSession,
    isFirstEver,
  };

  appendChatEvent('message.created', chatMessage.channel, { tags, message }, {
    messageId: chatMessage.id,
    username: chatMessage.username,
    occurredAt,
  });

  insertChat.run(
    chatMessage.id,
    chatMessage.channel,
    chatMessage.username,
    chatMessage.displayName,
    chatMessage.color,
    chatMessage.message,
    chatMessage.receivedAt,
    chatMessage.badges ? JSON.stringify(chatMessage.badges) : null,
    chatMessage.emotes ? JSON.stringify(chatMessage.emotes) : null,
    sessionChatter.sessionId,
    chatMessage.isFirstThisSession ? 1 : 0,
    chatMessage.isFirstEver ? 1 : 0,
  );
  broadcast('chat:message', chatMessage);

  if (/^!quack\b/i.test(message.trim())) {
    triggerQuackSound();
  }

  if (runtimeState) {
    void handleChatbotCommandMessage(runtimeState, chatMessage).catch((error: unknown) => {
      console.error('Chatbot command failed:', error);
    });
  }
});

twitchClient.on('messagedeleted', (channel, username, deletedMessage, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const messageId = tags['target-msg-id'];
  const event = appendChatEvent(
    'message.deleted',
    normalizedChannel,
    { username, deletedMessage, tags },
    { messageId, username },
  );

  if (messageId) {
    markMessageDeleted.run(event.occurredAt, 'message deleted by moderator', event.id, messageId);
  }

  broadcast('chat:moderated', {
    type: 'message.deleted',
    channel: normalizedChannel,
    messageId,
    username,
    deletedAt: event.occurredAt,
    deletedReason: 'message deleted by moderator',
  });
});

twitchClient.on('timeout', (channel, username, reason, duration, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('user.timeout', normalizedChannel, { username, reason, duration, tags }, { username });
  const deletedReason = `timeout: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username);
  broadcast('chat:moderated', {
    type: 'user.timeout',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason,
  });
});

twitchClient.on('ban', (channel, username, reason, tags) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('user.ban', normalizedChannel, { username, reason, tags }, { username });
  const deletedReason = `ban: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username);
  broadcast('chat:moderated', {
    type: 'user.ban',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason,
  });
});

twitchClient.on('clearchat', (channel) => {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('chat.clear', normalizedChannel, {});

  markChannelMessagesDeleted.run(event.occurredAt, 'chat cleared', event.id, normalizedChannel);
  broadcast('chat:moderated', {
    type: 'chat.clear',
    channel: normalizedChannel,
    deletedAt: event.occurredAt,
    deletedReason: 'chat cleared',
  });
});

export function connectTwitchChat(state: RuntimeState) {
  runtimeState = state;
  twitchClient.connect().catch((error: unknown) => {
    console.error('Failed to connect to Twitch chat:', error);
  });
}
