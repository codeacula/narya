import { db } from './db';

/**
 * The database reads that feed an llm_response step: the viewer's prior exchanges with
 * the bot, and recent channel chat.
 *
 * This module exists rather than putting `recentChatLines` in `chat.ts`, which owns the
 * table, because `chat.ts` imports `automation.ts`, which imports `actionExecutor.ts`.
 * An executor import of `chat.ts` would close the loop `actionExecutor -> chat ->
 * automation -> actionExecutor`, and all three build objects or prepare statements at
 * load time — so it fails as a boot-order crash rather than a clean error. That is the
 * same trap `windDown.ts` documents. This module imports only `db.ts`, so it has no
 * path back. Reading `chat_messages` from a second module is already the norm here
 * (`routes.ts`, `dashboard/status.ts`).
 */

/**
 * One exchange. Written only AFTER the reply reaches chat (see actionExecutor) — the
 * same rule quote_show applies to shown_count. Recording an undelivered reply would
 * make the model's account of the conversation diverge from the room's.
 */
export type LlmInteractionTurn = { prompt: string; reply: string };

/**
 * One line of channel chat. Declared here, not in llmPrompt.ts, so the dependency runs
 * one way: llmPrompt imports llmContext and never the reverse.
 */
export type LlmChatLine = { display: string; message: string };

/** Only the newest handful are ever read, so unbounded growth buys nothing. */
export const MAX_STORED_INTERACTIONS = 50;

const insertInteraction = db.prepare(`
  insert into llm_interactions (login, prompt, reply, created_at)
  values (?, ?, ?, ?)
`);

// Ordered by `seq`, never by created_at: two turns recorded in the same millisecond
// share a timestamp, so a timestamp sort would drop an arbitrary one of them here and
// return them shuffled below.
const pruneInteractions = db.prepare(`
  delete from llm_interactions
  where login = ?
    and seq not in (
      select seq from llm_interactions
      where login = ?
      order by seq desc
      limit ?
    )
`);

const selectInteractions = db.prepare(`
  select prompt, reply
  from llm_interactions
  where login = ?
  order by seq desc
  limit ?
`);

const deleteInteractions = db.prepare('delete from llm_interactions where login = ?');

const selectRecentChatLines = db.prepare(`
  select coalesce(nullif(display_name, ''), username) as display, message
  from chat_messages
  where deleted_at is null
  order by received_at desc, id desc
  limit ?
`);

const record = db.transaction((login: string, prompt: string, reply: string, now: string) => {
  insertInteraction.run(login, prompt, reply, now);
  pruneInteractions.run(login, login, MAX_STORED_INTERACTIONS);
});

export function recordInteraction(login: string, prompt: string, reply: string): void {
  const key = login.trim().toLowerCase();
  if (!key) return;
  record(key, prompt, reply, new Date().toISOString());
}

/** Newest `limit` turns, returned OLDEST first so they read as a transcript. */
export function loadInteractions(login: string, limit: number): LlmInteractionTurn[] {
  const key = login.trim().toLowerCase();
  if (!key || limit <= 0) return [];
  const rows = selectInteractions.all(key, limit) as LlmInteractionTurn[];
  return rows.reverse();
}

export function deleteInteractionsForLogin(login: string): number {
  const key = login.trim().toLowerCase();
  if (!key) return 0;
  return (deleteInteractions.run(key) as { changes: number }).changes;
}

/**
 * Recent channel chat for an LLM step's context, oldest first.
 *
 * Soft-deleted rows are excluded deliberately: replaying a moderated message into the
 * model's context would resurrect exactly the content moderation removed, and could put
 * it back on stream inside a generated reply.
 */
export function recentChatLines(limit: number): LlmChatLine[] {
  if (limit <= 0) return [];
  const rows = selectRecentChatLines.all(limit) as LlmChatLine[];
  return rows.reverse();
}
