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
 */
const CHAT_ARCHIVE_CUTOFF_DAYS = 90;
const ARCHIVE_FILENAME = 'chat-archive.sqlite';

/**
 * Attached rather than a table in the main database: deleted rows do not free
 * space in SQLite until VACUUM, so a same-file archive would keep the main
 * file growing forever. A separate file shrinks the *live* file down to what
 * is actually hot, while the archive grows without limit — which is the point.
 * The file sits next to the main database (whatever it is — the repo data dir
 * or a STREAMER_TOOLS_DB override), and tests, which run on a :memory: main,
 * attach an in-memory archive next to it.
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
  return path.join(path.dirname(mainDatabaseFile()), ARCHIVE_FILENAME);
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
 * incomplete and silently skip archiving that data from then on. Column order
 * matches because new columns are appended in `table_info` order, which is
 * exactly what `insert ... select *` relies on below.
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

const archiveMessages = db.prepare(`
  insert or ignore into archive.chat_messages_archive
  select * from main.chat_messages where received_at < ?
`);

const archiveEvents = db.prepare(`
  insert or ignore into archive.chat_events_archive
  select * from main.chat_events where occurred_at < ?
`);

const indexArchivedMessages = db.prepare(`
  insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
  select id, username, coalesce(display_name, ''), message, received_at
  from main.chat_messages where received_at < ?
`);

const selectMessagesOlderThan = db.prepare(`
  select count(*) as count from main.chat_messages where received_at < ?
`);

/** Cutoff ISO timestamp exposed for tests. */
export function chatRetentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - CHAT_ARCHIVE_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Move chat history older than the cutoff into the archive, then drop it
 * live. Everything happens inside one transaction: moderation events nearly
 * always land the same moment as the message they moderated, so the two
 * tables move together and a crash mid-way just retries cleanly next boot —
 * never split or lost. The FTS index is fed from the live rows before the
 * deletes, covering exactly the rows the archive just received.
 * Rows that were already in the archive are skipped (`or ignore`), so a re-run
 * does not double-index them.
 */
export function pruneChatHistory(now: Date = new Date()): number {
  const cutoff = chatRetentionCutoff(now);
  ensureArchiveAttached();
  return db.transaction((): number => {
    const pending = (selectMessagesOlderThan.get(cutoff) as { count: number }).count;
    if (pending === 0) return 0;

    const moved = (archiveMessages.run(cutoff) as { changes: number }).changes;
    if (moved > 0) indexArchivedMessages.run(cutoff);
    archiveEvents.run(cutoff);

    db.exec('delete from main.chat_messages where received_at < ?', [cutoff]);
    db.exec('delete from main.chat_events where occurred_at < ?', [cutoff]);
    return moved;
  })();
}

export interface ChatSearchHit {
  id: string;
  username: string;
  displayName: string;
  message: string;
  receivedAt: string;
  deletedAt: string | null;
  source: 'live' | 'archive';
}

/**
 * Search chat everywhere: the live window via LIKE and the archive via FTS5,
 * merged newest-first. An unparseable FTS query (operators, stray quotes)
 * falls back to a LIKE scan of the archive — slow in the archive but correct.
 */
export function searchChatHistory(query: string, limit = 50): ChatSearchHit[] {
  ensureArchiveAttached();
  const liveRows = db.prepare(`
    select id, username, display_name as displayName, message, received_at as receivedAt,
           deleted_at as deletedAt, 'live' as source
    from main.chat_messages
    where message like ? escape '\\'
    order by received_at desc
    limit ?
  `).all(`%${query}%`, limit) as unknown as ChatSearchHit[];

  let archiveRows: ChatSearchHit[];
  try {
    archiveRows = db.prepare(`
      select id, username, display_name as displayName, message, received_at as receivedAt,
             null as deletedAt, 'archive' as source
      from archive.chat_messages_fts
      where chat_messages_fts match ?
      order by received_at desc
      limit ?
    `).all(query, limit) as unknown as ChatSearchHit[];
  } catch {
    archiveRows = db.prepare(`
      select id, username, display_name as displayName, message, received_at as receivedAt,
             null as deletedAt, 'archive' as source
      from archive.chat_messages_archive
      where message like ? escape '\\'
      order by received_at desc
      limit ?
    `).all(`%${query}%`, limit) as unknown as ChatSearchHit[];
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
