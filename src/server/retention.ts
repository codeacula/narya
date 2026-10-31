import { db } from './db';

/**
 * chat_messages is the current display projection and chat_events is the raw
 * append-only layer behind it; both grow with every line of chat, forever. The
 * dashboard only ever reads small windows of them — the last 40 messages, the
 * last 100 moderation events, session-scoped shoutouts and per-week activity
 * counts — so nothing misses rows older than this window. The window is
 * deliberately generous (a season of streaming) and lives in code rather than
 * .env: it is not a credential and the operator can ask to change it the same
 * way they'd change any other default.
 */
const CHAT_RETENTION_DAYS = 90;

const deleteOldChatMessages = db.prepare('delete from chat_messages where received_at < ?');
const deleteOldChatEvents = db.prepare('delete from chat_events where occurred_at < ?');

/** Cutoff ISO timestamp used by both pokes, exposed for tests. */
export function chatRetentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Prune chat history older than the retention window. Chat moderation events
 * nearly always land the same moment as the message they moderated, so the
 * chat_messages.dangling `moderation_event_id` reference left behind by an
 * uneven prune is only ever a slightly stale audit pointer, and both deletes
 * run back to back in one transaction to keep even that window closed.
 */
export function pruneChatHistory(now: Date = new Date()): number {
  const cutoff = chatRetentionCutoff(now);
  return db.transaction((): number => {
    const messages = (deleteOldChatMessages.run(cutoff) as { changes: number }).changes;
    const events = (deleteOldChatEvents.run(cutoff) as { changes: number }).changes;
    return messages + events;
  })();
}
