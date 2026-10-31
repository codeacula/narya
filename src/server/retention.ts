import { chmodSync } from 'node:fs';
import path from 'node:path';
import { db } from './db';

/**
 * chat_messages is the current display projection and chat_events is the raw
 * append-only layer behind it; both grow with every line of chat, but the
 * operator keeps chat history permanently — it is a searchable record of every
 * stream, not disposable scratch. So instead of deleting, rows past the cutoff
 * are MOVED into archive tables in a separate SQLite file, and the live
 * tables stay bounded to the small windows their consumers read.
 *
 * Behavior note beyond the archive: dashboard/window consumers (older-chat
 * paging, viewer detail history) read only the live file, so their reach
 * ends at the cutoff; anything older lives in the archive and is reachable
 * through /api/chat/search.
 */
const CHAT_ARCHIVE_CUTOFF_DAYS = 90;
/**
 * How many trigram candidates make a search term "common". Below this, joining
 * and sorting the candidates is cheap; at or above it, walking the archive
 * newest-first finds `limit` matches sooner than sorting them all would.
 */
export const ARCHIVE_CANDIDATE_CAP = 5000;
const ARCHIVE_SUFFIX = '.archive.sqlite';

/**
 * Attached rather than a table in the main database, so the archive's
 * unbounded growth lands in its own file and the main file only holds what is
 * hot. Moving rows out does not make the main file *smaller*: SQLite puts the
 * freed pages on its freelist (auto_vacuum is off) and reuses them for later
 * writes, so chat stops adding net growth once the 90-day window is full — the
 * file still grows with the main database's other tables, and with a busier
 * window. Returning freed space to the disk takes a VACUUM of the main
 * database, which this module never runs: it rewrites the whole file and
 * blocks writers while it does.
 *
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

/**
 * streamer-tools.sqlite -> streamer-tools.archive.sqlite. Only a `.sqlite`
 * extension is replaced; any other name keeps its full basename, so two scratch
 * databases differing only by extension cannot share one archive.
 */
export function archivePathFor(mainFile: string): string {
  const base = path.basename(mainFile).replace(/\.sqlite$/, '');
  return path.join(path.dirname(mainFile), base + ARCHIVE_SUFFIX);
}

