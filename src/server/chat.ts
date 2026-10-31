import { ChatClient } from '@twurple/chat';
import type { ChatMessage } from '../shared/api';
import { getRoleFromBadges } from '../shared/roles';
import { getTriggerDispatcher } from './automation';
import { db } from './db';
import { broadcast } from './realtime';
import type { RuntimeState } from './runtime';
import {
  getCurrentStreamSessionId,
  hasSeenChatterBefore,
  recordCurrentSessionChatter,
} from './streamSession';
import { speakText } from './tts';
import { getTwitchChannel } from './twitchIdentity';
import { isLoginIgnored } from './viewerIdentity';

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

const upsertChatter = db.prepare(`
  insert into chatters (login, first_seen_at, message_count)
  values (?, ?, 1)
  on conflict(login) do update set message_count = message_count + 1
`);

const markMessageDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where id = ?
`);

const markUserMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and username = ? and deleted_at is null
`);

const markChannelMessagesDeleted = db.prepare(`
  update chat_messages
  set deleted_at = ?, deleted_reason = ?, moderation_event_id = ?
  where channel = ? and deleted_at is null
`);

// No authProvider: Twurple connects anonymously (justinfan), exactly what tmi.js
// used to do. An anonymous read-only client cannot send chat, so bot messages sent
// via Helix arrive here as ordinary chat and never as a flagged self-message —
// the twitchBotLogin loop guard below is what keeps replies from re-entering
// their own commands.
export const twitchClient = new ChatClient({
  channels: getTwitchChannel() ? [getTwitchChannel()] : [],
});

let joinedChannel = getTwitchChannel();

export function getTwitchRoomId(): string | null {
  return twitchRoomId;
}

