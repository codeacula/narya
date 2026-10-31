import { chmodSync } from 'node:fs';
import path from 'node:path';
import { db } from './db';

/**
 * chat_messages is the current display projection and chat_events is the raw
 * append-only layer behind it; both grow with every line of chat, but the
 * operator keeps chat history permanently — it is a searchable record of every
 * stream, not disposable scratch. So instead of deleting, rows past the cutoff
 * are MOVED into archive tables in a separate SQLite file, and the live
 * database stays small for the small windows its consumers read.
 *
 * Behavior note beyond the archive: dashboard/window consumers (older-chat
 * paging, viewer detail history) read only the live file, so their reach
 * ends at the cutoff; anything older lives in the archive and is reachable
 * through /api/chat/search.
 */
const CHAT_ARCHIVE_CUTOFF_DAYS = 90;
const ARCHIVE_SUFFIX = '.archive.sqlite';

/**
 * Attached rather than a table in the main database: deleted rows do not free
 * space in SQLite until VACUUM, so a same-file archive would keep the main
 * file growing forever. A separate file shrinks the *live* file down to what
 * is actually hot, while the archive grows without limit — which is the point.
 * The archive is named after the main database (streamer-tools.sqlite -> 
 * streamer-tools.archive.sqlite) so a scratch STREAMER_TOOLS_DB gets its own
 * archive and can never write into the operator's real history; tests, which
 * run on a :memory: main, attach an in-memory archive next to it.
 */
function mainDatabaseFile(): string {
  const mainFile = (db.prepare('pragma database_list').all() as Array<{ name: string; file: string }>)
    .find(entry => entry.name === 'main')?.file ?? '';
  return mainFile;
}

function mainIsMemory(): boolean {
  const mainFile = mainDatabaseFile();
  return mainFile === '' || mainFile.includes(':memory:');
}

/** Archive path for the main database: a sibling file, or memory for tests. */
function archivePath(): string {
  if (mainIsMemory()) return ':memory:';
  const mainFile = mainDatabaseFile();
  return path.join(path.dirname(mainFile), path.basename(mainFile) + ARCHIVE_SUFFIX);
}

let attached = false;

/** Idempotently ATTACH the archive database as `archive`. */
function ensureArchiveAttached(): void {
  if (attached) return;
  db.exec('attach database ? as archive', [archivePath()]);
  attached = true;
}

ensureArchiveAttached();

/**
 * The archive mirrors the live schema of chat_messages / chat_events. The DDL
 * is derived from `pragma main.table_info` instead of a hand-written snapshot:
 * a future db.ts migration that adds a live column would leave a static copy
 * incomplete and silently skip archiving that data from then on.
 */
function createArchiveTable(liveTable: string, archiveTable: string): void {
  db.exec(`create table if not exists archive.${archiveTable} (id text primary key)`);
  const liveColumns = db
    .prepare(`pragma main.table_info('${liveTable}')`)
    .all() as Array<{ name: string; type: string }>;
  const archiveColumns = new Set(
    (db.prepare(`pragma archive.table_info('${archiveTable}')`).all() as Array<{ name: string }>).map(c => c.name),
  );
  for (const column of liveColumns) {
    if (!archiveColumns.has(column.name)) {
      db.exec(`alter table archive.${archiveTable} add column ${column.name} ${column.type}`);
    }
  }
}

createArchiveTable('chat_messages', 'chat_messages_archive');
createArchiveTable('chat_events', 'chat_events_archive');

db.exec(`
  create virtual table if not exists archive.chat_messages_fts using fts5(
    id unindexed,
    username,
    display_name,
    message,
    received_at unindexed
  );
`);

// The attach created the file — mark it private the way db.ts marks the main
// database, unless main itself is in-memory (tests).
if (!mainIsMemory()) {
  try {
    chmodSync(archivePath(), 0o600);
  } catch (error) {
    console.warn('Chat archive: could not restrict file permissions:', error);
  }
}

/**
 * Copy statements are built from `pragma table_info` at boot rather than
 * `select *`: SQLite matches INSERT..SELECT * by position, and a positional
 * match silently corrupts data the day the live file's column layout and
 * the archive's disagree. Names are code-derived identifiers, not user data.
 */
function columnList(table: string): string {
  return (db.prepare(`pragma main.table_info('${table}')`).all() as Array<{ name: string }>)
    .map(c => c.name)
    .join(', ');
}

const messageColumns = columnList('chat_messages');
const eventColumns = columnList('chat_events');

const archiveMessages = db.prepare(`
  insert or ignore into archive.chat_messages_archive (${messageColumns})
  select ${messageColumns} from main.chat_messages where received_at < ?
`);

const archiveEvents = db.prepare(`
  insert or ignore into archive.chat_events_archive (${eventColumns})
  select ${eventColumns} from main.chat_events where occurred_at < ?
`);

const indexArchivedMessages = db.prepare(`
  insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
  select id, username, coalesce(display_name, ''), message, received_at
  from main.chat_messages where received_at < ?
`);

const selectMessagesOlderThan = db.prepare(`
  select count(*) as count from main.chat_messages where received_at < ?
`);

