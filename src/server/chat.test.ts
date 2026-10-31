import { beforeEach, describe, expect, test } from 'bun:test';
import {
  handleBan,
  handleChatClear,
  handleChatMessage,
  handleMessageDeleted,
  handleTimeout,
  type ChatMessageInfo,
} from './chat';
import { db } from './db';
import { endActiveStreamSession, getOrStartStreamSession } from './streamSession';
import { getTwitchChannel } from './twitchIdentity';

type ChatRow = { stream_session_id: string | null; is_first_in_session: number };

const CHANNEL = getTwitchChannel() || 'codeacula';

/** A minimal stand-in for Twurple's ChatMessage; structurally assignable. */
function chatMessageInfo(id: string, username: string, badges: Map<string, string> | null): ChatMessageInfo {
  return {
    id,
    channelId: null,
    userInfo: {
      userName: username,
      displayName: username,
      badges: badges ?? new Map(),
      isBroadcaster: badges?.get('broadcaster') !== undefined,
    },
  };
}

function sendMessage(id: string, username: string, badges: Record<string, string> | null) {
  handleChatMessage(`#${CHANNEL}`, username, 'hello', chatMessageInfo(id, username, badges ? new Map(Object.entries(badges)) : null));
}

function chatRow(id: string): ChatRow | null {
  return db.prepare('select stream_session_id, is_first_in_session from chat_messages where id = ?')
    .get(id) as ChatRow | null;
}

function startSession(source: string) {
  endActiveStreamSession();
  return getOrStartStreamSession(source, new Date().toISOString());
}

describe('chat session stamping', () => {
  beforeEach(() => {
    db.exec('delete from chat_messages');
    db.exec('delete from stream_sessions');
    db.exec('delete from stream_session_chatters');
  });

  test('a viewer message carries the live session', () => {
    const session = startSession(`viewer-${crypto.randomUUID()}`);
    const id = `msg-${crypto.randomUUID()}`;
    sendMessage(id, `viewer${Date.now()}`, null);
    expect(chatRow(id)?.stream_session_id).toBe(session.id);
  });

  // The broadcaster is deliberately excluded from session chatter counts. That
  // must not leak into the message's session, or the dashboard renders the
  // streamer's own live chat as past-stream and dims it.
  test('the broadcaster message carries the live session too', () => {
    const session = startSession(`owner-${crypto.randomUUID()}`);
    const id = `msg-${crypto.randomUUID()}`;
    sendMessage(id, CHANNEL, { broadcaster: '1' });
    expect(chatRow(id)?.stream_session_id).toBe(session.id);
  });

  test('the broadcaster is still not counted as a session chatter', () => {
    startSession(`owner-count-${crypto.randomUUID()}`);
    const id = `msg-${crypto.randomUUID()}`;
    sendMessage(id, CHANNEL, { broadcaster: '1' });
    expect(chatRow(id)?.is_first_in_session).toBe(0);
    const chatters = db.prepare('select count(*) as c from stream_session_chatters').get() as { c: number };
    expect(chatters.c).toBe(0);
  });

  test('off-stream messages carry no session', () => {
    startSession(`offline-${crypto.randomUUID()}`);
    endActiveStreamSession();
    const id = `msg-${crypto.randomUUID()}`;
    sendMessage(id, `viewer${Date.now()}`, null);
    expect(chatRow(id)?.stream_session_id).toBeNull();
  });
});

describe('chat moderation events', () => {
  beforeEach(() => {
    db.exec('delete from chat_messages');
    db.exec('delete from chat_events');
  });

  function seedMessage(id: string, username: string): void {
    handleChatMessage(
      `#${CHANNEL}`,
      username,
      'roast me',
      chatMessageInfo(id, username, null),
    );
  }

  test('a deleted message marks its moderation state and keeps the removed text in the raw event', () => {
    const id = `msg-${crypto.randomUUID()}`;
    seedMessage(id, `viewer${Date.now()}`);
    const tags = new Map<string, string>();
    tags.set('target-msg-id', id);

    handleMessageDeleted(`#${CHANNEL}`, id, 'viewer-a', 'roast me', { tags });

    const row = db.prepare('select deleted_at as deletedAt, deleted_reason as deletedReason, moderation_event_id as eventId from chat_messages where id = ?')
      .get(id) as { deletedAt: string | null; deletedReason: string | null; eventId: string | null };
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedReason).toBe('message deleted by moderator');
    expect(row.eventId).not.toBeNull();

    const event = db
      .prepare("select payload_json as payloadJson from chat_events where type = 'message.deleted' and message_id = ?")
      .get(id) as { payloadJson: string } | null;
    const payload = JSON.parse(event?.payloadJson ?? '{}') as { deletedMessage?: string };
    expect(payload.deletedMessage).toBe('roast me');
  });

  test('a timeout marks all of the user\'s messages with its reason', () => {
    const username = `viewer${Date.now()}`;
    const first = `msg-${crypto.randomUUID()}`;
    const second = `msg-${crypto.randomUUID()}`;
    seedMessage(first, username);
    seedMessage(second, username);
    const tags = new Map<string, string>();
    tags.set('ban-reason', 'be nice');

    handleTimeout(`#${CHANNEL}`, username, 600, { tags });

    const rows = db.prepare('select deleted_reason as deletedReason from chat_messages where username = ?')
      .all(username) as Array<{ deletedReason: string }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.deletedReason).toBe('timeout: be nice');
    }
    const event = db
      .prepare("select payload_json as payloadJson from chat_events where type = 'user.timeout'")
      .get() as { payloadJson: string };
    const payload = JSON.parse(event.payloadJson) as { duration?: number; reason?: string };
    expect(payload.duration).toBe(600);
    expect(payload.reason).toBe('be nice');
  });

  test('a ban reads its reason from the raw tags', () => {
    const username = `viewer${Date.now()}`;
    const id = `msg-${crypto.randomUUID()}`;
    seedMessage(id, username);
    const tags = new Map<string, string>();
    tags.set('ban-reason', 'spam');

    handleBan(`#${CHANNEL}`, username, { tags });

    const row = db.prepare('select deleted_reason as deletedReason from chat_messages where id = ?')
      .get(id) as { deletedReason: string };
    expect(row.deletedReason).toBe('ban: spam');
  });

  test('a chat clear marks the channel', () => {
    const first = `msg-${crypto.randomUUID()}`;
    const second = `msg-${crypto.randomUUID()}`;
    seedMessage(first, `viewer-a${Date.now()}`);
    seedMessage(second, `viewer-b${Date.now()}`);

    handleChatClear(`#${CHANNEL}`);

    const rows = db.prepare('select id, deleted_reason as deletedReason from chat_messages').all() as Array<{ id: string; deletedReason: string }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.deletedReason).toBe('chat cleared');
    }
  });

  test('an empty ban-reason falls back to the no-reason wording', () => {
    const username = `viewer${Date.now()}`;
    const id = `msg-${crypto.randomUUID()}`;
    seedMessage(id, username);

    handleBan(`#${CHANNEL}`, username, { tags: new Map() });

    const row = db.prepare('select deleted_reason as deletedReason from chat_messages where id = ?')
      .get(id) as { deletedReason: string };
    expect(row.deletedReason).toBe('ban: no reason provided');
  });
});
