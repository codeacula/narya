import { db } from './db';

export type StreamSession = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  discordMessageId: string | null;
  discordChannelId: string | null;
  discordAnnounceError: string | null;
  // How many announcement attempts this session has burned, and whether the last
  // failure was terminal (operator has to fix something) rather than transient.
  discordAnnounceAttempts: number;
  discordAnnounceTerminal: number;
};

const getActiveSessionRow = db.prepare(`
  select
    id,
    started_at as startedAt,
    ended_at as endedAt,
    source,
    discord_message_id as discordMessageId,
    discord_channel_id as discordChannelId,
    discord_announce_error as discordAnnounceError,
    discord_announce_attempts as discordAnnounceAttempts,
    discord_announce_terminal as discordAnnounceTerminal
  from stream_sessions
  where ended_at is null
  order by started_at desc
  limit 1
`);

const getSessionBySourceRow = db.prepare(`
  select
    id,
    started_at as startedAt,
    ended_at as endedAt,
    source,
    discord_message_id as discordMessageId,
    discord_channel_id as discordChannelId,
    discord_announce_error as discordAnnounceError,
    discord_announce_attempts as discordAnnounceAttempts,
    discord_announce_terminal as discordAnnounceTerminal
  from stream_sessions
  where source = ?
  limit 1
`);

const endActiveSessions = db.prepare(`
  update stream_sessions
  set ended_at = ?
  where ended_at is null
`);

const insertStreamSession = db.prepare(`
  insert into stream_sessions (id, started_at, ended_at, source, discord_message_id, discord_channel_id)
  values (?, ?, null, ?, null, null)
`);

const updateStreamSessionDiscord = db.prepare(`
  update stream_sessions
  set discord_message_id = ?, discord_channel_id = ?
  where id = ?
`);

const updateStreamSessionAnnounceError = db.prepare(`
  update stream_sessions
  set discord_announce_error = ?,
      discord_announce_terminal = ?,
      discord_announce_attempts = discord_announce_attempts + 1
  where id = ?
`);

const clearStreamSessionAnnounceError = db.prepare(`
  update stream_sessions
  set discord_announce_error = null,
      discord_announce_terminal = 0,
      discord_announce_attempts = 0
  where id = ?
`);

const insertStreamSessionChatter = db.prepare(`
  insert or ignore into stream_session_chatters (session_id, login, first_message_id, first_seen_at)
  values (?, ?, ?, ?)
`);

const countSessionChatters = db.prepare(`
  select count(*) as count
  from stream_session_chatters
  where session_id = ?
`);

const selectChatter = db.prepare(`
  select 1
  from chatters
  where login = ?
`);

function rowToStreamSession(row: unknown): StreamSession | null {
  if (!row) return null;
  return row as StreamSession;
}

export function getActiveStreamSession(): StreamSession | null {
  return rowToStreamSession(getActiveSessionRow.get());
}

export function getCurrentStreamSessionId(): string | null {
  return getActiveStreamSession()?.id ?? null;
}

export function getOrStartStreamSession(source: string, startedAt: string): StreamSession {
  const existing = rowToStreamSession(getSessionBySourceRow.get(source));
  if (existing) return existing;

  const id = crypto.randomUUID();
  const createSession = db.transaction(() => {
    const duplicate = rowToStreamSession(getSessionBySourceRow.get(source));
    if (duplicate) return duplicate;
    endActiveSessions.run(startedAt);
    insertStreamSession.run(id, startedAt, source);
    return rowToStreamSession(getSessionBySourceRow.get(source));
  });
  const session = createSession();
  if (!session) throw new Error('Could not create stream session.');
  return session;
}

export function endActiveStreamSession(endedAt = new Date().toISOString()) {
  endActiveSessions.run(endedAt);
}

export function attachDiscordAnnouncementToSession(sessionId: string, channelId: string, messageId: string) {
  updateStreamSessionDiscord.run(messageId, channelId, sessionId);
}

// `terminal` marks a failure the operator has to act on (bad bot token, missing
// permission, unknown channel). A non-terminal failure just burns an attempt, so a
// later reconnect can try again instead of the stream never being announced.
export function recordSessionAnnounceError(sessionId: string, reason: string, terminal: boolean) {
  updateStreamSessionAnnounceError.run(reason, terminal ? 1 : 0, sessionId);
}

export function clearSessionAnnounceError(sessionId: string) {
  clearStreamSessionAnnounceError.run(sessionId);
}

export function hasSeenChatterBefore(login: string): boolean {
  return selectChatter.get(login.toLowerCase()) != null;
}

export function recordCurrentSessionChatter(login: string, messageId: string, occurredAt: string) {
  const sessionId = getCurrentStreamSessionId();
  if (!sessionId) {
    return { sessionId: null, isFirstInSession: false };
  }

  const result = insertStreamSessionChatter.run(sessionId, login.toLowerCase(), messageId, occurredAt) as { changes: number };
  return {
    sessionId,
    isFirstInSession: result.changes > 0,
  };
}

export function getSessionChatterCount(): number {
  const sessionId = getCurrentStreamSessionId();
  if (!sessionId) return 0;
  const row = countSessionChatters.get(sessionId) as { count: number };
  return row.count;
}
