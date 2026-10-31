import { beforeEach, describe, expect, test } from 'bun:test';
import { handleChatMessage, type ChatMessageInfo } from './chat';
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
