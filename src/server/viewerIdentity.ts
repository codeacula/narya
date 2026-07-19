/**
 * Viewer identity: who is in the channel, and what we know about them.
 *
 * `chatters` began as a per-login message tally maintained solely by chat ingestion,
 * which meant a lurker — present in the channel, never typing — had no row at all and
 * could not be opened or managed. Helix Get Chatters already told us they were there;
 * the result was used only to light an "is live" dot on rows that already existed.
 *
 * This module is the write side of that gap. Presence creates a row with
 * `message_count = 0`, and profile detail is backfilled lazily: the first time a login
 * is seen without it, not on a schedule.
 *
 * The invariant that makes lurker rows safe: **`message_count > 0` means "has
 * chatted"**. `hasSeenChatterBefore` keys off that rather than row existence, because
 * row existence now also means "was merely present". See streamSession.ts.
 */
import { db } from './db';
import { anonymizeQuotesByLogin } from './quotes';

/** Helix caps Get Users at 100 logins per request. */
const HELIX_USERS_BATCH = 100;

export type ChatterPresence = {
  userId: string;
  userLogin: string;
  userName: string;
};

export type ChatterProfileUpdate = {
  login: string;
  userId?: string;
  displayName?: string;
  profileImageUrl?: string;
  accountCreatedAt?: string;
  /** Twitch no longer returns this account — renamed, deleted, or banned. */
  missing?: boolean;
};

const insertPresence = db.prepare(`
  insert into chatters (login, first_seen_at, message_count, twitch_user_id, display_name, last_seen_at)
  values (?, ?, 0, ?, ?, ?)
  on conflict(login) do update set
    last_seen_at = excluded.last_seen_at,
    -- Never overwrite a known value with a blank one, and never touch message_count:
    -- presence must not reset a regular's tally or their original first_seen_at.
    twitch_user_id = coalesce(chatters.twitch_user_id, excluded.twitch_user_id),
    display_name = coalesce(chatters.display_name, excluded.display_name)
`);

const selectMissingProfile = db.prepare(`
  select login
  from chatters
  where profile_fetched_at is null and missing_at is null
  order by last_seen_at desc, login asc
  limit ?
`);

const updateProfile = db.prepare(`
  update chatters
  set twitch_user_id = coalesce(?, twitch_user_id),
      display_name = coalesce(?, display_name),
      profile_image_url = coalesce(?, profile_image_url),
      account_created_at = coalesce(?, account_created_at),
      profile_fetched_at = ?,
      missing_at = ?
  where login = ?
`);

const selectIgnored = db.prepare('select 1 from ignored_logins where login = ?');
const listIgnored = db.prepare('select login, reason, created_at as createdAt from ignored_logins order by created_at desc');
const insertIgnored = db.prepare(`
  insert into ignored_logins (login, reason, created_at) values (?, ?, ?)
  on conflict(login) do nothing
`);
const deleteIgnored = db.prepare('delete from ignored_logins where login = ?');

const deleteChatter = db.prepare('delete from chatters where login = ?');
const deleteProfile = db.prepare('delete from viewer_profiles where login = ?');
const deleteMessages = db.prepare('delete from chat_messages where username = ?');

export function isLoginIgnored(login: string): boolean {
  return selectIgnored.get(login.trim().toLowerCase()) != null;
}

export function ignoredLogins(): Array<{ login: string; reason: string; createdAt: string }> {
  return listIgnored.all() as Array<{ login: string; reason: string; createdAt: string }>;
}

/**
 * Record everyone Helix says is currently in the channel.
 *
 * Idempotent: re-running for the same people updates `last_seen_at` and backfills any
 * identity field that was still blank, and changes nothing else. Ignored logins are
 * skipped, which is what stops a flushed bot reappearing on the very next poll.
 */
export function recordChatterPresence(chatters: ChatterPresence[]): void {
  if (chatters.length === 0) return;
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const chatter of chatters) {
      const login = chatter.userLogin.trim().toLowerCase();
      if (!login || isLoginIgnored(login)) continue;
      insertPresence.run(login, now, chatter.userId || null, chatter.userName || null, now);
    }
  })();
}

/**
 * Logins whose profile has never been fetched, capped at one Helix Get Users request.
 *
 * Most-recently-seen first, so when a channel has more unknown logins than one batch
 * the people actually present get their detail before a long tail of historical rows.
 */
export function loginsMissingProfile(limit = HELIX_USERS_BATCH): string[] {
  const rows = selectMissingProfile.all(Math.min(limit, HELIX_USERS_BATCH)) as Array<{ login: string }>;
  return rows.map(row => row.login);
}

/**
 * Persist what Helix returned for one login.
 *
 * `missing: true` stamps `missing_at` and deliberately keeps the row: an account that
 * was renamed, deleted, or banned is still part of the channel's history, and dropping
 * it would silently rewrite past chat. Any successful fetch clears the flag, so an
 * account that comes back stops being marked.
 */
export function saveChatterProfile(update: ChatterProfileUpdate): void {
  const login = update.login.trim().toLowerCase();
  if (!login) return;
  const now = new Date().toISOString();

  updateProfile.run(
    update.userId ?? null,
    update.displayName ?? null,
    update.profileImageUrl ?? null,
    update.accountCreatedAt ?? null,
    now,
    update.missing ? now : null,
    login,
  );
}

/**
 * Remove a viewer from the operator's view of the channel and keep them out.
 *
 * Deletes the roster row, the operator's own notes/tags, and the mutable chat
 * projection — and records the login as ignored. The ignore is the load-bearing part:
 * a delete on its own is self-healing-hostile, because the next chat message from that
 * account recreates the row via chat.ts's upsert, and the next presence poll recreates
 * it here.
 *
 * Append-only `chat_events` is deliberately untouched, so a flush is auditable and a
 * mistake is recoverable rather than a hole in the record.
 *
 * Quotes they submitted are *anonymized*, not deleted: the quote and its number stay
 * (a number already circulating in Discord must not come to mean something else), but
 * the attribution goes, so a `quote_show` step cannot keep announcing a flushed viewer
 * on stream. That part is one-way — `unflushViewer` has no login left to restore from.
 */
export function flushViewer(login: string, reason = ''): { messages: number; quotes: number } {
  const key = login.trim().toLowerCase();
  if (!key) return { messages: 0, quotes: 0 };
  const now = new Date().toISOString();

  let messages = 0;
  let quotes = 0;
  db.transaction(() => {
    insertIgnored.run(key, reason, now);
    deleteChatter.run(key);
    deleteProfile.run(key);
    messages = (deleteMessages.run(key) as { changes: number }).changes;
    quotes = anonymizeQuotesByLogin(key);
  })();

  return { messages, quotes };
}

/** Lift a flush, so the viewer can be recorded again the next time they appear. */
export function unflushViewer(login: string): void {
  deleteIgnored.run(login.trim().toLowerCase());
}