/** Archive path for the main database: a sibling file, or memory for tests. */
function archivePath(): string {
  if (mainIsMemory()) return ':memory:';
  return archivePathFor(mainDatabaseFile());
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

// The archive only ever grows, so every query against it needs an index:
// - username: flushViewer deletes a login's archived rows.
// - received_at: a search that does not go through the trigram index walks this
//   newest-first and stops at `limit` matches instead of scanning and sorting.
// The search join and the phase-two deletes' EXISTS probe use the `id` primary key.
db.exec('create index if not exists archive.idx_chat_messages_archive_username on chat_messages_archive(username)');
db.exec('create index if not exists archive.idx_chat_messages_archive_received_at on chat_messages_archive(received_at)');

/**
 * The trigram tokenizer is what lets archive search behave exactly like live
 * search. Live search is a substring LIKE; the default unicode61 tokenizer only
 * matches whole tokens and parses the query as FTS syntax, so "walru" found the
 * live copy of a message but not the archived one, and AND/OR/column:filters
 * were operators in one store and literal text in the other. A trigram index
 * answers substring lookups, which is what search and the flush need from it.
 *
 * `display_name` and `received_at` are unindexed: search and flush never filter
 * on them through this table, and each indexed column costs about one trigram
 * index entry per character.
 */
const ARCHIVE_FTS_DDL = `
  create virtual table archive.chat_messages_fts using fts5(
    id unindexed,
    username,
    display_name unindexed,
    message,
    received_at unindexed,
    tokenize = 'trigram'
  )
`;

const selectArchiveFtsDdl = db.prepare(
  "select sql from archive.sqlite_master where type = 'table' and name = 'chat_messages_fts'",
);

/**
 * Create the archive search index, or rebuild it in place when it predates the
 * trigram tokenizer. Keyed off the stored DDL rather than a runOnce ledger: the
 * ledger lives in the main database, which a restored or copied archive need
 * not match, whereas the archive's own schema says what it actually holds. The
 * index is derived entirely from chat_messages_archive, so a rebuild loses
 * nothing, and it runs in one transaction that only writes the archive file, so
 * a crash leaves either the old index or the new one, never half of each.
 */
export function ensureArchiveSearchIndex(): void {
  const existing = (selectArchiveFtsDdl.all() as Array<{ sql: string }>)[0]?.sql;
  if (existing && /tokenize\s*=\s*'trigram'/i.test(existing)) return;

  db.transaction((): void => {
    if (existing) db.exec('drop table archive.chat_messages_fts');
    db.exec(ARCHIVE_FTS_DDL);
    db.exec(`
      insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
      select id, username, coalesce(display_name, ''), message, received_at
      from archive.chat_messages_archive
    `);
  })();
  if (existing) console.log('Chat archive: rebuilt the search index with the trigram tokenizer.');
}

ensureArchiveSearchIndex();

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

// Indexes only archive rows inserted after `rowid > ?`, i.e. the rows this run
// actually copied. Selecting from main.chat_messages instead would re-index rows
// a crashed earlier run already archived and indexed but never deleted.
const archiveMaxRowid = db.prepare(`
  select coalesce(max(rowid), 0) as maxRowid from archive.chat_messages_archive
`);

const indexArchivedMessages = db.prepare(`
  insert into archive.chat_messages_fts (id, username, display_name, message, received_at)
  select id, username, coalesce(display_name, ''), message, received_at
  from archive.chat_messages_archive where rowid > ?
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

    const rowidBefore = (archiveMaxRowid.get() as { maxRowid: number }).maxRowid;
    moved = (archiveMessages.run(cutoff) as { changes: number }).changes;
    // Index exactly the rows copied this run: `or ignore` skips rows already
    // archived, and new rows get rowids above the pre-copy maximum.
    if (moved > 0) indexArchivedMessages.run(rowidBefore);
    archiveEvents.run(cutoff);
  })();

  // Phase two does not need a transaction spanning both files: each DELETE is
  // bounded to rows whose archive copy is already committed.
  db.exec(ARCHIVE_QUERY_SQL.pruneLiveMessages, [cutoff]);
  db.exec(ARCHIVE_QUERY_SQL.pruneLiveEvents, [cutoff]);
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

/** % and _ are LIKE wildcards; escaped, the query matches only its literal text. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, match => `\\${match}`);
}

/**
 * A trigram phrase query for `text` in one FTS column. Inside double quotes
 * FTS5 takes everything literally — `%`, `_`, `*`, `AND`, `column:` — so the
 * only escaping is doubling `"`. It matches rows whose column contains `text`
 * as a substring (folding case more broadly than LIKE does, so it is a
 * superset of the LIKE match, never a subset).
 */
function ftsPhrase(column: 'message' | 'username', text: string): string {
  return `${column} : "${text.replaceAll('"', '""')}"`;
}

/**
 * Whether the trigram index can answer a substring lookup for `text`. A phrase
 * shorter than three code points (not UTF-16 units: an emoji pair is two) has
 * no trigram and matches no rows at all, and a NUL would cut the phrase
 * short — both must take the non-FTS path or rows would silently go missing.
 */
function trigramSearchable(text: string): boolean {
  return [...text].length >= 3 && !text.includes('\0');
}

/**
 * Every statement the archive's search and flush run, exported so the tests can
 * EXPLAIN the exact SQL that ships rather than a hand-typed copy of it.
 */
export const ARCHIVE_QUERY_SQL = {
  // Stops after `limit ?` index hits, so a common term costs at most the cap.
  countCandidates: `
    select count(*) as count from (
      select 1 from archive.chat_messages_fts where chat_messages_fts match ? limit ?
    )
  `,
  searchIndexed: `
    select a.id as id, a.username as username, a.display_name as displayName, a.message as message,
           a.received_at as receivedAt, a.deleted_at as deletedAt,
           a.deleted_reason as deletedReason, 'archive' as source
    from archive.chat_messages_fts f
    join archive.chat_messages_archive a on a.id = f.id
    where chat_messages_fts match ?
      and a.message like ? escape '\\'
    order by a.received_at desc
    limit ?
  `,
  searchScan: `
    select id, username, display_name as displayName, message, received_at as receivedAt,
           deleted_at as deletedAt, deleted_reason as deletedReason, 'archive' as source
    from archive.chat_messages_archive
    where message like ? escape '\\'
    order by received_at desc
    limit ?
  `,
  flushArchive: 'delete from archive.chat_messages_archive where username = ?',
  flushFtsIndexed: 'delete from archive.chat_messages_fts where chat_messages_fts match ? and username = ?',
  flushFtsScan: 'delete from archive.chat_messages_fts where username = ?',
  // EXISTS, not `id in (select id from archive…)`: the IN form materializes every
  // archived id on every prune — linear in an archive that only grows, even with
  // nothing to delete — where EXISTS walks the live received_at/occurred_at index
  // to the cutoff and probes the archive's primary key per row.
  pruneLiveMessages: `
    delete from main.chat_messages
    where received_at < ?
      and exists (select 1 from archive.chat_messages_archive a where a.id = main.chat_messages.id)
  `,
  pruneLiveEvents: `
    delete from main.chat_events
    where occurred_at < ?
      and exists (select 1 from archive.chat_events_archive a where a.id = main.chat_events.id)
  `,
} as const;

/** Which statement removes a login from the FTS index; see deleteArchivedChatForLogin. */
export function archiveFtsFlushStatement(login: string): 'flushFtsIndexed' | 'flushFtsScan' {
  return trigramSearchable(login) ? 'flushFtsIndexed' : 'flushFtsScan';
}

/**
 * Which archive statement answers `query`; see searchChatHistory. Exported so
 * the tests can pin the routing, which no result can reveal — every path
 * returns the same rows, only at different cost.
 */
export function archiveSearchStatement(query: string): 'searchIndexed' | 'searchScan' {
  if (!trigramSearchable(query)) return 'searchScan';
  const { count } = db.prepare(ARCHIVE_QUERY_SQL.countCandidates)
    .get(ftsPhrase('message', query), ARCHIVE_CANDIDATE_CAP) as { count: number };
  return count < ARCHIVE_CANDIDATE_CAP ? 'searchIndexed' : 'searchScan';
}

/**
 * Search chat everywhere, with one matching rule on both sides of the cutoff:
 * the escaped substring LIKE live search uses — ASCII letters case-insensitive,
 * `%` and `_` literal. Results merge newest-first, and moderation state travels
 * with archived hits (timed out / banned / deleted messages must not surface
 * looking clean).
 *
 * In the archive that LIKE is always the final filter, so results are exact
 * whichever path finds the candidates. The path is picked by cost:
 * - a term with fewer than ARCHIVE_CANDIDATE_CAP trigram candidates is rare:
 *   the trigram phrase match (always a superset of the LIKE) hands back that
 *   bounded set to join and sort — fast however large the archive grows;
 * - a common term (the cap counted in full; the count stops there) would make
 *   that join sort most of the archive before `limit` applies, so it walks the
 *   received_at index newest-first instead and stops at `limit` matches;
 * - under three code points (or containing NUL) there is no trigram to look
 *   up, so it takes the same newest-first walk.
 * The worst case is therefore one walk of the archive — a short term that
 * matches almost nothing — rather than a sort of every match.
 * The phrase is quoted and bound, so no query can fail to parse — an error here
 * is a real one and propagates.
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

  const archiveRows = (archiveSearchStatement(query) === 'searchIndexed'
    ? db.prepare(ARCHIVE_QUERY_SQL.searchIndexed).all(ftsPhrase('message', query), pattern, limit)
    : db.prepare(ARCHIVE_QUERY_SQL.searchScan).all(pattern, limit)) as unknown as ChatSearchHit[];

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
  db.exec(ARCHIVE_QUERY_SQL.flushArchive, [lower]);
  // Equality alone is a full scan of an FTS5 table. The phrase match lets the
  // trigram index find the candidates for any login — `_` is literal inside a
  // phrase, unlike in LIKE, so ab_cd is as indexable as abxcd — and the equality
  // keeps the delete exact: cool_guy's flush never touches xcool_guyx.
  if (archiveFtsFlushStatement(lower) === 'flushFtsIndexed') {
    db.exec(ARCHIVE_QUERY_SQL.flushFtsIndexed, [ftsPhrase('username', lower), lower]);
  } else {
    db.exec(ARCHIVE_QUERY_SQL.flushFtsScan, [lower]);
  }
}