const selectEventsOlderThan = db.prepare(`
  select count(*) as count from main.chat_events where occurred_at < ?
`);

/** Cutoff ISO timestamp exposed for tests. */
export function chatRetentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - CHAT_ARCHIVE_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Move chat history older than the cutoff into the archive, in two phases.
 *
 * The main database runs in WAL mode, where a transaction spanning the main
 * file and an attached file is only atomic per file — so a plain
 * copy-then-delete-then-commit could lose rows in a crash between the two
 * files' commits. Instead: phase one copies message+event rows and indexes
 * them (this transaction only writes the archive file, so it is atomic);
 * phase two deletes live rows whose committed archive copy exists. A crash
 * between the phases leaves rows in BOTH files, which the next run resolves
 * — copies are id-keyed `or ignore`, FTS indexing is gated on rows actually
 * copied this run, so nothing is ever lost or double-indexed.
 */
export function pruneChatHistory(now: Date = new Date()): number {
  const cutoff = chatRetentionCutoff(now);
  ensureArchiveAttached();

  let moved: number = 0;
  db.transaction((): void => {
    const pendingMessages = (selectMessagesOlderThan.get(cutoff) as { count: number }).count;
    const pendingEvents = (selectEventsOlderThan.get(cutoff) as { count: number }).count;
    if (pendingMessages === 0 && pendingEvents === 0) return;

    moved = (archiveMessages.run(cutoff) as { changes: number }).changes;
    // Index exactly the rows copied this run; re-copying is suppressed by
    // `or ignore`, so a re-run cannot produce duplicate FTS entries.
    if (moved > 0) indexArchivedMessages.run(cutoff);
    archiveEvents.run(cutoff);
  })();

  // Phase two does not need a transaction spanning both files: each DELETE is
  // bounded to rows whose archive copy is already committed.
  db.exec(
    'delete from main.chat_messages where received_at < ? and id in (select id from archive.chat_messages_archive)',
    [cutoff],
  );
  db.exec(
    'delete from main.chat_events where occurred_at < ? and id in (select id from archive.chat_events_archive)',
    [cutoff],
  );
  return moved;
}

export interface ChatSearchHit {
  id: string;
  username: string;
  displayName: string;
  message: string;
  receivedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  source: 'live' | 'archive';
}

/** % and _ are LIKE wildcards; without escaping the user could match wider
 *  than everything the archive holds than intended. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, match => `\\${match}`);
}

/**
 * Search chat everywhere: the live window via LIKE and the archive via FTS5,
 * merged newest-first. Moderation state travels with archived hits (timed
 * out / banned / deleted messages must not surface looking clean). An
 * unparseable FTS query (operators, stray quotes) falls back to a LIKE scan
 * of the archive — slow in the archive but correct.
 */
export function searchChatHistory(query: string, limit = 50): ChatSearchHit[] {
  ensureArchiveAttached();
  const pattern = `%${likeEscape(query)}%`;

  const liveRows = db.prepare(`
    select id, username, display_name as displayName, message, received_at as receivedAt,
           deleted_at as deletedAt, deleted_reason as deletedReason, 'live' as source
    from main.chat_messages
    where message like ? escape '\\'
    order by received_at desc
    limit ?
  `).all(pattern, limit) as unknown as ChatSearchHit[];

  let archiveRows: ChatSearchHit[];
  try {
    archiveRows = db.prepare(`
      select f.id as id, a.username as username, a.display_name as displayName, f.message as message,
             f.received_at as receivedAt, a.deleted_at as deletedAt,
             a.deleted_reason as deletedReason, 'archive' as source
      from archive.chat_messages_fts f
      join archive.chat_messages_archive a on a.id = f.id
      where chat_messages_fts match ?
      order by f.received_at desc
      limit ?
    `).all(query, limit) as unknown as ChatSearchHit[];
  } catch {
    archiveRows = db.prepare(`
      select id, username, display_name as displayName, message, received_at as receivedAt,
             deleted_at as deletedAt, deleted_reason as deletedReason, 'archive' as source
      from archive.chat_messages_archive
      where message like ? escape '\\'
      order by received_at desc
      limit ?
    `).all(pattern, limit) as unknown as ChatSearchHit[];
  }

  const seen = new Set(liveRows.map(row => row.id));
  const merged = [...liveRows];
  for (const archiveRow of archiveRows) {
    if (!seen.has(archiveRow.id)) {
      seen.add(archiveRow.id);
      merged.push(archiveRow);
    }
  }
  merged.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return merged.slice(0, limit);
}

/**
 * Purge a viewer's chat from the archive, used by flushViewer so a flushed
 * viewer does not stay reachable through /api/chat/search. Mirrors flush's
 * live rule: the projection (chat_messages) goes, the raw append-only
 * `chat_events` layer stays for audit. Must run inside the caller's
 * transaction to match the rest of the flush.
 */
export function deleteArchivedChatForLogin(login: string): void {
  ensureArchiveAttached();
  const lower = login.toLowerCase();
  db.exec('delete from archive.chat_messages_archive where username = ?', [lower]);
  db.exec('delete from archive.chat_messages_fts where username = ?', [lower]);
}