export function appendChatEvent(
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

/**
 * The slice of Twurple's ChatMessage this module consumes, declared locally so
 * tests can pass plain objects instead of the real IRC-backed class; the real
 * class is structurally assignable to this.
 */
export interface ChatMessageInfo {
  id: string;
  channelId?: string | null;
  userInfo: {
    userName: string;
    displayName?: string;
    color?: string;
    badges: Map<string, string>;
    isBroadcaster?: boolean;
  };
  emoteOffsets?: Map<string, string[]>;
}

/** The slice of Twurple's ClearChat / ClearMsg this module consumes. */
export interface TaggedMessage {
  tags: Map<string, string>;
}

twitchClient.onMessage((channel, user, message, msg) => {
  handleChatMessage(channel, user, message, msg);
});

twitchClient.onMessageRemove((channel, messageId, msg) => {
  handleMessageDeleted(channel, messageId, msg.userName, msg);
});

twitchClient.onTimeout((channel, username, duration, msg) => {
  handleTimeout(channel, username, duration, msg);
});

twitchClient.onBan((channel, username, msg) => {
  handleBan(channel, username, msg);
});

twitchClient.onChatClear((channel) => {
  handleChatClear(channel);
});

export function handleChatMessage(
  channel: string,
  usernameArg: string,
  message: string,
  msg: ChatMessageInfo,
) {
  const badges = msg.userInfo.badges;
  const badgesRecord = badges ? Object.fromEntries(badges) : {};
  const username = (usernameArg || msg.userInfo.userName || 'unknown').toLowerCase();

  if (!twitchRoomId && msg.channelId) {
    twitchRoomId = msg.channelId;
  }

  const occurredAt = new Date().toISOString();
  const isChannelOwner = username === getTwitchChannel().toLowerCase() || badges.get('broadcaster') !== undefined;
  const messageId = msg.id ?? crypto.randomUUID();
  const isFirstEver = !isChannelOwner && !hasSeenChatterBefore(username);
  // The broadcaster is excluded from session chatter counts, but their messages
  // still belong to the live session — otherwise the dashboard renders them as
  // past-stream chat and draws a spurious "this stream" divider after them.
  // recordCurrentSessionChatter already resolved the session for everyone else,
  // so only the owner needs a lookup of their own.
  const sessionChatter = !isChannelOwner
    ? recordCurrentSessionChatter(username, messageId, occurredAt)
    : { sessionId: getCurrentStreamSessionId(), isFirstInSession: false };
  const sessionId = sessionChatter.sessionId;

  const chatMessage: ChatMessage = {
    id: messageId,
    channel: channel.replace(/^#/, ''),
    username,
    displayName: msg.userInfo.displayName || usernameArg || 'unknown',
    color: msg.userInfo.color ?? null,
    message,
    receivedAt: occurredAt,
    deletedAt: null,
    deletedReason: null,
    badges: badgesRecord,
    emotes: msg.emoteOffsets ? Object.fromEntries(msg.emoteOffsets) : null,
    isFirstTimer: isFirstEver,
    isFirstThisSession: sessionChatter.isFirstInSession,
    isFirstEver,
    sessionId,
  };

  appendChatEvent('message.created', chatMessage.channel, { tags: badgesRecord, message }, {
    messageId: chatMessage.id,
    username: chatMessage.username,
    occurredAt,
  });

  const insertResult = insertChat.run(
    chatMessage.id,
    chatMessage.channel,
    chatMessage.username,
    chatMessage.displayName,
    chatMessage.color,
    chatMessage.message,
    chatMessage.receivedAt,
    chatMessage.badges ? JSON.stringify(chatMessage.badges) : null,
    chatMessage.emotes ? JSON.stringify(chatMessage.emotes) : null,
    sessionId,
    chatMessage.isFirstThisSession ? 1 : 0,
    chatMessage.isFirstEver ? 1 : 0,
  ) as { changes: number };
  // Only fold into the chatters summary when the message was actually inserted
  // (insert-or-ignore skips replayed ids), so counts stay accurate.
  //
  // Two exclusions, both of which used to be missing. Narya's own bot was recorded as
  // an ordinary viewer because the loop guard below runs *after* this point — it is
  // the one bot the system can identify with certainty, and it does not belong in the
  // operator's roster. A flushed login is skipped because otherwise the next message
  // from a bot the operator just removed would recreate its row immediately.
  const isOwnBot = Boolean(runtimeState?.twitchBotLogin) && username === runtimeState?.twitchBotLogin;
  if (insertResult.changes > 0 && !isOwnBot && !isLoginIgnored(chatMessage.username)) {
    upsertChatter.run(chatMessage.username, chatMessage.receivedAt);
  }
  broadcast('chat:message', chatMessage);

  // The chat client is anonymous, so messages from Narya's own bot carry no
  // self-flag. Bot messages sent via Helix arrive here as ordinary chat; skip
  // command dispatch for them so replies can't re-enter their own commands
  // (loop guard).
  if (runtimeState?.twitchBotLogin && username === runtimeState.twitchBotLogin) return;

  const ttsMatch = /^!tts\s+(.+)/i.exec(message.trim());
  if (ttsMatch?.[1]) {
    const role = getRoleFromBadges(badgesRecord);
    if (role === 'broadcaster' || role === 'moderator' || role === 'vip') {
      void speakText(ttsMatch[1]).catch((err: unknown) => {
        console.error('TTS: !tts command failed:', err);
      });
    }
  }

  // Drives both viewer !commands and chat-phrase triggers. The dispatcher ignores
  // Narya's own bot login, deduplicates on the chat message id, and applies each
  // trigger's cooldowns, so a redelivered message cannot fire an Action twice.
  if (runtimeState) {
    void getTriggerDispatcher().handleChatMessage(chatMessage).catch((error: unknown) => {
      console.error('Automation: chat dispatch failed:', error);
    });
  }
}

function handleMessageDeleted(
  channel: string,
  messageId: string,
  username: string,
  msg: TaggedMessage,
) {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent(
    'message.deleted',
    normalizedChannel,
    { username, deletedMessage: null, tags: Object.fromEntries(msg.tags) },
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
}

function timeoutReasonOf(msg: TaggedMessage): string | null {
  const reason = msg.tags.get('ban-reason');
  return reason ? reason.split('\\s').join(' ') : null;
}

function handleTimeout(channel: string, username: string, duration: number, msg: TaggedMessage) {
  const normalizedChannel = channel.replace(/^#/, '');
  const reason = timeoutReasonOf(msg);
  const event = appendChatEvent('user.timeout', normalizedChannel, { username, reason, duration, tags: Object.fromEntries(msg.tags) }, { username });
  const deletedReason = `timeout: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username.toLowerCase());
  broadcast('chat:moderated', {
    type: 'user.timeout',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason,
  });
}

function handleBan(channel: string, username: string, msg: TaggedMessage) {
  const normalizedChannel = channel.replace(/^#/, '');
  const reason = timeoutReasonOf(msg);
  const event = appendChatEvent('user.ban', normalizedChannel, { username, reason, tags: Object.fromEntries(msg.tags) }, { username });
  const deletedReason = `ban: ${reason || 'no reason provided'}`;

  markUserMessagesDeleted.run(event.occurredAt, deletedReason, event.id, normalizedChannel, username.toLowerCase());
  broadcast('chat:moderated', {
    type: 'user.ban',
    channel: normalizedChannel,
    username,
    deletedAt: event.occurredAt,
    deletedReason,
  });
}

function handleChatClear(channel: string) {
  const normalizedChannel = channel.replace(/^#/, '');
  const event = appendChatEvent('chat.clear', normalizedChannel, {});

  markChannelMessagesDeleted.run(event.occurredAt, 'chat cleared', event.id, normalizedChannel);
  broadcast('chat:moderated', {
    type: 'chat.clear',
    channel: normalizedChannel,
    deletedAt: event.occurredAt,
    deletedReason: 'chat cleared',
  });
}

export function connectTwitchChat(state: RuntimeState) {
  runtimeState = state;
  joinedChannel = getTwitchChannel();
  // connect() is fire-and-forget: Twurple reconnects on its own and reports
  // failures through onDisconnect instead of a rejected promise.
  twitchClient.connect();
  twitchClient.onDisconnect((manually, reason) => {
    if (!manually && reason) {
      console.error('Twitch chat: disconnected:', reason);
    }
  });
}

export async function applyTwitchChannel() {
  const next = getTwitchChannel();
  if (next === joinedChannel) return;

  const previous = joinedChannel;
  joinedChannel = next;
  // The room id is inferred from the first message of a channel; clear it so a
  // stale id (and its emote cache) can't outlive the channel switch.
  twitchRoomId = null;
  try {
    if (previous) twitchClient.part(previous);
    if (next) await twitchClient.join(next);
  } catch (error) {
    console.error('Twitch chat: failed to switch channel:', error);
  }
}
